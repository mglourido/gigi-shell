// servicios/pantalla/service.ts
// Cola reactiva de gestión de pantallas compartida por QuickSettings (acceso
// rápido) y la sección Pantalla de Ajustes. Fuente única de verdad: estado de
// monitores (poller ref-counted), applyPatch en vivo, persistencia en
// display.json (monitors + global) y scheduler de luz nocturna por reloj.
import { createState } from "ags"
import { execAsync } from "ags/process"
import GLib from "gi://GLib"
import { buildMonitorSpecLua, monitorNeedsUpdate } from "./modes"
import type { MonitorPref } from "./modes"
import { normalizeRules, ruleKey, ultimoDisparo, type Channel } from "./schedule"
import type { NightRule } from "./schedule"
import { parseModetestCaps, parseEdidHdr } from "./caps"
import { applyBrightness, brightnessSupported, softwareDim } from "./brightness"
import { DIM_FLOOR } from "./atenuacion"
import {
  brightness,
  nightLightActive, setNightLightActive,
  nightLightTemp, setNightLightTemp,
} from "../../estado/shell"
import AstalHyprland from "gi://AstalHyprland"
import { hayJuegosAbiertos, revisionVentanas } from "../juegos/registro"
import { algunaVentanaCoincide } from "../ventanas/coincidenciaClases"
import { pausaLuzNocturnaApps, pausaLuzNocturnaJuegos } from "../../modulos/ajustes/preferences"

const DISPLAY_CONFIG_PATH = `${GLib.get_user_config_dir()}/gigishell/display.json`

export interface GlobalDisplay {
  vrrMode: number             // 0 off, 1 on, 2 pantalla completa, 3 solo videojuegos (fullscreen_game)
  allowTearing: boolean
  nightRulesEnabled: boolean  // ¿programación por horas activada?
  nightRules: NightRule[]     // reglas hora→{luz nocturna, brillo}
}

/** Estado de la luz nocturna tal como lo escribe un disparo (el mismo que el interruptor). */
type EstadoLuz = { active: boolean; temp: number }

/** Apunte de una franja en curso, por canal: el estado de justo antes de que empezara y el
 *  que puso ella. NO es configuración del usuario. Vive en disco porque el fin de la franja
 *  **cruza apagados** (una franja 00:00→07:00 se sale casi siempre con el PC apagado) y el
 *  brillo deja residuo físico en el monitor. Ver `dispararFin`. */
type FranjaPendiente = {
  temp?: { antes: EstadoLuz; aplicado: EstadoLuz }
  brightness?: { antes: number; aplicado: number }   // 0..1
}

interface DisplayConfig {
  brightness: number
  nightLightActive: boolean
  nightLightTemp: number
  franjasPendientes: Record<string, FranjaPendiente>
  monitors: Record<string, MonitorPref>
  global: GlobalDisplay
}

const DEFAULT_GLOBAL: GlobalDisplay = {
  vrrMode: 0, allowTearing: false,
  nightRulesEnabled: false, nightRules: [],
}

// Apuntes de franjas en curso. Migra el formato anterior (`brightnessWindow`: un único
// apunte de brillo con clave `inicio-fin|valor`), que sin migrar perdería el brillo previo
// si la actualización llega con una franja nocturna a medias.
function leerFranjasPendientes(c: any): Record<string, FranjaPendiente> {
  const out: Record<string, FranjaPendiente> = {}
  const esLuz = (v: any): v is EstadoLuz =>
    !!v && typeof v.active === "boolean" && typeof v.temp === "number"
  const esNum = (v: any): v is number => typeof v === "number" && Number.isFinite(v)
  const raw = c?.franjasPendientes
  if (raw && typeof raw === "object") {
    for (const [clave, f] of Object.entries<any>(raw)) {
      const p: FranjaPendiente = {}
      if (f?.temp && esLuz(f.temp.antes) && esLuz(f.temp.aplicado)) p.temp = f.temp
      if (f?.brightness && esNum(f.brightness.antes) && esNum(f.brightness.aplicado)) p.brightness = f.brightness
      if (p.temp || p.brightness) out[clave] = p
    }
  }
  const w = c?.brightnessWindow
  if (w && typeof w.key === "string" && esNum(w.before)) {
    const [clave, valor] = w.key.split("|")
    const aplicado = Number(valor) / 100
    if (clave && Number.isFinite(aplicado)) {
      out[clave] = { ...out[clave], brightness: { antes: w.before, aplicado } }
    }
  }
  return out
}

export function loadDisplayConfig(): DisplayConfig {
  try {
    const [ok, content] = GLib.file_get_contents(DISPLAY_CONFIG_PATH)
    if (ok) {
      const c = JSON.parse(new TextDecoder().decode(content))
      const g = c.global ?? {}
      return {
        brightness: c.brightness ?? 0.5,
        nightLightActive: c.nightLightActive ?? false,
        nightLightTemp: c.nightLightTemp ?? 4500,
        franjasPendientes: leerFranjasPendientes(c),
        monitors: c.monitors ?? {},
        global: {
          ...DEFAULT_GLOBAL, ...g,
          nightRulesEnabled: !!g.nightRulesEnabled,
          nightRules: normalizeRules(g.nightRules),
        },
      }
    }
  } catch (e) { /* fichero ausente o corrupto → defaults */ }
  return {
    brightness: 0.5, nightLightActive: false, nightLightTemp: 4500,
    franjasPendientes: {}, monitors: {}, global: { ...DEFAULT_GLOBAL },
  }
}

const config = loadDisplayConfig()

// Preferencias de monitor persistidas, clave = description (estable entre
// reconexiones/arranques, a diferencia de "HDMI-A-1").
export const monitorPrefs: Record<string, MonitorPref> = config.monitors

// `monitorPrefs` es un objeto plano, sin reactividad: la interfaz que lo lee (profundidad de
// color, gestión de color) no se enteraba de un cambio que no alterase `monitors()`. Esto lo
// avisa; leerlo dentro de un createComputed basta para suscribirse.
export const [revisionPrefs, setRevisionPrefs] = createState(0)

// Estado global reactivo
export const [globalVrrMode, setGlobalVrrMode] = createState(config.global.vrrMode)
export const [allowTearing, setAllowTearing] = createState(config.global.allowTearing)
export const [nightRules, setNightRules] = createState<NightRule[]>(config.global.nightRules)
export const [nightRulesEnabled, setNightRulesEnabledState] = createState(config.global.nightRulesEnabled)

// Guardado debounced (2 s): brightness.subscribe dispara a menudo, no queremos
// escribir el archivo en cada tick.
let saveTimeout: number | null = null

function writeDisplayConfig() {
  try {
    const dir = GLib.path_get_dirname(DISPLAY_CONFIG_PATH)
    if (!GLib.file_test(dir, GLib.FileTest.EXISTS)) execAsync(["mkdir", "-p", dir]).catch(() => {})
    const out: DisplayConfig = {
      brightness: brightness.get(),
      nightLightActive: nightLightActive.get(),
      nightLightTemp: nightLightTemp.get(),
      franjasPendientes,
      monitors: monitorPrefs,
      global: {
        vrrMode: globalVrrMode.get(),
        allowTearing: allowTearing.get(),
        nightRulesEnabled: nightRulesEnabled.get(),
        nightRules: nightRules.get(),
      },
    }
    GLib.file_set_contents(DISPLAY_CONFIG_PATH, JSON.stringify(out))
  } catch (e) { /* no-op */ }
}

export function saveDisplayConfig() {
  if (saveTimeout !== null) GLib.source_remove(saveTimeout)
  saveTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
    writeDisplayConfig()
    saveTimeout = null
    return GLib.SOURCE_REMOVE
  })
}

// Guardado SÍNCRONO, sin esperar al debounce. Lo usa el guardado de prefs por
// monitor porque display.json dejó de ser solo la fuente de verdad de AGS: lo lee
// también el config de Hyprland (hypr/gigishell/pantalla.lua). Con los 2 s de por
// medio, un `hyprctl reload` disparado justo después de tocar la resolución
// releería el fichero VIEJO y devolvería la pantalla al valor anterior.
export function saveDisplayConfigNow() {
  if (saveTimeout !== null) { GLib.source_remove(saveTimeout); saveTimeout = null }
  writeDisplayConfig()
}

// ── Cómo llegan estas prefs a Hyprland ───────────────────────────────────────
// display.json NO es solo la fuente de verdad de AGS: lo lee también el config
// del compositor (hypr/gigishell/pantalla.lua), que recorre `monitors` y emite un
// `hl.monitor{ output = "desc:…" }` por entrada, DESPUÉS del comodín de
// gigishell/monitores.lua — una spec concreta gana a la comodín, que sigue cubriendo
// los monitores sin preferencia guardada.
//
// Hace falta porque el comodín no lleva más que `preferred/auto/1`: sin nadie que
// aplique las prefs al cargar, cualquier `hyprctl reload` devolvía el monitor a
// modo preferido y escala 1 (240 Hz → 60, 1.25 → 1) sin que AGS se enterara — no
// hay señal de recarga a la que suscribirse, y su poller solo observa. Efecto
// extra: el compositor arranca ya en el modo bueno, sin el parpadeo de la
// re-aplicación.
//
// Antes esto se resolvía volcando además un `monitor-settings.lua` generado. Ya
// no: el config tiene condiciones y bucles, así que lee el JSON directamente. Se
// acabó el dato escrito dos veces, el fichero generado dentro del árbol de git y
// el escapado de la `description` del EDID, que venía del EDID y se interpolaba
// en un chunk (una comilla suelta rompía la config entera).
export function saveMonitorPref(description: string, pref: MonitorPref) {
  if (!description) return
  monitorPrefs[description] = pref
  setRevisionPrefs(revisionPrefs.get() + 1)
  // Síncrono, no debounced: ver saveDisplayConfigNow().
  saveDisplayConfigNow()
}

// Modo que el ahorro reemplazó en cada monitor (clave = nombre de conector) y al que hay que
// volver al salir. Solo RAM y a propósito: el cambio del ahorro es en vivo y NO toca
// `monitorPrefs`/display.json, así que un AGS que muera con el ahorro puesto no deja
// residuo — el siguiente `hyprctl reload` o inicio de sesión repone los Hz de siempre.
export const modoAntesDelAhorro = new Map<string, string>()

// ── Poller de monitores (ref-counted) ────────────────────────────────────────
export const [monitors, setMonitors] = createState<any[]>([])
let lastSig = ""

export function refreshMonitors() {
  execAsync(["hyprctl", "monitors", "all", "-j"]).then(out => {
    let list: any[] = []
    try { list = JSON.parse(out) } catch { return }
    const sig = list.map((m: any) =>
      `${m.name}|${m.width}x${m.height}@${Math.round(m.refreshRate)}|${m.scale}|${m.vrr}|${m.currentFormat}|${m.disabled}|${m.mirrorOf}|${m.focused}|${m.transform}|${(m.availableModes || []).join(",")}`
    ).join(";")
    if (sig !== lastSig) { lastSig = sig; setMonitors(list) }
  }).catch(() => {})
}

// ── Capacidades por monitor (para ocultar ajustes no soportados) ──────────────
// Clave = nombre de conector (eDP-1, HDMI-A-1…). Vacío hasta que detectCaps()
// termine; los ajustes inciertos se ocultan mientras tanto.
export interface MonitorCaps { vrr: boolean; bitdepth10: boolean; hdr: boolean }
export const [monitorCaps, setMonitorCaps] = createState<Record<string, MonitorCaps>>({})

// Detecta capacidades vía DRM (modetest) + EDID (edid-decode). hyprctl no expone
// vrr_capable/max bpc/HDR, así que se leen de las propiedades del conector.
function detectCaps() {
  // 1) drivers de cada card (i915, nvidia, amdgpu…)
  execAsync(["bash", "-c",
    'for c in /sys/class/drm/card[0-9]; do [ -e "$c/device/driver" ] && basename "$(readlink -f "$c/device/driver")"; done | sort -u',
  ]).then(drvOut => {
    const drivers = drvOut.split("\n").map(s => s.trim()).filter(Boolean)
    if (drivers.length === 0) return
    // 2) modetest por driver (concatenado) → vrr + max bpc
    const mtCmd = drivers.map(d => `modetest -M ${d} -c 2>/dev/null`).join("; ")
    execAsync(["bash", "-c", mtCmd]).then(mtOut => {
      const mt = parseModetestCaps(mtOut)
      // 3) EDID por conector → HDR
      execAsync(["bash", "-c",
        'for e in /sys/class/drm/card*-*/edid; do [ -s "$e" ] || continue; ' +
        'conn=$(basename "$(dirname "$e")" | sed "s/^card[0-9]*-//"); echo "###EDID $conn"; ' +
        'edid-decode "$e" 2>/dev/null | grep -iE "HDR Static Metadata|SMPTE ST 2084|BT2020|Hybrid Log-Gamma"; done',
      ]).then(edOut => {
        const hdr = parseEdidHdr(edOut)
        const merged: Record<string, MonitorCaps> = {}
        for (const name of Object.keys(mt)) merged[name] = { vrr: mt[name].vrr, bitdepth10: mt[name].bitdepth10, hdr: hdr.has(name) }
        setMonitorCaps(merged)
      }).catch(() => {
        const merged: Record<string, MonitorCaps> = {}
        for (const name of Object.keys(mt)) merged[name] = { vrr: mt[name].vrr, bitdepth10: mt[name].bitdepth10, hdr: false }
        setMonitorCaps(merged)
      })
    }).catch(() => {})
  }).catch(() => {})
}

let pollId: number | null = null
let pollRefs = 0
export function acquirePoll() {
  pollRefs++
  if (pollId === null) {
    refreshMonitors()
    pollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => { refreshMonitors(); return GLib.SOURCE_CONTINUE })
  }
}
export function releasePoll() {
  pollRefs = Math.max(0, pollRefs - 1)
  if (pollRefs === 0 && pollId !== null) { GLib.source_remove(pollId); pollId = null }
}

// Aplica un patch parcial a un monitor: resuelve pref completa, persiste, emite
// hyprctl y refresca. `position` sale de patch.position o del estado actual.
export function applyPatch(mon: any, patch: Partial<MonitorPref>) {
  // Un modo elegido a mano durante el ahorro manda: el ahorro deja de tener nada que
  // devolver. Sin modo en el patch (p. ej. cambiar la escala) se persiste el modo NORMAL,
  // no el de ahorro, que si no acabaría en display.json como si lo hubiera elegido el usuario.
  if (patch.mode !== undefined) modoAntesDelAhorro.delete(mon.name)
  const resolved: MonitorPref = {
    mode: patch.mode ?? modoAntesDelAhorro.get(mon.name) ?? `${mon.width}x${mon.height}@${mon.refreshRate.toFixed(2)}Hz`,
    scale: patch.scale ?? mon.scale,
    enabled: patch.enabled ?? !mon.disabled,
    mirrorOf: patch.mirrorOf ?? (mon.mirrorOf ?? "none"),
    transform: patch.transform ?? (mon.transform ?? 0),
    // Profundidad y color NO salen del monitor en vivo: si el patch no los trae (cambiar la
    // escala, el modo o el VRR) hay que conservar lo guardado. Antes se tiraban, la spec salía
    // sin `bitdepth` y Hyprland volvía a 8 bits, y display.json lo olvidaba para el siguiente
    // arranque.
    bitdepth: patch.bitdepth ?? monitorPrefs[mon.description]?.bitdepth,
    cm: patch.cm ?? monitorPrefs[mon.description]?.cm,
    sdrBrightness: patch.sdrBrightness ?? monitorPrefs[mon.description]?.sdrBrightness,
    sdrSaturation: patch.sdrSaturation ?? monitorPrefs[mon.description]?.sdrSaturation,
    position: patch.position ?? undefined,
  }
  const position = resolved.position && resolved.position !== "auto"
    ? resolved.position
    : `${mon.x}x${mon.y}`
  // Persistir la posición REAL, no la del patch: en vivo el compositor la resuelve
  // solo, pero al recargar el config lee display.json sin nadie que la resuelva, y
  // con "auto" un layout multi-monitor se recolocaría solo.
  resolved.position = position
  const spec = buildMonitorSpecLua({ name: mon.name, position, pref: resolved })
  saveMonitorPref(mon.description, resolved)
  // Bajo config Lua no existe `hyprctl keyword`: el cambio en vivo va por eval.
  execAsync(["hyprctl", "eval", `hl.monitor(${spec})`]).catch(() => {})
    .then(() => { GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => { refreshMonitors(); return GLib.SOURCE_REMOVE }) })
}

// Cambia el modo de un monitor SOLO EN VIVO: como `applyPatch` pero sin `saveMonitorPref`.
// Lo usa el modo ahorro, cuyo modo no es una preferencia del usuario y no debe llegar a disco.
export function aplicarModoTemporal(mon: any, modeString: string): Promise<unknown> {
  const position = `${mon.x}x${mon.y}`
  const pref: MonitorPref = {
    ...monitorPrefs[mon.description],
    mode: modeString,
    scale: mon.scale,
    enabled: !mon.disabled,
    mirrorOf: mon.mirrorOf ?? "none",
    transform: mon.transform ?? 0,
    position,
  }
  const spec = buildMonitorSpecLua({ name: mon.name, position, pref })
  return execAsync(["hyprctl", "eval", `hl.monitor(${spec})`]).catch(() => {})
    .then(() => { GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => { refreshMonitors(); return GLib.SOURCE_REMOVE }) })
}

// ── Ajustes globales en vivo ─────────────────────────────────────────────────
export function applyGlobalVrr(mode: number) {
  setGlobalVrrMode(mode); saveDisplayConfig()
  execAsync(["hyprctl", "eval", `hl.config({ misc = { vrr = ${mode} } })`]).catch(() => {})
}
export function applyAllowTearing(on: boolean) {
  setAllowTearing(on); saveDisplayConfig()
  execAsync(["hyprctl", "eval", `hl.config({ general = { allow_tearing = ${on ? "true" : "false"} } })`]).catch(() => {})
}

// ── Luz nocturna + brillo: estado manual + programación horaria por disparos ─
// El estado de la pantalla es UNO: el manual (`nightLightActive` + `nightLightTemp` y el
// brillo). La programación horaria (`nightRulesEnabled` + `nightRules`) no sostiene nada:
// a la hora de cada regla escribe ese mismo estado, como si el usuario pulsara el
// interruptor o moviera el slider, y luego manda el usuario hasta el siguiente disparo.
// Ver `schedule.ts` para los dos tipos de regla y la sección «Programación horaria» abajo.
// `lastAppliedTemp === -1` ⇒ hyprsunset apagado.
let lastAppliedTemp = -1

// Gamma aplicado (0..100). hyprsunset sostiene DOS canales en la misma matriz: temperatura
// (luz nocturna) y gamma (el tramo software del brillo, ver `atenuacion.ts`). Por eso el
// proceso tiene UN solo dueño y se reconcilian juntos: dos escritores se pisarían.
let lastAppliedGamma = 100

/** Temperatura neutra: la que hyprsunset usa por defecto. Es la que se pide cuando el
 *  proceso hace falta SOLO para el gamma — sin esto, atenuar por software encendería de
 *  paso la luz nocturna, que es un ajuste distinto que el usuario no ha pedido. */
const TEMP_NEUTRA = 6000

function rulesOn(): boolean { return nightRulesEnabled.get() && nightRules.get().length > 0 }

// ¿La luz nocturna está encendida AHORA? Estado reactivo que consume el toggle
// maestro de QuickSettings (refleja la fuente real: manual O programada).
export const [nightOn, setNightOn] = createState(false)

// ── Pausa por juego (Ajustes > Juegos > "Pausar la luz nocturna al jugar") ────
// Con la preferencia activa, mientras haya una ventana que retenga la luz nocturna esta
// no se enciende, venga de donde venga la orden: ni la franja horaria que entra a mitad
// de partida, ni el interruptor manual que quedó encendido de antes. Al cerrarla se
// reconcilia y vuelve lo que tocara — no hay que volver a encender nada a mano.
//
// Retienen DOS cosas, y la segunda no depende de la primera: los juegos que reconoce el
// registro de `servicios/juegos/` (`hayJuegoAbierto`) y las clases que el usuario apunte
// a mano (`hayAppQuePausa`), para lo que el detector no ve como juego. Con `escanerJuegos`
// en false la primera mitad queda muerta —`clientesJuego` está vacío para siempre— pero la
// segunda sigue entera, así que en Ajustes solo se retira la fila del interruptor de
// juegos, no la lista.
//
// Se mira que la ventana EXISTA, no que tenga el FOCO, al contrario que el gate de bash
// (lib/gaming-gate.sh) que sí distingue "juego abierto" de "juego atendido". Aquí la
// distinción sería un parpadeo: teñir la pantalla de naranja cada vez que haces alt-tab
// al navegador y quitarlo al volver al juego es peor que las dos alternativas. El
// usuario pidió "hasta que salga del juego" y eso es literalmente la vida de la ventana.
// Es también lo que hace que la lista manual sea un arma cargada —apuntar ahí el
// navegador deja la luz nocturna apagada el día entero— y por eso la UI lo dice.
export const [luzPausadaPorJuego, setLuzPausadaPorJuego] = createState(false)

// Escotilla: si el usuario toca la luz A MANO con la pausa vigente, gana él y la pausa
// se retira hasta que cierre el juego. Sin esto, el interruptor de Quick Settings y el
// slider de temperatura no harían nada durante una partida. Lo levanta `tocarLuzAMano`.
// No se persiste: caduca con la partida.
let pausaJuegoIgnorada = false

function hayJuegoAbierto(): boolean {
  return hayJuegosAbiertos.get()
}

// La mitad MANUAL: clases apuntadas a mano en Ajustes (`pausaLuzNocturnaApps`), para lo
// que el detector no reconoce como juego —un emulador, un juego sin `.desktop`, un
// launcher propio— o directamente no lo es. Se compara clase contra clase con el
// comparador compartido, así que **no depende del escáner de juegos**: sigue funcionando
// con la detección apagada, y por eso su parte de la UI no se retira con ella.
//
// La lista vacía —el caso normal— sale sin pedirle los clientes al compositor: esto se
// evalúa desde `revisionVentanas`, que emite también en cada cambio de foco (con
// `follow_mouse = 1`, cada vez que el puntero cruza de una ventana a otra).
function hayAppQuePausa(): boolean {
  const apps = pausaLuzNocturnaApps.get()
  if (apps.length === 0) return false
  try {
    return algunaVentanaCoincide(AstalHyprland.get_default().get_clients?.() ?? [], apps)
  } catch (e) {
    return false   // sin compositor al que preguntar, no se retiene nada
  }
}

/** ¿Hay abierta una ventana que retenga la luz: un juego detectado o una app de la lista? */
function hayVentanaQuePausa(): boolean {
  return hayJuegoAbierto() || hayAppQuePausa()
}

/** ¿Está la luz nocturna retenida ahora mismo? */
function pausadaPorJuego(): boolean {
  return pausaLuzNocturnaJuegos.get() && !pausaJuegoIgnorada && hayVentanaQuePausa()
}

// El usuario acaba de tocar la luz a mano: durante una partida eso es decir "esta vez la
// quiero yo", así que se levanta la pausa hasta que el juego cierre (applyNight la repone).
function tocarLuzAMano() {
  if (pausadaPorJuego()) pausaJuegoIgnorada = true
}

// Temperatura que debe sostener hyprsunset: la del estado manual, que es también donde
// escriben los disparos del horario. La pausa por juego va PRIMERO: es un veto sobre él.
function baseTemp(): number | null {
  if (pausadaPorJuego()) return null
  if (nightLightActive.get()) return nightLightTemp.get()
  return null
}

// ── Programación horaria: disparos ───────────────────────────────────────────
// Cada regla dispara a su hora UNA vez y escribe el estado (ver `schedule.ts`). Lo que el
// usuario haga después se respeta hasta el siguiente disparo: el horario ya no se reimpone
// cada minuto. Tres piezas:
//
// (1) `revisado`: minuto (epoch) hasta el que cada canal está repasado. El tick de 60 s
//     dispara el último disparo de cada canal solo si cayó DESPUÉS de esa marca, así que
//     cada disparo actúa una vez, y una suspensión que se salte varios aplica solo el
//     último. `null` = sin repasar: al iniciar sesión (y al editar el horario) se reaplica
//     el estado que el horario establece para esa hora. Por canal, porque el brillo espera
//     al backend (el sondeo DDC tarda ~1 s).
// (2) `franjasPendientes`: al empezar una franja se apunta, por canal, el estado de antes
//     y el que puso. Al acabar, si el canal sigue como la franja lo dejó (el usuario no lo
//     tocó), se devuelve lo de antes; si no, el fin no cambia nada. Es comparar estado y no
//     interceptar cada slider/tecla, así que vale también para lo que llega por udev.
// (3) El apunte vive EN DISCO: el brillo deja residuo físico (la franja lo graba en la
//     firmware del monitor por DDC) y una franja nocturna se sale casi siempre con el PC
//     apagado. Sin apunte, al arrancar `detectDdc()` leía el valor de la franja y se adoptaba
//     como el del usuario (medido: brillo 73 → franja 80 → apagar dentro → arrancar fuera =
//     monitor a 80 y `"brightness":0.8` en disco). Con él, el fin pendiente se cobra al
//     arrancar, comparando con el brillo GUARDADO (`brilloActual`), no con esa lectura.
const franjasPendientes: Record<string, FranjaPendiente> = config.franjasPendientes
const revisado: Record<Channel, number | null> = { temp: null, brightness: null }

/** Margen al comparar brillos: el hardware redondea a enteros por ciento. */
const MARGEN_BRILLO = 0.015

function ahora() {
  const d = GLib.DateTime.new_now_local()
  return { hm: { h: d.get_hour(), m: d.get_minute() }, minuto: Math.floor(d.to_unix() / 60) }
}
function estadoLuz(): EstadoLuz { return { active: nightLightActive.get(), temp: nightLightTemp.get() } }
function mismaLuz(a: EstadoLuz, b: EstadoLuz): boolean {
  return a.active === b.active && (!a.active || a.temp === b.temp)
}

// Hasta el primer repaso del brillo, el brillo "actual" es el guardado en disco: lo que
// publica `detectDdc()` puede ser el residuo de una franja en el monitor (ver (3)) o el
// suelo del tramo hardware si se apagó atenuado por software.
let brilloInicialHecho = false
function brilloActual(): number { return brilloInicialHecho ? brightness.get() : config.brightness }

function dispararInicio(canal: Channel, regla: NightRule) {
  const clave = ruleKey(regla)
  const previa = franjasPendientes[clave]
  if (canal === "temp") {
    const t = regla.temp as number
    const aplicado: EstadoLuz = t > 0 ? { active: true, temp: t } : { active: false, temp: nightLightTemp.get() }
    // Reaplicar la misma franja (reiniciar dentro de ella) conserva el "antes" original.
    if (regla.end != null) {
      franjasPendientes[clave] = { ...previa, temp: { antes: previa?.temp?.antes ?? estadoLuz(), aplicado } }
    }
    setNightLightActive(aplicado.active); setNightLightTemp(aplicado.temp)
  } else {
    const aplicado = (regla.brightness as number) / 100
    if (regla.end != null) {
      franjasPendientes[clave] = { ...previa, brightness: { antes: previa?.brightness?.antes ?? brilloActual(), aplicado } }
    }
    applyBrightness(aplicado)
  }
}

// Fin de una franja (o franja borrada / horario apagado): devuelve el canal a lo de antes si
// nadie lo tocó, y olvida el apunte. Devuelve si cambió el brillo.
function saldarFranja(canal: Channel, clave: string): boolean {
  const f = franjasPendientes[clave]
  let cambioBrillo = false
  if (canal === "temp" && f?.temp) {
    if (mismaLuz(estadoLuz(), f.temp.aplicado)) {
      setNightLightActive(f.temp.antes.active); setNightLightTemp(f.temp.antes.temp)
    }
    delete f.temp
  } else if (canal === "brightness" && f?.brightness) {
    // Sin backend la restauración se perdería en el vacío Y borraría el apunte, que es lo
    // único que recuerda el brillo real: se espera a tenerlo.
    if (!brightnessSupported.get()) return false
    if (Math.abs(brilloActual() - f.brightness.aplicado) < MARGEN_BRILLO) {
      applyBrightness(f.brightness.antes)
      cambioBrillo = true
    }
    delete f.brightness
  }
  if (f && !f.temp && !f.brightness) delete franjasPendientes[clave]
  return cambioBrillo
}

/** Repasa un canal: si su último disparo aún no se aplicó, lo aplica. Devuelve si tocó algo. */
function repasarCanal(canal: Channel): boolean {
  const { hm, minuto } = ahora()
  const desde = revisado[canal]
  revisado[canal] = minuto
  if (!rulesOn()) return false
  const d = ultimoDisparo(hm, nightRules.get(), canal)
  if (!d || (desde !== null && minuto - d.hace <= desde)) return false
  if (d.tipo === "inicio") { dispararInicio(canal, d.regla); return true }
  const clave = ruleKey(d.regla)
  const habia = !!franjasPendientes[clave]?.[canal]
  saldarFranja(canal, clave)
  return habia
}

// El brillo, solo con backend. Su PRIMER repaso es además el que decide si se restaura el
// tramo software guardado (ver `initDisplayService`): si el horario no aplicó nada, el valor
// bueno es el del disco.
function repasarBrillo(): boolean {
  if (!brightnessSupported.get()) return false
  if (brilloInicialHecho) return repasarCanal("brightness")
  const aplicado = repasarCanal("brightness")
  brilloInicialHecho = true
  // Restaurar el tramo SOFTWARE del brillo guardado, salvo que el horario acabe de fijar
  // otro. Es la mitad que el hardware no puede recordar: el gamma lo sostiene `hyprsunset`,
  // que muere con la sesión, mientras que el monitor sí conserva su valor DDC. Al arrancar
  // por debajo del suelo, `detectDdc()` lee el mínimo del panel y publica el SUELO (0.35):
  // sin esto la atenuación se perdía y el slider saltaba hacia arriba en cada arranque
  // (medido: gamma 39 → reiniciar → 100). En la zona hardware manda el monitor.
  if (!aplicado && config.brightness < DIM_FLOOR) applyBrightness(config.brightness)
  return aplicado
}

// Repasa los dos canales y reconcilia. Lo llaman el arranque, el tick de 60 s y todo cambio
// en el horario.
function applyRules() {
  const luz = repasarCanal("temp")
  repasarBrillo()   // el brillo se guarda solo: brightness.subscribe(saveDisplayConfig)
  if (luz) saveDisplayConfig()
  applyNight()
}

// Cierra los apuntes que ya no tienen un fin que los vaya a saldar: los de reglas borradas o
// que han dejado de programar ese canal (`seguir` dice cuáles siguen), o todos al apagar el
// horario. Cuentan como el fin de su franja.
function saldarHuerfanas(seguir: (clave: string, canal: Channel) => boolean) {
  let tocado = false
  for (const clave of Object.keys(franjasPendientes)) {
    for (const canal of ["temp", "brightness"] as Channel[]) {
      if (!franjasPendientes[clave]?.[canal] || seguir(clave, canal)) continue
      saldarFranja(canal, clave)
      tocado = true
    }
  }
  if (tocado) saveDisplayConfig()
}

// Reconcilia hyprsunset con el estado deseado (arranca / cambia temp / apaga) y
// publica `nightOn`.
function applyNight() {
  // Cerrada la ventana que retenía, la escotilla manual caduca: la próxima vuelve a pausar.
  if (!hayVentanaQuePausa()) pausaJuegoIgnorada = false
  setLuzPausadaPorJuego(pausadaPorJuego())
  const temp = baseTemp()
  // `nightOn` sigue colgando SOLO de la temperatura: atenuar por software no es luz
  // nocturna, y encender su interruptor por bajar el brillo confundiría dos ajustes.
  setNightOn(temp != null)

  const gamma = Math.max(1, Math.min(100, Math.round(softwareDim.get() * 100)))

  // hyprsunset hace falta si lo pide CUALQUIERA de los dos canales. Antes solo lo pedía la
  // luz nocturna, así que atenuar con ella apagada no habría tenido dónde aplicarse.
  if (temp == null && gamma >= 100) {
    if (lastAppliedTemp !== -1) {
      lastAppliedTemp = -1; lastAppliedGamma = 100
      execAsync(["pkill", "-HUP", "-x", "hyprsunset"]).catch(() => {})
    }
    return
  }

  const t = temp ?? TEMP_NEUTRA
  if (lastAppliedTemp === -1) {
    // off → on: arrancar ya con los dos canales, para no pintar un fogonazo a brillo pleno
    // entre el arranque del proceso y el ajuste del gamma.
    execAsync(["bash", "-c", `pkill -HUP -x hyprsunset; hyprsunset -t ${t} -g ${gamma} &`]).catch(() => {})
  } else {
    // on → on: cada canal se cambia en caliente y solo si de verdad se movió.
    if (t !== lastAppliedTemp) execAsync(["bash", "-c", `hyprctl hyprsunset temperature ${t}`]).catch(() => {})
    if (gamma !== lastAppliedGamma) execAsync(["bash", "-c", `hyprctl hyprsunset gamma ${gamma}`]).catch(() => {})
  }
  lastAppliedTemp = t
  lastAppliedGamma = gamma
}

// Maestro de QuickSettings: apaga o enciende la luz ahora. El horario sigue activo: el
// siguiente disparo volverá a escribir el estado.
export function toggleNightNow() {
  setNightLightActive(!nightOn.get())
  tocarLuzAMano()
  saveDisplayConfig(); applyNight()
}

// (1) Toggle manual — enciende/apaga la luz nocturna ahora.
export function setNightLightManual(on: boolean) {
  setNightLightActive(on); tocarLuzAMano(); saveDisplayConfig(); applyNight()
}

// Temperatura manual (slider). Aplica en vivo con debounce si el manual manda.
let tempDebounce: number | null = null
export function setManualTemp(t: number) {
  // Con la luz apagada solo se edita el valor para más tarde: no se enciende nada.
  setNightLightTemp(t); saveDisplayConfig()
  if (tempDebounce !== null) GLib.source_remove(tempDebounce)
  tempDebounce = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 120, () => { applyNight(); tempDebounce = null; return GLib.SOURCE_REMOVE })
}

// (2) Toggle de reglas — activa/desactiva la programación por horas. Al activar sin reglas
// se añade una franja por defecto (cálida de 22:00 a 07:00). Sin brillo: programarlo es
// opt-in, no algo que aparezca solo al encender el horario.
// Encender el horario aplica al momento el estado que establece para esta hora (como al
// iniciar sesión); apagarlo cierra las franjas en curso como si hubieran terminado.
export function setNightRulesEnabled(on: boolean) {
  setNightRulesEnabledState(on)
  if (on && nightRules.get().length === 0) {
    setNightRules([{ start: "22:00", end: "07:00", temp: 3500, brightness: null }])
  }
  if (!on) saldarHuerfanas(() => false)
  reaplicarHorario()
}

// Editar el horario se ve al momento: se reaplica el estado que establece para esta hora.
// Antes se cierran las franjas en curso que la edición deja sin fin (borradas, o que han
// dejado de programar ese canal; cambiar sus horas también cambia su clave).
export function setNightRulesAndSave(rules: NightRule[]) {
  setNightRules(rules)
  saldarHuerfanas((clave, canal) => rules.some(r => ruleKey(r) === clave && r[canal] != null))
  reaplicarHorario()
}

function reaplicarHorario() {
  revisado.temp = null; revisado.brightness = null
  saveDisplayConfig(); applyRules()
}

// ── Re-aplicación al arranque + arranque del scheduler ───────────────────────
let initialized = false
export function initDisplayService() {
  if (initialized) return
  initialized = true

  // Restaurar el estado guardado y reaplicar el que el horario establece para esta hora
  // (`revisado` empieza en null). El brillo guardado NO se restaura aquí —brightness.ts lee
  // el real del hardware—, salvo el tramo software (ver `repasarBrillo`).
  setNightLightActive(config.nightLightActive)
  setNightLightTemp(config.nightLightTemp)
  applyRules()
  brightness.subscribe(saveDisplayConfig)
  brightnessSupported.subscribe(() => { if (repasarBrillo()) saveDisplayConfig() })   // DDC: ~1 s tarde

  // Pausa por juego. NO se llama a `iniciarRegistroJuegos()` desde aquí a propósito:
  // initDisplayService corre al importar QuickSettings (t=0) y arrancar el registro ahí
  // metería en el pintado inicial el parseo de los ~161 .desktop del sistema, que es justo
  // lo que app.ts aparta a los 4 s (ver su comentario). Basta con suscribirse: el registro
  // lo arrancan initAutoDnd/initGamingState y su primera publicación llega aquí. El único
  // hueco es iniciar sesión con un juego YA abierto —imposible en la práctica— y se cierra
  // solo a los 4 s.
  hayJuegosAbiertos.subscribe(() => applyNight())
  pausaLuzNocturnaJuegos.subscribe(() => applyNight())
  // La mitad manual necesita otro disparador: una app de la lista que no sea un juego no
  // mueve `clientesJuego`. `revisionVentanas` sí (el registro lo emite en cada alta, baja,
  // fullscreen y cambio de foco, TAMBIÉN con el escáner apagado), pero por eso mismo es
  // ruidoso: con `follow_mouse = 1` salta cada vez que el puntero cruza de una ventana a
  // otra. Se reconcilia solo cuando el resultado CAMBIA — el resto de las veces es una
  // comparación de cadenas, o ni eso con la lista vacía.
  let ultimaAppQuePausa = false
  const revisarAppsQuePausan = () => {
    const hay = hayAppQuePausa()
    if (hay === ultimaAppQuePausa) return
    ultimaAppQuePausa = hay
    applyNight()
  }
  revisionVentanas.subscribe(revisarAppsQuePausan)
  // Editar la lista reconcilia siempre y refresca el espejo: el usuario acaba de tocar el
  // ajuste y espera verlo aplicado, así que aquí no se ahorra la llamada.
  pausaLuzNocturnaApps.subscribe(() => {
    ultimaAppQuePausa = hayAppQuePausa()
    applyNight()
  })

  // El tramo software se reconcilia como la temperatura, pero CON DEBOUNCE: arrastrar el
  // slider por la zona baja emite un cambio por píxel, y cada uno es un `hyprctl`.
  let gammaDebounce: number | null = null
  softwareDim.subscribe(() => {
    if (gammaDebounce !== null) GLib.source_remove(gammaDebounce)
    gammaDebounce = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 120, () => {
      applyNight(); gammaDebounce = null; return GLib.SOURCE_REMOVE
    })
  })

  // Re-aplicar preferencias por monitor (solo lo que difiera, para no pelear con
  // el comodín ni parpadear). Con gigishell/pantalla.lua leyendo display.json esto ya
  // no debería tener nada que hacer — se queda como red por si la spec `desc:` no
  // casa o el config no llegó a cargar ese módulo. idle_add = siguiente tick, sin
  // delay fijo.
  GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
    if (Object.keys(monitorPrefs).length > 0) {
      execAsync(["hyprctl", "monitors", "all", "-j"]).then(out => {
        let list: any[] = []
        try { list = JSON.parse(out) } catch { return }
        let backfilled = false
        for (const mon of list) {
          const pref = monitorPrefs[mon.description]
          if (!pref) continue
          // Las prefs guardadas antes de que se persistiera la posición no la traen,
          // y sin ella la spec saldría con "auto" (un layout multi-monitor se
          // recolocaría solo al recargar). La tomamos de la real.
          if (!pref.position) { pref.position = `${mon.x}x${mon.y}`; backfilled = true }
          if (!monitorNeedsUpdate(mon, pref)) continue
          execAsync(["hyprctl", "eval", `hl.monitor(${buildMonitorSpecLua({ name: mon.name, position: pref.position, pref })})`]).catch(() => {})
        }
        // Síncrono: el backfill es justo lo que gigishell/pantalla.lua necesita leer
        // en la próxima recarga, y esa recarga puede llegar antes que el debounce.
        if (backfilled) saveDisplayConfigNow()
      }).catch(() => {})
    }
    return GLib.SOURCE_REMOVE
  })

  // Globales
  const g = config.global
  if (g.vrrMode !== 0) execAsync(["hyprctl", "eval", `hl.config({ misc = { vrr = ${g.vrrMode} } })`]).catch(() => {})
  if (g.allowTearing) execAsync(["hyprctl", "eval", "hl.config({ general = { allow_tearing = true } })"]).catch(() => {})

  // Repaso cada 60 s: aplica los disparos del horario que hayan llegado (temp y brillo)
  GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 60, () => { applyRules(); return GLib.SOURCE_CONTINUE })

  // Capacidades de hardware (para ocultar ajustes no soportados por monitor)
  detectCaps()
}
