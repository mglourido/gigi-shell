// Acceso a disco del calendario. Es la única pieza de `persistencia/` que toca GLib; el esquema y
// la migración son puros y se prueban con `node --test`.
//
// Ruta: `~/.config/gigios/calendario.json`, fuera del repositorio. La antigua
// (`~/.config/ags/calendar-events.json`) caía DENTRO, porque `~/.config/ags` es un symlink a
// `~/GiGiShell/ags` — ver `migracion.ts`.

import GLib from "gi://GLib"
import {
  cargarJsonCrudo,
  crearGuardadoJsonProgramado,
  rutaConfig,
  saveJsonAsync,
} from "../../../servicios/almacenamiento/json.ts"
import { archivoVacio, escribirArchivo, leerArchivo } from "./esquema.ts"
import type { ArchivoCalendario } from "./esquema.ts"
import { migrarArchivoAntiguo } from "./migracion.ts"

export const RUTA_CALENDARIO = rutaConfig("calendario.json")
export const RUTA_ANTIGUA = `${GLib.get_home_dir()}/.config/ags/calendar-events.json`

const ETIQUETA = "calendario"
const DEMORA_GUARDADO_MS = 800

/** Id interno de un evento. No es el id remoto de Google. */
export function generarId(): string {
  return `ev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Carga el calendario, migrando desde el formato antiguo la primera vez.
 *
 * Es **síncrona** a propósito, como el resto de almacenes del shell: el fichero es pequeño y el
 * panel necesita los eventos para pintar su primer frame. Lo que se saca del hilo de UI son las
 * escrituras, que ocurren muchas veces por sesión; esta lectura ocurre una.
 */
export function cargarCalendario(): ArchivoCalendario {
  const crudo = cargarJsonCrudo(RUTA_CALENDARIO, ETIQUETA)
  if (crudo !== null) {
    const { archivo, problemas } = leerArchivo(crudo)
    if (problemas.length > 0) {
      console.warn(`[${ETIQUETA}] ${RUTA_CALENDARIO}: ${problemas.join("; ")}`)
    }
    return archivo
  }

  const migrado = migrarDesdeRutaAntigua()
  if (migrado !== null) return migrado
  return archivoVacio()
}

/**
 * Migración de un solo uso.
 *
 * El orden importa y no es negociable: se ESCRIBE el destino y solo después se borra el origen. Al
 * revés, un fallo entre medias perdería los eventos. Y el borrado sí ocurre —no se deja una copia—
 * porque el origen está dentro del árbol versionado del repositorio.
 */
function migrarDesdeRutaAntigua(): ArchivoCalendario | null {
  if (!GLib.file_test(RUTA_ANTIGUA, GLib.FileTest.EXISTS)) return null

  const crudo = cargarJsonCrudo(RUTA_ANTIGUA, `${ETIQUETA} antiguo`)
  if (crudo === null) {
    console.warn(`[${ETIQUETA}] ${RUTA_ANTIGUA} ilegible; no se migra (el fichero se deja intacto)`)
    return null
  }

  const { archivo, migrados, descartados } = migrarArchivoAntiguo(crudo, generarId)

  // Escritura SÍNCRONA, la única del módulo: si el proceso muere entre el `replace_contents_async`
  // y su callback, el borrado de abajo ya se habría llevado el original. Es una vez en la vida.
  try {
    const dir = GLib.path_get_dirname(RUTA_CALENDARIO)
    if (!GLib.file_test(dir, GLib.FileTest.EXISTS)) GLib.mkdir_with_parents(dir, 0o755)
    GLib.file_set_contents(RUTA_CALENDARIO, JSON.stringify(escribirArchivo(archivo), null, 2))
  } catch (e) {
    console.error(`[${ETIQUETA}] no se pudo escribir la migración, se conserva el original:`, e)
    return archivo
  }

  try {
    GLib.unlink(RUTA_ANTIGUA)
  } catch (e) {
    console.warn(`[${ETIQUETA}] migrado, pero no se pudo borrar ${RUTA_ANTIGUA}:`, e)
  }

  console.info(
    `[${ETIQUETA}] migrados ${migrados} evento(s) a ${RUTA_CALENDARIO}` +
      (descartados > 0 ? ` (${descartados} ilegibles descartados)` : ""),
  )
  return archivo
}

/**
 * Guardado con retardo. Se comparte un único programador para todo el módulo: cada llamada
 * reprograma la anterior, así que teclear un título no produce una escritura por letra.
 */
export function crearGuardadoCalendario(obtener: () => ArchivoCalendario): () => void {
  return crearGuardadoJsonProgramado(RUTA_CALENDARIO, ETIQUETA, DEMORA_GUARDADO_MS, () =>
    escribirArchivo(obtener()),
  )
}

/** Escritura inmediata (asíncrona). Para el cierre de sesión o acciones que no admiten demora. */
export function guardarCalendarioYa(archivo: ArchivoCalendario): void {
  saveJsonAsync(RUTA_CALENDARIO, escribirArchivo(archivo), ETIQUETA)
}
