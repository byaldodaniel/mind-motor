use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use crate::{
    motor_native::Fault,
    motor_permissions::{self as access, Scope},
    organize, text_write,
};

const MAX_TEXT: usize = 1024 * 1024;
const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

fn invalid(message: &str) -> Fault {
    Fault::new("INVALID_ARGUMENTS", message)
}

fn unsupported(message: &str) -> Fault {
    Fault::new("NOT_YET_PORTED", message)
}

fn optional<'a>(args: &'a Map<String, Value>, key: &str) -> Result<Option<&'a str>, Fault> {
    args.get(key).map(|value| value.as_str().ok_or_else(|| invalid("Se esperaba un argumento de texto."))).transpose()
}

fn limit(args: &Map<String, Value>, key: &str) -> Result<Option<u64>, Fault> {
    args.get(key).map(|value| {
        value.as_u64().filter(|number| (1..=MAX_SAFE_INTEGER).contains(number))
            .ok_or_else(|| invalid("Los límites por línea deben ser enteros positivos."))
    }).transpose()
}

fn only(args: &Map<String, Value>, fields: &[&str]) -> Result<(), Fault> {
    if args.keys().all(|key| fields.contains(&key.as_str())) {
        Ok(())
    } else {
        Err(invalid("La solicitud contiene argumentos no reconocidos."))
    }
}

fn absolute(scope: &Scope) -> PathBuf {
    let mut path = PathBuf::from(&scope.root);
    for component in scope.relative.split('/') {
        path.push(component);
    }
    path
}

fn version(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}

fn verify(base: &str, scope: &Scope, required: &[&str]) -> Result<(), Fault> {
    if access::resolve_file(base, Some(&scope.id), &scope.relative, required)? != *scope {
        return Err(Fault::new("ACCESS_NOT_GRANTED", "La autorización de la carpeta cambió durante la operación."));
    }
    Ok(())
}

fn read(base: &str, args: &Map<String, Value>, folder: Option<&str>, relative: &str) -> Result<Value, Fault> {
    if args.contains_key("seccion") {
        return Err(unsupported("La lectura por secciones todavía depende del Motor r3."));
    }
    let extension = Path::new(relative).extension().and_then(|extension| extension.to_str()).unwrap_or("")
        .to_ascii_lowercase();
    if matches!(extension.as_str(), "docx" | "xlsx" | "pptx" | "odt" | "ods" | "odp") {
        return Err(unsupported("La extracción de documentos de oficina aún no está conectada a esta ruta."));
    }
    only(args, &["carpeta", "ruta", "desde_linea", "lineas"])?;
    let from = limit(args, "desde_linea")?;
    let count = limit(args, "lineas")?;
    let scope = access::resolve_file(base, folder, relative, &["leer"])?;
    let bytes = access::read_file(&scope.root, &scope.relative, MAX_TEXT)?
        .ok_or_else(|| Fault::new("FILE_NOT_FOUND", "No se encontró el archivo."))?;
    let content = std::str::from_utf8(&bytes).ok().filter(|text| !text.contains('\0'))
        .ok_or_else(|| Fault::new("TEXT_UNREADABLE", "El archivo no contiene texto UTF-8 válido."))?;
    verify(base, &scope, &["leer"])?;
    let lines = content.split_terminator('\n').count();
    let shown = if from.is_some() || count.is_some() {
        let start = usize::try_from(from.unwrap_or(1) - 1).unwrap_or(usize::MAX);
        let take = count.and_then(|count| usize::try_from(count).ok()).unwrap_or(usize::MAX);
        content.split('\n').skip(start).take(take).collect::<Vec<_>>().join("\n")
    } else {
        content.to_owned()
    };
    let mut result = json!({
        "carpeta": scope.id, "ruta": scope.relative, "ruta_absoluta": absolute(&scope),
        "version": version(&bytes), "bytes": bytes.len(), "lineas": lines, "contenido": shown,
    });
    if shown != content {
        result["mostrado"] = json!({"desde_linea": from.unwrap_or(1), "lineas": count});
    }
    Ok(result)
}

fn write(
    base: &str, name: &str, args: &Map<String, Value>, folder: Option<&str>, relative: &str,
    confirm_owner: impl Fn() -> Result<(), &'static str>,
) -> Result<Value, Fault> {
    let creating = name == "crear";
    if creating && ["proyecto", "conversacion", "destino", "tipo"].iter().any(|key| args.contains_key(*key)) {
        return Err(unsupported("La creación por destinos configurados aún depende del Motor r3."));
    }
    if creating && access::destinations(base, None, None)?["efectivos"].as_object().is_some_and(|values| !values.is_empty()) {
        return Err(unsupported("La creación por destinos configurados aún depende del Motor r3."));
    }
    if !creating && args.contains_key("ediciones") {
        return Err(unsupported("La edición parcial aún depende del Motor r3."));
    }
    let directory = if creating {
        match optional(args, "accion")?.unwrap_or("archivo") {
            "archivo" => false,
            "carpeta" => true,
            _ => return Err(invalid("La acción debe ser archivo o carpeta.")),
        }
    } else {
        false
    };
    let required = if directory { ["organizar"] } else { ["escribir"] };
    let scope = access::resolve_file(base, folder, relative, &required)?;
    let confirm = || {
        verify(base, &scope, &required).map_err(|error| error.code)?;
        confirm_owner()
    };
    let filesystem = |code| Fault::new(code, "La publicación segura se detuvo. Revisa permisos, destino y versión.");
    if directory {
        only(args, &["accion", "carpeta", "ruta"])?;
        organize::create_directory(&scope.root, &scope.relative, confirm).map_err(filesystem)?;
        return Ok(json!({
            "estado": "creada", "carpeta": scope.id, "ruta": scope.relative, "ruta_absoluta": absolute(&scope),
        }));
    }

    let accepted = if creating { ["carpeta", "ruta", "contenido", "accion"] }
        else { ["carpeta", "ruta", "contenido", "version"] };
    only(args, &accepted)?;
    let content = optional(args, "contenido")?.ok_or_else(|| invalid("Indica el contenido del archivo."))?;
    let expected = if creating {
        None
    } else {
        let original = optional(args, "version")?.and_then(|version| version.strip_prefix("sha256:"))
            .filter(|digest| digest.len() == 64 && digest.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)))
            .ok_or_else(|| Fault::new("INVALID_VERSION", "Indica la versión leída del archivo."))?;
        Some(original)
    };
    text_write::write_bytes(&scope.root, &scope.relative, content.as_bytes(), MAX_TEXT, expected, confirm)
        .map_err(filesystem)?;
    let mut result = json!({
        "estado": if creating { "creado" } else { "modificado" },
        "carpeta": scope.id, "ruta": scope.relative, "ruta_absoluta": absolute(&scope),
        "bytes": content.len(), "version": version(content.as_bytes()), "indice": "needs-reconciliation",
    });
    if creating {
        result["registro"] = json!({"estado": "sin_conversacion"});
    } else {
        result["version_anterior"] = args["version"].clone();
    }
    Ok(result)
}

pub(crate) fn call(
    base: &str, name: &str, args: &Map<String, Value>,
    confirm_owner: impl Fn() -> Result<(), &'static str>,
) -> Result<Value, Fault> {
    let folder = optional(args, "carpeta")?;
    let relative = optional(args, "ruta")?.ok_or_else(|| invalid("Indica la ruta relativa del archivo."))?;
    match name {
        "leer" => read(base, args, folder, relative),
        "crear" | "modificar" => write(base, name, args, folder, relative, confirm_owner),
        _ => Err(Fault::new("UNKNOWN_TOOL", "Herramienta de archivos desconocida.")),
    }
}
