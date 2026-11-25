// Qué entra en el índice: My Mind y lo que enlaza su Inicio.md.

use std::fs;
use std::path::{Component, Path, PathBuf};

pub fn lugares(raiz: &Path) -> Vec<PathBuf> {
    let mut todos = vec![limpiar(raiz)];
    if let Ok(texto) = fs::read_to_string(raiz.join("Inicio.md")) {
        let enlace = regex::Regex::new(r"\]\(\s*<?([^)>]+?)>?\s*\)").expect("expresión válida");
        for c in enlace.captures_iter(&texto) {
            if let Some(p) = destino(raiz, &c[1]) {
                todos.push(p);
            }
        }
    }
    todos.sort();
    todos.dedup();
    // Un lugar dentro de otro ya está cubierto por el de fuera.
    let mut out: Vec<PathBuf> = Vec::new();
    for p in todos {
        if !out.iter().any(|o| p.starts_with(o)) {
            out.push(p);
        }
    }
    out
}

fn destino(raiz: &Path, enlace: &str) -> Option<PathBuf> {
    let mut s = enlace.trim().to_string();
    if let Some(i) = s.find(" \"") {
        s.truncate(i); // [texto](ruta "título")
    }
    if !s.starts_with("file:///") && (s.starts_with('#') || s.contains("://") || s.starts_with("mailto:")) {
        return None;
    }
    if let Some(i) = s.find('#') {
        s.truncate(i);
    }
    if s.starts_with("file:///") {
        return ruta_archivo(&s).filter(|p| p.exists());
    }
    let s = decodificar(&s);
    if s.is_empty() {
        return None;
    }
    let p = Path::new(&s);
    let p = if p.is_absolute() { p.to_path_buf() } else { raiz.join(p) };
    p.exists().then(|| limpiar(&p))
}

/// URL local explícita, distinta de las rutas absolutas de un sitio web.
pub(crate) fn ruta_archivo(enlace: &str) -> Option<PathBuf> {
    let ruta = enlace.strip_prefix("file://")?;
    if !ruta.starts_with('/') || ruta.starts_with("//") {
        return None;
    }
    let ruta = decodificar(if cfg!(windows) { &ruta[1..] } else { ruta });
    let p = Path::new(&ruta);
    p.is_absolute().then(|| limpiar(p))
}

/// Separadores propios del sistema y sin `.` ni `..` sobrantes.
pub fn limpiar(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                if matches!(out.components().next_back(), Some(Component::Normal(_))) {
                    out.pop();
                } else {
                    out.push(c);
                }
            }
            _ => out.push(c),
        }
    }
    out
}

pub(crate) fn decodificar(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let (Some(a), Some(b)) = ((b[i + 1] as char).to_digit(16), (b[i + 2] as char).to_digit(16)) {
                out.push((a * 16 + b) as u8);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TempDir(PathBuf);
    impl TempDir {
        fn nuevo(nombre: &str) -> Self {
            let n = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
            let p = std::env::temp_dir().join(format!("mind-test-{nombre}-{n}"));
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
    fn enlaces_de_inicio() {
        let tmp = TempDir::nuevo("lugares");
        let raiz = tmp.0.join("My Mind");
        let con_espacios = tmp.0.join("Mi Carpeta");
        let relativa = raiz.join("Notas");
        let con_titulo = tmp.0.join("Proyecto");
        let con_ancla = tmp.0.join("Guia.md");
        fs::create_dir_all(&raiz).unwrap();
        fs::create_dir_all(&con_espacios).unwrap();
        fs::create_dir_all(&relativa).unwrap();
        fs::create_dir_all(&con_titulo).unwrap();
        fs::write(&con_ancla, "# Guia").unwrap();

        let inicio = format!(
            "- [Espacios](../Mi%20Carpeta)\n\
             - [Relativa](Notas)\n\
             - [Titulo](../Proyecto \"Mi proyecto\")\n\
             - [Ancla](../Guia.md#seccion)\n\
             - [Solo ancla](#local)\n\
             - [Web](https://ejemplo.com/ruta)\n\
             - [Correo](mailto:alguien@ejemplo.com)\n\
             - [No existe](../Faltante)\n"
        );
        fs::write(raiz.join("Inicio.md"), inicio).unwrap();

        let encontrados = lugares(&raiz);
        assert!(encontrados.contains(&limpiar(&raiz)));
        assert!(encontrados.contains(&limpiar(&con_espacios)));
        assert!(encontrados.contains(&limpiar(&con_titulo)));
        assert!(encontrados.contains(&limpiar(&con_ancla)));
        // `Notas` está dentro de `My Mind`, así que queda cubierto por `raiz`.
        assert!(!encontrados.contains(&limpiar(&relativa)));
        assert_eq!(encontrados.len(), 4);
    }
}
