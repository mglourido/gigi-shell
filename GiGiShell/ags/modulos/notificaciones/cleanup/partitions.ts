// modulos/notificaciones/cleanup/partitions.ts
// Pure predicates for cleanup. `true` = keep the notification.
import type { NotifMeta } from "../rules/types.ts"

export const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000

interface Cleanable { timestamp: number; meta: NotifMeta }

export function keepUnexpired(n: Cleanable, now: number): boolean {
  if (n.meta.lifetime === "timed" && n.meta.expiresAt !== undefined) return n.meta.expiresAt > now
  return true
}

export function keepWithin7Days(n: Cleanable, now: number): boolean {
  return now - n.timestamp < SEVEN_DAYS_MS
}

/** Deep-clean predicate run once per real boot. */
export function keepAfterBoot(n: Cleanable, now: number): boolean {
  if (n.meta.clearOnBoot) return false
  if (!keepUnexpired(n, now)) return false
  if (!keepWithin7Days(n, now)) return false
  return true
}
