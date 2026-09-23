// modulos/notificaciones/cleanup/bootDetect.ts
// Detect a real machine boot by comparing the kernel boot time (btime from /proc/stat)
// against a marker file. AGS config reloads do NOT change btime, so they don't trigger boot.
import GLib from "gi://GLib"
import { parseBtime } from "./btime.ts"
export { parseBtime }

const MARKER_PATH = `${GLib.get_user_config_dir()}/gigios/notif-cleanup-state.json`

export function readBtime(): number | null {
  try {
    const [ok, content] = GLib.file_get_contents("/proc/stat")
    if (!ok) return null
    return parseBtime(new TextDecoder().decode(content))
  } catch { return null }
}

interface CleanupState { btime: number | null }

function readState(): CleanupState {
  try {
    const [ok, content] = GLib.file_get_contents(MARKER_PATH)
    if (ok) return JSON.parse(new TextDecoder().decode(content))
  } catch {}
  return { btime: null }
}

function writeState(state: CleanupState): void {
  try {
    const dir = GLib.path_get_dirname(MARKER_PATH)
    if (!GLib.file_test(dir, GLib.FileTest.EXISTS)) GLib.mkdir_with_parents(dir, 0o755)
    GLib.file_set_contents(MARKER_PATH, JSON.stringify(state))
  } catch (e) { console.error("[notif] writeState failed:", e) }
}

/**
 * Returns true exactly once per real boot. On a new boot it records the new btime
 * and returns true; on AGS reloads within the same boot it returns false.
 */
export function isNewBoot(): boolean {
  const current = readBtime()
  const state = readState()
  if (current !== null && current !== state.btime) {
    writeState({ ...state, btime: current })
    return true
  }
  return false
}
