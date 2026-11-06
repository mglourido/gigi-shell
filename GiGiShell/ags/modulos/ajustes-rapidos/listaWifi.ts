// Lógica pura de la lista de redes del menú Wi-Fi de Quick Settings (tiene test).

export interface PuntoAccesoLista {
  ssid: string | null
  strength: number
}

/** Una fila por SSID, la conectada primero y el resto por intensidad.
 *
 * Una misma red suele anunciarse con varios puntos de acceso (bandas 2,4/5 GHz,
 * repetidores, malla). Antes, entre dos AP de la red conectada el orden era
 * arbitrario —el comparador devolvía −1 para los dos—, así que la fila podía
 * quedarse con un BSSID débil o lejano y pintar sin barras una red a la que sí
 * se está conectado. Ahora gana el AP ACTIVO y, si no está en la lista, el más
 * fuerte. */
export function puntosAccesoVisibles<T extends PuntoAccesoLista>(
  puntos: T[],
  ssidConectado: string,
  activo: T | null,
  busqueda: string,
): T[] {
  const consulta = busqueda.trim().toLowerCase()
  const vistos = new Set<string>()
  return puntos
    .filter((ap) => ap.ssid && (!consulta || ap.ssid.toLowerCase().includes(consulta)))
    .sort((a, b) => {
      const aConectada = ssidConectado !== "" && a.ssid === ssidConectado
      const bConectada = ssidConectado !== "" && b.ssid === ssidConectado
      if (aConectada !== bConectada) return aConectada ? -1 : 1
      if (a === activo) return -1
      if (b === activo) return 1
      return (b.strength ?? 0) - (a.strength ?? 0)
    })
    .filter((ap) => {
      if (vistos.has(ap.ssid as string)) return false
      vistos.add(ap.ssid as string)
      return true
    })
}
