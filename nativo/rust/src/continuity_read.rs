use std::{io::Read, path::Path};
use bytes::Bytes;
use hmac::{Hmac, Mac};
use http_body_util::{BodyExt, Full};
use hyper::{header, HeaderMap, Response, StatusCode};
use serde_json::json;
use sha2::Sha256;
use uuid::Uuid;
use crate::{host::{full, same, Body}, scan};

pub(crate) const PATH_PREFIX: &str = "/interno/continuidad/";
const MAX_RECORD: usize = 2 * 1024 * 1024;

pub(crate) struct Reader {
    base: String,
    base_id: String,
    key: String,
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
        Ok(Some(Self { base, base_id: base_id.to_owned(), key }))
    }

    pub(crate) async fn serve(&self, headers: &HeaderMap, id: &str) -> Response<Body> {
        let credential = headers.get(header::AUTHORIZATION).and_then(|value| value.to_str().ok())
            .and_then(|value| value.strip_prefix("Mind-Internal ")).and_then(|value| value.split_once('.'));
        let Some((nonce, proof)) = credential.filter(|(nonce, proof)| hex(nonce, 32) && hex(proof, 64)) else {
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
