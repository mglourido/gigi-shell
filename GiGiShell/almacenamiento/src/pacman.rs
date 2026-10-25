//! Inventario de paquetes.
//!
//! Se lee directamente la base de datos local (`/var/lib/pacman/local/*/desc`) en vez de lanzar
//! `expac` o `pacman -Qi`: es lo mismo que leen ellos, sin depender de que expac esté instalado ni
//! del idioma de la salida de pacman (el respaldo bash se rompía en silencio sin `LC_ALL=C`).
//! Lo que no está en la base local —qué paquetes son del AUR, cuáles son huérfanos— se sigue
//! preguntando a pacman: reconstruirlo sería una segunda implementación de sus reglas.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;
use std::process::{Command, Stdio};

const LOCAL: &str = "/var/lib/pacman/local";

#[derive(Debug, Clone, Default)]
pub struct Paquete {
    pub nombre: String,
    pub version: String,
    pub base: String,
    pub arch: String,
    pub descripcion: String,
    pub bytes: u64,
    pub explicito: bool,
    pub fecha: i64,
}

impl Paquete {
    /// Prefijo del fichero `.pkg.tar*` de la versión instalada.
    pub fn fichero(&self) -> String {
        format!("{}-{}-{}.pkg.tar", self.nombre, self.version, self.arch)
    }
}

pub fn instalados() -> Vec<Paquete> {
    instalados_en(Path::new(LOCAL))
}

pub fn instalados_en(dir: &Path) -> Vec<Paquete> {
    let Ok(d) = fs::read_dir(dir) else { return vec![] };
    d.flatten().filter_map(|e| fs::read_to_string(e.path().join("desc")).ok()).map(|t| parsear_desc(&t)).collect()
}

pub fn parsear_desc(texto: &str) -> Paquete {
    let mut p = Paquete { explicito: true, ..Default::default() };
    let mut campo = "";
    for linea in texto.lines() {
        if linea.starts_with('%') && linea.ends_with('%') {
            campo = linea;
            continue;
        }
        if linea.is_empty() {
            continue;
        }
        match campo {
            "%NAME%" => p.nombre = linea.into(),
            "%VERSION%" => p.version = linea.into(),
            "%BASE%" => p.base = linea.into(),
            "%ARCH%" => p.arch = linea.into(),
            "%DESC%" => p.descripcion = linea.into(),
            "%SIZE%" => p.bytes = linea.parse().unwrap_or(0),
            // Sin %REASON% el paquete es explícito; `1` es «instalado como dependencia».
            "%REASON%" => p.explicito = linea != "1",
            "%INSTALLDATE%" => p.fecha = linea.parse().unwrap_or(0),
            _ => {}
        }
        campo = "";
    }
    if p.base.is_empty() {
        p.base = p.nombre.clone();
    }
    p
}

/// Salida de `pacman <args>` como lista de nombres. `pacman -Qtdq` sale con 1 cuando no hay
/// huérfanos: eso es «lista vacía», no un error.
fn lista_pacman(args: &[&str]) -> Option<Vec<String>> {
    let out = Command::new("pacman").args(args).env("LC_ALL", "C").stderr(Stdio::null()).output().ok()?;
    let texto = String::from_utf8_lossy(&out.stdout);
    if !out.status.success() && !texto.trim().is_empty() {
        return None;
    }
    Some(texto.lines().filter(|l| !l.is_empty()).map(String::from).collect())
}

pub fn extranjeros() -> HashSet<String> {
    lista_pacman(&["-Qmq"]).unwrap_or_default().into_iter().collect()
}

pub fn huerfanos() -> Option<Vec<String>> {
    lista_pacman(&["-Qtdq"])
}

pub fn por_nombre(paquetes: &[Paquete]) -> HashMap<&str, &Paquete> {
    paquetes.iter().map(|p| (p.nombre.as_str(), p)).collect()
}

/// `nombre-pkgver-pkgrel-arch.pkg.tar[.ext]` → (nombre, `pkgver-pkgrel`, arch). El `pkgver` puede
/// llevar época (`2:8.0`) y es exactamente lo que guarda `%VERSION%` en la base local.
pub fn partes_fichero(f: &str) -> Option<(&str, &str, &str)> {
    let base = &f[..f.find(".pkg.tar")?];
    let (resto, arch) = base.rsplit_once('-')?;
    let (resto, rel) = resto.rsplit_once('-')?;
    let (nombre, ver) = resto.rsplit_once('-')?;
    if nombre.is_empty() || ver.is_empty() || rel.is_empty() || arch.is_empty() {
        return None;
    }
    Some((nombre, &base[nombre.len() + 1..base.len() - arch.len() - 1], arch))
}

/// Qué sobra en la caché de pacman: todo paquete (y su `.sig`) que NO sea la versión instalada,
/// con la arquitectura con la que se instaló. Mismo criterio que el helper root
/// (`system/limpieza/gigishell-limpieza.sh paccache`): si cambia aquí, cambiarlo allí.
///
/// ── Por qué no `paccache -rk1` ──────────────────────────────────────────────
/// paccache agrupa por NOMBRE + ARQUITECTURA, y CachyOS sirve el mismo paquete unas veces como
/// `x86_64` y otras como `x86_64_v3` según el repo que lo tenga más nuevo. Para paccache,
/// `firefox-155.0.1-1-x86_64` y `firefox-158.0.1-1.1-x86_64_v3` son dos paquetes con una versión
/// cada uno: ninguno sobra y el viejo se queda para siempre. Medido en esta máquina: 52 versiones
/// viejas que paccache daba por buenas («no candidate packages found»). Conservar justo la versión
/// instalada es además lo que pedía `-k1`: poder reinstalarla sin red.
pub fn sobrantes_cache(dir: &Path, paquetes: &[Paquete]) -> Vec<String> {
    let idx = por_nombre(paquetes);
    let Ok(d) = fs::read_dir(dir) else { return vec![] };
    let mut out = vec![];
    for e in d.flatten() {
        let f = e.file_name().to_string_lossy().into_owned();
        let Some((nombre, ver, arch)) = partes_fichero(&f) else { continue };
        let actual = idx.get(nombre).is_some_and(|p| p.version == ver && p.arch == arch);
        if !actual {
            out.push(f);
        }
    }
    out.sort();
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parsea_desc() {
        let t = "%NAME%\nfoo-debug\n\n%VERSION%\n1.2-3\n\n%BASE%\nfoo\n\n%ARCH%\nx86_64\n\n%SIZE%\n1234\n\n%REASON%\n1\n";
        let p = parsear_desc(t);
        assert_eq!(p.nombre, "foo-debug");
        assert_eq!(p.base, "foo");
        assert_eq!(p.bytes, 1234);
        assert!(!p.explicito);
        assert_eq!(p.fichero(), "foo-debug-1.2-3-x86_64.pkg.tar");
    }

    #[test]
    fn partes_de_fichero() {
        assert_eq!(partes_fichero("firefox-158.0.1-1.1-x86_64_v3.pkg.tar.zst"), Some(("firefox", "158.0.1-1.1", "x86_64_v3")));
        assert_eq!(partes_fichero("ffmpeg-2:8.0-1-x86_64.pkg.tar.zst.sig"), Some(("ffmpeg", "2:8.0-1", "x86_64")));
        assert_eq!(partes_fichero("lib32-gcc-libs-15.2.1+r22-1-x86_64.pkg.tar.zst"), Some(("lib32-gcc-libs", "15.2.1+r22-1", "x86_64")));
        assert_eq!(partes_fichero("download-ABC123"), None);
    }

    /// El caso de CachyOS: misma app, dos arquitecturas, solo la instalada sobrevive.
    #[test]
    fn sobra_todo_menos_la_version_instalada() {
        let t = crate::pruebas::Temp::new();
        for f in [
            "firefox-155.0.1-1-x86_64.pkg.tar.zst",
            "firefox-158.0.1-1.1-x86_64_v3.pkg.tar.zst",
            "firefox-158.0.1-1.1-x86_64_v3.pkg.tar.zst.sig",
            "firefox-158.0.1-1.1-x86_64.pkg.tar.zst",
            "borrado-1-1-any.pkg.tar.zst",
        ] {
            t.fichero(f, 10);
        }
        let inst = vec![Paquete { nombre: "firefox".into(), version: "158.0.1-1.1".into(), arch: "x86_64_v3".into(), ..Default::default() }];
        assert_eq!(
            sobrantes_cache(t.raiz(), &inst),
            vec![
                "borrado-1-1-any.pkg.tar.zst".to_string(),
                "firefox-155.0.1-1-x86_64.pkg.tar.zst".to_string(),
                "firefox-158.0.1-1.1-x86_64.pkg.tar.zst".to_string(),
            ]
        );
    }

    #[test]
    fn sin_base_usa_el_nombre() {
        let p = parsear_desc("%NAME%\nbar\n\n%VERSION%\n1-1\n");
        assert_eq!(p.base, "bar");
        assert!(p.explicito);
    }
}
