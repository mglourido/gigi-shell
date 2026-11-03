// Adaptador de una notificación en vivo de AstalNotifd a `NotifEntrante`.
import type AstalNotifd from "gi://AstalNotifd"
import type { NotifEntrante } from "./entrante.ts"

/** Unpack a notification's D-Bus hints (a{sv}) into a flat string map for rewrite placeholders.
 *  Only string/number/boolean hint values are kept; complex values (images, byte arrays) skipped. */
function extractHints(n: AstalNotifd.Notification): Record<string, string> {
  const out: Record<string, string> = {}
  try {
    const raw = (n as any).hints?.recursiveUnpack?.()
    if (raw && typeof raw === "object") {
      for (const [k, v] of Object.entries(raw)) {
        if (typeof v === "string") out[k] = v
        else if (typeof v === "number" || typeof v === "boolean") out[k] = String(v)
      }
    }
  } catch (_) {}
  return out
}

/** Lee un hint suelto como cadena. Deliberadamente NO pasa por `extractHints()`: ese hace
 *  `recursiveUnpack()` de todo el a{sv}, y un `image-data` trae los píxeles en crudo —
 *  materializarlos en JS por cada notificación saldría caro. `lookup_value` desenvuelve la 'v'
 *  él solo. Es como se leen `x-gigishell-source` / `x-gigishell-event` (los ponen los scripts de
 *  `hypr/scripts/` vía `lib/notif.sh`) y los hints de sonido. */
function readStringHint(n: AstalNotifd.Notification, key: string): string | undefined {
  try {
    const v = (n as any).hints?.lookup_value?.(key, null)
    if (!v) return undefined
    return (v.get_type_string() === "s" ? v.get_string()[0] : String(v.deep_unpack())) || undefined
  } catch (_) { return undefined }
}

/** `suppress-sound` viaja como booleano en el spec, pero hay emisores que mandan 0/1 o "true". */
function readBoolHint(n: AstalNotifd.Notification, key: string): boolean {
  try {
    const v = (n as any).hints?.lookup_value?.(key, null)
    if (!v) return false
    const raw = v.deep_unpack()
    return raw === true || raw === 1 || raw === "true" || raw === "1"
  } catch (_) { return false }
}

export function desdeAstal(n: AstalNotifd.Notification): NotifEntrante {
  return {
    id: n.id,
    appName: n.app_name || "",
    appIcon: n.app_icon || "",
    summary: n.summary || "",
    body: n.body || "",
    urgency: n.urgency ?? 1,
    actions: (n.actions ?? [])
      .filter((a: any) => typeof a?.id === "string")
      .map((a: any) => ({ id: a.id, label: typeof a.label === "string" ? a.label : a.id })),
    expireTimeout: typeof n.expire_timeout === "number" ? n.expire_timeout : undefined,
    image: n.image_path || undefined,
    timestamp: Date.now(),
    diferida: false,
    hint: (clave) => readStringHint(n, clave),
    hintBool: (clave) => readBoolHint(n, clave),
    hintsTexto: () => extractHints(n),
  }
}
