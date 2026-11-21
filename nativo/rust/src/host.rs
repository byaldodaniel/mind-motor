// Anfitrión nativo de Mind 1.0.5 (Etapa 2): una sola puerta HTTP para todos
// los agentes. Escucha en loopback, valida Host/Origin y el token, verifica al
// Motor r3 con la prueba HMAC de /health y le reenvía /mcp y /rpc sin tocar su
// contenido (incluidas las respuestas SSE). Mientras dure el relevo, r3 sigue
// siendo el único escritor de la Base; el anfitrión no la escribe salvo su
// propio registro `anfitrion.json`. Las vistas optativas tienen otro puerto.
use std::{convert::Infallible, net::SocketAddr, path::PathBuf, sync::Arc, time::Duration};
use bytes::Bytes;
use futures_util::TryStreamExt;
use hmac::{Hmac, Mac};
use http_body_util::{combinators::BoxBody, BodyExt, Full, Limited, StreamBody};
use hyper::{body::{Frame, Incoming}, header, Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use serde_json::{json, Value};
use sha2::Sha256;
use tokio::{net::TcpListener, sync::Mutex};
use uuid::Uuid;
use crate::{bridge::{base_id, regular_json}, continuity_read, services::Services, views::Views, MAX_MESSAGE};

pub(crate) type Body = BoxBody<Bytes, std::io::Error>;

#[derive(Clone)]
struct Motor { port: u16, token: String }

struct Host {
    base: PathBuf,
    base_id: String,
    port: u16,
    client: reqwest::Client,
    motor: Mutex<Option<Motor>>,
    started: String,
    continuity_reader: Option<continuity_read::Reader>,
    views: Option<Arc<Views>>,
    services: Option<Arc<Services>>,
}

pub(crate) fn full(status: StatusCode, value: Value) -> Response<Body> {
    let bytes = Bytes::from(serde_json::to_vec(&value).unwrap_or_default());
    Response::builder().status(status).header(header::CONTENT_TYPE, "application/json")
        .body(Full::new(bytes).map_err(|never: Infallible| match never {}).boxed()).unwrap()
}

/// Igualdad en tiempo constante para el token.
pub(crate) fn same(a: &[u8], b: &[u8]) -> bool { a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0 }

/// Un navegador en el puerto de vistas nunca comparte origen con la API privada.
fn allowed_origin(req: &Request<Incoming>, port: u16) -> bool {
    fn loopback_authority(authority: &str, port: u16) -> bool {
        ["127.0.0.1", "localhost", "[::1]"].iter().any(|host| authority == format!("{host}:{port}"))
    }
    let host_ok = req.headers().get(header::HOST).and_then(|v| v.to_str().ok())
        .is_some_and(|host| loopback_authority(host, port));
    let origin_ok = req.headers().get(header::ORIGIN).is_none_or(|value| {
        value.to_str().ok().and_then(|origin| origin.strip_prefix("http://"))
            .is_some_and(|authority| loopback_authority(authority, port))
    });
    host_ok && origin_ok
}

impl Host {
    /// Motor auténtico de esta Base: conector y secreto regulares, baseId propio y prueba HMAC de /health.
    async fn verify(&self) -> Option<Motor> {
        let state = regular_json(&self.base.join("conector.json"))?;
        let secret = regular_json(&self.base.join("conector-secreto.json"))?;
        if state.get("version")?.as_u64() != Some(1) || secret.get("version")?.as_u64() != Some(1) { return None }
        let port = u16::try_from(state.get("port")?.as_u64()?).ok()?;
        if port == 0 || port == self.port { return None }
        let expected = &self.base_id;
        if state.get("baseId")?.as_str()? != expected { return None }
        let token = secret.get("token")?.as_str()?;
        if token.len() < 32 { return None }
        let nonce = Uuid::new_v4().simple().to_string();
        let response = self.client.get(format!("http://127.0.0.1:{port}/health?nonce={nonce}")).timeout(Duration::from_millis(800)).send().await.ok()?;
        if response.status() != 200 { return None }
        let bytes = response.bytes().await.ok()?;
        if bytes.len() > 65536 { return None }
        let health: Value = serde_json::from_slice(&bytes).ok()?;
        if health.get("ok")?.as_bool() != Some(true) || health.get("port")?.as_u64() != Some(port as u64) || health.get("baseId")?.as_str()? != expected { return None }
        let proof = health.get("proof")?.as_str()?;
        if proof.len() != 64 || !proof.bytes().all(|b| b.is_ascii_hexdigit()) { return None }
        let proof: Vec<u8> = (0..64).step_by(2).map(|i| u8::from_str_radix(&proof[i..i + 2], 16).ok()).collect::<Option<_>>()?;
        let mut mac = Hmac::<Sha256>::new_from_slice(token.as_bytes()).ok()?;
        mac.update(format!("mind-health-v1\n{nonce}\n{expected}\n{port}").as_bytes());
        mac.verify_slice(&proof).ok()?;
        Some(Motor { port, token: token.to_owned() })
    }

    async fn motor(&self, refresh: bool) -> Option<Motor> {
        let mut cached = self.motor.lock().await;
        if refresh || cached.is_none() { *cached = self.verify().await; }
        cached.clone()
    }

    async fn handle(self: Arc<Self>, req: Request<Incoming>) -> Result<Response<Body>, Infallible> {
        if !allowed_origin(&req, self.port) { return Ok(full(StatusCode::FORBIDDEN, json!({"error": "ORIGIN_NOT_ALLOWED"}))) }
        let path = req.uri().path().to_owned();
        if path == "/health" && req.method() == Method::GET {
            return Ok(self.health(req.uri().query()).await);
        }
        if let Some(id) = path.strip_prefix(continuity_read::PATH_PREFIX) {
            let response = match &self.continuity_reader {
                Some(reader) if req.method() == Method::GET => reader.serve(req.headers(), id).await,
                _ => full(StatusCode::NOT_FOUND, json!({"error": "NOT_FOUND"})),
            };
            return Ok(response);
        }
        if path == "/servicios" || path.starts_with("/servicios/") {
            return Ok(match &self.services {
                Some(services) => services.control(req).await,
                None => full(StatusCode::NOT_FOUND, json!({"error": "NOT_FOUND"})),
            });
        }
        let control = self.views.as_ref().filter(|_| path == "/vistas" || path.starts_with("/vistas/"));
        if path != "/mcp" && path != "/rpc" && control.is_none() {
            return Ok(full(StatusCode::NOT_FOUND, json!({"error": "NOT_FOUND"})));
        }
        let motor = if control.is_some() {
            self.motor(true).await
        } else {
            self.motor(false).await.or(self.motor(true).await)
        };
        let Some(motor) = motor else {
            return Ok(full(StatusCode::SERVICE_UNAVAILABLE, json!({"error": "MOTOR_UNAVAILABLE"})));
        };
        let authorized = req.headers().get(header::AUTHORIZATION).and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer ")).is_some_and(|t| same(t.as_bytes(), motor.token.as_bytes()));
        if !authorized {
            return Ok(Response::builder().status(StatusCode::UNAUTHORIZED).header(header::WWW_AUTHENTICATE, "Bearer")
                .body(Full::new(Bytes::from_static(b"{\"error\":\"UNAUTHORIZED\"}")).map_err(|never: Infallible| match never {}).boxed()).unwrap());
        }
        if let Some(views) = control {
            return Ok(views.control(req).await);
        }
        Ok(self.forward(req, motor).await)
    }

    async fn health(&self, query: Option<&str>) -> Response<Body> {
        let motor = self.motor(true).await;
        let mut state = json!({
            "ok": true, "anfitrion": true, "pid": std::process::id(), "port": self.port,
            "startedAt": self.started, "baseId": self.base_id,
            "motor": motor.as_ref().map(|m| json!({"port": m.port, "verificado": true})),
        });
        let nonce = query.and_then(|query| query.strip_prefix("nonce=")).filter(|nonce| {
            (16..=128).contains(&nonce.len()) && nonce.bytes().all(|byte| byte.is_ascii_hexdigit())
        });
        if let (Some(nonce), Some(motor)) = (nonce, motor) {
            let mut mac = Hmac::<Sha256>::new_from_slice(motor.token.as_bytes()).expect("HMAC accepts any key length");
            mac.update(format!("mind-host-health-v1\n{nonce}\n{}\n{}", self.base_id, self.port).as_bytes());
            state["proof"] = json!(format!("{:x}", mac.finalize().into_bytes()));
        }
        if let Some(views) = &self.views {
            state["vistas"] = views.usage().await;
        }
        full(StatusCode::OK, state)
    }

    /// Reenvía la petición al Motor tal cual (salvo cabeceras de transporte) y
    /// devuelve su respuesta en flujo, sin acumularla: así funcionan las SSE.
    async fn forward(&self, req: Request<Incoming>, motor: Motor) -> Response<Body> {
        let (parts, incoming) = req.into_parts();
        let body = match Limited::new(incoming, MAX_MESSAGE).collect().await {
            Ok(collected) => collected.to_bytes(),
            Err(_) => return full(StatusCode::PAYLOAD_TOO_LARGE, json!({"error": "MESSAGE_TOO_LARGE"})),
        };
        let target = format!("http://127.0.0.1:{}{}", motor.port, parts.uri.path_and_query().map(|p| p.as_str()).unwrap_or("/"));
        let method = reqwest::Method::from_bytes(parts.method.as_str().as_bytes()).unwrap_or(reqwest::Method::GET);
        let mut out = self.client.request(method, target);
        for (name, value) in parts.headers.iter() {
            if matches!(name.as_str(), "host" | "connection" | "content-length" | "transfer-encoding" | "keep-alive" | "upgrade" | "origin") { continue }
            if let Ok(value) = reqwest::header::HeaderValue::from_bytes(value.as_bytes()) { out = out.header(name.as_str(), value); }
        }
        let response = match out.body(body).send().await {
            Ok(r) => r,
            Err(_) => {
                // El Motor pudo reiniciarse con otro puerto: se vuelve a verificar en la próxima petición.
                *self.motor.lock().await = None;
                return full(StatusCode::BAD_GATEWAY, json!({"error": "MOTOR_CONNECTION_LOST"}));
            }
        };
        let mut builder = Response::builder().status(response.status().as_u16());
        for (name, value) in response.headers().iter() {
            if matches!(name.as_str(), "connection" | "content-length" | "transfer-encoding" | "keep-alive") { continue }
            builder = builder.header(name.as_str(), value.as_bytes());
        }
        let stream = response.bytes_stream().map_ok(Frame::data).map_err(std::io::Error::other);
        builder.body(BodyExt::boxed(StreamBody::new(stream))).unwrap()
    }
}

fn argument(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned()
}

pub async fn run(args: &[String]) -> Result<(), String> {
    let base = PathBuf::from(argument(args, "--base").ok_or("anfitrion --base ABS [--port N] [--puerto-vistas N]")?);
    if !base.is_absolute() { return Err("--base debe ser absoluta".into()) }
    let wanted: u16 = argument(args, "--port").map(|p| p.parse().map_err(|_| "--port inválido")).transpose()?.unwrap_or(0);
    let listener = TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], wanted))).await.map_err(|e| format!("No se pudo escuchar: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let base_identity = base_id(&base).ok_or("No se pudo identificar la Base")?;
    let preview = if args.iter().any(|arg| arg == "--puerto-vistas") {
        let wanted: u16 = argument(args, "--puerto-vistas")
            .and_then(|value| value.parse().ok()).ok_or("--puerto-vistas inválido")?;
        let listener = TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], wanted)))
            .await.map_err(|error| format!("No se pudo abrir el puerto de vistas: {error}"))?;
        let port = listener.local_addr().map_err(|error| error.to_string())?.port();
        Some((listener, port))
    } else {
        None
    };
    let started = format!("{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0));
    let client = reqwest::Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none())
        .build().map_err(|e| e.to_string())?;
    let views = preview.as_ref().map(|(_, port)| Arc::new(Views::new(*port)));
    let services = if args.iter().any(|arg| arg == "--servicios-prueba") {
        let (_, public_port) = preview.as_ref().ok_or("--servicios-prueba requiere --puerto-vistas")?;
        Some(Arc::new(Services::new(&base, port, *public_port, client.clone())?))
    } else {
        None
    };
    let mut record = json!({
        "version": 1, "port": port, "pid": std::process::id(), "baseId": base_identity,
        "url": format!("http://127.0.0.1:{port}/mcp"),
    });
    if let Some((_, port)) = &preview {
        record["puertoVistas"] = json!(port);
    }
    let continuity_reader = continuity_read::Reader::from_env(&base, &base_identity)?;
    let host = Arc::new(Host {
        base: base.clone(), base_id: base_identity, port, client, motor: Mutex::new(None), started, continuity_reader, views: views.clone(), services: services.clone(),
    });
    let path = base.join("anfitrion.json");
    let temporary = base.join(format!(".anfitrion-{}.tmp", Uuid::new_v4().simple()));
    std::fs::write(&temporary, serde_json::to_vec(&record).unwrap_or_default()).and_then(|_| std::fs::rename(&temporary, &path)).map_err(|e| format!("No se pudo registrar el anfitrión: {e}"))?;
    println!("{record}");
    if let (Some((listener, _)), Some(views)) = (preview, views) {
        tokio::spawn(serve_views(listener, views, services));
    }
    let shutdown = shutdown_signal();
    tokio::pin!(shutdown);
    loop {
        let accepted = tokio::select! {
            accepted = listener.accept() => accepted,
            signal = &mut shutdown, if host.services.is_some() => {
                signal.map_err(|error| error.to_string())?;
                return host.services.as_ref().expect("services enabled").shutdown().await;
            }
        };
        let (stream, _) = match accepted { Ok(stream) => stream, Err(_) => continue };
        let host = host.clone();
        tokio::spawn(async move {
            let service = hyper::service::service_fn(move |req| host.clone().handle(req));
            let _ = hyper::server::conn::http1::Builder::new().serve_connection(TokioIo::new(stream), service).await;
        });
    }
}

#[cfg(unix)]
async fn shutdown_signal() -> std::io::Result<()> {
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    tokio::select! {
        interrupt = tokio::signal::ctrl_c() => interrupt,
        _ = terminate.recv() => Ok(()),
    }
}

#[cfg(windows)]
async fn shutdown_signal() -> std::io::Result<()> {
    tokio::signal::ctrl_c().await
}

async fn serve_views(listener: TcpListener, views: Arc<Views>, services: Option<Arc<Services>>) {
    loop {
        let Ok((stream, _)) = listener.accept().await else { continue };
        let views = views.clone();
        let services = services.clone();
        tokio::spawn(async move {
            let service = hyper::service::service_fn(move |req| {
                let views = views.clone();
                let services = services.clone();
                async move {
                    if let Some(services) = services.filter(|_| req.uri().path().starts_with("/app/")) {
                        return Ok::<_, Infallible>(services.open_link(req).await);
                    }
                    Ok(views.serve(req).await)
                }
            });
            let _ = hyper::server::conn::http1::Builder::new()
                .serve_connection(TokioIo::new(stream), service).await;
        });
    }
}
