// modulos/notificaciones/cleanup/cleanupEngine.ts
// Orchestrates cleanup: a one-time deep clean on real boot, and a dynamic sweep of
// expired/old notifications.
//
// Instead of polling every 60s, we keep a single one-shot timer aimed at the next
// moment a notification could become removable (its `timed` expiry, or its 7-day
// boundary). When that fires we sweep and re-arm for the following boundary. With no
// notifications there is no timer at all, so an idle shell has zero cleanup wakeups.
// Any change to the notification list re-arms the timer. In power-save (when the user
// opted to suspend notification filters) the timer is dropped; on resume we run an
// immediate catch-up sweep and re-arm.
import GLib from "gi://GLib"
import { notifications, replaceNotifications } from "../store.ts"
import { isNewBoot } from "./bootDetect.ts"
import { keepAfterBoot, keepUnexpired, keepWithin7Days } from "./partitions.ts"
import { nextWakeAt } from "./schedule.ts"
import { notifProcessingSuspended } from "../../../servicios/energia/powerState.ts"

let started = false
let sweepTimer: number | null = null
let sweeping = false

function stopTimer(): void {
  if (sweepTimer !== null) { GLib.source_remove(sweepTimer); sweepTimer = null }
}

/** Remove everything that has expired or aged out right now. */
function runSweep(): void {
  sweeping = true
  const now = Date.now()
  const all = notifications.get()
  const kept = all.filter(n => keepUnexpired(n, now) && keepWithin7Days(n, now))
  if (kept.length !== all.length) replaceNotifications(kept)
  sweeping = false
  scheduleNext()
}

/** Arm a single one-shot timer at the next removal boundary, or none if unneeded. */
function scheduleNext(): void {
  if (sweeping) return // runSweep re-arms once at the end; ignore its own mutations
  stopTimer()
  if (notifProcessingSuspended.get()) return
  const now = Date.now()
  const wake = nextWakeAt(notifications.get(), now)
  if (wake === null) return
  const delay = Math.max(0, wake - now)
  sweepTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
    sweepTimer = null
    runSweep()
    return GLib.SOURCE_REMOVE
  })
}

/** Call once at startup (e.g. from app.ts main or a store import). Idempotent. */
export function startCleanupEngine(): void {
  if (started) return
  started = true

  // Deep clean once per real boot.
  if (isNewBoot()) {
    const now = Date.now()
    const kept = notifications.get().filter(n => keepAfterBoot(n, now))
    replaceNotifications(kept)
    console.log(`[notif] boot deep-clean: kept ${kept.length}`)
  }

  // Immediate catch-up sweep, then arm the dynamic timer.
  runSweep()

  // Re-arm whenever the list changes (add/remove/replace all flow through this).
  notifications.subscribe(scheduleNext)

  // Suspend/resume with power-save. On resume, catch up immediately and re-arm.
  notifProcessingSuspended.subscribe(() => {
    if (notifProcessingSuspended.get()) stopTimer()
    else runSweep()
  })
}
