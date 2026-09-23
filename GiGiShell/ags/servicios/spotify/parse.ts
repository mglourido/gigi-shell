// servicios/spotify/parse.ts
// Lógica pura de Spotify — sin imports de GTK/ags para poder testear con node --test.

/** true si el trackid corresponde a un anuncio de Spotify. */
export function isAd(trackid: string | null | undefined): boolean {
  if (!trackid) return false
  return trackid.includes(":ad:") || trackid.includes("/ad/")
}

/**
 * Extrae el ID base62 de 22 caracteres de un trackid MPRIS, una URI
 * (`spotify:track:<id>`) o una URL (`https://open.spotify.com/track/<id>`).
 * Devuelve null para anuncios o cadenas sin track.
 */
export function parseTrackId(input: string | null | undefined): string | null {
  if (!input || isAd(input)) return null
  const m = input.match(/track[:/]([0-9A-Za-z]{22})/)
  return m ? m[1] : null
}

/**
 * true si el access token caducó. `expiresAt` en segundos epoch; se aplica un
 * margen de 30 s para no usar un token a punto de expirar.
 */
export function tokenExpired(expiresAt: number, nowMs: number = Date.now()): boolean {
  return nowMs >= expiresAt * 1000 - 30_000
}
