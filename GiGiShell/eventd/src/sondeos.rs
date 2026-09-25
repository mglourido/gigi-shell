//! Los dos SONDEOS de oom-monitor.sh: `monitor_units` (unidades en `failed`) y
//! `monitor_smart` (disco a punto de fallar). Cada uno en su hilo, con su retardo de
//! arranque (DELAY_UNITS / DELAY_SMART del bash) y detrás de la puerta de juego.
//!
//! Siguen llamando a `systemctl` y `smartctl`: el trabajo está en esos programas y el
//! fork cada 2 min / cada hora no cuesta nada. Lo que se gana es no tener dos bash
//! residentes con su `sleep`.

use std::collections::HashSet;
use std::fs;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use crate::notif::{notificar, Salida};
use crate::sistema::{en_path, esperar_puerta, home, Config, Entorno, Real};

const DELAY_UNITS: Duration = Duration::from_secs(25);
const DELAY_SMART: Duration = Duration::from_secs(45);
const PASADA_UNITS: Duration = Duration::from_secs(120);
const PASADA_SMART: Duration = Duration::from_secs(3600);

fn config() -> Config {
    Config::new(home().join(".config/gigishell/security.json"))
}

// ── Unidades ──────────────────────────────────────────────────────────────────

/// Primera columna de `systemctl --failed --no-legend --plain`.
pub fn unidades_de(salida: &str) -> Vec<String> {
    salida.lines().filter_map(|l| l.split_whitespace().next()).map(str::to_string).collect()
}

fn fallidas(ambito: &str) -> Vec<String> {
    let mut c = Command::new("systemctl");
    if ambito == "user" {
        c.arg("--user");
    }
    c.args(["--failed", "--no-legend", "--plain"]).stderr(Stdio::null());
    c.output().map(|o| unidades_de(&String::from_utf8_lossy(&o.stdout))).unwrap_or_default()
}

/// Nuevas fallidas respecto a `conocidas` (y actualiza `conocidas`, olvidando las
/// recuperadas para volver a avisar si recaen). Con `sembrada == false` no devuelve
/// nada: la primera pasada no avisa de fallos preexistentes.
pub fn diferencia(conocidas: &mut HashSet<String>, actuales: Vec<String>, sembrada: bool) -> Vec<String> {
    let nuevas: Vec<String> = if sembrada {
        actuales.iter().filter(|u| !conocidas.contains(*u)).cloned().collect()
    } else {
        vec![]
    };
    *conocidas = actuales.into_iter().collect();
    nuevas
}

pub fn unidades(salida: Salida) {
    std::thread::sleep(DELAY_UNITS);
    let mut cfg = config();
    let mut env = Real::default();
    let mut conocidas = HashSet::new();
    let mut sembrada = false;
    loop {
        cfg.recargar(Instant::now());
        if !cfg.activo("serviceHealth") {
            // Apagado: al volver a encenderlo se resiembra, para no avisar de golpe de
            // todo lo que cayó mientras estaba apagado como si fuera nuevo.
            sembrada = false;
            std::thread::sleep(PASADA_UNITS);
            continue;
        }
        // La siembra NO pasa por la puerta: si un juego la retuviera, lo que fallase
        // durante la partida se sembraría como preexistente y no se avisaría nunca.
        if sembrada {
            esperar_puerta();
        }
        // En plena actualización se SALTA la pasada entera (sin tocar `conocidas`), así
        // una unidad que quede rota se avisa en la siguiente como nueva.
        if env.pkg_tx_activa() {
            std::thread::sleep(PASADA_UNITS);
            continue;
        }
        let mut actuales = vec![];
        for ambito in ["system", "user"] {
            actuales.extend(fallidas(ambito).into_iter().map(|u| format!("{ambito}/{u}")));
        }
        let nuevas = diferencia(&mut conocidas, actuales, sembrada);
        sembrada = true;
        // La PASADA es el lote: un aviso con todas, sin ventana de tiempo.
        let textos: Vec<String> = nuevas
            .iter()
            .map(|k| {
                let (ambito, u) = k.split_once('/').unwrap_or(("", k));
                format!("{u} ({ambito})")
            })
            .collect();
        match textos.len() {
            0 => {}
            1 => notificar(salida, "servicio.en-fallo", "critical", "Servicio en fallo", &format!("Unidad: {}", textos[0]), 15000),
            n => {
                let mut cuerpo: Vec<String> = textos.iter().take(8).map(|t| format!("· {t}")).collect();
                if n > 8 {
                    cuerpo.push(format!("… y {} más", n - 8));
                }
                notificar(salida, "servicio.en-fallo", "critical", &format!("{n} servicios en fallo"), &cuerpo.join("\n"), 15000);
            }
        }
        std::thread::sleep(PASADA_UNITS);
    }
}

// ── SMART ─────────────────────────────────────────────────────────────────────

/// Discos físicos: en /sys/block, con `device` (descarta zram, loop, dm, md) y sin
/// ópticos. Sustituye al `lsblk | awk` del bash.
fn discos() -> Vec<String> {
    let Ok(dir) = fs::read_dir("/sys/block") else { return vec![] };
    let mut v: Vec<String> = dir
        .flatten()
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|n| !["zram", "loop", "ram", "dm-", "sr", "md"].iter().any(|p| n.starts_with(p)))
        .filter(|n| std::path::Path::new("/sys/block").join(n).join("device").exists())
        .collect();
    v.sort();
    v
}

/// ¿smartctl no pudo leer el disco? Sin root no sale VACÍO, como suponía el bash: imprime
/// su cabecera y «Permission denied» en stdout, así que el aviso de permisos no llegaba
/// nunca y el sondeo SMART no hacía nada sin decirlo.
pub fn smart_sin_permiso(informe: &str) -> bool {
    let l = informe.to_lowercase();
    informe.trim().is_empty() || l.contains("permission denied") || l.contains("operation not permitted")
}

/// `result:\s*FAILED|FAILING_NOW`, sin distinguir mayúsculas.
pub fn smart_falla(informe: &str) -> bool {
    let l = informe.to_lowercase();
    l.contains("failing_now")
        || l.match_indices("result:").any(|(i, m)| l[i + m.len()..].trim_start().starts_with("failed"))
}

pub fn smart(salida: Salida) {
    // Sin smartctl no hay nada que sondear (el bash hacía `return`): no es un problema
    // de permisos y avisarlo como tal en cada inicio de sesión sería mentir.
    if !en_path("smartctl") {
        return;
    }
    std::thread::sleep(DELAY_SMART);
    let mut cfg = config();
    let mut avisado_permisos = false;
    let mut avisados = HashSet::new();
    loop {
        cfg.recargar(Instant::now());
        if cfg.activo("diskHealth") {
            // Consultar SMART despierta cada disco: con un juego delante, se retiene.
            esperar_puerta();
            for d in discos() {
                let dev = format!("/dev/{d}");
                let informe = Command::new("smartctl")
                    .args(["-H", "-A", &dev])
                    .stderr(Stdio::null())
                    .output()
                    .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
                    .unwrap_or_default();
                if smart_sin_permiso(&informe) {
                    if !avisado_permisos {
                        avisado_permisos = true;
                        notificar(salida, "disco.smart-sin-permisos", "normal", "Salud de disco",
                            "smartctl no puede leer SMART (¿faltan privilegios?).", 10000);
                    }
                    continue;
                }
                if smart_falla(&informe) && avisados.insert(dev.clone()) {
                    notificar(salida, "disco.smart-fallo", "critical", "Disco a punto de fallar",
                        &format!("{dev}: SMART reporta fallo inminente. Haz copia de seguridad YA."), 0);
                }
            }
        }
        std::thread::sleep(PASADA_SMART);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn primera_pasada_siembra() {
        let mut k = HashSet::new();
        assert!(diferencia(&mut k, vec!["system/a.service".into()], false).is_empty());
        assert_eq!(diferencia(&mut k, vec!["system/a.service".into(), "user/b.service".into()], true), vec!["user/b.service"]);
        // a se recupera y recae: se vuelve a avisar.
        assert!(diferencia(&mut k, vec!["user/b.service".into()], true).is_empty());
        assert_eq!(diferencia(&mut k, vec!["system/a.service".into(), "user/b.service".into()], true), vec!["system/a.service"]);
    }

    #[test]
    fn columnas() {
        assert_eq!(unidades_de("foo.service loaded failed failed Foo\nbar.timer loaded failed failed Bar\n"), vec!["foo.service", "bar.timer"]);
    }

    #[test]
    fn smart() {
        assert!(smart_falla("SMART overall-health self-assessment test result: FAILED!"));
        assert!(smart_falla("  5 Reallocated_Sector_Ct 0x0033 001 001 005 Pre-fail Always FAILING_NOW 2000"));
        assert!(!smart_falla("SMART overall-health self-assessment test result: PASSED"));
        assert!(smart_sin_permiso("smartctl 7.4\nSmartctl open device: /dev/nvme0n1 failed: Permission denied\n"));
        assert!(smart_sin_permiso("   \n"));
        assert!(!smart_sin_permiso("SMART overall-health self-assessment test result: PASSED"));
    }
}
