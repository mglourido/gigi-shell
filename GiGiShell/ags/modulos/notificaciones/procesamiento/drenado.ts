// Vacía lo que guardó `notif-respaldo/` mientras AGS estaba caído y lo mete por la misma
// `ingest()` que las notificaciones en vivo (reglas, deduplicación, tope, historial).
//
// Lo dispara `daemon/comprobacion.ts` cada vez que ve que `org.freedesktop.Notifications` es
// nuestro: el respaldo solo escribe mientras NO lo es, así que a partir de ahí el fichero ya no
// crece. Va por la suscripción a `NameOwnerChanged` que ya existía, sin temporizadores.
//
// Orden, para no perder nada si AGS vuelve a caer a medias:
//   1. `notif-pendientes.json` → `notif-pendientes.json.procesando.<ms>` (rename atómico; un
//      respaldo posterior escribe un fichero nuevo y no toca este);
//   2. ingerir todos los `.procesando.*` que haya, también los que dejó un AGS caído antes;
//   3. escribir `notifications.json` ya, sin el retardo de 1,5 s;
//   4. solo cuando eso está en disco, borrar los `.procesando.*`.
// Límite aceptado: si AGS cae entre 3 y 4, esas notificaciones se ingieren otra vez. La
// deduplicación de la lista activa sustituye las repetidas; en «Detectadas» suman una aparición.
import GLib from "gi://GLib"
import Gio from "gi://Gio"
import { notifications, guardarAlmacenYa } from "../store.ts"
import { ingest } from "./ingesta.ts"
import { leerPendientes, primerIdDiferido } from "./pendientes.ts"

const DIR = `${GLib.get_user_config_dir()}/gigishell`
const NOMBRE = "notif-pendientes.json"
const PREFIJO_PROCESANDO = `${NOMBRE}.procesando.`

let enCurso = false

function procesandoEnDisco(): string[] {
  const rutas: string[] = []
  try {
    const hijos = Gio.File.new_for_path(DIR).enumerate_children("standard::name", Gio.FileQueryInfoFlags.NONE, null)
    let info: Gio.FileInfo | null
    while ((info = hijos.next_file(null)) !== null) {
      const nombre = info.get_name()
      if (nombre.startsWith(PREFIJO_PROCESANDO)) rutas.push(`${DIR}/${nombre}`)
    }
    hijos.close(null)
  } catch (_) {
    // Sin el directorio no hay nada que vaciar.
  }
  // El sufijo es la hora del rename: en orden, lo más viejo entra primero.
  return rutas.sort()
}

/** Ingiere un fichero. `false` si estaba ilegible: se aparta a `.corrupto` y no se borra. */
function ingerirFichero(ruta: string): boolean {
  let raiz: unknown
  try {
    const [ok, contenido] = GLib.file_get_contents(ruta)
    if (!ok) return false
    raiz = JSON.parse(new TextDecoder().decode(contenido))
  } catch (e) {
    console.error(`[notif pendientes] ${ruta} ilegible; se aparta a .corrupto:`, e)
    try { GLib.rename(ruta, `${ruta}.corrupto`) } catch (_) {}
    return false
  }
  const entradas = leerPendientes(raiz, primerIdDiferido(notifications.get().map(n => n.id)), Date.now())
  for (const entrada of entradas) {
    // Una que falle no se lleva las demás, igual que en el handler en vivo.
    try { ingest(entrada) } catch (e) { console.error("[notif pendientes] no se pudo ingerir una:", e) }
  }
  if (entradas.length) console.log(`[notif pendientes] ${entradas.length} notificaciones de cuando AGS estaba caído`)
  return true
}

export function drenarPendientes(): void {
  if (enCurso) return
  try {
    const nuevo = `${DIR}/${NOMBRE}`
    if (GLib.file_test(nuevo, GLib.FileTest.EXISTS)) {
      if (GLib.rename(nuevo, `${DIR}/${PREFIJO_PROCESANDO}${Date.now()}`) !== 0) {
        console.error(`[notif pendientes] no se pudo apartar ${nuevo}`)
      }
    }
    const rutas = procesandoEnDisco()
    if (rutas.length === 0) return

    enCurso = true
    const ingeridas = rutas.filter(ingerirFichero)
    guardarAlmacenYa((ok) => {
      enCurso = false
      // Si no se pudo guardar, se conservan: el próximo vaciado (o arranque) las reintenta.
      if (!ok) return
      for (const ruta of ingeridas) {
        try { GLib.unlink(ruta) } catch (_) {}
      }
    })
  } catch (e) {
    enCurso = false
    console.error("[notif pendientes] el vaciado falló:", e)
  }
}
