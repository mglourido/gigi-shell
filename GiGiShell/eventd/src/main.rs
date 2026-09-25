//! gigishell-eventd — monitor de eventos de seguridad de GiGiShell.
//!
//! Sustituye a los seis sub-monitores de hypr/scripts/oom-monitor.sh: el journal por
//! sd-journal en el hilo principal, y un hilo para archivos (inotify), unidades, SMART
//! y el escáner de Descargas. Mismas reglas, mismos ids de aviso y misma agrupación en
//! ráfaga. Lo lanza oom-monitor.sh, que pregunta con `--modulos` qué cubre este
//! binario: si lo cubre todo le hace `exec` (no queda ningún bash), si no, lo lanza
//! como hijo con `--hijo` y corre en bash el resto. Sin el binario instalado, el bash
//! sigue haciéndolo todo como siempre.
//!
//! DOS procesos, a propósito: un SUPERVISOR mínimo y el TRABAJADOR que hace todo. En el
//! bash cada monitor era un proceso aparte y uno que muriera no se llevaba a los demás;
//! aquí van en hilos de un solo proceso, y un aborto en cualquiera (con `panic =
//! "abort"`, o un OOM) los tumba a todos. Quedarse sin vigilancia SIN SABERLO es el peor
//! fallo posible de este programa, así que el supervisor relanza al trabajador, avisa
//! de cada caída y, si cae en bucle, le devuelve el trabajo al bash.
//!
//! Uso:
//!   gigishell-eventd              supervisor + trabajador, notificando
//!   gigishell-eventd --simular    solo el trabajador, imprimiendo los avisos en vez de
//!                                 mandarlos y sin escribir estado en disco
//!   gigishell-eventd --hijo       lanzado por oom-monitor.sh junto a monitores bash:
//!                                 morir con él
//!   gigishell-eventd --modulos    listar los sub-monitores del bash que sustituye
//!   gigishell-eventd --stdin      leer líneas de stdin ("kernel: …" o "ident[pid]: …")
//!                                 en vez del journal; implica --simular

mod archivos;
mod descargas;
mod journal;
mod notif;
mod reglas;
mod sistema;
mod sondeos;
mod xxh64;

use std::io::{BufRead, Write};
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::path::PathBuf;
use std::process::Command;
use std::time::{Duration, Instant};

use notif::{hilo, log, notificar, Salida};
use reglas::Monitor;
use sistema::{home, Config, Real};

/// Contrato con oom-monitor.sh: nombres de sus funciones `monitor_<x>` que este
/// binario hace. Un binario viejo con un script nuevo (o al revés) nunca deja un
/// sub-monitor sin nadie que lo corra.
const MODULOS: &[&str] = &["kernel", "system", "files", "units", "smart", "downloads"];

/// Caídas toleradas en la ventana antes de rendirse y volver al bash.
const CAIDAS_MAX: usize = 5;
const CAIDAS_VENTANA: Duration = Duration::from_secs(600);
const ESPERA_REINICIO: Duration = Duration::from_secs(5);

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| a == "--modulos") {
        let _ = writeln!(std::io::stdout(), "{}", MODULOS.join(" "));
        return;
    }
    let tiene = |x: &str| args.iter().any(|a| a == x);
    if let Some(a) = args.iter().find(|a| !matches!(a.as_str(), "--stdin" | "--simular" | "--hijo" | "--trabajador")) {
        log(&format!("argumento desconocido: {a}"));
        std::process::exit(2);
    }

    if tiene("--stdin") {
        let mut m = Monitor::new(config(), Real::default(), Salida::Simulado);
        let t = Instant::now();
        for linea in std::io::stdin().lock().lines().map_while(Result::ok) {
            m.procesar(linea.starts_with("kernel: "), &linea, t);
        }
        m.volcar(t, true);
        return;
    }
    if tiene("--simular") {
        trabajar(Salida::Simulado);
    }
    if tiene("--trabajador") {
        // El padre es SIEMPRE el supervisor: si muere, este no debe quedarse suelto.
        morir_con_el_padre();
        // Lanzado como /proc/self/exe, el kernel le pondría de nombre «exe»: se le da el
        // mismo que al supervisor para que `pkill -x gigishell-event` y `ps` lo encuentren.
        unsafe { libc::prctl(libc::PR_SET_NAME, c"gigishell-event".as_ptr()) };
        trabajar(Salida::Real);
    }

    if tiene("--hijo") {
        morir_con_el_padre();
    }
    instancia_unica();
    supervisar();
}

fn config() -> Config {
    Config::new(home().join(".config/gigishell/security.json"))
}

// ── Supervisor ────────────────────────────────────────────────────────────────

fn motivo(st: std::process::ExitStatus) -> String {
    match (st.code(), st.signal()) {
        (_, Some(9)) => "matado con SIGKILL, probablemente por falta de memoria".into(),
        (_, Some(6)) => "abortó por un error interno".into(),
        (_, Some(s)) => format!("señal {s}"),
        (Some(c), _) => format!("código {c}"),
        _ => "motivo desconocido".into(),
    }
}

fn supervisar() -> ! {
    let mut caidas: Vec<Instant> = vec![];
    loop {
        // /proc/self/exe y no la ruta del binario: `instalar.sh` sustituye el fichero
        // (unlink + nuevo), y la ruta vieja pasaría a ser "… (deleted)". Así el
        // relanzado es siempre el mismo código que el supervisor.
        let argv0 = std::env::args_os().next().unwrap_or_else(|| "gigishell-eventd".into());
        let resultado = Command::new("/proc/self/exe").arg0(argv0).arg("--trabajador").status();
        let razon = match resultado {
            Ok(st) => motivo(st),
            Err(e) => format!("no se pudo lanzar: {e}"),
        };
        let ahora = Instant::now();
        caidas.retain(|t| ahora.duration_since(*t) < CAIDAS_VENTANA);
        caidas.push(ahora);
        log(&format!("el trabajador terminó ({razon})"));

        if caidas.len() >= CAIDAS_MAX {
            notificar(Salida::Real, "monitor.fallo", "critical", "Monitor de seguridad inestable",
                &format!("gigishell-eventd se ha caído {} veces en 10 minutos (la última: {razon}). Se vuelve a los monitores bash de oom-monitor.sh.", caidas.len()),
                0);
            volver_al_bash();
        }
        notificar(Salida::Real, "monitor.fallo", "normal", "Monitor de seguridad reiniciado",
            &format!("gigishell-eventd se cerró inesperadamente ({razon}) y se ha relanzado. Los eventos de esos segundos pueden haberse perdido."),
            15000);
        std::thread::sleep(ESPERA_REINICIO);
    }
}

/// Último recurso: cederle el proceso al bash con el daemon desactivado. `exec`
/// conserva el pid, y el cerrojo (O_CLOEXEC) se suelta solo.
fn volver_al_bash() -> ! {
    let script = home().join(".config/hypr/scripts/oom-monitor.sh");
    let e = Command::new(&script).env("GIGISHELL_EVENTD", "0").exec();
    log(&format!("no se pudo volver a {}: {e}", script.display()));
    notificar(Salida::Real, "monitor.fallo", "critical", "Monitor de seguridad detenido",
        "gigishell-eventd no funciona y no se pudo volver a oom-monitor.sh: NO hay vigilancia de seguridad en esta sesión.",
        0);
    std::process::exit(1);
}

// ── Trabajador ────────────────────────────────────────────────────────────────

fn trabajar(salida: Salida) -> ! {
    // Los seguidores de eventos enganchan YA (inotify no guarda lo pasado); los
    // sondeos se retrasan por dentro, como los DELAY_* del bash.
    hilo("archivos", move || archivos::correr(salida));
    hilo("unidades", move || sondeos::unidades(salida));
    hilo("smart", move || sondeos::smart(salida));
    hilo("descargas", move || descargas::correr(salida));

    let mut m = Monitor::new(config(), Real::default(), salida);
    // Si el journal falla, el proceso NO sale: se llevaría por delante los hilos de
    // archivos y sondeos, que no dependen de él. Pero tampoco se calla: sin journal no
    // hay avisos de OOM, sudo, SSH ni errores de disco, y eso tiene que saberse.
    if let Err(e) = seguir_journal(&mut m) {
        log(&e);
        notificar(salida, "monitor.fallo", "critical", "Monitor de seguridad sin journal",
            &format!("No se puede leer el journal ({e}): los avisos de kernel y sistema (OOM, sudo, SSH, errores de disco…) están desactivados. El resto sigue funcionando."),
            0);
    }
    loop {
        std::thread::park();
    }
}

fn seguir_journal(m: &mut Monitor<Real>) -> Result<(), String> {
    let mut j = journal::Journal::abrir()?;
    loop {
        while let Some(e) = j.siguiente()? {
            m.procesar(e.kernel, &e.linea, Instant::now());
        }
        m.volcar(Instant::now(), false);
        // Sin nada encolado se espera sin plazo: en reposo, 0 % de CPU y ningún timer.
        let plazo = m.plazo(Instant::now()).map(|d| d.as_micros().max(1) as u64);
        j.esperar(plazo)?;
    }
}

// ── Proceso ───────────────────────────────────────────────────────────────────

/// Una sola instancia por usuario, y la NUEVA gana: relanzar oom-monitor.sh (tras
/// editar algo, o un `hyprctl reload full-reset` que re-ejecuta el autostart) sustituye
/// a la que corría en vez de duplicar todos los avisos. El cerrojo es un `flock` sobre
/// un fichero con el pid del supervisor: si otro lo tiene, se le manda SIGTERM (su
/// trabajador muere con él) y se espera a que lo suelte — el kernel lo libera al morir
/// el proceso, sin ficheros rancios.
fn instancia_unica() {
    use std::io::{Read, Seek};
    use std::os::fd::AsRawFd;
    let dir = std::env::var_os("XDG_RUNTIME_DIR")
        .map(PathBuf::from)
        .filter(|d| d.is_dir())
        .unwrap_or_else(|| home().join(".cache/gigishell"));
    let _ = std::fs::create_dir_all(&dir);
    let ruta = dir.join("gigishell-eventd.pid");
    let Ok(mut f) = std::fs::OpenOptions::new().read(true).write(true).create(true).truncate(false).open(&ruta) else {
        return; // sin cerrojo se corre igual: peor duplicar que no vigilar
    };
    let fd = f.as_raw_fd();
    if unsafe { libc::flock(fd, libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        let mut s = String::new();
        let _ = f.read_to_string(&mut s);
        if let Ok(pid) = s.trim().parse::<i32>() {
            if pid > 1 && pid != std::process::id() as i32 {
                unsafe { libc::kill(pid, libc::SIGTERM) };
            }
        }
        unsafe { libc::flock(fd, libc::LOCK_EX) };
    }
    let _ = f.set_len(0);
    let _ = f.rewind();
    let _ = write!(f, "{}", std::process::id());
    // El descriptor se queda abierto (y con él el cerrojo) toda la vida del proceso.
    std::mem::forget(f);
}

/// Morir cuando muera el padre (PR_SET_PDEATHSIG). Se pide en dos casos: el trabajador
/// respecto a su supervisor, y el supervisor lanzado con `--hijo` respecto a
/// oom-monitor.sh (el bash tuvo que montar traps y `_recoger_huerfanos` porque sus
/// `journalctl -f` quedaban huérfanos; aquí lo resuelve el kernel). Tras un `exec` NO se
/// pide: no hay bash que seguir, y el padre que haya (un `sh -c` de paso, un `setsid`)
/// puede morir en cualquier momento sin que eso signifique nada. Si el padre ya había
/// muerto antes de pedirlo, se sale.
fn morir_con_el_padre() {
    unsafe {
        let padre = libc::getppid();
        libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM);
        if libc::getppid() != padre {
            std::process::exit(0);
        }
    }
}
