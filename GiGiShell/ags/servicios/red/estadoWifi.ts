import { createState } from "ags"
import AstalNetwork from "gi://AstalNetwork"
import NM from "gi://NM"

interface EstadoWifi {
  habilitada: boolean
  conectada: boolean
  ssid: string
  intensidad: number
}

const [estadoWifi, establecerEstadoWifi] = createState<EstadoWifi>({
  habilitada: false,
  conectada: false,
  ssid: "",
  intensidad: 0,
})

let red: AstalNetwork.Network | null = null
let dispositivo: NM.DeviceWifi | null = null
let punto: NM.AccessPoint | null = null
let senalesDispositivo: number[] = []
let senalesPunto: number[] = []

function desconectarSenales(emisor: { disconnect(id: number): void } | null, ids: number[]) {
  if (emisor) for (const id of ids) {
    try { emisor.disconnect(id) } catch (_) { }
  }
}

function enlazarPunto() {
  const siguiente = dispositivo?.get_active_access_point() ?? null
  if (siguiente === punto) return
  desconectarSenales(punto, senalesPunto)
  senalesPunto = []
  punto = siguiente
  if (punto) {
    senalesPunto.push(punto.connect("notify::strength", actualizarEstadoWifi))
    senalesPunto.push(punto.connect("notify::ssid", actualizarEstadoWifi))
  }
}

function actualizarEstadoWifi() {
  try {
    enlazarPunto()
    const conectada = dispositivo?.get_state() === NM.DeviceState.ACTIVATED
    const bytes = conectada ? punto?.get_ssid() : null
    const siguiente: EstadoWifi = {
      habilitada: red?.client.wireless_enabled ?? false,
      conectada,
      ssid: bytes ? NM.utils_ssid_to_utf8(bytes.get_data()) : "",
      intensidad: conectada ? punto?.get_strength() ?? 0 : 0,
    }
    const anterior = estadoWifi.get()
    if (siguiente.habilitada !== anterior.habilitada || siguiente.conectada !== anterior.conectada
      || siguiente.ssid !== anterior.ssid || siguiente.intensidad !== anterior.intensidad)
      establecerEstadoWifi(siguiente)
  } catch (error) {
    console.warn("No se pudo actualizar el estado Wi-Fi:", error)
  }
}

function enlazarDispositivo() {
  const siguiente = red?.wifi?.device ?? null
  if (siguiente !== dispositivo) {
    desconectarSenales(dispositivo, senalesDispositivo)
    senalesDispositivo = []
    desconectarSenales(punto, senalesPunto)
    senalesPunto = []
    punto = null
    dispositivo = siguiente
    if (dispositivo) {
      senalesDispositivo.push(dispositivo.connect("state-changed", actualizarEstadoWifi))
      senalesDispositivo.push(dispositivo.connect("notify::active-access-point", actualizarEstadoWifi))
      senalesDispositivo.push(dispositivo.connect("notify::active-connection", actualizarEstadoWifi))
    }
  }
  actualizarEstadoWifi()
}

/** Lee libnm directamente: la copia de SSID/intensidad de Astal puede quedar
 * desfasada si un AP cambia durante una reasociación Wi-Fi. */
export function observarEstadoWifi() {
  if (!red) {
    red = AstalNetwork.get_default()
    red.connect("notify::wifi", enlazarDispositivo)
    red.client.connect("notify::wireless-enabled", actualizarEstadoWifi)
    enlazarDispositivo()
  }
  return estadoWifi
}

export function refrescarEstadoWifi() {
  observarEstadoWifi()
  enlazarDispositivo()
}
