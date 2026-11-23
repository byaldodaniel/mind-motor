//! Update notices and explicit consent, backed by Rust signature verification.
use std::{path::{Path, PathBuf}, sync::{Arc, Mutex}, time::Duration};

use serde_json::{json, Map, Value};
use tokio::runtime::Handle;
use uuid::Uuid;

use crate::{host, motor_native::{invalid, only}, update_handoff::{self as runner, HANDOFF, STATE},
    update_package::*};

const DECISIONS: &str = "Sistema/Estado/actualizacion-decisiones.json";
const CONSENT: &str = "Sistema/Actualizaciones/consentimiento.json";
const DAY: i64 = 86_400_000;
const OFFER_PHASES: [&str; 3] = ["disponible", "descargando", "descargada"];

#[derive(Clone)]
pub(crate) struct Updater {
    root: Option<PathBuf>,
    base: String,
    lock: Arc<Mutex<()>>,
}

impl Updater {
    pub(crate) fn new(base: &str, root: Option<&Path>, _: Option<&Path>) -> Self {
        Self { base: base.to_owned(), root: root.map(Path::to_owned), lock: Arc::new(Mutex::new(())) }
    }

    pub(crate) fn enabled(&self) -> bool { self.root.is_some() }

    fn root(&self) -> Result<String> {
        physical(self.root.as_deref().ok_or_else(|| fail("UPDATE_NOT_INSTALLATION", "Esta copia de desarrollo no recibe actualizaciones."))?)
    }

    fn locked<T>(&self, call: impl FnOnce(&str) -> Result<T>) -> Result<T> {
        let _guard = self.lock.lock().map_err(|_| fail("INSTALLATION_BUSY", "La actualización está ocupada."))?;
        call(&self.root()?)
    }

    pub(crate) fn call(&self, op: &str, args: &Map<String, Value>) -> Result<Value> {
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
        if !self.enabled() && op == "actualizacion_consultar" {
            return Ok(json!({"estado":"no-aplica","motivo":"Esta copia de Mind no es una instalación (desarrollo); no recibe actualizaciones."}));
        }
        if !self.enabled() && op == "actualizacion_posponer" { return Err(no_offer()); }
        self.locked(|root| match op {
            "actualizacion_consultar" => self.consult(root),
            "actualizacion_posponer" => postpone(root, args.get("dias").and_then(Value::as_i64).unwrap_or(1)),
            _ => self.consent(root, args.get("codigo")),
        })
    }

    pub(crate) fn prepare_form(&self, args: &Map<String, Value>) -> Result<Value> {
        only(args, &[])?;
        self.locked(|root| Ok(offer(root)?.identity()))
    }

    pub(crate) fn finish_form(&self, identity: Value, approved: bool) -> Result<Value> {
        self.locked(|root| {
            let offer = offer(root)?;
            if offer.identity() != identity { return Err(changed()); }
            if let Some(mut state) = read_json(root, CONSENT)?.filter(|value| value["status"] == "pendiente") {
                state["status"] = json!("cancelado");
                put(root, CONSENT, &state)?;
            }
            if approved { runner::submit(root, &self.base, &offer) }
            else { Ok(json!({"estado":"cancelada","indicacion":"El usuario no confirmó la actualización."})) }
        })
    }

    fn consent(&self, root: &str, code: Option<&Value>) -> Result<Value> {
        let code = code.map(|raw| raw.as_str().map(|code| code.trim().to_ascii_lowercase())
            .filter(|code| code.len() == 24 && code.bytes().all(|b| b.is_ascii_hexdigit()))
            .ok_or_else(|| invalid("codigo debe ser el código de confirmación que devolvió Mind."))).transpose()?;
        let offer = offer(root)?;
        let identity = offer.identity();
        let now = now_ms();
        if let Some(code) = code {
            let mut state = read_json(root, CONSENT)?.filter(|value| value["status"] == "pendiente")
                .ok_or_else(|| fail("UPDATE_CONSENT_REQUIRED", "La confirmación ya se utilizó o no existe."))?;
            if state["format"] != "mind-update-consent" || state["version"] != 1 || !state["codeHash"].as_str().is_some_and(hash) {
                return Err(fail("UPDATE_CONSENT_INVALID", "No se puede verificar el consentimiento guardado."));
            }
            if millis(&state["expiresAt"]).is_none_or(|until| until <= now) {
                state["status"] = json!("caducado");
                put(root, CONSENT, &state)?;
                return Err(fail("UPDATE_CONSENT_EXPIRED", "El código caducó; solicita una nueva confirmación."));
            }
            if state["identity"] != identity {
                state["status"] = json!("cancelado");
                put(root, CONSENT, &state)?;
                return Err(changed());
            }
            if !host::same(sha(code.as_bytes()).as_bytes(), state["codeHash"].as_str().unwrap().as_bytes()) {
                return Err(fail("UPDATE_CONSENT_INVALID", "El código no coincide con la confirmación pendiente."));
            }
            state["status"] = json!("consumido");
            state["consumedAt"] = iso(now);
            put(root, CONSENT, &state)?;
            return runner::submit(root, &self.base, &offer);
        }
        let random = Uuid::new_v4().simple().to_string();
        let code = &random[8..];
        let expires = iso(now + 15 * 60_000);
        put(root, CONSENT, &json!({"format":"mind-update-consent","version":1,"status":"pendiente",
            "identity":identity,"codeHash":sha(code.as_bytes()),"createdAt":iso(now),"expiresAt":expires}))?;
        Ok(json!({"estado":"requiere-confirmacion","version":offer.release.mind_version,"revision":offer.release.package_revision,
            "codigo":code,"caduca":expires,"indicacion":"Pide al usuario que confirme esta entrega. Solo si confirma, vuelve a llamar con este código de un solo uso."}))
    }

    pub(crate) fn discover(&self) {
        let Ok(root) = self.root() else { return };
        let Ok(channel) = Channel::load(&root) else { return };
        let Some(url) = channel.url.as_ref().and_then(|raw| channel.address(raw).ok()) else { return };
        let now = now_ms();
        let Ok(previous) = state(&root) else { return };
        if millis(&previous["nextCheckAt"]).is_some_and(|until| until > now) { return; }
        let network = async {
            let reply = runner::internet(Duration::from_secs(15))?.get(url).send().await
                .and_then(reqwest::Response::error_for_status)
                .map_err(|error| fs_error("UPDATE_CONNECTION_FAILED", error))?;
            let bytes = runner::bounded(reply, 128 * 1024).await?;
            let envelope: Value = serde_json::from_slice(&bytes).map_err(|error| fs_error("UPDATE_CHANNEL_INVALID", error))?;
            Offer::verify(&channel, &envelope)
        };
        let found = Handle::current().block_on(network);
        let _ = self.locked(|root| {
            if runner::handoff(root)?.is_some_and(|handoff| !matches!(handoff["phase"].as_str(), Some("completada" | "fallida"))) {
                return Ok(());
            }
            let current = Release::read(&installed(root)?)?;
            let mut next = state(root)?;
            if next != previous { return Ok(()); }
            let interval = if found.is_ok() { 6 * 3_600_000 } else { 30 * 60_000 };
            next["nextCheckAt"] = iso(now + interval);
            next["updatedAt"] = iso(now);
            match found {
                Ok(offer) => {
                    next["lastCheckedAt"] = iso(now);
                    next["lastError"] = Value::Null;
                    if offer.release.newer_than(&current) {
                        next["phase"] = json!("disponible");
                        next["envelope"] = offer.envelope;
                        next["release"] = json!(offer.release);
                        next["package"] = offer.selected;
                    } else {
                        next["phase"] = json!("al-dia");
                        next["envelope"] = Value::Null;
                        next["release"] = Value::Null;
                        next["package"] = Value::Null;
                    }
                }
                Err(error) => {
                    if next["phase"].is_null() { next["phase"] = json!("fallida"); }
                    next["lastError"] = json!({"code":error.code,"kind":if error.code == "UPDATE_CONNECTION_FAILED" {"conexion"} else {"integridad"},
                        "message":error.message,"at":iso(now)});
                }
            }
            put(root, STATE, &next)
        });
    }

    fn consult(&self, root: &str) -> Result<Value> {
        let installed = Release::read(&installed(root)?)?;
        let state = state(root).unwrap_or_else(|error| json!({"phase":"estado-no-verificable","lastError":{"code":error.code,"message":error.message}}));
        let job = runner::handoff(root)?.map(|job| json!({"id":job["id"],"fase":job["phase"],"entrega":job["release"],
            "error":job["error"],"verificacion":job["verification"]}));
        let mut result = json!({"instalada":installed,"fase":state["phase"].as_str().unwrap_or("sin-comprobar"),
            "ultima_comprobacion":state["lastCheckedAt"],"disponible":null,"aplicacion":job,
            "ultimo_error":if state["lastError"].is_null() {Value::Null} else {
                json!({"codigo":state["lastError"]["code"],"tipo":state["lastError"]["kind"],"mensaje":state["lastError"]["message"]})
            }});
        let Ok(offer) = offer(root) else {
            result["resumen"] = json!(if state["phase"] == "al-dia" { "Mind está al día." } else { "No hay una entrega nueva disponible ahora." });
            return Ok(result);
        };
        let notes = &offer.feed["novedades"];
        let base_format = read_json(&self.base, "mind-base.json").ok().flatten().map(|record| record["version"].clone());
        let checked = &notes["comprobado"];
        let incoming = checked["baseFormatVersion"].as_i64();
        let current = base_format.as_ref().and_then(Value::as_i64);
        let mode = match (current, incoming) {
            (Some(a), Some(b)) if a == b => "sin-cambios",
            (Some(a), Some(b)) if a < b => "migracion",
            (Some(_), Some(_)) => "incompatible",
            _ => "desconocido",
        };
        let mut available = json!(offer.release);
        available.as_object_mut().unwrap().extend(json!({"aviso":notice(&offer),"nombre":notes["nombre"],"resumen":notes["resumen"],
            "cambios":notes["cambios"].as_array().cloned().unwrap_or_default(),"importancia":notes["importancia"].as_str().unwrap_or("normal"),
            "impacto_declarado":notes["impacto_datos"],"firma":"Ed25519 verificada. El ZIP y sus archivos se verifican antes de sustituir el programa."}).as_object().unwrap().clone());
        result["disponible"] = available;
        result["comprobado_en_este_equipo"] = json!({"base":{"formato_actual":base_format,"formato_entrega":incoming,
            "ubicacion":self.base,"efecto":mode},"espacio":{"libre_bytes":null,"necesario_bytes":null,"suficiente":null},
            "descarga_bytes":offer.selected["bytes"],"grupos_que_cambian":checked["gruposCambiados"],
            "se_conservan":["Base","Conversaciones","carpetas autorizadas y sus permisos","destinos","funciones","conexiones de los agentes"]});
        let decisions = decisions(root)?;
        result["pospuesta_hasta"] = if postponed(&decisions, &offer) { decisions["pospuesta"]["hasta"].clone() } else { Value::Null };
        result["resumen"] = json!(notice(&offer));
        result["indicacion"] = json!("Explica los cambios verificados y espera la decisión de la persona usuaria.");
        Ok(result)
    }

    pub(crate) fn advisories(&self, connection: Option<&str>, include_notice: bool) -> Option<Value> {
        self.locked(|root| {
            let slot = connection.unwrap_or("sin-conexion");
            let mut result = Map::new();
            if let Some(mut job) = runner::handoff(root)?.filter(|job| matches!(job["phase"].as_str(), Some("completada" | "fallida"))) {
                if job["reported"].get(slot).is_none() {
                    let notices = job["reported"].as_object().cloned().unwrap_or_default();
                    let mut latest: Vec<_> = notices.into_iter().collect();
                    latest.sort_by_key(|(_, value)| millis(value).unwrap_or_default());
                    let mut kept: Map<_, _> = latest.into_iter().rev().take(255).collect();
                    kept.insert(slot.into(), iso(now_ms()));
                    job["reported"] = Value::Object(kept);
                    put(root, HANDOFF, &job)?;
                    result.insert("acta_actualizacion".into(), json!({"estado":job["phase"],"id":job["id"],
                        "version":job["release"]["mindVersion"],"error":job["error"],"verificacion":job["verification"],
                        "texto":if job["phase"] == "completada" { "Mind comprobó el programa y la Base después de actualizar." }
                            else { "Consulta el acta de la actualización de Mind." }}));
                }
            }
            if include_notice {
                if let Some(value) = take_notice(root, slot, connection.is_some())? {
                    result.insert("aviso_actualizacion".into(), value);
                }
            }
            Ok(Value::Object(result))
        }).ok().filter(|value| value.as_object().is_some_and(|map| !map.is_empty()))
    }
}

fn state(root: &str) -> Result<Value> {
    let Some(mut state) = read_json(root, STATE)? else { return Ok(json!({"format":"mind-update-state","version":2})); };
    if state["format"] != "mind-update-state" || !matches!(state["version"].as_i64(), Some(1 | 2)) {
        return Err(fail("UPDATE_STATE_INVALID", "El estado de actualización no es válido."));
    }
    if state["version"] == 1 {
        state["version"] = json!(2);
        if state["phase"] == "preparada" { state["phase"] = json!("descargada"); }
        if state["phase"] == "comprobando" { state["phase"] = json!(if state["envelope"].is_null() {"al-dia"} else {"disponible"}); }
        if state["lastError"].is_null() && !state["code"].is_null() {
            state["lastError"] = json!({"code":state["code"],"kind":state["kind"],"message":state["reason"]});
        }
    }
    Ok(state)
}

fn no_offer() -> crate::motor_native::Fault { fail("UPDATE_NOT_AVAILABLE", "No hay una entrega nueva disponible.") }
fn changed() -> crate::motor_native::Fault { fail("UPDATE_CANDIDATE_CHANGED", "Cambió la entrega. Consulta los cambios y vuelve a confirmar.") }
fn offer(root: &str) -> Result<Offer> {
    let state = state(root)?;
    if !state["phase"].as_str().is_some_and(|phase| OFFER_PHASES.contains(&phase)) || state["envelope"].is_null() { return Err(no_offer()); }
    let offer = Offer::verify(&Channel::load(root)?, &state["envelope"])?;
    if !offer.release.newer_than(&Release::read(&installed(root)?)?) { return Err(no_offer()); }
    Ok(offer)
}

fn notice(offer: &Offer) -> String {
    let name = offer.feed["novedades"]["nombre"].as_str().filter(|text| !text.trim().is_empty())
        .map(|name| format!(" ({name})")).unwrap_or_default();
    format!("Hay una nueva versión de Mind ({}){name}", offer.release.mind_version)
}
fn decisions(root: &str) -> Result<Value> {
    Ok(read_json(root, DECISIONS)?.filter(|d| d["format"] == "mind-actualizacion-decisiones"
        && d["version"] == 1 && d["avisadas"].is_object())
        .unwrap_or_else(|| json!({"format":"mind-actualizacion-decisiones","version":1,"pospuesta":null,"avisadas":{}})))
}
fn postponed(decisions: &Value, offer: &Offer) -> bool {
    decisions["pospuesta"]["entrega"] == offer.release.key()
        && millis(&decisions["pospuesta"]["hasta"]).is_some_and(|until| until > now_ms())
}
fn postpone(root: &str, days: i64) -> Result<Value> {
    let offer = offer(root)?;
    let days = if offer.feed["novedades"]["importancia"] == "seguridad" { 1 } else { days };
    let now = now_ms();
    let until = iso(now + days * DAY);
    let mut d = decisions(root)?;
    d["pospuesta"] = json!({"entrega":offer.release.key(),"hasta":until,"decidido":iso(now)});
    d["avisadas"] = json!({});
    put(root, DECISIONS, &d)?;
    Ok(json!({"estado":"pospuesta","version":offer.release.mind_version,"hasta":until,
        "indicacion":"Confirma hasta cuándo no se avisará de esta entrega."}))
}
fn take_notice(root: &str, slot: &str, session: bool) -> Result<Option<Value>> {
    let Ok(offer) = offer(root) else { return Ok(None); };
    let mut d = decisions(root)?;
    let now = now_ms();
    let key = offer.release.key();
    if postponed(&d, &offer) { return Ok(None); }
    let notices = d["avisadas"].as_object_mut().unwrap();
    notices.retain(|_, value| millis(&value["at"]).is_some_and(|at| now - at < 30 * DAY));
    if notices.get(slot).is_some_and(|value| value["entrega"] == key
        && (session || millis(&value["at"]).is_some_and(|at| now - at < DAY / 2))) { return Ok(None); }
    if notices.len() >= 500 {
        if let Some(old) = notices.iter().min_by_key(|(_, value)| millis(&value["at"])).map(|(key, _)| key.clone()) {
            notices.remove(&old);
        }
    }
    notices.insert(slot.into(), json!({"entrega":key,"at":iso(now)}));
    put(root, DECISIONS, &d)?;
    Ok(Some(json!({"texto":notice(&offer),"version":offer.release.mind_version,
        "revision":offer.release.package_revision,"nombre":offer.feed["novedades"]["nombre"],
        "importancia":offer.feed["novedades"]["importancia"].as_str().unwrap_or("normal"),
        "indicacion":"Responde a la petición antes de avisar. Solo la persona usuaria decide si se aplica."})))
}
