use std::{io::Read, path::Path};
use bytes::Bytes;
use hmac::{Hmac, Mac};
use http_body_util::{BodyExt, Full, Limited};
use hyper::{body::Incoming, header, HeaderMap, Request, Response, StatusCode};
use serde_json::json;
use sha2::{Digest, Sha256};
use uuid::Uuid;
use crate::{host::{full, same, Body}, pending_write::Writer, scan, text_write};

pub(crate) const PATH_PREFIX: &str = "/interno/continuidad/";
const MAX_RECORD: usize = 2 * 1024 * 1024;

pub(crate) struct Reader {
    base: String,
    base_id: String,
    key: String,
    writer: Option<Writer>,
}

impl Reader {
    pub(crate) fn from_env(base: &Path, base_id: &str) -> Result<Option<Self>, String> {
        let Some(key) = std::env::var_os("MIND_CLAVE_LECTURA_CONTINUIDAD") else {
            return Ok(None);
        };
        let key = key.into_string().map_err(|_| "Clave interna inválida")?;
        if !hex(&key, 64) {
            return Err("Clave interna inválida".into());
        }
        let base = base.to_str().ok_or("Ruta de Base inválida")?.to_owned();
        let writer = (std::env::var("MIND_ESCRITURA_NATIVA").as_deref() == Ok("1")).then(Writer::new);
        Ok(Some(Self { base, base_id: base_id.to_owned(), key, writer }))
    }

    pub(crate) async fn serve(&self, headers: &HeaderMap, id: &str) -> Response<Body> {
        let Some((nonce, proof)) = credential(headers) else {
            return full(StatusCode::UNAUTHORIZED, json!({"error": "UNAUTHORIZED"}));
        };
        if !same(proof.as_bytes(), self.sign(&format!("read\n{nonce}\n"), id.as_bytes()).as_bytes()) {
            return full(StatusCode::UNAUTHORIZED, json!({"error": "UNAUTHORIZED"}));
        }
        if !Uuid::parse_str(id).is_ok_and(|value| value.hyphenated().to_string() == id) {
            return full(StatusCode::BAD_REQUEST, json!({"error": "INVALID_CONTINUITY_ID"}));
        }

        let base = self.base.clone();
        let filename = format!("continuity-{id}.json");
        let result = tokio::task::spawn_blocking(move || read(&base, &filename)).await;
        let (status, bytes) = match result {
            Ok(Ok(bytes)) => (StatusCode::OK, bytes),
            Ok(Err("FILE_NOT_FOUND")) => (StatusCode::NOT_FOUND, Vec::new()),
            Ok(Err("UNSAFE_PATH")) => (StatusCode::CONFLICT, Vec::new()),
            Ok(Err("RECORD_TOO_LARGE")) => (StatusCode::UNPROCESSABLE_ENTITY, Vec::new()),
            _ => (StatusCode::INTERNAL_SERVER_ERROR, Vec::new()),
        };
        self.response(nonce, status, bytes)
    }

    pub(crate) async fn write(&self, request: Request<Incoming>, action: &str) -> Response<Body> {
        let Some(writer) = &self.writer else {
            return full(StatusCode::NOT_FOUND, json!({"error": "NOT_FOUND"}));
        };
        let (headers, body) = request.into_parts();
        let Some((nonce, proof)) = credential(&headers.headers) else {
            return full(StatusCode::UNAUTHORIZED, json!({"error": "UNAUTHORIZED"}));
        };
        let digest = match action {
            "escribir" => headers.headers.get("x-mind-write-digest").and_then(|value| value.to_str().ok())
                .filter(|value| hex(value, 64)),
            _ => Some(""),
        };
        let Some(digest) = digest else {
            return full(StatusCode::UNAUTHORIZED, json!({"error": "UNAUTHORIZED"}));
        };
        if !same(proof.as_bytes(), self.sign(&format!("{action}\n{nonce}\n"), digest.as_bytes()).as_bytes()) {
            return full(StatusCode::UNAUTHORIZED, json!({"error": "UNAUTHORIZED"}));
        }
        let result = match action {
            "escribir" => {
                match Limited::new(body, text_write::MAX_REQUEST as usize).collect().await {
                    Ok(value) => {
                        let bytes = value.to_bytes();
                        if format!("{:x}", Sha256::digest(&bytes)) != digest {
                            Err("WRITE_INVALID")
                        } else {
                            match serde_json::from_slice(&bytes) {
                                Ok(request) => writer.prepare(nonce, request).await,
                                Err(_) => Err("WRITE_INVALID"),
                            }
                        }
                    }
                    Err(_) => Err("WRITE_INVALID"),
                }
            }
            "confirmar" => writer.finish(nonce, true).await,
            "cancelar" => writer.finish(nonce, false).await,
            _ => Err("WRITE_INVALID"),
        };
        let (status, body) = match result {
            Ok(value) => (StatusCode::OK, value),
            Err(code) => (StatusCode::CONFLICT, json!({"error": code})),
        };
        self.response(nonce, status, serde_json::to_vec(&body).expect("JSON interno válido"))
    }

    fn response(&self, nonce: &str, status: StatusCode, bytes: Vec<u8>) -> Response<Body> {
        let proof = self.sign(&format!("record\n{nonce}\n{}\n", status.as_u16()), &bytes);
        Response::builder().status(status).header(header::CONTENT_TYPE, "application/json")
            .header("x-mind-continuity-proof", proof)
            .body(Full::new(Bytes::from(bytes)).map_err(|never| match never {}).boxed())
            .expect("respuesta interna válida")
    }

    fn sign(&self, context: &str, bytes: &[u8]) -> String {
        let mut mac = Hmac::<Sha256>::new_from_slice(self.key.as_bytes()).expect("HMAC acepta cualquier longitud");
        mac.update(self.base_id.as_bytes());
        mac.update(b"\n");
        mac.update(context.as_bytes());
        mac.update(bytes);
        format!("{:x}", mac.finalize().into_bytes())
    }
}

fn credential(headers: &HeaderMap) -> Option<(&str, &str)> {
    headers.get(header::AUTHORIZATION).and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Mind-Internal "))
        .and_then(|value| value.split_once('.'))
        .filter(|(nonce, proof)| hex(nonce, 32) && hex(proof, 64))
}

fn hex(text: &str, len: usize) -> bool {
    text.len() == len && text.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn read(base: &str, filename: &str) -> Result<Vec<u8>, &'static str> {
    let mut bytes = Vec::new();
    scan::open_reader(base, filename)?.take((MAX_RECORD + 1) as u64)
        .read_to_end(&mut bytes).map_err(|_| "READ_FAILED")?;
    if bytes.len() > MAX_RECORD {
        return Err("RECORD_TOO_LARGE");
    }
    Ok(bytes)
}
