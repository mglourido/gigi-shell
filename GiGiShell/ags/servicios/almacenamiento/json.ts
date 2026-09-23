// Lectura y escritura de los almacenes JSON del shell (`~/.config/gigios/*.json`).
//
// Nació en `modulos/notificaciones/estado/persistencia.ts`; vive aquí porque no tiene nada de
// específico de las notificaciones y el calendario necesitaba exactamente lo mismo. Aquel módulo
// se conserva como fachada que reenvía a este, para no tocar sus llamantes.
//
// `GLib.file_set_contents` es síncrono y hace fsync: bloquea el bucle principal —y con él el
// dibujado— mientras el dato baja al disco. Los ficheros son pequeños, pero la escritura suele
// ocurrir en el instante más sensible (justo cuando entra una notificación, o mientras se arrastra
// por el calendario), así que se saca del hilo de UI.
//
// Se usa `replace_contents_bytes_async` y NO `replace_contents_async`: esta última no retiene el
// buffer que le pasas, así que el GC de GJS puede liberarlo mientras la escritura sigue en vuelo.
// La variante `_bytes_` toma un `GLib.Bytes` cuyo ciclo de vida sí queda garantizado.
import GLib from "gi://GLib"
import Gio from "gi://Gio"

export function cargarJson<T>(path: string, fallback: T, label: string): T {
  // Que el fichero no exista NO es un fallo: es el primer arranque, o un almacén que el usuario
  // todavía no ha tocado (`notif-sistema.json` no se escribe hasta que se personaliza un aviso).
  // `GLib.file_get_contents` lanza `GLib.FileError` ahí, y sin esta guarda cada uno de esos
  // almacenes escupía un CRITICAL en el log de la sesión pese a estar comportándose bien —
  // ruido que enmascara los fallos de verdad (fichero corrupto o ilegible), que sí se siguen
  // registrando. Misma distinción que hace `cargarJsonCrudo` aquí debajo.
  if (!GLib.file_test(path, GLib.FileTest.EXISTS)) return fallback
  try {
    const [ok, content] = GLib.file_get_contents(path)
    if (!ok) return fallback
    return JSON.parse(new TextDecoder().decode(content)) as T
  } catch (e) {
    console.error(`[${label}] load failed:`, e)
    return fallback
  }
}

/** `null` = el fichero no existe (que no es lo mismo que estar corrupto). */
export function cargarJsonCrudo(path: string, label: string): unknown | null {
  if (!GLib.file_test(path, GLib.FileTest.EXISTS)) return null
  try {
    const [ok, content] = GLib.file_get_contents(path)
    if (!ok) return null
    return JSON.parse(new TextDecoder().decode(content))
  } catch (e) {
    console.error(`[${label}] parse failed:`, e)
    return null
  }
}

export function saveJsonAsync(path: string, data: unknown, label: string, modo?: number): void {
  let text: string
  try {
    text = JSON.stringify(data)
  } catch (e) {
    console.error(`[${label}] serialize failed:`, e)
    return
  }

  try {
    const dir = GLib.path_get_dirname(path)
    if (!GLib.file_test(dir, GLib.FileTest.EXISTS)) GLib.mkdir_with_parents(dir, 0o755)

    const bytes = new GLib.Bytes(new TextEncoder().encode(text))
    const file = Gio.File.new_for_path(path)
    file.replace_contents_bytes_async(
      bytes,
      null,   // etag
      false,  // make_backup
      Gio.FileCreateFlags.REPLACE_DESTINATION, // escribe a temporal + rename: nunca deja el fichero a medias
      null,   // cancellable
      (f, res) => {
        try {
          (f as Gio.File).replace_contents_finish(res)
          // El modo se aplica DESPUÉS de escribir: `REPLACE_DESTINATION` crea un fichero nuevo y le
          // pone los permisos por defecto, así que fijarlos antes no serviría de nada. Es lo que
          // mantiene en 0600 los ficheros con credenciales.
          if (modo !== undefined) GLib.chmod(path, modo)
        } catch (e) {
          console.error(`[${label}] save failed:`, e)
        }
      },
    )
  } catch (e) {
    console.error(`[${label}] save failed:`, e)
  }
}

/**
 * Guardado con retardo: devuelve una función que reprograma la escritura en vez de escribir.
 * Editar un título letra a letra no debe producir una escritura por tecla.
 */
export function crearGuardadoJsonProgramado(
  path: string,
  label: string,
  demoraMs: number,
  obtenerDatos: () => unknown,
  modo?: number,
): () => void {
  let temporizador: number | null = null

  return () => {
    if (temporizador !== null) GLib.source_remove(temporizador)
    temporizador = GLib.timeout_add(GLib.PRIORITY_DEFAULT, demoraMs, () => {
      saveJsonAsync(path, obtenerDatos(), label, modo)
      temporizador = null
      return GLib.SOURCE_REMOVE
    })
  }
}

/** Ruta de un JSON de configuración del shell. */
export function rutaConfig(nombre: string): string {
  return `${GLib.get_home_dir()}/.config/gigios/${nombre}`
}
