// modulos/notificaciones/settings/runMigration.ts
// One-time migration of legacy appSettings.muted → suppress rules. Guarded by a marker file.
import GLib from "gi://GLib"
import { appSettings } from "../store.ts"
import { upsertUserRule } from "../rules/rulesStore.ts"
import { migrateAppSettingsToRules } from "./migration.ts"

const MARKER = `${GLib.get_user_config_dir()}/gigios/notif-migrated.json`

export function runAppSettingsMigration(): void {
  if (GLib.file_test(MARKER, GLib.FileTest.EXISTS)) return
  try {
    const rules = migrateAppSettingsToRules(appSettings.get() as any)
    for (const r of rules) upsertUserRule(r)
    GLib.file_set_contents(MARKER, JSON.stringify({ migrated: true, at: Date.now(), count: rules.length }))
    console.log(`[notif] appSettings migration: created ${rules.length} mute rule(s)`)
  } catch (e) { console.error("[notif] migration failed:", e) }
}
