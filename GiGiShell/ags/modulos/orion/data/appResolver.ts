// Auto-heals favoritos cuyo binario se movió o se reinstaló con otro nombre
// (rolling releases, un `-bin`/`-git` cambiado por el estable…). Se ejecuta
// al arrancar (`favorites.ts`) y al fallar un lanzamiento.

import type Gio from "gi://Gio"
import GLib from "gi://GLib"
import type { FavoriteApp } from "./favorites"
import { getAppInfos } from "./appsInfo"

// ── Helpers ───────────────────────────────────────────────────────────────────

export function extractBin(exec: string): string {
  // "code --new-window" → "code"   "/usr/bin/code" → "code"
  return exec.trim().split(/\s+/)[0].split("/").pop() ?? exec.trim()
}

// Session-level cache — avoids repeated PATH scans per rebuild
const _exists = new Map<string, boolean>()

export function checkExecExists(exec: string): boolean {
  const bin = extractBin(exec)
  if (_exists.has(bin)) return _exists.get(bin)!
  // flatpak/env/bash wrappers are always "available" — the real binary is inside
  const wrappers = new Set(["flatpak", "env", "bash", "sh", "zsh"])
  const result = wrappers.has(bin) || !!GLib.find_program_in_path(bin)
  _exists.set(bin, result)
  return result
}

export function invalidateCache(exec: string) {
  _exists.delete(extractBin(exec))
}

// ── Alternative finder ────────────────────────────────────────────────────────

const SUFFIXES = ["-bin", "-git", "-appimage", "-nightly", "-stable", "-latest", "-beta", "-dev", "-release"]
const PREFIXES = ["", "app-"]

function tryVariants(bin: string): string | null {
  for (const pre of PREFIXES) {
    for (const suf of SUFFIXES) {
      const candidate = `${pre}${bin}${suf}`
      if (GLib.find_program_in_path(candidate)) return candidate
    }
  }
  // Also try without separators: "code" → "vscode" if one contains the other
  const stripped = bin.replace(/[-_]/g, "")
  for (const pre of PREFIXES) {
    for (const suf of SUFFIXES) {
      const candidate = `${pre}${stripped}${suf}`
      if (candidate !== bin && GLib.find_program_in_path(candidate)) return candidate
    }
  }
  return null
}

function scoreGioApp(app: Gio.AppInfo, origBin: string): number {
  const exec = extractBin(app.get_commandline() ?? "").toLowerCase()
  const name = (app.get_name() ?? "").toLowerCase()
  const orig = origBin.toLowerCase()

  if (exec === orig)              return 100
  if (exec.startsWith(orig))     return  80
  if (orig.startsWith(exec))     return  70
  if (exec.includes(orig))       return  50
  if (orig.includes(exec))       return  45
  if (name.includes(orig))       return  30
  return 0
}

function findInGioApps(origBin: string): string | null {
  let bestExec = ""
  let bestScore = 0

  for (const app of getAppInfos()) {
    const s = scoreGioApp(app, origBin)
    if (s > bestScore) {
      bestScore = s
      bestExec = extractBin(app.get_commandline() ?? "")
    }
  }

  return bestScore >= 30 ? bestExec : null
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface ResolveResult {
  exec: string        // resolved exec (may differ from original)
  changed: boolean    // true if we found a different binary
  available: boolean  // false if nothing was found
}

export function resolveExec(app: FavoriteApp): ResolveResult {
  const orig = app.exec
  const bin  = extractBin(orig)

  // 1. Already OK
  if (GLib.find_program_in_path(bin)) {
    return { exec: orig, changed: false, available: true }
  }

  // 2. Try suffix/prefix variants
  const variant = tryVariants(bin)
  if (variant) {
    // Replace just the binary part in the original exec string
    const newExec = orig.replace(/^\S+/, variant)
    _exists.set(variant, true)
    return { exec: newExec, changed: true, available: true }
  }

  // 3. Scan installed apps for similar match (slower path)
  const gioExec = findInGioApps(bin)
  if (gioExec) {
    const newExec = orig.replace(/^\S+/, gioExec)
    _exists.set(gioExec, true)
    return { exec: newExec, changed: true, available: true }
  }

  return { exec: orig, changed: false, available: false }
}

/**
 * Validates all favorites, updating execs that have moved.
 * Returns the (possibly updated) list and whether anything changed.
 */
export function validateFavorites(apps: FavoriteApp[]): {
  list: FavoriteApp[]
  anyChanged: boolean
} {
  let anyChanged = false
  const list = apps.map(app => {
    const bin = extractBin(app.exec)
    // Fast path: already in cache as available
    if (_exists.get(bin) === true) return app

    const r = resolveExec(app)
    if (!r.available) {
      // Keep the entry but mark in cache as missing
      _exists.set(bin, false)
      return app
    }
    if (r.changed) { anyChanged = true; return { ...app, exec: r.exec } }
    _exists.set(bin, true)
    return app
  })

  return { list, anyChanged }
}
