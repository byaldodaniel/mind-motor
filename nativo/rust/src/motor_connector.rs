use std::{fs, path::Path};
use hmac::{Hmac, Mac};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;
use crate::{bridge, motor_owner::{timestamp, Owner}, motor_permissions, text_write};

const SECRET: &str = "conector-secreto.json";
const STATE: &str = "conector.json";

pub(crate) struct Connector {
    base: String,
    pub(crate) base_id: String,
    pub(crate) token: String,
    port: u16,
    started: String,
    version: String,
    revision: u64,
    launch: String,
    published: bool,
}

impl Connector {
    pub(crate) fn open(base: &str, port: u16, owner: &Owner, publish: bool) -> Result<Self, String> {
        let base_id = bridge::base_id(Path::new(base)).ok_or("No se pudo identificar la Base del conector.")?;
        let started = timestamp().ok_or("No se pudo leer la hora del sistema.")?;
        let version = std::env::var("MIND_MOTOR_NATIVO_VERSION").unwrap_or_else(|_| "1.0.5".into());
        let revision = std::env::var("MIND_MOTOR_NATIVO_REVISION").ok()
            .and_then(|value| value.parse().ok()).unwrap_or(0);
        let launch = std::env::var("MIND_LANZAMIENTO").unwrap_or_else(|_| "directo".into());
        let new_token = || format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
        let token = if publish {
            let previous = motor_permissions::read_file(base, SECRET, 64 * 1024).map_err(|e| e.to_string())?;
            let existing = previous.as_ref().and_then(|body| serde_json::from_slice::<Value>(body).ok())
                .filter(|entry| entry["version"] == 1)
                .and_then(|entry| entry["token"].as_str().filter(|token| {
                    token.len() >= 32 && token.bytes().all(|byte| byte.is_ascii_graphic())
                }).map(str::to_owned));
            match existing {
                Some(token) => token,
                None => {
                    let token = new_token();
                    write(base, SECRET, &json!({"version":1,"token":token,"createdAt":started}), previous, owner)?;
                    token
                }
            }
        } else {
            new_token()
        };

        let mut connector = Self {
            base: base.into(), base_id, token, port, started, version, revision, launch, published: false,
        };
        if publish {
            let previous = motor_permissions::read_file(base, STATE, 64 * 1024).map_err(|e| e.to_string())?;
            write(base, STATE, &json!({
                "version": 1, "baseId": connector.base_id, "port": port, "pid": std::process::id(),
                "motorVersion": connector.version, "startedAt": connector.started,
                "url": connector.url(), "backend": "rust",
            }), previous, owner)?;
            connector.published = true;
        }
        Ok(connector)
    }

    pub(crate) fn url(&self) -> String {
        format!("http://127.0.0.1:{}/mcp", self.port)
    }

    pub(crate) fn health(&self, query: Option<&str>, sessions: usize) -> Value {
        let mut health = json!({
            "ok": true, "baseId": self.base_id, "port": self.port, "pid": std::process::id(),
            "motorVersion": self.version, "packageRevision": self.revision, "backend": "rust",
            "state": "active", "startedAt": self.started, "sessions": sessions,
            "backgroundBusy": false, "launch": self.launch,
            "independence": if matches!(self.launch.as_str(), "wmi" | "setsid") { "plena" } else { "heredada" },
        });
        let nonce = query.and_then(|query| query.split('&').find_map(|part| part.strip_prefix("nonce=")));
        if let Some(nonce) = nonce.filter(|nonce| (32..=128).contains(&nonce.len())
            && nonce.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)))
        {
            let mut mac = Hmac::<Sha256>::new_from_slice(self.token.as_bytes()).expect("HMAC accepts any key");
            mac.update(format!("mind-health-v1\n{nonce}\n{}\n{}", self.base_id, self.port).as_bytes());
            health["proof"] = json!(format!("{:x}", mac.finalize().into_bytes()));
        }
        health
    }
}

impl Drop for Connector {
    fn drop(&mut self) {
        if !self.published { return; }
        let current = motor_permissions::read_json(&self.base, STATE).ok().flatten();
        if current.is_some_and(|entry| entry["pid"] == std::process::id()
            && entry["baseId"] == self.base_id && entry["startedAt"] == self.started)
        {
            let _ = fs::remove_file(Path::new(&self.base).join(STATE));
        }
    }
}

fn write(base: &str, file: &str, value: &Value, previous: Option<Vec<u8>>, owner: &Owner) -> Result<(), String> {
    let bytes = value.to_string() + "\n";
    let expected = previous.map(|bytes| format!("{:x}", Sha256::digest(&bytes)));
    text_write::write_bytes(base, file, bytes.as_bytes(), 64 * 1024, expected.as_deref(), || owner.check())
        .map(|_| ()).map_err(str::to_owned)
}
