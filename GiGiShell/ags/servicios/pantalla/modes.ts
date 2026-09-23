// Lógica pura de gestión de pantallas — SIN imports GTK/GLib para que corra bajo
// `node --test`. La cola reactiva (poller, UI, persistencia) vive en QuickSettings.tsx.

export interface RefreshRate {
  hz: number        // redondeado, para la etiqueta ("144")
  raw: string       // string original de availableModes ("144.00")
  modeString: string // "1920x1200@144.00Hz" — se conserva para reconstruir el modo exacto
}

export interface Resolution {
  w: number
  h: number
  key: string        // "1920x1200"
  label: string      // "1920×1200" (× = U+00D7)
  refreshRates: RefreshRate[]
}

export interface ParsedModes {
  resolutions: Resolution[]
}

export function parseAvailableModes(modes: string[]): ParsedModes {
  const byRes = new Map<string, Resolution>()
  for (const mode of modes) {
    const m = mode.match(/^(\d+)x(\d+)@([\d.]+)Hz$/)
    if (!m) continue
    const w = Number(m[1])
    const h = Number(m[2])
    const raw = m[3]
    const key = `${w}x${h}`
    let res = byRes.get(key)
    if (!res) {
      res = { w, h, key, label: `${w}×${h}`, refreshRates: [] }
      byRes.set(key, res)
    }
    const hz = Math.round(parseFloat(raw))
    if (!res.refreshRates.some(r => r.hz === hz)) {
      res.refreshRates.push({ hz, raw, modeString: mode })
    }
  }
  const resolutions = Array.from(byRes.values())
  resolutions.sort((a, b) => b.w * b.h - a.w * a.h)
  resolutions.forEach(r => r.refreshRates.sort((a, b) => b.hz - a.hz))
  return { resolutions }
}

export const SCALE_PRESETS = [1.0, 1.25, 1.33, 1.5, 1.75, 2.0]

export const TRANSFORMS: { value: number; label: string }[] = [
  { value: 0, label: "Normal" },
  { value: 1, label: "90°" },
  { value: 2, label: "180°" },
  { value: 3, label: "270°" },
  { value: 4, label: "Volteado" },
  { value: 5, label: "Volteado 90°" },
  { value: 6, label: "Volteado 180°" },
  { value: 7, label: "Volteado 270°" },
]

export const CM_MODES: { value: string; label: string }[] = [
  { value: "auto", label: "Automático" },
  { value: "srgb", label: "sRGB" },
  { value: "wide", label: "Wide gamut" },
  { value: "hdr", label: "HDR" },
]

interface Dims { width: number; height: number; scale: number }
interface RefBox extends Dims { x: number; y: number }

// Coloca `self` adyacente a `ref` en coordenadas lógicas (Hyprland posiciona en
// px lógicos = físicos / escala). Devuelve "XxY".
export function computeRelativePosition(ref: RefBox, self: Dims, side: "left" | "right" | "up" | "down"): string {
  const refLW = Math.round(ref.width / ref.scale)
  const refLH = Math.round(ref.height / ref.scale)
  const selfLW = Math.round(self.width / self.scale)
  const selfLH = Math.round(self.height / self.scale)
  switch (side) {
    case "right": return `${ref.x + refLW}x${ref.y}`
    case "left":  return `${ref.x - selfLW}x${ref.y}`
    case "down":  return `${ref.x}x${ref.y + refLH}`
    case "up":    return `${ref.x}x${ref.y - selfLH}`
  }
}

// Preferencia persistida por monitor (clave = description). Todos los campos son
// opcionales: al reconstruir una regla los ausentes caen a "preferred/auto".
export interface MonitorPref {
  mode?: string       // modeString completo "1920x1200@144.00Hz"
  scale?: number
  vrr?: boolean
  enabled?: boolean   // false => regla "disable"
  mirrorOf?: string   // "none" o nombre de otro monitor
  transform?: number  // 0–7 (Hyprland: normal/90/180/270 + volteados)
  bitdepth?: number   // 8 | 10
  cm?: string         // "auto" | "srgb" | "wide" | "hdr" | "hdredid"
  sdrBrightness?: number
  sdrSaturation?: number
  position?: string   // "XxY" | "auto"
}

export interface RuleInput {
  name: string
  position: string    // "0x0" o "auto"
  pref: MonitorPref
}

// availableModes trae "…@144.00Hz"; el campo `mode` de hl.monitor (igual que el
// de la regla legacy) quiere "…@144.00" — verificado en 0.56 con la instancia
// anidada: hl.monitor acepta el mismo formato sin el sufijo Hz.
export function modeToHyprctl(modeString: string): string {
  return modeString.replace(/Hz$/, "")
}

// Literal de cadena Lua entre comillas dobles. La description de un monitor
// viene del EDID y se interpola en un chunk: sin escapar, una comilla suelta
// rompería el fichero generado entero (y con él la config al recargar).
export function luaString(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
}

// Equivalente Lua de buildMonitorRule: una tabla HL.MonitorSpec para el
// `hl.monitor({...})` del aplicado en vivo (`hyprctl eval`). Al arrancar y al
// recargar, esa misma spec la arma el config leyendo display.json
// (hypr/gigios/pantalla.lua) — los dos lados deben coincidir. Los campos
// ausentes se omiten para que manden los defaults del compositor.
export function buildMonitorSpecLua(r: RuleInput): string {
  const { name, position, pref } = r
  if (pref.enabled === false) return `{ output = ${luaString(name)}, disabled = true }`
  const mode = pref.mode ? modeToHyprctl(pref.mode) : "preferred"
  const scale = pref.scale != null ? String(pref.scale) : "auto"
  const campos = [
    `output = ${luaString(name)}`,
    `mode = ${luaString(mode)}`,
    `position = ${luaString(position || "auto")}`,
    `scale = ${luaString(scale)}`,
  ]
  if (pref.vrr != null) campos.push(`vrr = ${pref.vrr ? 1 : 0}`)
  if (pref.mirrorOf && pref.mirrorOf !== "none") campos.push(`mirror = ${luaString(pref.mirrorOf)}`)
  if (pref.transform != null) campos.push(`transform = ${pref.transform}`)
  if (pref.bitdepth != null) campos.push(`bitdepth = ${pref.bitdepth}`)
  if (pref.cm) campos.push(`cm = ${luaString(pref.cm)}`)
  if (pref.sdrBrightness != null) campos.push(`sdrbrightness = ${pref.sdrBrightness}`)
  if (pref.sdrSaturation != null) campos.push(`sdrsaturation = ${pref.sdrSaturation}`)
  return `{ ${campos.join(", ")} }`
}

export function buildMonitorRule(r: RuleInput): string {
  const { name, position, pref } = r
  if (pref.enabled === false) return `${name},disable`
  const mode = pref.mode ? modeToHyprctl(pref.mode) : "preferred"
  const pos = position || "auto"
  const scale = pref.scale != null ? String(pref.scale) : "auto"
  let rule = `${name},${mode},${pos},${scale}`
  if (pref.vrr != null) rule += `,vrr,${pref.vrr ? 1 : 0}`
  if (pref.mirrorOf && pref.mirrorOf !== "none") rule += `,mirror,${pref.mirrorOf}`
  if (pref.transform != null) rule += `,transform,${pref.transform}`
  if (pref.bitdepth != null) rule += `,bitdepth,${pref.bitdepth}`
  if (pref.cm) rule += `,cm,${pref.cm}`
  if (pref.sdrBrightness != null) rule += `,sdrbrightness,${pref.sdrBrightness}`
  if (pref.sdrSaturation != null) rule += `,sdrsaturation,${pref.sdrSaturation}`
  return rule
}

export function matchScalePreset(scale: number): number {
  return SCALE_PRESETS.reduce(
    (best, p) => (Math.abs(p - scale) < Math.abs(best - scale) ? p : best),
    SCALE_PRESETS[0],
  )
}

interface MonitorState {
  width: number
  height: number
  refreshRate: number
  scale: number
  vrr: boolean
  disabled: boolean
  mirrorOf: string
  transform?: number
  bitdepth?: number
  cm?: string
}

// ¿El estado real difiere de la preferencia guardada? Se usa al arranque para
// re-aplicar SOLO lo que cambió (evita pelear con monitors.conf y parpadear).
export function monitorNeedsUpdate(monitor: MonitorState, pref: MonitorPref): boolean {
  if (pref.enabled === false) return !monitor.disabled       // quiero apagado, está encendido
  if (monitor.disabled) return true                          // quiero encendido (default), está apagado
  if (pref.mode) {
    const m = pref.mode.match(/^(\d+)x(\d+)@([\d.]+)/)
    if (m) {
      const w = Number(m[1]), h = Number(m[2]), hz = Math.round(parseFloat(m[3]))
      if (monitor.width !== w || monitor.height !== h || Math.round(monitor.refreshRate) !== hz) return true
    }
  }
  if (pref.scale != null && Math.abs(pref.scale - monitor.scale) > 0.01) return true
  if (pref.vrr != null && Boolean(pref.vrr) !== Boolean(monitor.vrr)) return true
  const wantMirror = pref.mirrorOf || "none"
  if ((monitor.mirrorOf || "none") !== wantMirror) return true
  if (pref.transform != null && (monitor.transform ?? 0) !== pref.transform) return true
  if (pref.bitdepth != null && (monitor.bitdepth ?? 8) !== pref.bitdepth) return true
  if (pref.cm != null && (monitor.cm ?? "auto") !== pref.cm) return true
  return false
}

// ── Ajustes generales (no limitados a availableModes) ─────────────────────────
// Hyprland acepta resoluciones no nativas (escala por GPU), así que ofrecemos una
// lista curada de resoluciones comunes en vez de solo las que reporta el panel.
export const COMMON_RESOLUTIONS: [number, number][] = [
  [3840, 2160], [2560, 1600], [2560, 1440], [1920, 1200], [1920, 1080],
  [1680, 1050], [1600, 900], [1440, 900], [1366, 768], [1280, 800],
  [1280, 720], [1024, 768],
]

export interface ResolutionOption {
  w: number
  h: number
  key: string       // "1920x1200"
  label: string     // "1920×1200" o "1920×1200 (nativa)"
  native: boolean
}

// Mayor resolución reportada por el panel (por área) — se considera la nativa.
export function nativeResolution(availableModes: string[]): { w: number; h: number } | null {
  let best: { w: number; h: number } | null = null
  for (const mode of availableModes) {
    const m = mode.match(/^(\d+)x(\d+)@/)
    if (!m) continue
    const w = Number(m[1]), h = Number(m[2])
    if (!best || w * h > best.w * best.h) best = { w, h }
  }
  return best
}

// Lista general de resoluciones seleccionables: la nativa marcada + las comunes
// que no superen la nativa, sin duplicados, ordenadas de mayor a menor área.
export function resolutionOptions(availableModes: string[]): ResolutionOption[] {
  const native = nativeResolution(availableModes)
  const seen = new Set<string>()
  const out: ResolutionOption[] = []
  const push = (w: number, h: number, isNative: boolean) => {
    const key = `${w}x${h}`
    if (seen.has(key)) return
    seen.add(key)
    out.push({ w, h, key, label: `${w}×${h}${isNative ? " (nativa)" : ""}`, native: isNative })
  }
  if (native) push(native.w, native.h, true)
  for (const [w, h] of COMMON_RESOLUTIONS) {
    if (native && w * h > native.w * native.h) continue
    push(w, h, false)
  }
  out.sort((a, b) => b.w * b.h - a.w * a.h)
  return out
}

export interface RefreshOption {
  hz: number
  raw: string       // string original ("144.00") para reconstruir el modo
}

// Hz distintos que reporta el panel para UNA resolución, redondeados y ordenados
// de mayor a menor.
//
// El filtro por resolución NO es cosmético: los modos de un panel no comparten
// frecuencias. Aquí (2560x1440) el panel da 240/165/144/120/60, pero a 1080p da
// además 100/50/30/25/24 — agruparlos todos ofrecía en el desplegable modos que
// esa resolución no admite. Y el `raw` es por modo, así que el 240 pooled venía
// del "239.97" de 1440p: elegirlo a 1080p mandaba `1920x1080@239.97Hz`, que no
// existe. `res` ausente (o una resolución fabricada de COMMON_RESOLUTIONS, que el
// panel no reporta) cae a la lista completa: es mejor ofrecer de más que dejar el
// desplegable vacío.
export function refreshOptions(availableModes: string[], res?: { w: number; h: number }): RefreshOption[] {
  const forRes = res
    ? availableModes.filter(m => m.startsWith(`${res.w}x${res.h}@`))
    : []
  const source = forRes.length > 0 ? forRes : availableModes

  const seen = new Set<number>()
  const out: RefreshOption[] = []
  for (const mode of source) {
    const m = mode.match(/@([\d.]+)Hz$/)
    if (!m) continue
    const raw = m[1]
    const hz = Math.round(parseFloat(raw))
    if (seen.has(hz)) continue
    seen.add(hz)
    out.push({ hz, raw })
  }
  out.sort((a, b) => b.hz - a.hz)
  return out
}

// Mejor frecuencia para `res` conservando la intención del usuario al cambiar de
// resolución: la misma si existe, si no la más alta por debajo, y como último
// recurso la más baja disponible.
//
// Sin esto, cambiar de resolución arrastraba los Hz actuales a pelo — pasar de
// 1080p@240 a 1440p pedía `2560x1440@240.00Hz`, que este panel no tiene (su modo
// es 239.97), y a 1600x1200 pedía 240 Hz donde el máximo son 60. Se prefiere
// bajar y no subir porque un modo por encima de lo que el panel admite es lo que
// deja la pantalla en negro.
export function bestRefreshFor(availableModes: string[], res: { w: number; h: number }, currentHz: number): string | null {
  // Resolución fabricada (COMMON_RESOLUTIONS, escalada por GPU): el panel no
  // reporta modos suyos, así que no hay nada mejor que conservar los Hz actuales.
  // Se comprueba aquí porque refreshOptions cae a la lista completa, y devolver
  // el raw de OTRA resolución sería peor que no tocar nada.
  if (!availableModes.some(m => m.startsWith(`${res.w}x${res.h}@`))) return null
  const opts = refreshOptions(availableModes, res)
  if (opts.length === 0) return null
  const target = Math.round(currentHz)
  const exact = opts.find(o => o.hz === target)
  if (exact) return exact.raw
  // opts va de mayor a menor: el primero por debajo del actual es el mayor que cabe.
  const lower = opts.find(o => o.hz < target)
  return (lower ?? opts[opts.length - 1]).raw
}
