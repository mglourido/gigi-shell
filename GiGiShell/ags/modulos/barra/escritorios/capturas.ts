import Gio from "gi://Gio"
import GLib from "gi://GLib"
import { execAsync } from "ags/process"

const idEscritorioValido = (id: number) => Number.isFinite(id) && id > 0 && id < 9000

const nombreSalidaSeguro = (nombreSalida: string) =>
  nombreSalida.replace(/[^a-zA-Z0-9_.-]+/g, "-") || "salida"

const escaparExpresionRegular = (texto: string) =>
  texto.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

export function rutaVistaPreviaEscritorio(nombreSalida: string, idEscritorio: number): string {
  return `/tmp/ags-ws-preview-${nombreSalidaSeguro(nombreSalida)}-${idEscritorio}.jpg`
}

/** Capturador perteneciente a una sola vista y monitor. Reemplaza solicitudes aún
 * pendientes y valida el escritorio activo antes de publicar la imagen. */
export function crearCapturadorEscritorios(
  nombreSalida: string,
  obtenerIdEscritorioActivo: () => number,
  estaActivo: () => boolean,
) {
  const directorioTemporal = Gio.File.new_for_path("/tmp")
  const prefijoSalida = `ags-ws-preview-${nombreSalidaSeguro(nombreSalida)}-`
  const patronArchivo = new RegExp(
    `^${escaparExpresionRegular(prefijoSalida)}([0-9]+)\\.jpg(?:\\.pending-[0-9]+)?$`,
  )
  let temporizador: ReturnType<typeof setTimeout> | null = null
  const idsEnCaptura = new Set<number>()
  const archivosPorEscritorio = new Map<number, Set<string>>()
  let secuenciaCaptura = 0
  let eliminado = false

  const registrarArchivo = (idEscritorio: number, ruta: string) => {
    const archivos = archivosPorEscritorio.get(idEscritorio) ?? new Set<string>()
    archivos.add(ruta)
    archivosPorEscritorio.set(idEscritorio, archivos)
  }

  const olvidarArchivo = (idEscritorio: number, ruta: string) => {
    const archivos = archivosPorEscritorio.get(idEscritorio)
    if (!archivos) return
    archivos.delete(ruta)
    if (archivos.size === 0) archivosPorEscritorio.delete(idEscritorio)
  }

  const eliminarArchivo = (idEscritorio: number, ruta: string) => {
    olvidarArchivo(idEscritorio, ruta)
    try {
      Gio.File.new_for_path(ruta).delete(null)
    } catch (_) {
      // El archivo puede haber desaparecido al terminar grim o una captura anterior.
    }
  }

  /** Recorre el directorio temporal solo en los límites de vida del capturador.
   * El patrón exacto de la salida y NOFOLLOW evitan tocar archivos ajenos. */
  const limpiarArchivosSalida = () => {
    if (!nombreSalida) return
    let enumerador: Gio.FileEnumerator | null = null
    try {
      enumerador = directorioTemporal.enumerate_children(
        "standard::name,standard::type",
        Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
        null,
      )
      let informacion: Gio.FileInfo | null
      while ((informacion = enumerador.next_file(null)) !== null) {
        if (informacion.get_file_type() !== Gio.FileType.REGULAR) continue
        const nombre = informacion.get_name()
        const coincidencia = patronArchivo.exec(nombre)
        if (!coincidencia) continue
        const idEscritorio = Number(coincidencia[1])
        eliminarArchivo(idEscritorio, directorioTemporal.get_child(nombre).get_path()!)
      }
    } catch (_) {
      // La falta puntual del directorio o de permisos no debe romper la barra.
    } finally {
      try { enumerador?.close(null) } catch (_) {}
    }
  }

  const cancelarPendiente = () => {
    if (temporizador !== null) clearTimeout(temporizador)
    temporizador = null
  }

  const solicitar = (idEscritorio: number, retrasoMs = 400) => {
    if (eliminado || !nombreSalida || !estaActivo() || !idEscritorioValido(idEscritorio)) return
    cancelarPendiente()
    temporizador = setTimeout(async () => {
      temporizador = null
      if (eliminado || !estaActivo() || obtenerIdEscritorioActivo() !== idEscritorio) return
      if (idsEnCaptura.has(idEscritorio)) return
      idsEnCaptura.add(idEscritorio)
      const rutaFinal = rutaVistaPreviaEscritorio(nombreSalida, idEscritorio)
      const rutaTemporal = `${rutaFinal}.pending-${++secuenciaCaptura}`
      registrarArchivo(idEscritorio, rutaTemporal)
      try {
        await execAsync([
          "grim", "-o", nombreSalida, "-t", "jpeg", "-q", "75",
          rutaTemporal,
        ])
        // La salida se publica atómicamente solo si aún muestra el ID solicitado.
        if (!eliminado && estaActivo() && obtenerIdEscritorioActivo() === idEscritorio) {
          if (GLib.rename(rutaTemporal, rutaFinal) === 0) {
            olvidarArchivo(idEscritorio, rutaTemporal)
            registrarArchivo(idEscritorio, rutaFinal)
          } else {
            eliminarArchivo(idEscritorio, rutaTemporal)
          }
        } else {
          eliminarArchivo(idEscritorio, rutaTemporal)
        }
      } catch (_) {
        // Una salida puede desaparecer entre la señal y grim sin romper la barra.
      } finally {
        idsEnCaptura.delete(idEscritorio)
        eliminarArchivo(idEscritorio, rutaTemporal)
      }
    }, retrasoMs)
  }

  const conservarEscritorios = (idsExistentes: ReadonlySet<number>) => {
    for (const [idEscritorio, archivos] of [...archivosPorEscritorio]) {
      if (idsExistentes.has(idEscritorio)) continue
      for (const ruta of [...archivos]) eliminarArchivo(idEscritorio, ruta)
    }
  }

  limpiarArchivosSalida()

  return {
    solicitar,
    conservarEscritorios,
    eliminar: () => {
      eliminado = true
      cancelarPendiente()
      limpiarArchivosSalida()
      archivosPorEscritorio.clear()
    },
  }
}
