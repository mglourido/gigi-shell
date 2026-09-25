//! Clasificación de líneas del journal: port 1:1 de las cadenas if/elif de
//! `monitor_kernel` y `monitor_system` de oom-monitor.sh. El ORDEN de las ramas se
//! conserva porque es semántico (una línea que case con dos reglas va a la primera).
//! Los porqués de cada regla están documentados en el bash; aquí solo lo que cambia.

use std::collections::HashMap;
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

    fn sistema(&mut self, linea: &str, ahora: Instant) {
        let l = linea.to_lowercase();
        let has = |s: &str| l.contains(s);

        if self.on("serviceFailure") && has("failed to start") {
            // Lo que siga roto tras la actualización lo caza monitor_units (bash).
            if !self.env.pkg_tx_activa() {
                self.grupos.encolar("ssvc", linea, ahora);
            }
        } else if self.on("sudoAuth") && has("sudo") && (has("authentication failure") || has("incorrect password")) {
            self.grupos.encolar("ssudo", "", ahora);
        } else if self.on("privEsc")
            && (has("pkexec")
                || (has("(su:auth)") && has("authentication failure"))
                || (has("polkit") && has("failed to authenticate")))
        {
            // Escalada autenticada (sesión PAM o COMMAND=) = el usuario acaba de meter
            // su contraseña: callar. Solo avisa la que NO pasó por una contraseña válida.
            if has("pkexec") && (has("pam_unix(polkit-1:session)") || linea.contains("[COMMAND=")) {
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
    fn sudo_por_prefijo() {
        let mut m = monitor(Falso::default());
        m.procesar(false, "sudo[5]:   mateo : 3 incorrect password attempts ; TTY=pts/1", Instant::now());
        assert!(pendientes(&m));
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
