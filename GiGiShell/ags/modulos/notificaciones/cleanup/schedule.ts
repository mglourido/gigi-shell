// modulos/notificaciones/cleanup/schedule.ts
// Pure logic for the dynamic cleanup scheduler: given the current notifications,
// compute the timestamp of the next event that could remove one. The engine turns
// that into a single one-shot timer instead of polling every 60s.
import type { NotifMeta } from "../rules/types.ts"
import { SEVEN_DAYS_MS } from "./partitions.ts"

interface Cleanable { timestamp: number; meta: NotifMeta }

/** Earliest boundary at which this notif becomes eligible for removal. */
function boundary(n: Cleanable): number {
  const sevenDay = n.timestamp + SEVEN_DAYS_MS
  if (n.meta.lifetime === "timed" && n.meta.expiresAt !== undefined) {
    return Math.min(n.meta.expiresAt, sevenDay)
  }
  return sevenDay
}

/**
 * Timestamp (ms epoch) of the next cleanup wake-up, or `null` when the list is
 * empty and no timer is needed. Never earlier than `now`, so an already-expired
 * notif schedules an immediate sweep rather than a negative delay.
 */
export function nextWakeAt(notifs: Cleanable[], now: number): number | null {
  if (notifs.length === 0) return null
  let earliest = Infinity
  for (const n of notifs) {
    const b = boundary(n)
    if (b < earliest) earliest = b
  }
  return Math.max(now, earliest)
}
