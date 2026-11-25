// Responde «¿dónde está?» con pocas líneas: ruta y, si es texto, la línea que coincide.

use crate::{indice, texto, vigilar, Resultado};
use rusqlite::params;
use std::collections::HashSet;
use std::path::Path;
use std::sync::mpsc;
use std::time::{Duration, Instant};

const LIMITE: usize = 10;
/// Candidatos que se piden al índice antes de ordenarlos.
const CANDIDATOS: i64 = 300;
/// Espera máxima la primera vez, mientras se arma el primer catálogo.
const ESPERA_INICIAL: Duration = Duration::from_secs(10);
/// Tope para leer líneas coincidentes sin esperar a discos o nubes lentas.
const TOPE_LINEAS: Duration = Duration::from_millis(200);
const PRESUPUESTO_BUSQUEDA: Duration = Duration::from_millis(350);
const VACIAS: &[&str] = &[
    "de", "del", "la", "las", "el", "los", "y", "e", "o", "u", "a", "al", "en", "un", "una", "por", "para",
    "con", "que", "se", "su", "sus", "lo", "the", "of", "and", "to", "in", "for",
];

struct Candidato {
    ruta: String,
    lugar: String,
    carpeta: bool,
    fecha: i64,
    puesto: usize,
}

fn consultar(
    c: &rusqlite::Connection,
    terminos: &[String],
    disyuncion: bool,
) -> rusqlite::Result<Vec<Candidato>> {
    let mut out: Vec<Candidato> = Vec::new();
    let mut vistos: HashSet<i64> = HashSet::new();
    let expr = terminos.join(if disyuncion { " OR " } else { " " });
    let expr_texto = format!("texto : ({expr})");

    let mut agregar = |id: i64, cand: Candidato| {
        if vistos.insert(id) {
            out.push(cand);
        }
    };

    {
        let mut q = c.prepare(
            "SELECT a.id, a.ruta, a.lugar, a.carpeta, a.fecha FROM rutas JOIN archivos a ON a.id = rutas.rowid
             WHERE rutas MATCH ?1 ORDER BY bm25(rutas, 10.0, 4.0) LIMIT ?2",
        )?;
        let filas = q.query_map(params![expr, CANDIDATOS], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                Candidato {
                    ruta: r.get(1)?,
                    lugar: r.get(2)?,
                    carpeta: r.get::<_, i64>(3)? != 0,
                    fecha: r.get(4)?,
                    puesto: 0,
                },
            ))
        })?;
        for f in filas {
            let (id, cand) = f?;
            agregar(id, cand);
        }
    }

    {
        let mut q = c.prepare(
            "SELECT a.id, a.ruta, a.lugar, a.carpeta, a.fecha FROM palabras JOIN archivos a ON a.id = palabras.rowid
             WHERE palabras MATCH ?1 ORDER BY bm25(palabras) LIMIT ?2",
        )?;
        let filas = q.query_map(params![expr_texto, CANDIDATOS], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                Candidato {
                    ruta: r.get(1)?,
                    lugar: r.get(2)?,
                    carpeta: r.get::<_, i64>(3)? != 0,
                    fecha: r.get(4)?,
                    puesto: 0,
                },
            ))
        })?;
        for f in filas {
            let (id, cand) = f?;
            agregar(id, cand);
        }
    }

    // Coincidencias mixtas: algunas palabras en ruta/nombre y otras en el contenido.
    if !disyuncion && terminos.len() > 1 {
        let mut ctes = Vec::with_capacity(terminos.len());
        let mut valores: Vec<rusqlite::types::Value> = Vec::with_capacity(terminos.len() * 2 + 1);
        for (i, t) in terminos.iter().enumerate() {
            let p1 = i * 2 + 1;
            let p2 = i * 2 + 2;
            ctes.push(format!(
                "SELECT rowid FROM (SELECT rowid FROM rutas WHERE rutas MATCH ?{p1} UNION SELECT rowid FROM palabras WHERE palabras MATCH ?{p2})"
            ));
            valores.push(t.clone().into());
            valores.push(format!("texto : {t}").into());
        }
        let lim_idx = terminos.len() * 2 + 1;
        valores.push(CANDIDATOS.into());
        let sql = format!(
            "WITH m(id) AS ({}) SELECT a.id, a.ruta, a.lugar, a.carpeta, a.fecha FROM m JOIN archivos a ON a.id = m.id ORDER BY a.fecha DESC LIMIT ?{lim_idx}",
            ctes.join(" INTERSECT ")
        );
        let mut q = c.prepare(&sql)?;
        let filas = q.query_map(rusqlite::params_from_iter(valores.iter()), |r| {
            Ok((
                r.get::<_, i64>(0)?,
                Candidato {
                    ruta: r.get(1)?,
                    lugar: r.get(2)?,
                    carpeta: r.get::<_, i64>(3)? != 0,
                    fecha: r.get(4)?,
                    puesto: 0,
                },
            ))
        })?;
        for f in filas {
            let (id, cand) = f?;
            agregar(id, cand);
        }
    }

    for (i, x) in out.iter_mut().enumerate() {
        x.puesto = i;
    }
    Ok(out)
}

/// Primero lo que tiene en su nombre y lugar todas las palabras buscadas, cerca de la superficie y reciente.
/// El orden del índice (palabras en el contenido) desempata.
fn ordenar(candidatos: Vec<Candidato>, clave: &[String], limite: usize) -> Vec<(String, String, bool)> {
    let ahora = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let total = candidatos.len().max(1) as f64;
    let mut puntuados: Vec<(f64, Candidato)> = candidatos
        .into_iter()
        .map(|x| {
            let p = Path::new(&x.ruta);
            let nombre = texto::palabras(&p.file_stem().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default());
            let lugar_pal = if p == Path::new(&x.lugar) {
                Vec::new()
            } else {
                texto::palabras(
                    &Path::new(&x.lugar)
                        .file_name()
                        .map(|n| n.to_string_lossy().into_owned())
                        .unwrap_or_default(),
                )
            };
            let en_nombre = clave.iter().filter(|w| nombre.iter().any(|n| n.starts_with(w.as_str()))).count();
            let en_nombre_o_lugar = clave
                .iter()
                .filter(|w| {
                    nombre.iter().any(|n| n.starts_with(w.as_str()))
                        || lugar_pal.iter().any(|n| n.starts_with(w.as_str()))
                })
                .count();
            let cobertura = en_nombre_o_lugar as f64 / clave.len() as f64;
            let precision = if en_nombre > 0 { en_nombre as f64 / nombre.len().max(1) as f64 } else { 0.0 };
            let profundidad = p
                .strip_prefix(&x.lugar)
                .ok()
                .map(|r| r.components().count())
                .unwrap_or_else(|| p.components().count()) as f64;
            let dias = ((ahora - x.fecha).max(0) / 86_400) as f64;
            let reciente = if dias <= 30.0 { 1.0 } else if dias <= 180.0 { 0.5 } else { 0.0 };
            let indice = 2.0 * (1.0 - x.puesto as f64 / total);
            let s = 10.0 * cobertura
                + if en_nombre > 0 && en_nombre_o_lugar == clave.len() { 5.0 } else { 0.0 }
                + 2.0 * (en_nombre as f64 / clave.len() as f64)
                + 4.0 * precision
                - 0.8 * profundidad
                + reciente
                + indice;
            (s, x)
        })
        .collect();
    puntuados.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    puntuados
        .into_iter()
        .take(limite)
        .map(|(_, x)| (x.ruta, x.lugar, x.carpeta))
        .collect()
}

pub fn buscar(raiz: &Path, args: &[String]) -> Resultado {
    let t0 = Instant::now();
    let mut limite = LIMITE;
    let mut partes = Vec::new();
    let mut i = 0;
    while i < args.len() {
        if args[i] == "--limite" && i + 1 < args.len() {
            limite = args[i + 1].parse().unwrap_or(LIMITE).clamp(1, 100);
            i += 2;
            continue;
        }
        partes.push(args[i].clone());
        i += 1;
    }
    let consulta = partes.join(" ");
    let palabras = texto::palabras(&consulta);
    if palabras.is_empty() {
        return Err("indica qué buscar: mind buscar <texto>".into());
    }

    let primera_vez = !indice::hay_catalogo(raiz);
    vigilar::encender(raiz)?;
    if primera_vez {
        let inicio_espera = Instant::now();
        while !indice::hay_catalogo(raiz) && inicio_espera.elapsed() < ESPERA_INICIAL {
            std::thread::sleep(Duration::from_millis(80));
        }
    }

    let mut c = match indice::abrir_lectura(raiz) {
        Ok(c) => c,
        Err(_) if primera_vez => {
            salida!("Sin coincidencias para «{consulta}».");
            salida!("Mind está indexando por primera vez; vuelve a buscar en un momento.");
            return Ok(());
        }
        Err(e) => return Err(e.into()),
    };
    if indice::necesita_actualizar(&c) {
        drop(c);
        let _ = indice::abrir(raiz)?;
        c = indice::abrir_lectura(raiz)?;
    }

    // Palabras vacías como «de» o «la» no ayudan a encontrar y llenan los resultados.
    let clave: Vec<String> = {
        let v: Vec<String> = palabras.iter().filter(|w| !VACIAS.contains(&w.as_str())).cloned().collect();
        if v.is_empty() { palabras.clone() } else { v }
    };
    // Prefijo solo en palabras de 4 letras o más: «perfil» encuentra «perfiles», «de» no encuentra «desarrollo».
    let terminos: Vec<String> = clave
        .iter()
        .map(|w| if w.chars().count() >= 4 { format!("\"{w}\"*") } else { format!("\"{w}\"") })
        .collect();
    let mut candidatos = match consultar(&c, &terminos, false) {
        Ok(v) => v,
        Err(_) if primera_vez => Vec::new(),
        Err(e) => return Err(e.into()),
    };
    let mut parcial = false;
    if candidatos.is_empty() && terminos.len() > 1 {
        if let Ok(v) = consultar(&c, &terminos, true) {
            candidatos = v;
            parcial = true;
        }
    }
    let filas = ordenar(candidatos, &clave, limite);

    if filas.is_empty() {
        salida!("Sin coincidencias para «{consulta}».");
    } else {
        if parcial {
            salida!("Ningún archivo tiene todas las palabras; estos tienen alguna:");
        }
        let ocupados = indice::lugares_pendientes(&c).unwrap_or_default();
        let tope = PRESUPUESTO_BUSQUEDA.saturating_sub(t0.elapsed()).min(TOPE_LINEAS);
        let lineas = leer_lineas_con_tope(&filas, &palabras, &ocupados, tope);
        for (n, ((ruta, _, carpeta), linea)) in filas.iter().zip(lineas.into_iter()).enumerate() {
            salida!("{}. {}{}", n + 1, ruta, if *carpeta { "  (carpeta)" } else { "" });
            if let Some((num, frase)) = linea {
                salida!("   {num}: {frase}");
            }
        }
        salida!("({} resultados en {} ms)", filas.len(), t0.elapsed().as_millis());
    }

    if primera_vez {
        salida!("Mind está indexando por primera vez; vuelve a buscar en un momento.");
    }
    if let Ok(faltan) = indice::pendientes_por_leer(&c) {
        if faltan > 0 {
            salida!("Aviso: faltan {faltan} archivos por leer por dentro; por ahora se buscan por nombre y ruta.");
        }
    }
    Ok(())
}

/// Lee las líneas coincidentes en paralelo sin bloquear más allá del tope
/// ni abrir lugares que aún tienen lectura de fondo en marcha.
fn leer_lineas_con_tope(
    filas: &[(String, String, bool)],
    palabras: &[String],
    ocupados: &HashSet<String>,
    tope: Duration,
) -> Vec<Option<(usize, String)>> {
    let mut salidas = vec![None; filas.len()];
    if tope.is_zero() {
        return salidas;
    }
    let (tx, rx) = mpsc::channel();
    let mut esperando = 0usize;
    let mut terminados = vec![true; filas.len()];
    let mut hilos = Vec::new();
    for (i, (ruta, lugar, carpeta)) in filas.iter().enumerate() {
        let p = Path::new(ruta);
        if !*carpeta && !ocupados.contains(lugar) && texto::es_texto(p) {
            esperando += 1;
            terminados[i] = false;
            let tx = tx.clone();
            let p = p.to_path_buf();
            let palabras = palabras.to_vec();
            hilos.push((
                i,
                std::thread::spawn(move || {
                    let _ = tx.send((i, mejor_linea(&p, &palabras)));
                }),
            ));
        }
    }
    drop(tx);
    let limite = Instant::now() + tope;
    while esperando > 0 {
        let queda = limite.saturating_duration_since(Instant::now());
        if queda.is_zero() {
            break;
        }
        match rx.recv_timeout(queda) {
            Ok((i, res)) => {
                salidas[i] = res;
                terminados[i] = true;
                esperando -= 1;
            }
            Err(_) => break,
        }
    }
    #[cfg(windows)]
    if esperando > 0 {
        use std::os::windows::io::AsRawHandle;
        #[link(name = "kernel32")]
        extern "system" {
            fn CancelSynchronousIo(h_thread: *mut std::ffi::c_void) -> i32;
        }
        for (i, h) in hilos {
            if !terminados[i] {
                unsafe {
                    CancelSynchronousIo(h.as_raw_handle());
                }
            }
        }
    }
    #[cfg(not(windows))]
    let _ = (&hilos, &terminados);
    salidas
}

/// La línea con más palabras de la consulta, recortada alrededor de la primera.
fn mejor_linea(p: &Path, palabras: &[String]) -> Option<(usize, String)> {
    let contenido = texto::leer(p)?;
    let mut mejor: Option<(usize, usize, &str)> = None;
    for (i, linea) in contenido.lines().enumerate() {
        let norm = texto::normalizar(linea);
        let k = palabras.iter().filter(|w| norm.contains(w.as_str())).count();
        if k > 0 && mejor.map_or(true, |(_, m, _)| k > m) {
            mejor = Some((i + 1, k, linea));
            if k == palabras.len() {
                break;
            }
        }
    }
    let (n, _, linea) = mejor?;
    Some((n, recortar(linea.trim(), &palabras[0])))
}

fn recortar(linea: &str, palabra: &str) -> String {
    const ANCHO: usize = 160;
    let chars: Vec<char> = linea.chars().collect();
    if chars.len() <= ANCHO {
        return linea.to_string();
    }
    let norm: Vec<char> = texto::normalizar(linea).chars().collect();
    let objetivo: Vec<char> = palabra.chars().collect();
    let pos = (0..norm.len().saturating_sub(objetivo.len()))
        .find(|&i| norm[i..i + objetivo.len()] == objetivo[..])
        .unwrap_or(0);
    let inicio = pos.saturating_sub(40).min(chars.len().saturating_sub(ANCHO));
    let fin = (inicio + ANCHO).min(chars.len());
    let mut s: String = chars[inicio..fin].iter().collect();
    if inicio > 0 {
        s.insert(0, '…');
    }
    if fin < chars.len() {
        s.push('…');
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn orden_prioriza_nombre_completo_y_superficie() {
        let clave = vec!["caja".to_string(), "clasica".to_string()];
        let ahora = 1_800_000_000;
        let candidatos = vec![
            Candidato {
                ruta: "D:/A/B/C/D/notas_caja.md".to_string(),
                lugar: "D:/A".to_string(),
                carpeta: false,
                fecha: ahora,
                puesto: 0,
            },
            Candidato {
                ruta: "D:/A/B/C/D/Caja Clásica.md".to_string(),
                lugar: "D:/A".to_string(),
                carpeta: false,
                fecha: ahora - 86_400 * 10,
                puesto: 2,
            },
            Candidato {
                ruta: "D:/Caja Clásica.md".to_string(),
                lugar: "D:/".to_string(),
                carpeta: false,
                fecha: ahora - 86_400 * 10,
                puesto: 5,
            },
        ];
        let ordenados = ordenar(candidatos, &clave, 10);
        assert_eq!(ordenados[0].0, "D:/Caja Clásica.md");
        assert_eq!(ordenados[1].0, "D:/A/B/C/D/Caja Clásica.md");
        assert_eq!(ordenados[2].0, "D:/A/B/C/D/notas_caja.md");
    }

    #[test]
    fn nombre_del_lugar_cuenta_en_el_orden() {
        let ahora = 1_800_000_000;

        let proyectox = ordenar(
            vec![
                Candidato {
                    ruta: "G:/Mi unidad/Ana Torres/Mind/Data/Histórico/Copia/ProyectoX - Sitio web.md".to_string(),
                    lugar: "G:/Mi unidad/Ana Torres".to_string(),
                    carpeta: false,
                    fecha: ahora - 86_400 * 100,
                    puesto: 0,
                },
                Candidato {
                    ruta: "D:/PROYECTOX/Sitio web".to_string(),
                    lugar: "D:/PROYECTOX".to_string(),
                    carpeta: true,
                    fecha: ahora - 86_400 * 5,
                    puesto: 1,
                },
            ],
            &["sitio".into(), "web".into(), "proyectox".into()],
            10,
        );
        assert_eq!(proyectox[0].0, "D:/PROYECTOX/Sitio web");

        let cooperativa = ordenar(
            vec![
                Candidato {
                    ruta: "G:/.shortcut/Cafe/COOPERATIVA/Informe Ejecutivo - Trazabilidad y Portal Cooperativa.pdf".to_string(),
                    lugar: "G:/.shortcut/Cafe/COOPERATIVA".to_string(),
                    carpeta: false,
                    fecha: ahora - 86_400 * 10,
                    puesto: 0,
                },
                Candidato {
                    ruta: "C:/Users/Ana Torres/Desktop/COOPERATIVA/Trazabilidad".to_string(),
                    lugar: "C:/Users/Ana Torres/Desktop/COOPERATIVA".to_string(),
                    carpeta: true,
                    fecha: ahora - 86_400 * 5,
                    puesto: 1,
                },
            ],
            &["trazabilidad".into(), "cooperativa".into()],
            10,
        );
        assert_eq!(cooperativa[0].0, "C:/Users/Ana Torres/Desktop/COOPERATIVA/Trazabilidad");

        let perfil = ordenar(
            vec![
                Candidato {
                    ruta: "G:/Mi unidad/Ana Torres/Data/Histórico/Copia/Perfil de Ana Torres.md".to_string(),
                    lugar: "G:/Mi unidad/Ana Torres".to_string(),
                    carpeta: false,
                    fecha: ahora - 86_400 * 50,
                    puesto: 0,
                },
                Candidato {
                    ruta: "G:/Mi unidad/Ana Torres/Perfil de Ana Torres.md".to_string(),
                    lugar: "G:/Mi unidad/Ana Torres".to_string(),
                    carpeta: false,
                    fecha: ahora - 86_400 * 2,
                    puesto: 1,
                },
            ],
            &["perfil".into(), "ana".into()],
            10,
        );
        assert_eq!(perfil[0].0, "G:/Mi unidad/Ana Torres/Perfil de Ana Torres.md");
    }

    #[test]
    fn consultar_combina_rutas_y_contenido() {
        let n = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let tmp = std::env::temp_dir().join(format!("mind-buscar-{n}"));
        std::fs::create_dir_all(&tmp).unwrap();
        let c = indice::abrir(&tmp).unwrap();
        c.execute_batch(
            "INSERT INTO archivos (id, ruta, lugar, carpeta, tamano, fecha, pendiente)
             VALUES (1, 'D:/PROYECTOX/nota.md', 'D:/PROYECTOX', 0, 10, 100, 0);
             INSERT INTO rutas (rowid, nombre, ruta) VALUES (1, 'nota.md', 'PROYECTOX');
             INSERT INTO palabras (rowid, nombre, ruta, texto) VALUES (1, '', '', 'portada principal');",
        )
        .unwrap();
        let solo_ruta = consultar(&c, &["\"proyectox\"*".into()], false).unwrap();
        assert_eq!(solo_ruta.len(), 1);
        let solo_texto = consultar(&c, &["\"portada\"*".into()], false).unwrap();
        assert_eq!(solo_texto.len(), 1);
        let mixta = consultar(&c, &["\"proyectox\"*".into(), "\"portada\"*".into()], false).unwrap();
        assert_eq!(mixta.len(), 1);
        assert_eq!(mixta[0].ruta, "D:/PROYECTOX/nota.md");
        drop(c);
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
