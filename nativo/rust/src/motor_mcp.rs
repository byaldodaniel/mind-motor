use std::{collections::HashMap, convert::Infallible, sync::Arc, time::{Duration, Instant}};

use bytes::Bytes;
use http_body_util::{BodyExt, Full, Limited};
use hyper::{body::Incoming, header::{self, HeaderValue}, Method, Request, Response, StatusCode};
use serde_json::{json, Value};
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::{host::{full, Body}, motor_native::Motor, MAX_MESSAGE};

const SESSION_HEADER: &str = "mcp-session-id";
const SESSION_IDLE: Duration = Duration::from_secs(15 * 60);
const PROTOCOLS: &[&str] = &["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const TOOLS: &[&str] = &[
    "estado", "retomar", "buscar", "leer", "crear", "modificar", "guardar", "actualizar",
];

/// El anfitrión valida el origen y el token antes de entregar la petición.
pub(crate) struct Mcp {
    sessions: Mutex<HashMap<Uuid, Instant>>,
}

impl Mcp {
    pub(crate) fn new() -> Self {
        Self { sessions: Mutex::new(HashMap::new()) }
    }

    pub(crate) async fn handle(&self, req: Request<Incoming>, motor: Arc<Motor>) -> Response<Body> {
        let (parts, incoming) = req.into_parts();
        if parts.method != Method::POST && parts.method != Method::DELETE {
            // Este catálogo no inicia solicitudes al cliente ni necesita un stream SSE.
            let mut response = full(StatusCode::METHOD_NOT_ALLOWED, json!({"error": "METHOD_NOT_ALLOWED"}));
            response.headers_mut().insert(header::ALLOW, HeaderValue::from_static("POST, DELETE"));
            return response;
        }

        let session = match parts.headers.get(SESSION_HEADER) {
            Some(value) => {
                let id = value.to_str().ok().and_then(|value| Uuid::parse_str(value).ok());
                let Some(id) = id else { return missing_session() };
                let mut sessions = self.sessions.lock().await;
                sessions.retain(|_, seen| seen.elapsed() < SESSION_IDLE);
                let Some(seen) = sessions.get_mut(&id) else { return missing_session() };
                if parts.method == Method::DELETE {
                    sessions.remove(&id);
                    return full(StatusCode::OK, json!({"closed": true}));
                }
                *seen = Instant::now();
                Some(id)
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
            Some(id) => with_session(dispatch(&message, &motor).await, id),
            None if message.get("method").and_then(Value::as_str) == Some("initialize") => {
                self.initialize(&message).await
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

    async fn initialize(&self, message: &Value) -> Response<Body> {
        let id = request_id(message).unwrap_or(Value::Null);
        if message.get("jsonrpc").and_then(Value::as_str) != Some("2.0") || id.is_null() {
            return full(StatusCode::BAD_REQUEST, rpc_error(id, -32600, "Mensaje JSON-RPC no válido."));
        }
        let empty = json!({});
        let params = message.get("params").unwrap_or(&empty);
        if !params.is_object() {
            return full(StatusCode::BAD_REQUEST, rpc_error(id, -32602, "params debe ser un objeto."));
        }
        let protocol = params.get("protocolVersion").and_then(Value::as_str)
            .filter(|version| PROTOCOLS.contains(version)).unwrap_or(PROTOCOLS[0]);
        let session = Uuid::new_v4();
        let mut sessions = self.sessions.lock().await;
        sessions.retain(|_, seen| seen.elapsed() < SESSION_IDLE);
        sessions.insert(session, Instant::now());
        drop(sessions);
        let result = json!({
            "protocolVersion": protocol,
            "capabilities": { "tools": { "listChanged": false } },
            "serverInfo": { "name": "Mind", "version": "1.0.5" },
            "instructions": "Consulta las autorizaciones con estado. Busca conversaciones por texto y usa retomar con el ID o la consulta. Lee archivos de texto antes de modificar una versión. Para actualizar una conversación, usa su ID y revisión vigentes.",
        });
        with_session(full(StatusCode::OK, rpc_result(id, result)), session)
    }
}

async fn dispatch(message: &Value, motor: &Arc<Motor>) -> Response<Body> {
    let Some(messages) = message.as_array() else {
        return match dispatch_one(message, motor).await {
            Some(reply) => full(StatusCode::OK, reply),
            None => accepted(),
        };
    };
    if messages.is_empty() {
        return full(StatusCode::BAD_REQUEST, rpc_error(Value::Null, -32600, "Lote JSON-RPC vacío."));
    }
    let mut replies = Vec::new();
    for message in messages {
        if let Some(reply) = dispatch_one(message, motor).await {
            replies.push(reply);
        }
    }
    if replies.is_empty() { accepted() } else { full(StatusCode::OK, json!(replies)) }
}

async fn dispatch_one(message: &Value, motor: &Arc<Motor>) -> Option<Value> {
    let id = request_id(message);
    if message.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
        return Some(rpc_error(id.unwrap_or(Value::Null), -32600, "Mensaje JSON-RPC no válido."));
    }
    let Some(method) = message.get("method").and_then(Value::as_str) else {
        return Some(rpc_error(id.unwrap_or(Value::Null), -32600, "Mensaje JSON-RPC no válido."));
    };
    // notifications/initialized confirma el inicio de un catálogo fijo.
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
            let args = params.get("arguments").unwrap_or(&empty);
            if !args.is_object() {
                return Some(rpc_error(id, -32602, "arguments debe ser un objeto."));
            }
            let motor = Arc::clone(motor);
            let (name, args) = (name.to_owned(), args.clone());
            match tokio::task::spawn_blocking(move || motor.call(&name, args)).await {
                Ok(Ok(value)) => tool_result(value, false),
                Ok(Err(error)) => tool_result(json!({"error": {"codigo": error.code, "mensaje": error.message}}), true),
                Err(_) => tool_result(json!({"error": {"codigo": "ERROR_INTERNO", "mensaje": "Mind no pudo completar la operación."}}), true),
            }
        }
        _ => return Some(rpc_error(id, -32601, "Método no admitido.")),
    };
    Some(rpc_result(id, result))
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

fn tool_result(value: Value, is_error: bool) -> Value {
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
            "title": "Buscar conversaciones",
            "description": "Busca conversaciones por palabras y permite filtrar por proyecto.",
            "inputSchema": {"type": "object", "properties": {
                "en": {"type": "string", "enum": ["conversaciones"]},
                "consulta": {"type": "string"}, "proyecto": {"type": "string"},
                "limite": {"type": "integer", "minimum": 1, "maximum": 100},
            }, "required": ["en"], "additionalProperties": false},
            "annotations": {"readOnlyHint": true, "openWorldHint": false},
        },
        {
            "name": "leer",
            "title": "Leer un archivo de texto",
            "description": "Lee texto UTF-8 y devuelve su versión. desde_linea y lineas permiten acotar la lectura.",
            "inputSchema": {"type": "object", "properties": {
                "carpeta": {"type": "string", "description": "ID o ruta absoluta de la carpeta registrada."},
                "ruta": {"type": "string", "description": "Ruta relativa dentro de la carpeta."},
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
            "title": "Modificar un archivo de texto",
            "description": "Sustituye el contenido UTF-8 completo cuando coincide la versión obtenida al leer.",
            "inputSchema": {"type": "object", "properties": {
                "carpeta": {"type": "string", "description": "ID o ruta absoluta de la carpeta registrada."},
                "ruta": {"type": "string", "description": "Ruta relativa dentro de la carpeta."},
                "version": {"type": "string", "pattern": "^sha256:[0-9a-f]{64}$"},
                "contenido": {"type": "string"},
            }, "required": ["ruta", "version", "contenido"], "additionalProperties": false},
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
        }
    ])
}
