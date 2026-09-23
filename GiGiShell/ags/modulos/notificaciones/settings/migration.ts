// modulos/notificaciones/settings/migration.ts
// Pure: convert legacy per-app mute settings into equivalent suppress rules.
// (Legacy `importance`/`showOnLockscreen` had no functional effect and are dropped.)
import type { NotifRule } from "../rules/types.ts"
import textos from "../../../textos/ajustes/notificaciones.json" with { type: "json" }
import { formatearTexto } from "../../../textos/formatear.ts"

export function migrateAppSettingsToRules(
  appSettings: Record<string, { muted?: boolean }>,
): NotifRule[] {
  const rules: NotifRule[] = []
  for (const [app, s] of Object.entries(appSettings)) {
    if (!s?.muted) continue
    rules.push({
      id: `user.mute.${app}`,
      name: formatearTexto(textos.migracion.nombreSilenciar, { app }),
      enabled: true, priority: 100, source: "user",
      match: { app: { op: "equals", value: app } },
      effects: { suppress: true },
    })
  }
  return rules
}
