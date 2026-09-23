export type BluetoothDeviceInfo = {
  connected?: boolean
  alias?: string | null
  name?: string | null
  address?: string | null
  icon_name?: string | null
}

export type BluetoothTileInfo = {
  label: string
  icon: string
  /** `true` = el tile se pinta encendido (clase CSS `active`).
   *
   * Vive aquí, y no en un cómputo aparte, porque el CSS y el texto describen el
   * MISMO hecho ("¿hay adaptador y está encendido?"). Derivarlos por separado —el
   * CSS por `createBinding(bt, "isPowered")`, el texto por este objeto— los dejaba
   * actualizarse en handlers distintos de `notify::is-powered`, y el CSS llegaba un
   * handler tarde: se veía el tile encendido con el texto "Desactivado" debajo.
   * Saliendo los dos del mismo objeto, contradecirse es imposible por construcción. */
  active: boolean
}

export function getBluetoothTileInfo(
  supported: boolean,
  powered: boolean,
  devices: BluetoothDeviceInfo[],
): BluetoothTileInfo {
  if (!supported) return { label: "Incompatible", icon: "󰂲", active: false }
  if (!powered) return { label: "Desactivado", icon: "󰂲", active: false }

  const connected = devices.find((device) => device.connected)
  if (!connected) return { label: "Desconectado", icon: "󰂯", active: true }

  let icon = "󰂱"
  const name = (connected.name || connected.alias || "").toLowerCase()
  if (name.includes("head") || name.includes("auric") || connected.icon_name?.includes("head")) icon = "󰋋"
  else if (name.includes("speak") || name.includes("altav") || connected.icon_name?.includes("speak")) icon = "󰓃"
  else if (name.includes("phone") || name.includes("móvil") || connected.icon_name?.includes("phone")) icon = "󰏲"

  return {
    label: connected.alias || connected.name || connected.address || "Conectado",
    icon,
    active: true,
  }
}
