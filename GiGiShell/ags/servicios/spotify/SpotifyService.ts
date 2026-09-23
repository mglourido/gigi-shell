// servicios/spotify/SpotifyService.ts
// Capa con efectos: habla con la Spotify Web API vía curl. Credenciales de larga
// duración en un JSON plano (config/spotify-creds.json, chmod 600); access token
// efímero en $XDG_RUNTIME_DIR.
import GLib from "gi://GLib"
import { execAsync } from "ags/process"
import { parseTrackId, isAd, tokenExpired } from "./parse"

// Reexport para que QsMedia importe todo desde un único módulo.
export { parseTrackId, isAd } from "./parse"

interface Creds { client_id: string; client_secret: string; refresh_token: string }
interface TokenCache { access_token: string; expires_at: number }

const RUNTIME_DIR = GLib.getenv("XDG_RUNTIME_DIR") || GLib.get_user_runtime_dir()
const TOKEN_CACHE = `${RUNTIME_DIR}/ags/spotify-token.json`
// Credenciales de larga duración en texto plano. Fichero personal (chmod 600),
// fuera de git. Formato: { client_id, client_secret, refresh_token }.
const CREDS_FILE = `${GLib.get_user_config_dir()}/gigios/spotify-creds.json`

let credsCache: Creds | null = null

/** Lee las credenciales del JSON plano en config/spotify-creds.json. */
export async function getCredentials(): Promise<Creds | null> {
  if (credsCache) return credsCache
  try {
    const [ok, contents] = GLib.file_get_contents(CREDS_FILE)
    if (ok) {
      const json = JSON.parse(new TextDecoder().decode(contents))
      if (json?.client_id && json?.client_secret && json?.refresh_token) {
        credsCache = json
        return json
      }
    }
  } catch (e) { /* no configurado */ }
  return null
}

export async function isConfigured(): Promise<boolean> {
  return (await getCredentials()) !== null
}


function readTokenCache(): TokenCache | null {
  try {
    const [ok, contents] = GLib.file_get_contents(TOKEN_CACHE)
    if (ok) return JSON.parse(new TextDecoder().decode(contents))
  } catch (e) { /* sin caché */ }
  return null
}

function writeTokenCache(t: TokenCache) {
  try {
    const dir = GLib.path_get_dirname(TOKEN_CACHE)
    if (!GLib.file_test(dir, GLib.FileTest.EXISTS)) GLib.mkdir_with_parents(dir, 0o700)
    GLib.file_set_contents(TOKEN_CACHE, JSON.stringify(t))
    execAsync(["chmod", "600", TOKEN_CACHE]).catch(() => { })
  } catch (e) { /* best-effort */ }
}

/** Devuelve un access token válido, refrescándolo si hace falta. null ante fallo. */
export async function getAccessToken(): Promise<string | null> {
  const cached = readTokenCache()
  if (cached && !tokenExpired(cached.expires_at)) return cached.access_token

  const creds = await getCredentials()
  if (!creds) return null
  try {
    const out = await execAsync(["curl", "-s", "-X", "POST",
      "https://accounts.spotify.com/api/token",
      "-H", "Content-Type: application/x-www-form-urlencoded",
      "-d", "grant_type=refresh_token",
      "-d", `refresh_token=${creds.refresh_token}`,
      "-d", `client_id=${creds.client_id}`,
      "-d", `client_secret=${creds.client_secret}`,
    ])
    const json = JSON.parse(out)
    if (!json?.access_token) return null
    const cache: TokenCache = {
      access_token: json.access_token,
      expires_at: Math.floor(Date.now() / 1000) + (json.expires_in || 3600),
    }
    writeTokenCache(cache)
    return cache.access_token
  } catch (e) { return null }
}

/**
 * Biblioteca ("Me gusta"). `/me/tracks` y `/me/tracks/contains` están **deprecados** y
 * responden 403 `Forbidden` con un token válido y los scopes concedidos, sin mencionar
 * la deprecación. El reemplazo es `/me/library`, con las pistas como URIs
 * (`spotify:track:<id>`) en `uris`, no como ids.
 */
const LIBRARY = "https://api.spotify.com/v1/me/library"

/** `spotify:track:<id>` percent-encoded. Los ids son base62: solo hay que escapar los `:`. */
function trackUri(trackId: string): string {
  return `spotify%3Atrack%3A${trackId}`
}

/** `denied` (401/403) = ocultar el corazón; `unavailable` (red/parseo) = dejarlo como está. */
export type LikeState = "liked" | "unliked" | "denied" | "unavailable"

/** Consulta si el track está en la biblioteca. Nunca lanza. */
export async function isLiked(trackId: string): Promise<LikeState> {
  const token = await getAccessToken()
  if (!token) return "unavailable"
  try {
    const out = await execAsync(["curl", "-s", "-w", "\n%{http_code}",
      `${LIBRARY}/contains?uris=${trackUri(trackId)}`,
      "-H", `Authorization: Bearer ${token}`,
    ])
    const { body, code } = splitHttpCode(out)
    if (code === 401 || code === 403) return "denied"
    if (code !== 200) return "unavailable"
    const json = JSON.parse(body)
    return Array.isArray(json) && json[0] === true ? "liked" : "unliked"
  } catch (e) { return "unavailable" }
}

/** Guarda (PUT) o quita (DELETE) el track de la biblioteca. true si tuvo éxito. */
export async function setLiked(trackId: string, liked: boolean): Promise<boolean> {
  const token = await getAccessToken()
  if (!token) return false
  try {
    const out = await execAsync(["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}",
      "-X", liked ? "PUT" : "DELETE",
      `${LIBRARY}?uris=${trackUri(trackId)}`,
      "-H", `Authorization: Bearer ${token}`,
      "-H", "Content-Length: 0",
    ])
    const code = parseInt(out.trim(), 10)
    return code >= 200 && code < 300
  } catch (e) { return false }
}

/**
 * Resultado de intentar traer la reproducción a este equipo (Spotify Connect).
 * - `ok`         — ya suena aquí, o se ha transferido.
 * - `denied`     — la API dice que no: cuenta **free** (los comandos de player son
 *                  solo Premium) o el refresh_token no trae los scopes de playback.
 *                  El llamante debe recurrir al plan B por MPRIS.
 * - `unavailable`— sin credenciales / sin red / respuesta inesperada.
 * - `no-device`  — la API responde pero este equipo no sale como dispositivo Connect
 *                  (Spotify de escritorio cerrado, o sin sesión iniciada).
 */
export type TransferResult = "ok" | "denied" | "unavailable" | "no-device"

interface Device { id: string; name: string; type: string; is_active: boolean }

/** Separa el cuerpo del `%{http_code}` que curl añade al final con -w. */
function splitHttpCode(out: string): { body: string; code: number } {
  const at = out.lastIndexOf("\n")
  if (at < 0) return { body: "", code: parseInt(out.trim(), 10) || 0 }
  return { body: out.slice(0, at), code: parseInt(out.slice(at + 1).trim(), 10) || 0 }
}

/**
 * Lleva la reproducción a este ordenador (el caso "estaba sonando en el móvil").
 * Es la vía correcta y la única fiable, pero **exige Premium**: en cuentas free
 * `/me/player/*` responde 403 sin excepción. Por eso devuelve `denied` en vez de un
 * booleano: el widget necesita distinguir "no se puede por la API" (→ plan B) de
 * "ha fallado" (→ avisar).
 */
export async function transferToThisDevice(): Promise<TransferResult> {
  const token = await getAccessToken()
  if (!token) return "unavailable"
  try {
    const list = await execAsync(["curl", "-s", "-w", "\n%{http_code}",
      "https://api.spotify.com/v1/me/player/devices",
      "-H", `Authorization: Bearer ${token}`,
    ])
    const { body, code } = splitHttpCode(list)
    if (code === 401 || code === 403) return "denied"
    if (code !== 200) return "unavailable"

    const devices: Device[] = JSON.parse(body)?.devices ?? []
    // El cliente de escritorio se registra con el hostname; si no, cualquier equipo.
    const host = (GLib.get_host_name() || "").toLowerCase()
    const self = devices.find((d) => String(d.name || "").toLowerCase() === host)
      ?? devices.find((d) => d.type === "Computer")
    if (!self) return "no-device"
    if (self.is_active) return "ok"  // ya está aquí: nada que transferir

    const put = await execAsync(["curl", "-s", "-w", "\n%{http_code}",
      "-X", "PUT", "https://api.spotify.com/v1/me/player",
      "-H", `Authorization: Bearer ${token}`,
      "-H", "Content-Type: application/json",
      "-d", JSON.stringify({ device_ids: [self.id], play: true }),
    ])
    const res = splitHttpCode(put).code
    if (res === 401 || res === 403) return "denied"
    return res >= 200 && res < 300 ? "ok" : "unavailable"
  } catch (e) { return "unavailable" }
}
