//! Reducción de una imagen BGRA de la salida al tamaño de la miniatura.

/// Máximo de muestras por eje dentro del bloque de origen de cada píxel de destino.
/// Promediar el bloque entero costaría leer los 14,7 MB de un monitor 1440p en cada fotograma.
/// Medido a 30 fps en 1440p: 3 muestras cuestan 22,8 % de un núcleo, 2 cuestan 15,0 % con el texto
/// casi igual, y 1 cuesta 10,7 % pero deja dentadas las letras y las líneas finas.
const MUESTRAS_POR_EJE: usize = 2;

/// Bloque de origen `[inicio, fin)` de una posición de destino, recorrido de `paso` en `paso`.
#[derive(Clone, Copy)]
struct Tramo {
    inicio: u32,
    fin: u32,
    paso: u32,
}

/// Píxeles de búfer que se descartan por cada borde: la zona que reservan los paneles.
#[derive(Clone, Copy, Default)]
pub struct Recorte {
    pub izquierda: usize,
    pub arriba: usize,
    pub derecha: usize,
    pub abajo: usize,
}

impl Recorte {
    /// Lee `izquierda,arriba,derecha,abajo`.
    pub fn desde_texto(texto: &str) -> Option<Self> {
        let valores = texto.split(',').map(|v| v.parse().ok()).collect::<Option<Vec<usize>>>()?;
        let [izquierda, arriba, derecha, abajo] = valores[..] else {
            return None;
        };
        Some(Self { izquierda, arriba, derecha, abajo })
    }

    /// Si deja algo de imagen en un búfer de ese tamaño.
    pub fn cabe_en(&self, ancho: usize, alto: usize) -> bool {
        self.izquierda + self.derecha < ancho && self.arriba + self.abajo < alto
    }
}

/// `base` es donde empieza el tramo útil del origen y `origen` lo que mide.
fn tramos(base: usize, origen: usize, destino: usize) -> Vec<Tramo> {
    (0..destino)
        .map(|i| {
            let inicio = (i * origen / destino).min(origen - 1);
            let fin = ((i + 1) * origen / destino).clamp(inicio + 1, origen);
            Tramo {
                inicio: (base + inicio) as u32,
                fin: (base + fin) as u32,
                paso: ((fin - inicio) / MUESTRAS_POR_EJE).max(1) as u32,
            }
        })
        .collect()
}

/// Geometría precalculada de una reducción: se reparte una vez por sesión de captura.
pub struct Reductor {
    stride_origen: usize,
    columnas: Vec<Tramo>,
    filas: Vec<Tramo>,
}

impl Reductor {
    pub fn new(
        ancho_origen: usize,
        alto_origen: usize,
        stride_origen: usize,
        recorte: Recorte,
        ancho_destino: usize,
        alto_destino: usize,
    ) -> Self {
        Self {
            stride_origen,
            columnas: tramos(recorte.izquierda, ancho_origen - recorte.izquierda - recorte.derecha, ancho_destino),
            filas: tramos(recorte.arriba, alto_origen - recorte.arriba - recorte.abajo, alto_destino),
        }
    }

    pub fn bytes_destino(&self) -> usize {
        self.columnas.len() * self.filas.len() * 4
    }

    /// Reduce `origen` sobre `destino` (BGRA ambos). `destino` mide `bytes_destino()`.
    pub fn reducir(&self, origen: &[u8], destino: &mut [u8]) {
        let mut salida = destino.chunks_exact_mut(4);
        for fila in &self.filas {
            for columna in &self.columnas {
                let mut suma = [0u32; 4];
                let mut muestras = 0u32;
                for y in (fila.inicio..fila.fin).step_by(fila.paso as usize) {
                    let base = y as usize * self.stride_origen;
                    for x in (columna.inicio..columna.fin).step_by(columna.paso as usize) {
                        let posicion = base + x as usize * 4;
                        for (acumulado, &canal) in suma.iter_mut().zip(&origen[posicion..posicion + 4]) {
                            *acumulado += canal as u32;
                        }
                        muestras += 1;
                    }
                }
                let pixel = salida.next().expect("destino medido con bytes_destino");
                for (canal, acumulado) in pixel.iter_mut().zip(suma) {
                    *canal = (acumulado / muestras) as u8;
                }
            }
        }
    }
}

#[cfg(test)]
mod pruebas {
    use super::*;

    #[test]
    fn un_color_uniforme_se_conserva() {
        let origen = [10u8, 20, 30, 255].repeat(100 * 50);
        let reductor = Reductor::new(100, 50, 400, Recorte::default(), 7, 3);
        let mut destino = vec![0u8; reductor.bytes_destino()];
        reductor.reducir(&origen, &mut destino);
        assert!(destino.chunks(4).all(|p| p == [10, 20, 30, 255]));
    }

    #[test]
    fn respeta_el_stride_de_origen() {
        // Filas de 8 píxeles con 2 de relleno rojo: el relleno no debe entrar en el resultado.
        let mut origen = Vec::new();
        for _ in 0..4 {
            origen.extend([1u8, 2, 3, 255].repeat(8));
            origen.extend([0u8, 0, 255, 255].repeat(2));
        }
        let reductor = Reductor::new(8, 4, 40, Recorte::default(), 2, 2);
        let mut destino = vec![0u8; reductor.bytes_destino()];
        reductor.reducir(&origen, &mut destino);
        assert!(destino.chunks(4).all(|p| p == [1, 2, 3, 255]));
    }

    #[test]
    fn un_destino_mayor_que_el_origen_no_se_sale() {
        let origen = [9u8, 9, 9, 9].repeat(2 * 2);
        let reductor = Reductor::new(2, 2, 8, Recorte::default(), 5, 5);
        let mut destino = vec![0u8; reductor.bytes_destino()];
        reductor.reducir(&origen, &mut destino);
        assert!(destino.chunks(4).all(|p| p == [9, 9, 9, 9]));
    }

    #[test]
    fn el_recorte_descarta_la_zona_reservada() {
        // Las 2 primeras filas son la franja de la barra: no deben entrar en el resultado.
        let mut origen = [0u8, 0, 255, 255].repeat(4 * 2);
        origen.extend([1u8, 2, 3, 255].repeat(4 * 4));
        let recorte = Recorte { arriba: 2, ..Recorte::default() };
        let reductor = Reductor::new(4, 6, 16, recorte, 2, 2);
        let mut destino = vec![0u8; reductor.bytes_destino()];
        reductor.reducir(&origen, &mut destino);
        assert!(destino.chunks(4).all(|p| p == [1, 2, 3, 255]));
    }

    #[test]
    fn lee_el_recorte_y_rechaza_el_mal_formado() {
        let recorte = Recorte::desde_texto("0,48,0,0").expect("recorte válido");
        assert_eq!(recorte.arriba, 48);
        assert!(Recorte::desde_texto("0,48").is_none());
        assert!(Recorte::desde_texto("a,b,c,d").is_none());
        assert!(!recorte.cabe_en(100, 48));
    }
}
