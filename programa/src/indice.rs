// El Índice: catálogo de rutas y palabras de cada archivo de texto, en la Base.
// La Base no guarda copias de los archivos; si se borra, se reconstruye desde ellos.

use crate::{conexiones, texto, Resultado};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const VERSION_BASE: i64 = 3;

const ESQUEMA: &str = "
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA cache_size = -2000;
CREATE TABLE IF NOT EXISTS archivos (
  id INTEGER PRIMARY KEY,
  ruta TEXT NOT NULL UNIQUE,
  lugar TEXT NOT NULL,
  carpeta INTEGER NOT NULL,
  tamano INTEGER NOT NULL,
  fecha INTEGER NOT NULL,
  pendiente INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS archivos_lugar ON archivos(lugar);
CREATE INDEX IF NOT EXISTS archivos_ruta_nocase ON archivos(ruta COLLATE NOCASE);
CREATE VIRTUAL TABLE IF NOT EXISTS rutas USING fts5(
  nombre, ruta,
  content = '', contentless_delete = 1,
  tokenize = 'unicode61 remove_diacritics 2'
);
CREATE VIRTUAL TABLE IF NOT EXISTS palabras USING fts5(
  nombre, ruta, texto,
  content = '', contentless_delete = 1,
  tokenize = 'unicode61 remove_diacritics 2'
);
CREATE TABLE IF NOT EXISTS enlaces (
  origen_id INTEGER NOT NULL,
  tipo TEXT NOT NULL,
  destino TEXT NOT NULL,
  destino_clave TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS enlaces_origen ON enlaces(origen_id);
CREATE INDEX IF NOT EXISTS enlaces_destino ON enlaces(tipo, destino_clave);
CREATE TABLE IF NOT EXISTS lugares (
  ruta TEXT PRIMARY KEY,
  entradas INTEGER NOT NULL,
  actualizado INTEGER NOT NULL,
  segundos REAL NOT NULL
);
";

/// Carpetas que son ruido técnico: se generan solas y nadie las busca.
const EXCLUIR: &[&str] = &[
    "node_modules", "target", "__pycache__", "venv", "bower_components",
    "$RECYCLE.BIN", "System Volume Information",
];

const LOTE: usize = 2000;
/// Lecturas de contenido a la vez.
pub const HILOS: usize = 32;

#[derive(Clone)]
pub struct Pendiente {
    pub id: i64,
    pub ruta: String,
    pub tamano: i64,
    pub fecha: i64,
    pub pendiente: i64,
}

pub fn ruta_base(raiz: &Path) -> PathBuf {
    raiz.join("Sistema").join("Base").join("mapa.sqlite")
}

pub fn abrir(raiz: &Path) -> Result<Connection, Box<dyn std::error::Error>> {
    let ruta = ruta_base(raiz);
    fs::create_dir_all(ruta.parent().expect("la Base tiene carpeta"))?;
    let c = Connection::open(ruta)?;
    c.busy_timeout(Duration::from_secs(10))?;
    c.execute_batch(ESQUEMA)?;
    let tiene_pendiente: bool = c
        .prepare("SELECT 1 FROM pragma_table_info('archivos') WHERE name = 'pendiente'")?
        .exists([])?;
    if !tiene_pendiente {
        c.execute_batch("ALTER TABLE archivos ADD COLUMN pendiente INTEGER NOT NULL DEFAULT 0")?;
    }
    c.execute_batch("CREATE INDEX IF NOT EXISTS archivos_pendiente ON archivos(lugar) WHERE pendiente = 1")?;
    let version: i64 = c.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if version < 1 {
        migrar_rutas(&c)?;
    }
    let version: i64 = c.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if version < VERSION_BASE {
        migrar_enlaces(&c)?;
    }
    Ok(c)
}

pub fn necesita_actualizar(c: &Connection) -> bool {
    c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
        .map(|v| v < VERSION_BASE)
        .unwrap_or(false)
}

/// Reconstruye solo la tabla `rutas` en Bases anteriores sin tocar `palabras` ni releer contenido.
fn migrar_rutas(c: &Connection) -> rusqlite::Result<()> {
    c.execute_batch("BEGIN IMMEDIATE")?;
    let r = (|| -> rusqlite::Result<()> {
        let version: i64 = c.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        if version >= 1 {
            return Ok(());
        }
        c.execute_batch(
            "DROP TABLE IF EXISTS rutas;
             CREATE VIRTUAL TABLE rutas USING fts5(
               nombre, ruta,
               content = '', contentless_delete = 1,
               tokenize = 'unicode61 remove_diacritics 2'
             );",
        )?;
        let mut q = c.prepare("SELECT id, ruta, lugar FROM archivos")?;
        let mut poner = c.prepare("INSERT INTO rutas (rowid, nombre, ruta) VALUES (?1, ?2, ?3)")?;
        let mut filas = q.query([])?;
        while let Some(fila) = filas.next()? {
            let id: i64 = fila.get(0)?;
            let ruta: String = fila.get(1)?;
            let lugar: String = fila.get(2)?;
            let (nombre, padre) = nombre_y_padre(Path::new(&ruta), Path::new(&lugar));
            poner.execute(params![id, nombre, padre])?;
        }
        drop(filas);
        drop(q);
        drop(poner);
        c.execute_batch("PRAGMA user_version = 1;")?;
        Ok(())
    })();
    match r {
        Ok(()) => c.execute_batch("COMMIT"),
        Err(e) => {
            let _ = c.execute_batch("ROLLBACK");
            Err(e)
        }
    }
}

/// Marca solo los Markdown ya leídos para extraer sus enlaces en segundo plano sin releer el resto.
fn migrar_enlaces(c: &Connection) -> rusqlite::Result<()> {
    c.execute_batch("BEGIN IMMEDIATE")?;
    let r = (|| -> rusqlite::Result<()> {
        let version: i64 = c.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        if version >= VERSION_BASE {
            return Ok(());
        }
        c.execute_batch(&format!(
            "UPDATE archivos SET pendiente = 2
             WHERE carpeta = 0 AND pendiente = 0
               AND lower(ruta) LIKE '%.md'
               AND tamano <= {};
             PRAGMA user_version = {VERSION_BASE};",
            texto::MAX_TEXTO
        ))?;
        Ok(())
    })();
    match r {
        Ok(()) => c.execute_batch("COMMIT"),
        Err(e) => {
            let _ = c.execute_batch("ROLLBACK");
            Err(e)
        }
    }
}

/// Abre una Base ya existente en modo de solo consulta sin crear archivos ni esquema.
pub fn abrir_lectura(raiz: &Path) -> rusqlite::Result<Connection> {
    let ruta = ruta_base(raiz);
    let c = Connection::open_with_flags(
        ruta,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    c.busy_timeout(Duration::from_secs(10))?;
    c.execute_batch("PRAGMA query_only = ON; PRAGMA cache_size = -2000;")?;
    Ok(c)
}

pub fn hay_catalogo(raiz: &Path) -> bool {
    if !ruta_base(raiz).exists() {
        return false;
    }
    let Ok(c) = abrir_lectura(raiz) else { return false };
    c.query_row("SELECT 1 FROM lugares LIMIT 1", [], |r| r.get::<_, i64>(0))
        .optional()
        .ok()
        .flatten()
        .is_some()
}

pub fn pendientes_por_leer(c: &Connection) -> rusqlite::Result<i64> {
    c.query_row("SELECT count(*) FROM archivos WHERE pendiente = 1", [], |r| r.get(0))
}

pub fn lugares_pendientes(c: &Connection) -> rusqlite::Result<HashSet<String>> {
    let mut q = c.prepare("SELECT DISTINCT lugar FROM archivos WHERE pendiente = 1")?;
    let filas = q.query_map([], |r| r.get::<_, String>(0))?;
    filas.collect()
}

pub fn compactar_memoria(c: &Connection) {
    let _ = c.execute_batch("PRAGMA wal_checkpoint(PASSIVE); PRAGMA shrink_memory;");
}

fn ahora() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

pub fn indexar(raiz: &Path) -> Resultado {
    if crate::vigilar::activo(raiz) {
        salida!("El vigilante ya mantiene el índice al día.");
        return Ok(());
    }
    let primera_vez = !hay_catalogo(raiz);
    crate::vigilar::encender(raiz)?;
    if primera_vez {
        let inicio_espera = Instant::now();
        while !hay_catalogo(raiz) && inicio_espera.elapsed() < Duration::from_secs(10) {
            std::thread::sleep(Duration::from_millis(80));
        }
    }
    if hay_catalogo(raiz) {
        salida!("Índice al día; el vigilante quedó en marcha.");
    } else {
        salida!("Mind está indexando por primera vez; el vigilante sigue en segundo plano.");
    }
    Ok(())
}

/// Lo que ya no enlaza Inicio.md sale del índice.
pub fn quitar_lugares_viejos(c: &Connection, lugares: &[PathBuf], log: &mut dyn FnMut(&str)) -> Resultado {
    let claves: HashSet<String> = lugares.iter().map(|p| p.to_string_lossy().into_owned()).collect();
    let anteriores: Vec<String> = c
        .prepare("SELECT ruta FROM lugares")?
        .query_map([], |r| r.get(0))?
        .collect::<Result<_, _>>()?;
    for viejo in anteriores.iter().filter(|v| !claves.contains(*v)) {
        c.execute_batch("BEGIN")?;
        c.execute("DELETE FROM rutas WHERE rowid IN (SELECT id FROM archivos WHERE lugar = ?1)", [viejo])?;
        c.execute("DELETE FROM palabras WHERE rowid IN (SELECT id FROM archivos WHERE lugar = ?1)", [viejo])?;
        c.execute("DELETE FROM enlaces WHERE origen_id IN (SELECT id FROM archivos WHERE lugar = ?1)", [viejo])?;
        c.execute("DELETE FROM archivos WHERE lugar = ?1", [viejo])?;
        c.execute("DELETE FROM lugares WHERE ruta = ?1", [viejo])?;
        c.execute_batch("COMMIT")?;
        log(&format!("Fuera del índice: {viejo}"));
    }
    Ok(())
}

/// ¿Esta ruta del lugar entra en el índice? Fuera: `Sistema/`, ocultos y ruido técnico.
pub fn entra(lugar: &Path, ruta: &Path, sistema: &Path) -> bool {
    if ruta.starts_with(sistema) {
        return false;
    }
    let Ok(rel) = ruta.strip_prefix(lugar) else { return false };
    rel.components().all(|c| {
        let n = c.as_os_str().to_string_lossy();
        !n.starts_with('.') && !n.starts_with("~$") && !EXCLUIR.iter().any(|x| x.eq_ignore_ascii_case(&n))
    })
}

pub fn en_indice(c: &Connection, ruta: &Path) -> rusqlite::Result<bool> {
    c.query_row("SELECT 1 FROM archivos WHERE ruta = ?1", [ruta.to_string_lossy()], |_| Ok(()))
        .optional()
        .map(|r| r.is_some())
}

#[derive(Default)]
struct Cambios {
    entradas: usize,
    nuevos: usize,
    cambiados: usize,
    pendientes: usize,
}

fn fila(r: &rusqlite::Row) -> rusqlite::Result<(String, (i64, i64, i64))> {
    Ok((r.get(0)?, (r.get(1)?, r.get(2)?, r.get(3)?)))
}

/// Paso 1: actualiza el catálogo (nombres y rutas) de `sub` dentro de `lugar`.
/// Deja los archivos de texto nuevos o cambiados marcados con `pendiente = 1`.
pub fn catalogar(
    c: &Connection,
    lugar: &Path,
    sub: &Path,
    sistema: &Path,
    log: &mut dyn FnMut(&str),
) -> Resultado {
    let t0 = Instant::now();
    let clave = lugar.to_string_lossy().into_owned();
    let completo = sub == lugar;
    let ruta_sub = sub.to_string_lossy().into_owned();
    let mut previos: HashMap<String, (i64, i64, i64)> = HashMap::new();
    {
        let filas = if completo {
            let mut q = c.prepare("SELECT ruta, id, tamano, fecha FROM archivos WHERE lugar = ?1")?;
            let v = q.query_map([&clave], fila)?.collect::<Vec<_>>();
            v
        } else {
            // Ella misma y todo lo que cuelga de ella: rutas entre «sub\» y «sub]».
            let sep = std::path::MAIN_SEPARATOR;
            let tope = char::from_u32(sep as u32 + 1).expect("carácter válido");
            let mut q = c.prepare(
                "SELECT ruta, id, tamano, fecha FROM archivos WHERE ruta = ?1 OR (ruta > ?2 AND ruta < ?3)",
            )?;
            let v = q
                .query_map(params![ruta_sub, format!("{ruta_sub}{sep}"), format!("{ruta_sub}{tope}")], fila)?
                .collect::<Vec<_>>();
            v
        };
        for f in filas {
            let (ruta, datos) = f?;
            previos.insert(ruta, datos);
        }
    }

    let mut cambios = Cambios::default();
    let mut error: Option<rusqlite::Error> = None;
    c.execute_batch("BEGIN")?;
    {
        let mut nuevo = c.prepare(
            "INSERT INTO archivos (ruta, lugar, carpeta, tamano, fecha, pendiente) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             RETURNING id",
        )?;
        let mut cambio = c.prepare("UPDATE archivos SET tamano = ?2, fecha = ?3, pendiente = ?4 WHERE id = ?1")?;
        let mut quitar_ruta = c.prepare("DELETE FROM rutas WHERE rowid = ?1")?;
        let mut quitar_texto = c.prepare("DELETE FROM palabras WHERE rowid = ?1")?;
        let mut quitar_enlaces = c.prepare("DELETE FROM enlaces WHERE origen_id = ?1")?;
        let mut poner_ruta = c.prepare("INSERT INTO rutas (rowid, nombre, ruta) VALUES (?1, ?2, ?3)")?;

        let mut anotar = |p: &Path, md: &fs::Metadata, carpeta: bool| -> rusqlite::Result<()> {
            cambios.entradas += 1;
            let ruta = p.to_string_lossy().into_owned();
            let tamano = if carpeta { 0 } else { md.len() as i64 };
            let fecha = md
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);
            let por_leer = !carpeta && texto::es_texto(p) && (tamano as u64) <= texto::MAX_TEXTO;
            let id = match previos.remove(&ruta) {
                Some((_, t, f)) if t == tamano && f == fecha => return Ok(()),
                Some((id, _, _)) => {
                    cambio.execute(params![id, tamano, fecha, por_leer as i64])?;
                    quitar_ruta.execute([id])?;
                    quitar_texto.execute([id])?;
                    quitar_enlaces.execute([id])?;
                    cambios.cambiados += 1;
                    id
                }
                None => {
                    cambios.nuevos += 1;
                    nuevo.query_row(params![ruta, clave, carpeta as i64, tamano, fecha, por_leer as i64], |r| {
                        r.get::<_, i64>(0)
                    })?
                }
            };
            let (nombre, padre) = nombre_y_padre(p, lugar);
            poner_ruta.execute(params![id, nombre, padre])?;
            cambios.pendientes += 1;
            if cambios.pendientes >= LOTE {
                c.execute_batch("COMMIT; BEGIN")?;
                cambios.pendientes = 0;
            }
            Ok(())
        };

        let mut cada = |p: &Path, md: &fs::Metadata, carpeta: bool| {
            if error.is_none() {
                if let Err(e) = anotar(p, md, carpeta) {
                    error = Some(e);
                }
            }
        };
        if !completo {
            if let Ok(md) = fs::metadata(sub) {
                if md.is_dir() {
                    cada(sub, &md, true);
                }
            }
        }
        recorrer(sub, sistema, &mut cada);
    }
    if let Some(e) = error {
        let _ = c.execute_batch("ROLLBACK");
        return Err(e.into());
    }

    let borrados = previos.len();
    for (_, (id, _, _)) in previos {
        c.execute("DELETE FROM rutas WHERE rowid = ?1", [id])?;
        c.execute("DELETE FROM palabras WHERE rowid = ?1", [id])?;
        c.execute("DELETE FROM enlaces WHERE origen_id = ?1", [id])?;
        c.execute("DELETE FROM archivos WHERE id = ?1", [id])?;
    }
    let catalogo = t0.elapsed().as_secs_f64();
    if completo {
        c.execute(
            "INSERT OR REPLACE INTO lugares (ruta, entradas, actualizado, segundos) VALUES (?1, ?2, ?3, ?4)",
            params![clave, cambios.entradas as i64, ahora(), catalogo],
        )?;
    } else {
        c.execute("UPDATE lugares SET actualizado = ?2 WHERE ruta = ?1", params![clave, ahora()])?;
    }
    c.execute_batch("COMMIT")?;
    if completo {
        log(&format!(
            "{clave}: catálogo de {} entradas · {} nuevas · {} cambiadas · {} borradas · {:.1} s",
            cambios.entradas, cambios.nuevos, cambios.cambiados, borrados, catalogo
        ));
    } else if cambios.nuevos + cambios.cambiados + borrados > 0 {
        log(&format!(
            "{ruta_sub}: {} nuevas · {} cambiadas · {} borradas",
            cambios.nuevos, cambios.cambiados, borrados
        ));
    }
    Ok(())
}

/// El nombre, el último nombre del lugar y las carpetas internas.
/// La ruta previa al lugar («Mi unidad», «Users») no cuenta, para no coincidir con todo.
pub(crate) fn nombre_y_padre(p: &Path, lugar: &Path) -> (String, String) {
    let nombre = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    if p == lugar {
        return (nombre, String::new());
    }
    let raiz_lugar = lugar.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let rel = p
        .parent()
        .and_then(|d| d.strip_prefix(lugar).ok())
        .map(|d| d.to_string_lossy().into_owned())
        .unwrap_or_default();
    let padre = match (raiz_lugar.is_empty(), rel.is_empty()) {
        (true, _) => rel,
        (false, true) => raiz_lugar,
        (false, false) => format!("{raiz_lugar}{}{rel}", std::path::MAIN_SEPARATOR),
    };
    (nombre, padre)
}

/// Siguiente tanda de archivos de texto por leer, los más recientes primero.
pub fn siguientes_pendientes(c: &Connection, limite: usize) -> rusqlite::Result<Vec<Pendiente>> {
    let mut q = c.prepare(
        "SELECT id, ruta, tamano, fecha, pendiente FROM archivos WHERE pendiente IN (1, 2) ORDER BY pendiente ASC, fecha DESC LIMIT ?1",
    )?;
    let filas = q.query_map([limite as i64], |r| {
        Ok(Pendiente {
            id: r.get(0)?,
            ruta: r.get(1)?,
            tamano: r.get(2)?,
            fecha: r.get(3)?,
            pendiente: r.get(4)?,
        })
    })?;
    filas.collect()
}

/// Anota en una sola transacción corta los contenidos y enlaces leídos, verificando que el archivo no cambió mientras tanto.
pub fn guardar_lote_contenido(
    c: &Connection,
    lote: &[(Pendiente, Option<String>)],
) -> rusqlite::Result<(usize, usize, usize)> {
    if lote.is_empty() {
        return Ok((0, 0, 0));
    }
    let mut quitar = c.prepare("DELETE FROM palabras WHERE rowid = ?1")?;
    let mut poner = c.prepare("INSERT INTO palabras (rowid, nombre, ruta, texto) VALUES (?1, '', '', ?2)")?;
    let mut quitar_enlaces = c.prepare("DELETE FROM enlaces WHERE origen_id = ?1")?;
    let mut poner_enlace = c.prepare(
        "INSERT INTO enlaces (origen_id, tipo, destino, destino_clave) VALUES (?1, ?2, ?3, ?4)",
    )?;
    let mut hecho = c.prepare(
        "UPDATE archivos SET pendiente = 0 WHERE id = ?1 AND pendiente = ?4 AND tamano = ?2 AND fecha = ?3",
    )?;
    let mut leidos_contenido = 0usize;
    let mut leidos_enlaces = 0usize;
    let mut anotados = 0usize;
    c.execute_batch("BEGIN")?;
    for (p, contenido) in lote {
        let filas = hecho.execute(params![p.id, p.tamano, p.fecha, p.pendiente])?;
        if filas == 0 {
            continue;
        }
        anotados += 1;
        if let Some(contenido) = contenido {
            if p.pendiente == 1 {
                quitar.execute([p.id])?;
                poner.execute(params![p.id, contenido])?;
                leidos_contenido += 1;
            } else if p.pendiente == 2 {
                leidos_enlaces += 1;
            }
            quitar_enlaces.execute([p.id])?;
            for e in conexiones::extraer(Path::new(&p.ruta), contenido) {
                poner_enlace.execute(params![p.id, e.tipo, e.destino, e.destino_clave])?;
            }
        }
    }
    c.execute_batch("COMMIT")?;
    Ok((leidos_contenido, leidos_enlaces, anotados))
}

/// Recorre un lugar sin seguir accesos directos ni entrar en ruido técnico ni en `Sistema/`.
fn recorrer(lugar: &Path, sistema: &Path, f: &mut dyn FnMut(&Path, &fs::Metadata, bool)) {
    let Ok(md) = fs::metadata(lugar) else { return };
    if md.is_file() {
        f(lugar, &md, false);
        return;
    }
    let mut pila = vec![lugar.to_path_buf()];
    while let Some(dir) = pila.pop() {
        let Ok(entradas) = fs::read_dir(&dir) else { continue };
        for e in entradas.flatten() {
            let nombre = e.file_name();
            let nombre = nombre.to_string_lossy();
            if nombre.starts_with('.') || nombre.starts_with("~$") {
                continue;
            }
            let Ok(tipo) = e.file_type() else { continue };
            if tipo.is_symlink() {
                continue;
            }
            let p = e.path();
            let Ok(md) = e.metadata() else { continue };
            if tipo.is_dir() {
                if p == sistema || EXCLUIR.iter().any(|x| x.eq_ignore_ascii_case(&nombre)) {
                    continue;
                }
                f(&p, &md, true);
                pila.push(p);
            } else {
                f(&p, &md, false);
            }
        }
    }
}

pub fn estado(raiz: &Path) -> Resultado {
    let base = ruta_base(raiz);
    if !base.exists() {
        salida!("Sin índice todavía. Ejecuta: mind indexar");
        return Ok(());
    }
    let mut c = abrir_lectura(raiz)?;
    if necesita_actualizar(&c) {
        drop(c);
        let _ = abrir(raiz)?;
        c = abrir_lectura(raiz)?;
    }
    let mut q = c.prepare("SELECT ruta, entradas, actualizado, segundos FROM lugares ORDER BY ruta")?;
    let filas = q.query_map([], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?, r.get::<_, f64>(3)?))
    })?;
    for f in filas {
        let (ruta, entradas, actualizado, segundos) = f?;
        let hace = (ahora() - actualizado).max(0);
        salida!("{ruta}: {entradas} entradas · actualizado hace {} · {:.1} s", tiempo(hace), segundos);
    }
    let total: i64 = c.query_row("SELECT count(*) FROM archivos", [], |r| r.get(0))?;
    let por_leer: i64 = c.query_row("SELECT count(*) FROM archivos WHERE pendiente = 1", [], |r| r.get(0))?;
    if por_leer > 0 {
        salida!("Contenido por leer: {por_leer} archivos de texto (se buscan ya por nombre y ruta).");
    }
    let tamano = fs::metadata(&base).map(|m| m.len()).unwrap_or(0)
        + fs::metadata(base.with_extension("sqlite-wal")).map(|m| m.len()).unwrap_or(0);
    let sin_lugares: Option<i64> = c.query_row("SELECT 1 FROM lugares LIMIT 1", [], |r| r.get(0)).optional()?;
    if sin_lugares.is_none() {
        salida!("Sin lugares indexados. Ejecuta: mind indexar");
    }
    let (total_enlaces, total_rotos) = conexiones::resumen(&c)?;
    salida!("Enlaces: {total_enlaces} · Rotos: {total_rotos}");
    salida!("Total: {total} entradas · Base de {:.1} MB", tamano as f64 / 1_048_576.0);
    Ok(())
}

fn tiempo(s: i64) -> String {
    match s {
        0..=59 => format!("{s} s"),
        60..=3599 => format!("{} min", s / 60),
        3600..=86399 => format!("{} h", s / 3600),
        _ => format!("{} días", s / 86400),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempDir(PathBuf);
    impl TempDir {
        fn nuevo(nombre: &str) -> Self {
            let n = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
            let p = std::env::temp_dir().join(format!("mind-indice-{nombre}-{n}"));
            fs::create_dir_all(&p).unwrap();
            Self(p)
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn filtra_sistema_ocultos_y_ruido() {
        let lugar = Path::new("C:/Prueba/My Mind");
        let sistema = lugar.join("Sistema");
        assert!(entra(lugar, &lugar.join("Inicio.md"), &sistema));
        assert!(entra(lugar, &lugar.join("Notas").join("idea.md"), &sistema));
        assert!(!entra(lugar, &sistema.join("Base").join("mapa.sqlite"), &sistema));
        assert!(!entra(lugar, &lugar.join(".git").join("HEAD"), &sistema));
        assert!(!entra(lugar, &lugar.join(".venv").join("pyvenv.cfg"), &sistema));
        assert!(!entra(lugar, &lugar.join("~$borrador.docx"), &sistema));
        assert!(!entra(lugar, &lugar.join("web").join("node_modules").join("a.js"), &sistema));
        assert!(!entra(lugar, &lugar.join("rust").join("target").join("debug"), &sistema));
        assert!(!entra(Path::new("C:/Otro"), &lugar.join("Inicio.md"), &sistema));
    }

    #[test]
    fn nombre_y_padre_incluye_ultimo_nombre_del_lugar() {
        let proyectox = Path::new("D:/PROYECTOX");
        assert_eq!(
            nombre_y_padre(&proyectox.join("Sitio web"), proyectox),
            ("Sitio web".to_string(), "PROYECTOX".to_string())
        );
        assert_eq!(
            nombre_y_padre(&proyectox.join("Sitio web").join("Copia").join("index.html"), proyectox),
            ("index.html".to_string(), format!("PROYECTOX{}Sitio web{}Copia", std::path::MAIN_SEPARATOR, std::path::MAIN_SEPARATOR))
        );
        let drive = Path::new("G:/Mi unidad/Ana Torres");
        assert_eq!(
            nombre_y_padre(&drive.join("Perfil de Ana Torres.md"), drive),
            ("Perfil de Ana Torres.md".to_string(), "Ana Torres".to_string())
        );
        let cooperativa = Path::new("C:/Users/Ana Torres/Desktop/COOPERATIVA");
        assert_eq!(
            nombre_y_padre(&cooperativa.join("Trazabilidad"), cooperativa),
            ("Trazabilidad".to_string(), "COOPERATIVA".to_string())
        );
        assert_eq!(nombre_y_padre(proyectox, proyectox), ("PROYECTOX".to_string(), String::new()));
    }

    #[test]
    fn migra_base_vieja_sin_releer_contenido() {
        let tmp = TempDir::nuevo("migra");
        let base = ruta_base(&tmp.0);
        fs::create_dir_all(base.parent().unwrap()).unwrap();
        {
            let c = Connection::open(&base).unwrap();
            c.execute_batch(
                "CREATE TABLE archivos (
                   id INTEGER PRIMARY KEY,
                   ruta TEXT NOT NULL UNIQUE,
                   lugar TEXT NOT NULL,
                   carpeta INTEGER NOT NULL,
                   tamano INTEGER NOT NULL,
                   fecha INTEGER NOT NULL,
                   pendiente INTEGER NOT NULL DEFAULT 0
                 );
                 CREATE VIRTUAL TABLE palabras USING fts5(
                   nombre, ruta, texto,
                   content = '', contentless_delete = 1,
                   tokenize = 'unicode61 remove_diacritics 2'
                 );
                 CREATE TABLE lugares (
                   ruta TEXT PRIMARY KEY,
                   entradas INTEGER NOT NULL,
                   actualizado INTEGER NOT NULL,
                   segundos REAL NOT NULL
                 );
                 INSERT INTO lugares VALUES ('D:/PROYECTOX', 1, 100, 0.1);
                 INSERT INTO archivos VALUES (1, 'D:/PROYECTOX/Sitio web/index.html', 'D:/PROYECTOX', 0, 50, 100, 0);
                 INSERT INTO palabras (rowid, nombre, ruta, texto) VALUES (1, 'index.html', 'Sitio web', 'portada oficial');",
            )
            .unwrap();
        }

        let c = abrir(&tmp.0).unwrap();
        assert!(!necesita_actualizar(&c));
        assert_eq!(pendientes_por_leer(&c).unwrap(), 0);
        let hit_ruta: i64 = c
            .query_row("SELECT rowid FROM rutas WHERE rutas MATCH 'PROYECTOX \"Sitio\" \"web\"'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(hit_ruta, 1);
        let hit_texto: i64 = c
            .query_row("SELECT rowid FROM palabras WHERE palabras MATCH 'texto : portada'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(hit_texto, 1);
    }

    #[test]
    fn migra_base_v1_marca_solo_markdown() {
        let tmp = TempDir::nuevo("migra-v1");
        let base = ruta_base(&tmp.0);
        fs::create_dir_all(base.parent().unwrap()).unwrap();
        {
            let c = Connection::open(&base).unwrap();
            c.execute_batch(ESQUEMA).unwrap();
            c.execute_batch(
                "INSERT INTO lugares VALUES ('C:/Notas', 2, 100, 0.1);
                 INSERT INTO archivos VALUES (1, 'C:/Notas/guia.md', 'C:/Notas', 0, 50, 100, 0);
                 INSERT INTO archivos VALUES (2, 'C:/Notas/registro.txt', 'C:/Notas', 0, 50, 100, 0);
                 INSERT INTO palabras (rowid, nombre, ruta, texto) VALUES (1, '', '', 'contenido guia');
                 INSERT INTO palabras (rowid, nombre, ruta, texto) VALUES (2, '', '', 'contenido txt');
                 PRAGMA user_version = 1;",
            )
            .unwrap();
        }

        let c = abrir(&tmp.0).unwrap();
        assert!(!necesita_actualizar(&c));
        assert_eq!(pendientes_por_leer(&c).unwrap(), 0);
        let p_md: i64 = c.query_row("SELECT pendiente FROM archivos WHERE id = 1", [], |r| r.get(0)).unwrap();
        let p_txt: i64 = c.query_row("SELECT pendiente FROM archivos WHERE id = 2", [], |r| r.get(0)).unwrap();
        assert_eq!(p_md, 2);
        assert_eq!(p_txt, 0);
        let hit_txt: i64 = c
            .query_row("SELECT rowid FROM palabras WHERE palabras MATCH 'texto : contenido'", [], |r| r.get(0))
            .unwrap();
        assert!(hit_txt == 1 || hit_txt == 2);
    }
}
