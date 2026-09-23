// Apps fijadas en la sección Inicio de Orion. Persisten en
// ~/.local/share/orion/favorites.json (fuera del repo, dato del usuario) y se
// validan/auto-sanan al arrancar contra `appResolver.ts`.

import { createState } from "ags"
import GLib from "gi://GLib"
import { validateFavorites, resolveExec, invalidateCache } from "./appResolver"

const DISK_PATH = `${GLib.get_home_dir()}/.local/share/orion/favorites.json`

export interface FavoriteApp {
  id: string
  name: string
  exec: string
  iconName: string
}

const DEFAULT_FAVORITES: FavoriteApp[] = []

function ensureDir() {
  GLib.mkdir_with_parents(`${GLib.get_home_dir()}/.local/share/orion`, 0o755)
}

export function loadFromDisk(): FavoriteApp[] {
  try {
    const bytes = GLib.file_get_contents(DISK_PATH)
    if (bytes[0]) {
      const text = new TextDecoder().decode(bytes[1] as Uint8Array)
      const parsed = JSON.parse(text)
      if (Array.isArray(parsed) && parsed.length > 0) return parsed as FavoriteApp[]
    }
  } catch (_) {}
  return [...DEFAULT_FAVORITES]
}

export function saveFavorites(list: FavoriteApp[]) {
  try {
    ensureDir()
    GLib.file_set_contents(DISK_PATH, JSON.stringify(list, null, 2))
  } catch (_) {}
}

// ── Reactive state ────────────────────────────────────────────────────────────

const initial = loadFromDisk()
export const [favorites, setFavorites] = createState<FavoriteApp[]>(initial)

// Validate and auto-heal exec paths at startup
;(function validateAtStartup() {
  const { list, anyChanged } = validateFavorites(initial)
  if (anyChanged) {
    setFavorites(list)
    saveFavorites(list)
  }
})()

// ── Mutations ─────────────────────────────────────────────────────────────────

export function addFavorite(app: FavoriteApp) {
  const cur = favorites.get()
  if (cur.some(f => f.id === app.id)) return
  const updated = [...cur, app]
  setFavorites(updated)
  saveFavorites(updated)
}

export function removeFavorite(id: string) {
  const updated = favorites.get().filter(f => f.id !== id)
  setFavorites(updated)
  saveFavorites(updated)
}

export function isFavorite(id: string): boolean {
  return favorites.get().some(f => f.id === id)
}

/**
 * Called when launching an app fails. Tries to find the new exec location,
 * updates state + disk if found, and returns the new exec to retry (or null).
 */
export function healAndGetExec(app: FavoriteApp): string | null {
  invalidateCache(app.exec)
  const r = resolveExec(app)
  if (!r.available) return null

  if (r.changed) {
    const cur = favorites.get()
    const updated = cur.map(f => f.id === app.id ? { ...f, exec: r.exec } : f)
    setFavorites(updated)
    saveFavorites(updated)
  }

  return r.exec
}
