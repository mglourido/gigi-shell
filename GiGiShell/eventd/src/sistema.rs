//! Consultas al sistema que usan las reglas: config de Ajustes > Seguridad, ventana de
//! actualización de paquetes, sesión desincronizada con los drivers y clasificación de
//! discos. Todo sin forks salvo `modinfo`, que se paga como mucho una vez por minuto.

#[cfg(test)]
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant, SystemTime};

// ── security.json ─────────────────────────────────────────────────────────────

/// Claves que entiende oom-monitor.sh. Solo un `false` explícito desactiva; ausente o
/// fichero ilegible = todo encendido.
pub const CLAVES: &[&str] = &[
    "oomKiller", "kernelPanic", "hungTask", "hwErrors", "kernelModules", "cpuThrottling",
    "diskError", "diskHealth", "gpuError", "serviceFailure", "serviceHealth", "sudoAuth",
    "privEsc", "ssh", "appCrash", "fileIntegrity", "downloadScan", "sandboxLaunch",
];

/// Ajustes con recarga en caliente: a diferencia del bash (que leía el fichero UNA vez
/// y había que relanzar el script), se revisa el mtime como mucho una vez por segundo.
pub struct Config {
    ruta: PathBuf,
    apagadas: Vec<String>,
    mtime: Option<SystemTime>,
    revisado: Option<Instant>,
}

impl Config {
    pub fn new(ruta: PathBuf) -> Self {
        let mut c = Config { ruta, apagadas: vec![], mtime: None, revisado: None };
        c.recargar(Instant::now());
        c
    }

    pub fn activo(&self, clave: &str) -> bool {
        !self.apagadas.iter().any(|k| k == clave)
    }

    pub fn recargar(&mut self, ahora: Instant) {
        if self.revisado.is_some_and(|t| ahora.duration_since(t) < Duration::from_secs(1)) {
            return;
        }
        self.revisado = Some(ahora);
        let mtime = fs::metadata(&self.ruta).and_then(|m| m.modified()).ok();
        if mtime == self.mtime && self.mtime.is_some() {
            return;
        }
        self.mtime = mtime;
        self.apagadas = fs::read_to_string(&self.ruta)
            .ok()
            .map(|s| apagadas_de(&s))
            .unwrap_or_default();
    }
}

pub fn apagadas_de(json: &str) -> Vec<String> {
    let Ok(serde_json::Value::Object(m)) = serde_json::from_str(json) else {
        return vec![];
    };
    m.into_iter()
        .filter(|(k, v)| v == &serde_json::Value::Bool(false) && CLAVES.contains(&k.as_str()))
        .map(|(k, _)| k)
        .collect()
}

// ── Puerta de juego / ahorro (port de lib/gaming-gate.sh) ─────────────────────
//
// Solo la usan los SONDEOS (unidades, SMART), igual que en el bash: congelar a los
// seguidores de eventos abriría una ventana ciega y no ahorraría nada. Fail-open: sin
// estado legible, o con el AGS que lo escribió muerto (`pid`), se trabaja.

const GRACIA_FOCO: u64 = 300;
const POLL_PUERTA: Duration = Duration::from_secs(10);
const REANUDAR: Duration = Duration::from_secs(5);

pub fn home() -> PathBuf {
    std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default()
}

fn leer_json(ruta: &Path) -> Option<serde_json::Value> {
    serde_json::from_str(&fs::read_to_string(ruta).ok()?).ok()
}

/// `Some(espera)` si ahora toca congelar; la espera alarga el sondeo hasta que vence
/// la gracia de foco, para no despertar cada 10 s con un juego aparcado.
pub fn congelar_ahora(estado: &serde_json::Value, congelar_al_jugar: bool, ahora_epoch: u64) -> Option<Duration> {
    let pid = estado.get("pid")?.as_u64()?;
    if !Path::new("/proc").join(pid.to_string()).exists() {
        return None;
    }
    let es = |k: &str| estado.get(k) == Some(&serde_json::Value::Bool(true));
    if es("gaming") && congelar_al_jugar {
        let ultimo = estado.get("lastGameFocus").and_then(|v| v.as_u64());
        let jugando = es("gameFocused")
            || ultimo.is_none_or(|l| l == 0 || ahora_epoch.saturating_sub(l) < GRACIA_FOCO);
        if jugando {
            let mut espera = POLL_PUERTA;
            if let (false, Some(l)) = (es("gameFocused"), ultimo.filter(|l| *l > 0)) {
                let restante = Duration::from_secs((l + GRACIA_FOCO).saturating_sub(ahora_epoch));
                espera = espera.max(restante);
            }
            return Some(espera);
        }
    }
    es("powerSaveFreeze").then_some(POLL_PUERTA)
}

fn congelar_segun_disco() -> Option<Duration> {
    let h = home().join(".config/gigishell");
    let estado = leer_json(&h.join("runtime-state.json"))?;
    // Solo un `false` explícito apaga la congelación al jugar.
    let al_jugar = leer_json(&h.join("preferences.json"))
        .and_then(|p| p.get("gamingFreeze").cloned())
        != Some(serde_json::Value::Bool(false));
    let ahora = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    congelar_ahora(&estado, al_jugar, ahora)
}

/// Retiene (no salta) hasta que no haya juego ni ahorro pidiendo congelar.
pub fn esperar_puerta() {
    let Some(mut espera) = congelar_segun_disco() else { return };
    loop {
        std::thread::sleep(espera);
        match congelar_segun_disco() {
            Some(e) => espera = e,
            None => break,
        }
    }
    std::thread::sleep(REANUDAR);
}

// ── Entorno que consultan las reglas (abstraído para los tests) ───────────────

pub trait Entorno {
    /// ¿Hay (o acaba de haber) una transacción de paquetes? Ver pkg_tx_activa.
    fn pkg_tx_activa(&mut self) -> bool;
    /// ¿Los drivers cargados difieren de los instalados? Ver pkg_sesion_desincronizada.
    fn sesion_desincronizada(&mut self) -> bool;
    /// Partición → disco padre (sdb1→sdb).
    fn disco_base(&self, dev: &str) -> String;
    /// ¿Disco interno presente y no extraíble?
    fn disco_interno(&self, base: &str) -> bool;
}

const PKG_LOCKS: &[&str] = &["/var/lib/pacman/db.lck"];
/// Nombres (comm, 15 caracteres como mucho) de gestores cuyo lock no sirve con `-e`.
const PKG_PROCS: &[&str] = &[
    "apt", "apt-get", "aptitude", "dpkg", "unattended-upgr", "dnf", "dnf5", "zypper", "rpm",
];
const PKG_GRACIA: Duration = Duration::from_secs(90);
const DESYNC_TTL: Duration = Duration::from_secs(60);

#[derive(Default)]
pub struct Real {
    pkg_hasta: Option<Instant>,
    procs_ts: Option<Instant>,
    procs_res: bool,
    desync: Option<bool>,
    desync_ts: Option<Instant>,
}

impl Entorno for Real {
    fn pkg_tx_activa(&mut self) -> bool {
        let ahora = Instant::now();
        let mut activa = PKG_LOCKS.iter().any(|l| Path::new(l).exists());
        if !activa {
            // Sustituye al `pgrep -x` limitado a una vez cada 2 s: leer /proc/*/comm.
            if self.procs_ts.is_none_or(|t| ahora.duration_since(t) >= Duration::from_secs(2)) {
                self.procs_ts = Some(ahora);
                self.procs_res = hay_proceso(PKG_PROCS);
            }
            activa = self.procs_res;
        }
        if activa {
            self.pkg_hasta = Some(ahora + PKG_GRACIA);
            return true;
        }
        self.pkg_hasta.is_some_and(|h| ahora < h)
    }

    fn sesion_desincronizada(&mut self) -> bool {
        // Una vez positiva no se vuelve a mirar: sin reiniciar no deja de ser cierto.
        if self.desync == Some(true) {
            return true;
        }
        let ahora = Instant::now();
        if self.desync.is_none() || self.desync_ts.is_none_or(|t| ahora.duration_since(t) >= DESYNC_TTL) {
            self.desync_ts = Some(ahora);
            self.desync = Some(calcular_desync());
        }
        self.desync == Some(true)
    }

    fn disco_base(&self, dev: &str) -> String {
        disco_base_en(Path::new("/sys"), dev)
    }

    fn disco_interno(&self, base: &str) -> bool {
        if base.is_empty() {
            return false;
        }
        let dir = Path::new("/sys/block").join(base);
        if !dir.exists() {
            return false; // arrancado en caliente: rastro de escrituras, no disco enfermo
        }
        fs::read_to_string(dir.join("removable")).map(|s| s.trim() != "1").unwrap_or(true)
    }
}

fn hay_proceso(nombres: &[&str]) -> bool {
    let Ok(dir) = fs::read_dir("/proc") else { return false };
    dir.flatten().any(|e| {
        e.file_name().to_str().is_some_and(|n| n.bytes().all(|b| b.is_ascii_digit()))
            && fs::read_to_string(e.path().join("comm"))
                .is_ok_and(|c| nombres.contains(&c.trim_end()))
    })
}

fn calcular_desync() -> bool {
    let rel = fs::read_to_string("/proc/sys/kernel/osrelease").unwrap_or_default();
    if !Path::new("/usr/lib/modules").join(rel.trim()).is_dir() {
        return true;
    }
    let Ok(ejecutando) = fs::read_to_string("/sys/module/nvidia/version") else {
        return false; // sin nvidia cargado no se inventa un desajuste
    };
    let disco = Command::new("modinfo")
        .args(["-F", "version", "nvidia"])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();
    !disco.is_empty() && disco != ejecutando.trim()
}

/// Si el nodo existe se resuelve por sysfs; si ya desapareció (el caso que importa:
/// un pendrive arrancado) se recorta el sufijo de partición a mano.
pub fn disco_base_en(sys: &Path, d: &str) -> String {
    if d.is_empty() {
        return String::new();
    }
    if sys.join("block").join(d).exists() {
        return d.to_string();
    }
    let clase = sys.join("class/block").join(d);
    if let Ok(real) = fs::canonicalize(clase.join("..")) {
        if let Some(p) = real.file_name().and_then(|n| n.to_str()) {
            if sys.join("block").join(p).exists() {
                return p.to_string();
            }
        }
    }
    if ["nvme", "mmcblk", "loop"].iter().any(|p| d.starts_with(p)) {
        // ${d%p[0-9]*}: quita la ÚLTIMA "p<dígito>…"
        match d.rfind('p').filter(|&i| d[i + 1..].starts_with(|c: char| c.is_ascii_digit())) {
            Some(i) => d[..i].to_string(),
            None => d.to_string(),
        }
    } else {
        // ${d%%[0-9]*}: corta en el PRIMER dígito
        d.split(|c: char| c.is_ascii_digit()).next().unwrap_or("").to_string()
    }
}

/// Entorno de mentira para los tests de reglas.
#[cfg(test)]
#[derive(Default)]
pub struct Falso {
    pub tx: bool,
    pub desync: bool,
    pub internos: HashMap<String, bool>,
}

#[cfg(test)]
impl Entorno for Falso {
    fn pkg_tx_activa(&mut self) -> bool {
        self.tx
    }
    fn sesion_desincronizada(&mut self) -> bool {
        self.desync
    }
    fn disco_base(&self, dev: &str) -> String {
        disco_base_en(Path::new("/nonexistent"), dev)
    }
    fn disco_interno(&self, base: &str) -> bool {
        self.internos.get(base).copied().unwrap_or(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_textual() {
        let s = Path::new("/nonexistent");
        assert_eq!(disco_base_en(s, "sdb1"), "sdb");
        assert_eq!(disco_base_en(s, "sdb"), "sdb");
        assert_eq!(disco_base_en(s, "nvme0n1p2"), "nvme0n1");
        assert_eq!(disco_base_en(s, "mmcblk0p1"), "mmcblk0");
        assert_eq!(disco_base_en(s, "nvme0n1"), "nvme0n1");
    }

    #[test]
    fn puerta_de_juego() {
        let yo = std::process::id();
        let e = |j: &str| serde_json::from_str::<serde_json::Value>(&j.replace("PID", &yo.to_string())).unwrap();
        let t = 10_000;
        // Jugando con foco → congela.
        assert!(congelar_ahora(&e(r#"{"pid":PID,"gaming":true,"gameFocused":true}"#), true, t).is_some());
        // Interruptor gamingFreeze apagado → no.
        assert!(congelar_ahora(&e(r#"{"pid":PID,"gaming":true,"gameFocused":true}"#), false, t).is_none());
        // Juego aparcado hace más de 5 min → a trabajar.
        assert!(congelar_ahora(&e(r#"{"pid":PID,"gaming":true,"lastGameFocus":9000}"#), true, t).is_none());
        // Aparcado hace 100 s → congela y espera lo que falta de gracia (200 s).
        assert_eq!(congelar_ahora(&e(r#"{"pid":PID,"gaming":true,"lastGameFocus":9900}"#), true, t), Some(Duration::from_secs(200)));
        // Ahorro, aunque gamingFreeze esté apagado.
        assert!(congelar_ahora(&e(r#"{"pid":PID,"powerSaveFreeze":true}"#), false, t).is_some());
        // AGS muerto → fail-open.
        assert!(congelar_ahora(&e(r#"{"pid":999999999,"gaming":true,"gameFocused":true}"#), true, t).is_none());
    }

    #[test]
    fn config_solo_false_explicito() {
        let a = apagadas_de(r#"{"ssh": false, "sudoAuth": true, "inventada": false, "gpuError": "false"}"#);
        assert_eq!(a, vec!["ssh".to_string()]);
        assert!(apagadas_de("{corrupto").is_empty());
    }
}
