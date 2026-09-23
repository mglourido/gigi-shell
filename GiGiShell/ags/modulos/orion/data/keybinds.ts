// Envoltorio con IO y estado reactivo de la sección "Atajos" de Orion: lee
// `~/.config/hypr/gigios/keybinds.lua` (+ `gigios/variables.lua`) y delega el
// parseo en `keybinds.parse.ts`, que es puro y está cubierto por node.
// Se re-parsea solo (con `Gio.FileMonitor`) cuando esos ficheros cambian en
// disco, así editarlos no requiere reiniciar AGS.

import { readFile } from "ags/file"
import { createState } from "ags"
import GLib from "gi://GLib"
import Gio from "gi://Gio"
import { parseKeybindsFrom } from "./keybinds.parse"
import type { Keybind, KeybindGroup } from "./keybinds.parse"

export type { Keybind, KeybindGroup }
export { fmtBinding } from "./keybinds.parse"

const HYPR = `${GLib.get_home_dir()}/.config/hypr`
const KEYBINDS_LUA = `${HYPR}/gigios/keybinds.lua`
const VARIABLES_LUA = `${HYPR}/gigios/variables.lua`

function leer(ruta: string): string {
  try {
    return readFile(ruta)
  } catch (_) {
    return ""   // fichero ausente: el parser degrada a lista vacía / sin resolver
  }
}

export function parseKeybinds(): KeybindGroup[] {
  return parseKeybindsFrom(leer(KEYBINDS_LUA), leer(VARIABLES_LUA))
}

// Reactive keybinds: parsed at load, re-parsed whenever keybinds.lua or
// variables.lua change on disk, so the UI reflects edits without restarting AGS.
const [keybinds, setKeybinds] = createState<KeybindGroup[]>(parseKeybinds())
export { keybinds }

/** Current parsed keybinds (used by the search handler, which reads synchronously). */
export function getKeybinds(): KeybindGroup[] {
  return keybinds.get()
}

let _refreshTimer: number | null = null
function scheduleRefresh() {
  // Editors write in bursts; debounce so we parse once the file settles.
  if (_refreshTimer) clearTimeout(_refreshTimer)
  _refreshTimer = setTimeout(() => {
    _refreshTimer = null
    setKeybinds(parseKeybinds())
  }, 200)
}

// Kept alive for the process lifetime so the monitors keep firing.
const _monitors: Gio.FileMonitor[] = []
for (const ruta of [KEYBINDS_LUA, VARIABLES_LUA]) {
  try {
    const monitor = Gio.file_new_for_path(ruta)
      .monitor(Gio.FileMonitorFlags.NONE, null)
    monitor.connect("changed", scheduleRefresh)
    _monitors.push(monitor)
  } catch (e) {
    console.error(`[keybinds] monitor error for ${ruta}:`, e)
  }
}
