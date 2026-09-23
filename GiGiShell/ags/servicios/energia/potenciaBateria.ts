import AstalBattery from "gi://AstalBattery"
import GLib from "gi://GLib"

type ConsumidorPotencia = (vatios: number | null) => void

const INTERVALO_LECTURA_MS = 4000
const consumidores = new Set<ConsumidorPotencia>()
let temporizador: number | null = null
let potenciaInstantanea: number | null = null

function obtenerRutaPotencia(): string | null {
  const bateria = AstalBattery.get_default()
  const candidatas = [
    bateria?.nativePath ? `${bateria.nativePath}/power_now` : "",
    "/sys/class/power_supply/BAT0/power_now",
  ]
  return candidatas.find((ruta) => ruta && GLib.file_test(ruta, GLib.FileTest.EXISTS)) ?? null
}

function leerPotenciaInstantanea(): number | null {
  const ruta = obtenerRutaPotencia()
  if (!ruta) return null
  try {
    const [correcto, bytes] = GLib.file_get_contents(ruta)
    if (!correcto) return null
    const microvatios = Number(new TextDecoder().decode(bytes).trim())
    return Number.isFinite(microvatios) && microvatios >= 0
      ? microvatios / 1_000_000
      : null
  } catch (_) {
    return null
  }
}

function notificarConsumidores() {
  for (const consumidor of [...consumidores]) {
    try {
      consumidor(potenciaInstantanea)
    } catch (error) {
      console.error("Error notificando la potencia instantanea de la bateria", error)
    }
  }
}

function actualizarPotencia() {
  potenciaInstantanea = leerPotenciaInstantanea()
  notificarConsumidores()
}

function detenerTemporizador() {
  if (temporizador === null) return
  try {
    GLib.source_remove(temporizador)
  } catch (_) {}
  temporizador = null
}

function iniciarTemporizador() {
  if (temporizador !== null || consumidores.size === 0) return
  actualizarPotencia()
  try {
    temporizador = GLib.timeout_add(GLib.PRIORITY_DEFAULT, INTERVALO_LECTURA_MS, () => {
      if (consumidores.size === 0) {
        temporizador = null
        return GLib.SOURCE_REMOVE
      }
      actualizarPotencia()
      return GLib.SOURCE_CONTINUE
    })
  } catch (error) {
    temporizador = null
    console.error("No se pudo iniciar la lectura periodica de potencia de la bateria", error)
  }
}

/**
 * Comparte una sola lectura periodica de `power_now` entre todas las barras.
 * La primera suscripcion lee inmediatamente y la ultima en cerrarse detiene el sondeo.
 */
export function suscribirPotenciaBateria(consumidor: ConsumidorPotencia): () => void {
  consumidores.add(consumidor)
  if (consumidores.size === 1) iniciarTemporizador()
  else {
    try {
      consumidor(potenciaInstantanea)
    } catch (error) {
      console.error("Error entregando la potencia instantanea de la bateria", error)
    }
  }

  let suscripcionActiva = true
  return () => {
    if (!suscripcionActiva) return
    suscripcionActiva = false
    consumidores.delete(consumidor)
    if (consumidores.size === 0) detenerTemporizador()
  }
}
