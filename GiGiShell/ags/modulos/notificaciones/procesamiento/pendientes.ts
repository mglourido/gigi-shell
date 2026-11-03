// Las notificaciones que guardó `notif-respaldo/` con AGS caído, traducidas a `NotifEntrante`.
//
// Puro y con test. El formato lo fija `notif-respaldo/src/pendientes.rs`
// (`{version, notificaciones: [{id, app, icono, titulo, cuerpo, urgencia, hora, expira, hints}]}`):
// si cambia un campo allí, hay que cambiarlo aquí. Todo se valida, porque el fichero está en disco
// y cualquiera puede editarlo: una entrada rota se descarta sin perder las demás.
import type { NotifEntrante } from "./entrante.ts"

/** Rango de ids de las diferidas. AstalNotifd numera desde 1 en cada sesión y no llega aquí, así
 *  que un `get_notification(id)` nunca devuelve otra notificación viva con el mismo número. */
export const ID_DIFERIDA_MIN = 3_000_000_000
export const ID_DIFERIDA_MAX = 4_000_000_000

function texto(v: unknown): string {
  return typeof v === "string" ? v : ""
}

/** Primer id libre del rango diferido a la vista de los que ya están en la lista activa. */
export function primerIdDiferido(idsActivos: Iterable<number>): number {
  let max = ID_DIFERIDA_MIN - 1
  for (const id of idsActivos) if (id >= ID_DIFERIDA_MIN && id < ID_DIFERIDA_MAX && id > max) max = id
  return max + 1 >= ID_DIFERIDA_MAX ? ID_DIFERIDA_MIN : max + 1
}

/** Una entrada del fichero, o `null` si no tiene ni título ni cuerpo ni app (nada que enseñar). */
export function desdePendiente(valor: unknown, id: number, ahora: number): NotifEntrante | null {
  if (!valor || typeof valor !== "object" || Array.isArray(valor)) return null
  const e = valor as Record<string, unknown>
  const app = texto(e.app)
  const summary = texto(e.titulo)
  const body = texto(e.cuerpo)
  if (!app && !summary && !body) return null

  const hints: Record<string, string> = {}
  if (e.hints && typeof e.hints === "object" && !Array.isArray(e.hints)) {
    for (const [k, v] of Object.entries(e.hints as Record<string, unknown>)) {
      if (typeof v === "string") hints[k] = v
    }
  }
  const urgencia = typeof e.urgencia === "number" && [0, 1, 2].includes(e.urgencia) ? e.urgencia : 1
  // Una hora futura (reloj cambiado) o ausente se queda en «ahora»: ordenada en el futuro, la
  // notificación se quedaría clavada arriba del panel.
  const hora = typeof e.hora === "number" && Number.isFinite(e.hora) && e.hora > 0 && e.hora <= ahora
    ? e.hora : ahora
  const imagen = hints["image-path"] || hints["image_path"]

  return {
    id,
    appName: app,
    appIcon: texto(e.icono),
    summary,
    body,
    urgency: urgencia,
    // Sin acciones: el respaldo no las anuncia, y aunque llegaran, el emisor ya no habla con
    // quien le dio el id.
    actions: [],
    expireTimeout: typeof e.expira === "number" && Number.isFinite(e.expira) ? e.expira : undefined,
    image: imagen || undefined,
    timestamp: hora,
    diferida: true,
    hint: (clave) => hints[clave] || undefined,
    hintBool: (clave) => ["true", "1"].includes(hints[clave] ?? ""),
    hintsTexto: () => ({ ...hints }),
  }
}

/** El fichero entero, ya parseado, en orden de llegada y con ids diferidos consecutivos. */
export function leerPendientes(raiz: unknown, primerId: number, ahora: number): NotifEntrante[] {
  if (!raiz || typeof raiz !== "object" || Array.isArray(raiz)) return []
  const lista = (raiz as Record<string, unknown>).notificaciones
  if (!Array.isArray(lista)) return []
  const salida: NotifEntrante[] = []
  let id = primerId
  for (const valor of lista) {
    const entrada = desdePendiente(valor, id, ahora)
    if (!entrada) continue
    salida.push(entrada)
    id = id + 1 >= ID_DIFERIDA_MAX ? ID_DIFERIDA_MIN : id + 1
  }
  // El orden del fichero es el de llegada salvo un `replaces_id`, que sustituye en su sitio:
  // se reordena por hora para que el panel las enseñe como llegaron.
  return salida.sort((a, b) => a.timestamp - b.timestamp)
}
