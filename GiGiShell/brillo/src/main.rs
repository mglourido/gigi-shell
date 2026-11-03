//! Respaldo de las teclas de brillo (XF86MonBrightnessUp/Down) cuando AGS no responde.
//!
//! El bind prueba antes `pedir-ags.sh brightness-up|down`; solo si falla llega aquí. Hace
//! lo mismo que `servicios/pantalla/brightness.ts` en su tramo de HARDWARE: panel interno
//! con `brightnessctl -c backlight`, monitor externo con `ddcutil setvcp 10`. No toca el
//! gamma (`hyprsunset` es de AGS), no enseña OSD ni escribe `display.json`: cuando AGS
//! vuelva, `detectDdc()` / el watcher de udev releen el hardware y el slider se pone al día.
//!
//! Constantes espejo de `atenuacion.ts` (`DIM_FLOOR`) y de `puentes.ts` (salto 0,1): si
//! cambian allí, cambiarlas aquí. `bin/preflight.sh` avisa si difieren.

use std::fs::{self, File};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, SystemTime};

const DIM_FLOOR: f64 = 0.35;
const SALTO: f64 = 0.1;
const VCP: &str = "10";
const TECHO_DDC: &str = "10";
/// Una lectura DDC cuesta ~0,3 s: con la tecla mantenida se reutiliza la última escrita.
const VIGENCIA: Duration = Duration::from_secs(3);

/// Brillo compuesto (lo que ve el slider) tras un salto, sin bajar del suelo: por debajo
/// solo trabaja el gamma, que aquí no se toca. Devuelve el ratio de HARDWARE 0..1.
fn paso(hw: f64, delta: f64) -> f64 {
    let compuesto = DIM_FLOOR + hw.clamp(0.0, 1.0) * (1.0 - DIM_FLOOR);
    let nuevo = (compuesto + delta).clamp(DIM_FLOOR, 1.0);
    (nuevo - DIM_FLOOR) / (1.0 - DIM_FLOOR)
}

fn salida(prog: &str, args: &[&str]) -> Option<String> {
    let o = Command::new(prog).args(args).stderr(Stdio::null()).output().ok()?;
    o.status.success().then(|| String::from_utf8_lossy(&o.stdout).into_owned())
}

// ── panel interno ───────────────────────────────────────────────────────────

fn hay_backlight() -> bool {
    fs::read_dir("/sys/class/backlight").map(|mut d| d.next().is_some()).unwrap_or(false)
}

fn backlight(delta: f64) -> bool {
    // `-c backlight` no es decorativo: sin esa clase brightnessctl cae a un LED (scroll-lock).
    let Some(s) = salida("brightnessctl", &["-c", "backlight", "-m"]) else { return false };
    // nombre,clase,actual,porcentaje,max
    let f: Vec<&str> = s.trim().split(',').collect();
    let (Some(act), Some(max)) = (f.get(2).and_then(|v| v.parse::<f64>().ok()), f.get(4).and_then(|v| v.parse::<f64>().ok())) else { return false };
    if max <= 0.0 { return false }
    let pct = (paso(act / max, delta) * 100.0).round() as u32;
    Command::new("brightnessctl")
        .args(["-c", "backlight", "-n2", "s", &format!("{pct}%")])
        .stdout(Stdio::null()).stderr(Stdio::null())
        .status().map(|s| s.success()).unwrap_or(false)
}

// ── monitor externo (DDC/CI) ────────────────────────────────────────────────

#[derive(Clone, Copy)]
struct Ddc { bus: u32, max: f64, actual: f64 }

fn ruta_cache() -> PathBuf {
    let dir = std::env::var_os("XDG_RUNTIME_DIR").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
    dir.join("gigishell-brillo")
}

/// `bus max actual` si el fichero es reciente (el bus y el máximo no cambian en la sesión;
/// el valor actual solo vale unos segundos porque AGS u otro pueden moverlo).
fn leer_cache() -> Option<(u32, f64, Option<f64>)> {
    let ruta = ruta_cache();
    let txt = fs::read_to_string(&ruta).ok()?;
    let f: Vec<&str> = txt.split_whitespace().collect();
    let bus = f.first()?.parse().ok()?;
    let max = f.get(1)?.parse().ok()?;
    let fresco = fs::metadata(&ruta).and_then(|m| m.modified()).ok()
        .and_then(|t| SystemTime::now().duration_since(t).ok())
        .map(|d| d < VIGENCIA).unwrap_or(false);
    let actual = if fresco { f.get(2).and_then(|v| v.parse().ok()) } else { None };
    Some((bus, max, actual))
}

fn guardar_cache(d: Ddc) {
    let _ = fs::write(ruta_cache(), format!("{} {} {}\n", d.bus, d.max, d.actual));
}

/// Interpreta `getvcp 10 --terse`: "VCP 10 C <actual> <max>".
fn parsear_vcp(s: &str) -> Option<(f64, f64)> {
    let f: Vec<&str> = s.split_whitespace().collect();
    if f.first() != Some(&"VCP") || f.get(1) != Some(&VCP) { return None }
    let (a, m): (f64, f64) = (f.get(3)?.parse().ok()?, f.get(4)?.parse().ok()?);
    (m > 0.0).then_some((a, m))
}

fn leer_vcp(bus: u32) -> Option<(f64, f64)> {
    let b = bus.to_string();
    parsear_vcp(&salida("timeout", &[TECHO_DDC, "ddcutil", "--bus", &b, "getvcp", VCP, "--terse"])?)
}

fn detectar_bus() -> Option<u32> {
    let s = salida("timeout", &[TECHO_DDC, "ddcutil", "detect", "--terse"])?;
    let i = s.find("/dev/i2c-")? + "/dev/i2c-".len();
    s[i..].chars().take_while(|c| c.is_ascii_digit()).collect::<String>().parse().ok()
}

fn estado_ddc() -> Option<Ddc> {
    let cache = leer_cache();
    if let Some((bus, max, Some(actual))) = cache {
        return Some(Ddc { bus, max, actual });
    }
    // Bus guardado primero (ahorra ~1 s); si ya no contesta —monitor desenchufado, otro
    // dock, el número `i2c-N` ha cambiado— se vuelve a detectar en vez de fallar toda la sesión.
    if let Some((bus, _, _)) = cache {
        if let Some((actual, max)) = leer_vcp(bus) {
            return Some(Ddc { bus, max, actual });
        }
    }
    let bus = detectar_bus()?;
    let (actual, max) = leer_vcp(bus)?;
    Some(Ddc { bus, max, actual })
}

fn ddc(delta: f64) -> bool {
    let Some(mut d) = estado_ddc() else { return false };
    let raw = (paso(d.actual / d.max, delta) * d.max).round();
    let ok = Command::new("timeout")
        .args([TECHO_DDC, "ddcutil", "--bus", &d.bus.to_string(), "--noverify", "setvcp", VCP, &(raw as u32).to_string()])
        .stdout(Stdio::null()).stderr(Stdio::null())
        .status().map(|s| s.success()).unwrap_or(false);
    if ok {
        d.actual = raw;
        guardar_cache(d);
    }
    ok
}

fn main() {
    let delta = match std::env::args().nth(1).as_deref() {
        Some("up") => SALTO,
        Some("down") => -SALTO,
        Some("--version") => {
            println!("{} {}", env!("CARGO_PKG_NAME"), env!("CARGO_PKG_VERSION"));
            return;
        }
        Some("--constantes") => {
            // Lo compara bin/preflight.sh con atenuacion.ts y puentes.ts.
            println!("{DIM_FLOOR} {SALTO}");
            return;
        }
        _ => {
            eprintln!("uso: gigishell-brillo up|down");
            std::process::exit(2);
        }
    };
    // Una sola instancia: la tecla mantenida repite ~25 veces/s y una escritura DDC tarda
    // ~0,3 s. Sin candado los procesos leían el mismo valor y escribían el mismo (pasos
    // perdidos), se peleaban por el bus I2C y, sin caché, lanzaban varios `detect` a la vez.
    // La pulsación que llega con otra en vuelo se descarta: la repetición manda otra enseguida.
    // El candado lo suelta el kernel al morir el proceso (también con `panic = "abort"`).
    let candado = File::create(ruta_cache().with_extension("lock")).ok();
    if let Some(f) = &candado {
        if f.try_lock().is_err() {
            return;
        }
    }
    let ok =if hay_backlight() { backlight(delta) } else { ddc(delta) };
    std::process::exit(if ok { 0 } else { 1 });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sube_y_baja_un_salto_compuesto() {
        // hw 0.5 → compuesto 0.675; +0.1 → 0.775 → hw 0.653…
        assert!((paso(0.5, 0.1) - (0.775 - DIM_FLOOR) / (1.0 - DIM_FLOOR)).abs() < 1e-9);
        assert!((paso(0.5, -0.1) - (0.575 - DIM_FLOOR) / (1.0 - DIM_FLOOR)).abs() < 1e-9);
    }

    #[test]
    fn no_pasa_de_los_extremos_ni_baja_del_suelo() {
        assert_eq!(paso(1.0, 0.1), 1.0);
        assert_eq!(paso(0.0, -0.1), 0.0);
        assert_eq!(paso(0.1, -0.5), 0.0);
    }

    #[test]
    fn entradas_fuera_de_rango_se_recortan() {
        assert_eq!(paso(7.0, 0.0), 1.0);
        assert_eq!(paso(-3.0, 0.0), 0.0);
    }

    #[test]
    fn parsea_getvcp_terse() {
        assert_eq!(parsear_vcp("VCP 10 C 73 100\n"), Some((73.0, 100.0)));
        assert_eq!(parsear_vcp("VCP 12 C 5 100"), None);
        assert_eq!(parsear_vcp("VCP 10 C 5 0"), None);
        assert_eq!(parsear_vcp(""), None);
    }
}
