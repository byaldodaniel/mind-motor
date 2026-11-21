use std::{
    collections::HashMap,
    convert::Infallible,
    pin::Pin,
    sync::{atomic::{AtomicBool, Ordering}, Arc, Mutex},
    task::{Context, Poll},
    time::{Duration, Instant},
};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use bytes::Bytes;
use futures_util::Stream;
use http_body_util::{BodyExt, Full, Limited, StreamBody};
use hyper::{body::{Frame, Incoming}, header::{self, HeaderValue}, Method, Request, Response, StatusCode};
use serde_json::{json, Value};
use tokio::sync::{mpsc, oneshot, Notify};
use uuid::Uuid;

use crate::{
    host::{full, Body},
    motor_consent::Prepared,
    motor_files::{OrganizeDecision, OrganizePrepared},
    motor_native::{unwrap_catalog_call, Fault, Motor},
    motor_workspace::{with_workspace, Workspace},
    MAX_MESSAGE,
};

const SESSION_HEADER: &str = "mcp-session-id";
const SESSION_IDLE: Duration = Duration::from_secs(15 * 60);
const ROOTS_TIMEOUT: Duration = Duration::from_secs(5);
const CLIENT_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const PROTOCOLS: &[&str] = &["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const TOOLS: &[&str] = &[
    "estado", "retomar", "buscar", "leer", "crear", "modificar", "organizar",
    "guardar", "actualizar", "acceso",
    "vista", "mind", "mind_cambiar",
    "crear_carpeta", "editar", "mover", "renombrar", "borrar", "papelera",
    "restaurar", "vaciar_papelera", "explorar", "eliminados",
    "conversacion_leer", "conversacion_guardar", "conversaciones_buscar",
    "continuidad_registrar", "continuidad_actualizar",
    "solicitar_acceso", "retirar_acceso",
    "vista_abrir", "vista_consultar", "vista_cerrar",
    "crear_respaldo",
    "funciones", "crear_funcion", "modificar_funcion", "retirar_funcion",
    "ejecutar_funcion", "activar_funcion", "desactivar_funcion", "historial_funcion",
];

struct Session {
    seen: Instant,
    context: Arc<SessionContext>,
}

struct SessionContext {
    protocol: &'static str,
    form: bool,
    client: Option<Value>,
    scope: Mutex<Scope>,
    refresh: Option<tokio::sync::Mutex<()>>,
    live: AtomicBool,
    pending: Mutex<Pending>,
}

struct Scope {
    workspace: Workspace,
    generation: u64,
    resolved: bool,
}

#[derive(Default)]
struct Pending {
    replies: HashMap<Uuid, oneshot::Sender<Result<Value, Fault>>>,
    calls: HashMap<Uuid, Arc<StreamCall>>,
}

struct StreamCall {
    id: Value,
    active: AtomicBool,
    cancelled: Notify,
}

impl StreamCall {
    fn cancel(&self) {
        self.active.store(false, Ordering::Release);
        self.cancelled.notify_one();
    }
}

impl SessionContext {
    fn close(&self) {
        self.live.store(false, Ordering::Release);
        let mut pending = self.pending.lock().unwrap();
        for call in pending.calls.values() {
            call.cancel();
        }
        pending.replies.clear();
        pending.calls.clear();
    }

    fn workspace(&self) -> Workspace {
        self.scope.lock().unwrap().workspace.clone()
    }

    fn receive(&self, message: &Value) -> bool {
        if message["jsonrpc"] != "2.0" {
            return false;
        }
        if message.get("method").is_none() {
            let result = message.get("result");
            let error = message.get("error");
            if result.is_some() == error.is_some() {
                return false;
            }
            let Some(id) = message["id"].as_str().and_then(|id| Uuid::parse_str(id).ok()) else {
                return false;
            };
            if let Some(reply) = self.pending.lock().unwrap().replies.remove(&id) {
                let answer = result.cloned().ok_or_else(|| Fault::new("CLIENT_ERROR", "El cliente rechazó la solicitud."));
                let _ = reply.send(answer);
            }
            return true;
        }
        if message.get("id").is_some() {
            return false;
        }
        match message["method"].as_str() {
            Some("notifications/cancelled") => {
                if let Some(target) = message.pointer("/params/requestId") {
                    for call in self.pending.lock().unwrap().calls.values() {
                        if &call.id == target {
                            call.cancel();
                        }
                    }
                }
            }
            Some("notifications/roots/list_changed") if self.refresh.is_some() => {
                let mut scope = self.scope.lock().unwrap();
                scope.generation += 1;
                scope.resolved = false;
                scope.workspace.roots.clear();
                scope.workspace.user_data = None;
            }
            _ => return false,
        }
        true
    }
}

struct CallGuard<'a> {
    session: &'a SessionContext,
    key: Uuid,
    call: Arc<StreamCall>,
}

impl Drop for CallGuard<'_> {
    fn drop(&mut self) {
        self.call.cancel();
        self.session.pending.lock().unwrap().calls.remove(&self.key);
    }
}

struct ReplyGuard<'a> {
    session: &'a SessionContext,
    id: Uuid,
}

impl Drop for ReplyGuard<'_> {
    fn drop(&mut self) {
        self.session.pending.lock().unwrap().replies.remove(&self.id);
    }
}

/// El anfitrión valida el origen y el token antes de entregar la petición.
pub(crate) struct Mcp {
    sessions: tokio::sync::Mutex<HashMap<Uuid, Session>>,
}

fn prune(sessions: &mut HashMap<Uuid, Session>) {
    sessions.retain(|_, session| {
        if session.seen.elapsed() < SESSION_IDLE {
            return true;
        }
        session.context.close();
        false
    });
}

impl Mcp {
    pub(crate) fn new() -> Self {
        Self { sessions: tokio::sync::Mutex::new(HashMap::new()) }
    }

    pub(crate) async fn count(&self) -> usize {
        let mut sessions = self.sessions.lock().await;
        prune(&mut sessions);
        sessions.len()
    }

    pub(crate) async fn handle(&self, req: Request<Incoming>, motor: Arc<Motor>) -> Response<Body> {
        let (parts, incoming) = req.into_parts();
        if parts.method != Method::POST && parts.method != Method::DELETE {
            let mut response = full(StatusCode::METHOD_NOT_ALLOWED, json!({"error": "METHOD_NOT_ALLOWED"}));
            response.headers_mut().insert(header::ALLOW, HeaderValue::from_static("POST, DELETE"));
            return response;
        }

        let session = match parts.headers.get(SESSION_HEADER) {
            Some(value) => {
                let id = value.to_str().ok().and_then(|value| Uuid::parse_str(value).ok());
                let Some(id) = id else { return missing_session() };
                let mut sessions = self.sessions.lock().await;
                prune(&mut sessions);
                let Some(session) = sessions.get_mut(&id) else { return missing_session() };
                if parts.method == Method::DELETE {
                    session.context.close();
                    sessions.remove(&id);
                    return full(StatusCode::OK, json!({"closed": true}));
                }
                session.seen = Instant::now();
                Some((id, Arc::clone(&session.context)))
            }
            None if parts.method == Method::DELETE => {
                return full(StatusCode::BAD_REQUEST, json!({"error": "MISSING_SESSION_ID"}));
            }
            None => None,
        };

        let body = match Limited::new(incoming, MAX_MESSAGE).collect().await {
            Ok(body) => body.to_bytes(),
            Err(error) if error.is::<http_body_util::LengthLimitError>() => {
                return full(StatusCode::PAYLOAD_TOO_LARGE, rpc_error(Value::Null, -32600, "Mensaje demasiado grande."));
            }
            Err(_) => return full(StatusCode::BAD_REQUEST, rpc_error(Value::Null, -32600, "No se pudo leer la petición.")),
        };
        let message: Value = match serde_json::from_slice(&body) {
            Ok(message) => message,
            Err(_) => return full(StatusCode::BAD_REQUEST, rpc_error(Value::Null, -32700, "JSON no válido.")),
        };

        match session {
            Some((id, context)) => {
                let sse = parts.headers.get_all(header::ACCEPT).iter().filter_map(|value| value.to_str().ok())
                    .any(|value| value.split(',').any(|media| media.trim() == "text/event-stream"));
                with_session(dispatch(&message, &motor, &context, sse).await, id)
            }
            None if message.get("method").and_then(Value::as_str) == Some("initialize") => {
                self.initialize(&message, &parts.headers, motor).await
            }
            None if message.get("method").and_then(Value::as_str) == Some("server/discover") => {
                full(StatusCode::NOT_FOUND, json!({"error": "DISCOVERY_NOT_SUPPORTED"}))
            }
            None => full(
                StatusCode::BAD_REQUEST,
                rpc_error(request_id(&message).unwrap_or(Value::Null), -32600, "Falta cabecera Mcp-Session-Id."),
            ),
        }
    }

    async fn initialize(&self, message: &Value, headers: &hyper::HeaderMap, motor: Arc<Motor>) -> Response<Body> {
        let id = request_id(message).unwrap_or(Value::Null);
        if message.get("jsonrpc").and_then(Value::as_str) != Some("2.0") || id.is_null() {
            return full(StatusCode::BAD_REQUEST, rpc_error(id, -32600, "Mensaje JSON-RPC no válido."));
        }
        let empty = json!({});
        let params = message.get("params").unwrap_or(&empty);
        if !params.is_object() {
            return full(StatusCode::BAD_REQUEST, rpc_error(id, -32602, "params debe ser un objeto."));
        }
        let requested = params.get("protocolVersion").and_then(Value::as_str);
        let protocol = PROTOCOLS.iter().copied().find(|version| Some(*version) == requested).unwrap_or(PROTOCOLS[0]);
        let form = params.pointer("/capabilities/elicitation").and_then(Value::as_object)
            .is_some_and(|elicitation| elicitation.is_empty() || elicitation.get("form").is_some_and(Value::is_object));
        let client = params.get("clientInfo").filter(|client| client.is_object()).cloned();
        let (paths, cwd) = match declared_paths(headers.get("x-mind-workspace")) {
            Ok(declared) => declared,
            Err(()) => return full(StatusCode::BAD_REQUEST, rpc_error(id, -32602, "Carpeta de trabajo no válida.")),
        };
        let roots = paths.is_empty() && params.pointer("/capabilities/roots").is_some_and(Value::is_object);
        let open_scope = tokio::task::spawn_blocking(move || {
            if roots || !paths.is_empty() {
                return motor.workspace(&paths, true);
            }
            if let Some(cwd) = cwd {
                let candidate = motor.workspace(&[cwd], true)?;
                if candidate.has_roots() {
                    return Ok(candidate);
                }
            }
            motor.workspace(&[], false)
        });
        let workspace = match open_scope.await {
            Ok(Ok(workspace)) => workspace,
            Ok(Err(error)) => return full(StatusCode::BAD_REQUEST, rpc_error(id, -32602, &error.message)),
            Err(_) => return full(StatusCode::INTERNAL_SERVER_ERROR, rpc_error(id, -32603, "Mind no pudo abrir la sesión.")),
        };
        let session = Uuid::new_v4();
        let context = Arc::new(SessionContext {
            protocol, form, client, live: AtomicBool::new(true),
            scope: Mutex::new(Scope { workspace, generation: 0, resolved: !roots }),
            refresh: roots.then(|| tokio::sync::Mutex::new(())),
            pending: Mutex::new(Pending::default()),
        });
        let mut sessions = self.sessions.lock().await;
        prune(&mut sessions);
        sessions.insert(session, Session { seen: Instant::now(), context });
        let result = json!({
            "protocolVersion": protocol,
            "capabilities": { "tools": { "listChanged": false } },
            "serverInfo": { "name": "Mind", "version": "1.0.5" },
            "instructions": "Consulta las autorizaciones con estado. Busca conversaciones por texto y usa retomar con el ID o la consulta. Lee archivos de texto antes de modificar una versión. Para actualizar una conversación, usa su ID y revisión vigentes.",
        });
        with_session(full(StatusCode::OK, rpc_result(id, result)), session)
    }
}

fn declared_paths(value: Option<&HeaderValue>) -> Result<(Vec<String>, Option<String>), ()> {
    let Some(value) = value else { return Ok((Vec::new(), None)) };
    let raw = URL_SAFE_NO_PAD.decode(value.as_bytes()).map_err(|_| ())?;
    let workspace: Value = serde_json::from_slice(&raw).map_err(|_| ())?;
    let object = workspace.as_object().ok_or(())?;
    let mut paths = Vec::new();
    if let Some(entries) = object.get("paths") {
        for path in entries.as_array().ok_or(())? {
            let path = path.as_str().ok_or(())?;
            if !path.trim().is_empty() {
                paths.push(path.to_owned());
            }
        }
    }
    let cwd = object.get("cwd").and_then(Value::as_str).filter(|cwd| !cwd.trim().is_empty()).map(str::to_owned);
    Ok((paths, cwd))
}

fn is_call(message: &Value) -> bool {
    message["jsonrpc"] == "2.0" && message["method"] == "tools/call"
}

enum InteractiveKind {
    None,
    Access { needs_form: bool },
    Organize,
    Automation,
}

fn resolve_interactive(message: &Value) -> Option<(InteractiveKind, Value)> {
    let name = message.pointer("/params/name").and_then(Value::as_str)?;
    if !TOOLS.contains(&name) {
        return None;
    }
    let args = message.pointer("/params/arguments").cloned().unwrap_or_else(|| json!({}));
    if !args.is_object() {
        return None;
    }
    let (eff_name, eff_args) = unwrap_catalog_call(name, args).ok()?;
    let kind = match eff_name.as_str() {
        "acceso" => InteractiveKind::Access {
            needs_form: eff_args.get("accion").and_then(Value::as_str) != Some("retirar"),
        },
        "borrar" | "vaciar_papelera" => InteractiveKind::Organize,
        "organizar" if matches!(eff_args.get("accion").and_then(Value::as_str), Some("borrar" | "vaciar_papelera")) => {
            InteractiveKind::Organize
        }
        "activar_funcion" => InteractiveKind::Automation,
        _ => return Some((InteractiveKind::None, message.clone())),
    };
    let mut normalized = message.clone();
    if let Some(params) = normalized.get_mut("params").and_then(Value::as_object_mut) {
        params.insert("name".into(), json!(eff_name));
        params.insert("arguments".into(), eff_args);
    }
    Some((kind, normalized))
}

async fn dispatch(
    message: &Value, motor: &Arc<Motor>, session: &Arc<SessionContext>, sse: bool,
) -> Response<Body> {
    let Some(messages) = message.as_array() else {
        if let Some(id) = request_id(message).filter(|_| is_call(message)) {
            let resolved = resolve_interactive(message);
            let roots = !session.scope.lock().unwrap().resolved;
            let needs_form = matches!(
                resolved.as_ref().map(|(kind, _)| kind),
                Some(InteractiveKind::Access { needs_form: true } | InteractiveKind::Organize | InteractiveKind::Automation)
            );
            if sse && (roots || (needs_form && session.form)) {
                return stream_call(message.clone(), id, Arc::clone(motor), Arc::clone(session));
            }
            match resolved {
                Some((InteractiveKind::Access { .. }, ref msg)) => {
                    return full(StatusCode::OK, access(msg, id, motor, session, None).await);
                }
                Some((InteractiveKind::Organize, ref msg)) => {
                    return full(StatusCode::OK, organize_interactive(msg, id, motor, session, None).await);
                }
                Some((InteractiveKind::Automation, ref msg)) => {
                    return full(StatusCode::OK, automation_interactive(msg, id, motor, session, None).await);
                }
                _ => {}
            }
        }
        return match dispatch_one(message, motor, session).await {
            Some(reply) => full(StatusCode::OK, reply),
            None => accepted(),
        };
    };
    if messages.is_empty() {
        return full(StatusCode::BAD_REQUEST, rpc_error(Value::Null, -32600, "Lote JSON-RPC vacío."));
    }
    let mut replies = Vec::new();
    for message in messages {
        if let Some(reply) = dispatch_one(message, motor, session).await {
            replies.push(reply);
        }
    }
    if replies.is_empty() { accepted() } else { full(StatusCode::OK, json!(replies)) }
}

async fn dispatch_one(message: &Value, motor: &Arc<Motor>, session: &Arc<SessionContext>) -> Option<Value> {
    if session.receive(message) {
        return None;
    }
    let id = request_id(message);
    if message.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
        return Some(rpc_error(id.unwrap_or(Value::Null), -32600, "Mensaje JSON-RPC no válido."));
    }
    let Some(method) = message.get("method").and_then(Value::as_str) else {
        return Some(rpc_error(id.unwrap_or(Value::Null), -32600, "Mensaje JSON-RPC no válido."));
    };
    let id = match id {
        Some(id) => id,
        None if message.get("id").is_none() => return None,
        None => return Some(rpc_error(Value::Null, -32600, "Identificador JSON-RPC no válido.")),
    };
    let empty = json!({});
    let params = message.get("params").unwrap_or(&empty);
    if !params.is_object() {
        return Some(rpc_error(id, -32602, "params debe ser un objeto."));
    }
    let result = match method {
        "ping" => json!({}),
        "tools/list" => json!({"tools": definitions()}),
        "tools/call" => {
            let Some(name) = params.get("name").and_then(Value::as_str).filter(|name| TOOLS.contains(name)) else {
                return Some(rpc_error(id, -32602, "Herramienta desconocida."));
            };
            let is_interactive = matches!(
                resolve_interactive(message).map(|(kind, _)| kind),
                Some(InteractiveKind::Access { .. } | InteractiveKind::Organize | InteractiveKind::Automation)
            );
            if name == "acceso" || is_interactive {
                return Some(rpc_error(id, -32602, "Envía la solicitud que requiere confirmación en una petición individual."));
            }
            let args = params.get("arguments").unwrap_or(&empty);
            if !args.is_object() {
                return Some(rpc_error(id, -32602, "arguments debe ser un objeto."));
            }
            let motor = Arc::clone(motor);
            let session = Arc::clone(session);
            let (name, args) = (name.to_owned(), args.clone());
            let result = tokio::task::spawn_blocking(move || {
                if !session.live.load(Ordering::Acquire) { return Err(closed()); }
                with_workspace(&session.workspace(), || motor.call(&name, args))
            }).await.unwrap_or_else(|_| Err(internal()));
            tool_reply(result)
        }
        _ => return Some(rpc_error(id, -32601, "Método no admitido.")),
    };
    Some(rpc_result(id, result))
}

struct ServerEvents<'a> {
    session: &'a SessionContext,
    sender: &'a mpsc::Sender<Frame<Bytes>>,
    call: Arc<StreamCall>,
}

impl ServerEvents<'_> {
    async fn request(&self, method: &str, params: Value, timeout: Duration) -> Result<Value, Fault> {
        if !self.session.live.load(Ordering::Acquire) {
            return Err(closed());
        }
        if !self.call.active.load(Ordering::Acquire) {
            return Err(cancelled());
        }
        let (reply, answer) = oneshot::channel();
        let request = ReplyGuard { session: self.session, id: Uuid::new_v4() };
        self.session.pending.lock().unwrap().replies.insert(request.id, reply);
        self.sender.send(frame(json!({
            "jsonrpc": "2.0", "id": request.id.to_string(), "method": method, "params": params,
        }))).await.map_err(|_| closed())?;
        match tokio::time::timeout(timeout, answer).await {
            Ok(Ok(answer)) => answer,
            Ok(Err(_)) => Err(closed()),
            Err(_) => Err(Fault::new("CLIENT_TIMEOUT", "El cliente no respondió a tiempo.")),
        }
    }
}

fn stream_call(message: Value, id: Value, motor: Arc<Motor>, session: Arc<SessionContext>) -> Response<Body> {
    let (sender, receiver) = mpsc::channel(2);
    let key = Uuid::new_v4();
    let call = Arc::new(StreamCall { id: id.clone(), active: AtomicBool::new(true), cancelled: Notify::new() });
    session.pending.lock().unwrap().calls.insert(key, Arc::clone(&call));
    tokio::spawn(async move {
        let _guard = CallGuard { session: &session, key, call: Arc::clone(&call) };
        let events = ServerEvents { session: &session, sender: &sender, call: Arc::clone(&call) };
        let reply = tokio::select! {
            biased;
            _ = sender.closed() => return,
            _ = call.cancelled.notified() => {
                let error = if session.live.load(Ordering::Acquire) { cancelled() } else { closed() };
                rpc_result(id.clone(), tool_reply(Err(error)))
            }
            result = async {
                refresh_roots(&motor, &session, &events).await;
                match resolve_interactive(&message) {
                    Some((InteractiveKind::Access { .. }, ref msg)) => {
                        access(msg, id.clone(), &motor, &session, Some(&events)).await
                    }
                    Some((InteractiveKind::Organize, ref msg)) => {
                        organize_interactive(msg, id.clone(), &motor, &session, Some(&events)).await
                    }
                    Some((InteractiveKind::Automation, ref msg)) => {
                        automation_interactive(msg, id.clone(), &motor, &session, Some(&events)).await
                    }
                    _ => dispatch_one(&message, &motor, &session).await
                        .unwrap_or_else(|| rpc_error(id.clone(), -32600, "Mensaje JSON-RPC no válido.")),
                }
            } => result,
        };
        let _ = sender.send(frame(reply)).await;
    });
    let body = StreamBody::new(EventStream(receiver)).boxed();
    let mut response = Response::new(body);
    response.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("text/event-stream"));
    response.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    response
}

async fn refresh_roots(motor: &Arc<Motor>, session: &Arc<SessionContext>, events: &ServerEvents<'_>) {
    let Some(refresh) = &session.refresh else { return };
    let _refresh = refresh.lock().await;
    let generation = {
        let scope = session.scope.lock().unwrap();
        if scope.resolved { return; }
        scope.generation
    };
    let result = events.request("roots/list", json!({}), ROOTS_TIMEOUT).await;
    let workspace = match result.ok().and_then(root_paths) {
        Some(paths) => {
            let motor = Arc::clone(motor);
            tokio::task::spawn_blocking(move || motor.workspace(&paths, true)).await.ok().and_then(Result::ok)
        }
        None => None,
    };
    let mut scope = session.scope.lock().unwrap();
    if scope.generation == generation && events.call.active.load(Ordering::Acquire) && session.live.load(Ordering::Acquire) {
        if let Some(workspace) = workspace {
            scope.workspace = workspace;
        }
        scope.resolved = true;
    }
}

fn root_paths(result: Value) -> Option<Vec<String>> {
    let roots = result["roots"].as_array()?;
    if roots.len() > 64 {
        return None;
    }
    roots.iter().map(|root| {
        let url = reqwest::Url::parse(root["uri"].as_str()?).ok()?;
        if url.scheme() != "file" || url.query().is_some() || url.fragment().is_some() {
            return None;
        }
        url.to_file_path().ok()?.into_os_string().into_string().ok()
    }).collect()
}

async fn access(
    message: &Value, id: Value, motor: &Arc<Motor>, session: &Arc<SessionContext>, events: Option<&ServerEvents<'_>>,
) -> Value {
    let args = message.pointer("/params/arguments").cloned().unwrap_or_else(|| json!({}));
    if !args.is_object() {
        return rpc_error(id, -32602, "arguments debe ser un objeto.");
    }
    let result = run_access(args, motor, session, events).await;
    rpc_result(id, tool_reply(result))
}

async fn run_access(
    args: Value, motor: &Arc<Motor>, session: &Arc<SessionContext>, events: Option<&ServerEvents<'_>>,
) -> Result<Value, Fault> {
    let (workspace, generation) = {
        let scope = session.scope.lock().unwrap();
        (scope.workspace.clone(), scope.generation)
    };
    let call = events.map(|events| Arc::clone(&events.call));
    let prepare = tokio::task::spawn_blocking({
        let (motor, session, workspace, call) = (Arc::clone(motor), Arc::clone(session), workspace.clone(), call.clone());
        move || {
            session.ensure_active(call.as_deref(), generation)?;
            with_workspace(&workspace, || {
                if args["accion"] == "retirar" {
                    return motor.call("acceso", args).map(Prepared::Authorized);
                }
                motor.prepare_access(args, session.client.as_ref())
            })
        }
    });
    let request = match prepare.await.map_err(|_| internal())?? {
        Prepared::Authorized(value) => return Ok(value),
        Prepared::Request(request) => request,
    };
    let answer = match events.filter(|_| session.form) {
        Some(events) => Some(events.request("elicitation/create", request.form(session.protocol), CLIENT_TIMEOUT).await?),
        None => None,
    };
    let (motor, session) = (Arc::clone(motor), Arc::clone(session));
    tokio::task::spawn_blocking(move || {
        session.ensure_active(call.as_deref(), generation)?;
        let active = || session.ensure_active(call.as_deref(), generation).is_ok();
        with_workspace(&workspace, || motor.finish_access(request, answer.as_ref(), active))
    }).await.map_err(|_| internal())?
}

async fn organize_interactive(
    message: &Value, id: Value, motor: &Arc<Motor>, session: &Arc<SessionContext>, events: Option<&ServerEvents<'_>>,
) -> Value {
    let mut args = message.pointer("/params/arguments").cloned().unwrap_or_else(|| json!({}));
    let Some(obj) = args.as_object_mut() else {
        return rpc_error(id, -32602, "arguments debe ser un objeto.");
    };
    if let Some(name @ ("borrar" | "vaciar_papelera")) = message.pointer("/params/name").and_then(Value::as_str) {
        if obj.insert("accion".into(), json!(name)).is_some() {
            return rpc_result(id, tool_reply(Err(Fault::new("INVALID_ARGUMENTS", "La llamada incluye argumentos no admitidos."))));
        }
    }
    let result = run_organize(args, motor, session, events).await;
    rpc_result(id, tool_reply(result))
}

async fn run_organize(
    args: Value, motor: &Arc<Motor>, session: &Arc<SessionContext>, events: Option<&ServerEvents<'_>>,
) -> Result<Value, Fault> {
    let (workspace, generation) = {
        let scope = session.scope.lock().unwrap();
        (scope.workspace.clone(), scope.generation)
    };
    let call = events.map(|events| Arc::clone(&events.call));
    let prepare = tokio::task::spawn_blocking({
        let (motor, session, workspace, call) = (Arc::clone(motor), Arc::clone(session), workspace.clone(), call.clone());
        move || {
            session.ensure_active(call.as_deref(), generation)?;
            with_workspace(&workspace, || motor.prepare_organize(args, session.client.as_ref()))
        }
    });
    let confirmation = match prepare.await.map_err(|_| internal())?? {
        OrganizePrepared::Immediate(value) => return Ok(value),
        OrganizePrepared::Confirm(confirmation) => confirmation,
    };
    let (first, second) = match events.filter(|_| session.form) {
        Some(events) => {
            let first = events.request("elicitation/create", confirmation.first_form(session.protocol), CLIENT_TIMEOUT).await?;
            let second = if first["action"] == "accept"
                && first["content"]["confirmar"] == true
                && confirmation.requires_second_form()
            {
                Some(events.request("elicitation/create", confirmation.second_form(session.protocol), CLIENT_TIMEOUT).await?)
            } else {
                None
            };
            (Some(first), second)
        }
        None => (None, None),
    };
    let (motor, session) = (Arc::clone(motor), Arc::clone(session));
    tokio::task::spawn_blocking(move || {
        session.ensure_active(call.as_deref(), generation)?;
        let active = || session.ensure_active(call.as_deref(), generation).is_ok();
        let decision = match &first {
            Some(first_val) => OrganizeDecision::FromForms {
                first: Some(first_val),
                second: second.as_ref(),
            },
            None => OrganizeDecision::Pending { cancelled: false },
        };
        with_workspace(&workspace, || motor.finish_organize(confirmation, decision, active))
    }).await.map_err(|_| internal())?
}

async fn automation_interactive(
    message: &Value, id: Value, motor: &Arc<Motor>, session: &Arc<SessionContext>, events: Option<&ServerEvents<'_>>,
) -> Value {
    let args = message.pointer("/params/arguments").cloned().unwrap_or_else(|| json!({}));
    if !args.is_object() {
        return rpc_error(id, -32602, "arguments debe ser un objeto.");
    }
    let result = run_automation(args, motor, session, events).await;
    rpc_result(id, tool_reply(result))
}

async fn run_automation(
    args: Value, motor: &Arc<Motor>, session: &Arc<SessionContext>, events: Option<&ServerEvents<'_>>,
) -> Result<Value, Fault> {
    let (workspace, generation) = {
        let scope = session.scope.lock().unwrap();
        (scope.workspace.clone(), scope.generation)
    };
    let call = events.map(|events| Arc::clone(&events.call));
    let prepare = tokio::task::spawn_blocking({
        let (motor, session, workspace, call) = (Arc::clone(motor), Arc::clone(session), workspace.clone(), call.clone());
        move || {
            session.ensure_active(call.as_deref(), generation)?;
            with_workspace(&workspace, || motor.prepare_activation(args, session.client.as_ref()))
        }
    });
    let request = prepare.await.map_err(|_| internal())??;
    let answer = match events.filter(|_| session.form) {
        Some(events) => Some(events.request("elicitation/create", request.form(session.protocol), CLIENT_TIMEOUT).await?),
        None => None,
    };
    let (motor, session) = (Arc::clone(motor), Arc::clone(session));
    tokio::task::spawn_blocking(move || {
        session.ensure_active(call.as_deref(), generation)?;
        let active = || session.ensure_active(call.as_deref(), generation).is_ok();
        with_workspace(&workspace, || motor.finish_activation(request, answer.as_ref(), session.client.as_ref(), active))
    }).await.map_err(|_| internal())?
}

impl SessionContext {
    fn ensure_active(&self, call: Option<&StreamCall>, generation: u64) -> Result<(), Fault> {
        if !self.live.load(Ordering::Acquire) {
            return Err(closed());
        }
        if call.is_some_and(|call| !call.active.load(Ordering::Acquire)) {
            return Err(cancelled());
        }
        if self.scope.lock().unwrap().generation != generation {
            return Err(Fault::new("WORKSPACE_CHANGED", "Las carpetas abiertas cambiaron durante la solicitud."));
        }
        Ok(())
    }
}

fn internal() -> Fault {
    Fault::new("ERROR_INTERNO", "Mind no pudo completar la operación.")
}

fn closed() -> Fault {
    Fault::new("SESSION_CLOSED", "La sesión con el agente terminó.")
}

fn cancelled() -> Fault {
    Fault::new("REQUEST_CANCELLED", "La solicitud se canceló.")
}

fn frame(message: Value) -> Frame<Bytes> {
    Frame::data(Bytes::from(format!("event: message\ndata: {message}\n\n")))
}

struct EventStream(mpsc::Receiver<Frame<Bytes>>);

impl Stream for EventStream {
    type Item = Result<Frame<Bytes>, std::io::Error>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        self.0.poll_recv(cx).map(|frame| frame.map(Ok))
    }
}

fn request_id(message: &Value) -> Option<Value> {
    let id = message.get("id")?;
    let valid_number = id.as_i64().is_some_and(|id| (-9_007_199_254_740_991..=9_007_199_254_740_991).contains(&id));
    (id.is_string() || valid_number).then(|| id.clone())
}

fn rpc_result(id: Value, result: Value) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "result": result})
}

fn rpc_error(id: Value, code: i32, message: &str) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}})
}

fn tool_reply(result: Result<Value, Fault>) -> Value {
    let (value, is_error) = match result {
        Ok(value) => (value, false),
        Err(error) => (json!({"error": {"codigo": error.code, "mensaje": error.message}}), true),
    };
    let structured = if value.is_object() { value } else { json!({"valor": value}) };
    let mut result = json!({
        "content": [{"type": "text", "text": structured.to_string()}],
        "structuredContent": structured,
    });
    if is_error { result["isError"] = json!(true); }
    result
}

fn with_session(mut response: Response<Body>, id: Uuid) -> Response<Body> {
    response.headers_mut().insert(SESSION_HEADER, HeaderValue::from_str(&id.to_string()).expect("UUID ASCII"));
    response
}

fn accepted() -> Response<Body> {
    let body = Full::new(Bytes::new()).map_err(|never: Infallible| match never {}).boxed();
    let mut response = Response::new(body);
    *response.status_mut() = StatusCode::ACCEPTED;
    response
}

fn missing_session() -> Response<Body> {
    full(StatusCode::NOT_FOUND, rpc_error(Value::Null, -32001, "Sesión MCP no encontrada."))
}

fn definitions() -> Value {
    let references = json!({"type": "array", "maxItems": 100, "items": {
        "type": "object", "properties": {
            "registro": {"type": "string"}, "ubicacion": {"type": "string"},
            "relacion": {"type": "string"},
        }, "additionalProperties": false,
        "description": "Indica registro o ubicacion. La relación es opcional.",
    }});
    json!([
        {
            "name": "acceso",
            "title": "Solicitar autorización",
            "description": "Solicita acceso a una carpeta o a la continuidad para que el usuario decida. También permite reducir permisos o excluir rutas de una carpeta.",
            "inputSchema": {"type": "object", "properties": {
                "accion": {"type":"string","enum":["solicitar","retirar"]},
                "ruta": {"type":"string"},
                "acceso": {"type":"string","enum":["encontrar","leer","completo"]},
                "permisos": {"type":"array","items":{"type":"string","enum":["encontrar","leer","escribir","organizar"]}},
                "continuidad": {"type":"array","items":{"type":"string","enum":["leer","registrar"]}},
                "motivo": {"type":"string"},
                "carpeta": {"type":"string"},
                "excluir": {"type":"array","items":{"type":"string"}},
                "todo": {"type":"boolean"},
            }, "additionalProperties": false},
            "annotations": {"readOnlyHint": false, "destructiveHint": false, "openWorldHint": false},
        },
        {
            "name": "estado",
            "title": "Estado de Mind",
            "description": "Consulta las autorizaciones y el estado del Motor.",
            "inputSchema": {"type": "object", "properties": {}, "additionalProperties": false},
            "annotations": {"readOnlyHint": true, "openWorldHint": false},
        },
        {
            "name": "retomar",
            "title": "Retomar una conversación",
            "description": "Recupera una conversación y su destino por ID de Mind. Si desconoces el ID, indica una consulta de texto.",
            "inputSchema": {"type": "object", "properties": {
                "id": {"type": "string"}, "consulta": {"type": "string"}, "proyecto": {"type": "string"},
            }, "anyOf": [{"required": ["id"]}, {"required": ["consulta"]}], "additionalProperties": false},
            "annotations": {"readOnlyHint": true, "openWorldHint": false},
        },
        {
            "name": "buscar",
            "title": "Buscar archivos, carpetas, eliminados o conversaciones",
            "description": "Busca en los índices persistentes de Mind (archivos, carpeta, eliminados) o en conversaciones.",
            "inputSchema": {"type": "object", "properties": {
                "en": {"type": "string", "enum": ["archivos", "carpeta", "eliminados", "conversaciones"], "default": "archivos"},
                "consulta": {"type": "string"}, "proyecto": {"type": "string"},
                "carpetas": {"type": "array", "items": {"type": "string"}},
                "carpeta": {"type": "string"}, "ruta": {"type": "string"},
                "modo": {"type": "string", "enum": ["contiene", "empieza", "exacto"]},
                "campo": {"type": "string", "enum": ["nombre", "ruta"]},
                "tipos": {"type": "array", "items": {"type": "string", "enum": ["archivo", "carpeta", "enlace", "otro"]}},
                "extensiones": {"type": "array", "items": {"type": "string"}},
                "dentro_de": {"type": "string"},
                "tamano_min": {"type": "integer", "minimum": 0},
                "tamano_max": {"type": "integer", "minimum": 0},
                "modificado_desde": {"type": "string"},
                "modificado_hasta": {"type": "string"},
                "orden": {"type": "string", "enum": ["relevancia", "ruta", "modificado", "tamano"]},
                "profundidad": {"type": "integer", "minimum": 1, "maximum": 8},
                "desde": {},
                "limite": {"type": "integer", "minimum": 1, "maximum": 1000},
            }, "additionalProperties": false},
            "annotations": {"readOnlyHint": true, "openWorldHint": false},
        },
        {
            "name": "leer",
            "title": "Leer un archivo de texto o documento de oficina",
            "description": "Lee texto UTF-8 (con su versión) o extrae texto de documentos de oficina (.docx, .xlsx, .pptx, .odt, .ods, .odp). Permite leer por sección o acotar líneas.",
            "inputSchema": {"type": "object", "properties": {
                "carpeta": {"type": "string", "description": "ID o ruta absoluta de la carpeta registrada."},
                "ruta": {"type": "string", "description": "Ruta relativa dentro de la carpeta."},
                "seccion": {"type": "string", "description": "Encabezado Markdown a extraer, o \"?\" para el índice."},
                "desde_linea": {"type": "integer", "minimum": 1},
                "lineas": {"type": "integer", "minimum": 1},
            }, "required": ["ruta"], "additionalProperties": false},
            "annotations": {"readOnlyHint": true, "openWorldHint": false},
        },
        {
            "name": "crear",
            "title": "Crear un archivo de texto o una carpeta",
            "description": "Crea texto UTF-8 con contenido o crea una carpeta. Conserva los elementos existentes.",
            "inputSchema": {"type": "object", "properties": {
                "accion": {"type": "string", "enum": ["archivo", "carpeta"], "default": "archivo"},
                "carpeta": {"type": "string", "description": "ID o ruta absoluta de la carpeta registrada."},
                "ruta": {"type": "string", "description": "Ruta relativa dentro de la carpeta."},
                "contenido": {"type": "string", "description": "Texto para la acción archivo."},
            }, "required": ["ruta"], "additionalProperties": false},
            "annotations": {"readOnlyHint": false, "destructiveHint": false, "openWorldHint": false},
        },
        {
            "name": "modificar",
            "title": "Modificar o editar un archivo de texto",
            "description": "Sustituye el contenido UTF-8 completo cuando coincide la versión obtenida al leer, o aplica reemplazos puntuales con ediciones.",
            "inputSchema": {"type": "object", "properties": {
                "carpeta": {"type": "string", "description": "ID o ruta absoluta de la carpeta registrada."},
                "ruta": {"type": "string", "description": "Ruta relativa dentro de la carpeta."},
                "version": {"type": "string", "pattern": "^sha256:[0-9a-f]{64}$"},
                "contenido": {"type": "string"},
                "ediciones": {
                    "type": "array", "minItems": 1, "maxItems": 50,
                    "items": {"type": "object", "properties": {
                        "buscar": {"type": "string"}, "reemplazar": {"type": "string"}, "todas": {"type": "boolean"}
                    }, "required": ["buscar", "reemplazar"], "additionalProperties": false}
                },
            }, "required": ["ruta"], "additionalProperties": false},
            "annotations": {"readOnlyHint": false, "destructiveHint": true, "openWorldHint": false},
        },
        {
            "name": "organizar",
            "title": "Organizar archivos y papelera de Mind",
            "description": "Mueve, renombra, borra a la papelera de Mind (con confirmación del usuario), lista la papelera, restaura o vacía la papelera (con doble confirmación).",
            "inputSchema": {"type": "object", "properties": {
                "accion": {"type": "string", "enum": ["mover", "renombrar", "borrar", "papelera", "restaurar", "vaciar_papelera"]},
                "carpeta": {"type": "string"},
                "carpeta_destino": {"type": "string"},
                "ruta": {"type": "string"},
                "desde": {"type": "string"},
                "hasta": {"type": "string"},
                "nuevo_nombre": {"type": "string"},
                "id": {"type": "string"},
                "motivo": {"type": "string"},
            }, "required": ["accion"], "additionalProperties": false},
            "annotations": {"readOnlyHint": false, "destructiveHint": true, "openWorldHint": false},
        },
        {
            "name": "guardar",
            "title": "Guardar algo nuevo",
            "description": "Para una conversación, indica titulo e importante. Para un registro de continuidad, indica en: continuidad y contenido.",
            "inputSchema": {"type": "object", "properties": {
                "en": {"type": "string", "enum": ["conversacion", "continuidad"], "default": "conversacion"},
                "titulo": {"type": "string"}, "importante": {"type": "string"},
                "proyecto": {"type": "string"}, "destino": {"type": "string"},
                "tipo": {"type": ["string", "null"], "description": "Etiqueta del registro de continuidad."},
                "contenido": {"description": "Datos JSON del registro de continuidad."},
                "referencias": references,
            }, "additionalProperties": true},
            "annotations": {"readOnlyHint": false, "destructiveHint": false, "openWorldHint": false},
        },
        {
            "name": "actualizar",
            "title": "Actualizar lo guardado",
            "description": "Actualiza una conversación o un registro de continuidad por ID y revisión. Para completar un Markdown pendiente, usa los datos de reintento devueltos por el guardado.",
            "inputSchema": {"type": "object", "properties": {
                "en": {"type": "string", "enum": ["conversacion", "continuidad"], "default": "conversacion"},
                "id": {"type": "string"}, "revision": {"type": "integer", "minimum": 1},
                "importante": {"type": "string"},
                "tipo": {"type": ["string", "null"], "description": "Etiqueta del registro de continuidad."},
                "contenido": {"description": "Datos JSON del registro de continuidad."},
                "referencias": references,
            }, "required": ["id", "revision"], "additionalProperties": true},
            "annotations": {"readOnlyHint": false, "destructiveHint": true, "openWorldHint": false},
        },
        {
            "name": "vista",
            "title": "Vista compartida local",
            "description": "Publica, consulta o cierra una vista web local de una carpeta con permiso de lectura (por ejemplo un sitio o construcción web con index.html). Sigue accesible en el navegador aunque el agente cierre sesión.",
            "inputSchema": {"type": "object", "properties": {
                "accion": {"type": "string", "enum": ["abrir", "consultar", "cerrar"]},
                "carpeta": {"type": "string", "description": "ID o ruta absoluta de la carpeta registrada."},
                "ruta": {"type": "string", "description": "Subcarpeta relativa dentro de la carpeta."},
                "proyecto": {"type": "string", "description": "Nombre del proyecto."},
                "id": {"type": "string", "description": "Identificador UUID de la vista."},
                "version": {"type": "integer", "minimum": 1, "description": "Versión leída al actualizar una vista."}
            }, "required": ["accion"], "additionalProperties": false},
            "annotations": {"readOnlyHint": false, "destructiveHint": false, "openWorldHint": false},
        },
        {
            "name": "mind",
            "title": "Consultas de Mind",
            "description": "Ejecuta por su nombre cualquier operación de Mind que solo consulta (ayuda, funciones, historial_funcion, vista_consultar…). operacion \"ayuda\" lista las disponibles en mind y mind_cambiar.",
            "inputSchema": {"type": "object", "properties": {
                "operacion": {"type": "string", "description": "\"ayuda\" o el nombre de una operación de consulta."},
                "detalle": {"type": "string", "description": "Con ayuda: operación a describir."},
                "argumentos": {"type": "object", "description": "Parámetros de la operación."}
            }, "required": ["operacion"], "additionalProperties": true},
            "annotations": {"readOnlyHint": true, "openWorldHint": false},
        },
        {
            "name": "mind_cambiar",
            "title": "Cambios en Mind",
            "description": "Ejecuta por su nombre una operación de Mind que cambia algo (funciones, activar_funcion, desactivar_funcion, crear_respaldo, vista_abrir, vista_cerrar…). Las que borran o activan automatizaciones siguen pidiendo confirmación al usuario.",
            "inputSchema": {"type": "object", "properties": {
                "operacion": {"type": "string", "description": "Nombre de la operación."},
                "argumentos": {"type": "object", "description": "Parámetros de la operación."}
            }, "required": ["operacion"], "additionalProperties": true},
            "annotations": {"readOnlyHint": false, "destructiveHint": true, "openWorldHint": false},
        }
    ])
}
