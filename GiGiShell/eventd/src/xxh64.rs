//! XXH64 (semilla 0) en streaming, para no forkear `xxh64sum` por fichero.
//!
//! Tiene que dar EXACTAMENTE lo mismo que `xxh64sum`: `~/.cache/gigishell/download-hashes`
//! guarda hashes escritos por el bash con esa herramienta, y un formato distinto haría
//! que todo lo ya analizado se volviera a pasar por ClamAV. El test lo fija contra los
//! vectores de referencia y contra el propio binario cuando está instalado.

const P1: u64 = 0x9E37_79B1_85EB_CA87;
const P2: u64 = 0xC2B2_AE3D_27D4_EB4F;
const P3: u64 = 0x1656_67B1_9E37_79F9;
const P4: u64 = 0x85EB_CA77_C2B2_AE63;
const P5: u64 = 0x27D4_EB2F_1656_67C5;

fn ronda(acc: u64, entrada: u64) -> u64 {
    acc.wrapping_add(entrada.wrapping_mul(P2)).rotate_left(31).wrapping_mul(P1)
}

fn mezclar(acc: u64, v: u64) -> u64 {
    (acc ^ ronda(0, v)).wrapping_mul(P1).wrapping_add(P4)
}

fn u64le(b: &[u8]) -> u64 {
    u64::from_le_bytes(b[..8].try_into().unwrap())
}

pub struct Xxh64 {
    v: [u64; 4],
    buf: [u8; 32],
    lleno: usize,
    total: u64,
}

impl Default for Xxh64 {
    fn default() -> Self {
        Xxh64 { v: [P1.wrapping_add(P2), P2, 0, 0u64.wrapping_sub(P1)], buf: [0; 32], lleno: 0, total: 0 }
    }
}

impl Xxh64 {
    fn franja(&mut self, b: &[u8]) {
        for i in 0..4 {
            self.v[i] = ronda(self.v[i], u64le(&b[i * 8..]));
        }
    }

    pub fn update(&mut self, mut datos: &[u8]) {
        self.total += datos.len() as u64;
        if self.lleno > 0 {
            let n = (32 - self.lleno).min(datos.len());
            self.buf[self.lleno..self.lleno + n].copy_from_slice(&datos[..n]);
            self.lleno += n;
            datos = &datos[n..];
            if self.lleno < 32 {
                return;
            }
            let b = self.buf;
            self.franja(&b);
            self.lleno = 0;
        }
        while datos.len() >= 32 {
            self.franja(&datos[..32]);
            datos = &datos[32..];
        }
        self.buf[..datos.len()].copy_from_slice(datos);
        self.lleno = datos.len();
    }

    pub fn digest(&self) -> u64 {
        let mut h = if self.total >= 32 {
            let [a, b, c, d] = self.v;
            let mut h = a.rotate_left(1).wrapping_add(b.rotate_left(7)).wrapping_add(c.rotate_left(12)).wrapping_add(d.rotate_left(18));
            for v in self.v {
                h = mezclar(h, v);
            }
            h
        } else {
            P5
        };
        h = h.wrapping_add(self.total);
        let mut resto = &self.buf[..self.lleno];
        while resto.len() >= 8 {
            h = (h ^ ronda(0, u64le(resto))).rotate_left(27).wrapping_mul(P1).wrapping_add(P4);
            resto = &resto[8..];
        }
        if resto.len() >= 4 {
            let k = u32::from_le_bytes(resto[..4].try_into().unwrap()) as u64;
            h = (h ^ k.wrapping_mul(P1)).rotate_left(23).wrapping_mul(P2).wrapping_add(P3);
            resto = &resto[4..];
        }
        for &b in resto {
            h = (h ^ (b as u64).wrapping_mul(P5)).rotate_left(11).wrapping_mul(P1);
        }
        h ^= h >> 33;
        h = h.wrapping_mul(P2);
        h ^= h >> 29;
        h = h.wrapping_mul(P3);
        h ^ (h >> 32)
    }
}

/// Hash de un fichero en el mismo formato que imprime `xxh64sum` (16 hex).
pub fn fichero(ruta: &std::path::Path) -> Option<String> {
    use std::io::Read;
    let mut f = std::fs::File::open(ruta).ok()?;
    let mut h = Xxh64::default();
    let mut buf = vec![0u8; 256 * 1024];
    loop {
        let n = f.read(&mut buf).ok()?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Some(format!("{:016x}", h.digest()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn de(b: &[u8]) -> u64 {
        let mut h = Xxh64::default();
        h.update(b);
        h.digest()
    }

    #[test]
    fn vectores() {
        assert_eq!(de(b""), 0xEF46_DB37_51D8_E999);
        assert_eq!(de(b"a"), 0xD24E_C4F1_A98C_6E5B);
        assert_eq!(de(b"abc"), 0x44BC_2CF5_AD77_0999);
    }

    #[test]
    fn por_trozos_igual_que_de_una_vez() {
        let datos: Vec<u8> = (0..1000u32).map(|i| (i * 7 % 251) as u8).collect();
        let mut h = Xxh64::default();
        for c in datos.chunks(13) {
            h.update(c);
        }
        assert_eq!(h.digest(), de(&datos));
    }

    #[test]
    fn igual_que_xxh64sum() {
        let Ok(o) = std::process::Command::new("xxh64sum").arg("Cargo.toml").output() else { return };
        let esperado = String::from_utf8_lossy(&o.stdout).split_whitespace().next().unwrap_or("").to_string();
        assert_eq!(fichero(std::path::Path::new("Cargo.toml")).unwrap(), esperado);
    }
}
