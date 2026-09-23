// modulos/ajustes/seguridad/preferencias.ts
//
// Preferencias de la sección "Protección" del panel de ajustes general
// (modulos/ajustes/SettingsPanel.tsx). Cada clave activa/desactiva un tipo de evento que
// vigila hypr/scripts/oom-monitor.sh.
//
// IMPORTANTE: el script bash lee este archivo UNA sola vez al arrancar (nada de
// polling), igual que batteryMonitor/tempMonitor en preferences.ts. Por eso un
// cambio aquí solo surte efecto reiniciando el sistema (o relanzando el script);
// la UI lo avisa de forma destacada.
//
// Se persiste en su PROPIO archivo ~/.config/gigios/security.json para no
// mezclarlo con las preferencias de personalización (preferences.json).

import GLib from "gi://GLib"
import { createState } from "ags"
import textos from "../../../textos/ajustes/seguridad.json" with { type: "json" }

const SEC_PATH = `${GLib.get_user_config_dir()}/gigios/security.json`

export type SecurityKey =
  | "oomKiller" | "kernelPanic" | "hungTask" | "hwErrors" | "kernelModules"
  | "cpuThrottling" | "diskError" | "diskHealth" | "gpuError"
  | "serviceFailure" | "serviceHealth" | "sudoAuth" | "privEsc" | "ssh"
  | "appCrash" | "fileIntegrity" | "downloadScan" | "sandboxLaunch"

// Orden + metadatos de UI. El orden aquí es el orden en el que se pintan las
// filas. Todos por defecto ON = comportamiento actual del monitor.
const eventos = textos.eventos
export const SECURITY_ITEMS: { key: SecurityKey; label: string; hint: string }[] = [
  { key: "oomKiller",      label: eventos.memoriaAgotada.titulo,       hint: eventos.memoriaAgotada.descripcion },
  { key: "kernelPanic",    label: eventos.panicoKernel.titulo,         hint: eventos.panicoKernel.descripcion },
  { key: "hungTask",       label: eventos.procesosColgados.titulo,     hint: eventos.procesosColgados.descripcion },
  { key: "hwErrors",       label: eventos.erroresHardware.titulo,      hint: eventos.erroresHardware.descripcion },
  { key: "kernelModules",  label: eventos.modulosKernel.titulo,        hint: eventos.modulosKernel.descripcion },
  { key: "cpuThrottling",  label: eventos.limitacionCpu.titulo,        hint: eventos.limitacionCpu.descripcion },
  { key: "diskError",      label: eventos.erroresDisco.titulo,         hint: eventos.erroresDisco.descripcion },
  { key: "diskHealth",     label: eventos.saludDisco.titulo,           hint: eventos.saludDisco.descripcion },
  { key: "gpuError",       label: eventos.erroresGpu.titulo,           hint: eventos.erroresGpu.descripcion },
  { key: "serviceFailure", label: eventos.serviciosFallidos.titulo,    hint: eventos.serviciosFallidos.descripcion },
  { key: "serviceHealth",  label: eventos.saludServicios.titulo,       hint: eventos.saludServicios.descripcion },
  { key: "sudoAuth",       label: eventos.fallosSudo.titulo,           hint: eventos.fallosSudo.descripcion },
  { key: "privEsc",        label: eventos.escaladaPrivilegios.titulo,  hint: eventos.escaladaPrivilegios.descripcion },
  { key: "ssh",            label: eventos.sesionesSsh.titulo,          hint: eventos.sesionesSsh.descripcion },
  { key: "appCrash",       label: eventos.fallosAplicaciones.titulo,   hint: eventos.fallosAplicaciones.descripcion },
  { key: "fileIntegrity",  label: eventos.integridadArchivos.titulo,   hint: eventos.integridadArchivos.descripcion },
  { key: "downloadScan",   label: eventos.escaneoDescargas.titulo,     hint: eventos.escaneoDescargas.descripcion },
  { key: "sandboxLaunch",  label: eventos.lanzadorAislado.titulo,      hint: eventos.lanzadorAislado.descripcion },
]

const KEYS: SecurityKey[] = SECURITY_ITEMS.map((i) => i.key)

// Estado reactivo por clave (default = true = todo activado).
const states = {} as Record<SecurityKey, ReturnType<typeof createState<boolean>>>
for (const k of KEYS) states[k] = createState(true)

// ── Escáner de descargas: recursos y pausas ─────────────────────────────────
// Prefs heterogéneas (3 pausas + un número de GB) que se pintan en su PROPIA
// pestaña Descargas de SecuritySection, no en la lista de eventos de arriba. A
// DIFERENCIA de los toggles de eventos, hypr/scripts/oom-monitor.sh relee estas
// EN CADA BARRIDO (no solo al arrancar): cambiarlas surte efecto sin reiniciar.
export type DlPauseKey = "dlPauseInPowerSave" | "dlPauseOnBattery" | "dlPauseWhileGaming"

const pausasDescargas = textos.recursosDescargas.pausas
export const DL_PAUSE_ITEMS: { key: DlPauseKey; label: string; hint: string }[] = [
  { key: "dlPauseInPowerSave", label: pausasDescargas.modoAhorro.titulo,    hint: pausasDescargas.modoAhorro.descripcion },
  { key: "dlPauseOnBattery",   label: pausasDescargas.conBateria.titulo,    hint: pausasDescargas.conBateria.descripcion },
  { key: "dlPauseWhileGaming", label: pausasDescargas.mientrasJuego.titulo, hint: pausasDescargas.mientrasJuego.descripcion },
]
const DL_PAUSE_KEYS = DL_PAUSE_ITEMS.map((i) => i.key)

// Defaults POR CLAVE, no uno común, porque no significan lo mismo.
//
// `dlPauseWhileGaming` viene ACTIVADA: es la mitad más cara del "modo juego"
// (clamscan recarga ~200 MB de firmas POR invocación, y el barrido además hashea),
// justo el pico de E/S y CPU que arruina una partida. Lo aplazado no se pierde: el
// barrido se reanuda al cerrar el juego. Va en la misma dirección que el gate
// compartido de hypr/scripts/lib/gaming-gate.sh, que congela el resto del sondeo
// prescindible — sin él, activar la congelación dejaba fuera precisamente al
// consumidor más caro de todos.
//
// Las otras dos siguen en false: pausar por batería o por ahorro sacrifica
// seguridad por autonomía, y esa es una decisión que debe tomar el usuario.
// Tope de tamaño en GB (default 1 GB).
const DL_PAUSE_DEFAULTS: Record<DlPauseKey, boolean> = {
  dlPauseInPowerSave: false,
  dlPauseOnBattery: false,
  dlPauseWhileGaming: true,
}
const dlPauseStates = {} as Record<DlPauseKey, ReturnType<typeof createState<boolean>>>
for (const k of DL_PAUSE_KEYS) dlPauseStates[k] = createState(DL_PAUSE_DEFAULTS[k])

// ── Firmas de ClamAV: actualizar al iniciar sesión ──────────────────────────
// UN BOOLEANO, y **ningún temporizador**. Antes esta fila encendía y apagaba
// `clamav-freshclam.service`: el estado vivía en systemd y la actualización ocurría POR
// PERIODO, corriera o no falta, también con el equipo sin hacer nada. Ahora el estado es
// del usuario y vive aquí, y quien actualiza es `hypr/scripts/actualizar-firmas.sh --auto`
// **una sola vez, al arrancar Hyprland** (`gigios/autostart.lua`), y solo si la base falta
// o pasa de un día. Durante la sesión no hay reloj, ni servicio, ni reintentos por barrido:
// si un análisis se queda sin motor, los escáneres ofrecen un botón y decide el usuario.
// En el arranque no se notifica nada — el interruptor promete que se hace solo.
//
// Lo lee desde bash `lib/firmas.sh` con jq, comprobando `has()` en vez de `//` — ver el
// comentario de `dlPauseWhileGaming`, mismo tropiezo. Por defecto ACTIVADO: sin base de
// firmas el escáner de descargas no da NADA por analizado, así que el fallo seguro es
// actualizar.
const CLAMAV_AUTO_DEFAULT = true
const [clamavAutoUpdateState, _setClamavAutoUpdatePref] = createState(CLAMAV_AUTO_DEFAULT)
/** Estado reactivo de "actualizar las firmas de ClamAV al iniciar sesión" (para binds en JSX). */
export const clamavAutoUpdatePref = clamavAutoUpdateState

const DL_MAX_GB_DEFAULT = 1
const [dlMaxScanGBState, _setDlMaxScanGB] = createState(DL_MAX_GB_DEFAULT)
/** Estado reactivo del tope de tamaño en GB (para binds en JSX). */
export const dlMaxScanGB = dlMaxScanGBState

// ── Carga inicial ─────────────────────────────────────────────────────────────
function load() {
  try {
    const [ok, content] = GLib.file_get_contents(SEC_PATH)
    if (!ok) return
    const saved = JSON.parse(new TextDecoder().decode(content))
    for (const k of KEYS) {
      if (typeof saved[k] === "boolean") states[k][1](saved[k])
    }
    for (const k of DL_PAUSE_KEYS) {
      if (typeof saved[k] === "boolean") dlPauseStates[k][1](saved[k])
    }
    if (typeof saved.dlMaxScanGB === "number" && saved.dlMaxScanGB > 0) _setDlMaxScanGB(saved.dlMaxScanGB)
    if (typeof saved.clamavAutoUpdate === "boolean") _setClamavAutoUpdatePref(saved.clamavAutoUpdate)
  } catch (_) { /* ausente o corrupto → nos quedamos con los defaults (todo ON) */ }
}

// ── Persistencia ──────────────────────────────────────────────────────────────
function save() {
  try {
    const dir = GLib.path_get_dirname(SEC_PATH)
    if (!GLib.file_test(dir, GLib.FileTest.EXISTS)) GLib.mkdir_with_parents(dir, 0o755)
    const config: Record<string, boolean | number> = {}
    for (const k of KEYS) config[k] = states[k][0].get()
    for (const k of DL_PAUSE_KEYS) config[k] = dlPauseStates[k][0].get()
    config.dlMaxScanGB = dlMaxScanGBState.get()
    config.clamavAutoUpdate = clamavAutoUpdateState.get()
    GLib.file_set_contents(SEC_PATH, JSON.stringify(config, null, 2))
  } catch (_) { /* un fallo de escritura no debe romper la UI */ }
}

// ── API pública ───────────────────────────────────────────────────────────────
/** Estado reactivo de una categoría (para binds en JSX). */
export function securityEnabled(k: SecurityKey) {
  return states[k][0]
}
/** Muta el estado de una categoría y persiste. */
export function setSecurityEnabled(k: SecurityKey, on: boolean) {
  states[k][1](on)
  save()
}

// ── API de pausas / tope del escáner de descargas ──────────────────────────
/** Estado reactivo de una pausa (para binds en JSX). */
export function dlPauseEnabled(k: DlPauseKey) {
  return dlPauseStates[k][0]
}
/** Muta una pausa y persiste. */
export function setDlPauseEnabled(k: DlPauseKey, on: boolean) {
  dlPauseStates[k][1](on)
  save()
}
/**
 * Enciende o apaga "actualizar las firmas al iniciar sesión" y persiste. Solo escribe el
 * booleano: lo lee el script del autostart en el PRÓXIMO arranque, así que aquí no se lanza nada
 * ni se programa nada. Quien quiera actualizar AHORA usa el botón de la tarjeta (servicios/
 * seguridad/clamav.ts → `updateClamavDb`).
 */
export function setClamavAutoUpdatePref(on: boolean) {
  _setClamavAutoUpdatePref(on)
  save()
}

/** Fija el tope de tamaño en GB (>0) y persiste; ignora valores inválidos. */
export function setDlMaxScanGB(v: number) {
  const n = Number.isFinite(v) && v > 0 ? v : DL_MAX_GB_DEFAULT
  _setDlMaxScanGB(n)
  save()
}

load()
