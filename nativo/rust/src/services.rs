//! Trusted local administration for application processes. Public links only open the healthy app.
use std::{
    collections::HashMap,
    fs::{self, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
};

use http_body_util::{BodyExt, Limited};
use hyper::{body::Incoming, header, Method, Request, Response, StatusCode};
use serde::Deserialize;
use serde_json::{json, Value};
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};
use tokio::sync::{Mutex, Semaphore};
use uuid::Uuid;

use crate::{
    bridge::base_id,
    build_recipe::Recipe,
    host::{full, same, Body},
    service_process::ServiceProcess,
    view_cli::{directory, git_info, is_link, path_option, Git},
};

const MAX_SERVICES: usize = 4;
const MAX_REQUEST: usize = 16 * 1024;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Start {
    proyecto: String,
    copia: String,
    receta: String,
    autorizar: String,
}

struct Spec {
    project: String,
    copy_id: String,
    revision: Option<Git>,
    recipe: String,
}

impl Spec {
    fn describe(&self) -> Value {
        json!({
            "proyecto": self.project, "copia": self.copy_id, "git": self.revision, "receta": self.recipe,
        })
    }
}

struct Served {
    spec: Spec,
    database: PathBuf,
    process: ServiceProcess,
    version: u64,
}

pub(crate) const HOST_SECRET: &str = "servicios-secreto.json";
pub(crate) const MOTOR_SECRET: &str = "servicios-motor-secreto.json";

pub(crate) struct Services {
    credential: PathBuf,
    origin: String,
    authority: String,
    token: String,
    databases: PathBuf,
    client: reqwest::Client,
    records: Mutex<HashMap<Uuid, Served>>,
    starting: Semaphore,
}

impl Services {
    pub(crate) fn new(
        base: &Path, control_port: u16, public_port: u16, client: reqwest::Client, secret: &str,
    ) -> Result<Self, String> {
        let databases = directory(base)?.join("servicios-datos");
        let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
        let credential = base.join(secret);
        write_secret(base, &credential, control_port, public_port, &token)?;
        let authority = format!("127.0.0.1:{public_port}");
        Ok(Self {
            credential,
            origin: format!("http://{authority}"),
            authority,
            token,
            databases,
            client,
            records: Mutex::new(HashMap::new()),
            starting: Semaphore::new(2),
        })
    }

    pub(crate) fn authorized(&self, req: &Request<Incoming>) -> bool {
        req.headers().get(header::AUTHORIZATION).and_then(|value| value.to_str().ok())
            .and_then(|value| value.strip_prefix("Bearer "))
            .is_some_and(|token| same(token.as_bytes(), self.token.as_bytes()))
    }

    pub(crate) fn proof(&self, nonce: &str, base_id: &str, port: u16) -> String {
        let mut mac = Hmac::<Sha256>::new_from_slice(self.token.as_bytes()).expect("HMAC accepts any key length");
        mac.update(format!("mind-services-health-v1\n{nonce}\n{base_id}\n{port}").as_bytes());
        format!("{:x}", mac.finalize().into_bytes())
    }

    pub(crate) async fn busy(&self) -> bool {
        self.starting.available_permits() < 2 || !self.records.lock().await.is_empty()
    }

    pub(crate) async fn shutdown(&self) -> Result<(), String> {
        self.starting.close();
        let records = std::mem::take(&mut *self.records.lock().await);
        let stops = records.into_values().map(|served| served.process.stop());
        for result in futures_util::future::join_all(stops).await {
            result?;
        }
        Ok(())
    }

    fn database(&self, spec: &Spec) -> Result<PathBuf, String> {
        let digest = Sha256::digest(format!("mind-sqlite-v1\0{}\0{}", spec.project, spec.copy_id));
        match fs::create_dir(&self.databases) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(format!("No se pudo preparar el almacén SQLite: {error}")),
        }
        let target = directory(&self.databases)?.join(format!("{digest:x}.sqlite"));
        let mut settings = OpenOptions::new();
        settings.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            settings.mode(0o600);
        }
        match settings.open(&target) {
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                let regular = fs::symlink_metadata(&target)
                    .is_ok_and(|info| info.is_file() && !is_link(&info));
                if !regular {
                    return Err("El archivo SQLite asignado debe ser un archivo regular.".into());
                }
            }
            Err(error) => return Err(format!("No se pudo preparar el archivo SQLite: {error}")),
        }
        Ok(target)
    }

    fn metadata(&self, id: Uuid, served: &Served, health: bool) -> Value {
        json!({
            "id": id.to_string(),
            "url": format!("{}/app/{id}/", self.origin),
            "url_aplicacion": format!("http://127.0.0.1:{}/", served.process.port()),
            "proyecto": served.spec.project, "copia": served.spec.copy_id, "git": served.spec.revision,
            "receta": served.spec.recipe, "version": served.version,
            "pid": served.process.pid(), "sqlite": served.database,
            "salud": health, "recursos": served.process.resources(),
        })
    }

    async fn status(&self, id: Uuid) -> Option<Value> {
        let records = self.records.lock().await;
        let served = records.get(&id)?;
        let health = served.process.healthy(&self.client).await;
        Some(self.metadata(id, served, health))
    }

    pub(crate) async fn control(&self, req: Request<Incoming>) -> Response<Body> {
        if req.headers().contains_key(header::ORIGIN) {
            return error(StatusCode::FORBIDDEN, "SERVICE_ORIGIN_NOT_ALLOWED");
        }
        if !self.authorized(&req) {
            return error(StatusCode::UNAUTHORIZED, "SERVICE_UNAUTHORIZED");
        }
        if req.uri().path() == "/servicios" {
            return if req.method() == Method::POST {
                self.open(req, None).await
            } else {
                error(StatusCode::METHOD_NOT_ALLOWED, "METHOD_NOT_ALLOWED")
            };
        }
        let Some(id) = req.uri().path().strip_prefix("/servicios/").and_then(parse_id) else {
            return error(StatusCode::NOT_FOUND, "SERVICE_NOT_FOUND");
        };
        match *req.method() {
            Method::PUT => self.open(req, Some(id)).await,
            Method::GET => match self.status(id).await {
                Some(served) => full(StatusCode::OK, served),
                None => error(StatusCode::NOT_FOUND, "SERVICE_NOT_FOUND"),
            },
            Method::DELETE => {
                let served = self.records.lock().await.remove(&id);
                let Some(served) = served else {
                    return error(StatusCode::NOT_FOUND, "SERVICE_NOT_FOUND");
                };
                match served.process.stop().await {
                    Ok(()) => full(StatusCode::OK, json!({
                        "id": id.to_string(), "cerrada": true,
                        "recursos": {"procesos": 0, "memoria_bytes": 0},
                    })),
                    Err(motivo) => full(StatusCode::SERVICE_UNAVAILABLE, json!({
                        "error": "SERVICE_STOP_FAILED", "motivo": motivo,
                    })),
                }
            }
            _ => error(StatusCode::METHOD_NOT_ALLOWED, "METHOD_NOT_ALLOWED"),
        }
    }

    async fn open(&self, req: Request<Incoming>, id: Option<Uuid>) -> Response<Body> {
        let Ok(_slot) = self.starting.try_acquire() else {
            return error(StatusCode::TOO_MANY_REQUESTS, "SERVICE_START_BUSY");
        };
        let Ok(body) = Limited::new(req.into_body(), MAX_REQUEST).collect().await else {
            return error(StatusCode::PAYLOAD_TOO_LARGE, "SERVICE_REQUEST_TOO_LARGE");
        };
        let Ok(input) = serde_json::from_slice::<Start>(&body.to_bytes()) else {
            return error(StatusCode::BAD_REQUEST, "SERVICE_REQUEST_INVALID");
        };
        let (spec, copy, recipe) = match approve(input).await {
            Ok(approved) => approved,
            Err(motivo) => return full(StatusCode::BAD_REQUEST, json!({
                "error": "SERVICE_RECIPE_INVALID", "motivo": motivo,
            })),
        };

        // Read the version before the app starts. A healthy late result cannot replace a newer one.
        let previous = match self.expected_version(id, &spec).await {
            Ok(previous) => previous,
            Err((status, code)) => return error(status, code),
        };
        let database = match self.database(&spec) {
            Ok(path) => path,
            Err(motivo) => return self.failure(id, &spec, "fallo", motivo).await,
        };
        let process = match ServiceProcess::start(&recipe, &copy, &database, &self.client).await {
            Ok(process) => process,
            Err(motivo) => return self.failure(id, &spec, "fallo", motivo).await,
        };
        if !git_info(&copy).await.is_ok_and(|current| current == spec.revision) {
            let _ = process.stop().await;
            return self.failure(id, &spec, "desactualizada", "La copia cambió mientras arrancaba.".into()).await;
        }
        if !process.healthy(&self.client).await {
            let _ = process.stop().await;
            return self.failure(id, &spec, "fallo", "La aplicación dejó de responder antes de abrirse.".into()).await;
        }
        self.activate(id, previous, spec, database, process).await
    }

    async fn expected_version(
        &self, id: Option<Uuid>, spec: &Spec,
    ) -> Result<u64, (StatusCode, &'static str)> {
        let records = self.records.lock().await;
        if let Some(id) = id {
            let served = records.get(&id).ok_or((StatusCode::NOT_FOUND, "SERVICE_NOT_FOUND"))?;
            if served.spec.copy_id != spec.copy_id || served.spec.project != spec.project {
                return Err((StatusCode::CONFLICT, "SERVICE_COPY_CHANGED"));
            }
            Ok(served.version)
        } else if records.len() == MAX_SERVICES {
            Err((StatusCode::SERVICE_UNAVAILABLE, "SERVICE_CAPACITY_REACHED"))
        } else {
            Ok(0)
        }
    }

    async fn activate(
        &self, id: Option<Uuid>, previous: u64, spec: Spec, database: PathBuf, process: ServiceProcess,
    ) -> Response<Body> {
        let requested = spec.describe();
        let mut records = self.records.lock().await;
        let still_current = match id {
            Some(id) => records.get(&id).is_some_and(|record| record.version == previous),
            None => records.len() < MAX_SERVICES,
        };
        let next = previous.checked_add(1);
        if self.starting.is_closed() || !still_current || next.is_none() {
            drop(records);
            let _ = process.stop().await;
            return self.failure(id, &spec, "desactualizada", "La vista ya cambió o alcanzó su límite.".into()).await;
        }
        let view_id = id.unwrap_or_else(|| {
            let mut fresh = Uuid::new_v4();
            while records.contains_key(&fresh) {
                fresh = Uuid::new_v4();
            }
            fresh
        });
        let served = Served { spec, database, process, version: next.unwrap() };
        let metadata = self.metadata(view_id, &served, true);
        let retired = records.insert(view_id, served);
        drop(records);
        let mut report = json!({"estado": "abierta", "solicitada": requested, "servida": metadata});
        if let Some(retired) = retired {
            if let Err(motivo) = retired.process.stop().await {
                report["aviso_cierre_anterior"] = json!(motivo);
            }
        }
        let status = if id.is_some() { StatusCode::OK } else { StatusCode::CREATED };
        full(status, report)
    }

    async fn failure(&self, id: Option<Uuid>, spec: &Spec, state: &str, motivo: String) -> Response<Body> {
        let served = match id {
            Some(id) => self.status(id).await,
            None => None,
        };
        let status = if state == "desactualizada" { StatusCode::CONFLICT } else { StatusCode::UNPROCESSABLE_ENTITY };
        full(status, json!({
            "estado": state, "motivo": motivo, "solicitada": spec.describe(), "servida": served,
        }))
    }

    pub(crate) async fn open_link(&self, req: Request<Incoming>) -> Response<Body> {
        let hosts = req.headers().get_all(header::HOST);
        let host_ok = hosts.iter().count() == 1
            && req.headers().get(header::HOST).is_some_and(|value| value.as_bytes() == self.authority.as_bytes());
        let origins = req.headers().get_all(header::ORIGIN);
        let origin_ok = origins.iter().count() <= 1 && req.headers().get(header::ORIGIN)
            .is_none_or(|value| value.as_bytes() == self.origin.as_bytes());
        if !host_ok || !origin_ok {
            return error(StatusCode::FORBIDDEN, "SERVICE_ORIGIN_NOT_ALLOWED");
        }
        if !matches!(*req.method(), Method::GET | Method::HEAD) {
            return error(StatusCode::METHOD_NOT_ALLOWED, "METHOD_NOT_ALLOWED");
        }
        let Some(id) = req.uri().path().strip_prefix("/app/").and_then(|value| value.strip_suffix('/')).and_then(parse_id) else {
            return error(StatusCode::NOT_FOUND, "SERVICE_NOT_FOUND");
        };
        let records = self.records.lock().await;
        let Some(served) = records.get(&id) else {
            return error(StatusCode::NOT_FOUND, "SERVICE_NOT_FOUND");
        };
        if !served.process.healthy(&self.client).await {
            return error(StatusCode::SERVICE_UNAVAILABLE, "SERVICE_UNHEALTHY");
        }
        let mut response = full(StatusCode::TEMPORARY_REDIRECT, json!({}));
        response.headers_mut().insert(
            header::LOCATION, header::HeaderValue::from_str(
                &format!("http://127.0.0.1:{}/", served.process.port()),
            ).expect("valid loopback URL"),
        );
        response.headers_mut().insert(header::REFERRER_POLICY, header::HeaderValue::from_static("no-referrer"));
        response.headers_mut().insert(header::CACHE_CONTROL, header::HeaderValue::from_static("no-store"));
        response
    }
}

async fn approve(input: Start) -> Result<(Spec, PathBuf, Recipe), String> {
    let name = input.proyecto.trim();
    if name.is_empty() || name.len() > 512 || name.chars().any(char::is_control) {
        return Err("Indica el nombre del proyecto.".into());
    }
    let copy = directory(&path_option(Some(&input.copia))?)?;
    let file = path_option(Some(&input.receta))?;
    let recipe = Recipe::load(name, &copy, &file)?;
    recipe.authorize(&input.autorizar)?;
    let spec = Spec {
        project: name.to_owned(),
        copy_id: base_id(&copy).ok_or("No se pudo identificar la copia.")?,
        revision: git_info(&copy).await?,
        recipe: input.autorizar,
    };
    Ok((spec, copy, recipe))
}

fn parse_id(value: &str) -> Option<Uuid> {
    Uuid::parse_str(value).ok().filter(|id| id.to_string() == value)
}

fn error(status: StatusCode, code: &'static str) -> Response<Body> {
    full(status, json!({"error": code}))
}

impl Drop for Services {
    fn drop(&mut self) {
        if crate::bridge::regular_json(&self.credential).is_some_and(|value| value["token"] == self.token) {
            let _ = fs::remove_file(&self.credential);
        }
    }
}

fn write_secret(base: &Path, target: &Path, port: u16, view_port: u16, token: &str) -> Result<(), String> {
    let temporary = base.join(format!(".servicios-{}.tmp", Uuid::new_v4().simple()));
    let mut settings = OpenOptions::new();
    settings.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        settings.mode(0o600);
    }
    let result = (|| -> io::Result<()> {
        let mut file = settings.open(&temporary)?;
        let value = json!({"version":1,"port":port,"puertoVistas":view_port,"pid":std::process::id(),"token":token});
        file.write_all(value.to_string().as_bytes())?;
        drop(file);
        fs::rename(&temporary, target)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result.map_err(|error| format!("No se pudo preparar la entrada local de servicios: {error}"))
}
