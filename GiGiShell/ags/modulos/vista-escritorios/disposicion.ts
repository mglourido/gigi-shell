/** Siempre 3 por fila: el texto de una miniatura solo gana nitidez con más píxeles en pantalla. */
const POR_FILA = 3
/** Filas que deben caber sin scroll. */
const FILAS_VISIBLES = 3
/** La vista grande mide esto por el ancho de una miniatura, y dejando sitio debajo a la primera fila entera. */
const VECES_MINIATURA_GRANDE = 2.5

export function repartirFilas<T>(elementos: readonly T[]): T[][] {
  const filas: T[][] = []
  for (let i = 0; i < elementos.length; i += POR_FILA) filas.push(elementos.slice(i, i + POR_FILA))
  return filas
}

/** La mayor miniatura con la que caben 3 columnas y 3 filas. En píxeles lógicos. */
export function tamanoMiniatura(
  anchoUtil: number,
  altoUtil: number,
  proporcion: number,
  separacion: number,
  margen: number,
): { ancho: number; alto: number } {
  const porAncho = (anchoUtil - margen * 2 - separacion * (POR_FILA - 1)) / POR_FILA
  const porAlto = (altoUtil - margen * 2 - separacion * (FILAS_VISIBLES - 1)) / FILAS_VISIBLES
  const ancho = Math.floor(Math.min(porAncho, porAlto * proporcion))
  return { ancho, alto: Math.floor(ancho / proporcion) }
}

/** La altura se limita para que debajo quepan, sin scroll, el margen de arriba y de abajo, la
 * separación y la primera fila. El ancho nunca llega al de la pantalla: 2,5 miniaturas son menos
 * que sus 3 columnas. */
export function tamanoVistaGrande(
  proporcion: number,
  anchoMiniatura: number,
  altoMiniatura: number,
  altoUtil: number,
  separacion: number,
  margen: number,
): { ancho: number; alto: number } {
  const altoMax = altoUtil - margen * 2 - separacion - altoMiniatura
  const ancho = Math.floor(Math.min(anchoMiniatura * VECES_MINIATURA_GRANDE, altoMax * proporcion))
  return { ancho, alto: Math.floor(ancho / proporcion) }
}

/** Valor del scroll tras saltar `delta` filas desde la más cercana al actual. Limitado a
 * [0, maximo], así la última fila es alcanzable aunque `maximo` no sea múltiplo del paso. */
export function valorFilaSiguiente(valorActual: number, pasoFila: number, delta: number, maximo: number): number {
  const tope = Math.max(0, maximo)
  const nuevo = pasoFila > 0 ? (Math.round(valorActual / pasoFila) + delta) * pasoFila : valorActual
  return Math.min(tope, Math.max(0, nuevo))
}

/** Medidas del rótulo de una miniatura (número + iconos). Deben coincidir con `.ve-rotulo` en
 * `_vista-escritorios.scss`: margen y padding horizontales de la pastilla. */
export const MARGEN_ROTULO = 8
export const PADDING_ROTULO = 10
export const TAMANO_ICONO = 16
export const SEPARACION_ICONOS = 4
/** Dos cifras con holgura: el número se mide aquí, no en pantalla, para que el tope no dependa de
 * un widget aún sin asignar. */
export const ANCHO_NUMERO = 24

/** Cuántos iconos caben en la fila del rótulo sin ensanchar la pastilla más allá de la miniatura.
 * Descuenta el margen a ambos lados, el padding de la pastilla y el número; cada icono ocupa su
 * tamaño más la separación que lo precede. Los sobrantes no se muestran. */
export function maximoIconos(anchoMiniatura: number): number {
  const libre = anchoMiniatura - 2 * MARGEN_ROTULO - 2 * PADDING_ROTULO - ANCHO_NUMERO
  if (!Number.isFinite(libre) || libre <= 0) return 0
  return Math.max(0, Math.floor(libre / (TAMANO_ICONO + SEPARACION_ICONOS)))
}
