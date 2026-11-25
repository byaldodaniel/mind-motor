// Conexiones: extrae enlaces al indexar y los resuelve al consultar.
// Mind nunca escribe enlaces en los archivos del usuario: solo los lee.

use crate::{indice, lugares, texto, vigilar, Resultado};
use regex::Regex;
use rusqlite::{params, Connection, OptionalExtension};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

const ESPERA_INICIAL: Duration = Duration::from_secs(10);
const LIMITE_PROBABLES: usize = 10;
const CANDIDATOS_PROBABLES: i64 = 50;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EnlaceExtraido {
    pub tipo: &'static str,
    pub destino: String,
    pub destino_clave: String,
}

fn re_wiki() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\[\[([^\]\r\n]+)\]\]").expect("regex válida"))
}

fn re_backtick() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"`([^`\r\n]+)`").expect("regex válida"))
}

/// Extrae enlaces Markdown, Wiki (`[[nombre]]`) y rutas absolutas entre comillas invertidas.
pub fn extraer(origen: &Path, contenido: &str) -> Vec<EnlaceExtraido> {
    let ext = origen.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    if !matches!(ext.as_str(), "md" | "markdown" | "txt" | "text") {
        return Vec::new();
    }

    let base = origen.parent().unwrap_or_else(|| Path::new(""));
    let mut vistos: HashSet<(String, String)> = HashSet::new();
    let mut out = Vec::new();
    let mut agregar = |tipo: &'static str, destino: String| {
        if destino.is_empty() {
            return;
        }
        let clave = destino.to_lowercase();
        if vistos.insert((tipo.to_string(), clave.clone())) {
            out.push(EnlaceExtraido {
                tipo,
                destino,
                destino_clave: clave,
            });
        }
    };

    for crudo in extraer_markdown(contenido) {
        if let Some(dest) = normalizar_markdown(base, &crudo) {
            agregar("ruta", dest);
        }
    }

    for c in re_wiki().captures_iter(contenido) {
        let mut s = c[1].trim();
        if let Some(i) = s.find('|') {
            s = s[..i].trim_end_matches('\\');
        }
        if let Some(i) = s.find('#') {
            s = &s[..i];
        }
        let s = s.trim();
        if !s.is_empty() {
            agregar("wiki", s.to_string());
        }
    }

    for c in re_backtick().captures_iter(contenido) {
        if let Some(dest) = normalizar_ruta_absoluta(&c[1]) {
            agregar("ruta", dest);
        }
    }

    out
}

/// Extrae destinos de `[texto](destino)` aceptando `<...>`, paréntesis equilibrados y `\)` escapados.
fn extraer_markdown(contenido: &str) -> Vec<String> {
    let mut out = Vec::new();
    let b = contenido.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'\\' {
            i += 2;
            continue;
        }
        if b[i] == b']' && i + 1 < b.len() && b[i + 1] == b'(' {
            let mut j = i + 2;
            while j < b.len() && matches!(b[j], b' ' | b'\t') {
                j += 1;
            }
            if j < b.len() && b[j] == b'<' {
                let ini = j + 1;
                j = ini;
                while j < b.len() && !matches!(b[j], b'>' | b'\r' | b'\n') {
                    j += 1;
                }
                if j < b.len() && b[j] == b'>' {
                    out.push(contenido[ini..j].to_string());
                    i = j + 1;
                    continue;
                }
            } else {
                let ini = j;
                let mut prof = 0usize;
                let mut cerrado = false;
                while j < b.len() {
                    match b[j] {
                        b'\\' if j + 1 < b.len() => j += 2,
                        b'(' => {
                            prof += 1;
                            j += 1;
                        }
                        b')' => {
                            if prof == 0 {
                                cerrado = true;
                                break;
                            }
                            prof -= 1;
                            j += 1;
                        }
                        b'\r' | b'\n' => break,
                        _ => j += 1,
                    }
                }
                if cerrado {
                    out.push(contenido[ini..j].to_string());
                    i = j + 1;
                    continue;
                }
            }
        }
        i += 1;
    }
    out
}

fn desescapar_markdown(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            match chars.next() {
                Some(sig @ ('(' | ')' | ' ')) => out.push(sig),
                Some(sig) => {
                    out.push('\\');
                    out.push(sig);
                }
                None => out.push('\\'),
            }
        } else {
            out.push(c);
        }
    }
    out
}

fn normalizar_markdown(base: &Path, crudo: &str) -> Option<String> {
    let mut s = crudo.trim();
    if let Some(i) = s.find(" \"") {
        s = s[..i].trim();
    } else if let Some(i) = s.find(" '") {
        s = s[..i].trim();
    }
    if s.is_empty() || s.starts_with('#') {
        return None;
    }
    if let Some(i) = s.find('#') {
        s = &s[..i];
    }
    if let Some(ruta) = lugares::ruta_archivo(s) {
        return Some(ruta.to_string_lossy().into_owned());
    }
    let lower = s.to_ascii_lowercase();
    if lower.contains("://")
        || lower.starts_with("mailto:")
        || lower.starts_with("javascript:")
        || lower.starts_with("data:")
        || lower.starts_with("tel:")
    {
        return None;
    }
    let desesc = desescapar_markdown(s);
    let dec = lugares::decodificar(&desesc);
    let dec = dec.trim();
    if dec.is_empty()
        || dec.contains('\r')
        || dec.contains('\n')
        || dec.starts_with('/')
        || dec.starts_with('\\')
    {
        return None;
    }
    let p = Path::new(dec);
    let abs = if p.is_absolute() { p.to_path_buf() } else { base.join(p) };
    Some(lugares::limpiar(&abs).to_string_lossy().into_owned())
}

fn normalizar_ruta_absoluta(crudo: &str) -> Option<String> {
    let s = crudo.trim();
    if s.is_empty() {
        return None;
    }
    if let Some(ruta) = lugares::ruta_archivo(s) {
        return Some(ruta.to_string_lossy().into_owned());
    }
    let lower = s.to_ascii_lowercase();
    if lower.contains("://") || lower.starts_with("mailto:") {
        return None;
    }
    if s.chars().any(|c| matches!(c, '*' | '?' | '"' | '<' | '>' | '|' | '\t')) {
        return None;
    }
    let b = s.as_bytes();
    let es_win = b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/');
    let es_unc = s.starts_with("\\\\") && s.len() > 3 && !s[2..].starts_with('\\') && s[2..].contains('\\');
    if !(es_win || es_unc) {
        return None;
    }
    let s = if cfg!(windows) {
        s
    } else {
        // Path en Unix no distingue los separadores invertidos de un nombre.
        let recorte = s.trim_end_matches(['\\', '/']);
        if es_win && recorte.len() == 2 {
            return Some(s[..3].to_string());
        }
        recorte
    };
    Some(lugares::limpiar(Path::new(s)).to_string_lossy().into_owned())
}

/// Resuelve `[[nombre]]` contra el índice por cercanía: misma carpeta > mismo lugar > cualquier otro.
pub fn resolver_wiki(
    c: &Connection,
    clave_lower: &str,
    origen_ruta: &str,
    origen_lugar: &str,
) -> rusqlite::Result<Option<String>> {
    let origen_padre = Path::new(origen_ruta).parent().unwrap_or_else(|| Path::new(""));
    let mut candidatos: Vec<(String, String, bool)> = Vec::new();
    let terminos = texto::palabras(clave_lower);
    if terminos.is_empty() {
        return Ok(None);
    }

    let expr = terminos
        .iter()
        .map(|t| format!("\"{t}\""))
        .collect::<Vec<_>>()
        .join(" ");
    let consulta = format!("nombre : ({expr})");
    if let Ok(mut q) = c.prepare(
        "SELECT a.ruta, a.lugar, a.carpeta FROM rutas JOIN archivos a ON a.id = rutas.rowid
         WHERE rutas MATCH ?1 LIMIT 200",
    ) {
        if let Ok(filas) = q.query_map([&consulta], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)? != 0))
        }) {
            for f in filas.flatten() {
                candidatos.push(f);
            }
        }
    }

    let mut mejor: Option<((u8, usize, String), String)> = None;
    for (ruta, lugar, carpeta) in candidatos {
        if !coincide_wiki(Path::new(&ruta), carpeta, clave_lower) {
            continue;
        }
        let nivel = if Path::new(&ruta).parent() == Some(origen_padre) {
            0u8
        } else if lugar.eq_ignore_ascii_case(origen_lugar) {
            1u8
        } else {
            2u8
        };
        let clave_ord = (nivel, ruta.len(), ruta.clone());
        if mejor.as_ref().is_none_or(|(k, _)| clave_ord < *k) {
            mejor = Some((clave_ord, ruta));
        }
    }

    Ok(mejor.map(|(_, r)| r))
}

fn coincide_wiki(p: &Path, carpeta: bool, clave_lower: &str) -> bool {
    let nombre = p.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
    if nombre == clave_lower {
        return true;
    }
    if !carpeta {
        if let Some(stem) = p.file_stem() {
            if stem.to_string_lossy().to_lowercase() == clave_lower {
                return true;
            }
        }
    }
    false
}

/// Cuenta total de enlaces y cuántos están rotos, para `mind estado`.
pub fn resumen(c: &Connection) -> rusqlite::Result<(i64, usize)> {
    let total: i64 = c.query_row("SELECT count(*) FROM enlaces", [], |r| r.get(0))?;
    let rotos = enlaces_rotos(c)?;
    let total_rotos: usize = rotos.iter().map(|(_, n)| *n).sum();
    Ok((total, total_rotos))
}

fn enlaces_rotos(c: &Connection) -> rusqlite::Result<Vec<(String, usize)>> {
    let mut ql = c.prepare("SELECT ruta FROM lugares")?;
    let lugares: Vec<String> = ql
        .query_map([], |r| r.get::<_, String>(0))?
        .filter_map(Result::ok)
        .map(|s| s.to_lowercase())
        .collect();
    let lugares_set: HashSet<String> = lugares.iter().cloned().collect();

    let mut q = c.prepare(
        "SELECT a_orig.ruta, a_orig.lugar, e.tipo, e.destino, e.destino_clave, a_dest.id
         FROM enlaces e
         JOIN archivos a_orig ON a_orig.id = e.origen_id
         LEFT JOIN archivos a_dest ON e.tipo = 'ruta' AND a_dest.ruta = e.destino COLLATE NOCASE",
    )?;
    let filas = q.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, String>(3)?,
            r.get::<_, String>(4)?,
            r.get::<_, Option<i64>>(5)?,
        ))
    })?;

    let mut cache_wiki: HashMap<String, bool> = HashMap::new();
    let mut pendientes_externos: Vec<(String, String)> = Vec::new();
    let mut externos_unicos: HashMap<String, String> = HashMap::new();
    let mut conteo: HashMap<String, usize> = HashMap::new();

    for f in filas {
        let (orig_ruta, orig_lugar, tipo, destino, clave, dest_id) = f?;
        if tipo == "ruta" {
            if dest_id.is_some() || lugares_set.contains(&clave) {
                continue;
            }
            if cubierto_por_indice(&lugares, &clave) {
                *conteo.entry(orig_ruta).or_insert(0) += 1;
            } else {
                externos_unicos.entry(clave.clone()).or_insert(destino);
                pendientes_externos.push((orig_ruta, clave));
            }
        } else {
            let existe = if let Some(&res) = cache_wiki.get(&clave) {
                res
            } else {
                let res = resolver_wiki(c, &clave, &orig_ruta, &orig_lugar)?.is_some();
                cache_wiki.insert(clave, res);
                res
            };
            if !existe {
                *conteo.entry(orig_ruta).or_insert(0) += 1;
            }
        }
    }

    if !externos_unicos.is_empty() {
        let lista: Vec<(String, String)> = externos_unicos.into_iter().collect();
        let existen = comprobar_externos(lista);
        for (orig_ruta, clave) in pendientes_externos {
            if !existen.get(&clave).copied().unwrap_or(true) {
                *conteo.entry(orig_ruta).or_insert(0) += 1;
            }
        }
    }

    let mut rotos: Vec<(String, usize)> = conteo.into_iter().collect();
    rotos.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    Ok(rotos)
}

fn cubierto_por_indice(lugares_lower: &[String], ruta_lower: &str) -> bool {
    let sep = std::path::MAIN_SEPARATOR;
    for lugar in lugares_lower {
        let Some(resto) = ruta_lower.strip_prefix(lugar.as_str()) else {
            continue;
        };
        if resto.is_empty() {
            return true;
        }
        let Some(rel) = resto.strip_prefix(sep) else {
            continue;
        };
        let excluido = rel.split(sep).enumerate().any(|(i, seg)| {
            seg.starts_with('.')
                || seg.starts_with("~$")
                || (i == 0 && seg == "sistema")
                || matches!(
                    seg,
                    "node_modules"
                        | "target"
                        | "__pycache__"
                        | "venv"
                        | "bower_components"
                        | "$recycle.bin"
                        | "system volume information"
                )
        });
        if !excluido {
            return true;
        }
    }
    false
}

fn comprobar_externos(destinos: Vec<(String, String)>) -> HashMap<String, bool> {
    let mut out = HashMap::with_capacity(destinos.len());
    if destinos.is_empty() {
        return out;
    }
    let total = destinos.len();
    let lista = std::sync::Arc::new(destinos);
    let siguiente = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let (tx, rx) = std::sync::mpsc::channel();
    let hilos = total.min(32);
    for _ in 0..hilos {
        let lista = lista.clone();
        let siguiente = siguiente.clone();
        let tx = tx.clone();
        std::thread::spawn(move || loop {
            let i = siguiente.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let Some((clave, ruta)) = lista.get(i) else { break };
            let existe = Path::new(ruta).exists();
            if tx.send((clave.clone(), existe)).is_err() {
                break;
            }
        });
    }
    drop(tx);
    let t0 = Instant::now();
    let tope = Duration::from_millis(120);
    while out.len() < total {
        let restante = tope.saturating_sub(t0.elapsed());
        if restante.is_zero() {
            break;
        }
        match rx.recv_timeout(restante) {
            Ok((clave, existe)) => {
                out.insert(clave, existe);
            }
            Err(_) => break,
        }
    }
    out
}

pub fn conexiones(raiz: &Path, args: &[String]) -> Resultado {
    vigilar::encender(raiz)?;
    if !indice::hay_catalogo(raiz) {
        let inicio = Instant::now();
        while !indice::hay_catalogo(raiz) && inicio.elapsed() < ESPERA_INICIAL {
            std::thread::sleep(Duration::from_millis(80));
        }
    }

    let mut c = match indice::abrir_lectura(raiz) {
        Ok(c) => c,
        Err(_) => {
            salida!("Mind está indexando por primera vez; vuelve a consultar en un momento.");
            return Ok(());
        }
    };
    if indice::necesita_actualizar(&c) {
        drop(c);
        let _ = indice::abrir(raiz)?;
        c = indice::abrir_lectura(raiz)?;
    }

    if args.is_empty() {
        let rotos = enlaces_rotos(&c)?;
        if rotos.is_empty() {
            salida!("Sin enlaces rotos.");
        } else {
            let mut out = std::io::BufWriter::new(std::io::stdout().lock());
            for (origen, n) in rotos {
                let _ = writeln!(out, "{n:>4}  {origen}");
            }
        }
        return Ok(());
    }

    let entrada = args.join(" ");
    let p = Path::new(&entrada);
    let buscada: PathBuf = if p.is_absolute() {
        lugares::limpiar(p)
    } else {
        let desde_cwd = std::env::current_dir().map(|d| lugares::limpiar(&d.join(p))).ok();
        if desde_cwd.as_ref().is_some_and(|x| x.exists()) {
            desde_cwd.unwrap()
        } else {
            lugares::limpiar(&raiz.join(p))
        }
    };
    let ruta_str = buscada.to_string_lossy().into_owned();

    let archivo: Option<(i64, String, String, bool)> = c
        .query_row(
            "SELECT id, ruta, lugar, carpeta FROM archivos WHERE ruta = ?1 COLLATE NOCASE",
            [&ruta_str],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get::<_, i64>(3)? != 0)),
        )
        .optional()?;

    let Some((id, ruta, lugar, carpeta)) = archivo else {
        let nombre = buscada
            .file_stem()
            .or_else(|| buscada.file_name())
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| entrada.clone());
        salida!("No está en el índice: {} (prueba: mind buscar {nombre})", buscada.display());
        return Ok(());
    };

    let (enlaza_a, lo_enlazan, rotos, probables) = consultar_archivo(&c, id, &ruta, &lugar, carpeta)?;
    let mut alguno = false;
    let bloques = [
        ("Enlaza a:", enlaza_a),
        ("Lo enlazan:", lo_enlazan),
        ("Rotos:", rotos),
        ("Probables:", probables),
    ];
    for (titulo, items) in bloques {
        if items.is_empty() {
            continue;
        }
        alguno = true;
        salida!("{titulo}");
        for item in items {
            salida!("  {item}");
        }
    }
    if !alguno {
        salida!("Sin conexiones para {ruta}.");
    }
    Ok(())
}

pub fn consultar_archivo(
    c: &Connection,
    id: i64,
    ruta: &str,
    lugar: &str,
    carpeta: bool,
) -> rusqlite::Result<(Vec<String>, Vec<String>, Vec<String>, Vec<String>)> {
    // 1 y 3: Enlaza a / Rotos
    let mut enlaza_a: BTreeSet<String> = BTreeSet::new();
    let mut rotos: BTreeSet<String> = BTreeSet::new();
    {
        let mut q = c.prepare(
            "SELECT e.tipo, e.destino, e.destino_clave, a_dest.ruta
             FROM enlaces e
             LEFT JOIN archivos a_dest ON e.tipo = 'ruta' AND a_dest.ruta = e.destino COLLATE NOCASE
             WHERE e.origen_id = ?1",
        )?;
        let filas = q.query_map([id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, Option<String>>(3)?,
            ))
        })?;
        for f in filas {
            let (tipo, destino, clave, dest_indice) = f?;
            if tipo == "ruta" {
                if let Some(r) = dest_indice {
                    enlaza_a.insert(r);
                } else if Path::new(&destino).exists() {
                    enlaza_a.insert(destino);
                } else {
                    rotos.insert(destino);
                }
            } else if let Some(res) = resolver_wiki(c, &clave, ruta, lugar)? {
                enlaza_a.insert(res);
            } else {
                rotos.insert(format!("[[{destino}]]"));
            }
        }
    }

    // 2: Lo enlazan
    let mut lo_enlazan: BTreeSet<String> = BTreeSet::new();
    let ruta_clave = ruta.to_lowercase();
    {
        let mut q = c.prepare(
            "SELECT a.ruta FROM enlaces e
             JOIN archivos a ON a.id = e.origen_id
             WHERE e.tipo = 'ruta' AND e.destino_clave = ?1 AND e.origen_id != ?2",
        )?;
        let filas = q.query_map(params![ruta_clave, id], |r| r.get::<_, String>(0))?;
        for f in filas {
            lo_enlazan.insert(f?);
        }
    }

    let p = Path::new(ruta);
    let mut claves_wiki: Vec<String> = Vec::new();
    if let Some(n) = p.file_name() {
        let s = n.to_string_lossy().to_lowercase();
        if !s.is_empty() {
            claves_wiki.push(s);
        }
    }
    if !carpeta {
        if let Some(st) = p.file_stem() {
            let s = st.to_string_lossy().to_lowercase();
            if !s.is_empty() && !claves_wiki.contains(&s) {
                claves_wiki.push(s);
            }
        }
    }
    for clave in &claves_wiki {
        let mut q = c.prepare(
            "SELECT a.ruta, a.lugar FROM enlaces e
             JOIN archivos a ON a.id = e.origen_id
             WHERE e.tipo = 'wiki' AND e.destino_clave = ?1 AND e.origen_id != ?2",
        )?;
        let filas = q.query_map(params![clave, id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        for f in filas {
            let (orig_ruta, orig_lugar) = f?;
            if let Some(res) = resolver_wiki(c, clave, &orig_ruta, &orig_lugar)? {
                if res.eq_ignore_ascii_case(ruta) {
                    lo_enlazan.insert(orig_ruta);
                }
            }
        }
    }

    // 4: Probables (mencionan el nombre completo como frase, o nombre+extensión si es de una palabra)
    let mut probables: Vec<String> = Vec::new();
    let nombre_base = if carpeta {
        p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
    } else {
        p.file_stem()
            .or_else(|| p.file_name())
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default()
    };
    let terminos = texto::palabras(&nombre_base);
    let expr = if terminos.len() >= 2 {
        Some(format!("texto : \"{}\"", terminos.join(" ")))
    } else if terminos.len() == 1 {
        if !carpeta {
            let completo = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            let con_ext = texto::palabras(&completo);
            if con_ext.len() >= 2 {
                Some(format!("texto : \"{}\"", con_ext.join(" ")))
            } else if terminos[0].chars().count() >= 3 {
                Some(format!("texto : \"{}\"", terminos[0]))
            } else {
                None
            }
        } else {
            (terminos[0].chars().count() >= 3).then(|| format!("texto : \"{}\"", terminos[0]))
        }
    } else {
        None
    };

    if let Some(expr) = expr {
        if let Ok(mut q) = c.prepare(
            "SELECT a.id, a.ruta FROM palabras JOIN archivos a ON a.id = palabras.rowid
             WHERE palabras MATCH ?1 ORDER BY bm25(palabras) LIMIT ?2",
        ) {
            if let Ok(filas) = q.query_map(params![expr, CANDIDATOS_PROBABLES], |r| {
                Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
            }) {
                for f in filas.flatten() {
                    let (cand_id, cand_ruta) = f;
                    if cand_id == id || lo_enlazan.contains(&cand_ruta) {
                        continue;
                    }
                    probables.push(cand_ruta);
                    if probables.len() >= LIMITE_PROBABLES {
                        break;
                    }
                }
            }
        }
    }

    Ok((
        enlaza_a.into_iter().collect(),
        lo_enlazan.into_iter().collect(),
        rotos.into_iter().collect(),
        probables,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TempDir(PathBuf);
    impl TempDir {
        fn nuevo(nombre: &str) -> Self {
            let n = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
            let p = std::env::temp_dir().join(format!("mind-conexiones-{nombre}-{n}"));
            fs::create_dir_all(&p).unwrap();
            Self(p)
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn raiz_prueba() -> &'static Path {
        if cfg!(windows) {
            Path::new("C:\\Mind")
        } else {
            Path::new("/Mind")
        }
    }

    #[cfg(unix)]
    #[test]
    fn extrae_enlaces_absolutos_locales_sin_confundir_rutas_web() {
        let origen = Path::new("/Mind/nota.md");
        let md = "[Guía](file:///Mis%20notas/Gu%C3%ADa.md#intro) [Web](/assets/logo.png) `file:///otra/nota.md`";
        let rutas: Vec<_> = extraer(origen, md).into_iter().map(|e| e.destino).collect();
        assert_eq!(rutas, ["/Mis notas/Guía.md", "/otra/nota.md"]);
    }

    #[test]
    fn extrae_tres_tipos_e_ignora_web() {
        assert_eq!(normalizar_ruta_absoluta("D:\\"), Some("D:\\".to_string()));
        let origen = raiz_prueba().join("Proyectos").join("nota.md");
        let md = "\
- [Guía](../Gu%C3%ADa%20r%C3%A1pida.md#intro \"título\")
- [Web](https://ejemplo.com/ruta)
- [Correo](mailto:a@b.com)
- [Solo ancla](#aqui)
- [[Base Mind]]
- [[Esencia|la esencia]]
- [[Plan#pasos]]
- Ruta: `D:\\PROYECTOX\\Sitio web\\`
- No ruta: `npm run build`
";
        let e = extraer(&origen, md);
        let destinos: Vec<(&str, &str)> = e.iter().map(|x| (x.tipo, x.destino.as_str())).collect();
        assert_eq!(
            destinos,
            vec![
                ("ruta", raiz_prueba().join("Guía rápida.md").to_str().unwrap()),
                ("wiki", "Base Mind"),
                ("wiki", "Esencia"),
                ("wiki", "Plan"),
                ("ruta", "D:\\PROYECTOX\\Sitio web"),
            ]
        );
    }

    #[test]
    fn resuelve_wiki_por_cercania() {
        let tmp = TempDir::nuevo("wiki");
        let mind = tmp.0.join("My Mind");
        let lugar1 = tmp.0.join("Lugar1");
        let sub1 = lugar1.join("Sub");
        let otro = tmp.0.join("Lugar2");
        fs::create_dir_all(&mind).unwrap();
        fs::create_dir_all(&sub1).unwrap();
        fs::create_dir_all(&otro).unwrap();

        let origen = sub1.join("origen.md");
        let misma_carpeta = sub1.join("meta.md");
        let mismo_lugar = lugar1.join("meta.md");
        let otro_lugar = otro.join("meta.md");
        fs::write(&origen, "[[meta]]").unwrap();
        fs::write(&misma_carpeta, "local").unwrap();
        fs::write(&mismo_lugar, "lugar").unwrap();
        fs::write(&otro_lugar, "otro").unwrap();

        let c = indice::abrir(&mind).unwrap();
        let sistema = mind.join("Sistema");
        indice::catalogar(&c, &lugar1, &lugar1, &sistema, &mut |_| {}).unwrap();
        indice::catalogar(&c, &otro, &otro, &sistema, &mut |_| {}).unwrap();

        let orig_s = lugares::limpiar(&origen).to_string_lossy().into_owned();
        let lug1_s = lugares::limpiar(&lugar1).to_string_lossy().into_owned();

        // 1) Misma carpeta gana.
        let r1 = resolver_wiki(&c, "meta", &orig_s, &lug1_s).unwrap();
        assert_eq!(r1, Some(lugares::limpiar(&misma_carpeta).to_string_lossy().into_owned()));

        // 2) Al borrar la de la misma carpeta, gana la del mismo lugar.
        fs::remove_file(&misma_carpeta).unwrap();
        indice::catalogar(&c, &lugar1, &lugar1, &sistema, &mut |_| {}).unwrap();
        let r2 = resolver_wiki(&c, "meta", &orig_s, &lug1_s).unwrap();
        assert_eq!(r2, Some(lugares::limpiar(&mismo_lugar).to_string_lossy().into_owned()));

        // 3) Al borrar la del mismo lugar, gana la de otro lugar.
        fs::remove_file(&mismo_lugar).unwrap();
        indice::catalogar(&c, &lugar1, &lugar1, &sistema, &mut |_| {}).unwrap();
        let r3 = resolver_wiki(&c, "meta", &orig_s, &lug1_s).unwrap();
        assert_eq!(r3, Some(lugares::limpiar(&otro_lugar).to_string_lossy().into_owned()));
    }

    #[test]
    fn enlace_se_rompe_y_se_arregla_al_recrear_destino() {
        let tmp = TempDir::nuevo("roto");
        let mind = tmp.0.join("My Mind");
        fs::create_dir_all(&mind).unwrap();
        let a = mind.join("a.md");
        let b = mind.join("b.md");
        let c_md = mind.join("c.md");
        fs::write(&a, "Ver [B](b.md).").unwrap();
        fs::write(&b, "Soy B.").unwrap();
        fs::write(&c_md, "Aquí menciono b sin enlazar.").unwrap();

        let c = indice::abrir(&mind).unwrap();
        let sistema = mind.join("Sistema");
        indice::catalogar(&c, &mind, &mind, &sistema, &mut |_| {}).unwrap();
        let pendientes = indice::siguientes_pendientes(&c, 100).unwrap();
        let lote: Vec<_> = pendientes
            .into_iter()
            .map(|p| {
                let txt = texto::leer(Path::new(&p.ruta));
                (p, txt)
            })
            .collect();
        indice::guardar_lote_contenido(&c, &lote).unwrap();

        let a_s = lugares::limpiar(&a).to_string_lossy().into_owned();
        let b_s = lugares::limpiar(&b).to_string_lossy().into_owned();
        let id_a: i64 = c.query_row("SELECT id FROM archivos WHERE ruta = ?1", [&a_s], |r| r.get(0)).unwrap();

        // Vivo: A enlaza a B, 0 rotos.
        let (enl, _, rot, _) = consultar_archivo(&c, id_a, &a_s, &mind.to_string_lossy(), false).unwrap();
        assert_eq!(enl, vec![b_s.clone()]);
        assert!(rot.is_empty());

        // Borramos B en disco y recatalogamos: ahora el enlace está roto.
        fs::remove_file(&b).unwrap();
        indice::catalogar(&c, &mind, &mind, &sistema, &mut |_| {}).unwrap();
        let (enl2, _, rot2, _) = consultar_archivo(&c, id_a, &a_s, &mind.to_string_lossy(), false).unwrap();
        assert!(enl2.is_empty());
        assert_eq!(rot2, vec![b_s.clone()]);

        // Volvemos a crear B (incluso sin recatalogar aún, existe en disco; y al recatalogar también en índice).
        fs::write(&b, "Volví.").unwrap();
        let (enl3, _, rot3, _) = consultar_archivo(&c, id_a, &a_s, &mind.to_string_lossy(), false).unwrap();
        assert_eq!(enl3, vec![b_s]);
        assert!(rot3.is_empty());
    }

    #[test]
    fn ignora_rutas_web_sin_unidad() {
        let origen = raiz_prueba().join("README.md");
        let md = "\
- [Video](/assets/caja-scroll.mp4)
- [Traz](/Trazabilidad)
- [Win](\\solo_barra)
- [Rel](guia.md)
- Ruta web: `/glb/modelo.glb`
- Ruta win: `\\Trazabilidad`
- Doble barra sin recurso: `\\\\solo_barra`
";
        let e = extraer(&origen, md);
        let destinos: Vec<&str> = e.iter().map(|x| x.destino.as_str()).collect();
        assert_eq!(destinos, vec![raiz_prueba().join("guia.md").to_str().unwrap()]);
    }

    #[test]
    fn parentesis_escapes_y_angulares_en_markdown() {
        let origen = raiz_prueba().join("Frente.md");
        let md = "\
- [Caja](01 - Caja Clasica (Seguridad y Navidad)/guion.md)
- [Escapado](archivo\\(v2\\).md)
- [Angular](<Carpeta (Prueba)/nota final.md> \"título\")
";
        let e = extraer(&origen, md);
        let destinos: Vec<&str> = e.iter().map(|x| x.destino.as_str()).collect();
        assert_eq!(
            destinos,
            vec![
                raiz_prueba().join("01 - Caja Clasica (Seguridad y Navidad)").join("guion.md").to_str().unwrap(),
                raiz_prueba().join("archivo(v2).md").to_str().unwrap(),
                raiz_prueba().join("Carpeta (Prueba)").join("nota final.md").to_str().unwrap(),
            ]
        );
    }

    #[test]
    fn wiki_en_tablas_con_barra_pipe() {
        let origen = Path::new("C:\\Mind\\tabla.md");
        let md = "| Campo | Enlace |\n|---|---|\n| Uno | [[Base Mind\\|La Base]] |\n| Dos | [[Plan#paso1\\|Paso 1]] |\n";
        let e = extraer(&origen, md);
        let wikis: Vec<(&str, &str)> = e
            .iter()
            .filter(|x| x.tipo == "wiki")
            .map(|x| (x.destino.as_str(), x.destino_clave.as_str()))
            .collect();
        assert_eq!(wikis, vec![("Base Mind", "base mind"), ("Plan", "plan")]);
    }

    #[test]
    fn probables_una_palabra_exige_extension() {
        let tmp = TempDir::nuevo("probables");
        let mind = tmp.0.join("My Mind");
        fs::create_dir_all(&mind).unwrap();
        let inicio = mind.join("Inicio.md");
        let css = mind.join("inicio-mensaje.css");
        let nota = mind.join("guia.md");
        fs::write(&inicio, "# Inicio").unwrap();
        fs::write(&css, ".inicio { color: red; }").unwrap();
        fs::write(&nota, "Abre Inicio.md antes de empezar.").unwrap();

        let c = indice::abrir(&mind).unwrap();
        let sistema = mind.join("Sistema");
        indice::catalogar(&c, &mind, &mind, &sistema, &mut |_| {}).unwrap();
        let pendientes = indice::siguientes_pendientes(&c, 100).unwrap();
        let lote: Vec<_> = pendientes
            .into_iter()
            .map(|p| {
                let txt = texto::leer(Path::new(&p.ruta));
                (p, txt)
            })
            .collect();
        indice::guardar_lote_contenido(&c, &lote).unwrap();

        let inicio_s = lugares::limpiar(&inicio).to_string_lossy().into_owned();
        let nota_s = lugares::limpiar(&nota).to_string_lossy().into_owned();
        let id_inicio: i64 = c.query_row("SELECT id FROM archivos WHERE ruta = ?1", [&inicio_s], |r| r.get(0)).unwrap();

        let (_, _, _, probables) = consultar_archivo(&c, id_inicio, &inicio_s, &mind.to_string_lossy(), false).unwrap();
        assert_eq!(probables, vec![nota_s]);
    }
}
