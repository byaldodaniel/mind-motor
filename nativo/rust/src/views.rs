use std::collections::{BTreeMap, HashMap};

use base64::{engine::general_purpose::STANDARD, Engine};
use bytes::Bytes;
use http_body_util::{BodyExt, Full, Limited};
use hyper::{body::Incoming, header, Method, Request, Response, StatusCode};
use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use tokio::sync::{Mutex, Semaphore};
use uuid::Uuid;

use crate::{host::{full, Body}, MAX_MESSAGE};

pub(crate) const MAX_VIEW_BYTES: usize = 8 * 1024 * 1024;
pub(crate) const MAX_VIEW_FILES: usize = 256;
pub(crate) const MAX_ASSET_PATH: usize = 4096;
const MAX_VIEWS: usize = 8;
const MAX_TOTAL_BYTES: usize = 4 * MAX_VIEW_BYTES;
const VIEW_POLICY: &str = "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; media-src 'self'; connect-src 'self'; object-src 'none'; worker-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

#[derive(Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
struct Git {
    rama: Option<String>,
    revision: Option<String>,
    cambios: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Publication {
    proyecto: String,
    copia: String,
    git: Option<Git>,
    archivos: Vec<AssetInput>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AssetInput {
    ruta: String,
    base64: String,
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
}

pub(crate) struct Views {
    authority: String,
    origin: String,
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
    pub(crate) fn new(port: u16) -> Self {
        let authority = format!("127.0.0.1:{port}");
        Self {
            origin: format!("http://{authority}"),
            authority,
            records: Mutex::new(HashMap::new()),
            publishing: Semaphore::new(2),
        }
    }

    pub(crate) async fn usage(&self) -> serde_json::Value {
        let records = self.records.lock().await;
        let bytes: usize = records.values().map(|view| view.snapshot.size).sum();
        json!({"activas": records.len(), "bytes": bytes})
    }

    fn metadata(&self, status: StatusCode, id: Uuid, view: &View) -> Response<Body> {
        let mut response = full(status, json!({
            "id": id.to_string(),
            "url": format!("{}/vista/{id}/", self.origin),
            "proyecto": view.snapshot.project,
            "copia": view.snapshot.copy,
            "git": view.snapshot.git,
            "huella": view.snapshot.fingerprint,
            "version": view.version,
        }));
        response.headers_mut().insert(
            header::ETAG,
            header::HeaderValue::from_str(&format!("\"{}\"", view.version)).unwrap(),
        );
        response.headers_mut().insert(header::CACHE_CONTROL, header::HeaderValue::from_static("no-store"));
        response
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
            Method::GET => match self.records.lock().await.get(&id) {
                Some(view) => self.metadata(StatusCode::OK, id, view),
                None => error(StatusCode::NOT_FOUND, "VIEW_NOT_FOUND"),
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
                if self.records.lock().await.remove(&id).is_some() {
                    Response::builder().status(StatusCode::NO_CONTENT).body(body(Bytes::new())).unwrap()
                } else {
                    error(StatusCode::NOT_FOUND, "VIEW_NOT_FOUND")
                }
            }
            _ => method_not_allowed("GET, PUT, DELETE"),
        }
    }

    async fn publish(&self, req: Request<Incoming>, previous: Option<(Uuid, u64)>) -> Response<Body> {
        let Ok(_slot) = self.publishing.try_acquire() else {
            return error(StatusCode::TOO_MANY_REQUESTS, "VIEW_PUBLISH_BUSY");
        };
        let Ok(body) = Limited::new(req.into_body(), MAX_MESSAGE).collect().await else {
            return error(StatusCode::PAYLOAD_TOO_LARGE, "VIEW_TOO_LARGE");
        };
        let Ok(input) = serde_json::from_slice(&body.to_bytes()) else {
            return error(StatusCode::BAD_REQUEST, "INVALID_VIEW");
        };
        let snapshot = match Snapshot::parse(input) {
            Ok(snapshot) => snapshot,
            Err((status, code)) => return error(status, code),
        };
        let mut records = self.records.lock().await;
        let (status, id, base_version, old_size) = match previous {
            Some((id, expected)) => {
                let Some(current) = records.get(&id) else {
                    return error(StatusCode::NOT_FOUND, "VIEW_NOT_FOUND");
                };
                if current.version != expected {
                    return error(StatusCode::PRECONDITION_FAILED, "VIEW_VERSION_CHANGED");
                }
                if current.snapshot.project != snapshot.project || current.snapshot.copy != snapshot.copy {
                    return error(StatusCode::CONFLICT, "VIEW_COPY_CHANGED");
                }
                (StatusCode::OK, id, current.version, current.snapshot.size)
            }
            None => {
                if records.len() == MAX_VIEWS {
                    return error(StatusCode::SERVICE_UNAVAILABLE, "VIEW_CAPACITY_REACHED");
                }
                let mut id = Uuid::new_v4();
                while records.contains_key(&id) {
                    id = Uuid::new_v4();
                }
                (StatusCode::CREATED, id, 0, 0)
            }
        };
        let total: usize = records.values().map(|view| view.snapshot.size).sum();
        if total - old_size + snapshot.size > MAX_TOTAL_BYTES {
            return error(StatusCode::SERVICE_UNAVAILABLE, "VIEW_CAPACITY_REACHED");
        }
        let Some(version) = base_version.checked_add(1) else {
            return error(StatusCode::CONFLICT, "VIEW_VERSION_EXHAUSTED");
        };
        let view = View { snapshot, version };
        let response = self.metadata(status, id, &view);
        records.insert(id, view);
        response
    }

    pub(crate) async fn serve(&self, req: Request<Incoming>) -> Response<Body> {
        let mut hosts = req.headers().get_all(header::HOST).iter();
        let mut origins = req.headers().get_all(header::ORIGIN).iter();
        let host_ok = hosts.next().is_some_and(|value| value.as_bytes() == self.authority.as_bytes())
            && hosts.next().is_none();
        let origin_ok = origins.next().is_none_or(|value| value.as_bytes() == self.origin.as_bytes())
            && origins.next().is_none();
        if !host_ok || !origin_ok {
            return error(StatusCode::FORBIDDEN, "ORIGIN_NOT_ALLOWED");
        }
        let is_head = req.method() == Method::HEAD;
        if !is_head && req.method() != Method::GET {
            return method_not_allowed("GET, HEAD");
        }
        let Some((id, asset)) = req.uri().path().strip_prefix("/vista/")
            .and_then(|path| path.split_once('/'))
            .and_then(|(id, asset)| Some((uuid(id)?, request_asset(asset)?))) else {
            return error(StatusCode::NOT_FOUND, "VIEW_NOT_FOUND");
        };
        let bytes = self.records.lock().await.get(&id)
            .and_then(|view| view.snapshot.assets.get(&asset)).cloned();
        let Some(bytes) = bytes else {
            return error(StatusCode::NOT_FOUND, "VIEW_NOT_FOUND");
        };
        Response::builder()
            .header(header::CONTENT_TYPE, mime(&asset))
            .header(header::CONTENT_LENGTH, bytes.len())
            .header(header::CACHE_CONTROL, "no-store")
            .header(header::CONTENT_SECURITY_POLICY, VIEW_POLICY)
            .header(header::REFERRER_POLICY, "no-referrer")
            .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
            .header("cross-origin-resource-policy", "same-origin")
            .body(body(if is_head { Bytes::new() } else { bytes }))
            .unwrap()
    }
}

fn body(bytes: Bytes) -> Body {
    Full::new(bytes).map_err(|never| match never {}).boxed()
}

fn mime(name: &str) -> &'static str {
    let extension = name.rsplit_once('.').map_or("", |(_, extension)| extension);
    match extension.to_ascii_lowercase().as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
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
