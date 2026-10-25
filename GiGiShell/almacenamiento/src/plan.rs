//! El planificador: para cada acción, QUÉ se borraría exactamente y cuánto ocupa.
//!
//! ── Por qué existe ──────────────────────────────────────────────────────────
//! La versión bash tenía un analizador y un limpiador con dos ideas distintas de lo que hacía cada
//! acción, y la cifra de Ajustes nunca coincidía con lo liberado. El caso peor era la caché del
//! AUR: el análisis prometía la carpeta ENTERA y el borrado delegaba en `yay -Sc`, que se lleva
//! otra cosa (y que, además, por dentro lanza `sudo pacman -Sc`, se quedaba 5 minutos esperando
//! una contraseña en una TTY que nadie ve y abortaba sin limpiar nada del AUR).
//!
//! Aquí el análisis y la limpieza llaman a la MISMA función. Para las acciones que borra este
//! binario, `liberable` es la suma de `objetivos`, y limpiar es borrar esos objetivos: lo que se
//! promete y lo que se borra son la misma lista. Solo las acciones de root (paccache, journal,
//! /var/tmp, huérfanos) y Flatpak se ejecutan fuera; para esas, la estimación simula el criterio
//! de la herramienta que borra, no el tamaño de la carpeta.

use crate::disco;
use crate::medir::{asignado, Medidor};
use crate::pacman::{self, Paquete};
use crate::rutas::{self, Entorno, Preferencias};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

pub const PACMAN_PKG: &str = "/var/cache/pacman/pkg";
pub const JOURNAL: &str = "/var/log/journal";

pub struct Contexto {
    pub ent: Entorno,
    pub prefs: Preferencias,
    pub plazo: Option<Instant>,
    pub ahora: i64,
    paquetes: OnceLock<Vec<Paquete>>,
    instantaneas: OnceLock<Vec<u64>>,
}

impl Contexto {
    pub fn new(ent: Entorno, prefs: Preferencias, plazo: Option<Instant>) -> Self {
        let ahora = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
        Contexto { ent, prefs, plazo, ahora, paquetes: OnceLock::new(), instantaneas: OnceLock::new() }
    }

    pub fn paquetes(&self) -> &[Paquete] {
        self.paquetes.get_or_init(pacman::instalados)
    }

    fn instantaneas(&self) -> &[u64] {
        self.instantaneas.get_or_init(disco::subvolumenes_con_instantaneas)
    }

    fn medidor(&self) -> Medidor {
        Medidor::new(self.plazo)
    }
}

/// Algo que este binario borrará, con lo que ocupa medido en el momento de planificar.
#[derive(Debug, Clone)]
pub struct Objetivo {
    pub ruta: PathBuf,
    pub bytes: u64,
}

#[derive(Debug, Default)]
pub struct Plan {
    /// Lo que borra este binario. Vacío en las acciones que ejecuta un tercero.
    pub objetivos: Vec<Objetivo>,
    /// Lo que quedaría libre. `None` = no se puede saber (no es lo mismo que 0).
    pub liberable: Option<u64>,
    /// Lo que ocupa la categoría (solo se mide si se pide: limpiar no lo necesita).
    pub ocupa: Option<u64>,
    pub detalle: String,
    /// Aclaración para la UI cuando `liberable` necesita contexto (instantáneas, restos sin medir).
    pub nota: String,
    /// Si la acción no tiene nada que hacer por configuración, el motivo.
    pub omitida: Option<String>,
    /// «Descargas a la papelera»: los objetivos se MUEVEN, no se borran, y no liberan nada.
    pub mover_a_papelera: bool,
}

impl Plan {
    fn con_objetivos(&mut self, ctx: &Contexto, rutas: Vec<PathBuf>) {
        let rutas = rutas::filtrar_protegidos(rutas, &ctx.prefs.protegidas);
        let mut m = ctx.medidor();
        self.objetivos = rutas.into_iter().map(|r| Objetivo { bytes: m.ruta(&r), ruta: r }).collect();
        let suma = self.objetivos.iter().map(|o| o.bytes).sum();
        self.liberable = if m.agotado { None } else { Some(suma) };
    }

    /// Lo borrado en un subvolumen con instantáneas no libera disco hasta que caduquen.
    fn retenido_si_instantaneas(&mut self, ctx: &Contexto, base: &Path) {
        if disco::en_instantaneas(base, ctx.instantaneas()) && self.liberable.unwrap_or(0) > 0 {
            self.nota = "El espacio no volverá hasta que caduquen las instantáneas de snapper que contienen estos ficheros.".into();
            self.liberable = Some(0);
        }
    }
}

fn medir_ocupa(ctx: &Contexto, rutas: &[PathBuf], pedir: bool) -> Option<u64> {
    if !pedir {
        return None;
    }
    let mut m = ctx.medidor();
    let existentes: Vec<&Path> = rutas.iter().map(PathBuf::as_path).filter(|r| r.exists()).collect();
    if existentes.is_empty() {
        return None;
    }
    let t = m.rutas(existentes);
    (!m.agotado).then_some(t)
}

fn nombre(p: &Path) -> String {
    p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

pub const ACCIONES: &[&str] = &[
    "cachePaquetes",
    "cachePaquetesTotal",
    "cacheAur",
    "huerfanos",
    "registros",
    "temporales",
    "cacheUsuario",
    "miniaturas",
    "cacheDesarrollo",
    "cacheSombreadores",
    "papelera",
    "descargas",
    "flatpak",
    "rutasPersonalizadas",
];

/// Planifica una acción. `ocupa` decide si se mide además el tamaño total de la categoría.
pub fn planificar(id: &str, ctx: &Contexto, ocupa: bool) -> Option<Plan> {
    let ent = &ctx.ent;
    let mut p = Plan::default();
    match id {
        "cacheUsuario" => {
            let rutas = rutas::entradas(&ent.cache).into_iter().filter(|r| !rutas::preservado(&nombre(r))).collect();
            p.con_objetivos(ctx, rutas);
            p.ocupa = medir_ocupa(ctx, &[ent.cache.clone()], ocupa);
        }
        "miniaturas" => {
            let dir = ent.cache.join("thumbnails");
            p.con_objetivos(ctx, rutas::entradas(&dir));
            p.ocupa = medir_ocupa(ctx, &[dir], ocupa);
        }
        "cacheDesarrollo" => {
            let dirs = rutas::rutas_desarrollo(&ent);
            p.con_objetivos(ctx, dirs.iter().flat_map(|d| rutas::entradas(d)).collect());
            p.ocupa = medir_ocupa(ctx, &dirs, ocupa);
        }
        "cacheSombreadores" => {
            let dirs = rutas::rutas_shaders(&ent);
            if dirs.is_empty() {
                p.omitida = Some("No hay ninguna caché de sombreadores.".into());
            }
            p.detalle = dirs.len().to_string();
            p.con_objetivos(ctx, dirs.iter().flat_map(|d| rutas::objetivos_de_ruta(d)).collect());
            p.ocupa = p.liberable;
        }
        "rutasPersonalizadas" => {
            let prefs = &ctx.prefs;
            if prefs.personalizadas.is_empty() && prefs.rechazadas.is_empty() {
                p.omitida = Some("No has añadido ninguna ruta.".into());
            }
            p.detalle = prefs.personalizadas.len().to_string();
            p.con_objetivos(ctx, prefs.personalizadas.iter().flat_map(|r| rutas::objetivos_de_ruta(r)).collect());
            p.ocupa = p.liberable;
            if !prefs.rechazadas.is_empty() {
                p.nota = format!("Se omiten {}: {}", prefs.rechazadas.len(), prefs.rechazadas[0]);
                if prefs.rechazadas.len() > 1 {
                    p.nota += &format!(" (y {} más)", prefs.rechazadas.len() - 1);
                }
                if prefs.personalizadas.is_empty() {
                    p.omitida = Some(p.nota.clone());
                }
            }
        }
        "papelera" => plan_papelera(ctx, &mut p, ocupa),
        "descargas" => plan_descargas(ctx, &mut p, ocupa)?,
        "cacheAur" => plan_aur(ctx, &mut p, ocupa)?,
        "cachePaquetes" => plan_paccache(ctx, &mut p, ocupa),
        "cachePaquetesTotal" => {
            p.ocupa = medir_ocupa(ctx, &[PathBuf::from(PACMAN_PKG)], true);
            p.liberable = p.ocupa;
        }
        "huerfanos" => plan_huerfanos(ctx, &mut p),
        "registros" => plan_journal(ctx, &mut p, ocupa),
        "temporales" => plan_temporales(ctx, &mut p, ocupa),
        "flatpak" => {
            if Command::new("flatpak").arg("--version").stdout(Stdio::null()).stderr(Stdio::null()).status().is_err() {
                return None;
            }
            // `flatpak uninstall --unused` no tiene simulación: reconstruir su criterio sería una
            // segunda implementación. `None` hace que la UI diga «al menos».
            p.ocupa = medir_ocupa(ctx, &[PathBuf::from("/var/lib/flatpak"), ent.datos.join("flatpak")], ocupa);
            p.liberable = None;
        }
        _ => return None,
    }
    Some(p)
}

// ── Papelera ─────────────────────────────────────────────────────────────────

/// `DeletionDate=2026-10-25T19:46:09` (hora local) → epoch.
fn fecha_borrado(texto: &str) -> Option<i64> {
    let v = texto.lines().find_map(|l| l.strip_prefix("DeletionDate="))?.trim();
    let n = |a: usize, b: usize| v.get(a..b)?.parse::<i32>().ok();
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    tm.tm_year = n(0, 4)? - 1900;
    tm.tm_mon = n(5, 7)? - 1;
    tm.tm_mday = n(8, 10)?;
    tm.tm_hour = n(11, 13)?;
    tm.tm_min = n(14, 16)?;
    tm.tm_sec = n(17, 19).unwrap_or(0);
    tm.tm_isdst = -1;
    let t = unsafe { libc::mktime(&mut tm) };
    (t != -1).then_some(t as i64)
}

/// Con un límite de días, la antigüedad es la FECHA DE BORRADO del `.trashinfo`, no la de
/// modificación del fichero: mover a la papelera conserva el `mtime` original, así que con
/// `find -mtime` una foto de hace dos años tirada ayer se vaciaba en la primera limpieza.
fn plan_papelera(ctx: &Contexto, p: &mut Plan, ocupa: bool) {
    let base = ctx.ent.datos.join("Trash");
    let dias = ctx.prefs.dias_papelera;
    let mut rutas = vec![];
    if dias == 0 {
        for d in ["files", "info", "expunged"] {
            rutas.extend(rutas::entradas(&base.join(d)));
        }
    } else {
        let limite = ctx.ahora - dias as i64 * 86400;
        for info in rutas::entradas(&base.join("info")) {
            let n = nombre(&info);
            let Some(fichero) = n.strip_suffix(".trashinfo") else { continue };
            let Some(fecha) = fs::read_to_string(&info).ok().as_deref().and_then(fecha_borrado) else { continue };
            if fecha < limite {
                rutas.push(base.join("files").join(fichero));
                rutas.push(info);
            }
        }
    }
    p.detalle = rutas::entradas(&base.join("files")).len().to_string();
    p.con_objetivos(ctx, rutas);
    p.ocupa = medir_ocupa(ctx, &[base], ocupa);
}

// ── Descargas ────────────────────────────────────────────────────────────────

fn plan_descargas(ctx: &Contexto, p: &mut Plan, ocupa: bool) -> Option<()> {
    let dir = ctx.ent.dir_usuario("DOWNLOAD", "Descargas")?;
    p.detalle = dir.to_string_lossy().into_owned();
    p.ocupa = medir_ocupa(ctx, &[dir.clone()], ocupa);
    let dias = ctx.prefs.dias_descargas;
    if dias == 0 {
        p.omitida = Some("Requiere fijar una antigüedad en días.".into());
        p.liberable = Some(0);
        return Some(());
    }
    // La antigüedad es la MÁS RECIENTE de modificación y cambio de inodo: algunos navegadores
    // conservan la fecha del servidor como `mtime`, y un fichero bajado hoy con fecha de 2019 no
    // es «antiguo». El `ctime` lo pone el kernel al crearlo aquí y no se puede falsear.
    let limite = ctx.ahora - dias as i64 * 86400;
    let viejos = rutas::entradas(&dir)
        .into_iter()
        .filter(|r| fs::symlink_metadata(r).map(|m| m.mtime().max(m.ctime()) < limite).unwrap_or(false))
        .collect();
    p.con_objetivos(ctx, viejos);
    if ctx.prefs.descargas_a_papelera {
        // Mover a la papelera no libera disco (mismo sistema de ficheros): lo liberará «Vaciar
        // papelera», que tiene su propia cifra. Contarlo en las dos prometería el hueco dos veces.
        p.mover_a_papelera = true;
        p.liberable = Some(0);
    }
    Some(())
}

// ── AUR ──────────────────────────────────────────────────────────────────────

/// Ficheros versionados de un clon de AUR, como nombres de primer nivel. `None` si no es un repo.
fn versionados(dir: &Path) -> Option<HashSet<String>> {
    if !dir.join(".git").exists() {
        return None;
    }
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(["ls-files", "-z"])
        .env("GIT_OPTIONAL_LOCKS", "0")
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    Some(
        out.stdout
            .split(|b| *b == 0)
            .filter(|s| !s.is_empty())
            .map(|s| String::from_utf8_lossy(s.split(|b| *b == b'/').next().unwrap_or(s)).into_owned())
            .collect(),
    )
}

/// La caché de yay (`~/.cache/yay/<pkgbase>`) o paru (`~/.cache/paru/clone/<pkgbase>`), planificada
/// a mano en vez de con `yay -Sc`. Criterio, por clon:
///
/// - el pkgbase YA NO está instalado → se borra el clon entero;
/// - está instalado → se conserva el repositorio (`.git` y lo versionado: PKGBUILD, .SRCINFO,
///   parches) y el `.pkg.tar*` de la versión instalada, para poder reinstalarla sin compilar; se
///   borra todo lo demás: versiones viejas, fuentes descargadas (`.deb`, tarballs), `src/`, `pkg/`.
///
/// En esta máquina la diferencia era enorme: `visual-studio-code-bin` guardaba nueve versiones del
/// `.deb` original Y nueve paquetes construidos — 4,8 GB para conservar uno de 290 MB.
fn plan_aur(ctx: &Contexto, p: &mut Plan, ocupa: bool) -> Option<()> {
    let dirs: Vec<PathBuf> = [ctx.ent.cache.join("yay"), ctx.ent.cache.join("paru/clone")]
        .into_iter()
        .filter(|d| d.is_dir())
        .collect();
    if dirs.is_empty() {
        return None;
    }
    let paquetes = ctx.paquetes();
    let mut por_base: HashMap<&str, Vec<&Paquete>> = HashMap::new();
    for pk in paquetes {
        por_base.entry(pk.base.as_str()).or_default().push(pk);
    }
    let nombres: HashSet<&str> = paquetes.iter().map(|p| p.nombre.as_str()).collect();

    let mut rutas = vec![];
    let mut clones = 0;
    for base in &dirs {
        for clon in rutas::entradas(base) {
            if !fs::symlink_metadata(&clon).map(|m| m.is_dir()).unwrap_or(false) {
                continue; // vcs.json, completion.cache: metadatos del propio helper
            }
            clones += 1;
            let n = nombre(&clon);
            let instalados: Vec<&Paquete> = match por_base.get(n.as_str()) {
                Some(v) => v.clone(),
                None if nombres.contains(n.as_str()) => paquetes.iter().filter(|p| p.nombre == n).collect(),
                None => {
                    rutas.push(clon);
                    continue;
                }
            };
            let actuales: Vec<String> = instalados.iter().map(|p| p.fichero()).collect();
            let es_actual = |f: &str| actuales.iter().any(|a| f.starts_with(a.as_str()));
            match versionados(&clon) {
                Some(seguidos) => {
                    for e in rutas::entradas(&clon) {
                        let f = nombre(&e);
                        if f != ".git" && !seguidos.contains(&f) && !es_actual(&f) {
                            rutas.push(e);
                        }
                    }
                }
                // Sin git no se sabe qué es receta y qué es resto: solo lo inequívoco.
                None => {
                    for e in rutas::entradas(&clon) {
                        let f = nombre(&e);
                        if (f.contains(".pkg.tar") && !es_actual(&f)) || f == "src" || f == "pkg" {
                            rutas.push(e);
                        }
                    }
                }
            }
        }
    }
    p.detalle = clones.to_string();
    p.con_objetivos(ctx, rutas);
    p.ocupa = medir_ocupa(ctx, &dirs, ocupa);
    Some(())
}

// ── Caché de pacman (la ejecuta el helper root) ──────────────────────────────

fn plan_paccache(ctx: &Contexto, p: &mut Plan, ocupa: bool) {
    let dir = Path::new(PACMAN_PKG);
    let entradas = rutas::entradas(dir);
    p.detalle = entradas.iter().filter(|e| nombre(e).contains(".pkg.tar")).count().to_string();
    p.ocupa = medir_ocupa(ctx, &[dir.to_path_buf()], ocupa);
    if ctx.paquetes().is_empty() {
        return; // sin base local legible, todo parecería «sobrante»: mejor no saber que mentir
    }
    let mut vistos = HashSet::new();
    p.liberable = Some(
        pacman::sobrantes_cache(dir, ctx.paquetes())
            .iter()
            .filter_map(|n| fs::symlink_metadata(dir.join(n)).ok())
            .filter(|m| vistos.insert(m.ino()))
            .map(|m| asignado(&m))
            .sum(),
    );
    // Descargas de pacman a medias (`download-XXXXXX`, de root y sin permiso de lectura): el
    // helper las borra con el resto, pero desde aquí no se pueden medir.
    let restos = entradas.iter().filter(|e| nombre(e).starts_with("download-")).count();
    if restos > 0 {
        p.nota = format!("Además se borran {restos} descargas de pacman a medias, que no se pueden medir sin permisos.");
    }
}

// ── Huérfanos ────────────────────────────────────────────────────────────────

fn plan_huerfanos(ctx: &Contexto, p: &mut Plan) {
    let Some(lista) = pacman::huerfanos() else { return };
    let idx = pacman::por_nombre(ctx.paquetes());
    let bytes: u64 = lista.iter().filter_map(|n| idx.get(n.as_str())).map(|p| p.bytes).sum();
    p.detalle = lista.len().to_string();
    p.ocupa = Some(bytes);
    p.liberable = Some(bytes);
    // Sus ficheros viven en /usr, dentro del subvolumen raíz: con snapper (y snap-pac, que hace una
    // instantánea antes de cada `pacman -Rns`) quitarlos no libera nada todavía.
    p.retenido_si_instantaneas(ctx, Path::new("/usr"));
}

// ── Journal ──────────────────────────────────────────────────────────────────

/// Simula `journalctl --vacuum-size`: por cada directorio de journal, borra ficheros ARCHIVADOS
/// (nunca el activo) del más antiguo al más nuevo hasta que el total cabe en la retención. La
/// versión anterior restaba «tamaño − retención», que promete también lo que no se puede borrar.
pub fn simular_vacuum(dir: &Path, retener: u64) -> Option<u64> {
    let mut liberable = 0;
    let maquinas = fs::read_dir(dir).ok()?;
    for m in maquinas.flatten() {
        let Ok(ficheros) = fs::read_dir(m.path()) else { continue };
        let mut total = 0u64;
        let mut archivados: Vec<(u64, u64)> = vec![]; // (realtime, bytes)
        for f in ficheros.flatten() {
            let n = f.file_name().to_string_lossy().into_owned();
            if !n.ends_with(".journal") && !n.ends_with(".journal~") {
                continue;
            }
            let Ok(md) = f.metadata() else { continue };
            let b = asignado(&md);
            total += b;
            if let Some(t) = tiempo_archivado(&n) {
                archivados.push((t, b));
            } else if n.ends_with('~') {
                archivados.push((md.mtime().max(0) as u64 * 1_000_000, b));
            }
        }
        archivados.sort();
        for (_, b) in archivados {
            if total <= retener {
                break;
            }
            total -= b;
            liberable += b;
        }
    }
    Some(liberable)
}

/// `system@<seqnum_id>-<head_seqnum>-<head_realtime>.journal` (archivado limpio) o
/// `system@<realtime>-<aleatorio>.journal~` (archivado sucio). El activo no lleva `@`.
fn tiempo_archivado(n: &str) -> Option<u64> {
    let (_, resto) = n.split_once('@')?;
    if let Some(s) = resto.strip_suffix(".journal~") {
        return u64::from_str_radix(s.split('-').next()?, 16).ok();
    }
    let s = resto.strip_suffix(".journal")?;
    u64::from_str_radix(s.rsplit('-').next()?, 16).ok()
}

fn plan_journal(ctx: &Contexto, p: &mut Plan, ocupa: bool) {
    let dir = Path::new(JOURNAL);
    p.ocupa = medir_ocupa(ctx, &[dir.to_path_buf()], ocupa);
    p.liberable = simular_vacuum(dir, ctx.prefs.retener_bytes());
    p.retenido_si_instantaneas(ctx, dir);
}

// ── /var/tmp ─────────────────────────────────────────────────────────────────

/// Simula `find /var/tmp -xdev -mindepth 1 -mtime +1 -delete` del helper: ficheros (no carpetas,
/// que `-delete` solo quita vacías) con dos días cumplidos. Lo que el usuario no puede leer (los
/// `systemd-private-*`) queda fuera: la estimación es un mínimo.
fn plan_temporales(ctx: &Contexto, p: &mut Plan, ocupa: bool) {
    let dir = Path::new("/var/tmp");
    p.ocupa = medir_ocupa(ctx, &[dir.to_path_buf()], ocupa);
    let limite = ctx.ahora - 2 * 86400;
    let Ok(raiz) = fs::symlink_metadata(dir) else { return };
    let mut total = 0;
    let mut pila = vec![dir.to_path_buf()];
    while let Some(d) = pila.pop() {
        let Ok(rd) = fs::read_dir(&d) else { continue };
        for e in rd.flatten() {
            let Ok(md) = e.metadata() else { continue };
            if md.dev() != raiz.dev() {
                continue;
            }
            if md.is_dir() {
                pila.push(e.path());
            } else if md.mtime() < limite {
                total += asignado(&md);
            }
        }
    }
    p.liberable = Some(total);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pruebas::Temp;

    fn ctx(t: &Temp, prefs: serde_json::Value) -> Contexto {
        let ent = Entorno::de_prueba(t.raiz());
        let prefs = Preferencias::desde_json(&prefs, &ent);
        Contexto::new(ent, prefs, None)
    }

    #[test]
    fn cache_usuario_respeta_preservados_y_protegidas() {
        let t = Temp::new();
        t.fichero(".cache/navegador/a", 100_000);
        t.fichero(".cache/navegador/perfil/b", 100_000);
        t.fichero(".cache/yay/x/c", 100_000);
        t.fichero(".cache/gigishell/d", 100_000);
        let prot = rutas::canonica(&t.p(".cache/navegador/perfil")).unwrap();
        let c = ctx(&t, serde_json::json!({"rutasProtegidas": [prot]}));
        let p = planificar("cacheUsuario", &c, true).unwrap();
        let mut obj: Vec<String> = p.objetivos.iter().map(|o| o.ruta.to_string_lossy().into_owned()).collect();
        obj.sort();
        assert_eq!(obj.len(), 1);
        assert!(obj[0].ends_with(".cache/navegador/a"));
        assert!(p.ocupa.unwrap() > p.liberable.unwrap());
    }

    #[test]
    fn papelera_usa_la_fecha_de_borrado() {
        let t = Temp::new();
        t.fichero(".local/share/Trash/files/viejo", 1000);
        t.fichero(".local/share/Trash/files/nuevo", 1000);
        t.dir(".local/share/Trash/info");
        fs::write(t.p(".local/share/Trash/info/viejo.trashinfo"), "[Trash Info]\nPath=/x\nDeletionDate=2001-01-01T00:00:00\n").unwrap();
        fs::write(t.p(".local/share/Trash/info/nuevo.trashinfo"), "[Trash Info]\nPath=/x\nDeletionDate=2999-01-01T00:00:00\n").unwrap();
        let c = ctx(&t, serde_json::json!({"diasPapelera": 30}));
        let p = planificar("papelera", &c, false).unwrap();
        let obj: Vec<String> = p.objetivos.iter().map(|o| nombre(&o.ruta)).collect();
        assert_eq!(obj.len(), 2);
        assert!(obj.contains(&"viejo".to_string()));
        assert!(obj.contains(&"viejo.trashinfo".to_string()));
    }

    #[test]
    fn descargas_sin_dias_no_borra_nada() {
        let t = Temp::new();
        t.fichero("Descargas/x", 1000);
        let c = ctx(&t, serde_json::json!({}));
        let p = planificar("descargas", &c, false).unwrap();
        assert!(p.objetivos.is_empty());
        assert!(p.omitida.is_some());
    }

    #[test]
    fn nombres_de_journal() {
        assert_eq!(
            tiempo_archivado("system@f435ef33156944959e5b67472978f656-0000000000040cda-00065e36ce4fd448.journal"),
            Some(0x00065e36ce4fd448)
        );
        assert_eq!(tiempo_archivado("system@00065e5de2ba6800-6c7ef44da5e0c3c1.journal~"), Some(0x00065e5de2ba6800));
        assert_eq!(tiempo_archivado("system.journal"), None);
    }

    #[test]
    fn vacuum_nunca_borra_el_activo() {
        let t = Temp::new();
        t.fichero("j/m/system.journal", 300_000);
        t.fichero("j/m/system@a-1-0000000000000001.journal", 300_000);
        t.fichero("j/m/system@a-2-0000000000000002.journal", 300_000);
        let uno = crate::medir::tam(&t.p("j/m/system.journal"));
        // Retención mínima: se borran los dos archivados, nunca el activo.
        assert_eq!(simular_vacuum(&t.p("j"), 0), Some(uno * 2));
        // Cabe todo: nada.
        assert_eq!(simular_vacuum(&t.p("j"), u64::MAX), Some(0));
        // Cabe con quitar uno: el más antiguo.
        assert_eq!(simular_vacuum(&t.p("j"), uno * 2), Some(uno));
    }

    #[test]
    fn fecha_de_trashinfo() {
        let a = fecha_borrado("DeletionDate=2026-10-25T19:46:09").unwrap();
        let b = fecha_borrado("DeletionDate=2026-10-26T19:46:09").unwrap();
        assert_eq!(b - a, 86400);
        assert!(fecha_borrado("nada").is_none());
    }
}
