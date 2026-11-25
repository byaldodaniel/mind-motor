// Mind: el mapa vivo de la información del usuario.
// Una sola orden por llamada; responde y termina.

/// Escribe en la salida sin fallar si quien lee la cierra antes (por ejemplo, `| head`).
macro_rules! salida {
    ($($t:tt)*) => {{
        use std::io::Write;
        let _ = writeln!(std::io::stdout(), $($t)*);
    }};
}

mod buscar;
mod conexiones;
mod indice;
mod lugares;
mod texto;
mod vigilar;

use std::path::PathBuf;

pub type Resultado = Result<(), Box<dyn std::error::Error>>;

fn main() {
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    let mut raiz: Option<PathBuf> = std::env::var_os("MIND_RAIZ").map(PathBuf::from);
    if let Some(i) = args.iter().position(|a| a == "--raiz") {
        if i + 1 < args.len() {
            raiz = Some(PathBuf::from(args.remove(i + 1)));
        }
        args.remove(i);
    }
    let raiz = raiz.unwrap_or_else(raiz_por_defecto);
    // Los avisos del sistema identifican los lugares por sus rutas absolutas.
    let raiz = std::env::current_dir()
        .map(|cwd| lugares::limpiar(&cwd.join(&raiz)))
        .unwrap_or(raiz);
    let orden = args.first().cloned().unwrap_or_default();
    let resto: Vec<String> = args.into_iter().skip(1).collect();

    let r = match orden.as_str() {
        "indexar" => indice::indexar(&raiz),
        "buscar" => buscar::buscar(&raiz, &resto),
        "conexiones" => conexiones::conexiones(&raiz, &resto),
        "estado" => indice::estado(&raiz),
        "vigilar" => vigilar::vigilar(&raiz),
        _ => {
            ayuda();
            Ok(())
        }
    };
    if let Err(e) = r {
        eprintln!("Mind: {e}");
        std::process::exit(1);
    }
}

/// My Mind es la carpeta que contiene `Sistema/`, donde vive este ejecutable.
fn raiz_por_defecto() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent()?.parent().map(|p| p.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."))
}

fn ayuda() {
    salida!(
        "Mind 1.0.6\n\n\
         mind buscar <texto> [--limite N]   Dónde está: archivos cuyo nombre, ruta o contenido coincide.\n\
         mind conexiones [ruta]             Enlaces, quién apunta al archivo, rotos y probables.\n\
         mind indexar                       Pone al día el índice de My Mind y de lo que enlaza Inicio.md.\n\
         mind estado                        Lugares indexados, entradas y última actualización.\n\
         mind vigilar                       Mantiene el índice al día mientras corre."
    );
}
