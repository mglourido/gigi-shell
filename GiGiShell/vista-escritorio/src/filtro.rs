//! Reducción de calidad del menú de escritorios: filtro separable repartido entre hilos, y la
//! firma barata con la que se decide si un escritorio ha cambiado.
//!
//! Medidas con capturas reales en `ags/modulos/vista-escritorios/CLAUDE.md`. Lo caro es calcular el
//! filtro, no leer la memoria: copiar la imagen entera son 3,6 ms en 1440p.

use crate::reducir::Recorte;

const BITS: u32 = 14;
const SOPORTE_LANCZOS: f64 = 3.0;
const SOPORTE_CAJA: f64 = 0.5;

fn caja(x: f64) -> f64 {
    if x > -0.5 && x <= 0.5 { 1.0 } else { 0.0 }
}

fn lanczos_nucleo(x: f64) -> f64 {
    let a = x.abs();
    if a >= SOPORTE_LANCZOS {
        return 0.0;
    }
    if a < 1e-9 {
        return 1.0;
    }
    let p = std::f64::consts::PI * a;
    SOPORTE_LANCZOS * p.sin() * (p / SOPORTE_LANCZOS).sin() / (p * p)
}

/// Pesos de un eje en punto fijo. `inicio` ya incluye el recorte de ese eje.
struct Pesos {
    inicio: Vec<usize>,
    tomas: usize,
    valores: Vec<i32>,
}

impl Pesos {
    fn new(destino: usize, origen: usize, base: usize, soporte: f64, nucleo: fn(f64) -> f64) -> Self {
        let razon = origen as f64 / destino as f64;
        let escala = razon.max(1.0);
        let radio = soporte * escala;
        let tomas = (radio.ceil() as usize) * 2 + 1;
        let mut inicio = Vec::with_capacity(destino);
        let mut valores = vec![0i32; destino * tomas];
        for i in 0..destino {
            let centro = (i as f64 + 0.5) * razon;
            let a = (centro - radio + 0.5).floor().max(0.0) as usize;
            let b = ((centro + radio + 0.5).floor() as usize).min(origen);
            let n = (b - a).min(tomas);
            let crudos: Vec<f64> = (0..n).map(|k| nucleo((k as f64 + a as f64 + 0.5 - centro) / escala)).collect();
            let total: f64 = crudos.iter().sum();
            for (k, peso) in crudos.iter().enumerate() {
                valores[i * tomas + k] = (peso / total * (1u32 << BITS) as f64).round() as i32;
            }
            inicio.push(base + a);
        }
        Self { inicio, tomas, valores }
    }

    fn de(&self, i: usize) -> (usize, &[i32]) {
        (self.inicio[i], &self.valores[i * self.tomas..(i + 1) * self.tomas])
    }
}

pub struct Filtro {
    stride: usize,
    /// Primera y siguiente a la última fila de origen útiles.
    filas_origen: (usize, usize),
    ancho: usize,
    alto: usize,
    hilos: usize,
    caja_x: Pesos,
    caja_y: Pesos,
    lanczos_x: Pesos,
    lanczos_y: Pesos,
}

impl Filtro {
    pub fn new(ancho_origen: usize, alto_origen: usize, stride: usize, recorte: Recorte, ancho: usize, alto: usize, hilos: usize) -> Self {
        let util_x = ancho_origen - recorte.izquierda - recorte.derecha;
        let util_y = alto_origen - recorte.arriba - recorte.abajo;
        Self {
            stride,
            filas_origen: (recorte.arriba, alto_origen - recorte.abajo),
            ancho,
            alto,
            hilos: hilos.max(1),
            caja_x: Pesos::new(ancho, util_x, recorte.izquierda, SOPORTE_CAJA, caja),
            caja_y: Pesos::new(alto, util_y, 0, SOPORTE_CAJA, caja),
            lanczos_x: Pesos::new(ancho, util_x, recorte.izquierda, SOPORTE_LANCZOS, lanczos_nucleo),
            lanczos_y: Pesos::new(alto, util_y, 0, SOPORTE_LANCZOS, lanczos_nucleo),
        }
    }

    pub fn bytes_destino(&self) -> usize {
        self.ancho * self.alto * 4
    }

    /// Mientras la imagen cambia.
    pub fn caja(&self, origen: &[u8], destino: &mut [u8], intermedio: &mut Vec<u8>) {
        self.filtrar(&self.caja_x, &self.caja_y, origen, destino, intermedio);
    }

    /// Una sola pasada, al congelarse: el texto quieto es lo que se quiere leer.
    pub fn lanczos(&self, origen: &[u8], destino: &mut [u8], intermedio: &mut Vec<u8>) {
        self.filtrar(&self.lanczos_x, &self.lanczos_y, origen, destino, intermedio);
    }

    fn filtrar(&self, px: &Pesos, py: &Pesos, origen: &[u8], destino: &mut [u8], intermedio: &mut Vec<u8>) {
        let ancho_bytes = self.ancho * 4;
        let (fila_0, fila_fin) = self.filas_origen;
        let filas = fila_fin - fila_0;
        intermedio.resize(ancho_bytes * filas, 0);
        let mitad = 1i32 << (BITS - 1);
        let stride = self.stride;

        // Horizontal: cada hilo reparte filas de origen sobre el búfer intermedio.
        let por_trozo = filas.div_ceil(self.hilos);
        std::thread::scope(|s| {
            for (n, trozo) in intermedio.chunks_mut(por_trozo * ancho_bytes).enumerate() {
                s.spawn(move || {
                    for (j, salida) in trozo.chunks_exact_mut(ancho_bytes).enumerate() {
                        let y = fila_0 + n * por_trozo + j;
                        let fila = &origen[y * stride..(y + 1) * stride];
                        for (i, p) in salida.as_chunks_mut::<4>().0.iter_mut().enumerate() {
                            let (a, pesos) = px.de(i);
                            let mut suma = [mitad; 4];
                            for (peso, q) in pesos.iter().zip(fila[a * 4..].as_chunks::<4>().0) {
                                suma[0] += q[0] as i32 * peso;
                                suma[1] += q[1] as i32 * peso;
                                suma[2] += q[2] as i32 * peso;
                                suma[3] += q[3] as i32 * peso;
                            }
                            for c in 0..4 {
                                p[c] = (suma[c] >> BITS).clamp(0, 255) as u8;
                            }
                        }
                    }
                });
            }
        });

        // Vertical: del intermedio al destino.
        let intermedio: &[u8] = intermedio;
        let por_trozo = self.alto.div_ceil(self.hilos);
        std::thread::scope(|s| {
            for (n, trozo) in destino.chunks_mut(por_trozo * ancho_bytes).enumerate() {
                s.spawn(move || {
                    let mut acumulado = vec![0i32; ancho_bytes];
                    for (j, salida) in trozo.chunks_exact_mut(ancho_bytes).enumerate() {
                        let (a, pesos) = py.de(n * por_trozo + j);
                        acumulado.fill(mitad);
                        for (k, &peso) in pesos.iter().enumerate() {
                            if peso == 0 || a + k >= filas {
                                continue;
                            }
                            let fila = &intermedio[(a + k) * ancho_bytes..(a + k + 1) * ancho_bytes];
                            for (x, &b) in acumulado.iter_mut().zip(fila) {
                                *x += b as i32 * peso;
                            }
                        }
                        for (p, x) in salida.iter_mut().zip(&acumulado) {
                            *p = (*x >> BITS).clamp(0, 255) as u8;
                        }
                    }
                });
            }
        });
    }
}

/// Muestra en diagonal para decidir si algo ha cambiado, sin calcular el filtro de calidad.
pub struct Firma {
    stride: usize,
    columnas: Vec<(u32, u32)>,
    filas: Vec<(u32, u32)>,
}

impl Firma {
    pub fn new(ancho_origen: usize, alto_origen: usize, stride: usize, recorte: Recorte, ancho: usize, alto: usize) -> Self {
        let puntos = |destino: usize, origen: usize, base: usize| -> Vec<(u32, u32)> {
            (0..destino)
                .map(|i| {
                    let en = |f: f64| (base + (((i as f64 + f) * origen as f64 / destino as f64) as usize).min(origen - 1)) as u32;
                    (en(0.25), en(0.75))
                })
                .collect()
        };
        Self {
            stride,
            columnas: puntos(ancho, ancho_origen - recorte.izquierda - recorte.derecha, recorte.izquierda),
            filas: puntos(alto, alto_origen - recorte.arriba - recorte.abajo, recorte.arriba),
        }
    }

    pub fn bytes(&self) -> usize {
        self.columnas.len() * self.filas.len() * 8
    }

    pub fn calcular(&self, origen: &[u8], destino: &mut [u8]) {
        let mut salida = destino.as_chunks_mut::<8>().0.iter_mut();
        for &(ya, yb) in &self.filas {
            let (f1, f2) = (
                &origen[ya as usize * self.stride..(ya as usize + 1) * self.stride],
                &origen[yb as usize * self.stride..(yb as usize + 1) * self.stride],
            );
            for &(xa, xb) in &self.columnas {
                let p = salida.next().expect("destino medido con bytes()");
                p[..4].copy_from_slice(&f1[xa as usize * 4..xa as usize * 4 + 4]);
                p[4..].copy_from_slice(&f2[xb as usize * 4..xb as usize * 4 + 4]);
            }
        }
    }
}

#[cfg(test)]
mod pruebas {
    use super::*;

    fn filtro(ao: usize, ho: usize, recorte: Recorte, w: usize, h: usize, hilos: usize) -> Filtro {
        Filtro::new(ao, ho, ao * 4, recorte, w, h, hilos)
    }

    #[test]
    fn los_pesos_suman_la_unidad() {
        for (destino, origen) in [(7, 100), (760, 2560), (2240, 2560)] {
            for (soporte, nucleo) in [(0.5, caja as fn(f64) -> f64), (3.0, lanczos_nucleo)] {
                let pesos = Pesos::new(destino, origen, 0, soporte, nucleo);
                for i in 0..destino {
                    let suma: i32 = pesos.de(i).1.iter().sum();
                    assert!((suma - (1 << BITS)).abs() <= pesos.tomas as i32, "suma {suma}");
                }
            }
        }
    }

    #[test]
    fn un_color_uniforme_se_conserva() {
        let origen = [10u8, 20, 30, 255].repeat(100 * 50);
        for hilos in [1, 2] {
            let f = filtro(100, 50, Recorte::default(), 7, 3, hilos);
            let mut destino = vec![0u8; f.bytes_destino()];
            let mut intermedio = Vec::new();
            f.caja(&origen, &mut destino, &mut intermedio);
            assert!(destino.chunks(4).all(|p| p == [10, 20, 30, 255]));
            f.lanczos(&origen, &mut destino, &mut intermedio);
            assert!(destino.chunks(4).all(|p| p == [10, 20, 30, 255]));
        }
    }

    #[test]
    fn dos_hilos_dan_lo_mismo_que_uno() {
        let origen: Vec<u8> = (0..200 * 100 * 4).map(|i| (i * 7 % 251) as u8).collect();
        let (uno, dos) = (filtro(200, 100, Recorte::default(), 61, 37, 1), filtro(200, 100, Recorte::default(), 61, 37, 2));
        let (mut a, mut b) = (vec![0u8; uno.bytes_destino()], vec![0u8; dos.bytes_destino()]);
        let mut intermedio = Vec::new();
        uno.lanczos(&origen, &mut a, &mut intermedio);
        dos.lanczos(&origen, &mut b, &mut intermedio);
        assert_eq!(a, b);
    }

    #[test]
    fn el_recorte_descarta_la_zona_reservada() {
        let mut origen = [0u8, 0, 255, 255].repeat(40 * 10);
        origen.extend([1u8, 2, 3, 255].repeat(40 * 30));
        let f = filtro(40, 40, Recorte { arriba: 10, ..Recorte::default() }, 10, 7, 2);
        let mut destino = vec![0u8; f.bytes_destino()];
        let mut intermedio = Vec::new();
        f.caja(&origen, &mut destino, &mut intermedio);
        assert!(destino.chunks(4).all(|p| p == [1, 2, 3, 255]));
    }

    #[test]
    fn la_firma_detecta_un_cambio_pequeno() {
        let mut origen = [0u8, 0, 0, 255].repeat(400 * 200);
        let firma = Firma::new(400, 200, 1600, Recorte::default(), 100, 50);
        let (mut a, mut b) = (vec![0u8; firma.bytes()], vec![0u8; firma.bytes()]);
        firma.calcular(&origen, &mut a);
        // Un bloque de 8×16, el tamaño de una letra.
        for y in 100..116 {
            for x in 200..208 {
                origen[(y * 400 + x) * 4] = 255;
            }
        }
        firma.calcular(&origen, &mut b);
        assert_ne!(a, b);
    }
}
