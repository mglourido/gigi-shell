import GLib from "gi://GLib"
import Gio from "gi://Gio"
import { createState } from "ags"

interface OpcionesFuenteArchivo<T> {
  ruta: string
  vacio: T
  interpretar: (contenido: string) => T
  etiqueta: string
}

// Los wrappers GObject deben conservar una referencia JS; si el GC recogiera el
// monitor, dejarían de llegar cambios aunque Gio mantuviera internamente el inode.
const monitoresActivos = new Set<Gio.FileMonitor>()

/**
 * Crea una fuente reactiva singleton cuando se invoca una vez a nivel de módulo.
 * Observa el directorio, no el inode del archivo, para sobrevivir a escrituras
 * atómicas que reemplazan el JSON mediante rename(2).
 */
export function crearFuenteArchivoJson<T>(opciones: OpcionesFuenteArchivo<T>) {
  const leer = (): T => {
    try {
      const [ok, bytes] = GLib.file_get_contents(opciones.ruta)
      if (!ok) return opciones.vacio
      return opciones.interpretar(new TextDecoder().decode(bytes))
    } catch (_) {
      return opciones.vacio
    }
  }

  const [valor, establecerValor] = createState(leer())
  const directorio = GLib.path_get_dirname(opciones.ruta)
  const nombre = GLib.path_get_basename(opciones.ruta)

  try {
    if (!GLib.file_test(directorio, GLib.FileTest.IS_DIR)) GLib.mkdir_with_parents(directorio, 0o755)
    const monitor = Gio.file_new_for_path(directorio).monitor_directory(Gio.FileMonitorFlags.NONE, null)
    monitoresActivos.add(monitor)
    monitor.connect("changed", (_monitor, archivo: Gio.File, otroArchivo: Gio.File | null) => {
      const afectaObjetivo = archivo?.get_basename() === nombre || otroArchivo?.get_basename() === nombre
      if (afectaObjetivo) establecerValor(leer())
    })
  } catch (error) {
    console.error(`[${opciones.etiqueta}] monitor:`, error)
  }

  return valor
}
