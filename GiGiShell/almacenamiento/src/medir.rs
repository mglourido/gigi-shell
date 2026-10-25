//! Medir lo que ocupa una ruta en disco.
//!
//! Sustituye a `du -sxb`, con tres diferencias que importan para que la cifra describa lo que se
//! libera al borrar:
//!
//! - **bloques asignados (`st_blocks`), no tamaño aparente.** Un fichero disperso (el journal de
//!   systemd, imágenes de VM) tiene un tamaño aparente muy superior a lo que ocupa: medido aquí,
//!   `/var/log/journal` daba 111 MB con `du -b` y 48 MB asignados. Prometer los 111 era mentir.
//! - **un inodo con varios enlaces cuenta una vez** dentro de una misma medida.
//! - **no cruza de sistema de ficheros** (igual que `-x`) y **no sigue enlaces simbólicos**.
//!
//! Lo que NO puede saber nadie sin root es lo que ahorra la compresión de btrfs: `st_blocks`
//! informa del tamaño sin comprimir. Por eso el limpiador mide además el espacio libre del sistema
//! de ficheros antes y después (`recuperado`), que es la única cifra que lo incluye.

use std::collections::HashSet;
use std::fs;
use std::os::unix::fs::MetadataExt;
use std::path::Path;
use std::time::Instant;

/// Bytes que ocupa una entrada según sus metadatos.
pub fn asignado(md: &fs::Metadata) -> u64 {
    md.blocks().saturating_mul(512)
}

pub struct Medidor {
    plazo: Option<Instant>,
    vistos: HashSet<(u64, u64)>,
    /// Se pasó del plazo: la medida es parcial y quien la pide debe tratarla como desconocida.
    pub agotado: bool,
}

impl Medidor {
    pub fn new(plazo: Option<Instant>) -> Self {
        Medidor { plazo, vistos: HashSet::new(), agotado: false }
    }

    /// Lo que ocupa `ruta` (y todo lo que cuelga de ella, si es un directorio). 0 si no existe.
    pub fn ruta(&mut self, ruta: &Path) -> u64 {
        match fs::symlink_metadata(ruta) {
            Ok(md) => self.entrada(ruta, &md, md.dev()),
            Err(_) => 0,
        }
    }

    pub fn rutas<'a, I: IntoIterator<Item = &'a Path>>(&mut self, rutas: I) -> u64 {
        rutas.into_iter().map(|r| self.ruta(r)).sum()
    }

    fn entrada(&mut self, ruta: &Path, md: &fs::Metadata, dev: u64) -> u64 {
        if md.dev() != dev {
            return 0;
        }
        if md.nlink() > 1 && !md.is_dir() && !self.vistos.insert((md.dev(), md.ino())) {
            return 0;
        }
        let mut total = asignado(md);
        if !md.is_dir() {
            return total;
        }
        if let Some(p) = self.plazo {
            if Instant::now() > p {
                self.agotado = true;
                return total;
            }
        }
        let Ok(dir) = fs::read_dir(ruta) else { return total };
        for e in dir.flatten() {
            let hijo = e.path();
            if let Ok(m) = fs::symlink_metadata(&hijo) {
                total += self.entrada(&hijo, &m, dev);
            }
        }
        total
    }
}

/// Medida simple sin plazo, para quien no necesita distinguir «parcial».
pub fn tam(ruta: &Path) -> u64 {
    Medidor::new(None).ruta(ruta)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pruebas::Temp;

    #[test]
    fn cuenta_una_vez_los_enlaces_duros() {
        let t = Temp::new();
        let a = t.fichero("a", 64 * 1024);
        fs::hard_link(&a, t.p("b")).unwrap();
        let solo = tam(&a);
        assert!(solo >= 64 * 1024);
        let dir = Medidor::new(None).ruta(t.raiz());
        assert!(dir < solo * 2, "el enlace duro no debe sumarse dos veces");
    }

    #[test]
    fn no_sigue_symlinks() {
        let t = Temp::new();
        let otra = Temp::new();
        otra.fichero("gordo", 1024 * 1024);
        std::os::unix::fs::symlink(otra.raiz(), t.p("enlace")).unwrap();
        assert!(tam(t.raiz()) < 64 * 1024);
    }
}
