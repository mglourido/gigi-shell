import AstalBluetooth from "gi://AstalBluetooth"
import { Gtk } from "ags/gtk4"
import { createBinding, createState } from "ags"

import { crearCicloVida } from "../../../../utilidades/cicloVida"
import { tituloBarra } from "../../componentes/tituloBarra"

type BluetoothAstal = ReturnType<typeof AstalBluetooth.get_default>
type DispositivoBluetooth = ReturnType<BluetoothAstal["get_devices"]>[number]

export default function Bluetooth() {
  const bluetooth = AstalBluetooth.get_default()
  const cicloVida = crearCicloVida()

  // Se muestra siempre que el adaptador esté encendido; si el BT está apagado se
  // oculta. El color lo decide `connected` (gris / morado) vía cssClasses.
  const encendido = createBinding(bluetooth, "isPowered")

  // isConnected trae su propia señal notify::is-connected. Antes la visibilidad
  // se derivaba de `devices`, que solo se emite al añadir/quitar dispositivos y
  // NO al conectar/desconectar uno ya emparejado: el estado quedaba pegado.
  const conectado = createBinding(bluetooth, "isConnected")

  // Nombre del dispositivo conectado, para el tooltip ("saber qué tengo puesto").
  const [nombre, fijarNombre] = createState("")
  const recalcularNombre = () => {
    const dispositivo = bluetooth.get_devices().find((actual) => actual.connected)
    fijarNombre(
      dispositivo
        ? (dispositivo.alias || dispositivo.name || dispositivo.address || "Bluetooth")
        : "Sin conectar",
    )
  }

  // Cada dispositivo conserva su baja. Al desaparecer de Astal se desconecta al
  // momento, sin esperar al desmontaje; si vuelve más tarde recibe una sola pareja
  // de señales nueva. Esto evita que los toggles del ajuste acumulen callbacks.
  const bajasDispositivos = new Map<DispositivoBluetooth, () => void>()
  const sincronizarDispositivos = () => {
    const actuales = bluetooth.get_devices()
    const conjuntoActual = new Set(actuales)

    for (const [dispositivo, desconectar] of bajasDispositivos) {
      if (conjuntoActual.has(dispositivo)) continue
      desconectar()
      bajasDispositivos.delete(dispositivo)
    }

    for (const dispositivo of actuales) {
      if (bajasDispositivos.has(dispositivo)) continue
      const desconectar = cicloVida.conectarSenales(
        dispositivo,
        ["notify::connected", "notify::alias"],
        recalcularNombre,
      )
      bajasDispositivos.set(dispositivo, desconectar)
    }

    recalcularNombre()
  }

  cicloVida.registrar(() => {
    for (const desconectar of bajasDispositivos.values()) desconectar()
    bajasDispositivos.clear()
  })
  cicloVida.conectarSenales(
    bluetooth,
    ["notify::devices", "device-added", "device-removed"],
    sincronizarDispositivos,
  )
  cicloVida.conectarSenales(bluetooth, ["notify::is-connected"], recalcularNombre)
  sincronizarDispositivos()

  return (
    <box
      cssClasses={conectado((activo) => activo ? ["bluetooth-ind", "connected"] : ["bluetooth-ind"])}
      visible={encendido}
      valign={Gtk.Align.CENTER}
      $={(self: Gtk.Widget) => tituloBarra(self, nombre)}
    >
      <label cssClasses={["bluetooth-icon"]} label="󰂱" />
    </box>
  )
}
