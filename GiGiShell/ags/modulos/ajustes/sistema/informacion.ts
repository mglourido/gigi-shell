// Recolección de la información del equipo para Ajustes > Sistema.
//
// Está partida en dos mitades a propósito, y esa partición es lo que hace que
// el panel se pinte al instante:
//
//   - `leerSincrono()` no lanza NI UN proceso: todo sale de /proc, /sys y las
//     variables del entorno, así que cuesta ~1 ms y puede correr durante el
//     propio render. Es la mayor parte de lo que se enseña.
//   - `sondear()` es lo que obliga a forkear (lspci, glxinfo, vulkaninfo,
//     hyprctl…). Su resultado se **cachea en disco**, de modo que al abrir la
//     sección se dibuja el sondeo anterior de inmediato y el nuevo se aplica
//     por detrás cuando llega.
//
// El sondeo es un `Record<string, string>` plano y no un objeto con forma fija
// justo para que la caché sobreviva a que se añadan o quiten claves: una clave
// ausente se lee como "" y `add()` la descarta, en vez de romper el parseo.
import { Gtk } from "ags/gtk4"
import { execAsync } from "ags/process"
import GLib from "gi://GLib"
import Gio from "gi://Gio"
import textos from "../../../textos/ajustes/sistema.json" with { type: "json" }
import { formatearTexto } from "../../../textos/formatear"
import {
  bitsPorCanal,
  diagonalPulgadas,
  identidadMonitor,
  parsearMonitores,
} from "./monitores"

export interface InfoItem { label: string; value: string }
export interface InfoGroup { title: string; icon: string; items: InfoItem[] }
export interface SystemSnapshot { groups: InfoGroup[] }

export type Sondeo = Record<string, string>

const CACHE_VERSION = 1
const CACHE_PATH = GLib.build_filenamev([GLib.get_user_cache_dir(), "gigios", "sysinfo.json"])

// Valores que el fabricante deja sin rellenar en el DMI. Enseñarlos es peor que
// no enseñar la fila: "System Product Name" parece un dato y no lo es.
const MARCADORES = new Set([
  "n/a", "unknown", "none", "default string", "to be filled by o.e.m.",
  "system product name", "system manufacturer", "system version",
  "not specified", "not applicable", "o.e.m.", "empty",
])

// ─── lectura de disco ────────────────────────────────────────────────────────

function readFile(path: string): string {
  try {
    const [ok, bytes] = GLib.file_get_contents(path)
    return ok ? new TextDecoder().decode(bytes).trim() : ""
  } catch (_) { return "" }
}

function listDir(path: string): string[] {
  try {
    const iter = Gio.File.new_for_path(path)
      .enumerate_children("standard::name", Gio.FileQueryInfoFlags.NONE, null)
    const names: string[] = []
    for (let info = iter.next_file(null); info; info = iter.next_file(null)) names.push(info.get_name())
    iter.close(null)
    return names.sort()
  } catch (_) { return [] }
}

// ─── formato ─────────────────────────────────────────────────────────────────

/** Decimal con coma: la UI está en español y el resto del sistema también. */
function decimal(value: number, digits = 1): string {
  return value.toFixed(digits).replace(".", ",").replace(/,0$/, "")
}

function fromKiB(kib: number): string {
  if (!kib) return ""
  if (kib >= 1024 * 1024) return `${decimal(kib / 1024 / 1024)} GiB`
  if (kib >= 1024) return `${decimal(kib / 1024)} MiB`
  return `${kib} KiB`
}

/** Tamaños de sysfs: "48K", "18432K", "1M". */
function parseKiB(raw: string): number {
  const m = raw.match(/^(\d+)([KMG])?/i)
  if (!m) return 0
  const n = Number(m[1])
  return m[2]?.toUpperCase() === "M" ? n * 1024 : m[2]?.toUpperCase() === "G" ? n * 1024 * 1024 : n
}

function uptime(): string {
  const secs = Number(readFile("/proc/uptime").split(" ")[0] ?? 0)
  if (!secs) return ""
  const d = Math.floor(secs / 86400), h = Math.floor((secs % 86400) / 3600), m = Math.floor((secs % 3600) / 60)
  return [d && `${d} d`, (d || h) && `${h} h`, `${m} min`].filter(Boolean).join(" ")
}

function firstLine(value: string): string {
  return value.split("\n").find(Boolean)?.trim() ?? ""
}

function add(items: InfoItem[], label: string, value: string) {
  const clean = value.trim()
  if (clean && !MARCADORES.has(clean.toLowerCase())) items.push({ label, value: clean })
}

function join(...parts: string[]): string {
  return parts.filter(Boolean).join(" · ")
}

// ─── mitad síncrona (cero procesos) ──────────────────────────────────────────

function osRelease(): Record<string, string> {
  const result: Record<string, string> = {}
  for (const line of readFile("/etc/os-release").split("\n")) {
    const pos = line.indexOf("=")
    if (pos < 1) continue
    result[line.slice(0, pos)] = line.slice(pos + 1).replace(/^['"]|['"]$/g, "")
  }
  return result
}

/**
 * Los marcadores hay que filtrarlos POR CAMPO, no sobre el resultado ya unido:
 * `sys_vendor` suele venir bien ("ASUS") y `product_name` sin rellenar, y
 * concatenarlos antes de mirar daba "ASUS System Product Name" — una cadena que
 * ya no casa con ningún marcador y se colaba entera a la UI.
 */
function dmi(...fields: string[]): string {
  return fields
    .map(f => readFile(`/sys/devices/virtual/dmi/id/${f}`))
    .filter(v => v && !MARCADORES.has(v.toLowerCase()))
    .join(" ")
}

/**
 * Suma la caché por nivel deduplicando por `level|type|id`: una L3 compartida
 * aparece una vez por cada core y contarla 12 veces daría 216 MiB.
 */
function cpuCache(): string {
  const seen = new Set<string>()
  const perLevel = new Map<number, number>()
  for (const cpu of listDir("/sys/devices/system/cpu").filter(n => /^cpu\d+$/.test(n))) {
    const base = `/sys/devices/system/cpu/${cpu}/cache`
    for (const idx of listDir(base).filter(n => n.startsWith("index"))) {
      const dir = `${base}/${idx}`
      const level = Number(readFile(`${dir}/level`))
      if (!level) continue
      const key = `${level}|${readFile(`${dir}/type`)}|${readFile(`${dir}/id`) || dir}`
      if (seen.has(key)) continue
      seen.add(key)
      perLevel.set(level, (perLevel.get(level) ?? 0) + parseKiB(readFile(`${dir}/size`)))
    }
  }
  return [...perLevel.entries()].sort((a, b) => a[0] - b[0])
    .map(([level, kib]) => `L${level} ${fromKiB(kib)}`).join(" · ")
}

/**
 * Velocidad de la RAM por EDAC. El camino clásico (`lshw -class memory`) se
 * quitó tras medirlo: sin root no puede leer el DMI, así que devolvía **cadena
 * vacía tras 857 ms** — era el grueso de la espera al abrir la sección, gastado
 * en nada. EDAC son lecturas de sysfs y cuesta ~1 ms; donde no exista, la fila
 * simplemente no sale.
 */
function memorySpeed(): string {
  const speeds = new Set<string>()
  for (const mc of listDir("/sys/devices/system/edac/mc").filter(n => n.startsWith("mc"))) {
    const base = `/sys/devices/system/edac/mc/${mc}`
    for (const dimm of listDir(base).filter(n => n.startsWith("dimm"))) {
      const speed = readFile(`${base}/${dimm}/dimm_speed`)
      if (speed && Number(speed) > 0) speeds.add(`${speed} MT/s`)
    }
  }
  return [...speeds].join(" · ")
}

interface Sincrono {
  os: Record<string, string>
  cpuModel: string; cores: string; threads: string; maxFreq: string; governor: string
  cache: string; memTotal: number; swapTotal: number; memSpeed: string
  kernel: string; hostname: string; uptime: string
  board: string; bios: string; biosDate: string; product: string; firmware: string
  gtk: string; sessionType: string; desktop: string
}

function leerSincrono(): Sincrono {
  const cpuinfo = readFile("/proc/cpuinfo")
  const meminfo = readFile("/proc/meminfo")
  const maxKHz = Number(readFile("/sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_max_freq"))
  return {
    os: osRelease(),
    cpuModel: cpuinfo.match(/^model name\s*:\s*(.+)$/m)?.[1] ?? "",
    cores: cpuinfo.match(/^cpu cores\s*:\s*(\d+)$/m)?.[1] ?? "",
    threads: cpuinfo.match(/^siblings\s*:\s*(\d+)$/m)?.[1] ?? "",
    maxFreq: maxKHz ? `${decimal(maxKHz / 1_000_000, 2)} GHz` : "",
    governor: readFile("/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor"),
    cache: cpuCache(),
    memTotal: Number(meminfo.match(/^MemTotal:\s+(\d+)/m)?.[1] ?? 0),
    swapTotal: Number(meminfo.match(/^SwapTotal:\s+(\d+)/m)?.[1] ?? 0),
    memSpeed: memorySpeed(),
    kernel: readFile("/proc/sys/kernel/osrelease"),
    hostname: GLib.get_host_name(),
    uptime: uptime(),
    board: dmi("board_vendor", "board_name"),
    bios: dmi("bios_vendor", "bios_version"),
    biosDate: dmi("bios_date"),
    product: dmi("sys_vendor", "product_name"),
    firmware: GLib.file_test("/sys/firmware/efi", GLib.FileTest.IS_DIR) ? "UEFI" : "BIOS",
    gtk: `${Gtk.get_major_version()}.${Gtk.get_minor_version()}.${Gtk.get_micro_version()}`,
    sessionType: GLib.getenv("XDG_SESSION_TYPE") || "Wayland",
    desktop: GLib.getenv("XDG_CURRENT_DESKTOP") || "Hyprland",
  }
}

// ─── mitad asíncrona (procesos, cacheada) ────────────────────────────────────

async function command(script: string): Promise<string> {
  return execAsync(["bash", "-c", script]).then(out => out.trim()).catch(() => "")
}

// Un solo `lspci -Dk` alimenta GPU, red y audio: antes eran tres invocaciones
// distintas del mismo binario y el troceado por categorías se hacía en awk.
const SONDEOS: Record<string, string> = {
  arch: "uname -m",
  virt: "systemd-detect-virt 2>/dev/null || true",
  pci: "lspci -Dk 2>/dev/null",
  gl: "(glxinfo -B 2>/dev/null || eglinfo -B 2>/dev/null) | sed -n 's/^[ \\t]*OpenGL \\(renderer string\\|version string\\):[ \\t]*/\\1|/p'",
  vulkan: "vulkaninfo --summary 2>/dev/null | sed -n 's/^[ \\t]*\\(driverName\\|driverInfo\\|apiVersion\\)[ \\t]*=[ \\t]*/\\1|/p'",
  nvidia: "nvidia-smi --query-gpu=driver_version,memory.total --format=csv,noheader 2>/dev/null | head -n1",
  // `-P` (KEY="value") y no columnas sueltas: un disco sin MODEL o sin TRAN
  // deja el hueco vacío, y al trocear por espacios los valores se corren una
  // posición (el tamaño acababa leyéndose como modelo). zram/loop/dm/sr no son
  // almacenamiento físico — zram es RAM y ya sale como intercambio.
  // `-b` (bytes) y no el tamaño ya formateado: lsblk lo formatea según el
  // locale ("447,1G") y quedaba en otra unidad y otra escala que el resto de la
  // sección, que va en GiB. Se formatea aquí, una sola vez y para todo.
  disks: "lsblk -dnb -P -o NAME,MODEL,SIZE,TRAN,ROTA 2>/dev/null | grep -vE 'NAME=\"(zram|loop|sr|dm-)'",
  hypr: "hyprctl version -j 2>/dev/null",
  monitors: "hyprctl monitors -j 2>/dev/null",
  ags: "ags --version 2>/dev/null",
  packages:
    "if command -v pacman >/dev/null; then printf '%s' \"$(pacman -Qq 2>/dev/null | wc -l)\";" +
    " elif command -v dpkg-query >/dev/null; then printf '%s' \"$(dpkg-query -f '.\\n' -W 2>/dev/null | wc -l)\";" +
    " elif command -v rpm >/dev/null; then printf '%s' \"$(rpm -qa 2>/dev/null | wc -l)\"; fi",
  lastUpgrade:
    "tail -n 4000 /var/log/pacman.log 2>/dev/null | grep -F 'starting full system upgrade' | tail -n1 |" +
    " sed -n 's/^\\[\\([0-9-]*\\)T\\([0-9:]*\\).*/\\1 \\2/p'",
}

export async function sondear(): Promise<Sondeo> {
  const keys = Object.keys(SONDEOS)
  const values = await Promise.all(keys.map(k => command(SONDEOS[k])))
  const probe: Sondeo = { __version: String(CACHE_VERSION) }
  keys.forEach((k, i) => { probe[k] = values[i] })
  return probe
}

export function leerCache(): Sondeo | null {
  const raw = readFile(CACHE_PATH)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || parsed.__version !== String(CACHE_VERSION)) return null
    return parsed as Sondeo
  } catch (_) { return null }
}

export function guardarCache(probe: Sondeo) {
  try {
    GLib.mkdir_with_parents(GLib.path_get_dirname(CACHE_PATH), 0o755)
    GLib.file_set_contents(CACHE_PATH, JSON.stringify(probe))
  } catch (_) { /* la caché es una comodidad: si falla, se vuelve a sondear */ }
}

// ─── parseo de los sondeos ───────────────────────────────────────────────────

interface PciDevice { clase: string; nombre: string; driver: string; modules: string }

/** Trocea `lspci -Dk`: una línea sin sangrar abre dispositivo, las sangradas son sus detalles. */
function parsePci(raw: string): PciDevice[] {
  const devices: PciDevice[] = []
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue
    if (!/^\s/.test(line)) {
      const m = line.match(/^\S+\s+([^:]+):\s*(.+)$/)
      // El "(rev a1)" de la cola es número de revisión del silicio: alarga
      // mucho la fila y no le dice nada a quien mira sus componentes.
      if (m) devices.push({
        clase: m[1].trim(),
        nombre: m[2].trim().replace(/\s*\(rev [0-9a-f]+\)\s*$/i, ""),
        driver: "", modules: "",
      })
      continue
    }
    const dev = devices[devices.length - 1]
    if (!dev) continue
    const detail = line.trim()
    if (detail.startsWith("Kernel driver in use:")) dev.driver = detail.split(":").slice(1).join(":").trim()
    if (detail.startsWith("Kernel modules:")) dev.modules = detail.split(":").slice(1).join(":").trim()
  }
  return devices
}

/** `clave|valor` por línea, tal y como los dejan los `sed` de SONDEOS. */
function pairs(raw: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of raw.split("\n")) {
    const pos = line.indexOf("|")
    if (pos > 0 && !(line.slice(0, pos) in out)) out[line.slice(0, pos)] = line.slice(pos + 1).trim()
  }
  return out
}

const BUSES: Record<string, string> = { nvme: "NVMe", sata: "SATA", usb: "USB", ata: "ATA", scsi: "SCSI", mmc: "MMC" }

function parseDisks(raw: string): string[] {
  return raw.split("\n").filter(line => line.includes("NAME=")).map(line => {
    const campos: Record<string, string> = {}
    for (const m of line.matchAll(/(\w+)="([^"]*)"/g)) campos[m[1]] = m[2]
    const size = fromKiB(Math.round(Number(campos.SIZE ?? 0) / 1024))
    if (!size) return ""
    const bus = campos.TRAN ? (BUSES[campos.TRAN.toLowerCase()] ?? campos.TRAN.toUpperCase()) : ""
    const tipo = join(bus, campos.ROTA === "1" ? textos.etiquetas.hdd : textos.etiquetas.ssd)
    return `${campos.MODEL || campos.NAME} — ${size}${tipo ? ` (${tipo})` : ""}`
  }).filter(Boolean)
}

function addNumbered(items: InfoItem[], label: string, values: string[]) {
  values.forEach((value, index) => add(items, values.length > 1
    ? formatearTexto(textos.etiquetas.elementoNumerado, { etiqueta: label, numero: index + 1 })
    : label, value))
}

function etiquetaMonitor(etiqueta: string, indice: number, total: number): string {
  return total > 1
    ? formatearTexto(textos.etiquetas.elementoNumerado, { etiqueta, numero: indice + 1 })
    : etiqueta
}

/**
 * Cada salida forma una ficha de filas consecutivas. No se consulta el EDID por
 * separado: Hyprland ya publica fabricante, modelo y milímetros físicos, así
 * que reutilizar su único sondeo conserva el coste actual de la sección.
 */
function construirMonitores(raw: string): InfoItem[] {
  const detectados = parsearMonitores(raw)
  const items: InfoItem[] = []

  detectados.forEach((monitor, indice) => {
    const etiqueta = (texto: string) => etiquetaMonitor(texto, indice, detectados.length)
    const resolucion = monitor.ancho && monitor.alto ? `${monitor.ancho}×${monitor.alto}` : ""
    const frecuencia = monitor.frecuencia
      ? formatearTexto(textos.etiquetas.hercios, { frecuencia: decimal(monitor.frecuencia, 2) })
      : ""
    const diagonal = diagonalPulgadas(monitor)
    const tamano = monitor.anchoFisico && monitor.altoFisico
      ? formatearTexto(textos.etiquetas.tamanoMonitor, {
          ancho: monitor.anchoFisico,
          alto: monitor.altoFisico,
          diagonal: diagonal ? decimal(diagonal, 1) : "",
        })
      : ""
    const profundidad = bitsPorCanal(monitor.formatoColor)
    const color = join(
      profundidad ? formatearTexto(textos.etiquetas.bitsPorCanal, { bits: profundidad }) : "",
      monitor.formatoColor,
    )

    add(items, etiqueta(textos.etiquetas.monitor), identidadMonitor(monitor))
    add(items, etiqueta(textos.etiquetas.conector), monitor.conector)
    add(items, etiqueta(textos.etiquetas.resolucionFrecuencia), join(resolucion, frecuencia))
    add(items, etiqueta(textos.etiquetas.tamanoFisico), tamano)
    add(items, etiqueta(textos.etiquetas.escalaMonitor), monitor.escala
      ? formatearTexto(textos.etiquetas.escalaMonitorValor, {
          factor: decimal(monitor.escala, 2),
          porcentaje: decimal(monitor.escala * 100, 0),
        })
      : "")
    add(items, etiqueta(textos.etiquetas.profundidadFormato), color)
  })

  return items
}

// ─── construcción de la vista ────────────────────────────────────────────────

export function construir(probe: Sondeo | null): SystemSnapshot {
  const s = leerSincrono()
  const p = probe ?? {}
  const pci = parsePci(p.pci ?? "")
  const gl = pairs(p.gl ?? "")
  const vk = pairs(p.vulkan ?? "")
  const [nvDriver, nvVram] = (p.nvidia ?? "").split(",").map(v => v.trim())

  const sistema: InfoItem[] = []
  add(sistema, textos.etiquetas.sistemaOperativo, s.os.PRETTY_NAME || s.os.NAME || "")
  add(sistema, textos.etiquetas.kernelArquitectura, join(s.kernel, p.arch ?? ""))
  add(sistema, textos.etiquetas.modeloEquipo, s.product)
  add(sistema, textos.etiquetas.nombreEquipo, s.hostname)
  add(sistema, textos.etiquetas.tiempoEncendido, s.uptime)
  add(sistema, textos.etiquetas.paquetes, p.packages
    ? join(formatearTexto(textos.etiquetas.paquetesInstalados, { numero: p.packages }),
      p.lastUpgrade ? formatearTexto(textos.etiquetas.ultimaActualizacion, { fecha: p.lastUpgrade }) : "")
    : "")
  if (p.virt && p.virt !== "none") add(sistema, textos.etiquetas.virtualizacion, p.virt)

  const procesador: InfoItem[] = []
  add(procesador, textos.etiquetas.modelo, s.cpuModel)
  add(procesador, textos.etiquetas.nucleos, s.cores && s.threads
    ? formatearTexto(textos.etiquetas.nucleosHilos, { nucleos: s.cores, hilos: s.threads }) : "")
  add(procesador, textos.etiquetas.frecuenciaMaxima, s.maxFreq)
  add(procesador, textos.etiquetas.cache, s.cache)
  add(procesador, textos.etiquetas.gobernador, s.governor)

  const memoria: InfoItem[] = []
  add(memoria, textos.etiquetas.memoria, join(fromKiB(s.memTotal), s.memSpeed))
  add(memoria, textos.etiquetas.intercambio, fromKiB(s.swapTotal))
  addNumbered(memoria, textos.etiquetas.almacenamiento, parseDisks(p.disks ?? ""))

  const placa: InfoItem[] = []
  add(placa, textos.etiquetas.placaBase, s.board)
  add(placa, textos.etiquetas.firmware, join(s.bios, s.biosDate))
  add(placa, textos.etiquetas.modoArranque, s.firmware)

  const graficos: InfoItem[] = []
  const gpus = pci.filter(d => /VGA compatible controller|3D controller|Display controller/i.test(d.clase))
  gpus.forEach((gpu, index) => {
    const numero = { numero: index + 1 }
    const etiquetaGpu = gpus.length > 1 ? formatearTexto(textos.etiquetas.gpuNumerada, numero) : textos.etiquetas.gpu
    const etiquetaCtrl = gpus.length > 1 ? formatearTexto(textos.etiquetas.controladorNumerado, numero) : textos.etiquetas.controlador
    const esNvidia = gpu.driver === "nvidia"
    const modulos = gpu.modules && gpu.modules !== gpu.driver
      ? formatearTexto(textos.etiquetas.modulos, { modulos: gpu.modules }) : ""
    add(graficos, etiquetaGpu, join(gpu.nombre, esNvidia && nvVram ? nvVram.replace("MiB", "MiB VRAM") : ""))
    add(graficos, etiquetaCtrl, join(gpu.driver, esNvidia ? nvDriver : "", modulos))
  })
  add(graficos, textos.etiquetas.renderizadorOpenGl, gl["renderer string"] ?? "")
  add(graficos, textos.etiquetas.versionOpenGl, (gl["version string"] ?? "").split(" ")[0] ?? "")
  add(graficos, textos.etiquetas.vulkan, join(
    vk.apiVersion ? formatearTexto(textos.etiquetas.vulkanApi, { version: vk.apiVersion }) : "",
    join(vk.driverName ?? "", vk.driverInfo ?? "")))

  const monitores = construirMonitores(p.monitors ?? "")

  let hyprland = ""
  try {
    const h = JSON.parse(p.hypr ?? "")
    hyprland = join(h.tag || h.version, h.commit ? `(${String(h.commit).slice(0, 8)})` : "").replace(" · ", " ")
  } catch (_) { hyprland = firstLine(p.hypr ?? "") }

  const entorno: InfoItem[] = []
  add(entorno, textos.etiquetas.compositor, hyprland ? `Hyprland ${hyprland}` : "Hyprland")
  add(entorno, textos.etiquetas.sesion, join(s.sessionType, s.desktop))
  add(entorno, textos.etiquetas.ags, firstLine(p.ags ?? "").replace(/^ags version /i, ""))
  add(entorno, textos.etiquetas.gtk, s.gtk)

  const dispositivos: InfoItem[] = []
  addNumbered(dispositivos, textos.etiquetas.redPci,
    pci.filter(d => /Ethernet controller|Network controller/i.test(d.clase)).map(d => join(d.nombre, d.driver)))
  addNumbered(dispositivos, textos.etiquetas.audioPci,
    pci.filter(d => /^Audio device/i.test(d.clase)).map(d => join(d.nombre, d.driver)))

  return {
    groups: [
      { title: textos.grupos.sistema, icon: "󰍹", items: sistema },
      { title: textos.grupos.procesador, icon: "󰻠", items: procesador },
      { title: textos.grupos.memoria, icon: "󰍛", items: memoria },
      { title: textos.grupos.placaBase, icon: "󰘚", items: placa },
      { title: textos.grupos.graficos, icon: "󰢮", items: graficos },
      { title: textos.grupos.monitores, icon: "󰍹", items: monitores },
      { title: textos.grupos.entorno, icon: "󰖯", items: entorno },
      { title: textos.grupos.controladoresPci, icon: "󰓢", items: dispositivos },
    ].filter(group => group.items.length),
  }
}
