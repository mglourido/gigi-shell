// modulos/notificaciones/rules/duration.ts
// Pure parsing/formatting of human durations like "2d 4h 5min 30s". No imports.

const UNIT_MS: Record<string, number> = {
  d: 86_400_000,
  h: 3_600_000,
  min: 60_000,
  m: 60_000,
  sec: 1000,
  s: 1000,
}

/**
 * Parse a duration string ("2d 4h 5min", "15min", "3h") into milliseconds.
 * Returns null if no recognizable token is present. Longer unit aliases are matched
 * first ("min" before "m", "sec" before "s") so "5min" is minutes, not 5m + in.
 */
export function parseDuration(input: string): number | null {
  const s = input.trim().toLowerCase()
  if (!s) return null
  const re = /(\d+(?:\.\d+)?)\s*(d|h|min|m|sec|s)/g
  let total = 0
  let matched = false
  for (const m of s.matchAll(re)) {
    matched = true
    total += parseFloat(m[1]) * UNIT_MS[m[2]]
  }
  return matched ? total : null
}

/** Format milliseconds back into a "2d 4h 5min 30s" string (omitting zero parts). */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return ""
  let rem = Math.round(ms / 1000)
  const d = Math.floor(rem / 86_400); rem -= d * 86_400
  const h = Math.floor(rem / 3_600); rem -= h * 3_600
  const min = Math.floor(rem / 60); rem -= min * 60
  const sec = rem
  const parts: string[] = []
  if (d) parts.push(`${d}d`)
  if (h) parts.push(`${h}h`)
  if (min) parts.push(`${min}min`)
  if (sec) parts.push(`${sec}s`)
  return parts.join(" ")
}
