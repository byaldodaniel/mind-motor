use std::{collections::BTreeMap, path::Path, time::Duration};

use reqwest::{Method, Url};
use serde_json::json;

use crate::{
    bridge::regular_json,
    services::{HOST_SECRET, MOTOR_SECRET},
    view_cli::{path_option, small_json, view_id, Host},
};

const USAGE: &str =
    "servicio abrir --base ABS --proyecto NOMBRE --copia ABS --receta ABS --autorizar SHA256 [--id UUID]\n\
     servicio estado|cerrar --base ABS --id UUID";

fn admin_token(base: &Path, endpoint: &Url) -> Result<String, String> {
    let port = endpoint.port_or_known_default().map(u64::from);
    let secret = [HOST_SECRET, MOTOR_SECRET].iter()
        .filter_map(|name| regular_json(&base.join(name)))
        .find(|secret| secret["port"].as_u64() == port && secret["version"] == 1)
        .ok_or("Inicia el Motor o el anfitrión con --servicios-prueba.")?;
    if endpoint.scheme() != "http"
        || endpoint.host_str() != Some("127.0.0.1")
        || port.is_none()
        || secret["port"].as_u64() != port
        || secret["version"].as_u64() != Some(1)
    {
        return Err("El permiso de servicios no corresponde a este anfitrión.".into());
    }
    secret["token"]
        .as_str()
        .filter(|token| {
            (32..=256).contains(&token.len()) && token.bytes().all(|byte| byte.is_ascii_graphic())
        })
        .map(str::to_owned)
        .ok_or_else(|| "El permiso de servicios no es válido.".into())
}

pub(crate) async fn run(args: &[String]) -> Result<(), String> {
    if matches!(args, [help] if help == "--help" || help == "-h") {
        println!("{USAGE}");
        return Ok(());
    }
    let (operation, args) = args.split_first().ok_or(USAGE)?;
    let mut options = BTreeMap::new();
    let mut pairs = args.chunks_exact(2);
    for pair in &mut pairs {
        let key = pair[0].as_str();
        if !matches!(key, "--base" | "--id" | "--proyecto" | "--copia" | "--receta" | "--autorizar")
            || options.insert(key, pair[1].as_str()).is_some()
        {
            return Err(USAGE.into());
        }
    }
    if !pairs.remainder().is_empty() {
        return Err(USAGE.into());
    }
    let base = path_option(Some(options.remove("--base").ok_or(USAGE)?))?;
    let id = view_id(options.remove("--id"))?;
    let (method, payload) = match operation.as_str() {
        "abrir" => {
            let project = options.remove("--proyecto").ok_or(USAGE)?;
            let copy = path_option(Some(options.remove("--copia").ok_or(USAGE)?))?;
            let recipe = path_option(Some(options.remove("--receta").ok_or(USAGE)?))?;
            let approval = options.remove("--autorizar").ok_or(USAGE)?;
            let method = if id.is_some() { Method::PUT } else { Method::POST };
            let body = json!({
                "proyecto": project, "copia": copy, "receta": recipe, "autorizar": approval,
            });
            (method, Some(body))
        }
        "estado" if id.is_some() => (Method::GET, None),
        "cerrar" if id.is_some() => (Method::DELETE, None),
        _ => return Err(USAGE.into()),
    };
    if !options.is_empty() {
        return Err(USAGE.into());
    }

    let route = id.map_or_else(|| "/servicios".to_owned(), |id| format!("/servicios/{id}"));
    let host = Host::connect(&base).await?;
    let endpoint_for = |host: &Host| Url::parse(&host.url(&route)).map_err(|_| "La dirección del servidor local no es válida.");
    let endpoint = endpoint_for(&host)?;
    let (host, endpoint, token) = match admin_token(&base, &endpoint) {
        Ok(token) => (host, endpoint, token),
        Err(error) => {
            let native = Host::connect_native(&base).await.map_err(|_| error)?;
            let endpoint = endpoint_for(&native)?;
            let token = admin_token(&base, &endpoint)?;
            (native, endpoint, token)
        }
    };
    let mut request = host.client.request(method, endpoint).bearer_auth(token);
    if let Some(body) = payload {
        request = request.timeout(Duration::from_secs(1810)).json(&body);
    }
    let response = request
        .send()
        .await
        .map_err(|_| "El anfitrión local no respondió a la operación de servicio.")?;
    let status = response.status();
    let body = small_json(response).await?;
    println!("{body}");
    if status.is_success() {
        Ok(())
    } else {
        Err(format!("La operación de servicio falló ({status})."))
    }
}
