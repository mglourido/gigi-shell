//! gigishell-eventd — monitor de eventos del journal de GiGiShell.
//!
//! Sustituye a los seis sub-monitores de hypr/scripts/oom-monitor.sh con un solo
//! proceso: el journal por sd-journal en el hilo principal, y un hilo para archivos
//! (inotify), unidades, SMART y el escáner de Descargas. Mismas reglas, mismos ids
//! de aviso y misma agrupación en ráfaga. Lo lanza oom-monitor.sh, que pregunta con
//! `--modulos` qué cubre este binario: si lo cubre todo le hace `exec` (no queda
//! ningún bash), si no, lo lanza como hijo con `--hijo` y corre en bash el resto.
//! Sin el binario instalado, el bash sigue haciéndolo todo como siempre.
//!
//! Uso:
//!   gigishell-eventd              seguir el journal y notificar
//!   gigishell-eventd --simular    igual, pero imprimir los avisos en vez de mandarlos
//!                                 (para correrlo junto al bash y comparar)
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

use std::io::BufRead;
use std::time::Instant;

use notif::Salida;
use reglas::Monitor;
use sistema::{home, Config, Real};

/// Contrato con oom-monitor.sh: nombres de sus funciones `monitor_<x>` que este
/// binario hace. Un binario viejo con un script nuevo (o al revés) nunca deja un
/// sub-monitor sin nadie que lo corra.
const MODULOS: &[&str] = &["kernel", "system", "files", "units", "smart", "downloads"];

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| a == "--modulos") {
        println!("{}", MODULOS.join(" "));
        return;
    }
    let stdin = args.iter().any(|a| a == "--stdin");
    let salida = if stdin || args.iter().any(|a| a == "--simular") { Salida::Simulado } else { Salida::Real };
    if let Some(a) = args.iter().find(|a| !matches!(a.as_str(), "--stdin" | "--simular" | "--hijo")) {
        eprintln!("gigishell-eventd: argumento desconocido: {a}");
        std::process::exit(2);
    }

    if args.iter().any(|a| a == "--hijo") {
        morir_con_el_padre();
    }
    if salida == Salida::Real {
        instancia_unica();
    }

    let cfg = Config::new(home().join(".config/gigishell/security.json"));
    let mut m = Monitor::new(cfg, Real::default(), salida);

    if stdin {
        let t = Instant::now();
        for linea in std::io::stdin().lock().lines().map_while(Result::ok) {
            m.procesar(linea.starts_with("kernel: "), &linea, t);
        }
        m.volcar(t, true);
        return;
    }

    // Los seguidores de eventos enganchan YA (inotify no guarda lo pasado); los
    // sondeos se retrasan por dentro, como los DELAY_* del bash.
    std::thread::spawn(move || archivos::correr(salida));
    std::thread::spawn(move || sondeos::unidades(salida));
    std::thread::spawn(move || sondeos::smart(salida));
    std::thread::spawn(move || descargas::correr(salida));

    // Si el journal falla, el proceso NO sale: se llevaría por delante los hilos de
    // archivos y sondeos, que no dependen de él. Se queda aparcado y lo dice.
    if let Err(e) = seguir_journal(&mut m) {
        // Sin acceso al journal (usuario fuera de systemd-journal/wheel) el bash
        // tampoco veía nada: journalctl devolvía vacío. Aquí al menos queda dicho.
        eprintln!("gigishell-eventd: {e}");
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

/// Una sola instancia por usuario, y la NUEVA gana: relanzar oom-monitor.sh (tras
/// editar algo, o un `hyprctl reload full-reset` que re-ejecuta el autostart) sustituye
/// a la que corría en vez de duplicar todos los avisos. El cerrojo es un `flock` sobre
/// un fichero con el pid: si otro lo tiene, se le manda SIGTERM y se espera a que lo
/// suelte (el kernel lo libera al morir el proceso, sin ficheros rancios).
fn instancia_unica() {
    use std::io::{Read, Seek, Write};
    use std::os::fd::AsRawFd;
    let dir = std::env::var_os("XDG_RUNTIME_DIR").map(std::path::PathBuf::from).unwrap_or_else(std::env::temp_dir);
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

/// Que el daemon no sobreviva a oom-monitor.sh cuando corre como HIJO suyo (junto a
/// monitores bash). El bash tuvo que montar traps,
/// `_matar_descendientes` y `_recoger_huerfanos` porque sus `journalctl -f` quedaban
/// huérfanos tras un `pkill -f oom-monitor.sh`; aquí lo resuelve el kernel: al morir el
/// padre llega un SIGTERM. Si el padre ya había muerto antes de pedirlo, se sale.
/// Tras un `exec` no se pide: no hay padre bash que seguir, y el que haya (un `sh -c`
/// de paso, un `setsid`) puede morir en cualquier momento sin que eso signifique nada.
fn morir_con_el_padre() {
    unsafe {
        let padre = libc::getppid();
        libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM);
        if libc::getppid() != padre {
            std::process::exit(0);
        }
    }
}
