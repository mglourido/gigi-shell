// Franja fija de métricas (CPU / iGPU / RAM / GPU·NVIDIA) al pie de la
// sección Inicio de Orion. Vive en su propio archivo porque el sondeo y el
// widget no comparten nada con la rejilla de apps favoritas de `favoritosFlow.tsx`
// más allá de montarse en la misma sección — ver `../HomeSection.tsx`.

import { Gtk } from "ags/gtk4"
import { execAsync } from "ags/process"
import { readFile } from "ags/file"
import { createState, type Accessor } from "ags"
import GLib from "gi://GLib"
import GObject from "gi://GObject"
import Pango from "gi://Pango"
import { orionVisible, activeSection } from "../../../state"

// ── State ─────────────────────────────────────────────────────────────────────

const [cpuPct,     setCpuPct]     = createState(0)
const [ramUsed,    setRamUsed]    = createState("0.0")
const [ramPct,     setRamPct]     = createState(0)
// iGPU Intel
const [iGpu,       setIGpu]       = createState({ pct: 0, freq: 0, max: 1300 })
// NVIDIA dGPU (only shown when PRIME active)
const [nGpuActive, setNGpuActive] = createState(false)
const [nGpuPct,    setNGpuPct]    = createState(0)
const [nVramUsed,  setNVramUsed]  = createState("0M")
const [nVramPct,   setNVramPct]   = createState(0)

export const ALTURA_FRANJA_SISTEMA = 58

// ── CPU (delta) ───────────────────────────────────────────────────────────────

let prevIdle  = 0
let prevTotal = 0

function updateCpu() {
  try {
    const parts = readFile("/proc/stat").split("\n")[0].trim().split(/\s+/).slice(1).map(Number)
    const idle  = parts[3]
    const total = parts.reduce((a, b) => a + b, 0)
    if (prevTotal > 0) {
      const dIdle  = idle  - prevIdle
      const dTotal = total - prevTotal
      if (dTotal > 0) setCpuPct(Math.round(100 - (dIdle / dTotal) * 100))
    }
    prevIdle  = idle
    prevTotal = total
  } catch (_) {}
}

// ── RAM ───────────────────────────────────────────────────────────────────────

function updateRam() {
  try {
    const lines = readFile("/proc/meminfo").split("\n")
    const get = (k: string) => parseInt(lines.find(l => l.startsWith(k))?.split(/\s+/)[1] ?? "0")
    const total = get("MemTotal:")
    const free  = get("MemFree:")
    const bufs  = get("Buffers:")
    const cache = get("Cached:")
    const used  = total - free - bufs - cache
    setRamUsed((used / 1024 / 1024).toFixed(1))
    setRamPct(Math.round((used / total) * 100))
  } catch (_) {}
}

// ── iGPU Intel via RC6 residency delta ───────────────────────────────────────
// RC6 is a sleep state: the more time in RC6 → more idle
// delta_rc6_ms / 1000ms = fraction of time idle → GPU usage = 100 - that

const IGPU_CARD = "/sys/class/drm/card2"
let prevRc6 = -1

function updateIGpu() {
  try {
    const curFreq  = parseInt(readFile(`${IGPU_CARD}/gt_cur_freq_mhz`).trim())
    const maxFreq  = parseInt(readFile(`${IGPU_CARD}/gt_max_freq_mhz`).trim())
    const rc6Ms    = parseInt(readFile(`${IGPU_CARD}/gt/gt0/rc6_residency_ms`).trim())

    let pct = 0
    if (prevRc6 >= 0) {
      const deltaRc6 = rc6Ms - prevRc6
      pct = Math.max(0, Math.min(100, Math.round(100 - (deltaRc6 / 10))))
    }
    prevRc6 = rc6Ms

    setIGpu({ pct, freq: curFreq, max: maxFreq })
  } catch (_) {}
}

// ── NVIDIA dGPU (PRIME) ───────────────────────────────────────────────────────

async function updateNvidia() {
  try {
    const out = await execAsync([
      "bash", "-c",
      "/usr/bin/nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits",
    ])
    const [gpu, vramMb, vramTotal] = out.trim().split(", ").map(s => parseFloat(s.trim()))
    const active = gpu > 0 || vramMb > 100
    setNGpuActive(active)
    setNGpuPct(Math.round(gpu))
    setNVramUsed(vramMb >= 1024 ? `${(vramMb / 1024).toFixed(1)}G` : `${Math.round(vramMb)}M`)
    setNVramPct(Math.round((vramMb / vramTotal) * 100))
  } catch (_) {
    setNGpuActive(false)
  }
}

// ── Polling ───────────────────────────────────────────────────────────────────
// Las stats (CPU/RAM/GPU) sólo se ven en la sección de inicio de Jarvis. Para no
// consumir en reposo, el poll sólo corre mientras Orion está visible Y en
// "inicio"; se para al cerrar o al cambiar de sección. En reposo el consumo es
// cero.

let _pollSource: number | null = null

// CPU/RAM/iGPU son lecturas de sysfs (micras); nvidia-smi es un spawn de
// proceso real (~lo más caro de este módulo con diferencia). Van a tics
// distintos: CPU/RAM/iGPU cada 1000ms para que la franja se sienta fluida,
// nvidia-smi cada 2000ms (mitad de spawns) porque un uso de dGPU no cambia
// tan rápido como para necesitar la misma cadencia.
let _nvidiaTick = false

function tick() {
  updateCpu()
  updateRam()
  updateIGpu()
  _nvidiaTick = !_nvidiaTick
  if (_nvidiaTick) updateNvidia()
}

function pollShouldRun(): boolean {
  return orionVisible.get() && activeSection.get() === "inicio"
}

function startPolling() {
  if (_pollSource !== null) return
  // Resetea los acumuladores delta para que el primer tick tras reabrir no
  // muestre un pico falso calculado sobre todo el tiempo que estuvo cerrado.
  prevTotal = 0
  prevIdle = 0
  prevRc6 = -1
  _nvidiaTick = false  // el tick inmediato de abajo lo pone a true → nvidia-smi también refresca al abrir
  tick()  // refresco inmediato para no mostrar datos rancios al abrir
  _pollSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT_IDLE, 1000, () => {
    tick()
    return GLib.SOURCE_CONTINUE
  })
}

function stopPolling() {
  if (_pollSource !== null) {
    GLib.source_remove(_pollSource)
    _pollSource = null
  }
}

function syncPolling() {
  if (pollShouldRun()) startPolling()
  else stopPolling()
}

orionVisible.subscribe(syncPolling)
activeSection.subscribe(syncPolling)

// Pie de métricas fijo: Orion lo monta fuera del viewport desplazable y sólo
// aparece en Inicio, donde también vive el polling que alimenta estos datos.
interface TarjetaMetricaProps {
  titulo: string
  valor: Accessor<string>
  progreso: Accessor<number>
  color: string
  visible?: Accessor<boolean>
}

const ANCHO_TARJETA_METRICA = 120
const ContenedorTarjetaMetrica = GObject.registerClass(
  class ContenedorTarjetaMetrica extends Gtk.Widget {
    private contenido: Gtk.Widget | null = null

    establecerContenido(contenido: Gtk.Widget) {
      this.contenido?.unparent()
      this.contenido = contenido
      contenido.set_parent(this)
    }

    vfunc_measure(orientation: Gtk.Orientation, _forSize: number) {
      if (orientation === Gtk.Orientation.HORIZONTAL) {
        return [ANCHO_TARJETA_METRICA, ANCHO_TARJETA_METRICA, -1, -1]
      }
      return this.contenido?.measure(Gtk.Orientation.VERTICAL, -1) ?? [0, 0, -1, -1]
    }

    vfunc_size_allocate(width: number, height: number, baseline: number) {
      this.contenido?.allocate(width, height, baseline, null)
    }

    vfunc_dispose() {
      this.contenido?.unparent()
      this.contenido = null
      super.vfunc_dispose()
    }
  },
)

function TarjetaMetrica({ titulo, valor, progreso, color, visible }: TarjetaMetricaProps) {
  const contenido = (
    <box
      cssClasses={["sys-card"]}
      orientation={Gtk.Orientation.VERTICAL}
      hexpand
    >
      <label label={titulo} cssClasses={["sys-label"]} halign={Gtk.Align.START} />
      <label
        cssClasses={["sys-val"]}
        halign={Gtk.Align.START}
        maxWidthChars={8}
        ellipsize={Pango.EllipsizeMode.END}
        label={valor}
      />
      <box cssClasses={["sys-bar"]}>
        <box
          cssClasses={["sys-fill", color]}
          hexpand
          css={progreso(valorActual => {
            const fraccion = Math.max(0, Math.min(1, valorActual))
            return `.sys-fill { transform-origin: left center; transform: scaleX(${fraccion}); }`
          })}
        />
      </box>
    </box>
  ) as unknown as Gtk.Widget

  const limite = new ContenedorTarjetaMetrica({ hexpand: true })
  limite.establecerContenido(contenido)
  if (visible) {
    const sincronizarVisibilidad = () => { limite.visible = visible.get() }
    sincronizarVisibilidad()
    visible.subscribe(sincronizarVisibilidad)
  }
  return limite
}

export function SystemStats() {
  const grid = new Gtk.Grid({
    columnHomogeneous: true,
    columnSpacing: 5,
    hexpand: true,
  })
  grid.attach(TarjetaMetrica({
    titulo: "CPU",
    valor: cpuPct(valor => `${valor}%`),
    progreso: cpuPct(valor => valor / 100),
    color: "sf-blue",
  }), 0, 0, 1, 1)
  grid.attach(TarjetaMetrica({
    titulo: "iGPU",
    valor: iGpu(valor => `${valor.pct}%·${valor.freq}M`),
    progreso: iGpu(valor => valor.pct / 100),
    color: "sf-pink",
  }), 1, 0, 1, 1)
  grid.attach(TarjetaMetrica({
    titulo: "RAM",
    valor: ramUsed(valor => `${valor}G`),
    progreso: ramPct(valor => valor / 100),
    color: "sf-teal",
  }), 2, 0, 1, 1)
  grid.attach(TarjetaMetrica({
    titulo: "GPU·NV",
    valor: nGpuPct(valor => `${valor}%`),
    progreso: nGpuPct(valor => valor / 100),
    color: "sf-pink",
    visible: nGpuActive(valor => valor),
  }), 3, 0, 1, 1)
  grid.attach(TarjetaMetrica({
    titulo: "VRAM·NV",
    valor: nVramUsed(valor => valor),
    progreso: nVramPct(valor => valor / 100),
    color: "sf-amber",
    visible: nGpuActive(valor => valor),
  }), 4, 0, 1, 1)

  return (
    <box
      cssClasses={["sys-strip", "sys-strip-fixed"]}
      hexpand
      heightRequest={ALTURA_FRANJA_SISTEMA}
      visible={activeSection(section => section === "inicio")}
    >
      {grid as unknown as any}
    </box>
  )
}
