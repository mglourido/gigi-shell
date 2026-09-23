import GLib from "gi://GLib"
import { createState } from "ags"
import { readFileAsync } from "ags/file"
import { execAsync } from "ags/process"
import {
  calcularUsoCpu,
  formatearProcesoCpu,
  formatearProcesoRam,
  interpretarMuestraCpu,
  interpretarRamUsadaGiB,
} from "./recursosDatos"
import type { MuestraCpu } from "./recursosDatos"

export const [usoCpu, establecerUsoCpu] = createState(0)
export const [ramUsadaGiB, establecerRamUsadaGiB] = createState("0.0")
export const [procesoCpu, establecerProcesoCpu] = createState("Cargando…")
export const [procesoRam, establecerProcesoRam] = createState("Cargando…")

let consumidoresMetricas = 0
let consumidoresDetalle = 0
let temporizadorMetricas: number | null = null
let temporizadorDetalle: number | null = null
let muestraAnterior: MuestraCpu | null = null
let leyendoMetricas = false
let leyendoDetalle = false

async function actualizarMetricas(): Promise<void> {
  if (leyendoMetricas) return
  leyendoMetricas = true
  try {
    const [cpuTexto, ramTexto] = await Promise.all([
      readFileAsync("/proc/stat"),
      readFileAsync("/proc/meminfo"),
    ])
    const muestra = interpretarMuestraCpu(cpuTexto)
    const ram = interpretarRamUsadaGiB(ramTexto)
    if (muestra) {
      if (muestraAnterior) {
        const uso = calcularUsoCpu(muestraAnterior, muestra)
        if (uso !== null) establecerUsoCpu(uso)
      }
      muestraAnterior = muestra
    }
    if (ram !== null) establecerRamUsadaGiB(ram.toFixed(1))
  } catch (_) {
    // /proc puede no estar disponible en entornos de prueba o contenedores.
  } finally {
    leyendoMetricas = false
  }
}

async function actualizarDetalle(): Promise<void> {
  if (leyendoDetalle) return
  leyendoDetalle = true
  try {
    const [cpuTexto, ramTexto] = await Promise.all([
      execAsync(["ps", "axch", "-o", "pcpu,comm", "--sort=-pcpu"]),
      execAsync(["ps", "axch", "-o", "rss,comm", "--sort=-rss"]),
    ])
    establecerProcesoCpu(formatearProcesoCpu(cpuTexto.split("\n")[0] ?? "") ?? "—")
    establecerProcesoRam(formatearProcesoRam(ramTexto.split("\n")[0] ?? "") ?? "—")
  } catch (_) {
    establecerProcesoCpu("—")
    establecerProcesoRam("—")
  } finally {
    leyendoDetalle = false
  }
}

function iniciarMetricas(): void {
  if (temporizadorMetricas !== null) return
  void actualizarMetricas()
  temporizadorMetricas = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 4000, () => {
    void actualizarMetricas()
    return GLib.SOURCE_CONTINUE
  })
}

function detenerMetricas(): void {
  if (temporizadorMetricas === null) return
  GLib.source_remove(temporizadorMetricas)
  temporizadorMetricas = null
}

function iniciarDetalle(): void {
  if (temporizadorDetalle !== null) return
  void actualizarDetalle()
  temporizadorDetalle = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 5000, () => {
    void actualizarDetalle()
    return GLib.SOURCE_CONTINUE
  })
}

function detenerDetalle(): void {
  if (temporizadorDetalle === null) return
  GLib.source_remove(temporizadorDetalle)
  temporizadorDetalle = null
}

/** Mantiene una única fuente de métricas mientras al menos una barra las muestra. */
export function adquirirMetricas(): () => void {
  consumidoresMetricas++
  if (consumidoresMetricas === 1) iniciarMetricas()
  let activa = true
  return () => {
    if (!activa) return
    activa = false
    consumidoresMetricas = Math.max(0, consumidoresMetricas - 1)
    if (consumidoresMetricas === 0) detenerMetricas()
  }
}

/** Ejecuta `ps` solo mientras algún popover de detalle está abierto. */
export function adquirirDetalleProcesos(): () => void {
  consumidoresDetalle++
  if (consumidoresDetalle === 1) iniciarDetalle()
  let activa = true
  return () => {
    if (!activa) return
    activa = false
    consumidoresDetalle = Math.max(0, consumidoresDetalle - 1)
    if (consumidoresDetalle === 0) detenerDetalle()
  }
}
