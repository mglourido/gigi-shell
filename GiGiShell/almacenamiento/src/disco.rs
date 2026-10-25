//! Montajes, espacio libre e instantáneas.

use std::collections::HashSet;
use std::ffi::CString;
use std::fs;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
pub struct Montaje {
    pub dispositivo: String,
    pub punto: PathBuf,
    pub fs: String,
    pub opciones: String,
}

const IGNORADOS: &[&str] = &[
    "tmpfs", "devtmpfs", "squashfs", "overlay", "efivarfs", "ramfs", "proc", "sysfs", "cgroup2", "cgroup", "devpts",
    "mqueue", "debugfs", "tracefs", "securityfs", "pstore", "bpf", "configfs", "fusectl", "hugetlbfs", "autofs",
    "binfmt_misc", "nsfs", "rpc_pipefs", "fuse.portal", "fuse.gvfsd-fuse", "selinuxfs", "zram",
];

/// `/proc/self/mounts` sin pseudo-sistemas. Los campos van escapados en octal (`\040` = espacio).
pub fn montajes() -> Vec<Montaje> {
    let Ok(t) = fs::read_to_string("/proc/self/mounts") else { return vec![] };
    t.lines()
        .filter_map(|l| {
            let c: Vec<&str> = l.split(' ').collect();
            (c.len() >= 4 && !IGNORADOS.contains(&c[2]) && c[0].starts_with('/')).then(|| Montaje {
                dispositivo: desescapar(c[0]),
                punto: PathBuf::from(desescapar(c[1])),
                fs: c[2].to_string(),
                opciones: c[3].to_string(),
            })
        })
        .collect()
}

fn desescapar(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'\\' && i + 3 < b.len() && b[i + 1..i + 4].iter().all(|c| (b'0'..=b'7').contains(c)) {
            out.push((b[i + 1] - b'0') * 64 + (b[i + 2] - b'0') * 8 + (b[i + 3] - b'0'));
            i += 4;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[derive(Debug, Clone, Copy)]
pub struct Espacio {
    pub total: u64,
    pub libre: u64,
    pub disponible: u64,
}

pub fn espacio(ruta: &Path) -> Option<Espacio> {
    let c = CString::new(ruta.as_os_str().as_bytes()).ok()?;
    let mut s: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(c.as_ptr(), &mut s) } != 0 {
        return None;
    }
    let f = s.f_frsize as u64;
    Some(Espacio {
        total: s.f_blocks as u64 * f,
        libre: s.f_bfree as u64 * f,
        disponible: s.f_bavail as u64 * f,
    })
}

/// Fuerza la escritura del sistema de ficheros que contiene `ruta`. En btrfs el espacio de lo
/// borrado no vuelve a contar como libre hasta que se confirma la transacción (cada 30 s por
/// defecto): medir el libre sin esto daba «0 B recuperados» justo después de borrar 5 GB.
pub fn sincronizar(ruta: &Path) {
    if let Ok(f) = fs::File::open(ruta) {
        use std::os::fd::AsRawFd;
        unsafe { libc::syncfs(f.as_raw_fd()) };
    }
}

/// Espacio disponible sumado por sistema de ficheros real. Es la referencia del `recuperado` de
/// cada limpieza.
///
/// Se deduplica por DISPOSITIVO, no por `f_fsid`: en btrfs cada subvolumen devuelve un `f_fsid`
/// distinto (el kernel mezcla en él el id del subvolumen), así que con `fsid` los siete
/// subvolúmenes de esta máquina contaban el mismo disco siete veces y borrar 6,8 GB daba «48 GB
/// recuperados» (medido; `df` decía 316 → 323 GB). Con el dispositivo de `/proc/self/mounts`
/// todos ellos son `/dev/nvme0n1p2` y cuentan una vez.
pub fn disponible_total() -> u64 {
    let mut vistos = HashSet::new();
    let mut total = 0;
    for m in montajes() {
        if !vistos.insert(m.dispositivo.clone()) {
            continue;
        }
        sincronizar(&m.punto);
        if let Some(e) = espacio(&m.punto) {
            total += e.disponible;
        }
    }
    total
}

/// ¿El sistema de ficheros raíz comprime (btrfs `compress=`/`compress-force=`)? Entonces las
/// cifras lógicas son un techo de lo que se recupera, no la cifra exacta.
pub fn comprime(ruta: &Path) -> bool {
    let ms = montajes();
    ms.iter()
        .filter(|m| ruta.starts_with(&m.punto))
        .max_by_key(|m| m.punto.as_os_str().len())
        .map(|m| m.fs == "btrfs" && m.opciones.split(',').any(|o| o.starts_with("compress")))
        .unwrap_or(false)
}

/// Dispositivos (`st_dev`) de los subvolúmenes que snapper fotografía. En btrfs cada subvolumen
/// tiene su propio `st_dev`, así que «este fichero está en un subvolumen con instantáneas» es
/// comparar un número. Lo borrado ahí NO libera disco mientras alguna instantánea lo contenga, y
/// con snap-pac cada `pacman -Rns` crea una antes de borrar: quitar huérfanos de `/usr` no devuelve
/// ni un byte hasta que esa instantánea caduca.
pub fn subvolumenes_con_instantaneas() -> Vec<u64> {
    let Ok(d) = fs::read_dir("/etc/snapper/configs") else { return vec![] };
    let mut devs = vec![];
    for e in d.flatten() {
        let Ok(t) = fs::read_to_string(e.path()) else { continue };
        for l in t.lines() {
            if let Some(v) = l.strip_prefix("SUBVOLUME=") {
                if let Ok(md) = fs::metadata(v.trim_matches('"')) {
                    devs.push(md.dev());
                }
            }
        }
    }
    devs
}

pub fn en_instantaneas(ruta: &Path, devs: &[u64]) -> bool {
    fs::metadata(ruta).map(|m| devs.contains(&m.dev())).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn desescapa_octal() {
        assert_eq!(desescapar("/mnt/mi\\040disco"), "/mnt/mi disco");
        assert_eq!(desescapar("/sin/nada"), "/sin/nada");
    }
}
