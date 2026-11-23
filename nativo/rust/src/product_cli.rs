//! User-facing entry point of an installed native distribution.
use std::{path::{Path, PathBuf}, time::Duration};
use serde_json::{json, Value};
use crate::{bridge, motor_workspace::same_path, product_profiles, update_handoff as update,
    update_package::{self as package, *}};

struct Product { root: String, base: String, program: PathBuf, release: Release }
impl Product {
    fn open() -> Result<Self> {
        let program = std::env::current_exe().map_err(|error| fs_error("PRODUCT_NOT_INSTALLED", error))?;
        let root_path = program.ancestors().nth(5).ok_or_else(not_installed)?;
        let root = physical(root_path)?;
        if !same_path(&program.to_string_lossy(), &Path::new(&root).join(package::executable(&target()))) {
            return Err(not_installed());
        }
        let manifest = installed(&root)?;
        if manifest["runtime"] != "rust" || manifest["baseFormatVersion"] != 3 { return Err(not_installed()); }
        update::check_start(&root)?;
        let release = Release::read(&manifest)?;
        ensure(&root, "Sistema/Base")?;
        let base = physical(&Path::new(&root).join("Sistema/Base"))?;
        Ok(Self { root, base, program, release })
    }
    async fn connect(&self, client: &reqwest::Client) -> Result<bridge::Connector> {
        if let Some(existing) = bridge::healthy(Path::new(&self.base), client).await { return require_native(existing); }
        update::start_program(&self.root, &self.base)?;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
        while tokio::time::Instant::now() < deadline {
            if let Some(existing) = bridge::healthy(Path::new(&self.base), client).await { return require_native(existing); }
            tokio::time::sleep(Duration::from_millis(80)).await;
        }
        Err(fail("MOTOR_UNAVAILABLE", "El Motor Rust de esta Base no respondió."))
    }
}
fn not_installed() -> crate::motor_native::Fault {
    fail("PRODUCT_NOT_INSTALLED", "Ejecuta el iniciador de una instalación nativa de Mind.")
}
fn require_native(connection: bridge::Connector) -> Result<bridge::Connector> {
    if connection.health["backend"] != "rust" { return Err(fail("BASE_OWNERSHIP", "La Base tiene un Motor anterior activo.")); }
    Ok(connection)
}
fn cwd() -> Option<String> { std::env::current_dir().ok().and_then(|path| physical(&path).ok()) }

pub(crate) async fn run(args: &[String]) -> std::result::Result<(), String> {
    dispatch(args).await.map_err(|error| error.to_string())
}
const REGISTERED_VIEW: &str = "vista abrir --carpeta RUTA_O_ID [--ruta SUBCARPETA] [--proyecto NOMBRE] [--id UUID --version N] [--mantener-abierta | --no-mantener-abierta]";

fn command_help(command: &str) -> Result<()> {
    match command {
        "vista" => {
            println!("{REGISTERED_VIEW}\nvista mantener --id UUID --mantener-abierta | --no-mantener-abierta");
            println!("{}", crate::view_cli::USAGE.replace("--base ABS ", ""));
            println!("Abrir devuelve la URL y el ID. Usa ese ID para consultar, mantener o cerrar.");
        }
        "servicio" => println!("{}", crate::service_cli::USAGE.replace("--base ABS ", "")),
        "" => println!("Mind 1.0.5\ninicio, estado, herramienta NOMBRE JSON, despertar, apagar, preparar, mcp, autorizar, vista, servicio y version.\nUsa mind ayuda vista o mind ayuda servicio para ver sus opciones."),
        _ => return Err(fail("INVALID_ARGUMENTS", "Consulta mind ayuda para ver las órdenes disponibles.")),
    }
    Ok(())
}

fn registered_view(args: &[String]) -> Result<Option<Value>> {
    let Some((action, options)) = args.split_first() else { return Ok(None) };
    if !(action == "mantener" || (action == "abrir" && options.iter().any(|arg| arg == "--carpeta"))) {
        return Ok(None);
    }
    let mut fields = json!({"accion": action});
    let mut options = options.iter();
    while let Some(flag) = options.next() {
        let (key, value) = match flag.as_str() {
            "--mantener-abierta" | "--no-mantener-abierta" => ("mantener_abierta", json!(flag == "--mantener-abierta")),
            "--carpeta" | "--ruta" | "--proyecto" | "--id" | "--version" => {
                let raw = options.next().ok_or_else(|| fail("INVALID_ARGUMENTS", format!("Falta el valor de {flag}.")))?;
                let value = if flag == "--version" {
                    json!(raw.parse::<u64>().map_err(|_| fail("INVALID_ARGUMENTS", "Indica una versión numérica de vista."))?)
                } else { json!(raw) };
                (&flag[2..], value)
            }
            _ => return Err(fail("INVALID_ARGUMENTS", "Opción desconocida. Consulta mind ayuda vista.")),
        };
        if fields.get(key).is_some() { return Err(fail("INVALID_ARGUMENTS", format!("Opción repetida: {flag}."))); }
        fields[key] = value;
    }
    Ok(Some(fields))
}

async fn dispatch(args: &[String]) -> Result<()> {
    let operation = args.first().map(String::as_str).unwrap_or("inicio");
    let tail = args.get(1..).unwrap_or_default();
    if matches!(operation, "ayuda" | "--help" | "-h") {
        return match tail {
            [] => command_help(""),
            [topic] => command_help(topic),
            _ => Err(fail("INVALID_ARGUMENTS", "Usa mind ayuda [vista|servicio].")),
        };
    }
    if matches!(operation, "vista" | "servicio")
        && (tail.is_empty() || matches!(tail, [help] | [_, help] if matches!(help.as_str(), "ayuda" | "--help" | "-h")))
    {
        return command_help(operation);
    }
    let view = if operation == "vista" { registered_view(tail)? } else { None };
    let product = Product::open()?;
    if operation == "version" {
        println!("{}", json!({"mind":product.release.mind_version,"revision":product.release.package_revision,"motor":"rust","destino":target()}));
        return Ok(());
    }
    if operation == "preparar" {
        if args.len() != 1 { return Err(fail("INVALID_ARGUMENTS", "Usa preparar sin argumentos.")); }
        let answer = if std::env::var("MIND_AGENT_STARTUP").as_deref() == Ok("0") { json!({"estado":"omitido"}) }
            else { product_profiles::prepare(&product.root, &product.base, product_profiles::Mode::Explicit)? };
        println!("{answer}");
        return Ok(());
    }
    if operation == "mcp" {
        // Revisa las conexiones de los clientes sin retrasar al que acaba de lanzar este puente.
        let (root, base) = (product.root.clone(), product.base.clone());
        std::thread::spawn(move || product_profiles::heal(&root, &base));
        let scope = match &args[1..] {
            [flag, path] if flag == "--carpeta" => Some(physical(Path::new(path))?),
            [] => cwd(),
            _ => return Err(fail("INVALID_ARGUMENTS", "Usa mcp [--carpeta RUTA_ABSOLUTA].")),
        };
        let working = scope.clone().unwrap_or_else(|| product.root.clone());
        let paths = scope.into_iter().collect::<Vec<_>>();
        let mut bridge_args = vec!["--base".into(), product.base.clone(), "--cwd".into(), working,
            "--paths".into(), json!(paths).to_string(), "--launch-command".into(), product.program.to_string_lossy().into_owned(),
            "--motor-version".into(), product.release.mind_version.clone(), "--package-revision".into(),
            product.release.package_revision.to_string()];
        for arg in ["motor", "--base", &product.base, "--conector", "--raiz-instalacion", &product.root] {
            bridge_args.extend(["--launch-arg".into(), arg.to_owned()]);
        }
        return bridge::run(&bridge_args).await.map_err(|error| fs_error("MOTOR_UNAVAILABLE", error));
    }
    product_profiles::heal(&product.root, &product.base);
    let client = update::loopback()?;
    if operation == "apagar" {
        let answer = if let Some(existing) = bridge::healthy(Path::new(&product.base), &client).await {
            update::rpc(&client, &require_native(existing)?, &json!({"accion":"apagar","soloSiInactivo":true})).await?
        } else { json!({"ok":true,"estado":"apagado"}) };
        println!("{answer}");
        return Ok(());
    }
    if matches!(operation, "vista" | "servicio") && view.is_none() {
        let mut routed = args[1..].to_vec();
        if !matches!(routed.first().map(String::as_str), Some("receta")) {
            product.connect(&client).await?;
            if !routed.iter().any(|arg| arg == "--base") { routed.extend(["--base".into(), product.base.clone()]); }
        }
        return if operation == "vista" { crate::view_cli::run(&routed).await } else { crate::service_cli::run(&routed).await }
            .map_err(|error| fs_error("PRODUCT_COMMAND_FAILED", error));
    }
    let connection = product.connect(&client).await?;
    let answer = match (operation, tail) {
        ("despertar", []) => json!({"estado":"listo","pid":connection.health["pid"],"puerto":connection.port}),
        ("estado" | "inicio", []) => update::rpc(&client, &connection, &json!({"accion":operation,"cwd":cwd()})).await?,
        ("vista", _) => update::rpc(&client, &connection, &json!({"accion":"herramienta","tool":"vista","args":view,"cwd":cwd()})).await?,
        ("herramienta", [tool, raw]) => {
            let args: Value = serde_json::from_str(raw).map_err(|error| fs_error("INVALID_ARGUMENTS", error))?;
            update::rpc(&client, &connection, &json!({"accion":"herramienta","tool":tool,"args":args,"cwd":cwd()})).await?
        }
        ("autorizar", []) => authorize(&product, &client, &connection).await?,
        ("consola", [op, raw]) => console(&product, &client, &connection, op,
            serde_json::from_str(raw).map_err(|error| fs_error("INVALID_ARGUMENTS", error))?).await?,
        _ => return Err(fail("INVALID_ARGUMENTS", "Consulta mind ayuda para ver las órdenes disponibles.")),
    };
    if answer["isError"] == true || answer["ok"] == false {
        return Err(fail("PRODUCT_COMMAND_FAILED", answer.get("value").unwrap_or(&answer).to_string()));
    }
    println!("{}", if matches!(operation, "herramienta" | "estado" | "vista") { answer.get("value").unwrap_or(&answer) } else { &answer });
    Ok(())
}

async fn console(product: &Product, client: &reqwest::Client, connection: &bridge::Connector, op: &str, mut args: Value) -> Result<Value> {
    if !args.is_object() { return Err(fail("INVALID_ARGUMENTS", "Los argumentos de consola deben ser un objeto.")); }
    args["accion"] = json!("consola");
    args["operacion"] = json!(op);
    let token = read_json(&product.base, "conector-consola.json")?.filter(|data| data["version"] == 1)
        .and_then(|data| data["token"].as_str().map(str::to_owned))
        .ok_or_else(|| fail("CONSOLE_CREDENTIAL_REQUIRED", "No se pudo leer la credencial administrativa local."))?;
    let reply = client.post(format!("http://127.0.0.1:{}/rpc", connection.port)).bearer_auth(&connection.token)
        .header("X-Mind-Consola", token).json(&args).send().await.and_then(reqwest::Response::error_for_status)
        .map_err(|error| fs_error("MOTOR_UNAVAILABLE", error))?;
    serde_json::from_slice(&update::bounded(reply, 16 * 1024 * 1024).await?).map_err(|error| fs_error("MOTOR_UNAVAILABLE", error))
}

async fn authorize(product: &Product, client: &reqwest::Client, connection: &bridge::Connector) -> Result<Value> {
    use std::io::{self, Write};
    let result = console(product, client, connection, "listar_solicitudes", json!({})).await?;
    let Some(requests) = result["solicitudes"].as_array() else { return Ok(result); };
    for request in requests {
        let kind = request["kind"].as_str().or_else(|| request["type"].as_str()).unwrap_or_default();
        let details = request.get("request").unwrap_or(request);
        let folder = details["path"].as_str().or(details["ruta"].as_str());
        let permissions = &details["permissions"];
        if !permissions.is_array() || (folder.is_none() && !matches!(kind, "continuidad" | "continuity")) {
            println!("Revisión manual de la solicitud {} desde la consola local.", request["id"]);
            continue;
        }
        print!("{}\nEscribe SI para conceder exactamente esos permisos: ", request);
        io::stdout().flush().map_err(|error| fs_error("CONSOLE_UNAVAILABLE", error))?;
        let mut answer = String::new();
        io::stdin().read_line(&mut answer).map_err(|error| fs_error("CONSOLE_UNAVAILABLE", error))?;
        if answer.trim() != "SI" { continue; }
        let reply = if let Some(path) = folder {
            let granted = console(product, client, connection, "autorizar_carpeta", json!({"ruta":path})).await?;
            if granted["ok"] != true { return Ok(granted); }
            console(product, client, connection, "guardar_acceso", json!({"id":granted["carpeta"]["id"],"permisos":permissions,"canal":"consola"})).await?
        } else {
            console(product, client, connection, "guardar_continuidad", json!({"permisos":permissions,"canal":"consola"})).await?
        };
        if reply["ok"] != true { return Ok(reply); }
        console(product, client, connection, "retirar_solicitud", json!({"id":request["id"]})).await?;
    }
    Ok(json!({"estado":"revisadas"}))
}
