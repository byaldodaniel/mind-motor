// El vigilante: mantiene el Índice al día sin recorrer el disco cada segundo.
// El sistema avisa qué cambió y solo eso se vuelve a anotar. Donde no hay avisos
// (algunas unidades de red), el lugar se revisa entero cada cierto tiempo.

use crate::{indice, lugares, texto, Resultado};
use notify::{RecursiveMode, Watcher};
use std::collections::BTreeSet;
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
#[cfg(not(windows))]
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// Se espera a que los cambios se calmen antes de anotarlos.
const CALMA: Duration = Duration::from_secs(2);
/// Revisión completa de los lugares sin avisos del sistema.
const REVISION: Duration = Duration::from_secs(10 * 60);
/// Tamaño máximo del registro antes de empezar de nuevo.
const MAX_LOG: u64 = 1_048_576;
/// Cantidad de archivos por tanda de lectura en segundo plano.
const TANDA_LECTURA: usize = 500;

pub fn cerrojo(raiz: &Path) -> PathBuf {
    indice::ruta_base(raiz).with_file_name("vigilante.lock")
}

pub fn ruta_log(raiz: &Path) -> PathBuf {
    indice::ruta_base(raiz).with_file_name("vigilante.log")
}

/// ¿Hay un vigilante corriendo? Lo sabe por el cerrojo que mantiene tomado.
pub fn activo(raiz: &Path) -> bool {
    let p = cerrojo(raiz);
    if !p.exists() {
        return false;
    }
    match File::options().read(true).write(true).open(p) {
        Ok(f) => f.try_lock().is_err(),
        Err(_) => false,
    }
}

/// Enciende `mind vigilar` como proceso independiente y sin ventanas si aún no corre.
pub fn encender(raiz: &Path) -> Resultado {
    if activo(raiz) {
        return Ok(());
    }
    let exe = std::env::current_exe()?;
    #[cfg(windows)]
    {
        lanzar_desacoplado(&exe, raiz)?;
    }
    #[cfg(not(windows))]
    {
        let mut cmd = Command::new(exe);
        cmd.arg("--raiz")
            .arg(raiz)
            .arg("vigilar")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }
        cmd.spawn()?;
    }
    Ok(())
}

#[cfg(windows)]
fn lanzar_desacoplado(exe: &Path, raiz: &Path) -> Resultado {
    use std::ffi::c_void;
    use std::mem::{size_of, zeroed};
    use std::os::windows::ffi::OsStrExt;
    use std::ptr::{null, null_mut};

    #[repr(C)]
    struct StartupInfoW {
        cb: u32,
        lp_reserved: *mut u16,
        lp_desktop: *mut u16,
        lp_title: *mut u16,
        dw_x: u32,
        dw_y: u32,
        dw_x_size: u32,
        dw_y_size: u32,
        dw_x_count_chars: u32,
        dw_y_count_chars: u32,
        dw_fill_attribute: u32,
        dw_flags: u32,
        w_show_window: u16,
        cb_reserved2: u16,
        lp_reserved2: *mut u8,
        h_std_input: *mut c_void,
        h_std_output: *mut c_void,
        h_std_error: *mut c_void,
    }

    #[repr(C)]
    struct ProcessInformation {
        h_process: *mut c_void,
        h_thread: *mut c_void,
        dw_process_id: u32,
        dw_thread_id: u32,
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn CreateProcessW(
            lp_application_name: *const u16,
            lp_command_line: *mut u16,
            lp_process_attributes: *mut c_void,
            lp_thread_attributes: *mut c_void,
            b_inherit_handles: i32,
            dw_creation_flags: u32,
            lp_environment: *mut c_void,
            lp_current_directory: *const u16,
            lp_startup_info: *const StartupInfoW,
            lp_process_information: *mut ProcessInformation,
        ) -> i32;
        fn CloseHandle(h_object: *mut c_void) -> i32;
    }

    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;

    let cmdline = format!(
        "{} --raiz {} vigilar",
        citar_win(&exe.to_string_lossy()),
        citar_win(&raiz.to_string_lossy())
    );
    let app_w: Vec<u16> = exe.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut cmd_w: Vec<u16> = cmdline.encode_utf16().chain(Some(0)).collect();
    let si = StartupInfoW { cb: size_of::<StartupInfoW>() as u32, ..unsafe { zeroed() } };
    let mut pi: ProcessInformation = unsafe { zeroed() };

    let base_flags = DETACHED_PROCESS | CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP;
    let mut ok = unsafe {
        CreateProcessW(
            app_w.as_ptr(),
            cmd_w.as_mut_ptr(),
            null_mut(),
            null_mut(),
            0, // Sin herencia de conductos del agente o consola padre.
            base_flags | CREATE_BREAKAWAY_FROM_JOB,
            null_mut(),
            null(),
            &si,
            &mut pi,
        )
    };
    if ok == 0 {
        let mut cmd_w2: Vec<u16> = cmdline.encode_utf16().chain(Some(0)).collect();
        ok = unsafe {
            CreateProcessW(
                app_w.as_ptr(),
                cmd_w2.as_mut_ptr(),
                null_mut(),
                null_mut(),
                0,
                base_flags,
                null_mut(),
                null(),
                &si,
                &mut pi,
            )
        };
    }
    if ok == 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    unsafe {
        CloseHandle(pi.h_thread);
        CloseHandle(pi.h_process);
    }
    Ok(())
}

#[cfg(any(windows, test))]
fn citar_win(s: &str) -> String {
    if !s.is_empty() && !s.chars().any(|c| c == ' ' || c == '\t' || c == '"') {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    let mut barras = 0usize;
    for ch in s.chars() {
        match ch {
            '\\' => barras += 1,
            '"' => {
                out.extend(std::iter::repeat('\\').take(barras * 2 + 1));
                out.push('"');
                barras = 0;
            }
            _ => {
                out.extend(std::iter::repeat('\\').take(barras));
                out.push(ch);
                barras = 0;
            }
        }
    }
    out.extend(std::iter::repeat('\\').take(barras * 2));
    out.push('"');
    out
}

fn registrar(ruta_log: &Path, linea: &str) {
    if let Some(dir) = ruta_log.parent() {
        let _ = fs::create_dir_all(dir);
    }
    let reiniciar = fs::metadata(ruta_log).map(|m| m.len() >= MAX_LOG).unwrap_or(false);
    let mut opciones = File::options();
    opciones.create(true).write(true);
    if reiniciar {
        opciones.truncate(true);
    } else {
        opciones.append(true);
    }
    if let Ok(mut f) = opciones.open(ruta_log) {
        let _ = writeln!(f, "[{}] {}", sello_utc(), linea);
    }
}

fn sello_utc() -> String {
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let dias = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let h = rem / 3_600;
    let m = (rem % 3_600) / 60;
    let s = rem % 60;
    let (a, mes, d) = fecha_desde_dias(dias);
    format!("{a:04}-{mes:02}-{d:02} {h:02}:{m:02}:{s:02}Z")
}

/// Conversión civil desde días Unix (algoritmo de Howard Hinnant).
fn fecha_desde_dias(dias: i64) -> (i64, u32, u32) {
    let z = dias + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = (yoe as i64) + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y, m as u32, d as u32)
}

struct Lectura {
    rx: mpsc::Receiver<(indice::Pendiente, Option<String>)>,
    hilo: Option<std::thread::JoinHandle<()>>,
    leidos: usize,
    enlaces_leidos: usize,
    intentados: usize,
    inicio: Instant,
}

fn iniciar_tanda(
    pendientes: Vec<indice::Pendiente>,
    leidos: usize,
    enlaces_leidos: usize,
    intentados: usize,
    inicio: Instant,
) -> Lectura {
    let total = pendientes.len();
    let (tx, rx) = mpsc::sync_channel::<(indice::Pendiente, Option<String>)>(64);
    let hilo = std::thread::spawn(move || {
        let siguiente = AtomicUsize::new(0);
        std::thread::scope(|s| {
            for _ in 0..indice::HILOS {
                let tx = tx.clone();
                let (pendientes, siguiente) = (&pendientes, &siguiente);
                s.spawn(move || loop {
                    let i = siguiente.fetch_add(1, Ordering::Relaxed);
                    let Some(p) = pendientes.get(i) else { break };
                    let contenido = texto::leer(Path::new(&p.ruta));
                    if tx.send((p.clone(), contenido)).is_err() {
                        break;
                    }
                });
            }
            drop(tx);
        });
    });
    Lectura {
        rx,
        hilo: Some(hilo),
        leidos,
        enlaces_leidos,
        intentados: intentados + total,
        inicio,
    }
}

pub fn vigilar(raiz: &Path) -> Resultado {
    indice::abrir(raiz)?; // crea la carpeta de la Base
    let cerrojo = File::options().read(true).write(true).create(true).open(cerrojo(raiz))?;
    if cerrojo.try_lock().is_err() {
        salida!("Ya hay un vigilante en marcha.");
        return Ok(());
    }

    let ruta_registro = ruta_log(raiz);
    let mut log = |msg: &str| {
        registrar(&ruta_registro, msg);
    };
    log("Vigilante iniciado.");

    let sistema = raiz.join("Sistema");
    let inicio = raiz.join("Inicio.md");
    loop {
        let c = indice::abrir(raiz)?;
        let lugares = lugares::lugares(raiz);

        // 1. Catálogo.
        indice::quitar_lugares_viejos(&c, &lugares, &mut log)?;
        for lugar in &lugares {
            indice::catalogar(&c, lugar, lugar, &sistema, &mut log)?;
        }

        // 2. Empieza a vigilar antes de leer contenido.
        #[cfg(target_os = "macos")]
        let rutas_reales: Vec<_> = lugares
            .iter()
            .filter_map(|lugar| {
                let real = lugar.canonicalize().ok()?;
                (real != *lugar).then(|| (real, lugar.clone()))
            })
            .collect();
        let (tx, rx) = mpsc::channel();
        let sistema_vigilado = sistema.clone();
        let mut vigia = notify::recommended_watcher(move |aviso: notify::Result<notify::Event>| {
            use notify::event::{AccessKind, AccessMode, EventKind};

            let aviso = aviso.map(|mut evento| {
                // En Linux hasta abrir la Base para buscar genera un aviso de acceso.
                if matches!(evento.kind, EventKind::Access(_))
                    && evento.kind != EventKind::Access(AccessKind::Close(AccessMode::Write))
                {
                    evento.paths.clear();
                }
                #[cfg(target_os = "macos")]
                for ruta in &mut evento.paths {
                    // FSEvents devuelve rutas canónicas, incluso para /var y /tmp.
                    if let Some((base, relativa)) = rutas_reales
                        .iter()
                        .filter_map(|(real, base)| Some((base, ruta.strip_prefix(real).ok()?)))
                        .max_by_key(|(_, relativa)| std::cmp::Reverse(relativa.components().count()))
                    {
                        *ruta = base.join(relativa);
                    }
                }
                evento.paths.retain(|ruta| !ruta.starts_with(&sistema_vigilado));
                evento
            });
            if aviso.as_ref().map_or(true, |evento| !evento.paths.is_empty()) {
                let _ = tx.send(aviso);
            }
        })?;
        let mut sin_avisos: Vec<PathBuf> = Vec::new();
        for lugar in &lugares {
            if let Err(e) = vigia.watch(lugar, RecursiveMode::Recursive) {
                log(&format!("{}: sin avisos del sistema ({e}); se revisa cada 10 min.", lugar.display()));
                sin_avisos.push(lugar.clone());
            }
        }
        let firma_inicio = fs::read_to_string(&inicio).unwrap_or_default();
        let mut pendientes_ev: BTreeSet<PathBuf> = BTreeSet::new();
        let mut ultimo_evento: Option<Instant> = None;
        let mut ultima_revision = Instant::now();

        // 3. Lee el contenido en segundo plano mientras atiende avisos.
        let iniciales = indice::siguientes_pendientes(&c, TANDA_LECTURA)?;
        let mut lectura = if iniciales.is_empty() {
            indice::compactar_memoria(&c);
            None
        } else {
            Some(iniciar_tanda(iniciales, 0, 0, 0, Instant::now()))
        };

        'vigilia: loop {
            if let Some(ref mut lec) = lectura {
                // Drena avisos disponibles sin esperar.
                loop {
                    match rx.try_recv() {
                        Ok(Ok(evento)) => {
                            if !evento.paths.is_empty() {
                                pendientes_ev.extend(evento.paths);
                                ultimo_evento = Some(Instant::now());
                            }
                        }
                        Ok(Err(e)) => log(&format!("Aviso del sistema con error: {e}")),
                        Err(mpsc::TryRecvError::Empty) => break,
                        Err(mpsc::TryRecvError::Disconnected) => break 'vigilia,
                    }
                }

                // Guarda una tanda corta de lecturas para no bloquear ni a buscar ni a notify.
                let mut lote = Vec::with_capacity(64);
                let mut termino_tanda = false;
                match lec.rx.recv_timeout(Duration::from_millis(150)) {
                    Ok(item) => {
                        lote.push(item);
                        while lote.len() < 64 {
                            match lec.rx.try_recv() {
                                Ok(item) => lote.push(item),
                                Err(mpsc::TryRecvError::Empty) => break,
                                Err(mpsc::TryRecvError::Disconnected) => {
                                    termino_tanda = true;
                                    break;
                                }
                            }
                        }
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                    Err(mpsc::RecvTimeoutError::Disconnected) => termino_tanda = true,
                }
                if !lote.is_empty() {
                    let (lc, le, _) = indice::guardar_lote_contenido(&c, &lote)?;
                    lec.leidos += lc;
                    lec.enlaces_leidos += le;
                }
                if termino_tanda {
                    if let Some(h) = lec.hilo.take() {
                        let _ = h.join();
                    }
                    let siguientes = indice::siguientes_pendientes(&c, TANDA_LECTURA)?;
                    if siguientes.is_empty() {
                        let total_leidos = lec.leidos + lec.enlaces_leidos;
                        let fallidos = lec.intentados.saturating_sub(total_leidos);
                        let segs = lec.inicio.elapsed().as_secs_f64();
                        if lec.enlaces_leidos > 0 && lec.leidos == 0 {
                            log(&format!(
                                "Enlaces al día: {} archivos Markdown ({fallidos} sin poder leer) · {segs:.1} s",
                                lec.enlaces_leidos
                            ));
                        } else if lec.enlaces_leidos > 0 {
                            log(&format!(
                                "Contenido al día: {} archivos de texto y {} Markdown de enlaces ({fallidos} sin poder leer) · {segs:.1} s",
                                lec.leidos, lec.enlaces_leidos
                            ));
                        } else {
                            log(&format!(
                                "Contenido al día: {} archivos de texto ({fallidos} sin poder leer) · {segs:.1} s",
                                lec.leidos
                            ));
                        }
                        indice::compactar_memoria(&c);
                        lectura = None;
                    } else {
                        let (leidos, enlaces_leidos, intentados, t0) =
                            (lec.leidos, lec.enlaces_leidos, lec.intentados, lec.inicio);
                        lectura = Some(iniciar_tanda(siguientes, leidos, enlaces_leidos, intentados, t0));
                    }
                }
            } else {
                // En reposo: espera bloqueado sin consumir CPU.
                let espera = if let Some(t) = ultimo_evento {
                    Some(CALMA.saturating_sub(t.elapsed()))
                } else if !sin_avisos.is_empty() {
                    Some(REVISION.saturating_sub(ultima_revision.elapsed()))
                } else {
                    None
                };
                let recibido = match espera {
                    Some(d) => match rx.recv_timeout(d) {
                        Ok(ev) => Some(ev),
                        Err(mpsc::RecvTimeoutError::Timeout) => None,
                        Err(mpsc::RecvTimeoutError::Disconnected) => break 'vigilia,
                    },
                    None => match rx.recv() {
                        Ok(ev) => Some(ev),
                        Err(_) => break 'vigilia,
                    },
                };
                if let Some(ev) = recibido {
                    match ev {
                        Ok(evento) => {
                            if !evento.paths.is_empty() {
                                pendientes_ev.extend(evento.paths);
                                ultimo_evento = Some(Instant::now());
                            }
                        }
                        Err(e) => log(&format!("Aviso del sistema con error: {e}")),
                    }
                    loop {
                        match rx.try_recv() {
                            Ok(Ok(evento)) => {
                                if !evento.paths.is_empty() {
                                    pendientes_ev.extend(evento.paths);
                                    ultimo_evento = Some(Instant::now());
                                }
                            }
                            Ok(Err(e)) => log(&format!("Aviso del sistema con error: {e}")),
                            Err(mpsc::TryRecvError::Empty) => break,
                            Err(mpsc::TryRecvError::Disconnected) => break 'vigilia,
                        }
                    }
                }
            }

            // Atiende los avisos acumulados en cuanto pase la calma.
            if !pendientes_ev.is_empty() && ultimo_evento.map_or(false, |t| t.elapsed() >= CALMA) {
                ultimo_evento = None;
                let rutas = std::mem::take(&mut pendientes_ev);
                let mut reindexar = false;
                for ruta in rutas {
                    if ruta == inicio
                        && fs::read_to_string(&inicio).unwrap_or_default() != firma_inicio
                        && lugares::lugares(raiz) != lugares
                    {
                        log("Inicio.md cambió sus lugares: se vuelven a indexar.");
                        reindexar = true;
                        break;
                    }
                    let Some(lugar) =
                        lugares.iter().filter(|l| ruta.starts_with(l)).max_by_key(|l| l.as_os_str().len())
                    else {
                        continue;
                    };
                    if !indice::entra(lugar, &ruta, &sistema) {
                        continue;
                    }
                    if ruta.is_dir() && indice::en_indice(&c, &ruta)? {
                        continue;
                    }
                    if let Err(e) = indice::catalogar(&c, lugar, &ruta, &sistema, &mut log) {
                        log(&format!("{}: {e}", ruta.display()));
                    }
                }
                if reindexar {
                    drop(lectura);
                    break 'vigilia;
                }
                if lectura.is_none() {
                    let nuevos = indice::siguientes_pendientes(&c, TANDA_LECTURA)?;
                    if !nuevos.is_empty() {
                        lectura = Some(iniciar_tanda(nuevos, 0, 0, 0, Instant::now()));
                    }
                }
            }

            if !sin_avisos.is_empty() && ultima_revision.elapsed() >= REVISION {
                for lugar in &sin_avisos {
                    indice::catalogar(&c, lugar, lugar, &sistema, &mut log)?;
                }
                ultima_revision = Instant::now();
                if lectura.is_none() {
                    let nuevos = indice::siguientes_pendientes(&c, TANDA_LECTURA)?;
                    if !nuevos.is_empty() {
                        lectura = Some(iniciar_tanda(nuevos, 0, 0, 0, Instant::now()));
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cita_argumentos_windows() {
        assert_eq!(citar_win("C:\\Mind\\mind.exe"), "C:\\Mind\\mind.exe");
        assert_eq!(
            citar_win("C:\\Users\\Ana Torres\\My Mind"),
            "\"C:\\Users\\Ana Torres\\My Mind\""
        );
        assert_eq!(citar_win("C:\\Con espacio\\"), "\"C:\\Con espacio\\\\\"");
    }
}
