//! Utilidades de las pruebas: un directorio temporal que se borra solo.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

static N: AtomicU32 = AtomicU32::new(0);

pub struct Temp(PathBuf);

impl Temp {
    pub fn new() -> Self {
        let d = std::env::temp_dir().join(format!(
            "gigishell-alm-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        Temp(d)
    }
    pub fn raiz(&self) -> &Path {
        &self.0
    }
    pub fn p(&self, rel: &str) -> PathBuf {
        self.0.join(rel)
    }
    pub fn dir(&self, rel: &str) -> PathBuf {
        let p = self.p(rel);
        fs::create_dir_all(&p).unwrap();
        p
    }
    /// Fichero con contenido no comprimible de `bytes` bytes (crea los padres).
    pub fn fichero(&self, rel: &str, bytes: usize) -> PathBuf {
        let p = self.p(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        let mut x: u64 = 0x9E3779B97F4A7C15 ^ bytes as u64;
        let datos: Vec<u8> = (0..bytes)
            .map(|_| {
                x ^= x << 13;
                x ^= x >> 7;
                x ^= x << 17;
                x as u8
            })
            .collect();
        fs::write(&p, datos).unwrap();
        p
    }
}

impl Drop for Temp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
