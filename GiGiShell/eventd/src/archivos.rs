//! Integridad de ficheros: port de `monitor_files` de oom-monitor.sh con inotify
//! nativo en vez de `inotifywait -m` + subshell + tubería.
//!
//! Se vigilan los DIRECTORIOS padre y se filtra por nombre, para cazar también los
//! reemplazos atómicos (write-temp + rename) de passwd/visudo/editores. Mismas rutas,
//! mismas categorías y misma desviación a «Actualización del sistema» mientras dura
//! una transacción de paquetes; los porqués están en el bash.

use std::ffi::CString;
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use crate::notif::{notificar, Agrupador, Grupo, Salida, CALMA, TOPE};
use crate::sistema::{home, Config, Entorno, Real};

/// Ventana ANCHA durante una actualización: un `pacman -Syu` de tres minutos sale en
/// una sola tarjeta al terminar, no en una cada 20 s.
const PKG_CALMA: Duration = Duration::from_secs(30);
const PKG_TOPE: Duration = Duration::from_secs(900);

#[derive(Debug, PartialEq, Eq)]
pub enum Clase {
    Critico,
    Persistencia,
    ClaveSsh,
    Boot,
    Nada,
}

/// Artefactos del gestor de paquetes: nunca son el evento (un `.pacnew` existe
/// precisamente para NO tocar el fichero activo).
pub fn es_artefacto_de_paquetes(ruta: &str) -> bool {
    const SUFIJOS: &[&str] = &[
        ".pacnew", ".pacsave", ".pacorig", ".dpkg-new", ".dpkg-dist", ".dpkg-old", ".dpkg-tmp",
        ".rpmnew", ".rpmsave", ".rpmorig", "~",
    ];
    if SUFIJOS.iter().any(|s| ruta.ends_with(s)) {
        return true;
    }
    // *.pacsave.[0-9]
    let b = ruta.as_bytes();
    b.len() > 10 && b[b.len() - 1].is_ascii_digit() && ruta[..ruta.len() - 1].ends_with(".pacsave.")
}

pub fn clasificar(ruta: &str, home: &str) -> Clase {
    const CRITICOS: &[&str] = &[
        "/etc/passwd", "/etc/shadow", "/etc/group", "/etc/gshadow", "/etc/hosts", "/etc/sudoers",
        "/etc/ld.so.preload", "/etc/ssh/sshd_config",
    ];
    if CRITICOS.contains(&ruta) {
        return Clase::Critico;
    }
    let persist = [
        "/etc/sudoers.d/".to_string(),
        "/etc/pam.d/".into(),
        "/etc/cron.d/".into(),
        "/etc/systemd/system/".into(),
        format!("{home}/.config/autostart/"),
        format!("{home}/.config/systemd/user/"),
    ];
    if persist.iter().any(|p| ruta.starts_with(p.as_str())) {
        return Clase::Persistencia;
    }
    if es_clave_ssh(ruta, home) {
        return Clase::ClaveSsh;
    }
    if ruta.starts_with("/boot/") {
        return Clase::Boot;
    }
    Clase::Nada
}

fn es_clave_ssh(ruta: &str, home: &str) -> bool {
    ruta == format!("{home}/.ssh/authorized_keys") || ruta == format!("{home}/.ssh/authorized_keys2")
}

fn directorios(home: &Path) -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = [
        "/etc", "/etc/pam.d", "/etc/sudoers.d", "/etc/ssh", "/etc/cron.d", "/etc/systemd/system", "/boot",
    ]
    .iter()
    .map(PathBuf::from)
    .collect();
    v.extend([".ssh", ".config/autostart", ".config/systemd/user"].iter().map(|d| home.join(d)));
    // Solo lo que se puede vigilar de verdad (-r -x): /etc/sudoers.d o /boot son de
    // root en muchas máquinas. A diferencia de inotifywait, un watch que falla no tumba
    // a los demás, pero así el comportamiento coincide con el bash.
    v.retain(|d| {
        CString::new(d.as_os_str().as_bytes())
            .is_ok_and(|c| d.is_dir() && unsafe { libc::access(c.as_ptr(), libc::R_OK | libc::X_OK) } == 0)
    });
    v
}

pub fn correr(salida: Salida) {
    let home = home();
    let home_s = home.to_string_lossy().into_owned();
    let mut cfg = Config::new(home.join(".config/gigishell/security.json"));
    let mut env = Real::default();

    let fd = unsafe { libc::inotify_init1(libc::IN_CLOEXEC) };
    if fd < 0 {
        notificar(salida, "monitor.sin-inotify", "normal", "oom-monitor",
            "No se pudo iniciar inotify. Vigilancia de archivos desactivada.", 10000);
        return;
    }
    let mut watches: Vec<(i32, String)> = vec![];
    for d in directorios(&home) {
        let c = CString::new(d.as_os_str().as_bytes()).unwrap();
        let wd = unsafe {
            libc::inotify_add_watch(fd, c.as_ptr(), libc::IN_CLOSE_WRITE | libc::IN_MOVED_TO | libc::IN_CREATE)
        };
        if wd >= 0 {
            watches.push((wd, d.to_string_lossy().into_owned()));
        }
    }
    if watches.is_empty() {
        return;
    }

    let mut a = Agrupador::new(salida);
    let g = |evento, urgencia, tmo_ms, titulo, plural, prefijo, sufijo| Grupo {
        evento, urgencia, tmo_ms, titulo, plural, prefijo, sufijo,
    };
    a.registrar("fcrit", g("archivos.critico-modificado", "critical", 0, "Archivo crítico modificado", "archivos críticos modificados", "Archivo: ", ""));
    a.registrar("fpersist", g("archivos.persistencia", "critical", 0, "Posible persistencia", "cambios de posible persistencia", "Nuevo/modificado: ", ""));
    a.registrar("fssh", g("archivos.clave-ssh", "critical", 0, "Clave SSH autorizada modificada", "cambios en claves SSH autorizadas", "Archivo: ", ""));
    a.registrar("fboot", g("archivos.boot", "normal", 15000, "Cambio en /boot", "cambios en /boot", "Archivo: ", " (kernel/initramfs)"));
    a.registrar("fpkg", g("archivos.actualizacion", "low", 15000, "Actualización del sistema", "archivos de sistema actualizados", "Archivo: ", ""));
    for c in ["fcrit", "fpersist", "fssh", "fboot", "fpkg"] {
        a.marcar_unica(c);
    }

    let mut en_tx = false;
    let mut ventana = |a: &mut Agrupador, env: &mut Real| {
        let tx = env.pkg_tx_activa();
        if tx != en_tx {
            en_tx = tx;
            if tx { a.ventana(PKG_CALMA, PKG_TOPE) } else { a.ventana(CALMA, TOPE) }
        }
        tx
    };

    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let plazo = a.plazo(Instant::now());
        let ms = plazo.map(|d| d.as_millis().clamp(1, i32::MAX as u128) as i32).unwrap_or(-1);
        let mut pfd = libc::pollfd { fd, events: libc::POLLIN, revents: 0 };
        let r = unsafe { libc::poll(&mut pfd, 1, ms) };
        if r < 0 {
            if std::io::Error::last_os_error().raw_os_error() == Some(libc::EINTR) {
                continue;
            }
            return;
        }
        if r > 0 {
            let n = unsafe { libc::read(fd, buf.as_mut_ptr().cast(), buf.len()) };
            if n <= 0 {
                continue;
            }
            let ahora = Instant::now();
            cfg.recargar(ahora);
            for ruta in rutas_de_eventos(&buf[..n as usize], &watches) {
                if !cfg.activo("fileIntegrity") || es_artefacto_de_paquetes(&ruta) {
                    continue;
                }
                let clase = clasificar(&ruta, &home_s);
                if ventana(&mut a, &mut env) {
                    // Las claves SSH no las escribe ningún paquete: siguen siendo críticas.
                    let cat = if es_clave_ssh(&ruta, &home_s) { "fssh" } else { "fpkg" };
                    a.encolar(cat, &ruta, ahora);
                    continue;
                }
                let cat = match clase {
                    Clase::Critico => "fcrit",
                    Clase::Persistencia => "fpersist",
                    Clase::ClaveSsh => "fssh",
                    Clase::Boot => "fboot",
                    Clase::Nada => continue,
                };
                a.encolar(cat, &ruta, ahora);
            }
        }
        let antes = a.plazo(Instant::now()).is_some();
        a.volcar(Instant::now(), false);
        if antes && a.plazo(Instant::now()).is_none() {
            ventana(&mut a, &mut env); // volcado hecho: si la actualización acabó, ventana normal
        }
    }
}

/// Recorre el buffer de `struct inotify_event` y devuelve `<dir>/<nombre>`.
fn rutas_de_eventos(buf: &[u8], watches: &[(i32, String)]) -> Vec<String> {
    let cab = std::mem::size_of::<libc::inotify_event>();
    let mut out = vec![];
    let mut i = 0;
    while i + cab <= buf.len() {
        let ev: libc::inotify_event = unsafe { std::ptr::read_unaligned(buf[i..].as_ptr().cast()) };
        let nombre_bytes = &buf[i + cab..(i + cab + ev.len as usize).min(buf.len())];
        let fin = nombre_bytes.iter().position(|&b| b == 0).unwrap_or(nombre_bytes.len());
        let nombre = String::from_utf8_lossy(&nombre_bytes[..fin]);
        if let Some((_, dir)) = watches.iter().find(|(wd, _)| *wd == ev.wd) {
            if !nombre.is_empty() {
                out.push(format!("{}/{}", dir.trim_end_matches('/'), nombre));
            }
        }
        i += cab + ev.len as usize;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clases() {
        let h = "/home/u";
        assert_eq!(clasificar("/etc/shadow", h), Clase::Critico);
        assert_eq!(clasificar("/etc/pam.d/sudo", h), Clase::Persistencia);
        assert_eq!(clasificar("/home/u/.config/autostart/x.desktop", h), Clase::Persistencia);
        assert_eq!(clasificar("/home/u/.ssh/authorized_keys", h), Clase::ClaveSsh);
        assert_eq!(clasificar("/home/u/.ssh/known_hosts", h), Clase::Nada);
        assert_eq!(clasificar("/boot/vmlinuz-linux", h), Clase::Boot);
        assert_eq!(clasificar("/etc/hostname", h), Clase::Nada);
    }

    #[test]
    fn artefactos() {
        assert!(es_artefacto_de_paquetes("/etc/pam.d/system-auth.pacnew"));
        assert!(es_artefacto_de_paquetes("/etc/passwd.pacsave.1"));
        assert!(es_artefacto_de_paquetes("/etc/hosts~"));
        assert!(!es_artefacto_de_paquetes("/etc/passwd"));
    }

    #[test]
    fn create_y_close_write_son_un_cambio() {
        let mut a = Agrupador::new(Salida::Simulado);
        a.registrar("f", Grupo { evento: "a.b", urgencia: "low", tmo_ms: 0, titulo: "T", plural: "p", prefijo: "", sufijo: "" });
        a.marcar_unica("f");
        let t = Instant::now();
        a.encolar("f", "/etc/passwd", t);
        a.encolar("f", "/etc/passwd", t);
        assert_eq!(a.total("f"), 1);
    }
}
