import { isAd } from "../spotify/parse.ts"

export type EstadoAnuncio = {
  esAnuncio: boolean
  indice: number
}

/** Mantiene la numeración de un bloque de anuncios sin contar dos veces la misma pista. */
export class ContadorAnuncios {
  private indice = 0
  private ultimoId: string | null = null

  actualizar(trackId: string | null | undefined): EstadoAnuncio {
    const id = String(trackId ?? "")
    if (!isAd(id)) {
      this.indice = 0
      this.ultimoId = null
      return { esAnuncio: false, indice: 0 }
    }

    if (id !== this.ultimoId) {
      this.indice += 1
      this.ultimoId = id
    }
    return { esAnuncio: true, indice: this.indice }
  }
}

/** Deriva una carátula para los clientes que solo publican la URL de YouTube. */
export function obtenerMiniaturaYoutube(url: string | null | undefined): string {
  if (!url) return ""
  const coincidencia = url.match(/(?:[?&]v=|youtu\.be\/|\/embed\/|\/shorts\/)([A-Za-z0-9_-]{11})/)
  return coincidencia ? `https://i.ytimg.com/vi/${coincidencia[1]}/hqdefault.jpg` : ""
}

export function esReproductorSpotify(reproductor: { bus_name?: string | null } | null | undefined): boolean {
  return String(reproductor?.bus_name ?? "").toLowerCase().includes("spotify")
}

/**
 * `playerctld` publica SIEMPRE su propio nombre MPRIS y, cuando hay algo sonando, espeja al
 * reproductor activo: `entry`, `identity`, `title` y `trackid` salen idénticos a los del original
 * (medido con Spotify: dos `Player` indistinguibles salvo por el `bus_name`). AstalMpris no lo
 * filtra, así que sin esta regla el mismo reproductor entra dos veces en la lista y la tarjeta de
 * multimedia — que es un carrusel, no una lista — enseña el paginador «1/2» y deja cambiar con la
 * rueda a un clon idéntico. No es un reproductor: es el demonio de playerctl haciendo de proxy.
 */
export function esEspejoPlayerctld(
  reproductor: { bus_name?: string | null } | null | undefined,
): boolean {
  const nombre = String(reproductor?.bus_name ?? "")
  return /^org\.mpris\.MediaPlayer2\.playerctld$/i.test(nombre)
}

/**
 * Spotify se anuncia en MPRIS en cuanto abre, aunque no haya nada seleccionado: sin lista
 * ni pista queda parado (`Stopped`) y con los metadatos vacíos, y el reproductor de la barra
 * enseñaba una tarjeta muerta que además ocupaba un hueco en el carrusel. Otros clientes sí
 * usan `Stopped` como "pausa larga" con la pista aún cargada, así que la regla se aplica solo
 * a Spotify y solo cuando de verdad no hay nada que enseñar.
 */
export function esSpotifyOcioso(reproductor: {
  bus_name?: string | null
  playback_status?: unknown
  title?: string | null
  trackid?: string | null
} | null | undefined): boolean {
  if (!esReproductorSpotify(reproductor)) return false

  // AstalMpris.PlaybackStatus: 0 PLAYING, 1 PAUSED, 2 STOPPED. Se compara por número para
  // no importar GI aquí (este módulo es lógica pura y se cubre con node --test).
  const estado = Number((reproductor as any)?.playback_status ?? 2)
  if (estado === 0 || estado === 1) return false

  const titulo = String(reproductor?.title ?? "").trim()
  const pista = String(reproductor?.trackid ?? "").trim()
  return !titulo && !pista
}
