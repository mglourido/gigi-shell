// modulos/notificaciones/rules/notifFields.ts
// Single source of truth for the placeholder fields available to text-rewrite templates.
// `NOTIF_FIELDS` is what the rule editor lists; `buildNotifFields` is the runtime value map.
// Keep the two in sync (one entry + one line per new field). Pure — no gi/ags imports.

/** Structural subset of AstalNotifd.Notification that we read. */
export interface RawNotif {
  app_name?: string | null
  summary?: string | null
  body?: string | null
  urgency?: number | null
}

export const NOTIF_FIELDS: { key: string; desc: string }[] = [
  { key: "app",         desc: "nombre de la app" },
  { key: "summary",     desc: "título original" },
  { key: "body",        desc: "cuerpo original" },
  { key: "urgency",     desc: "nivel (0/1/2)" },
  { key: "urgencyName", desc: "baja / normal / urgente" },
  { key: "time",        desc: "hora de llegada (HH:MM)" },
]

export function buildNotifFields(
  n: RawNotif,
  now: number,
  extra: Record<string, string> = {},
): Record<string, string> {
  const u = n.urgency ?? 1
  const d = new Date(now)
  const hh = String(d.getHours()).padStart(2, "0")
  const mm = String(d.getMinutes()).padStart(2, "0")
  // `extra` (notification hints) is spread first so the standard core fields always win a key
  // collision (e.g. a hint named "summary" can't shadow the real summary).
  return {
    ...extra,
    app: n.app_name ?? "",
    summary: n.summary ?? "",
    body: n.body ?? "",
    urgency: String(u),
    urgencyName: u >= 2 ? "urgente" : u <= 0 ? "baja" : "normal",
    time: `${hh}:${mm}`,
  }
}
