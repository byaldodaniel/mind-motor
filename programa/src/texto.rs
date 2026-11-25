// Qué archivos se leen por dentro y cómo se normalizan las palabras.

use std::fs::File;
use std::io::Read;
use std::path::Path;
use unicode_normalization::{char::is_combining_mark, UnicodeNormalization};

/// Solo se leen por dentro hasta este tamaño; el resto entra por nombre y ruta.
pub const MAX_TEXTO: u64 = 1024 * 1024;

const EXTENSIONES: &[&str] = &[
    "md", "markdown", "txt", "text", "csv", "tsv", "json", "jsonc", "yaml", "yml", "toml", "ini",
    "cfg", "conf", "xml", "html", "htm", "css", "scss", "js", "mjs", "cjs", "ts", "tsx", "jsx",
    "py", "rs", "go", "java", "kt", "c", "h", "cpp", "hpp", "cs", "php", "rb", "swift", "sh",
    "ps1", "psm1", "bat", "cmd", "sql", "tex", "srt", "vtt",
];

fn extension(p: &Path) -> String {
    p.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default()
}

pub fn es_texto(p: &Path) -> bool {
    EXTENSIONES.contains(&extension(p).as_str())
}

/// Lee un archivo de texto; None si parece binario o no se puede leer.
pub fn leer(p: &Path) -> Option<String> {
    let mut buf = Vec::new();
    File::open(p).ok()?.take(MAX_TEXTO).read_to_end(&mut buf).ok()?;
    let s = if buf.starts_with(&[0xFF, 0xFE]) {
        let u: Vec<u16> = buf[2..].chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        String::from_utf16_lossy(&u)
    } else {
        if buf.contains(&0) {
            return None;
        }
        String::from_utf8_lossy(&buf).into_owned()
    };
    let s = s.trim_start_matches('\u{feff}').to_string();
    Some(match extension(p).as_str() {
        "html" | "htm" | "xml" => quitar_etiquetas(&s),
        _ => s,
    })
}

fn quitar_etiquetas(s: &str) -> String {
    let sin_codigo = regex::Regex::new(r"(?is)<script\b.*?</script>|<style\b.*?</style>")
        .map(|re| re.replace_all(s, " ").into_owned())
        .unwrap_or_else(|_| s.to_string());
    let mut out = String::with_capacity(sin_codigo.len());
    let mut dentro = false;
    for ch in sin_codigo.chars() {
        match ch {
            '<' => dentro = true,
            '>' if dentro => {
                dentro = false;
                out.push(' ');
            }
            _ if !dentro => out.push(ch),
            _ => {}
        }
    }
    out
}

/// Minúsculas y sin tildes: «Clásica» y «clasica» son la misma palabra.
pub fn normalizar(s: &str) -> String {
    s.nfd().filter(|c| !is_combining_mark(*c)).collect::<String>().to_lowercase()
}

pub fn palabras(s: &str) -> Vec<String> {
    normalizar(s)
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .map(str::to_string)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normaliza_tildes_y_mayusculas() {
        assert_eq!(
            palabras("Árbol Clásica CAFÉ, ñandú 1.0.6"),
            vec!["arbol", "clasica", "cafe", "nandu", "1", "0", "6"]
        );
        assert_eq!(palabras("Diseño-Único_Final"), vec!["diseno", "unico", "final"]);
    }
}
