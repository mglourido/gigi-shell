//! `analizar`: el inventario de Ajustes > Almacenamiento, como JSON por stdout. No borra nada.
//!
//! Formato versión 3 = el de la versión 2 (`bytes` lo que ocupa, `liberable` lo que liberaría) más
//! `nota` por categoría y `compresion` arriba. `null` sigue significando «no se ha podido medir» y
//! nunca debe pintarse como 0.

use crate::disco;
use crate::pacman;
use crate::plan::{self, Contexto, Plan};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

pub const VERSION: u64 = 3;

fn categoria(id: &str, p: &Plan, limpiable: bool) -> Value {
    let mut liberable = p.liberable;
    // Tope duro: dos medidas tomadas en instantes distintos no pueden prometer más de lo que hay.
    if let (Some(l), Some(o)) = (liberable, p.ocupa) {
        liberable = Some(l.min(o));
    }
    json!({
        "id": id,
        "bytes": p.ocupa,
        "detalle": p.detalle,
        "limpiable": limpiable,
        "liberable": if limpiable { json!(liberable) } else { Value::Null },
        "nota": p.nota,
    })
}

pub fn discos() -> Value {
    let mut vistos: Vec<(String, PathBuf)> = vec![];
    let mut ms = disco::montajes();
    // El punto más corto primero: los subvolúmenes btrfs salen como discos distintos con cifras
    // idénticas, y se deduplican por dispositivo quedándose con `/`.
    ms.sort_by_key(|m| m.punto.as_os_str().len());
    let mut salida = vec![];
    for m in ms {
        if vistos.iter().any(|(d, _)| *d == m.dispositivo) {
            continue;
        }
        let Some(e) = disco::espacio(&m.punto) else { continue };
        if e.total == 0 {
            continue;
        }
        vistos.push((m.dispositivo.clone(), m.punto.clone()));
        let usado = e.total - e.libre;
        // Igual que `df`: porcentaje sobre lo que el usuario puede usar, redondeado hacia arriba.
        let base = usado + e.disponible;
        let pct = if base == 0 { 0 } else { (usado * 100).div_ceil(base) };
        salida.push(json!({
            "dispositivo": m.dispositivo, "punto": m.punto, "fs": m.fs,
            "total": e.total, "usado": usado, "libre": e.disponible, "porcentaje": pct,
        }));
    }
    salida.sort_by(|a, b| a["punto"].as_str().cmp(&b["punto"].as_str()));
    Value::Array(salida)
}

fn instantaneas() -> Option<u64> {
    let helper = Path::new(crate::limpiar::HELPER);
    if !helper.exists() {
        return None;
    }
    let out = Command::new("sudo").args(["-n", crate::limpiar::HELPER, "instantaneas"]).stderr(Stdio::null()).output().ok()?;
    String::from_utf8_lossy(&out.stdout).trim().parse().ok()
}

pub fn categorias(ctx: &Contexto) -> Value {
    let hay_pacman = Path::new("/var/lib/pacman/local").is_dir();
    // Cada categoría recorre su parte del disco; en paralelo el análisis tarda lo que la más lenta
    // (normalmente `~/.cache`), no la suma.
    let acciones: Vec<&str> = [
        "cachePaquetes", "huerfanos", "cacheAur", "registros", "temporales", "flatpak", "cacheUsuario", "miniaturas",
        "cacheDesarrollo", "cacheSombreadores", "papelera", "rutasPersonalizadas", "descargas",
    ]
    .into_iter()
    .filter(|a| hay_pacman || !matches!(*a, "cachePaquetes" | "huerfanos" | "cacheAur"))
    .collect();

    let personales = [
        ("DOCUMENTS", "Documentos", "documentos"),
        ("PICTURES", "Imágenes", "imagenes"),
        ("VIDEOS", "Vídeos", "videos"),
        ("MUSIC", "Música", "musica"),
        ("DESKTOP", "Escritorio", "escritorio"),
    ];

    let (planes, carpetas, snaps) = std::thread::scope(|s| {
        let hilos: Vec<_> = acciones.iter().map(|a| (*a, s.spawn(move || plan::planificar(a, ctx, true)))).collect();
        let carpetas: Vec<_> = personales
            .iter()
            .map(|(clave, resp, id)| {
                (*id, s.spawn(move || {
                    let dir = ctx.ent.dir_usuario(clave, resp)?;
                    let mut m = crate::medir::Medidor::new(ctx.plazo);
                    let b = m.ruta(&dir);
                    Some((dir, (!m.agotado).then_some(b)))
                }))
            })
            .collect();
        let snaps = s.spawn(instantaneas);
        (
            hilos.into_iter().map(|(a, h)| (a, h.join().ok().flatten())).collect::<Vec<_>>(),
            carpetas.into_iter().map(|(id, h)| (id, h.join().ok().flatten())).collect::<Vec<_>>(),
            snaps.join().ok().flatten(),
        )
    });

    let mut salida = vec![];
    if hay_pacman {
        let paquetes = ctx.paquetes();
        salida.push(json!({
            "id": "paquetes", "bytes": paquetes.iter().map(|p| p.bytes).sum::<u64>(),
            "detalle": paquetes.len().to_string(), "limpiable": false, "liberable": null, "nota": "",
        }));
    }
    for (id, p) in planes {
        let Some(p) = p else { continue };
        match id {
            "rutasPersonalizadas" if ctx.prefs.personalizadas.is_empty() => continue,
            "cacheSombreadores" if p.omitida.is_some() => continue,
            _ => {}
        }
        salida.push(categoria(id, &p, true));
        if id == "temporales" {
            // El número de instantáneas va junto al resto del sistema; sin helper (o con cero) la
            // fila no sale, en vez de afirmar que hay cero.
            if let Some(n) = snaps.filter(|n| *n > 0) {
                salida.push(json!({"id": "instantaneas", "bytes": null, "detalle": n.to_string(), "limpiable": false, "liberable": null, "nota": ""}));
            }
        }
    }
    for (id, c) in carpetas {
        if let Some((dir, bytes)) = c {
            salida.push(json!({"id": id, "bytes": bytes, "detalle": dir, "limpiable": false, "liberable": null, "nota": ""}));
        }
    }
    Value::Array(salida)
}

fn fecha(t: i64) -> String {
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    let tt = t as libc::time_t;
    unsafe { libc::localtime_r(&tt, &mut tm) };
    let mut buf = [0u8; 64];
    let n = unsafe { libc::strftime(buf.as_mut_ptr() as *mut _, buf.len(), c"%a %b %e %H:%M:%S %Y".as_ptr(), &tm) };
    String::from_utf8_lossy(&buf[..n]).into_owned()
}

pub fn apps(ctx: &Contexto) -> Value {
    let aur = pacman::extranjeros();
    let mut lista: Vec<&pacman::Paquete> = ctx.paquetes().iter().collect();
    lista.sort_by(|a, b| b.bytes.cmp(&a.bytes));
    Value::Array(
        lista
            .into_iter()
            .map(|p| {
                json!({
                    "nombre": p.nombre, "bytes": p.bytes,
                    "origen": if aur.contains(&p.nombre) { "aur" } else { "repo" },
                    "explicito": p.explicito, "fecha": fecha(p.fecha), "descripcion": p.descripcion,
                })
            })
            .collect(),
    )
}

pub fn todo(ctx: &Contexto) -> Value {
    let (d, c, a) = std::thread::scope(|s| {
        let d = s.spawn(discos);
        let a = s.spawn(|| apps(ctx));
        let c = categorias(ctx);
        (d.join().unwrap_or(Value::Array(vec![])), c, a.join().unwrap_or(Value::Array(vec![])))
    });
    json!({
        "version": VERSION,
        "epoch": ctx.ahora,
        "compresion": disco::comprime(&ctx.ent.home) || disco::comprime(Path::new("/")),
        "discos": d,
        "categorias": c,
        "apps": a,
    })
}
