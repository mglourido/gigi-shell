import GLib from "gi://GLib"
import { createState } from "ags"
import { execAsync } from "ags/process"
import { NOMBRE_TEMA_VALIDO, resolverTemaHyprcursor } from "./cursores"

export interface DeviceSettings {
  kbLayout: string
  kbVariant: string
  repeatRate: number
  repeatDelay: number
  numlock: boolean
  followMouse: number
  tamanoCursor: number
  /** Tema de puntero, o "" = no fijar ninguno (ver DEFAULT_DEVICE_SETTINGS). */
  temaCursor: string
  sensitivity: number
  accelProfile: "adaptive" | "flat"
  forceNoAccel: boolean
  leftHanded: boolean
  mouseNaturalScroll: boolean
  mouseScrollFactor: number
  touchpadNaturalScroll: boolean
  touchpadScrollFactor: number
  tapToClick: boolean
  tapButtonMap: "lrm" | "lmr"
  disableWhileTyping: boolean
  clickfinger: boolean
  middleEmulation: boolean
  dragLock: boolean
}

// `temaCursor: ""` significa "no fijar tema", no "usar uno de fábrica". Es el
// mismo criterio que el `locale` de gigios/env.lua: con la clave ausente no se
// emite ningún hl.env y manda lo que traiga la sesión. Poner aquí un nombre
// concreto cambiaría el puntero de una máquina que nunca ha tocado el ajuste —
// y encima nombraría un tema que puede no existir en ella.
export const DEFAULT_DEVICE_SETTINGS: DeviceSettings = {
  kbLayout: "es", kbVariant: "", repeatRate: 25, repeatDelay: 600,
  numlock: true, followMouse: 1, tamanoCursor: 24, temaCursor: "",
  sensitivity: 0, accelProfile: "adaptive", forceNoAccel: false,
  leftHanded: false, mouseNaturalScroll: false, mouseScrollFactor: 1,
  touchpadNaturalScroll: true, touchpadScrollFactor: 0.4,
  tapToClick: true, tapButtonMap: "lrm", disableWhileTyping: true,
  clickfinger: false, middleEmulation: false, dragLock: false,
}

// ÚNICO fichero que escribe este servicio. Lo lee también el config de Hyprland
// (hypr/gigios/dispositivos.lua, cargado después de gigios/userprefs.lua para
// que estas preferencias pisen a las de ahí), así que el dato vive en un solo
// sitio: aquí ya no se genera ningún chunk Lua. Antes se escribían los dos
// —devices.json e input-settings.lua— y podían divergir si el segundo fallaba.
const DATA_PATH = `${GLib.get_user_config_dir()}/gigios/devices.json`

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback
}

function normalize(raw: Partial<DeviceSettings> = {}): DeviceSettings {
  const d = DEFAULT_DEVICE_SETTINGS
  return {
    ...d, ...raw,
    kbLayout: typeof raw.kbLayout === "string" && raw.kbLayout.trim() ? raw.kbLayout.trim() : d.kbLayout,
    kbVariant: typeof raw.kbVariant === "string" ? raw.kbVariant.trim() : d.kbVariant,
    repeatRate: Math.round(clamp(raw.repeatRate, 1, 100, d.repeatRate)),
    repeatDelay: Math.round(clamp(raw.repeatDelay, 100, 2000, d.repeatDelay)),
    followMouse: Math.round(clamp(raw.followMouse, 0, 3, d.followMouse)),
    tamanoCursor: Math.round(clamp(raw.tamanoCursor, 16, 64, d.tamanoCursor)),
    // El nombre acaba en `hyprctl setcursor` y en un literal Lua de hl.env(), así
    // que se valida aquí una vez en vez de escaparlo en cada punto de uso. NO se
    // comprueba que el tema exista: un devices.json traído de otra máquina debe
    // conservar la elección aunque ese tema todavía no esté instalado.
    temaCursor: typeof raw.temaCursor === "string" && NOMBRE_TEMA_VALIDO.test(raw.temaCursor.trim())
      ? raw.temaCursor.trim() : d.temaCursor,
    sensitivity: clamp(raw.sensitivity, -1, 1, d.sensitivity),
    mouseScrollFactor: clamp(raw.mouseScrollFactor, 0.1, 5, d.mouseScrollFactor),
    touchpadScrollFactor: clamp(raw.touchpadScrollFactor, 0.1, 5, d.touchpadScrollFactor),
    accelProfile: raw.accelProfile === "flat" ? "flat" : "adaptive",
    tapButtonMap: raw.tapButtonMap === "lmr" ? "lmr" : "lrm",
  }
}

function read(): DeviceSettings {
  try {
    const [ok, bytes] = GLib.file_get_contents(DATA_PATH)
    if (ok) return normalize(JSON.parse(new TextDecoder().decode(bytes)))
  } catch (_) { /* defaults */ }
  return { ...DEFAULT_DEVICE_SETTINGS }
}

function sameSettings(a: DeviceSettings, b: DeviceSettings): boolean {
  return (Object.keys(DEFAULT_DEVICE_SETTINGS) as (keyof DeviceSettings)[]).every((key) => a[key] === b[key])
}

const [deviceSettings, _setDeviceSettings] = createState<DeviceSettings>(read())
export { deviceSettings }

// Literal de cadena Lua: kb_layout/kb_variant se interpolan en el `hyprctl eval`
// del aplicado en vivo, y una comilla sin escapar rompería el chunk.
const luaStr = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`

function write(s: DeviceSettings) {
  try {
    GLib.mkdir_with_parents(GLib.path_get_dirname(DATA_PATH), 0o755)
    GLib.file_set_contents(DATA_PATH, JSON.stringify(s, null, 2))
  } catch (e) { console.error("[devices] No se pudo guardar:", e) }
}

export function updateDeviceSettings(patch: Partial<DeviceSettings>, reload = false) {
  const next = normalize({ ...deviceSettings.get(), ...patch })
  if (sameSettings(deviceSettings.get(), next)) return
  _setDeviceSettings(next)
  write(next)
  if (patch.tamanoCursor !== undefined || patch.temaCursor !== undefined) {
    aplicarCursor(next.tamanoCursor, next.temaCursor)
  }
  // El reload puede ir detrás sin más: write() escribe devices.json de forma
  // SÍNCRONA (GLib.file_set_contents), así que cuando el `hyprctl reload` re-ejecute
  // la config Lua entera —y con ella gigios/dispositivos.lua, que lo lee— el
  // fichero ya está completo en disco.
  if (reload) execAsync(["hyprctl", "reload"]).catch(() => {})
  else {
    // `hyprctl keyword` no existe bajo config Lua: todos los campos cambiados van
    // en UN solo `hyprctl eval` con la tabla anidada que espera hl.config.
    const lua = liveConfigLua(patch, next)
    if (lua) execAsync(["hyprctl", "eval", lua]).catch(() => {})
  }
}

// Aplica puntero en vivo. El tema del ajuste manda; con el ajuste vacío se cae a
// la cadena de siempre (entorno → `default`), que es lo que mantiene el
// comportamiento anterior en una máquina que aún no lo ha elegido. Ese `default`
// solo resuelve porque seguimos su `Inherits` nosotros — libhyprcursor no lo
// hace, y sin nombre resoluble acaba cogiendo un tema cualquiera; ver cursores.ts.
function aplicarCursor(tamano: number, temaElegido: string) {
  // GTK no sigue `hyprctl setcursor`; GSettings cubre GTK y persiste por su lado.
  execAsync(["gsettings", "set", "org.gnome.desktop.interface", "cursor-size", String(tamano)]).catch(() => {})

  const candidatos = [temaElegido, GLib.getenv("HYPRCURSOR_THEME"), GLib.getenv("XCURSOR_THEME"), "default"]
  const tema = candidatos.reduce<string | null>((encontrado, candidato) =>
    encontrado ?? resolverTemaHyprcursor(candidato ?? ""), null)

  // HL.ConfigOpt no tiene sección env: las variables van por hl.env(). El --batch
  // admite mezclar `eval …` con `setcursor …` separados por " ; " (verificado en
  // 0.56); lo que NO admite es dispatch con sintaxis legacy.
  const comandos = [
    `eval hl.env('XCURSOR_SIZE','${tamano}')`,
    `eval hl.env('HYPRCURSOR_SIZE','${tamano}')`,
  ]
  if (tema) {
    // Las dos variables van al MISMO nombre a propósito: hyprcursor cubre el
    // cursor del compositor y XCursor sigue cubriendo XWayland y los toolkits.
    // hl.env() solo alcanza a los procesos que Hyprland lance a partir de ahora,
    // así que las apps ya abiertas conservan el tema anterior hasta reiniciarse:
    // esto es "a partir de aquí", no un cambio retroactivo de toda la sesión.
    comandos.push(`eval hl.env('XCURSOR_THEME','${tema}')`)
    comandos.push(`eval hl.env('HYPRCURSOR_THEME','${tema}')`)
    comandos.push(`setcursor ${tema} ${tamano}`)
    // GTK tampoco sigue el setcursor para el tema (igual que con el tamaño), y
    // además es de donde lo lee Hyprland al arrancar si cursor:sync_gsettings_theme
    // sigue activo — dejarlo desincronizado revive el tema viejo en el próximo login.
    execAsync(["gsettings", "set", "org.gnome.desktop.interface", "cursor-theme", tema]).catch(() => {})
  }
  execAsync(["hyprctl", "--batch", comandos.join(" ; ")]).catch(() => {})
}

// Ruta de cada campo dentro de la tabla de hl.config({ input = … }). Es el mapa
// que era LIVE_KEYWORDS, con el anidamiento explícito (input:touchpad:x →
// {input={touchpad={x=…}}}) y los nombres Lua (tap_to_click, no tap-to-click).
const LIVE_LUA_PATHS: Partial<Record<keyof DeviceSettings, string[]>> = {
  kbLayout: ["kb_layout"], kbVariant: ["kb_variant"], repeatRate: ["repeat_rate"],
  repeatDelay: ["repeat_delay"], numlock: ["numlock_by_default"], followMouse: ["follow_mouse"],
  sensitivity: ["sensitivity"], accelProfile: ["accel_profile"], forceNoAccel: ["force_no_accel"],
  leftHanded: ["left_handed"], mouseNaturalScroll: ["natural_scroll"], mouseScrollFactor: ["scroll_factor"],
  touchpadNaturalScroll: ["touchpad", "natural_scroll"], touchpadScrollFactor: ["touchpad", "scroll_factor"],
  tapToClick: ["touchpad", "tap_to_click"], tapButtonMap: ["touchpad", "tap_button_map"],
  disableWhileTyping: ["touchpad", "disable_while_typing"], clickfinger: ["touchpad", "clickfinger_behavior"],
  middleEmulation: ["touchpad", "middle_button_emulation"], dragLock: ["touchpad", "drag_lock"],
}

function luaValue(value: DeviceSettings[keyof DeviceSettings]): string {
  if (typeof value === "boolean") return value ? "true" : "false"
  if (typeof value === "number") return String(value)
  return luaStr(value)
}

// `hl.config({ input = {…} })` con SOLO los campos del patch que tienen mapeo,
// anidados donde toca. Devuelve null si el patch no toca nada aplicable en vivo.
function liveConfigLua(patch: Partial<DeviceSettings>, next: DeviceSettings): string | null {
  const input: Record<string, unknown> = {}
  for (const key of Object.keys(patch) as (keyof DeviceSettings)[]) {
    const path = LIVE_LUA_PATHS[key]
    if (!path) continue
    let cursor = input
    for (const seg of path.slice(0, -1)) {
      cursor = (cursor[seg] ??= {}) as Record<string, unknown>
    }
    cursor[path[path.length - 1]] = next[key]
  }
  if (Object.keys(input).length === 0) return null
  const tabla = (obj: Record<string, unknown>): string =>
    `{ ${Object.entries(obj).map(([k, v]) =>
      `${k} = ${typeof v === "object" && v !== null ? tabla(v as Record<string, unknown>) : luaValue(v as DeviceSettings[keyof DeviceSettings])}`,
    ).join(", ")} }`
  return `hl.config({ input = ${tabla(input)} })`
}

export function resetDeviceSettings() {
  const next = { ...DEFAULT_DEVICE_SETTINGS }
  _setDeviceSettings(next)
  write(next)   // síncrono: devices.json queda completo ANTES del reload de abajo
  aplicarCursor(next.tamanoCursor, next.temaCursor)
  execAsync(["hyprctl", "reload"]).catch(() => {})
}

// No escribimos nada al importar este módulo: el fichero se guarda solo cuando el
// usuario cambia algo. Ya no vive bajo ~/.config/hypr (Hyprland vigila sus
// archivos de configuración y escribir ahí al arrancar AGS provocaba una recarga
// visible), pero la regla se mantiene: escribir por escribir no aporta nada.
