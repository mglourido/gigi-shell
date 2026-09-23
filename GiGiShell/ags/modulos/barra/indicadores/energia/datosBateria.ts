/** Lógica pura del indicador de batería. */
export const SEGMENTOS_BATERIA = 5
export const UMBRAL_BATERIA_BAJA = 10
export const UMBRAL_AVISO_BATERIA = 15

export function formatearTiempoBateria(segundos: number): string {
  const horas = Math.floor(segundos / 3600)
  const minutos = Math.floor((segundos % 3600) / 60)
  return horas > 0 ? `${horas}h ${minutos}m` : `${minutos}m`
}

export function claseEstadoBateria(porcentaje: number, cargando: boolean): string {
  if (cargando) return "charging"
  if (porcentaje <= UMBRAL_BATERIA_BAJA) return "low"
  return "normal"
}

export function clasesSegmentosBateria(
  porcentaje: number,
  cargando: boolean,
  cargaCompleta: boolean,
): string[][] {
  const porcentajeSeguro = Math.max(0, Math.min(100, Math.round(porcentaje)))
  const estaCargando = cargando && porcentajeSeguro < 100 && !cargaCompleta
  const baja = !cargando && porcentajeSeguro <= UMBRAL_BATERIA_BAJA
  const aviso = !estaCargando && !baja && porcentajeSeguro <= UMBRAL_AVISO_BATERIA
  const tamanoSegmento = 100 / SEGMENTOS_BATERIA
  const activo = Math.min(SEGMENTOS_BATERIA - 1, Math.floor(porcentajeSeguro / tamanoSegmento))
  const llenos = estaCargando
    ? activo
    : porcentajeSeguro > 0
      ? Math.ceil(porcentajeSeguro / tamanoSegmento)
      : 0
  const descargando = Math.max(0, llenos - 1)
  const inicio = descargando * tamanoSegmento
  const mitad = inicio + tamanoSegmento / 2
  const segmentoAviso = !estaCargando && !baja && porcentajeSeguro < 100 &&
    (porcentajeSeguro <= mitad || aviso)

  return Array.from({ length: SEGMENTOS_BATERIA }, (_, indice) => {
    const clases = ["battery-seg"]
    if (indice < llenos) clases.push("filled")
    if (segmentoAviso && indice === descargando) clases.push("warn")
    if (estaCargando && indice === activo) clases.push("charging-blink")
    if (baja && indice === 0) clases.push("low-blink", "filled")
    return clases
  })
}
