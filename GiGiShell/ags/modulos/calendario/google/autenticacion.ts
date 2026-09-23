// Credenciales y access token de Google Calendar.
//
// **Aquí no se hace el consentimiento OAuth.** Ese flujo —abrir el navegador, servir el callback de
// loopback, canjear el código con PKCE— lo hace una sola vez `ags/scripts/google-calendar-auth.sh`,
// por el mismo motivo que Spotify: es interactivo, ocurre una vez en la vida de la máquina, y
// montar un servidor HTTP dentro del shell para eso significaría tener un puerto abierto durante
// toda la sesión para algo que se usa una tarde.
//
// Reparto de ficheros, y no es cosmético:
//
// - `~/.config/gigios/google-calendar-creds.json` (**0600**) — client id, client secret y refresh
//   token. Es un **secreto**: vive fuera del repositorio, como `spotify-creds.json`, y no se
//   escribe nunca en un log ni en un mensaje de error.
// - `$XDG_RUNTIME_DIR/ags/google-calendar-token.json` — el access token, que caduca en una hora.
//   Va en el directorio de ejecución, que es tmpfs y se **borra al cerrar sesión**: un token de una
//   hora no tiene por qué sobrevivir en disco a un apagado, y así no hay que caducarlo a mano.

import GLib from "gi://GLib"
import { execAsync } from "ags/process"
import { cargarJsonCrudo, rutaConfig, saveJsonAsync } from "../../../servicios/almacenamiento/json.ts"

export const RUTA_CREDENCIALES = rutaConfig("google-calendar-creds.json")

function rutaToken(): string {
  const runtime = GLib.getenv("XDG_RUNTIME_DIR") ?? `/run/user/${GLib.getenv("UID") ?? "1000"}`
  return `${runtime}/ags/google-calendar-token.json`
}

interface Credenciales {
  clientId: string
  clientSecret: string
  refreshToken: string
}

interface TokenCacheado {
  accessToken: string
  /** Epoch en segundos. */
  expiraEn: number
}

/** Margen antes de dar por caducado el token: evita usarlo justo cuando expira a mitad de petición. */
const MARGEN_S = 120

export function leerCredenciales(): Credenciales | null {
  const crudo = cargarJsonCrudo(RUTA_CREDENCIALES, "google-calendar")
  if (crudo === null || typeof crudo !== "object") return null
  const b = crudo as Record<string, unknown>
  const clientId = typeof b.client_id === "string" ? b.client_id : ""
  const clientSecret = typeof b.client_secret === "string" ? b.client_secret : ""
  const refreshToken = typeof b.refresh_token === "string" ? b.refresh_token : ""
  if (clientId === "" || refreshToken === "") return null
  return { clientId, clientSecret, refreshToken }
}

export function hayCuentaConfigurada(): boolean {
  return leerCredenciales() !== null
}

function leerTokenCacheado(): TokenCacheado | null {
  const crudo = cargarJsonCrudo(rutaToken(), "google-calendar token")
  if (crudo === null || typeof crudo !== "object") return null
  const b = crudo as Record<string, unknown>
  if (typeof b.accessToken !== "string" || typeof b.expiraEn !== "number") return null
  return { accessToken: b.accessToken, expiraEn: b.expiraEn }
}

let enVuelo: Promise<string | null> | null = null

/**
 * Access token válido, refrescándolo si hace falta. `null` = no hay cuenta o el refresco falló.
 *
 * **Los refrescos concurrentes se colapsan en uno.** Abrir el panel dispara la sincronización de
 * varios calendarios a la vez y todos piden token; sin esta guarda saldrían N peticiones al
 * endpoint de token, que además Google acabaría limitando.
 */
export async function obtenerAccessToken(forzar = false): Promise<string | null> {
  if (!forzar) {
    const cacheado = leerTokenCacheado()
    if (cacheado && cacheado.expiraEn - MARGEN_S > Date.now() / 1000) return cacheado.accessToken
  }
  if (enVuelo) return enVuelo

  enVuelo = refrescar().finally(() => {
    enVuelo = null
  })
  return enVuelo
}

async function refrescar(): Promise<string | null> {
  const creds = leerCredenciales()
  if (!creds) return null

  try {
    // El secreto viaja como argumento de `curl`, no dentro de una cadena para el shell: con `sh -c`
    // acabaría en el histórico y en cualquier log de comandos.
    const salida = await execAsync([
      "curl", "-s", "--max-time", "20",
      "-X", "POST", "https://oauth2.googleapis.com/token",
      "-d", `client_id=${creds.clientId}`,
      ...(creds.clientSecret ? ["-d", `client_secret=${creds.clientSecret}`] : []),
      "-d", `refresh_token=${creds.refreshToken}`,
      "-d", "grant_type=refresh_token",
    ])

    const datos = JSON.parse(salida) as Record<string, unknown>
    if (typeof datos.access_token !== "string") {
      // Nunca se vuelca la respuesta entera: puede traer el token o pistas del secreto.
      const error = typeof datos.error === "string" ? datos.error : "respuesta sin access_token"
      console.warn(`[google-calendar] refresco rechazado: ${error}`)
      if (error === "invalid_grant") {
        console.warn(
          "[google-calendar] el refresh token ya no vale. Si el proyecto OAuth sigue en modo " +
            "«Testing», Google los caduca a los 7 días: vuelve a ejecutar scripts/google-calendar-auth.sh",
        )
      }
      return null
    }

    const duracion = typeof datos.expires_in === "number" ? datos.expires_in : 3600
    const token: TokenCacheado = {
      accessToken: datos.access_token,
      expiraEn: Math.floor(Date.now() / 1000) + duracion,
    }
    saveJsonAsync(rutaToken(), token, "google-calendar token", 0o600)
    return token.accessToken
  } catch (e) {
    console.warn("[google-calendar] no se pudo refrescar el token:", e)
    return null
  }
}

/** Olvida el token en curso. Se llama al recibir un 401, antes de reintentar una sola vez. */
export function invalidarToken() {
  try {
    GLib.unlink(rutaToken())
  } catch (_) {}
}
