//! Clasificación de líneas del journal: port 1:1 de las cadenas if/elif de
//! `monitor_kernel` y `monitor_system` de oom-monitor.sh. El ORDEN de las ramas se
//! conserva porque es semántico (una línea que case con dos reglas va a la primera).
//! Los porqués de cada regla están documentados en el bash; aquí solo lo que cambia.

use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

use crate::notif::{notificar, Agrupador, Grupo, Salida};
use crate::sistema::{Config, Entorno};

pub struct Monitor<E: Entorno> {
    pub cfg: Config,
    pub env: E,
    salida: Salida,
    grupos: Agrupador,
    cooldown_seg: HashMap<String, Instant>,
    cooldown_io: HashMap<String, Instant>,
    cooldown_core: HashMap<String, Instant>,
    coredumps: Vec<Instant>,
    tormenta: Option<Instant>,
    aviso_reinicio: bool,
    /// PIDs de sudo cuyo fallo ya se contó por la línea PAM (ver `sudo()`).
    sudo_pam: HashSet<u32>,
    /// Último fallo de pkexec que polkitd vio en SU diálogo (ver la rama de pkexec).
    polkit_dialogo: Option<Instant>,
}

fn g(
    evento: &'static str,
    urgencia: &'static str,
    tmo_ms: i64,
    titulo: &'static str,
    plural: &'static str,
    prefijo: &'static str,
    sufijo: &'static str,
) -> Grupo {
    Grupo { evento, urgencia, tmo_ms, titulo, plural, prefijo, sufijo }
}

impl<E: Entorno> Monitor<E> {
    pub fn new(cfg: Config, env: E, salida: Salida) -> Self {
        let mut a = Agrupador::new(salida);
        // kernel
        a.registrar("koom", g("kernel.oom", "critical", 10000, "OOM Killer", "procesos matados por OOM", "Proceso: ", ""));
        a.registrar("khung", g("kernel.tarea-colgada", "critical", 15000, "Proceso colgado", "procesos colgados", "", ""));
        a.registrar("kdisk", g("disco.error-es", "critical", 15000, "Error de disco", "errores de disco", "", ""));
        a.registrar("kusb", g("usb.extraccion-insegura", "normal", 12000, "Extracción insegura", "extracciones inseguras",
            "Se quitó ", " con escrituras pendientes. Puede haber archivos incompletos o el sistema de ficheros marcado como sucio. Expúlsalo antes de retirarlo."));
        a.registrar("kusbr", g("usb.extraccion-en-lectura", "normal", 10000, "Se retiró mientras se leía", "dispositivos retirados mientras se leían",
            "Se quitó ", " mientras se leía de él. No había escrituras pendientes, así que no debería faltar nada; lo que estuviera leyéndolo (una copia, una comprobación) se quedó a medias."));
        a.registrar("khw", g("hardware.error", "critical", 15000, "Error de hardware", "errores de hardware", "", ""));
        a.registrar("kmod", g("kernel.modulo-sin-firmar", "critical", 15000, "Módulo de kernel sin firmar", "módulos de kernel sin firmar", "", ""));
        a.registrar("kgpu", g("gpu.error", "critical", 15000, "Error GPU", "errores de GPU", "", ""));
        a.registrar("kthrottle", g("cpu.throttling", "normal", 10000, "CPU Throttling", "avisos de CPU throttling", "", ""));
        a.registrar("kseg", g("app.crash", "critical", 15000, "App crasheada", "apps crasheadas", "Proceso: ", ""));
        // sistema
        a.registrar("ssvc", g("servicio.fallo-arranque", "normal", 10000, "Servicio fallido", "servicios fallidos", "", ""));
        a.registrar("ssudo", g("sudo.fallo-autenticacion", "critical", 15000, "Fallo sudo", "fallos de sudo", "Intento fallido de sudo", ""));
        a.registrar("spriv", g("seguridad.escalada-privilegios", "critical", 15000, "Escalada de privilegios", "escaladas de privilegios", "", ""));
        a.registrar("sssh", g("ssh.evento", "normal", 15000, "SSH", "eventos SSH", "", ""));
        // Autenticación: el primer aviso sale en el acto (ver `marcar_inmediata`).
        for cat in ["ssudo", "spriv", "sssh"] {
            a.marcar_inmediata(cat);
        }
        a.registrar("score", g("app.crash", "critical", 15000, "App crasheada", "apps crasheadas", "Proceso: ", ""));
        Monitor {
            cfg,
            env,
            salida,
            grupos: a,
            cooldown_seg: HashMap::new(),
            cooldown_io: HashMap::new(),
            cooldown_core: HashMap::new(),
            coredumps: vec![],
            tormenta: None,
            aviso_reinicio: false,
            sudo_pam: HashSet::new(),
            polkit_dialogo: None,
        }
    }

    pub fn plazo(&self, ahora: Instant) -> Option<Duration> {
        self.grupos.plazo(ahora)
    }

    pub fn volcar(&mut self, ahora: Instant, forzar: bool) {
        self.grupos.volcar(ahora, forzar);
    }

    pub fn procesar(&mut self, kernel: bool, linea: &str, ahora: Instant) {
        self.cfg.recargar(ahora);
        if kernel {
            self.kernel(linea, ahora)
        } else {
            self.sistema(linea, ahora)
        }
    }

    fn on(&self, k: &str) -> bool {
        self.cfg.activo(k)
    }

    /// Ruido garantizado de una actualización de drivers (GPU / módulos). Ver
    /// `_ruido_de_drivers` en el bash.
    fn ruido_de_drivers(&mut self) -> bool {
        if self.env.pkg_tx_activa() {
            return true;
        }
        if !self.env.sesion_desincronizada() {
            return false;
        }
        if !self.aviso_reinicio {
            self.aviso_reinicio = true;
            notificar(self.salida, "sistema.reinicio-pendiente", "normal", "Reinicio pendiente",
                "Se actualizaron el kernel o los drivers y la sesión sigue con los antiguos. Los errores de GPU y de módulos quedan silenciados hasta que reinicies.",
                20000);
        }
        true
    }

    fn kernel(&mut self, linea: &str, ahora: Instant) {
        let l = linea.to_lowercase();
        let has = |s: &str| l.contains(s);

        if self.on("oomKiller") && (has("oom-killer") || has("out of memory") || has("killed process")) {
            let proceso = proceso_entre_parentesis(linea, "Killed process ")
                .or_else(|| proceso_entre_parentesis(linea, "Kill process "))
                .or_else(|| disparador_oom(linea).map(|p| format!("{p} (disparador)")))
                .unwrap_or_else(|| "desconocido".into());
            self.grupos.encolar("koom", &proceso, ahora);
        } else if self.on("kernelPanic") && has("kernel panic") {
            // Único evento que NO se agrupa: la sesión puede no durar la ventana.
            notificar(self.salida, "kernel.panic", "critical", "Kernel Panic", "El sistema va a reiniciar", 0);
        } else if self.on("hungTask") && (has("hung_task") || has("blocked for more than")) {
            self.grupos.encolar("khung", linea, ahora);
        } else if self.on("diskError") && has("i/o error") {
            let dev = dispositivo_io(linea).unwrap_or_default();
            let base = self.env.disco_base(&dev);
            let escritura = io_es_escritura(&l);
            let clave = format!("{}:{}", if base.is_empty() { "desconocido" } else { &base }, if escritura { 'w' } else { 'r' });
            if enfriado(&mut self.cooldown_io, clave, ahora, 30) {
                if base.is_empty() || self.env.disco_interno(&base) {
                    self.grupos.encolar("kdisk", linea, ahora);
                } else if escritura {
                    self.grupos.encolar("kusb", &dev, ahora);
                } else {
                    self.grupos.encolar("kusbr", &dev, ahora);
                }
            }
        } else if self.on("hwErrors")
            && ["machine check", "mce:", "hardware error", "edac", "memory error"].iter().any(|s| has(s))
        {
            self.grupos.encolar("khw", linea, ahora);
        } else if self.on("kernelModules")
            && ["tainting kernel", "module verification failed", "loading out-of-tree module", "unsigned module"]
                .iter()
                .any(|s| has(s))
        {
            if !self.ruido_de_drivers() {
                self.grupos.encolar("kmod", linea, ahora);
            }
        } else if self.on("gpuError")
            && (has("nvrm") || (has("nvidia") && has("error")) || (has("gpu") && has("error")))
        {
            if !self.ruido_de_drivers() {
                self.grupos.encolar("kgpu", linea, ahora);
            }
        } else if self.on("cpuThrottling") && contiene_en_orden(&l, "cpu", "throttl") {
            self.grupos.encolar("kthrottle", linea, ahora);
        } else if self.on("appCrash") && has("segfault") {
            // Descartado ANTES del cooldown: no gastarlo en un crash que no se avisa.
            if self.env.pkg_tx_activa() {
                return;
            }
            let app = app_segfault(linea).unwrap_or_else(|| "desconocida".into());
            if enfriado(&mut self.cooldown_seg, app.clone(), ahora, 10) {
                self.grupos.encolar("kseg", &format!("{app} (segfault)"), ahora);
            }
        }
    }

    /// **Un fallo tecleado en una terminal NO avisa**: sudo ya lo dice ahí al instante
    /// («Lo siento, pruebe otra vez»), y una tarjeta crítica segundos después solo repite
    /// lo que el usuario acaba de ver. Avisa el intento SIN terminal —un script o un
    /// proceso en segundo plano probando contraseñas—, que nadie está mirando. Un
    /// atacante que se fabrique un pty lo esquiva, pero al tercer fallo pam_faillock
    /// bloquea la cuenta y eso sí avisa (rama de abajo).
    ///
    /// Una contraseña incorrecta deja DOS líneas: la de PAM (`pam_unix(sudo:auth):
    /// authentication failure`, una por intento) y el resumen de sudo al rendirse
    /// (`N incorrect password attempt(s)`). Contar las dos convertía un fallo en «2 fallos
    /// de sudo». Cuenta PAM; el resumen solo cuando ese proceso no dejó línea PAM (una
    /// cuenta de systemd-homed no pasa por pam_unix), y entonces vale por N.
    fn sudo(&mut self, l: &str, linea: &str, ahora: Instant) {
        let pid = pid_de(linea);
        if l.contains("(sudo:auth)") && l.contains("authentication failure") {
            if let Some(p) = pid {
                // Un resumen que no llega (sudo matado) no debe dejar crecer el set.
                if self.sudo_pam.len() >= 32 {
                    self.sudo_pam.clear();
                }
                self.sudo_pam.insert(p);
            }
            if self.on("sudoAuth") && !en_terminal(l) {
                self.grupos.encolar("ssudo", "", ahora);
            }
        } else if let Some(n) = intentos_incorrectos(l) {
            let ya_contado = pid.is_some_and(|p| self.sudo_pam.remove(&p));
            if self.on("sudoAuth") && !ya_contado && !en_terminal(l) {
                for _ in 0..n {
                    self.grupos.encolar("ssudo", "", ahora);
                }
            }
        } else if self.on("privEsc")
            && (l.contains("not in sudoers")
                || l.contains("command not allowed")
                || l.contains("not authorized on host")
                || l.contains("account temporarily locked"))
        {
            // Escalada DENEGADA por la política (sudoers) o cuenta bloqueada por
            // pam_faillock tras `deny` fallos: no es un despiste de contraseña.
            self.grupos.encolar("spriv", linea, ahora);
        }
    }

    fn sistema(&mut self, linea: &str, ahora: Instant) {
        let l = linea.to_lowercase();
        let has = |s: &str| l.contains(s);
        let ident = identificador(linea);

        if self.on("serviceFailure") && has("failed to start") {
            // Lo que siga roto tras la actualización lo caza monitor_units (bash).
            if !self.env.pkg_tx_activa() {
                self.grupos.encolar("ssvc", linea, ahora);
            }
        } else if ident == "sudo" {
            // Toda línea de sudo se queda aquí: antes caía a las ramas siguientes por
            // subcadena, y un `sudo pkexec …` correcto (COMMAND=/usr/bin/pkexec) avisaba
            // como escalada de pkexec.
            self.sudo(&l, linea, ahora);
        } else if ident == "polkitd" && has("failed to authenticate") {
            // Fallo DENTRO del diálogo de polkit: el propio diálogo ya lo dijo, no avisa.
            // Solo se apunta, para que el «Not authorized» con que pkexec cierra ese mismo
            // intento tampoco avise. Va por tiempo y no por PID: el sujeto que polkitd
            // registra es el PADRE de pkexec (su `getppid()`), no pkexec.
            if has("org.freedesktop.policykit.exec") {
                self.polkit_dialogo = Some(ahora);
            }
        } else if self.on("privEsc")
            && (ident == "pkexec"
                || (ident == "su" && (has("(su:auth)") || has("(su-l:auth)")) && has("authentication failure")))
        {
            if ident == "pkexec" {
                // Escalada autenticada (sesión PAM o COMMAND=) = el usuario acaba de meter
                // su contraseña. «Request dismissed» = pulsó Cancelar. Ninguna avisa.
                if has("pam_unix(polkit-1:session)") || linea.contains("[COMMAND=") || has("request dismissed") {
                    return;
                }
                // Denegado tras fallar en el diálogo: ya se vio. Denegado SIN diálogo
                // (la política dice «no», sesión inactiva…) sí avisa.
                if self.polkit_dialogo.take().is_some_and(|t| ahora.duration_since(t) < Duration::from_secs(10)) {
                    return;
                }
            } else if en_terminal(&l) {
                // `su` fallido en una terminal: la terminal ya dijo «Authentication failure».
                return;
            }
            self.grupos.encolar("spriv", linea, ahora);
        } else if self.on("ssh") && has("sshd") && (has("failed password") || has("accepted")) {
            self.grupos.encolar("sssh", linea, ahora);
        } else if (self.on("appCrash") || self.on("serviceHealth"))
            && has("coredump")
            && (has("dumped core") || has("terminated abnormally"))
        {
            if self.env.pkg_tx_activa() {
                return;
            }
            let app = proceso_entre_parentesis(linea, "Process ").unwrap_or_else(|| "desconocida".into());
            if self.on("appCrash") && enfriado(&mut self.cooldown_core, app.clone(), ahora, 10) {
                self.grupos.encolar("score", &format!("{app} (coredump)"), ahora);
            }
            if self.on("serviceHealth") {
                self.coredumps.retain(|t| ahora.duration_since(*t) < Duration::from_secs(60));
                self.coredumps.push(ahora);
                let n = self.coredumps.len();
                if n >= 3 && self.tormenta.is_none_or(|t| ahora.duration_since(t) >= Duration::from_secs(60)) {
                    self.tormenta = Some(ahora);
                    notificar(self.salida, "app.tormenta-crashes", "critical", "Tormenta de crashes",
                        &format!("{n} volcados de core en <60s. Algo va muy mal."), 0);
                }
            }
        }
    }
}

/// Cooldown por clave: true (y rearma) si han pasado `seg` segundos desde el último.
fn enfriado(m: &mut HashMap<String, Instant>, clave: String, ahora: Instant, seg: u64) -> bool {
    if m.get(&clave).is_some_and(|t| ahora.duration_since(*t) < Duration::from_secs(seg)) {
        return false;
    }
    m.insert(clave, ahora);
    true
}

// ── Extractores (sustituyen a los BASH_REMATCH) ───────────────────────────────

/// `<prefijo>[0-9]+ \(([^)]+)\)` — primera aparición que case.
pub fn proceso_entre_parentesis(linea: &str, prefijo: &str) -> Option<String> {
    let mut resto = linea;
    while let Some(i) = resto.find(prefijo) {
        let tras = &resto[i + prefijo.len()..];
        let digitos = tras.bytes().take_while(u8::is_ascii_digit).count();
        if digitos > 0 {
            if let Some(dentro) = tras[digitos..].strip_prefix(" (") {
                if let Some(fin) = dentro.find(')') {
                    if fin > 0 {
                        return Some(dentro[..fin].to_string());
                    }
                }
            }
        }
        resto = &resto[i + prefijo.len()..];
    }
    None
}

/// `([^[:space:]]+) invoked oom-killer`
pub fn disparador_oom(linea: &str) -> Option<String> {
    let i = linea.find(" invoked oom-killer")?;
    let tok = linea[..i].rsplit(char::is_whitespace).next()?;
    (!tok.is_empty()).then(|| tok.to_string())
}

/// `(on dev|, dev) ([a-zA-Z0-9_-]+)` — "sdb1", "nvme0n1p2"…
pub fn dispositivo_io(linea: &str) -> Option<String> {
    let i = [linea.find("on dev "), linea.find(", dev ")].into_iter().flatten().min()?;
    let tras = &linea[i..];
    let tras = &tras[tras.find("dev ")? + 4..];
    let dev: String = tras
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
        .collect();
    (!dev.is_empty()).then_some(dev)
}

/// ¿La E/S que falló era una escritura? Ante la duda, lectura (no alarmar).
pub fn io_es_escritura(lower: &str) -> bool {
    lower.contains("(write)") || lower.contains("page write") || lower.contains("write error")
}

/// `kernel: ([^[]+)\[[0-9]+\]: segfault`
pub fn app_segfault(linea: &str) -> Option<String> {
    let mut resto = linea;
    while let Some(i) = resto.find("kernel: ") {
        let tras = &resto[i + 8..];
        if let Some(c) = tras.find('[') {
            let nombre = &tras[..c];
            let d = &tras[c + 1..];
            let n = d.bytes().take_while(u8::is_ascii_digit).count();
            if !nombre.is_empty() && n > 0 && d[n..].starts_with("]: segfault") {
                return Some(nombre.to_string());
            }
        }
        resto = tras;
    }
    None
}

/// `<ident>` de `<ident>[<pid>]: …` o `<ident>: …` (el formato de `journal::Entrada`).
fn identificador(linea: &str) -> &str {
    linea.find(['[', ':']).map_or(linea, |i| &linea[..i])
}

/// ¿La línea dice que el intento vino de una terminal? `tty=/dev/pts/1` (PAM) o
/// `TTY=pts/1` (resumen de sudo). Sin terminal, PAM deja `tty=` vacío y sudo omite el campo.
fn en_terminal(l: &str) -> bool {
    l.find("tty=").is_some_and(|i| {
        l[i + 4..].chars().next().is_some_and(|c| !c.is_whitespace() && c != ';')
    })
}

/// `<ident>[([0-9]+)]: …`
fn pid_de(linea: &str) -> Option<u32> {
    let tras = &linea[linea.find('[')? + 1..];
    tras[..tras.find(']')?].parse().ok()
}

/// `([0-9]+) incorrect password attempt` sobre la línea en minúsculas. Sin número
/// legible cuenta 1; el tope evita un bucle absurdo con un dato corrupto.
fn intentos_incorrectos(l: &str) -> Option<usize> {
    let i = l.find(" incorrect password attempt")?;
    let n = l[..i].rsplit(' ').next().and_then(|t| t.parse().ok()).unwrap_or(1);
    Some(n.clamp(1, 100))
}

/// `a.*b` sobre una sola línea.
fn contiene_en_orden(s: &str, a: &str, b: &str) -> bool {
    s.find(a).is_some_and(|i| s[i + a.len()..].contains(b))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sistema::Falso;
    use std::path::PathBuf;

    fn monitor(env: Falso) -> Monitor<Falso> {
        Monitor::new(Config::new(PathBuf::from("/nonexistent/security.json")), env, Salida::Simulado)
    }

    fn pendientes(m: &Monitor<Falso>) -> bool {
        m.plazo(Instant::now()).is_some()
    }

    #[test]
    fn extractores() {
        assert_eq!(
            proceso_entre_parentesis("kernel: Out of memory: Killed process 4242 (firefox) total-vm:1kB", "Killed process ").as_deref(),
            Some("firefox")
        );
        assert_eq!(disparador_oom("kernel: Web invoked oom-killer: gfp_mask=0x0").as_deref(), Some("Web"));
        assert_eq!(
            dispositivo_io("kernel: Buffer I/O error on dev sdb1, logical block 786432, lost async page write").as_deref(),
            Some("sdb1")
        );
        assert_eq!(
            dispositivo_io("kernel: blk_update_request: I/O error, dev nvme0n1, sector 6293504 op 0x1:(WRITE)").as_deref(),
            Some("nvme0n1")
        );
        assert_eq!(
            app_segfault("kernel: Web Content[1234]: segfault at 0 ip 0 sp 0 error 4").as_deref(),
            Some("Web Content")
        );
        assert_eq!(
            proceso_entre_parentesis("systemd-coredump[9]: Process 777 (gimp) of user 1000 dumped core.", "Process ").as_deref(),
            Some("gimp")
        );
        assert!(contiene_en_orden("cpu0: core temperature above threshold, cpu clock throttled", "cpu", "throttl"));
        assert!(!contiene_en_orden("throttled cpu", "cpu", "throttl"));
    }

    #[test]
    fn pkexec_autenticado_calla() {
        let mut m = monitor(Falso::default());
        let t = Instant::now();
        m.procesar(false, "pkexec[1]: pam_unix(polkit-1:session): session opened for user root", t);
        m.procesar(false, "pkexec[1]: mateo: Executing command [USER=root] [TTY=unknown] [CWD=/] [COMMAND=/usr/bin/true]", t);
        assert!(!pendientes(&m));
        m.procesar(false, "pkexec[1]: mateo: Error executing command as another user: Not authorized", t);
        assert!(pendientes(&m));
    }

    #[test]
    fn sudo_resumen_sin_pam_cuenta_n() {
        let mut m = monitor(Falso::default());
        m.procesar(false, "sudo[5]:   mateo : 3 incorrect password attempts ; PWD=/tmp ; USER=root ; COMMAND=/usr/bin/true", Instant::now());
        assert_eq!(m.grupos.total("ssudo"), 3);
    }

    /// Lo del requisito: fallar sudo en la terminal no manda nada (la terminal ya avisó).
    #[test]
    fn sudo_en_terminal_calla() {
        let mut m = monitor(Falso::default());
        let t = Instant::now();
        for l in [
            "sudo[40]: pam_unix(sudo:auth): authentication failure; logname=mateo uid=1000 euid=0 tty=/dev/pts/1 ruser=mateo rhost=  user=mateo",
            "sudo[40]: pam_unix(sudo:auth): authentication failure; logname=mateo uid=1000 euid=0 tty=/dev/pts/1 ruser=mateo rhost=  user=mateo",
            "sudo[40]: mateo : 2 incorrect password attempts ; TTY=pts/1 ; PWD=/home/mateo ; USER=root ; COMMAND=/usr/bin/true",
            "sudo[41]: mateo : 1 incorrect password attempt ; TTY=pts/1 ; PWD=/home/mateo ; USER=root ; COMMAND=/usr/bin/true",
        ] {
            m.procesar(false, l, t);
        }
        assert!(!pendientes(&m));
        assert!(m.sudo_pam.is_empty());
    }

    #[test]
    fn su_en_terminal_calla() {
        let mut m = monitor(Falso::default());
        m.procesar(false, "su[3]: pam_unix(su-l:auth): authentication failure; logname=mateo uid=1000 euid=0 tty=pts/1 ruser=mateo rhost=  user=root", Instant::now());
        assert!(!pendientes(&m));
    }

    #[test]
    fn polkit_visto_en_dialogo_calla() {
        let mut m = monitor(Falso::default());
        let t = Instant::now();
        m.procesar(false, "polkitd[763]: Operator of unix-session:2 FAILED to authenticate to gain authorization for action org.freedesktop.policykit.exec for unix-process:900:1 [bash] (owned by unix-user:mateo)", t);
        m.procesar(false, "pkexec[901]: mateo: Error executing command as another user: Not authorized [USER=root] [TTY=unknown] [CWD=/]", t);
        m.procesar(false, "pkexec[902]: mateo: Error executing command as another user: Request dismissed [USER=root] [TTY=unknown] [CWD=/]", t);
        assert!(!pendientes(&m));
        // Denegado sin diálogo: avisa.
        m.procesar(false, "pkexec[903]: mateo: Error executing command as another user: Not authorized [USER=root] [TTY=unknown] [CWD=/]", t);
        assert_eq!(m.grupos.total("spriv"), 1);
    }

    /// Líneas reales de UNA contraseña incorrecta (sudo 1.9.17, pam_unix + faillock):
    /// es un fallo, no dos.
    #[test]
    fn sudo_un_fallo_cuenta_uno() {
        let mut m = monitor(Falso::default());
        let t = Instant::now();
        for l in [
            "sudo[28520]: pam_unix(sudo:auth): authentication failure; logname=mateo uid=1000 euid=0 tty= ruser=mateo rhost=  user=mateo",
            "sudo[28520]: pam_unix(sudo:auth): conversation failed",
            "sudo[28520]: pam_unix(sudo:auth): auth could not identify password for [mateo]",
            "sudo[28520]: mateo : 1 incorrect password attempt ; PWD=/home/mateo ; USER=root ; COMMAND=/usr/bin/true",
        ] {
            m.procesar(false, l, t);
        }
        assert_eq!(m.grupos.total("ssudo"), 1);
        assert!(m.sudo_pam.is_empty());
    }

    #[test]
    fn sudo_denegado_es_escalada() {
        let mut m = monitor(Falso::default());
        let t = Instant::now();
        m.procesar(false, "sudo[7]:    intruso : user NOT in sudoers ; TTY=pts/2 ; PWD=/tmp ; USER=root ; COMMAND=/usr/bin/sh", t);
        m.procesar(false, "sudo[8]: pam_faillock(sudo:auth): Consecutive login failures for user mateo account temporarily locked", t);
        assert_eq!(m.grupos.total("spriv"), 2);
        assert_eq!(m.grupos.total("ssudo"), 0);
    }

    #[test]
    fn sudo_correcto_no_avisa() {
        let mut m = monitor(Falso::default());
        let t = Instant::now();
        // Contiene "pkexec": antes caía a la rama de pkexec y avisaba como escalada.
        m.procesar(false, "sudo[9]: mateo : TTY=pts/1 ; PWD=/home/mateo ; USER=root ; COMMAND=/usr/bin/pkexec true", t);
        m.procesar(false, "sudo[9]: pam_unix(sudo:session): session opened for user root(uid=0) by mateo(uid=1000)", t);
        assert!(!pendientes(&m));
    }

    #[test]
    fn su_login_falla() {
        let mut m = monitor(Falso::default());
        m.procesar(false, "su[3]: pam_unix(su-l:auth): authentication failure; logname=mateo uid=1000 euid=0 tty= ruser=mateo rhost=  user=root", Instant::now());
        assert_eq!(m.grupos.total("spriv"), 1);
    }

    #[test]
    fn gpu_silenciada_durante_actualizacion() {
        let mut m = monitor(Falso { tx: true, ..Default::default() });
        m.procesar(true, "kernel: NVRM: Xid (PCI:0000:01:00): 79, GPU has fallen off the bus", Instant::now());
        assert!(!pendientes(&m));
    }

    #[test]
    fn io_extraible_vs_interno() {
        let mut env = Falso::default();
        env.internos.insert("nvme0n1".into(), true);
        let mut m = monitor(env);
        let t = Instant::now();
        m.procesar(true, "kernel: Buffer I/O error on dev sdb1, logical block 1, lost async page write", t);
        m.procesar(true, "kernel: I/O error, dev nvme0n1, sector 1 op 0x0:(READ)", t);
        // Cooldown por (disco, tipo): la segunda escritura de sdb no cuenta.
        m.procesar(true, "kernel: Buffer I/O error on dev sdb1, logical block 2, lost async page write", t);
        assert!(!m.cooldown_io.contains_key("sdb:r"));
        assert!(m.cooldown_io.contains_key("sdb:w"));
        assert!(m.cooldown_io.contains_key("nvme0n1:r"));
    }

    #[test]
    fn tormenta_de_coredumps() {
        let mut m = monitor(Falso::default());
        let t = Instant::now();
        for (i, app) in ["a", "b", "c"].iter().enumerate() {
            m.procesar(false, &format!("systemd-coredump[1]: Process {i} ({app}) of user 1000 dumped core."), t);
        }
        assert!(m.tormenta.is_some());
    }
}
