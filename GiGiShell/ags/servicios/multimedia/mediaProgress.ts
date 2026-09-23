const MPRIS_MICROSECONDS_PER_SECOND = 1_000_000

/**
 * Los directos (radios, streams de Twitch/YouTube en vivo) no tienen duración,
 * pero varios reproductores no publican eso omitiendo `mpris:length`: publican
 * un Int64 gigante (a menudo el máximo del tipo) o el uptime del stream. Sin
 * este techo la etiqueta mostraba números absurdos y la barra de progreso se
 * quedaba pegada al origen. 24 h cubre con holgura cualquier pista, set o
 * audiolibro real y descarta el ruido de los directos.
 */
const MAX_MEDIA_LENGTH_SECONDS = 24 * 60 * 60

function plausibleLengthSeconds(value: unknown): number | null {
  try {
    const number = Number(value)
    if (!Number.isFinite(number)) return null
    return number > 0 && number <= MAX_MEDIA_LENGTH_SECONDS ? number : null
  } catch (_) {
    return null
  }
}

/**
 * Astal exposes Player.length in seconds, while the raw MPRIS mpris:length
 * metadata (and playerctl's value for it) is expressed in microseconds.
 *
 * Devuelve `null` también cuando la fuente anuncia una duración imposible
 * (ver MAX_MEDIA_LENGTH_SECONDS): quien llama trata ese `null` como "sin
 * duración conocida" y deja la etiqueta vacía, que es lo correcto en un directo.
 */
export function resolveMediaLengthSeconds(
  astalSeconds: unknown,
  mprisMicroseconds: unknown,
): number | null {
  const length = plausibleLengthSeconds(astalSeconds)
  if (length !== null) return length

  const rawLength = Number(mprisMicroseconds)
  if (!Number.isFinite(rawLength)) return null
  return plausibleLengthSeconds(rawLength / MPRIS_MICROSECONDS_PER_SECOND)
}

/**
 * ¿La fuente ha publicado una duración, pero imposible? Eso es la firma de un
 * directo, y no es lo mismo que no publicar ninguna: aquí no hay nada que
 * recuperar, así que quien llama debe ahorrarse los rodeos que sí valen la pena
 * con un `mpris:length` ausente (el Pause+Play de Firefox, las consultas a
 * playerctl). En un directo ese Pause+Play es además un corte de audio real.
 */
export function isLiveStreamLength(
  astalSeconds: unknown,
  mprisMicroseconds: unknown,
): boolean {
  const astal = Number(astalSeconds)
  if (Number.isFinite(astal) && astal > MAX_MEDIA_LENGTH_SECONDS) return true

  const raw = Number(mprisMicroseconds)
  return Number.isFinite(raw) && raw / MPRIS_MICROSECONDS_PER_SECOND > MAX_MEDIA_LENGTH_SECONDS
}

export function safeMediaPosition(position: unknown, length: number): number {
  const value = Number(position)
  if (!Number.isFinite(value) || value < 0) return 0
  return Math.min(value, length)
}
