/** Siempre 3 por fila: el texto de una miniatura solo gana nitidez con más píxeles en pantalla. */
const POR_FILA = 3
/** Filas que deben caber sin scroll. */
const FILAS_VISIBLES = 3
/** La vista grande mide esto por el ancho de una miniatura, sin salirse de la pantalla. */
const VECES_MINIATURA_GRANDE = 2.5
const ANCHO_MAX_VISTA_GRANDE = 0.875
const ALTO_MAX_VISTA_GRANDE = 0.86

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

export function tamanoVistaGrande(
  anchoUtil: number,
  altoUtil: number,
  proporcion: number,
  anchoMiniatura: number,
): { ancho: number; alto: number } {
  const ancho = Math.floor(Math.min(anchoMiniatura * VECES_MINIATURA_GRANDE, anchoUtil * ANCHO_MAX_VISTA_GRANDE, altoUtil * ALTO_MAX_VISTA_GRANDE * proporcion))
  return { ancho, alto: Math.floor(ancho / proporcion) }
}
