use std::{fs, io::{self, Write}, path::Path};

use serde_json::json;
use uuid::Uuid;

use crate::{bridge::regular_json, text_write};

const FIXTURE_PREFIX: &str = "mind-nativo-runs-relevo-";
const ENTRY_FORMAT: &str = "mind-continuity-entry";

pub(crate) fn run(args: &[String]) -> Result<(), String> {
    let [base_flag, root, reference_flag, reference] = args else {
        return Err("crear-continuidad-prueba --base ABS --referencia UUID".into());
    };
    let base = Path::new(root);
    if base_flag != "--base" || reference_flag != "--referencia" || !base.is_absolute()
        || base.file_name().and_then(|name| name.to_str()) != Some("Base")
        || !base.parent().and_then(Path::file_name).and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with(FIXTURE_PREFIX))
    {
        return Err("BASE_FICTICIA_REQUERIDA".into());
    }
    if !Uuid::parse_str(reference).is_ok_and(|id| id.to_string() == *reference) {
        return Err("REFERENCIA_INVALIDA".into());
    }
    let marker = regular_json(&base.join("mind-base.json")).ok_or("BASE_R3_REQUERIDA")?;
    if marker["format"] != "mind-base" || marker["version"] != 3 {
        return Err("BASE_R3_REQUERIDA".into());
    }
    let previous = regular_json(&base.join(format!("continuity-{reference}.json")))
        .ok_or("REFERENCIA_INEXISTENTE")?;
    if previous["format"] != ENTRY_FORMAT || previous["version"] != 1 || previous["id"].as_str() != Some(reference) {
        return Err("REFERENCIA_INVALIDA".into());
    }
    // Reutiliza la fecha de la nota ficticia creada al preparar el ensayo.
    let timestamp = previous["updatedAt"].as_str().ok_or("REFERENCIA_INVALIDA")?;
    let id = Uuid::new_v4().to_string();
    let record = json!({
        "format": ENTRY_FORMAT, "version": 1, "id": id, "revision": 1,
        "createdAt": timestamp, "updatedAt": timestamp,
        "source": "Rust", "kind": "resultado",
        "content": { "nota": "Comprobación de continuidad en el área norte", "pasos": ["guardar", "retomar"], "verificado": true },
        "references": [{ "entry": reference, "relation": "continúa" }],
    });

    require_offline(base)?;
    let mut bytes = serde_json::to_vec(&record).map_err(|error| error.to_string())?;
    bytes.push(b'\n');
    text_write::create_stream(root, &format!("continuity-{id}.json"), || require_offline(base), |file| {
        file.write_all(&bytes).map_err(|_| "CREATE_FAILED")?;
        Ok(bytes.len() as u64)
    })?;
    serde_json::to_writer(io::stdout().lock(), &json!({ "id": id, "pid": std::process::id() }))
        .map_err(|error| error.to_string())
}

fn require_offline(base: &Path) -> Result<(), &'static str> {
    // La exclusión del ensayo se obtiene esperando la salida de cada proceso.
    for lock in ["conector.lock", "conector.lock.recovery"] {
        match fs::symlink_metadata(base.join(lock)) {
            Ok(_) => return Err("BASE_OCUPADA"),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(_) => return Err("BASE_NO_VERIFICADA"),
        }
    }
    Ok(())
}
