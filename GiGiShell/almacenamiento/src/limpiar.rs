//! `limpiar`: ejecuta acciones y devuelve, por cada una, `{accion, estado, liberado, recuperado,
//! mensaje}`.
//!
//! - **`liberado`** es lo que se ha borrado, medido igual que la estimación (bloques asignados).
//!   En las acciones propias es la suma de los objetivos del plan que ya no existen, así que
//!   coincide con lo prometido salvo que algo no se pudiera borrar — y entonces lo dice `mensaje`.
//! - **`recuperado`** es lo que creció el espacio disponible del disco, medido con `statvfs` antes
//!   y después (forzando la escritura del sistema de ficheros, ver `disco::sincronizar`). Es la
//!   única cifra que incluye lo que nadie puede calcular sin root: la compresión de btrfs y lo que
//!   retienen las instantáneas. Por eso las dos cifras se dan por separado y no se mezclan.
//!
//! El desenlace va en el JSON y no en el código de salida: en un lote desatendido, que falle una
//! acción no debe cancelar las demás.

use crate::disco;
use crate::medir;
use crate::plan::{self, Contexto, Plan};
use crate::rutas;
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

pub const HELPER: &str = "/usr/local/bin/gigishell-limpieza";

struct Resultado {
    estado: &'static str,
    liberado: u64,
    mensaje: String,
}

impl Resultado {
    fn ok(liberado: u64) -> Self {
        Resultado { estado: "ok", liberado, mensaje: String::new() }
    }
    fn con(estado: &'static str, mensaje: impl Into<String>) -> Self {
        Resultado { estado, liberado: 0, mensaje: mensaje.into() }
    }
}

/// Mismo formato que `formatearBytes` de la UI: unidades binarias con `i`, coma decimal.
pub fn legible(b: u64) -> String {
    const U: [&str; 6] = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
    let mut v = b as f64;
    let mut i = 0;
    while v >= 1024.0 && i < U.len() - 1 {
        v /= 1024.0;
        i += 1;
    }
    if i == 0 {
        return format!("{b} B");
    }
    let s = format!("{v:.1}").replace('.', ",");
    format!("{} {}", s.strip_suffix(",0").unwrap_or(&s), U[i])
}

fn borrar(ruta: &Path) -> std::io::Result<()> {
    // `remove_dir_all` no sigue enlaces simbólicos: un symlink dentro de una caché se borra él,
    // no lo que hay al otro lado.
    match fs::symlink_metadata(ruta) {
        Ok(m) if m.is_dir() => fs::remove_dir_all(ruta),
        Ok(_) => fs::remove_file(ruta),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}

/// Borra los objetivos del plan. Lo liberado es lo planificado menos lo que haya sobrevivido.
fn ejecutar_plan(p: &Plan) -> Resultado {
    let mut liberado = 0;
    let mut fallos: Vec<(PathBuf, String)> = vec![];
    for o in &p.objetivos {
        let r = borrar(&o.ruta);
        let queda = if o.ruta.symlink_metadata().is_ok() { medir::tam(&o.ruta) } else { 0 };
        liberado += o.bytes.saturating_sub(queda);
        if let Err(e) = r {
            fallos.push((o.ruta.clone(), e.to_string()));
        }
    }
    let mut res = Resultado::ok(liberado);
    if let Some((ruta, e)) = fallos.first() {
        res.mensaje = format!("No se pudieron borrar {} elemento(s); por ejemplo {}: {e}", fallos.len(), ruta.display());
    }
    res
}

/// Mueve los objetivos a la papelera con `gio trash` (descargas, con el interruptor encendido).
fn mover_a_papelera(p: &Plan) -> Resultado {
    if p.objetivos.is_empty() {
        return Resultado::ok(0);
    }
    for trozo in p.objetivos.chunks(200) {
        let _ = Command::new("gio")
            .arg("trash")
            .arg("--")
            .args(trozo.iter().map(|o| &o.ruta))
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    let movido: u64 = p.objetivos.iter().filter(|o| !o.ruta.exists()).map(|o| o.bytes).sum();
    let mut r = Resultado::ok(0);
    r.mensaje = format!("Se han movido {} a la papelera. Vacíala para liberar el espacio.", legible(movido));
    r
}

/// Las acciones de root van al helper con `sudo -n`: sin contraseña, o no van. Un `sudo` que
/// pudiera preguntar se quedaría esperando en una TTY que nadie ve — exactamente lo que hacía
/// `yay -Sc` y por lo que la autolimpieza tardaba cinco minutos.
fn helper(args: &[&str]) -> Resultado {
    if !Path::new(HELPER).exists() {
        return Resultado::con("sin-permisos", format!("Falta {HELPER} (se instala con install.sh)."));
    }
    let out = Command::new("sudo").arg("-n").arg(HELPER).args(args).stdin(Stdio::null()).output();
    match out {
        Ok(o) if o.status.success() => Resultado::ok(String::from_utf8_lossy(&o.stdout).trim().parse().unwrap_or(0)),
        Ok(o) => {
            let err = String::from_utf8_lossy(&o.stderr);
            let linea = err.lines().last().unwrap_or("el helper falló").to_string();
            if linea.contains("password") || linea.contains("contraseña") {
                return Resultado::con("sin-permisos", "La regla de sudoers del helper no está instalada o no cubre esta acción.");
            }
            Resultado::con("error", linea)
        }
        Err(e) => Resultado::con("error", e.to_string()),
    }
}

fn antes_despues(rutas: &[PathBuf], f: impl FnOnce() -> Option<Resultado>) -> Resultado {
    let medir = || rutas.iter().map(|r| medir::tam(r)).sum::<u64>();
    let antes = medir();
    if let Some(r) = f() {
        return r;
    }
    Resultado::ok(antes.saturating_sub(medir()))
}

fn ejecutar(id: &str, ctx: &Contexto) -> Resultado {
    match id {
        "cachePaquetes" => return helper(&["paccache"]),
        "registros" => return helper(&["journal", &ctx.prefs.retener_journal]),
        "temporales" => return helper(&["tmp"]),
        "huerfanos" => return helper(&["huerfanos"]),
        "cachePaquetesTotal" => {
            return antes_despues(&[PathBuf::from(plan::PACMAN_PKG)], || {
                let o = Command::new("pkexec").args(["/usr/bin/pacman", "-Scc", "--noconfirm"]).stdin(Stdio::null()).output();
                match o {
                    Ok(o) if o.status.success() => None,
                    Ok(o) if o.status.code() == Some(126) => Some(Resultado::con("cancelado", "Cancelado.")),
                    Ok(o) => Some(Resultado::con(
                        "error",
                        String::from_utf8_lossy(&o.stderr).lines().last().unwrap_or("pacman -Scc falló").to_string(),
                    )),
                    Err(e) => Some(Resultado::con("error", e.to_string())),
                }
            })
        }
        "flatpak" => {
            let dirs = [PathBuf::from("/var/lib/flatpak"), ctx.ent.datos.join("flatpak")];
            return antes_despues(&dirs, || {
                match Command::new("flatpak").args(["uninstall", "--unused", "-y", "--noninteractive"]).stdin(Stdio::null()).output() {
                    Ok(_) => None,
                    Err(_) => Some(Resultado::con("omitida", "Flatpak no está instalado.")),
                }
            });
        }
        _ => {}
    }
    let Some(p) = plan::planificar(id, ctx, false) else {
        return match id {
            "cacheAur" => Resultado::con("omitida", "No hay caché de paru ni de yay."),
            "descargas" => Resultado::con("omitida", "No hay carpeta de Descargas."),
            _ => Resultado::con("error", format!("Acción desconocida: {id}")),
        };
    };
    if let Some(m) = &p.omitida {
        if p.objetivos.is_empty() {
            let mut r = Resultado::con("omitida", m.clone());
            if !p.nota.is_empty() {
                r.mensaje = p.nota.clone();
            }
            return r;
        }
    }
    let mut r = if p.mover_a_papelera { mover_a_papelera(&p) } else { ejecutar_plan(&p) };
    if r.mensaje.is_empty() && !p.nota.is_empty() {
        r.mensaje = p.nota.clone();
    }
    r
}

pub fn limpiar(acciones: &[String], ctx: &Contexto) -> Value {
    let mut salida = vec![];
    for id in acciones {
        let antes = disco::disponible_total();
        let r = ejecutar(id, ctx);
        let recuperado = disco::disponible_total().saturating_sub(antes);
        salida.push(json!({
            "accion": id,
            "estado": r.estado,
            "liberado": r.liberado,
            "recuperado": if r.estado == "ok" { json!(recuperado) } else { Value::Null },
            "mensaje": r.mensaje,
        }));
    }
    Value::Array(salida)
}

/// `--validar-ruta` / `--validar-protegida`: canónica por stdout o motivo por stderr (rc 1).
pub fn validar(modo: &str, ruta: &str, ctx: &Contexto) -> i32 {
    let r = if modo == "--validar-ruta" {
        rutas::personalizada_valida(ruta, &ctx.ent, &ctx.prefs.protegidas)
    } else {
        rutas::protegida_valida(ruta)
    };
    match r {
        Ok(c) => {
            println!("{}", c.display());
            0
        }
        Err(m) => {
            eprintln!("{m}");
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pruebas::Temp;
    use crate::rutas::{Entorno, Preferencias};

    #[test]
    fn formato_legible() {
        assert_eq!(legible(512), "512 B");
        assert_eq!(legible(4 * 1024 * 1024), "4 MiB");
        assert_eq!(legible(4_089_446), "3,9 MiB");
    }

    /// De punta a punta en un `$HOME` de juguete: lo que promete el plan es lo que se libera, lo
    /// protegido sobrevive y los directorios de caché siguen existiendo.
    #[test]
    fn lo_prometido_es_lo_liberado() {
        let t = Temp::new();
        t.fichero(".cache/app/datos", 400_000);
        t.fichero(".cache/app/perfil/sesion", 200_000);
        t.fichero(".cache/thumbnails/large/x.png", 50_000);
        let ent = Entorno::de_prueba(t.raiz());
        let prot = rutas::canonica(&t.p(".cache/app/perfil")).unwrap();
        let prefs = Preferencias::desde_json(&json!({"rutasProtegidas": [prot]}), &ent);
        let ctx = Contexto::new(ent, prefs, None);

        let prometido = plan::planificar("cacheUsuario", &ctx, false).unwrap().liberable.unwrap();
        let r = ejecutar("cacheUsuario", &ctx);
        assert_eq!(r.estado, "ok");
        assert_eq!(r.liberado, prometido);
        assert!(t.p(".cache/app/perfil/sesion").exists());
        assert!(!t.p(".cache/app/datos").exists());
        assert!(t.p(".cache/thumbnails/large/x.png").exists(), "miniaturas tiene su propio botón");

        let despues = plan::planificar("cacheUsuario", &ctx, false).unwrap().liberable.unwrap();
        assert_eq!(despues, 0, "tras limpiar no puede quedar nada «liberable»");

        let r = ejecutar("miniaturas", &ctx);
        assert!(r.liberado > 0);
        assert!(t.p(".cache/thumbnails").is_dir(), "el directorio sobrevive vacío");
    }
}
