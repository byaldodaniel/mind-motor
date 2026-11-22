use std::{
    collections::{BTreeMap, HashMap},
    sync::Arc,
    time::{Duration, Instant},
};

use base64::{engine::general_purpose::STANDARD, Engine};
use bytes::Bytes;
use http_body_util::{BodyExt, Full, Limited, StreamBody};
use hyper::{body::{Body as _, Frame, Incoming}, header, Method, Request, Response, StatusCode};
use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use tokio::sync::{Mutex, MutexGuard, Semaphore};
use uuid::Uuid;

use crate::{host::{full, Body}, MAX_MESSAGE};

pub(crate) const MAX_VIEW_BYTES: usize = 8 * 1024 * 1024;
pub(crate) const MAX_VIEW_FILES: usize = 256;
pub(crate) const MAX_ASSET_PATH: usize = 4096;
const MAX_VIEWS: usize = 8;
const MAX_TOTAL_BYTES: usize = 4 * MAX_VIEW_BYTES;
const DEFAULT_IDLE_MS: u64 = 1_800_000;
const MIN_IDLE_MS: u64 = 1_000;
const ACTIVITY_PATH: &str = "_mind/actividad";
const HTML_MIME: &str = "text/html; charset=utf-8";
const VIEW_POLICY: &str = "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; media-src 'self'; connect-src 'self'; object-src 'none'; worker-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

#[derive(Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Git {
    pub(crate) rama: Option<String>,
    pub(crate) revision: Option<String>,
    pub(crate) cambios: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Publication {
    pub(crate) proyecto: String,
    pub(crate) copia: String,
    pub(crate) git: Option<Git>,
    pub(crate) archivos: Vec<AssetInput>,
    pub(crate) mantener_abierta: Option<bool>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct AssetInput {
    pub(crate) ruta: String,
    pub(crate) base64: String,
}

struct Snapshot {
    project: String,
    copy: String,
    git: Option<Git>,
    assets: BTreeMap<String, Bytes>,
    fingerprint: String,
    size: usize,
}

struct View {
    snapshot: Snapshot,
    version: u64,
    last_activity: Instant,
    mantener_abierta: bool,
}

pub(crate) struct Views {
    authority: String,
    origin: String,
    idle: Duration,
    records: Mutex<HashMap<Uuid, View>>,
    publishing: Semaphore,
}

fn error(status: StatusCode, code: &'static str) -> Response<Body> {
    full(status, json!({"error": code}))
}

fn method_not_allowed(allow: &'static str) -> Response<Body> {
    let mut response = error(StatusCode::METHOD_NOT_ALLOWED, "METHOD_NOT_ALLOWED");
    response.headers_mut().insert(header::ALLOW, header::HeaderValue::from_static(allow));
    response
}

fn uuid(value: &str) -> Option<Uuid> {
    let id = Uuid::parse_str(value).ok()?;
    (id.hyphenated().to_string() == value).then_some(id)
}

fn valid_label(value: &str) -> bool {
    !value.trim().is_empty() && value.len() <= 512 && !value.chars().any(char::is_control)
}

fn valid_segment(segment: &str) -> bool {
    !segment.is_empty() && !segment.starts_with('.')
        && !segment.chars().any(|ch| ch.is_control() || matches!(ch, '\\' | '/' | ':'))
}

fn decode_segment(segment: &str) -> Option<String> {
    let mut decoded = Vec::with_capacity(segment.len());
    let mut bytes = segment.bytes();
    while let Some(byte) = bytes.next() {
        if byte != b'%' {
            decoded.push(byte);
            continue;
        }
        let high = char::from(bytes.next()?).to_digit(16)?;
        let low = char::from(bytes.next()?).to_digit(16)?;
        decoded.push((high * 16 + low) as u8);
    }
    let decoded = String::from_utf8(decoded).ok()?;
    valid_segment(&decoded).then_some(decoded)
}

fn request_asset(relative: &str) -> Option<String> {
    // Allow UTF-8 encoded as three URL bytes per byte of the decoded filename.
    if relative.len() > 3 * MAX_ASSET_PATH {
        return None;
    }
    let asset = if relative.is_empty() || relative.ends_with('/') {
        format!("{relative}index.html")
    } else {
        relative.to_owned()
    };
    let decoded = asset.split('/').map(decode_segment).collect::<Option<Vec<_>>>()?.join("/");
    (decoded.len() <= MAX_ASSET_PATH).then_some(decoded)
}

type PublicationError = (StatusCode, &'static str);

impl Snapshot {
    fn parse(input: Publication) -> Result<Self, PublicationError> {
        let invalid = (StatusCode::BAD_REQUEST, "INVALID_VIEW");
        let too_large = (StatusCode::PAYLOAD_TOO_LARGE, "VIEW_TOO_LARGE");
        if !valid_label(&input.proyecto) || !valid_label(&input.copia)
            || input.git.as_ref().is_some_and(|git| {
                [&git.rama, &git.revision].into_iter().flatten().any(|value| !valid_label(value))
            })
        {
            return Err(invalid);
        }
        if input.archivos.len() > MAX_VIEW_FILES {
            return Err(too_large);
        }
        let mut assets = BTreeMap::new();
        let mut size = 0;
        for file in input.archivos {
            if file.ruta.len() > MAX_ASSET_PATH || !file.ruta.split('/').all(valid_segment)
                || assets.contains_key(&file.ruta)
            {
                return Err(invalid);
            }
            let remaining = MAX_VIEW_BYTES - size;
            if file.base64.len() > remaining.div_ceil(3) * 4 {
                return Err(too_large);
            }
            let bytes = STANDARD.decode(file.base64).map_err(|_| invalid)?;
            if bytes.len() > remaining {
                return Err(too_large);
            }
            size += bytes.len();
            assets.insert(file.ruta, Bytes::from(bytes));
        }
        if !assets.contains_key("index.html") {
            return Err(invalid);
        }
        // Lengths retain file boundaries; BTreeMap fixes ordering independent of input.
        let mut digest = Sha256::new();
        for (name, bytes) in &assets {
            digest.update((name.len() as u64).to_be_bytes());
            digest.update(name.as_bytes());
            digest.update((bytes.len() as u64).to_be_bytes());
            digest.update(bytes);
        }
        Ok(Self {
            project: input.proyecto,
            copy: input.copia,
            git: input.git,
            assets,
            fingerprint: format!("{:x}", digest.finalize()),
            size,
        })
    }
}

impl Views {
    pub(crate) fn new(port: u16) -> Arc<Self> {
        let authority = format!("127.0.0.1:{port}");
        let idle_ms = std::env::var("MIND_VISTA_INACTIVA_MS").ok()
            .and_then(|value| value.parse::<u64>().ok())
            .filter(|&value| value >= MIN_IDLE_MS)
            .unwrap_or(DEFAULT_IDLE_MS);
        let idle = Duration::from_millis(idle_ms);
        let views = Arc::new(Self {
            origin: format!("http://{authority}"),
            authority,
            idle,
            records: Mutex::new(HashMap::new()),
            publishing: Semaphore::new(2),
        });
        let records = Arc::downgrade(&views);
        let interval = (idle / 4).min(Duration::from_secs(30));
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(interval).await;
                let Some(views) = records.upgrade() else { break };
                drop(views.live_records().await);
            }
        });
        views
    }

    async fn live_records(&self) -> MutexGuard<'_, HashMap<Uuid, View>> {
        let mut records = self.records.lock().await;
        let now = Instant::now();
        records.retain(|_, view| view.mantener_abierta || now.duration_since(view.last_activity) < self.idle);
        records
    }

    pub(crate) async fn usage(&self) -> serde_json::Value {
        let records = self.records.lock().await;
        let bytes: usize = records.values().map(|view| view.snapshot.size).sum();
        json!({"activas": records.len(), "bytes": bytes})
    }

    fn metadata_value(&self, id: Uuid, view: &View) -> serde_json::Value {
        json!({
            "id": id.to_string(),
            "url": format!("{}/vista/{id}/", self.origin),
            "proyecto": view.snapshot.project,
            "copia": view.snapshot.copy,
            "git": view.snapshot.git,
            "huella": view.snapshot.fingerprint,
            "version": view.version,
            "mantener_abierta": view.mantener_abierta,
            "inactividad_ms": self.idle.as_millis() as u64,
        })
    }

    fn metadata(&self, status: StatusCode, version: u64, payload: serde_json::Value) -> Response<Body> {
        let mut response = full(status, payload);
        response.headers_mut().insert(
            header::ETAG,
            header::HeaderValue::from_str(&format!("\"{version}\"")).unwrap(),
        );
        response.headers_mut().insert(header::CACHE_CONTROL, header::HeaderValue::from_static("no-store"));
        response
    }

    pub(crate) async fn access_info(
        &self, id: Uuid, keep_open: Option<bool>,
    ) -> Result<(u64, serde_json::Value), PublicationError> {
        let mut records = self.live_records().await;
        let view = records.get_mut(&id).ok_or((StatusCode::NOT_FOUND, "VIEW_NOT_FOUND"))?;
        view.last_activity = Instant::now();
        if let Some(keep_open) = keep_open {
            view.mantener_abierta = keep_open;
        }
        Ok((view.version, self.metadata_value(id, view)))
    }

    pub(crate) async fn remove_view(&self, id: Uuid) -> bool {
        self.live_records().await.remove(&id).is_some()
    }

    pub(crate) async fn publish_input(
        &self, input: Publication, previous: Option<(Uuid, u64)>,
    ) -> Result<(StatusCode, Uuid, u64, serde_json::Value), PublicationError> {
        let Ok(_slot) = self.publishing.try_acquire() else {
            return Err((StatusCode::TOO_MANY_REQUESTS, "VIEW_PUBLISH_BUSY"));
        };
        let requested_keep_open = input.mantener_abierta;
        let snapshot = Snapshot::parse(input)?;
        let mut records = self.live_records().await;
        let (status, id, base_version, old_size, keep_open) = match previous {
            Some((id, expected)) => {
                let Some(current) = records.get(&id) else {
                    return Err((StatusCode::NOT_FOUND, "VIEW_NOT_FOUND"));
                };
                if current.version != expected {
                    return Err((StatusCode::PRECONDITION_FAILED, "VIEW_VERSION_CHANGED"));
                }
                if current.snapshot.project != snapshot.project || current.snapshot.copy != snapshot.copy {
                    return Err((StatusCode::CONFLICT, "VIEW_COPY_CHANGED"));
                }
                (StatusCode::OK, id, current.version, current.snapshot.size, current.mantener_abierta)
            }
            None => {
                if records.len() == MAX_VIEWS {
                    return Err((StatusCode::SERVICE_UNAVAILABLE, "VIEW_CAPACITY_REACHED"));
                }
                let mut id = Uuid::new_v4();
                while records.contains_key(&id) {
                    id = Uuid::new_v4();
                }
                (StatusCode::CREATED, id, 0, 0, false)
            }
        };
        let total: usize = records.values().map(|view| view.snapshot.size).sum();
        if total - old_size + snapshot.size > MAX_TOTAL_BYTES {
            return Err((StatusCode::SERVICE_UNAVAILABLE, "VIEW_CAPACITY_REACHED"));
        }
        let Some(version) = base_version.checked_add(1) else {
            return Err((StatusCode::CONFLICT, "VIEW_VERSION_EXHAUSTED"));
        };
        let view = View {
            snapshot, version, last_activity: Instant::now(),
            mantener_abierta: requested_keep_open.unwrap_or(keep_open),
        };
        let payload = self.metadata_value(id, &view);
        records.insert(id, view);
        Ok((status, id, version, payload))
    }

    // The private listener authenticates every request before passing it here.
    pub(crate) async fn control(&self, req: Request<Incoming>) -> Response<Body> {
        let path = req.uri().path();
        if path == "/vistas" {
            return if req.method() == Method::POST {
                self.publish(req, None).await
            } else {
                method_not_allowed("POST")
            };
        }
        let Some(id) = path.strip_prefix("/vistas/").and_then(uuid) else {
            return error(StatusCode::NOT_FOUND, "VIEW_NOT_FOUND");
        };
        match *req.method() {
            Method::GET => match self.access_info(id, None).await {
                Ok((version, payload)) => self.metadata(StatusCode::OK, version, payload),
                Err((status, code)) => error(status, code),
            },
            Method::PUT => {
                let Some(tag) = req.headers().get(header::IF_MATCH) else {
                    return error(StatusCode::PRECONDITION_REQUIRED, "VIEW_VERSION_REQUIRED");
                };
                let version = tag.to_str().ok()
                    .and_then(|value| value.strip_prefix('"')?.strip_suffix('"')?.parse::<u64>().ok());
                let Some(version) = version.filter(|v| *v > 0) else {
                    return error(StatusCode::BAD_REQUEST, "INVALID_VIEW_VERSION");
                };
                if req.headers().get_all(header::IF_MATCH).iter().count() != 1 {
                    return error(StatusCode::BAD_REQUEST, "INVALID_VIEW_VERSION");
                }
                self.publish(req, Some((id, version))).await
            }
            Method::DELETE => {
                if self.remove_view(id).await {
                    Response::builder().status(StatusCode::NO_CONTENT).body(body(Bytes::new())).unwrap()
                } else {
                    error(StatusCode::NOT_FOUND, "VIEW_NOT_FOUND")
                }
            }
            _ => method_not_allowed("GET, PUT, DELETE"),
        }
    }

    async fn publish(&self, req: Request<Incoming>, previous: Option<(Uuid, u64)>) -> Response<Body> {
        let Ok(body) = Limited::new(req.into_body(), MAX_MESSAGE).collect().await else {
            return error(StatusCode::PAYLOAD_TOO_LARGE, "VIEW_TOO_LARGE");
        };
        let Ok(input) = serde_json::from_slice(&body.to_bytes()) else {
            return error(StatusCode::BAD_REQUEST, "INVALID_VIEW");
        };
        match self.publish_input(input, previous).await {
            Ok((status, _, version, payload)) => self.metadata(status, version, payload),
            Err((status, code)) => error(status, code),
        }
    }

    pub(crate) async fn serve(&self, req: Request<Incoming>) -> Response<Body> {
        let mut hosts = req.headers().get_all(header::HOST).iter();
        let mut origins = req.headers().get_all(header::ORIGIN).iter();
        let host_ok = hosts.next().is_some_and(|value| value.as_bytes() == self.authority.as_bytes())
            && hosts.next().is_none();
        let origin = origins.next();
        let origin_ok = origin.is_none_or(|value| value.as_bytes() == self.origin.as_bytes())
            && origins.next().is_none();
        if !host_ok || !origin_ok {
            return error(StatusCode::FORBIDDEN, "ORIGIN_NOT_ALLOWED");
        }
        let route = req.uri().path().strip_prefix("/vista/")
            .and_then(|path| path.split_once('/'))
            .and_then(|(id, relative)| Some((uuid(id)?, relative)));
        if let Some((id, ACTIVITY_PATH)) = route {
            if req.method() != Method::POST {
                return method_not_allowed("POST");
            }
            if origin.is_none() {
                return error(StatusCode::FORBIDDEN, "ORIGIN_NOT_ALLOWED");
            }
            if req.body().size_hint().exact() != Some(0) {
                return error(StatusCode::PAYLOAD_TOO_LARGE, "ACTIVITY_BODY_NOT_ALLOWED");
            }
            let mut records = self.live_records().await;
            let Some(view) = records.get_mut(&id) else {
                return error(StatusCode::NOT_FOUND, "VIEW_NOT_FOUND");
            };
            view.last_activity = Instant::now();
            return Response::builder().status(StatusCode::NO_CONTENT)
                .header(header::CACHE_CONTROL, "no-store")
                .body(body(Bytes::new())).unwrap();
        }
        let is_head = req.method() == Method::HEAD;
        if !is_head && req.method() != Method::GET {
            return method_not_allowed("GET, HEAD");
        }
        let Some((id, relative)) = route else {
            return error(StatusCode::NOT_FOUND, "VIEW_NOT_FOUND");
        };
        let asset = request_asset(relative);
        let bytes = {
            let mut records = self.live_records().await;
            records.get_mut(&id).and_then(|view| {
                view.last_activity = Instant::now();
                view.snapshot.assets.get(asset.as_deref()?).cloned()
            })
        };
        let (Some(asset), Some(bytes)) = (asset, bytes) else {
            return error(StatusCode::NOT_FOUND, "VIEW_NOT_FOUND");
        };
        let content_type = mime(&asset);
        let script = (content_type == HTML_MIME).then(|| self.activity_script(id));
        let length = bytes.len() + script.as_ref().map_or(0, String::len);
        let response_body = match (is_head, script) {
            (true, _) => body(Bytes::new()),
            (false, Some(script)) => {
                let frames = [Ok(Frame::data(bytes)), Ok(Frame::data(Bytes::from(script)))];
                StreamBody::new(futures_util::stream::iter(frames)).boxed()
            }
            (false, None) => body(bytes),
        };
        Response::builder()
            .header(header::CONTENT_TYPE, content_type)
            .header(header::CONTENT_LENGTH, length)
            .header(header::CACHE_CONTROL, "no-store")
            .header(header::CONTENT_SECURITY_POLICY, VIEW_POLICY)
            .header(header::REFERRER_POLICY, "no-referrer")
            .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
            .header("cross-origin-resource-policy", "same-origin")
            .body(response_body)
            .unwrap()
    }

    fn activity_script(&self, id: Uuid) -> String {
        let interval_ms = (self.idle.as_millis() / 4).min(120_000);
        format!(r#"
<script data-mind-actividad>
(() => {{
    const ping = () => {{
        if (document.visibilityState !== 'visible') return;
        fetch('/vista/{id}/{ACTIVITY_PATH}', {{ method: 'POST', credentials: 'omit' }}).catch(() => {{}});
    }};
    setInterval(ping, {interval_ms});
    document.addEventListener('visibilitychange', ping);
    window.addEventListener('pageshow', ping);
}})();
</script>
"#)
    }
}

fn body(bytes: Bytes) -> Body {
    Full::new(bytes).map_err(|never| match never {}).boxed()
}

fn mime(name: &str) -> &'static str {
    let extension = name.rsplit_once('.').map_or("", |(_, extension)| extension);
    match extension.to_ascii_lowercase().as_str() {
        "html" | "htm" => HTML_MIME,
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "json" | "map" => "application/json",
        "geojson" => "application/geo+json",
        "txt" => "text/plain; charset=utf-8",
        "csv" => "text/csv; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "gif" => "image/gif",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "wasm" => "application/wasm",
        "pdf" => "application/pdf",
        "mp3" => "audio/mpeg",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "glb" => "model/gltf-binary",
        "gltf" => "model/gltf+json",
        _ => "application/octet-stream",
    }
}
