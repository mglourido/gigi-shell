//! Integridad de ficheros: port de `monitor_files` de oom-monitor.sh con inotify
//! nativo en vez de `inotifywait -m` + subshell + tubería.
//!
//! Se vigilan los DIRECTORIOS padre y se filtra por nombre, para cazar también los
//! reemplazos atómicos (write-temp + rename) de passwd/visudo/editores. Mismas rutas,
//! mismas categorías y misma desviación a «Actualización del sistema» mientras dura
//! una transacción de paquetes; los porqués están en el bash.
//!
//! Tres cosas que inotify no da solo y resuelve `Vigilancia::revisar`: subcarpetas
//! (`systemctl enable` escribe en `*.wants/`), carpetas que aparecen después de arrancar
//! (`~/.ssh`) y las que no se pueden leer sin root (`/etc/sudoers.d`), de las que solo
//! se ve la fecha.

use std::collections::HashMap;
use std::ffi::CString;
use std::fs;
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};

use crate::notif::{notificar, Agrupador, Grupo, Salida, CALMA, TOPE};
use crate::sistema::{home, Config, Entorno, Real, PKG_GRACIA};

/// Ventana ANCHA durante una actualización: un `pacman -Syu` de tres minutos sale en
/// una sola tarjeta al terminar, no en una cada 20 s.
const PKG_CALMA: Duration = Duration::from_secs(30);
const PKG_TOPE: Duration = Duration::from_secs(900);

/// Cada cuánto se repasan las carpetas. Esto no vigila ficheros, que siguen yendo por
/// inotify: solo recoge lo que inotify no puede avisar (ver `Vigilancia::revisar`).
const REVISION: Duration = Duration::from_secs(600);
/// `foo.target.wants/` y `foo.service.d/` son un nivel; el margen es para no recorrer
/// sin límite un árbol que alguien haya llenado a propósito.
const PROFUNDIDAD: usize = 4;

/// El registro de pacman, donde consta cuándo hubo transacciones de verdad.
const LOG_PACMAN: &str = "/var/log/pacman.log";
/// Una carpeta ciega se mira como mucho 10 min tarde: el final del log basta.
const LOG_PACMAN_FINAL: u64 = 256 * 1024;
/// Para los gestores sin registro: sus bases de datos cambian al instalar o quitar.
const BASES_DE_PAQUETES: &[&str] = &["/var/lib/pacman/local", "/var/lib/dpkg/status", "/var/lib/rpm"];

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

/// Temporales de editor: `.foo.swp` y `4913` de vim, `.foo.kate-swp`, `.#foo` de emacs y
/// de `systemctl edit`. Lo que vale es el fichero que se guarda después. Ningún lector de
/// estas rutas carga un oculto, pero cron sí ejecutaría un `4913`: ahí no se descarta.
pub fn es_temporal_de_editor(ruta: &str) -> bool {
    let n = ruta.rsplit('/').next().unwrap_or(ruta);
    let b = n.as_bytes();
    let oculto = b.first() == Some(&b'.');
    let swap = b.len() > 4 && b[b.len() - 4..b.len() - 1] == *b".sw" && b[b.len() - 1].is_ascii_lowercase();
    (oculto && (swap || n.ends_with(".kate-swp")))
        || n.starts_with(".#")
        || (n == "4913" && !ruta.starts_with("/etc/cron") && !ruta.starts_with("/var/spool/cron"))
}

pub fn clasificar(ruta: &str, home: &str) -> Clase {
    const CRITICOS: &[&str] = &[
        "/etc/passwd", "/etc/shadow", "/etc/group", "/etc/gshadow", "/etc/hosts", "/etc/sudoers",
        "/etc/ld.so.preload", "/etc/ld.so.conf", "/etc/nsswitch.conf", "/etc/environment",
        "/etc/ssh/sshd_config",
    ];
    if CRITICOS.contains(&ruta) {
        return Clase::Critico;
    }
    const PERSIST_FICHEROS: &[&str] = &["/etc/crontab", "/etc/profile", "/etc/bash.bashrc"];
    const PERSIST_CARPETAS: &[&str] = &[
        "/etc/sudoers.d/", "/etc/pam.d/", "/etc/ssh/sshd_config.d/", "/etc/polkit-1/rules.d/",
        "/etc/cron.d/", "/etc/cron.hourly/", "/etc/cron.daily/", "/etc/cron.weekly/", "/etc/cron.monthly/",
        "/var/spool/cron/", "/etc/systemd/system/", "/etc/systemd/user/", "/etc/udev/rules.d/",
        "/etc/pacman.d/hooks/", "/etc/profile.d/", "/etc/xdg/autostart/", "/etc/ld.so.conf.d/",
    ];
    if PERSIST_FICHEROS.contains(&ruta)
        || PERSIST_CARPETAS.iter().any(|p| ruta.starts_with(p))
        || ruta.starts_with(&format!("{home}/.config/autostart/"))
        || ruta.starts_with(&format!("{home}/.config/systemd/user/"))
    {
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

/// Lo que ninguna actualización debe tocar: se avisa como siempre aunque haya una en
/// curso. Las rutas del usuario no solo por eso: «hay una actualización» lo decide
/// también un proceso llamado `apt`, y eso lo puede fingir cualquiera sin ser root.
fn nunca_de_paquetes(ruta: &str, home: &str) -> bool {
    ruta == "/etc/ld.so.preload" || (!home.is_empty() && ruta.starts_with(&format!("{home}/")))
}

/// Lo que los paquetes reescriben en cada actualización suya (kernel, `gawk.sh`, los
/// `.desktop` de Plasma): durante una no dice nada, y mantenerlo en la tarjeta la haría
/// salir casi siempre, que es justo lo que enseña a no leerla.
fn esperado_en_actualizacion(ruta: &str) -> bool {
    const RUTINA: &[&str] = &[
        "/boot/", "/etc/profile.d/", "/etc/xdg/autostart/", "/etc/ld.so.conf.d/", "/etc/cron.d/",
        "/etc/cron.hourly/", "/etc/cron.daily/", "/etc/cron.weekly/", "/etc/cron.monthly/",
    ];
    RUTINA.iter().any(|p| ruta.starts_with(p))
}

/// Categoría del aviso, o `None` si este cambio no merece ninguno.
fn destino(clase: &Clase, ruta: &str, home: &str, en_tx: bool) -> Option<&'static str> {
    let cat = match clase {
        Clase::Critico => "fcrit",
        Clase::Persistencia => "fpersist",
        Clase::ClaveSsh => "fssh",
        Clase::Boot => "fboot",
        Clase::Nada => return None,
    };
    if !en_tx || nunca_de_paquetes(ruta, home) {
        return Some(cat);
    }
    (!esperado_en_actualizacion(ruta)).then_some("fpkg")
}

/// `2026-10-30T12:23:11+0100` → segundos desde 1970. Sin dependencia de fechas por esto.
fn epoca_iso(ts: &str) -> Option<i64> {
    let num = |r: std::ops::Range<usize>| ts.get(r)?.parse::<i64>().ok();
    let (y, m, d) = (num(0..4)?, num(5..7)?, num(8..10)?);
    let (h, mi, se) = (num(11..13)?, num(14..16)?, num(17..19)?);
    let signo = match ts.get(19..20)? {
        "+" => 1,
        "-" => -1,
        _ => return None,
    };
    let desfase = signo * (num(20..22)? * 3600 + num(22..24)? * 60);
    // Días desde 1970 de una fecha civil (algoritmo de Howard Hinnant).
    let (ya, ma) = (if m <= 2 { y - 1 } else { y }, (m + 9) % 12);
    let era = ya.div_euclid(400);
    let yoe = ya - era * 400;
    let doy = (153 * ma + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let dias = era * 146_097 + doe - 719_468;
    Some(dias * 86_400 + h * 3600 + mi * 60 + se - desfase)
}

/// ¿El instante `t` cae en una transacción del registro de pacman? `None` si el texto no
/// trae ninguna línea `[ALPM]`. Vale el intervalo `started`..`completed` y, además, el
/// entorno de cualquier línea, porque los hooks se registran fuera de ese intervalo: unos
/// antes de `started` y otros después de `completed`. No se alarga el intervalo hasta la
/// línea siguiente: el hook previo de la próxima actualización abriría una ventana de horas.
fn en_transaccion_pacman(log: &str, t: i64) -> Option<bool> {
    let gracia = PKG_GRACIA.as_secs() as i64;
    let tope = PKG_TOPE.as_secs() as i64;
    let mut hay = false;
    let mut inicio = None;
    for l in log.lines() {
        let Some(ts) = l.strip_prefix('[').and_then(|r| r.split_once("] [ALPM] ")) else { continue };
        let Some(e) = epoca_iso(ts.0) else { continue };
        hay = true;
        if (t - e).abs() <= gracia {
            return Some(true);
        }
        let msg = ts.1;
        if msg.starts_with("transaction started") {
            // Una anterior sin cerrar (pacman cayó): se le concede el tope, no hasta aquí.
            if inicio.is_some_and(|i| i <= t && t <= i + tope) {
                return Some(true);
            }
            inicio = Some(e);
        } else if msg.starts_with("transaction ") && inicio.take().is_some_and(|i| i <= t && t <= e) {
            return Some(true);
        }
    }
    if inicio.is_some_and(|i| i <= t && t <= i + tope) {
        return Some(true);
    }
    hay.then_some(false)
}

fn final_del_log(ruta: &str) -> Option<String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = fs::File::open(ruta).ok()?;
    let largo = f.metadata().ok()?.len();
    f.seek(SeekFrom::Start(largo.saturating_sub(LOG_PACMAN_FINAL))).ok()?;
    let mut b = vec![];
    f.read_to_end(&mut b).ok()?;
    Some(String::from_utf8_lossy(&b).into_owned())
}

/// Con margen: para quien no deja registro. Es una ventana ciega aceptada por la misma
/// razón que `PKG_GRACIA`: escribir en estas carpetas ya exige ser root.
fn cerca(a: SystemTime, b: SystemTime, margen: Duration) -> bool {
    a.duration_since(b).unwrap_or_else(|e| e.duration()) <= margen
}

/// De una carpeta ciega solo se sabe CUÁNDO cambió, y se mira hasta 10 min después: la
/// transacción ya pasó, así que se busca en su registro si coincide con aquella fecha.
fn obra_de_paquetes(mtime: SystemTime) -> bool {
    let en_log = mtime.duration_since(SystemTime::UNIX_EPOCH).ok().and_then(|d| {
        en_transaccion_pacman(&final_del_log(LOG_PACMAN)?, d.as_secs() as i64)
    });
    en_log.unwrap_or_else(|| {
        BASES_DE_PAQUETES
            .iter()
            .filter_map(|b| fs::metadata(b).and_then(|m| m.modified()).ok())
            .any(|base| cerca(mtime, base, PKG_TOPE))
    })
}

struct Raiz {
    dir: PathBuf,
    /// Se vigilan también sus subcarpetas (`*.wants/`, `*.service.d/`).
    arbol: bool,
}

fn raices(home: &Path) -> Vec<Raiz> {
    let planas = [
        "/etc", "/etc/pam.d", "/etc/sudoers.d", "/etc/ssh", "/etc/ssh/sshd_config.d", "/etc/polkit-1/rules.d",
        "/etc/cron.d", "/etc/cron.hourly", "/etc/cron.daily", "/etc/cron.weekly", "/etc/cron.monthly",
        "/etc/udev/rules.d", "/etc/pacman.d/hooks", "/etc/profile.d", "/etc/xdg/autostart", "/etc/ld.so.conf.d",
        "/boot",
    ];
    // /var/spool/cron es árbol porque Debian guarda los crontabs en `crontabs/`.
    let arboles = ["/etc/systemd/system", "/etc/systemd/user", "/var/spool/cron"];
    let mut v: Vec<Raiz> = planas.iter().map(|d| Raiz { dir: d.into(), arbol: false }).collect();
    v.extend(arboles.iter().map(|d| Raiz { dir: d.into(), arbol: true }));
    v.push(Raiz { dir: home.join(".ssh"), arbol: false });
    v.push(Raiz { dir: home.join(".config/autostart"), arbol: false });
    v.push(Raiz { dir: home.join(".config/systemd/user"), arbol: true });
    v
}

fn legible(d: &Path) -> bool {
    CString::new(d.as_os_str().as_bytes())
        .is_ok_and(|c| unsafe { libc::access(c.as_ptr(), libc::R_OK | libc::X_OK) } == 0)
}

#[derive(Default)]
struct Hallazgos {
    /// Ficheros dentro de una carpeta que se acaba de empezar a vigilar.
    nuevas: Vec<String>,
    /// Carpetas sin permiso de lectura cuya fecha cambió, con esa fecha.
    ciegas: Vec<(String, SystemTime)>,
}

struct Vigilancia {
    fd: i32,
    watches: Vec<(i32, String)>,
    mtimes: HashMap<PathBuf, SystemTime>,
}

impl Vigilancia {
    /// Repasa las carpetas y pone al día los watches. Es idempotente (el kernel devuelve
    /// el mismo watch para el mismo inodo), así que sirve igual al arrancar, cada
    /// `REVISION` y cuando inotify avisa de una carpeta nueva, sin lógica aparte para cada
    /// caso. Fuera del arranque, lo que ya hubiera dentro de una carpeta nueva se devuelve
    /// como cambio: es lo que se escribió antes de que hubiera watch.
    fn revisar(&mut self, raices: &[Raiz], inicial: bool) -> Hallazgos {
        let mut h = Hallazgos::default();
        for r in raices {
            let Ok(meta) = fs::metadata(&r.dir) else {
                self.mtimes.remove(&r.dir);
                continue;
            };
            if !meta.is_dir() {
                continue;
            }
            if legible(&r.dir) {
                self.vigilar(&r.dir, r.arbol, 0, inicial, &mut h.nuevas);
            } else if let Ok(m) = meta.modified() {
                // Sin permiso de lectura no hay watch, pero la fecha sí se ve: cambia con
                // altas, bajas y renombrados. No con una edición dentro de un fichero.
                let antes = self.mtimes.insert(r.dir.clone(), m);
                if antes.map_or(!inicial, |a| a != m) {
                    h.ciegas.push((format!("{}/", r.dir.to_string_lossy()), m));
                }
            }
        }
        h
    }

    fn vigilar(&mut self, dir: &Path, arbol: bool, nivel: usize, inicial: bool, nuevas: &mut Vec<String>) {
        let Ok(c) = CString::new(dir.as_os_str().as_bytes()) else { return };
        let mascara = libc::IN_CLOSE_WRITE | libc::IN_MOVED_TO | libc::IN_CREATE | libc::IN_MOVE_SELF;
        let wd = unsafe { libc::inotify_add_watch(self.fd, c.as_ptr(), mascara) };
        if wd < 0 {
            return;
        }
        let es_nuevo = !self.watches.iter().any(|(w, _)| *w == wd);
        if es_nuevo {
            self.watches.push((wd, dir.to_string_lossy().into_owned()));
        }
        if !es_nuevo && !arbol {
            return;
        }
        let Ok(entradas) = fs::read_dir(dir) else { return };
        for e in entradas.flatten() {
            let es_dir = e.file_type().is_ok_and(|t| t.is_dir());
            if es_dir {
                if arbol && nivel < PROFUNDIDAD {
                    self.vigilar(&e.path(), true, nivel + 1, inicial, nuevas);
                }
            } else if es_nuevo && !inicial {
                nuevas.push(e.path().to_string_lossy().into_owned());
            }
        }
    }

    /// Recorre el buffer de `struct inotify_event`. Devuelve `<dir>/<nombre>` de cada
    /// fichero y si hay que repasar las carpetas: una carpeta creada no es un cambio por
    /// sí misma, pero a partir de ella hay watches que poner.
    fn leer(&mut self, buf: &[u8]) -> (Vec<String>, bool) {
        let cab = std::mem::size_of::<libc::inotify_event>();
        let mut rutas = vec![];
        let mut repasar = false;
        let mut i = 0;
        while i + cab <= buf.len() {
            let ev: libc::inotify_event = unsafe { std::ptr::read_unaligned(buf[i..].as_ptr().cast()) };
            let nombre_bytes = &buf[i + cab..(i + cab + ev.len as usize).min(buf.len())];
            let fin = nombre_bytes.iter().position(|&b| b == 0).unwrap_or(nombre_bytes.len());
            let nombre = String::from_utf8_lossy(&nombre_bytes[..fin]);
            if ev.mask & libc::IN_MOVE_SELF != 0 {
                // El watch sigue al inodo: si no se suelta, una carpeta renombrada seguiría
                // informando con la ruta vieja. Su IN_IGNORED lo saca de la lista.
                unsafe { libc::inotify_rm_watch(self.fd, ev.wd) };
                repasar = true;
            } else if ev.mask & libc::IN_IGNORED != 0 {
                self.watches.retain(|(w, _)| *w != ev.wd);
                repasar = true;
            } else if ev.mask & (libc::IN_ISDIR | libc::IN_Q_OVERFLOW) != 0 {
                repasar = true;
            } else if let Some((_, dir)) = self.watches.iter().find(|(wd, _)| *wd == ev.wd) {
                if !nombre.is_empty() {
                    rutas.push(format!("{}/{}", dir.trim_end_matches('/'), nombre));
                }
            }
            i += cab + ev.len as usize;
        }
        (rutas, repasar)
    }
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
    let raices = raices(&home);
    let mut vig = Vigilancia { fd, watches: vec![], mtimes: HashMap::new() };
    vig.revisar(&raices, true);

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
    // El primero sale en el acto y un resumen posterior sustituye esa tarjeta: sin esto un
    // crítico durante una actualización esperaba los 30 s de su ventana ancha.
    for c in ["fcrit", "fpersist", "fssh"] {
        a.marcar_inmediata(c);
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

    let mut proxima = Instant::now() + REVISION;
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let ahora = Instant::now();
        let hasta_revision = proxima.saturating_duration_since(ahora);
        let espera = a.plazo(ahora).map_or(hasta_revision, |d| d.min(hasta_revision));
        let ms = espera.as_millis().clamp(1, i32::MAX as u128) as i32;
        let mut pfd = libc::pollfd { fd, events: libc::POLLIN, revents: 0 };
        let r = unsafe { libc::poll(&mut pfd, 1, ms) };
        if r < 0 {
            if std::io::Error::last_os_error().raw_os_error() == Some(libc::EINTR) {
                continue;
            }
            return;
        }
        let (mut rutas, mut repasar) = (vec![], false);
        if r > 0 {
            let n = unsafe { libc::read(fd, buf.as_mut_ptr().cast(), buf.len()) };
            if n <= 0 {
                continue;
            }
            (rutas, repasar) = vig.leer(&buf[..n as usize]);
        }
        let ahora = Instant::now();
        cfg.recargar(ahora);
        let mut ciegas = vec![];
        if repasar || ahora >= proxima {
            if ahora >= proxima {
                proxima = ahora + REVISION;
            }
            let h = vig.revisar(&raices, false);
            rutas.extend(h.nuevas);
            ciegas = h.ciegas;
        }
        if cfg.activo("fileIntegrity") {
            for ruta in rutas {
                if es_artefacto_de_paquetes(&ruta) || es_temporal_de_editor(&ruta) {
                    continue;
                }
                // Antes de mirar si hay transacción: ese `stat` (y a veces un recorrido de
                // /proc) no se paga por un /etc/resolv.conf que no se va a avisar.
                let clase = clasificar(&ruta, &home_s);
                if clase == Clase::Nada {
                    continue;
                }
                let tx = ventana(&mut a, &mut env);
                if let Some(cat) = destino(&clase, &ruta, &home_s, tx) {
                    a.encolar(cat, &ruta, ahora);
                }
            }
            for (ruta, mtime) in ciegas {
                let tx = ventana(&mut a, &mut env) || obra_de_paquetes(mtime);
                if let Some(cat) = destino(&clasificar(&ruta, &home_s), &ruta, &home_s, tx) {
                    a.encolar(cat, &ruta, ahora);
                }
            }
        }
        let antes = a.plazo(Instant::now()).is_some();
        a.volcar(Instant::now(), false);
        if antes && a.plazo(Instant::now()).is_none() {
            ventana(&mut a, &mut env); // volcado hecho: si la actualización acabó, ventana normal
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clases() {
        let h = "/home/u";
        assert_eq!(clasificar("/etc/shadow", h), Clase::Critico);
        assert_eq!(clasificar("/etc/nsswitch.conf", h), Clase::Critico);
        assert_eq!(clasificar("/etc/pam.d/sudo", h), Clase::Persistencia);
        assert_eq!(clasificar("/home/u/.config/autostart/x.desktop", h), Clase::Persistencia);
        assert_eq!(clasificar("/etc/systemd/system/multi-user.target.wants/x.service", h), Clase::Persistencia);
        assert_eq!(clasificar("/etc/pacman.d/hooks/x.hook", h), Clase::Persistencia);
        assert_eq!(clasificar("/etc/sudoers.d/", h), Clase::Persistencia);
        assert_eq!(clasificar("/etc/crontab", h), Clase::Persistencia);
        assert_eq!(clasificar("/home/u/.ssh/authorized_keys", h), Clase::ClaveSsh);
        assert_eq!(clasificar("/home/u/.ssh/known_hosts", h), Clase::Nada);
        assert_eq!(clasificar("/boot/vmlinuz-linux", h), Clase::Boot);
        assert_eq!(clasificar("/etc/hostname", h), Clase::Nada);
        assert_eq!(clasificar("/etc/ld.so.cache", h), Clase::Nada);
        assert_eq!(clasificar("/etc/cron.deny", h), Clase::Nada);
    }

    #[test]
    fn artefactos() {
        assert!(es_artefacto_de_paquetes("/etc/pam.d/system-auth.pacnew"));
        assert!(es_artefacto_de_paquetes("/etc/passwd.pacsave.1"));
        assert!(es_artefacto_de_paquetes("/etc/hosts~"));
        assert!(!es_artefacto_de_paquetes("/etc/passwd"));
    }

    #[test]
    fn temporales_de_editor() {
        for r in ["/etc/pam.d/.sudo.swp", "/etc/pam.d/.sudo.swx", "/etc/pam.d/4913", "/etc/pam.d/.sudo.kate-swp", "/etc/systemd/system/.#x.service1a2b"] {
            assert!(es_temporal_de_editor(r), "{r}");
        }
        for r in ["/etc/pam.d/sudo", "/etc/pam.d/x.swp", "/etc/cron.hourly/4913", "/var/spool/cron/4913", "/etc/pam.d/.ñ"] {
            assert!(!es_temporal_de_editor(r), "{r}");
        }
    }

    #[test]
    fn durante_una_actualizacion() {
        let h = "/home/u";
        let d = |r: &str| destino(&clasificar(r, h), r, h, true);
        // Lo que se ignora fuera de una actualización también se ignora dentro.
        assert_eq!(d("/etc/ld.so.cache"), None);
        assert_eq!(d("/home/u/.ssh/known_hosts"), None);
        // Lo rutinario de un paquete no saca tarjeta.
        assert_eq!(d("/boot/vmlinuz-linux"), None);
        assert_eq!(d("/etc/profile.d/gawk.sh"), None);
        // Lo que un paquete rara vez toca sí consta, sin alarmar.
        assert_eq!(d("/etc/passwd"), Some("fpkg"));
        assert_eq!(d("/etc/pam.d/sudo"), Some("fpkg"));
        assert_eq!(d("/etc/systemd/system/x.service"), Some("fpkg"));
        // Lo que ningún paquete escribe sigue siendo crítico.
        assert_eq!(d("/home/u/.ssh/authorized_keys"), Some("fssh"));
        assert_eq!(d("/home/u/.config/autostart/malo.desktop"), Some("fpersist"));
        assert_eq!(d("/etc/ld.so.preload"), Some("fcrit"));
    }

    #[test]
    fn fuera_de_una_actualizacion() {
        let h = "/home/u";
        let d = |r: &str| destino(&clasificar(r, h), r, h, false);
        assert_eq!(d("/boot/vmlinuz-linux"), Some("fboot"));
        assert_eq!(d("/etc/profile.d/x.sh"), Some("fpersist"));
        assert_eq!(d("/etc/ld.so.cache"), None);
    }

    #[test]
    fn margen_de_paquetes_en_los_dos_sentidos() {
        let t = SystemTime::UNIX_EPOCH + Duration::from_secs(10_000);
        let m = Duration::from_secs(900);
        assert!(cerca(t, t + Duration::from_secs(900), m));
        assert!(cerca(t + Duration::from_secs(900), t, m));
        assert!(!cerca(t, t + Duration::from_secs(901), m));
    }

    #[test]
    fn fechas_del_log() {
        assert_eq!(epoca_iso("1970-01-01T00:00:00+0000"), Some(0));
        // `date -d 2026-10-30T12:23:11+0100 +%s`
        assert_eq!(epoca_iso("2026-10-30T12:23:11+0100"), Some(1793359391));
        assert_eq!(epoca_iso("2024-03-01T00:00:00-0530"), Some(1709251200 + 19800));
        assert_eq!(epoca_iso("basura"), None);
    }

    #[test]
    fn transacciones_del_registro() {
        let e = |s: &str| epoca_iso(s).unwrap();
        let log = "\
[2026-10-30T10:00:00+0000] [PACMAN] Running 'pacman -Syu'
[2026-10-30T10:00:10+0000] [ALPM] running 'zz-snap-pac-pre.hook'...
[2026-10-30T10:00:20+0000] [ALPM] transaction started
[2026-10-30T10:10:00+0000] [ALPM-SCRIPTLET] algo
[2026-10-30T10:30:00+0000] [ALPM] transaction completed
[2026-10-30T10:30:30+0000] [ALPM] running 'zz-snap-pac-post.hook'...
[2026-10-30T15:00:00+0000] [ALPM] running 'zz-snap-pac-pre.hook'...
[2026-10-30T15:00:05+0000] [ALPM] transaction started
";
        let en = |s: &str| en_transaccion_pacman(log, e(s));
        // Dentro, sin ninguna línea cerca.
        assert_eq!(en("2026-10-30T10:15:00+0000"), Some(true));
        // Hook posterior, con su gracia.
        assert_eq!(en("2026-10-30T10:31:50+0000"), Some(true));
        assert_eq!(en("2026-10-30T10:32:01+0000"), Some(false));
        // Entre una actualización y la siguiente: ahí un cambio es de otro.
        assert_eq!(en("2026-10-30T12:00:00+0000"), Some(false));
        // Hook previo de la siguiente.
        assert_eq!(en("2026-10-30T14:59:00+0000"), Some(true));
        // Transacción sin cerrar: dura el tope, no para siempre.
        assert_eq!(en("2026-10-30T15:10:00+0000"), Some(true));
        assert_eq!(en("2026-10-30T15:20:00+0000"), Some(false));
        // Sin datos: decide el margen.
        assert_eq!(en_transaccion_pacman("[x] [PACMAN] nada\n", 0), None);
        assert_eq!(en_transaccion_pacman("", 0), None);
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

    fn tmp(nombre: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("gigishell-archivos-{}-{nombre}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn vigilancia() -> Vigilancia {
        let fd = unsafe { libc::inotify_init1(libc::IN_CLOEXEC | libc::IN_NONBLOCK) };
        assert!(fd >= 0);
        Vigilancia { fd, watches: vec![], mtimes: HashMap::new() }
    }

    fn eventos(v: &mut Vigilancia) -> (Vec<String>, bool) {
        let mut buf = vec![0u8; 64 * 1024];
        let n = unsafe { libc::read(v.fd, buf.as_mut_ptr().cast(), buf.len()) };
        if n <= 0 {
            return (vec![], false);
        }
        v.leer(&buf[..n as usize])
    }

    #[test]
    fn lo_que_habia_al_arrancar_no_se_avisa() {
        let d = tmp("arranque");
        fs::write(d.join("viejo"), "x").unwrap();
        let raices = [Raiz { dir: d.clone(), arbol: false }];
        let mut v = vigilancia();
        assert!(v.revisar(&raices, true).nuevas.is_empty());
        assert!(v.revisar(&raices, false).nuevas.is_empty());
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn carpeta_creada_despues_se_vigila_y_avisa_de_lo_que_traia() {
        let base = tmp("tardia");
        let d = base.join(".ssh");
        let raices = [Raiz { dir: d.clone(), arbol: false }];
        let mut v = vigilancia();
        assert!(v.revisar(&raices, true).nuevas.is_empty());
        assert!(v.watches.is_empty());
        fs::create_dir(&d).unwrap();
        fs::write(d.join("authorized_keys"), "k").unwrap();
        assert_eq!(v.revisar(&raices, false).nuevas, [d.join("authorized_keys").to_string_lossy()]);
        // A partir de aquí ya va por inotify.
        fs::write(d.join("otra"), "k").unwrap();
        assert!(eventos(&mut v).0.contains(&d.join("otra").to_string_lossy().into_owned()));
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn subcarpeta_de_un_arbol() {
        let d = tmp("arbol");
        let raices = [Raiz { dir: d.clone(), arbol: true }];
        let mut v = vigilancia();
        v.revisar(&raices, true);
        let wants = d.join("multi-user.target.wants");
        fs::create_dir(&wants).unwrap();
        std::os::unix::fs::symlink("/x", wants.join("a.service")).unwrap();
        // La carpeta no es un aviso en sí: pide repasar, y el repaso trae lo de dentro.
        let (rutas, repasar) = eventos(&mut v);
        assert!(rutas.is_empty());
        assert!(repasar);
        assert_eq!(v.revisar(&raices, false).nuevas, [wants.join("a.service").to_string_lossy()]);
        std::os::unix::fs::symlink("/x", wants.join("b.service")).unwrap();
        assert_eq!(eventos(&mut v).0, [wants.join("b.service").to_string_lossy()]);
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn carpeta_plana_no_entra_en_subcarpetas() {
        let d = tmp("plana");
        let raices = [Raiz { dir: d.clone(), arbol: false }];
        let mut v = vigilancia();
        v.revisar(&raices, true);
        fs::create_dir(d.join("sub")).unwrap();
        assert!(v.revisar(&raices, false).nuevas.is_empty());
        assert_eq!(v.watches.len(), 1);
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn carpeta_borrada_y_recreada_se_recupera() {
        let base = tmp("recreada");
        let d = base.join("x");
        fs::create_dir(&d).unwrap();
        let raices = [Raiz { dir: d.clone(), arbol: false }];
        let mut v = vigilancia();
        v.revisar(&raices, true);
        fs::remove_dir(&d).unwrap();
        assert!(eventos(&mut v).1);
        assert!(v.watches.is_empty());
        fs::create_dir(&d).unwrap();
        fs::write(d.join("f"), "x").unwrap();
        assert_eq!(v.revisar(&raices, false).nuevas, [d.join("f").to_string_lossy()]);
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn carpeta_renombrada_suelta_la_ruta_vieja() {
        let base = tmp("renombrada");
        let d = base.join("x");
        fs::create_dir(&d).unwrap();
        let raices = [Raiz { dir: d.clone(), arbol: false }];
        let mut v = vigilancia();
        v.revisar(&raices, true);
        fs::rename(&d, base.join("y")).unwrap();
        assert!(eventos(&mut v).1);
        eventos(&mut v); // su IN_IGNORED
        assert!(v.watches.is_empty());
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn carpeta_ciega_avisa_por_fecha() {
        let d = tmp("ciega");
        fs::set_permissions(&d, std::os::unix::fs::PermissionsExt::from_mode(0o000)).unwrap();
        // Como root `access` da igual y esta prueba no mide nada.
        if legible(&d) {
            fs::set_permissions(&d, std::os::unix::fs::PermissionsExt::from_mode(0o700)).unwrap();
            fs::remove_dir_all(&d).unwrap();
            return;
        }
        let raices = [Raiz { dir: d.clone(), arbol: false }];
        let mut v = vigilancia();
        assert!(v.revisar(&raices, true).ciegas.is_empty());
        assert!(v.revisar(&raices, false).ciegas.is_empty());
        v.mtimes.insert(d.clone(), SystemTime::UNIX_EPOCH);
        let c = v.revisar(&raices, false).ciegas;
        assert_eq!(c.len(), 1);
        assert!(c[0].0.ends_with('/'));
        fs::set_permissions(&d, std::os::unix::fs::PermissionsExt::from_mode(0o700)).unwrap();
        fs::remove_dir_all(&d).unwrap();
    }
}
