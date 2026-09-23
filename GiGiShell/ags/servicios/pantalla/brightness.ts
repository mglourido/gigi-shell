import { createState } from "ags"
import { execAsync } from "ags/process"
import GLib from "gi://GLib"
import Gio from "gi://Gio"
import GUdev from "gi://GUdev"
import { brightnessOsdEnabled } from "../../modulos/ajustes/preferences"
import { repartirBrillo, componerBrillo } from "./atenuacion"

// ─────────────────────────────────────────────────────────────────────────────
// Brillo: DOS hardwares distintos, no uno con dos rutas.
//
//  • `backlight` (portátil): la GPU maneja la retroiluminación del panel interno y el
//    kernel la publica en `/sys/class/backlight` → `brightnessctl`. Barato, y udev nos
//    avisa de los cambios los haga quien los haga.
//  • `ddc` (sobremesa): un monitor externo NO aparece en esa clase. Su brillo vive en el
//    firmware del monitor y solo se toca por DDC/CI, o sea I2C sobre el propio cable de
//    vídeo → `ddcutil`. Caro (~0,3 s por escritura, medido) y mudo: no hay evento de
//    vuelta, pero tampoco hace falta porque el único que escribe aquí somos nosotros.
//  • `none`: ni una cosa ni la otra (monitor sin DDC/CI, `ddcutil` ausente, módulo
//    `i2c-dev` sin cargar) → la UI oculta el slider en vez de fingir que funciona.
//
// Requisitos del camino DDC (ver `system/modules-load.d/i2c-dev.conf` y el CLAUDE.md raíz):
// el módulo `i2c-dev` cargado y los nodos `/dev/i2c-*` accesibles — de eso último ya se
// encarga la regla udev que trae el propio ddcutil (`TAG+="uaccess"`), sin tocar grupos.
// ─────────────────────────────────────────────────────────────────────────────

export type BrightnessBackend = "backlight" | "ddc" | "none"

export const [brightness, setBrightness] = createState(0.5)
/** Falso mientras no haya un backend confirmado. El sondeo DDC es asíncrono (~1 s), así
 *  que esto pasa a cierto *después* de arrancar: por eso es estado reactivo y no una
 *  constante — los sliders se enganchan a él con `visible={brightnessSupported}`. */
export const [brightnessSupported, setBrightnessSupported] = createState(false)

/** Factor de gamma pedido por el tramo software del slider (1 = sin atenuar). Publicado
 *  aquí pero APLICADO en `service.ts`, que es el único dueño del proceso `hyprsunset`:
 *  la luz nocturna y esto comparten la misma CTM, y dos escritores del mismo proceso se
 *  pisarían. `service.ts` se suscribe y reconcilia temperatura + gamma de una vez. */
export const [softwareDim, setSoftwareDim] = createState(1)

let _backend: BrightnessBackend = "none"
export function brightnessBackend(): BrightnessBackend { return _backend }

// ── Backend 1: panel interno ────────────────────────────────────────────────

function detectBacklight(): string | null {
  try {
    const iter = Gio.File.new_for_path("/sys/class/backlight")
      .enumerate_children("standard::name", Gio.FileQueryInfoFlags.NONE, null)
    const names: string[] = []
    for (let info = iter.next_file(null); info !== null; info = iter.next_file(null)) {
      names.push(info.get_name())
    }
    iter.close(null)
    if (!names.length) return null
    const dev = names.includes("intel_backlight") ? "intel_backlight" : names.sort()[0]
    return `/sys/class/backlight/${dev}`
  } catch {
    return null
  }
}

const BACKLIGHT_PATH = detectBacklight()

/** Adopta una lectura del HARDWARE como valor del slider, o `null` si adoptarla mentiría.
 *  El hardware solo conoce su propio tramo: en la zona software está clavado en 0 porque
 *  lo pusimos nosotros, así que componer ese 0 devolvería el slider al suelo y desharía la
 *  atenuación en cada evento de udev. Un 0 con atenuación activa no es información nueva. */
function adoptarLecturaHardware(hw: number): number | null {
  if (hw <= 0 && softwareDim.get() < 1) return null
  return componerBrillo(hw)
}

function readBacklightRatio(): number | null {
  if (!BACKLIGHT_PATH) return null
  try {
    const [brightnessOk, brightnessBytes] = GLib.file_get_contents(`${BACKLIGHT_PATH}/brightness`)
    const [maxOk, maxBytes] = GLib.file_get_contents(`${BACKLIGHT_PATH}/max_brightness`)
    if (!brightnessOk || !maxOk) return null
    const current = Number(new TextDecoder().decode(brightnessBytes).trim())
    const maximum = Number(new TextDecoder().decode(maxBytes).trim())
    if (!Number.isFinite(current) || !Number.isFinite(maximum) || maximum <= 0) return null
    return Math.max(0, Math.min(1, current / maximum))
  } catch {
    return null
  }
}

// Watcher udev (event-driven, cero polling): mantiene `brightness` al día aunque el cambio
// venga de fuera del shell (teclas del portátil, otra herramienta).
function watchBacklight() {
  try {
    const client = new GUdev.Client({ subsystems: ["backlight"] })
    const dev = client.query_by_sysfs_path(BACKLIGHT_PATH!)
    const max = Number(dev?.get_sysfs_attr_as_int("max_brightness") ?? 0)
    if (!dev || !(max > 0)) return

    const read = (d: GUdev.Device) => {
      const raw = Number(d.get_sysfs_attr_as_int_uncached("brightness"))
      if (!Number.isFinite(raw)) return null
      return Math.max(0, Math.min(1, raw / max))
    }

    const initial = read(dev)
    if (initial !== null) {
      const v = adoptarLecturaHardware(initial)
      if (v !== null) setBrightness(v)
    }

    client.connect("uevent", (_c: GUdev.Client, action: string, device: GUdev.Device) => {
      if (action !== "change") return
      const raw = read(device)
      if (raw === null) return
      const value = adoptarLecturaHardware(raw)
      if (value !== null) setBrightness(value)
    })
  } catch (e) {
    console.error("[brightness] udev watcher:", e)
  }
}

// ── Backend 2: DDC/CI ───────────────────────────────────────────────────────

const DDC_BRIGHTNESS_VCP = "10" // código VCP estándar del brillo
const DDC_TIMEOUT_S = 10        // un bus I2C mudo puede colgar a ddcutil: nunca sin techo

let _ddcBus: number | null = null
let _ddcMax = 100

/** Sondea DDC/CI. Sale en silencio ante cualquier fallo (sin ddcutil, sin i2c-dev, monitor
 *  sin DDC/CI, monitor dormido): el resultado es simplemente `none` y el slider no aparece. */
async function detectDdc(): Promise<void> {
  try {
    const detected = await execAsync([
      "bash", "-c", `timeout ${DDC_TIMEOUT_S} ddcutil detect --terse 2>/dev/null`,
    ])
    // Primer display detectado. Limitación conocida: con varios monitores DDC solo se
    // controla este (el slider es uno solo, como en el camino backlight).
    const bus = detected.match(/\/dev\/i2c-(\d+)/)
    if (!bus) return

    // No basta con que el monitor conteste: hay que confirmar que soporta el VCP 10.
    // `getvcp --terse` da una línea: "VCP 10 C <actual> <max>".
    const probe = await execAsync([
      "bash", "-c",
      `timeout ${DDC_TIMEOUT_S} ddcutil --bus ${bus[1]} getvcp ${DDC_BRIGHTNESS_VCP} --terse 2>/dev/null`,
    ])
    const f = probe.trim().split(/\s+/)
    if (f[0] !== "VCP" || f[1] !== DDC_BRIGHTNESS_VCP) return
    const current = Number(f[3])
    const max = Number(f[4])
    if (!Number.isFinite(current) || !Number.isFinite(max) || max <= 0) return

    _ddcBus = Number(bus[1])
    _ddcMax = max
    _backend = "ddc"
    setBrightness(componerBrillo(current / max))
    setBrightnessSupported(true)
  } catch {
    // sin backend DDC
  }
}

// Escribir por DDC cuesta ~0,3 s, así que un arrastre del slider genera muchas más
// peticiones de las que el bus puede tragar. Se COALESCEN: una escritura en vuelo como
// mucho, y al terminar se lanza el último valor pendiente (si cambió). El resultado es
// ~3 actualizaciones/s durante el arrastre y, siempre, el valor final exacto al soltar.
let _ddcInFlight = false
let _ddcPending: number | null = null

function ddcWrite(pct: number) {
  if (_ddcBus === null) return
  if (_ddcInFlight) {
    _ddcPending = pct
    return
  }
  _ddcInFlight = true
  const raw = Math.round((pct / 100) * _ddcMax)
  execAsync([
    "bash", "-c",
    `timeout ${DDC_TIMEOUT_S} ddcutil --bus ${_ddcBus} --noverify setvcp ${DDC_BRIGHTNESS_VCP} ${raw}`,
  ])
    .catch(() => {}) // monitor dormido / bus ocupado: el siguiente intento lo arregla
    .then(() => {
      _ddcInFlight = false
      const next = _ddcPending
      _ddcPending = null
      if (next !== null && next !== pct) ddcWrite(next)
    })
}

// ── API pública ─────────────────────────────────────────────────────────────

/** Fija el brillo (0..1): actualiza el estado y lo reparte entre los dos canales.
 *
 *  El valor que llega aquí es el COMPUESTO — lo que ve el usuario en el slider y en el OSD.
 *  `repartirBrillo` lo parte en hardware + gamma: por encima del suelo del monitor manda el
 *  hardware y el gamma queda intacto; por debajo, el hardware se queda en su mínimo y sigue
 *  oscureciendo el gamma. Ver `atenuacion.ts` para el porqué del reparto. */
export function applyBrightness(ratio: number) {
  const value = Math.max(0, Math.min(1, ratio))
  setBrightness(value)
  const { hardware, gamma } = repartirBrillo(value)
  const pct = Math.round(hardware * 100)

  if (_backend === "backlight") {
    // `-c backlight` no es decorativo: sin dispositivos de esa clase, brightnessctl no
    // falla — cae al primer dispositivo `leds` y enciende el LED de scroll-lock.
    execAsync(["bash", "-c", `brightnessctl -c backlight -n2 s ${pct}%`]).catch(() => {})
  } else if (_backend === "ddc") {
    ddcWrite(pct)
  }
  // Fuera del `if`: el gamma es independiente del backend de hardware (lo aplica la CTM,
  // no el panel), así que vale igual para `backlight` y para `ddc`. `service.ts` reconcilia.
  setSoftwareDim(gamma)
}

/** Sube/baja el brillo un salto y enseña el OSD. Lo llaman las teclas XF86MonBrightness*
 *  vía `ags request` — pasar por aquí es lo que hace que funcionen con los dos backends. */
export function stepBrightness(delta: number) {
  if (_backend === "none") return
  applyBrightness(brightness.get() + delta)
  // `releerHardware: false` NO es una optimización, es lo que hace que las teclas funcionen.
  // `applyBrightness` acaba de fijar el valor nuevo y ha lanzado `brightnessctl` de forma
  // ASÍNCRONA: en este instante sysfs todavía tiene el valor VIEJO. Releerlo aquí adoptaba
  // ese valor viejo como estado del shell —deshaciendo el salto que acabábamos de dar— y el
  // OSD salía con la cifra anterior. Peor: la siguiente pulsación partía de ese valor rancio
  // si udev aún no había hecho eco, así que restaba el mismo salto otra vez y la pantalla no
  // se movía. De ahí el «a veces cambia y a veces no» y el 100% clavado en la UI mientras el
  // panel sí bajaba. Del cambio real ya nos avisa el watcher de udev cuando ocurre de verdad.
  showBrightnessOSD(false, false)
}

// ── OSD ─────────────────────────────────────────────────────────────────────

export const [brightnessOsdVisible, setBrightnessOsdVisible] = createState(false)
let _osdTimer: number | null = null

function hideBrightnessOSD() {
  setBrightnessOsdVisible(false)
  if (_osdTimer) clearTimeout(_osdTimer)
  _osdTimer = null
}

/** Enseña el OSD del brillo.
 *  `releerHardware` solo tiene sentido cuando el OSD lo pide alguien que NO acaba de
 *  escribir el brillo (`ags request brightness-osd`, el resumen del arranque): ahí sysfs es
 *  la única fuente fiable. Quien acaba de llamar a `applyBrightness` debe pasarlo en falso
 *  — ver `stepBrightness`. */
export function showBrightnessOSD(startup = false, releerHardware = true) {
  if (_backend === "none") {
    hideBrightnessOSD()
    return
  }
  // El resumen del arranque existe para delatar un panel de portátil que quedó atenuado.
  // Por DDC no aplica: el valor lo acabamos de leer del monitor y además la detección es
  // asíncrona, así que saldría un OSD tardío y sin motivo.
  if (startup && _backend === "ddc") {
    hideBrightnessOSD()
    return
  }
  if (releerHardware && _backend === "backlight") {
    // Cambio hecho fuera del shell: sysfs manda y udev puede tardar en avisar.
    const current = readBacklightRatio()
    if (current !== null) {
      const v = adoptarLecturaHardware(current)   // sysfs solo conoce el tramo hardware
      if (v !== null) setBrightness(v)
    }
  }
  const value = brightness.get()
  if (!brightnessOsdEnabled.get() || !Number.isFinite(value) || (startup && value >= 0.999)) {
    hideBrightnessOSD()
    return
  }
  setBrightnessOsdVisible(true)
  if (_osdTimer) clearTimeout(_osdTimer)
  _osdTimer = setTimeout(() => {
    setBrightnessOsdVisible(false)
    _osdTimer = null
  }, 2000)
}

brightnessOsdEnabled.subscribe(() => {
  if (!brightnessOsdEnabled.get()) hideBrightnessOSD()
})

// ── Arranque ────────────────────────────────────────────────────────────────

if (BACKLIGHT_PATH) {
  _backend = "backlight"
  setBrightnessSupported(true)
  watchBacklight()
} else {
  void detectDdc() // asíncrono: no bloquea el arranque del shell
}
