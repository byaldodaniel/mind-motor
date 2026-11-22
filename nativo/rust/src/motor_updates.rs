use std::{path::{Path, PathBuf}, process::Stdio, time::Duration};

use serde_json::{json, Map, Value};
use tokio::{io::{AsyncReadExt, AsyncWriteExt}, process::Command, runtime::Handle};

use crate::{
    motor_native::{invalid, only, Fault},
    motor_permissions::read_json,
    motor_workspace::{physical_directory, same_path},
    scan,
};

#[derive(Clone)]
pub(crate) struct Updater {
    root: Option<PathBuf>,
    motor: Option<PathBuf>,
    base: String,
}

const MAX_REPLY: u64 = 256 * 1024;
const TIMEOUT: Duration = Duration::from_secs(35);
const CODES: &[&str] = &[
    "INVALID_ARGUMENTS", "UPDATE_NOT_INSTALLATION", "UPDATE_NOT_AVAILABLE",
    "UPDATE_SIGNATURE_INVALID", "UPDATE_CHANNEL_INVALID", "UPDATE_STATE_INVALID",
    "UPDATE_PLATFORM_MISMATCH", "UPDATE_RELEASE_INVALID", "UPDATE_PACKAGE_ALTERED", "UPDATE_PYTHON_PATH",
    "UPDATE_CANDIDATE_CHANGED", "UPDATE_CONSENT_REQUIRED", "UPDATE_CONSENT_INVALID",
    "UPDATE_CONSENT_EXPIRED", "UPDATE_MANIFEST_ALTERED", "UPDATE_PROTOCOL_INVALID",
    "UPDATE_OFFER_CHANGED", "UPDATE_HANDOFF_START_FAILED", "UPDATE_HANDOFF_START_TIMEOUT",
    "UPDATE_RECOVERY_REQUIRED", "UPDATE_PATH_LINK", "UPDATE_HANDOFF_INVALID",
    "LOCK_BUSY", "LOCK_TIMEOUT", "INSTALLATION_BUSY",
];

fn unavailable() -> Fault {
    Fault::new("UPDATE_UNAVAILABLE", "No se pudo consultar el actualizador de esta instalación. Mind sigue disponible.")
}

impl Updater {
    pub(crate) fn new(base: &str, root: Option<&Path>, motor: Option<&Path>) -> Self {
        Self { base: base.to_owned(), root: root.map(Path::to_owned), motor: motor.map(Path::to_owned) }
    }

    pub(crate) fn enabled(&self) -> bool { self.root.is_some() }

    pub(crate) fn call(&self, op: &str, args: &Map<String, Value>) -> Result<Value, Fault> {
        match op {
            "actualizacion_consultar" => only(args, &[])?,
            "actualizacion_posponer" => {
                only(args, &["dias"])?;
                if args.get("dias").is_some_and(|value| !matches!(value.as_u64(), Some(1 | 3 | 7))) {
                    return Err(invalid("dias debe ser 1, 3 o 7."));
                }
            }
            "actualizacion_aplicar" => only(args, &["codigo"])?,
            _ => return Err(invalid("Operación de actualización no válida.")),
        }
        if !self.enabled() {
            return match op {
                "actualizacion_consultar" => Ok(json!({
                    "estado":"no-aplica","motivo":"Esta copia de Mind no es una instalación (desarrollo); no recibe actualizaciones.",
                })),
                "actualizacion_posponer" => Err(Fault::new("UPDATE_NOT_AVAILABLE", "No hay una entrega nueva que posponer.")),
                _ => Err(Fault::new("UPDATE_NOT_INSTALLATION", "Esta copia es de desarrollo; no recibe actualizaciones.")),
            };
        }
        self.request(json!({"op":op,"args":args}))
    }

    pub(crate) fn discover(&self) {
        if self.enabled() {
            let _ = self.request(json!({"op":"descubrir"}));
        }
    }

    pub(crate) fn advisories(&self, connection: Option<&str>, include_notice: bool) -> Option<Value> {
        let root = self.root.as_deref()?.to_str()?;
        let notice = include_notice && read_json(root, "Sistema/Actualizaciones/estado.json").ok().flatten()
            .is_some_and(|state| matches!(state["phase"].as_str(), Some("disponible" | "descargando" | "descargada")));
        let report = read_json(root, "Sistema/Actualizaciones/relevo.json").ok().flatten()
            .is_some_and(|state| matches!(state["phase"].as_str(), Some("completada" | "fallida"))
                && connection.is_none_or(|id| state["reported"].get(id).is_none()));
        if !notice && !report { return None; }
        self.request(json!({"op":"avisos","connection":connection,"report":report,"notice":notice})).ok()
    }

    pub(crate) fn prepare_form(&self, args: &Map<String, Value>) -> Result<Value, Fault> {
        only(args, &[])?;
        if !self.enabled() { return self.call("actualizacion_aplicar", args); }
        self.request(json!({"op":"preparar"}))
    }

    pub(crate) fn finish_form(&self, identity: Value, approved: bool) -> Result<Value, Fault> {
        self.request(json!({"op":"confirmar","identity":identity,"approved":approved}))
    }

    fn executable(&self) -> Result<(PathBuf, PathBuf, PathBuf), Fault> {
        let declared = self.root.as_deref().ok_or_else(unavailable)?;
        let root = physical_directory(declared).filter(|physical| same_path(physical, declared))
            .map(PathBuf::from).ok_or_else(unavailable)?;
        let root_text = root.to_str().ok_or_else(unavailable)?;
        let manifest = read_json(root_text, "Sistema/mind-producto.json").map_err(|_| unavailable())?;
        let (manifest, modern) = match manifest {
            Some(manifest) if manifest["layoutVersion"] == 2 => (manifest, true),
            _ => (read_json(root_text, "mind-producto.json").map_err(|_| unavailable())?
                .ok_or_else(unavailable)?, false),
        };
        if manifest["format"] != "mind-product" || manifest["version"] != 1 {
            return Err(unavailable());
        }
        let motor = if modern { root.join("Sistema/Programa/Motor") } else { root.join("Motor") };
        if self.motor.as_ref().is_some_and(|provided| provided.to_str().is_none_or(|provided| !same_path(provided, &motor))) {
            return Err(unavailable());
        }
        let motor_text = physical_directory(&motor).filter(|physical| same_path(physical, &motor))
            .ok_or_else(unavailable)?;
        let motor = Path::new(&motor_text);
        let os = if cfg!(windows) { "win32" } else { std::env::consts::OS };
        let arch = match std::env::consts::ARCH { "x86_64" => "x64", "aarch64" => "arm64", _ => return Err(unavailable()) };
        let target = format!("{os}-{arch}");
        let node_dir = if modern {
            format!("Sistema/Componentes/Node/{target}")
        } else if !cfg!(windows) && manifest["targets"].is_array() {
            format!("Runtime/{target}/node")
        } else {
            "Runtime/node".to_owned()
        };
        let relative = format!("{node_dir}/{}", if cfg!(windows) { "node.exe" } else { "bin/node" });
        let node = root.join(relative.replace('/', std::path::MAIN_SEPARATOR_STR));
        let helper = "bin/native-update.js";
        scan::open_reader(root_text, &relative).map_err(|_| unavailable())?;
        scan::open_reader(&motor_text, helper).map_err(|_| unavailable())?;
        Ok((root, node, motor.join("bin").join("native-update.js")))
    }

    fn request(&self, request: Value) -> Result<Value, Fault> {
        let (root, node, helper) = self.executable()?;
        let mut command = Command::new(node);
        command.arg(helper).arg(&self.base).arg(&root).current_dir(&root)
            .env_remove("NODE_OPTIONS").env_remove("NODE_PATH").env_remove("MIND_UPDATE_VERIFY")
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        let input = serde_json::to_vec(&request).map_err(|_| unavailable())?;
        let reply = Handle::current().block_on(async {
            tokio::time::timeout(TIMEOUT, async {
                let mut child = command.spawn().ok()?;
                let mut stdin = child.stdin.take()?;
                stdin.write_all(&input).await.ok()?;
                drop(stdin);
                let mut output = Vec::new();
                child.stdout.take()?.take(MAX_REPLY + 1).read_to_end(&mut output).await.ok()?;
                if output.len() as u64 > MAX_REPLY || !child.wait().await.ok()?.success() { return None; }
                serde_json::from_slice::<Value>(&output).ok()
            }).await.ok().flatten()
        }).ok_or_else(unavailable)?;
        if reply["ok"] == true {
            return reply.get("value").cloned().ok_or_else(unavailable);
        }
        let code = reply["code"].as_str().unwrap_or_default();
        let message = reply["message"].as_str().filter(|value| !value.is_empty() && value.len() <= 4096);
        match (CODES.iter().copied().find(|candidate| *candidate == code), message) {
            (Some(code), Some(message)) => Err(Fault::new(code, message)),
            _ => Err(unavailable()),
        }
    }
}
