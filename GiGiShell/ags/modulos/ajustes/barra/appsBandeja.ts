// modulos/ajustes/barra/appsBandeja.ts
//
// Registro + preferencia de visibilidad de las "apps en segundo plano" (los
// iconos StatusNotifierItem de BandejaSistema, ver
// modulos/barra/bandeja/BandejaSistema.tsx).
//
// Dos piezas persistidas en ~/.config/gigios/tray-apps.json:
//   - known:  toda app que ha aparecido alguna vez en el tray {id, title, iconName}.
//             Se alimenta con un watcher único (initTrayApps) suscrito a los items
//             del tray: NO hay polling, sólo reacciona cuando el tray cambia. Sirve
//             para poder ocultar una app aunque ahora mismo esté cerrada.
//   - hidden: ids de las apps que el usuario NO quiere ver en el bar.
//
// La barra (BandejaSistema) filtra sus items contra `hiddenTrayApps`; la sección de
// ajustes (BarraEscritoriosSection) lista `knownTrayApps` con un toggle por app. Ambos estados
// son reactivos, así que ocultar/mostrar se refleja en vivo sin reiniciar.

import GLib from "gi://GLib"
import AstalTray from "gi://AstalTray"
import { createState } from "ags"

const PATH = `${GLib.get_user_config_dir()}/gigios/tray-apps.json`

export type TrayAppInfo = { id: string; title: string; iconName: string }

// ── Estado reactivo ───────────────────────────────────────────────────────────
const [knownTrayApps, _setKnown] = createState<TrayAppInfo[]>([])
const [hiddenTrayApps, _setHidden] = createState<string[]>([])
export { knownTrayApps, hiddenTrayApps }

// Nº de apps (ya filtradas por las ocultas) a partir del cual el bar recoge TODOS
// los iconos en el menú desplegable (la flecha). Con este valor o más, se agrupan.
// Default 5 = comportamiento anterior (se agrupaban con >4). Mínimo 2.
const TRAY_OVERFLOW_MIN = 2
const [trayOverflowAt, _setOverflowAt] = createState<number>(5)
export { trayOverflowAt }

// ── Persistencia ──────────────────────────────────────────────────────────────
function load() {
  try {
    const [ok, content] = GLib.file_get_contents(PATH)
    if (!ok) return
    const saved = JSON.parse(new TextDecoder().decode(content))
    if (Array.isArray(saved.known)) {
      const known: TrayAppInfo[] = []
      for (const a of saved.known) {
        if (a && typeof a.id === "string" && a.id.length > 0) {
          known.push({ id: a.id, title: typeof a.title === "string" ? a.title : a.id, iconName: typeof a.iconName === "string" ? a.iconName : "" })
        }
      }
      _setKnown(known)
    }
    if (Array.isArray(saved.hidden)) {
      _setHidden(saved.hidden.filter((x: unknown): x is string => typeof x === "string"))
    }
    if (typeof saved.overflowAt === "number" && Number.isFinite(saved.overflowAt)) {
      _setOverflowAt(Math.max(TRAY_OVERFLOW_MIN, Math.round(saved.overflowAt)))
    }
  } catch (_) { /* ausente o corrupto → defaults vacíos */ }
}

function save() {
  try {
    const dir = GLib.path_get_dirname(PATH)
    if (!GLib.file_test(dir, GLib.FileTest.EXISTS)) GLib.mkdir_with_parents(dir, 0o755)
    GLib.file_set_contents(PATH, JSON.stringify({ known: knownTrayApps.get(), hidden: hiddenTrayApps.get(), overflowAt: trayOverflowAt.get() }, null, 2))
  } catch (_) { /* un fallo de escritura no debe romper la UI */ }
}

// ── Setters públicos ──────────────────────────────────────────────────────────
export function hideTrayApp(id: string) {
  if (hiddenTrayApps.get().includes(id)) return
  _setHidden([...hiddenTrayApps.get(), id])
  save()
}

export function showTrayApp(id: string) {
  _setHidden(hiddenTrayApps.get().filter((x) => x !== id))
  save()
}

/** Ajusta el umbral de agrupación (nº de apps que activa la flecha). Mín. 2. */
export function setTrayOverflowAt(n: number) {
  const clamped = Math.max(TRAY_OVERFLOW_MIN, Math.round(n))
  if (clamped === trayOverflowAt.get()) return
  _setOverflowAt(clamped)
  save()
}

/** Quita una app del registro (y de la lista de ocultas si estaba). */
export function forgetTrayApp(id: string) {
  _setKnown(knownTrayApps.get().filter((a) => a.id !== id))
  _setHidden(hiddenTrayApps.get().filter((x) => x !== id))
  save()
}

// Añade/actualiza una app en el registro. Actualiza title/iconName si cambiaron
// (una app puede publicar su icono un instante después de aparecer).
function record(item: AstalTray.TrayItem) {
  const id = item.id
  if (!id) return
  const title = item.title || id
  const iconName = item.iconName || ""
  const known = knownTrayApps.get()
  const existing = known.find((a) => a.id === id)
  if (existing) {
    if (existing.title === title && existing.iconName === iconName) return
    _setKnown(known.map((a) => (a.id === id ? { id, title, iconName } : a)))
  } else {
    _setKnown([...known, { id, title, iconName }])
  }
  save()
}

// ── Watcher único (llamado una vez desde app.ts) ──────────────────────────────
// Registra los items presentes al arrancar y los que se añadan después. Sin
// polling: AstalTray emite "item-added" por D-Bus cuando una app aparece.
let started = false
export function initTrayApps() {
  if (started) return
  started = true
  const tray = AstalTray.get_default()
  for (const item of tray.get_items()) record(item)
  tray.connect("item-added", (_t: AstalTray.Tray, id: string) => {
    const item = tray.get_item(id)
    if (item) record(item)
  })
}

load()
