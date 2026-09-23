import { execAsync } from "ags/process"
import Gio from "gi://Gio"
import GLib from "gi://GLib"

const LIMITE_CARATULAS = 5
const DIRECTORIO_CACHE_AGS = `${GLib.get_user_cache_dir()}/ags/media`
const DIRECTORIO_CACHE_ASTAL = `${GLib.get_user_cache_dir()}/astal/mpris`

type ArchivoCache = {
  ruta: string
  modificado: number
}

let limpiezaInicialProgramada = false
let ultimaCaratulaAstal = ""
const descargasPendientes = new Map<string, Promise<string>>()

function nombreCache(url: string): string {
  let hash = 0
  for (let i = 0; i < url.length; i++) {
    hash = (Math.imul(hash, 31) + url.charCodeAt(i)) | 0
  }

  const extension = (url.split("?")[0].match(/\.(jpe?g|png|webp|gif)$/i)?.[1] || "img").toLowerCase()
  return `c${(hash >>> 0).toString(16)}.${extension}`
}

function eliminar(ruta: string) {
  try { Gio.File.new_for_path(ruta).delete(null) } catch (_) {}
}

/** Conserva la carátula activa y las imágenes más recientes hasta el límite. */
function limitarCache(directorio: string, rutaProtegida = "") {
  let enumerador: Gio.FileEnumerator | null = null

  try {
    enumerador = Gio.File.new_for_path(directorio).enumerate_children(
      "standard::name,standard::type,time::modified",
      Gio.FileQueryInfoFlags.NONE,
      null,
    )

    const archivos: ArchivoCache[] = []
    for (let info = enumerador.next_file(null); info !== null; info = enumerador.next_file(null)) {
      if (info.get_file_type() !== Gio.FileType.REGULAR) continue
      archivos.push({
        ruta: `${directorio}/${info.get_name()}`,
        modificado: Number(info.get_modification_date_time()?.to_unix() ?? 0),
      })
    }

    archivos.sort((a, b) => {
      const aProtegido = a.ruta === rutaProtegida ? 1 : 0
      const bProtegido = b.ruta === rutaProtegida ? 1 : 0
      return bProtegido - aProtegido || b.modificado - a.modificado || a.ruta.localeCompare(b.ruta)
    })

    for (const archivo of archivos.slice(LIMITE_CARATULAS)) eliminar(archivo.ruta)
  } catch (_) {
    // La caché puede no existir aún o desaparecer durante el listado.
  } finally {
    try { enumerador?.close(null) } catch (_) {}
  }
}

/** Poda una caché antigua una sola vez y fuera del camino crítico del arranque. */
export function programarLimpiezaCacheCaratulas() {
  if (limpiezaInicialProgramada) return
  limpiezaInicialProgramada = true
  GLib.idle_add(GLib.PRIORITY_LOW, () => {
    limitarCache(DIRECTORIO_CACHE_AGS)
    limitarCache(DIRECTORIO_CACHE_ASTAL, ultimaCaratulaAstal)
    return GLib.SOURCE_REMOVE
  })
}

/** Registra la portada local que Astal acaba de entregar y poda su caché. */
export function registrarCaratulaLocal(origen: string) {
  const ruta = origen.startsWith("file://") ? origen.slice(7) : origen
  if (!ruta.startsWith(`${DIRECTORIO_CACHE_ASTAL}/`) || ruta === ultimaCaratulaAstal) return

  ultimaCaratulaAstal = ruta
  limitarCache(DIRECTORIO_CACHE_ASTAL, ruta)
}

/** Descarga una URL una sola vez y mantiene compartida la caché de carátulas. */
export function resolverCaratulaRemota(url: string): Promise<string> {
  programarLimpiezaCacheCaratulas()
  const ruta = `${DIRECTORIO_CACHE_AGS}/${nombreCache(url)}`

  if (GLib.file_test(ruta, GLib.FileTest.IS_REGULAR)) {
    limitarCache(DIRECTORIO_CACHE_AGS, ruta)
    return Promise.resolve(ruta)
  }

  const pendiente = descargasPendientes.get(url)
  if (pendiente) return pendiente

  try { GLib.mkdir_with_parents(DIRECTORIO_CACHE_AGS, 0o700) } catch (_) {}

  const descarga = execAsync(["curl", "-sfL", "-o", ruta, url])
    .then(() => {
      limitarCache(DIRECTORIO_CACHE_AGS, ruta)
      return ruta
    })
    .catch((error) => {
      eliminar(ruta)
      throw error
    })
    .finally(() => descargasPendientes.delete(url))

  descargasPendientes.set(url, descarga)
  return descarga
}
