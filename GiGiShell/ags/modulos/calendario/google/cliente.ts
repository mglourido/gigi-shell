// Cliente HTTP de la API de Google Calendar. Todo pasa por `curl` vía `execAsync`, igual que
// `servicios/spotify/SpotifyService.ts`: es asíncrono de verdad (proceso aparte), así que **ninguna
// petición bloquea el hilo de GTK**, y no añade una dependencia de HTTP dentro de GJS.
//
// Los tokens no aparecen nunca en un mensaje de error ni en un log: se pasan como argumento de
// `-H`, y lo que se registra al fallar es el código de estado, no la petición.

import { execAsync } from "ags/process"
import { invalidarToken, obtenerAccessToken } from "./autenticacion.ts"

const BASE = "https://www.googleapis.com/calendar/v3"

export interface RespuestaApi<T> {
  ok: boolean
  estado: number
  datos: T | null
  /** `true` cuando Google invalida el `syncToken` (410) y toca reconstruir la caché. */
  syncTokenCaducado: boolean
}

/** Separa el cuerpo del `%{http_code}` que `curl` añade al final con `-w`. */
function separarEstado(salida: string): { cuerpo: string; estado: number } {
  const corte = salida.lastIndexOf("\n")
  if (corte < 0) return { cuerpo: salida, estado: 0 }
  return { cuerpo: salida.slice(0, corte), estado: Number(salida.slice(corte + 1).trim()) || 0 }
}

async function peticion<T>(
  metodo: string,
  ruta: string,
  parametros: Record<string, string | undefined>,
  cuerpo: unknown | null,
  reintento = false,
): Promise<RespuestaApi<T>> {
  const token = await obtenerAccessToken()
  if (token === null) return { ok: false, estado: 401, datos: null, syncTokenCaducado: false }

  const query = Object.entries(parametros)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v!)}`)
    .join("&")

  const argumentos = [
    "curl", "-s", "--max-time", "30",
    "-w", "\n%{http_code}",
    "-X", metodo,
    "-H", `Authorization: Bearer ${token}`,
    "-H", "Content-Type: application/json",
  ]
  if (cuerpo !== null) argumentos.push("-d", JSON.stringify(cuerpo))
  argumentos.push(`${BASE}${ruta}${query ? `?${query}` : ""}`)

  let salida: string
  try {
    salida = await execAsync(argumentos)
  } catch (e) {
    // Sin red no hay estado HTTP: se devuelve 0, que quien llama distingue de un rechazo del
    // servidor. Un fallo de red nunca debe interpretarse como «el evento ya no existe».
    console.warn("[google-calendar] petición fallida (¿sin conexión?)")
    return { ok: false, estado: 0, datos: null, syncTokenCaducado: false }
  }

  const { cuerpo: texto, estado } = separarEstado(salida)

  // 401: el token cacheado ya no vale. Se descarta y se reintenta UNA vez; el segundo 401 es un
  // problema de credenciales, y reintentar en bucle solo consigue que Google nos limite.
  if (estado === 401 && !reintento) {
    invalidarToken()
    return peticion<T>(metodo, ruta, parametros, cuerpo, true)
  }

  if (estado === 410) {
    return { ok: false, estado, datos: null, syncTokenCaducado: true }
  }

  if (estado < 200 || estado >= 300) {
    console.warn(`[google-calendar] ${metodo} ${ruta} → HTTP ${estado}`)
    return { ok: false, estado, datos: null, syncTokenCaducado: false }
  }

  if (texto.trim() === "") return { ok: true, estado, datos: null, syncTokenCaducado: false }
  try {
    return { ok: true, estado, datos: JSON.parse(texto) as T, syncTokenCaducado: false }
  } catch (e) {
    console.warn(`[google-calendar] respuesta no era JSON en ${ruta}`)
    return { ok: false, estado, datos: null, syncTokenCaducado: false }
  }
}

export interface PaginaEventos {
  items?: unknown[]
  nextPageToken?: string
  nextSyncToken?: string
}

export function listarCalendarios() {
  return peticion<{ items?: unknown[] }>("GET", "/users/me/calendarList", { minAccessRole: "reader" }, null)
}

/**
 * Una página de eventos.
 *
 * Con `syncToken` la petición es **incremental** y Google prohíbe combinarlo con filtros de tiempo,
 * así que `timeMin` solo se manda en la primera sincronización. `showDeleted` es obligatorio en la
 * incremental: es como llegan los borrados (`status: "cancelled"`), y sin él un evento borrado en
 * el móvil se quedaría aquí para siempre.
 */
export function listarEventos(
  calendarioId: string,
  opciones: { syncToken?: string; pageToken?: string; timeMin?: string },
) {
  const incremental = opciones.syncToken !== undefined && opciones.syncToken !== ""
  return peticion<PaginaEventos>("GET", `/calendars/${encodeURIComponent(calendarioId)}/events`, {
    maxResults: "250",
    singleEvents: "true", // las series llegan ya expandidas en instancias: esta versión no edita recurrencias
    showDeleted: "true",
    syncToken: opciones.syncToken,
    pageToken: opciones.pageToken,
    timeMin: incremental ? undefined : opciones.timeMin,
    orderBy: incremental ? undefined : "startTime",
  }, null)
}

export function crearEventoRemoto(calendarioId: string, cuerpo: Record<string, unknown>) {
  return peticion<Record<string, unknown>>(
    "POST",
    `/calendars/${encodeURIComponent(calendarioId)}/events`,
    {},
    cuerpo,
  )
}

export function actualizarEventoRemoto(
  calendarioId: string,
  eventoId: string,
  cuerpo: Record<string, unknown>,
) {
  return peticion<Record<string, unknown>>(
    "PATCH",
    `/calendars/${encodeURIComponent(calendarioId)}/events/${encodeURIComponent(eventoId)}`,
    {},
    cuerpo,
  )
}

export function eliminarEventoRemoto(calendarioId: string, eventoId: string) {
  return peticion<null>(
    "DELETE",
    `/calendars/${encodeURIComponent(calendarioId)}/events/${encodeURIComponent(eventoId)}`,
    {},
    null,
  )
}
