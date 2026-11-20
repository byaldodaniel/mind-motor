mod bridge;
mod host;
mod scan;
mod view_cli;
mod views;
use std::io::{self, BufRead, Write};
use serde_json::{json,Value};
const MAX_MESSAGE: usize = 16 * 1024 * 1024;
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result = match args.first().map(String::as_str) {
        Some("scan") => scanner(),
        Some("bridge") => tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build()
            .map_err(|e|e.to_string()).and_then(|rt|rt.block_on(bridge::run(&args[1..]))),
        Some("anfitrion") => tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build()
            .map_err(|e|e.to_string()).and_then(|rt|rt.block_on(host::run(&args[1..]))),
        Some("vista") => tokio::runtime::Builder::new_current_thread().enable_all().build()
            .map_err(|e| e.to_string()).and_then(|rt| rt.block_on(view_cli::run(&args[1..]))),
        Some("version") => {println!("mind-native-rust-pilot 0.1.0"); Ok(())},
        _ => Err("usage: mind-native-rust-pilot bridge --base ABS --cwd ABS --paths JSON --launch-command ABS [--launch-arg ARG] | scan | anfitrion --base ABS [--port N] [--puerto-vistas N] | vista abrir|consultar|cerrar".into())
    };
    if let Err(error) = result {eprintln!("{error}");std::process::exit(2)}
}
fn scanner() -> Result<(),String> {
    let mut input=io::stdin().lock();
    let mut output=io::stdout().lock();
    let mut buffer=Vec::new();
    loop {
        buffer.clear();
        let mut oversized=false;
        loop {
            let available=input.fill_buf().map_err(|e|e.to_string())?;
            if available.is_empty(){break}
            let n=available.iter().position(|b|*b==b'\n').map(|x|x+1).unwrap_or(available.len());
            if buffer.len()+n>MAX_MESSAGE {oversized=true} else if !oversized{buffer.extend_from_slice(&available[..n])}
            let end=available[n-1]==b'\n'; input.consume(n); if end{break}
        }
        if buffer.is_empty()&&!oversized{break}
        let reply=if oversized {json!({"id":null,"entries":[],"complete":false,"error":{"code":"MESSAGE_TOO_LARGE","message":"JSONL frame exceeds 16 MiB"}})}
        else {match serde_json::from_slice::<Value>(&buffer) {
            Ok(request)=>scan::handle(request),
            Err(_)=>json!({"id":null,"entries":[],"complete":false,"error":{"code":"INVALID_JSON","message":"Expected a JSON object"}})
        }};
        serde_json::to_writer(&mut output,&reply).map_err(|e|e.to_string())?;
        output.write_all(b"\n").and_then(|_|output.flush()).map_err(|e|e.to_string())?;
    }
    Ok(())
}
