// modulos/notificaciones/rules/conditions.ts
// Registry of dynamic condition providers (the "flash" resolvers). A provider watches a stored
// notification and calls resolve() when the condition is met; the notification is then removed.
import AstalBattery from "gi://AstalBattery"
import type { StoredNotification } from "../store.ts"

export interface ConditionProvider {
  name: string
  watch(notif: StoredNotification, resolve: () => void): () => void // returns disposer
}

const registry = new Map<string, ConditionProvider>()
export function registerCondition(p: ConditionProvider): void { registry.set(p.name, p) }
export function getCondition(name: string): ConditionProvider | undefined { return registry.get(name) }

// battery-resolved: remove a low-battery notification once battery percentage rises.
registerCondition({
  name: "battery-resolved",
  watch(_notif, resolve) {
    const bat = AstalBattery.get_default()
    const baseline = bat.percentage
    const handler = bat.connect("notify::percentage", () => {
      if (bat.percentage > baseline) resolve()
    })
    return () => bat.disconnect(handler)
  },
})

// superseded: resolved imperatively by ingest when a newer notif with the same dedupKey arrives.
// Registered as a no-op watcher so the name is known; ingest handles the actual removal.
registerCondition({
  name: "superseded",
  watch(_notif, _resolve) { return () => {} },
})

// Hook for future, currently-infeasible conditions (e.g. "update-applied"): register as no-op
// so rules can reference them without error; implement when feasible.
registerCondition({ name: "update-applied", watch() { return () => {} } })
