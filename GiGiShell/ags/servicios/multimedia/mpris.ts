import { createState } from "ags"
import AstalMpris from "gi://AstalMpris"
import {
  programarLimpiezaCacheCaratulas,
  registrarCaratulaLocal,
  resolverCaratulaRemota,
} from "./cacheCaratulas"
import {
  ContadorAnuncios,
  esEspejoPlayerctld,
  esReproductorSpotify,
  esSpotifyOcioso,
  obtenerMiniaturaYoutube,
} from "./estadoPista"

export type EstadoReproductor = {
  reproductor: any
  titulo: string
  artista: string
  reproduciendo: boolean
  trackIdCrudo: string
  esAnuncio: boolean
  esSpotify: boolean
  indiceAnuncio: number
  caratula: string
  origenCaratula: string
}

type RegistroReproductor = {
  estado: EstadoReproductor
  contadorAnuncios: ContadorAnuncios
  idSenal: number | null
}

const mpris = (() => {
  try { return AstalMpris.get_default() } catch (_) { return null }
})()
const registros = new Map<any, RegistroReproductor>()
/**
 * Todos los reproductores vivos, incluidos los que no se enseñan. Se guardan aparte porque
 * hay que seguir escuchando sus señales: un Spotify ocioso vuelve a la lista visible en
 * cuanto se le da a reproducir, y si se hubiera descartado nadie avisaría del cambio.
 */
let reproductoresVivos: any[] = []

export const [reproductoresMultimedia, establecerReproductoresMultimedia] = createState<any[]>([])
export const [revisionMultimedia, establecerRevisionMultimedia] = createState(0)
export const [estadoSpotify, establecerEstadoSpotify] = createState<EstadoReproductor | null>(null)

function leerMetadato(reproductor: any, clave: string): string {
  try { return String(reproductor.get_meta?.(clave)?.deep_unpack?.() ?? "") } catch (_) { return "" }
}

function origenCaratula(reproductor: any): string {
  const publicado = String(reproductor.cover_art || reproductor.art_url || "")
  if (publicado) return publicado
  return obtenerMiniaturaYoutube(leerMetadato(reproductor, "xesam:url"))
}

function mismosReproductores(a: any[], b: any[]): boolean {
  return a.length === b.length && a.every((reproductor, indice) => reproductor === b[indice])
}

function publicar() {
  const visibles = reproductoresVivos.filter((reproductor) => !esSpotifyOcioso(reproductor))
  // Publicar un array nuevo en cada `notify` reconstruiría el carrusel entero, así que solo
  // se sustituye cuando la lista visible cambia de verdad.
  if (!mismosReproductores(visibles, reproductoresMultimedia.get())) {
    establecerReproductoresMultimedia(visibles)
  }
  const spotify = visibles.find(esReproductorSpotify)
  establecerEstadoSpotify(spotify ? registros.get(spotify)?.estado ?? null : null)
  establecerRevisionMultimedia(revisionMultimedia.get() + 1)
}

function resolverCaratula(reproductor: any, registro: RegistroReproductor, origen: string) {
  if (origen === registro.estado.origenCaratula) return

  registro.estado = { ...registro.estado, origenCaratula: origen }
  if (!origen) {
    registro.estado = { ...registro.estado, caratula: "" }
    return
  }

  if (!origen.startsWith("http")) {
    registrarCaratulaLocal(origen)
    registro.estado = { ...registro.estado, caratula: origen }
    return
  }

  resolverCaratulaRemota(origen)
    .then((ruta) => {
      const actual = registros.get(reproductor)
      if (actual !== registro || actual.estado.origenCaratula !== origen) return
      actual.estado = { ...actual.estado, caratula: ruta }
      publicar()
    })
    .catch(() => {
      const actual = registros.get(reproductor)
      if (actual !== registro || actual.estado.origenCaratula !== origen) return
      actual.estado = { ...actual.estado, caratula: "" }
      publicar()
    })
}

function actualizarReproductor(reproductor: any, publicarAlFinal = true) {
  const registro = registros.get(reproductor)
  if (!registro) return

  const trackIdCrudo = String(reproductor.trackid || "")
  const anuncio = registro.contadorAnuncios.actualizar(trackIdCrudo)
  registro.estado = {
    ...registro.estado,
    reproductor,
    titulo: anuncio.esAnuncio ? `Anuncio · ${anuncio.indice}` : reproductor.title || "Sin título",
    artista: anuncio.esAnuncio ? "" : reproductor.artist || "Artista desconocido",
    reproduciendo: reproductor.playback_status === AstalMpris.PlaybackStatus.PLAYING,
    trackIdCrudo,
    esAnuncio: anuncio.esAnuncio,
    esSpotify: esReproductorSpotify(reproductor),
    indiceAnuncio: anuncio.indice,
  }

  const caratula = origenCaratula(reproductor)
  resolverCaratula(reproductor, registro, caratula)
  if (publicarAlFinal) publicar()
}

function crearRegistro(reproductor: any): RegistroReproductor {
  const registro: RegistroReproductor = {
    contadorAnuncios: new ContadorAnuncios(),
    idSenal: null,
    estado: {
      reproductor,
      titulo: "Sin título",
      artista: "Artista desconocido",
      reproduciendo: false,
      trackIdCrudo: "",
      esAnuncio: false,
      esSpotify: esReproductorSpotify(reproductor),
      indiceAnuncio: 0,
      caratula: "",
      origenCaratula: "\0",
    },
  }

  try {
    registro.idSenal = reproductor.connect("notify", (_origen: any, propiedad: any) => {
      const nombre = String(propiedad?.get_name?.() ?? propiedad?.name ?? "").replace(/_/g, "-")
      if (nombre === "position") return
      actualizarReproductor(reproductor)
    })
  } catch (_) {}
  return registro
}

function sincronizarReproductores() {
  // El espejo de playerctld se descarta AQUÍ, no en `publicar()`: así tampoco se le crea registro
  // ni se le conectan señales, que serían un duplicado exacto de las del reproductor real.
  const actuales = [...(mpris?.players ?? [])].filter((r) => !esEspejoPlayerctld(r))
  const conjunto = new Set(actuales)

  for (const [reproductor, registro] of registros) {
    if (conjunto.has(reproductor)) continue
    if (registro.idSenal !== null) {
      try { reproductor.disconnect(registro.idSenal) } catch (_) {}
    }
    registros.delete(reproductor)
  }

  for (const reproductor of actuales) {
    if (!registros.has(reproductor)) registros.set(reproductor, crearRegistro(reproductor))
    actualizarReproductor(reproductor, false)
  }

  reproductoresVivos = actuales
  publicar()
}

/** Devuelve el último estado compartido del reproductor, sin crear sondeos por consumidor. */
export function obtenerEstadoReproductor(reproductor: any): EstadoReproductor | null {
  return registros.get(reproductor)?.estado ?? null
}

programarLimpiezaCacheCaratulas()
if (mpris) {
  try { mpris.connect("player-added", sincronizarReproductores) } catch (_) {}
  try { mpris.connect("player-closed", sincronizarReproductores) } catch (_) {}
}
sincronizarReproductores()
