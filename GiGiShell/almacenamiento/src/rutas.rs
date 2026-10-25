//! Qué se puede tocar y qué no: entorno, preferencias, rutas protegidas y vetadas.
//!
//! Es la traducción de `hypr/scripts/lib/limpieza-rutas.sh`. Allí la lista vivía en un fichero que
//! sourceaban dos scripts para que el análisis y el borrado no discreparan; aquí los dos son el
//! mismo binario y la discrepancia es imposible por construcción (ver `plan.rs`).

use serde_json::Value;
use std::fs;
use std::path::{Component, Path, PathBuf};

/// Las rutas base. Se construye una vez y se pasa a todo, para que las pruebas puedan usar un
/// `$HOME` de juguete en vez del de verdad.
#[derive(Clone, Debug)]
pub struct Entorno {
    pub home: PathBuf,
    pub cache: PathBuf,
    pub datos: PathBuf,
    pub config: PathBuf,
}

impl Entorno {
    pub fn real() -> Self {
        let home = PathBuf::from(std::env::var_os("HOME").unwrap_or_else(|| "/".into()));
        let xdg = |var: &str, defecto: &str| {
            std::env::var_os(var)
                .filter(|v| !v.is_empty())
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join(defecto))
        };
        Entorno {
            cache: xdg("XDG_CACHE_HOME", ".cache"),
            datos: xdg("XDG_DATA_HOME", ".local/share"),
            config: xdg("XDG_CONFIG_HOME", ".config"),
            home,
        }
    }

    #[cfg(test)]
    pub fn de_prueba(home: &Path) -> Self {
        Entorno {
            home: home.to_path_buf(),
            cache: home.join(".cache"),
            datos: home.join(".local/share"),
            config: home.join(".config"),
        }
    }

    /// Carpeta XDG del usuario (`xdg-user-dir`) con el nombre de respaldo si no hay configuración.
    pub fn dir_usuario(&self, clave: &str, respaldo: &str) -> Option<PathBuf> {
        if let Some(r) = leer_user_dirs(&self.config, &self.home, clave) {
            if r != self.home && r.is_dir() {
                return Some(r);
            }
        }
        let r = self.home.join(respaldo);
        r.is_dir().then_some(r)
    }
}

/// Lee `~/.config/user-dirs.dirs` sin lanzar `xdg-user-dir`. Formato: `XDG_DOWNLOAD_DIR="$HOME/x"`.
fn leer_user_dirs(config: &Path, home: &Path, clave: &str) -> Option<PathBuf> {
    let texto = fs::read_to_string(config.join("user-dirs.dirs")).ok()?;
    let prefijo = format!("XDG_{clave}_DIR=");
    let linea = texto.lines().find(|l| l.trim_start().starts_with(&prefijo))?;
    let valor = linea.trim_start()[prefijo.len()..].trim().trim_matches('"');
    let valor = valor.replace("$HOME", &home.to_string_lossy());
    valor.starts_with('/').then(|| PathBuf::from(valor))
}

// ── Canonicalización ─────────────────────────────────────────────────────────

/// Equivalente a `realpath -m`: resuelve los enlaces de la parte que existe y normaliza `.`/`..`
/// en la que no. Es obligatoria ANTES de comparar rutas: sin ella, un `~/basura` que es un symlink
/// a `/` pasa cualquier comprobación textual.
pub fn canonica(ruta: &Path) -> Option<PathBuf> {
    fn paso(base: &mut PathBuf, comp: &Path, saltos: &mut u32) -> Option<()> {
        for c in comp.components() {
            match c {
                Component::RootDir => *base = PathBuf::from("/"),
                Component::CurDir => {}
                Component::ParentDir => {
                    base.pop();
                }
                Component::Normal(n) => {
                    base.push(n);
                    if let Ok(md) = fs::symlink_metadata(&*base) {
                        if md.file_type().is_symlink() {
                            *saltos += 1;
                            if *saltos > 40 {
                                return None;
                            }
                            let destino = fs::read_link(&*base).ok()?;
                            base.pop();
                            paso(base, &destino, saltos)?;
                        }
                    }
                }
                Component::Prefix(_) => return None,
            }
        }
        Some(())
    }
    if !ruta.is_absolute() {
        return None;
    }
    let mut base = PathBuf::from("/");
    let mut saltos = 0;
    paso(&mut base, ruta, &mut saltos)?;
    Some(base)
}

/// `a` es `b` o cuelga de `b`.
pub fn dentro_de(a: &Path, b: &Path) -> bool {
    a == b || a.starts_with(b)
}

// ── Preferencias ─────────────────────────────────────────────────────────────

/// `~/.config/gigishell/almacenamiento.json`, ya validado. Los valores por defecto son los mismos
/// que usaban los scripts: cambiarlos aquí sin cambiarlos en `servicios/disco/preferencias.ts`
/// vuelve a dar dos verdades sobre la misma configuración.
#[derive(Debug, Clone)]
pub struct Preferencias {
    pub retener_journal: String,
    pub dias_papelera: u64,
    pub dias_descargas: u64,
    pub descargas_a_papelera: bool,
    pub personalizadas: Vec<PathBuf>,
    pub rechazadas: Vec<String>,
    pub protegidas: Vec<PathBuf>,
}

impl Preferencias {
    pub fn leer(ent: &Entorno) -> Self {
        let ruta = ent.config.join("gigishell/almacenamiento.json");
        let v: Value = fs::read(&ruta)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or(Value::Null);
        Self::desde_json(&v, ent)
    }

    pub fn desde_json(v: &Value, ent: &Entorno) -> Self {
        let num = |k: &str| v.get(k).and_then(Value::as_u64).unwrap_or(0);
        let mut retener = v.get("retenerJournal").and_then(Value::as_str).unwrap_or("200M").to_string();
        if !journal_valido(&retener) {
            retener = "200M".into();
        }
        let lista = |k: &str| -> Vec<String> {
            v.get(k)
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(Value::as_str)
                        .filter(|s| !s.is_empty())
                        .map(String::from)
                        .collect()
                })
                .unwrap_or_default()
        };

        // Primero las protegidas: hacen falta para validar las personalizadas.
        let protegidas = podar(lista("rutasProtegidas").iter().filter_map(|r| protegida_valida(r).ok()).collect());
        let mut p = Preferencias {
            retener_journal: retener,
            dias_papelera: num("diasPapelera"),
            dias_descargas: num("diasDescargas"),
            // Booleano por `as_bool`, no «verdadero si existe»: `false` tiene que valer `false`.
            descargas_a_papelera: v.get("descargasAPapelera").and_then(Value::as_bool).unwrap_or(false),
            personalizadas: vec![],
            rechazadas: vec![],
            protegidas,
        };
        for r in lista("rutasPersonalizadas") {
            match personalizada_valida(&r, ent, &p.protegidas) {
                Ok(c) => p.personalizadas.push(c),
                Err(m) => p.rechazadas.push(m),
            }
        }
        p
    }

    pub fn retener_bytes(&self) -> u64 {
        let (n, u) = self.retener_journal.split_at(self.retener_journal.len() - 1);
        let n: u64 = n.parse().unwrap_or(200);
        n * match u {
            "K" => 1024,
            "M" => 1024 * 1024,
            _ => 1024 * 1024 * 1024,
        }
    }
}

fn journal_valido(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() >= 2 && b[..b.len() - 1].iter().all(u8::is_ascii_digit) && matches!(b[b.len() - 1], b'K' | b'M' | b'G')
}

// ── Rutas protegidas (lo que NINGUNA limpieza toca) ──────────────────────────

/// Filtra muy poco a propósito: proteger de más como mucho deja algo sin limpiar. No exige que
/// exista (una carpeta que aún no se ha creado, un disco desconectado).
pub fn protegida_valida(cruda: &str) -> Result<PathBuf, String> {
    if cruda.is_empty() {
        return Err("ruta vacía".into());
    }
    if !cruda.starts_with('/') {
        return Err(format!("no es una ruta absoluta: {cruda}"));
    }
    let real = canonica(Path::new(cruda)).ok_or_else(|| format!("ruta ilegible: {cruda}"))?;
    if real == Path::new("/") {
        return Err("proteger / no tiene sentido: no se limpiaría nada".into());
    }
    Ok(real)
}

/// Fuera duplicados y descendientes de otra protegida.
pub fn podar(mut rutas: Vec<PathBuf>) -> Vec<PathBuf> {
    rutas.sort();
    rutas.dedup();
    let todas = rutas.clone();
    rutas.retain(|a| !todas.iter().any(|b| a != b && a.starts_with(b)));
    rutas
}

pub fn protegido_cubre(ruta: &Path, protegidas: &[PathBuf]) -> bool {
    protegidas.iter().any(|p| dentro_de(ruta, p))
}

/// Las tres reglas: el objetivo ES o está DENTRO de una protegida → fuera; no tiene nada que ver
/// → se queda; CONTIENE una protegida → se desciende un nivel y se vuelve a filtrar, para borrar
/// todo lo de alrededor menos lo protegido.
pub fn filtrar_protegidos(objetivos: Vec<PathBuf>, protegidas: &[PathBuf]) -> Vec<PathBuf> {
    if protegidas.is_empty() {
        return objetivos;
    }
    let mut salida = Vec::new();
    let mut pendientes = objetivos;
    for _ in 0..32 {
        if pendientes.is_empty() {
            break;
        }
        let mut siguiente = Vec::new();
        for ruta in pendientes {
            if protegido_cubre(&ruta, protegidas) {
                continue;
            }
            let contiene = protegidas.iter().any(|p| p.starts_with(&ruta));
            let es_dir = fs::symlink_metadata(&ruta).map(|m| m.is_dir()).unwrap_or(false);
            if contiene && es_dir {
                if let Ok(d) = fs::read_dir(&ruta) {
                    siguiente.extend(d.flatten().map(|e| e.path()));
                }
            } else {
                salida.push(ruta);
            }
        }
        pendientes = siguiente;
    }
    salida
}

// ── Rutas personalizadas (lo que el usuario pide borrar) ─────────────────────

fn vetadas(ent: &Entorno) -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = [
        "/", "/home", "/root", "/boot", "/dev", "/etc", "/proc", "/run", "/sys", "/usr", "/var", "/bin", "/sbin",
        "/lib", "/lib64", "/opt", "/srv",
    ]
    .iter()
    .map(PathBuf::from)
    .collect();
    let h = &ent.home;
    v.extend([
        h.clone(),
        ent.config.clone(),
        h.join(".config"),
        h.join(".local"),
        h.join(".local/share"),
        h.join(".local/state"),
        h.join(".ssh"),
        h.join(".gnupg"),
        h.join(".gigishell"),
        h.join(".dotfiles"),
        h.join(".mozilla"),
        ent.cache.clone(),
        ent.datos.clone(),
    ]);
    v
}

/// ¿Se puede vaciar? Devuelve la ruta canónica o el motivo. El filtro vive en quien borra, no en
/// la UI: el JSON se puede editar a mano o venir de otro equipo.
pub fn personalizada_valida(cruda: &str, ent: &Entorno, protegidas: &[PathBuf]) -> Result<PathBuf, String> {
    if cruda.is_empty() {
        return Err("ruta vacía".into());
    }
    if !cruda.starts_with('/') {
        return Err(format!("no es una ruta absoluta: {cruda}"));
    }
    let real = canonica(Path::new(cruda)).ok_or_else(|| format!("ruta ilegible: {cruda}"))?;
    let mostrar = real.display();
    if vetadas(ent).iter().any(|v| *v == real) {
        return Err(format!("ruta protegida: {mostrar}"));
    }
    if protegido_cubre(&real, protegidas) {
        return Err(format!("está en tus rutas protegidas: {mostrar}"));
    }
    if ent.home.starts_with(&real) {
        return Err(format!("contiene tu carpeta personal: {mostrar}"));
    }
    const SISTEMA: [&str; 12] =
        ["/boot", "/dev", "/etc", "/proc", "/run", "/sys", "/usr", "/var", "/bin", "/sbin", "/lib", "/lib64"];
    if SISTEMA.iter().any(|s| real.starts_with(s)) {
        return Err(format!("ruta del sistema: {mostrar}"));
    }
    match fs::metadata(&real) {
        Ok(m) if m.is_dir() || m.is_file() => Ok(real),
        _ => Err(format!("no existe o no es una carpeta ni un fichero: {mostrar}")),
    }
}

/// Qué borrar para «limpiar» una ruta: el contenido si es carpeta (la carpeta sobrevive: hay apps
/// que no recrean su directorio), el propio fichero si es fichero.
pub fn objetivos_de_ruta(ruta: &Path) -> Vec<PathBuf> {
    match fs::symlink_metadata(ruta) {
        Ok(m) if m.is_dir() => entradas(ruta),
        Ok(_) => vec![ruta.to_path_buf()],
        Err(_) => vec![],
    }
}

/// Entradas de primer nivel de un directorio (vacío si no existe o no se puede leer).
pub fn entradas(dir: &Path) -> Vec<PathBuf> {
    fs::read_dir(dir).map(|d| d.flatten().map(|e| e.path()).collect()).unwrap_or_default()
}

// ── Listas fijas ─────────────────────────────────────────────────────────────

/// Nombres de primer nivel de `~/.cache` que `cacheUsuario` NO toca: o no son caché (gigishell), o
/// tienen su propio botón (AUR, miniaturas, desarrollo, sombreadores). Patrones con `*`.
pub const CACHE_PRESERVADO: &[&str] = &[
    "gigishell",
    "paru",
    "yay",
    "mesa_shader_cache*",
    "nvidia",
    "radv_builtin_shaders*",
    "AMD",
    "qtshadercache-*",
    "thumbnails",
    "pip",
    "go-build",
];

/// Comparación de patrones con `*` (lo único que usan las listas de aquí).
pub fn casa_patron(patron: &str, nombre: &str) -> bool {
    let partes: Vec<&str> = patron.split('*').collect();
    if partes.len() == 1 {
        return patron == nombre;
    }
    let (primera, ultima) = (partes[0], partes[partes.len() - 1]);
    if !nombre.starts_with(primera) || nombre.len() < primera.len() + ultima.len() || !nombre.ends_with(ultima) {
        return false;
    }
    let mut resto = &nombre[primera.len()..nombre.len() - ultima.len()];
    for p in &partes[1..partes.len() - 1] {
        match resto.find(p) {
            Some(i) => resto = &resto[i + p.len()..],
            None => return false,
        }
    }
    true
}

pub fn preservado(nombre: &str) -> bool {
    CACHE_PRESERVADO.iter().any(|p| casa_patron(p, nombre))
}

/// Cachés de sombreadores (OpenGL, Vulkan, CUDA, Steam). Canonicalizadas y sin repetir: en esta
/// máquina `~/.steam/steam` y `~/.local/share/Steam` son el mismo directorio.
pub fn rutas_shaders(ent: &Entorno) -> Vec<PathBuf> {
    let mut candidatas: Vec<PathBuf> = vec![];
    for e in entradas(&ent.cache) {
        let n = e.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        if ["mesa_shader_cache*", "radv_builtin_shaders*", "qtshadercache-*", "nvidia", "AMD"]
            .iter()
            .any(|p| casa_patron(p, &n))
        {
            candidatas.push(e);
        }
    }
    let h = &ent.home;
    candidatas.extend([
        h.join(".nv/GLCache"),
        h.join(".nv/ComputeCache"),
        ent.datos.join("Steam/steamapps/shadercache"),
        h.join(".steam/steam/steamapps/shadercache"),
        h.join(".var/app/com.valvesoftware.Steam/data/Steam/steamapps/shadercache"),
    ]);
    let mut vistas: Vec<PathBuf> = vec![];
    for c in candidatas {
        if !c.exists() {
            continue;
        }
        if let Some(r) = canonica(&c) {
            if !vistas.contains(&r) {
                vistas.push(r);
            }
        }
    }
    vistas.sort();
    vistas
}

/// Cachés de desarrollo, exactamente lo que vacía la acción. De npm solo `_cacache` (lo que borra
/// `npm cache clean`); de cargo solo `registry/cache` — `registry/src` es el código del que
/// dependen las compilaciones ya hechas.
pub fn rutas_desarrollo(ent: &Entorno) -> Vec<PathBuf> {
    vec![
        ent.home.join(".npm/_cacache"),
        ent.cache.join("pip"),
        ent.cache.join("go-build"),
        ent.home.join(".cargo/registry/cache"),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pruebas::Temp;

    #[test]
    fn patrones() {
        assert!(casa_patron("radv_builtin_shaders*", "radv_builtin_shaders64"));
        assert!(casa_patron("qtshadercache-*", "qtshadercache-x86_64-little_endian-lp64"));
        assert!(casa_patron("yay", "yay"));
        assert!(!casa_patron("yay", "yayo"));
        assert!(casa_patron("a*b*c", "aXXbYYc"));
        assert!(!casa_patron("a*b*c", "aXXc"));
    }

    #[test]
    fn canonica_resuelve_symlinks_y_puntos() {
        let t = Temp::new();
        std::os::unix::fs::symlink("/", t.p("basura")).unwrap();
        assert_eq!(canonica(&t.p("basura")).unwrap(), PathBuf::from("/"));
        let real = canonica(t.raiz()).unwrap();
        assert_eq!(canonica(&t.p("x/../y/./z")).unwrap(), real.join("y/z"));
    }

    #[test]
    fn rechaza_symlink_a_la_raiz_y_hogar() {
        let t = Temp::new();
        let ent = Entorno::de_prueba(t.raiz());
        std::os::unix::fs::symlink("/", t.p("basura")).unwrap();
        let r = personalizada_valida(&t.p("basura").to_string_lossy(), &ent, &[]);
        assert!(r.unwrap_err().starts_with("ruta protegida"));
        assert!(personalizada_valida(&t.raiz().to_string_lossy(), &ent, &[]).is_err());
        assert!(personalizada_valida("/usr/share", &ent, &[]).is_err());
        assert!(personalizada_valida("relativa", &ent, &[]).is_err());
        assert!(personalizada_valida(&ent.cache.to_string_lossy(), &ent, &[]).is_err());
    }

    #[test]
    fn acepta_carpeta_propia_y_respeta_protegidas() {
        let t = Temp::new();
        let ent = Entorno::de_prueba(t.raiz());
        t.dir("basura/dentro");
        let c = personalizada_valida(&t.p("basura").to_string_lossy(), &ent, &[]).unwrap();
        assert_eq!(c, canonica(&t.p("basura")).unwrap());
        let prot = vec![c.clone()];
        assert!(personalizada_valida(&t.p("basura").to_string_lossy(), &ent, &prot).is_err());
    }

    #[test]
    fn filtrar_desciende_alrededor_de_lo_protegido() {
        let t = Temp::new();
        t.fichero("c/foo/perfil/x", 10);
        t.fichero("c/foo/otro", 10);
        t.fichero("c/bar", 10);
        let base = canonica(&t.p("c")).unwrap();
        let prot = vec![base.join("foo/perfil")];
        let mut r = filtrar_protegidos(entradas(&base), &prot);
        r.sort();
        assert_eq!(r, vec![base.join("bar"), base.join("foo/otro")]);
    }

    #[test]
    fn podar_quita_descendientes_y_duplicados() {
        let r = podar(vec!["/a/b".into(), "/a".into(), "/a".into(), "/c".into()]);
        assert_eq!(r, vec![PathBuf::from("/a"), PathBuf::from("/c")]);
    }

    #[test]
    fn preferencias_por_defecto_y_booleanos() {
        let t = Temp::new();
        let ent = Entorno::de_prueba(t.raiz());
        let p = Preferencias::desde_json(&serde_json::json!({"retenerJournal": "x", "descargasAPapelera": false}), &ent);
        assert_eq!(p.retener_journal, "200M");
        assert!(!p.descargas_a_papelera);
        assert_eq!(p.retener_bytes(), 200 * 1024 * 1024);
    }
}
