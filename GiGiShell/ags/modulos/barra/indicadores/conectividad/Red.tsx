import AstalNetwork from "gi://AstalNetwork"
import { For, createState } from "ags"
import { Gtk } from "ags/gtk4"
import { crearCicloVida } from "../../../../utilidades/cicloVida"
import { barrasActivas, clasesBarraRed, determinarTipoRed } from "./datosRed"
import type { CalidadRed, TipoRed } from "./datosRed"
import type { EstadoVisibilidadBarra } from "../../../../estado/visibilidadBarra"
import { tituloBarra } from "../../componentes/tituloBarra"

const GLIFO_ETHERNET = "󰈀"
const INDICES_BARRAS = [0, 1, 2, 3]

export default function Red({ visibilidad }: { visibilidad: EstadoVisibilidadBarra }) {
  const cicloVida = crearCicloVida()
  const red = AstalNetwork.get_default()
  const P = AstalNetwork.Primary
  const C = AstalNetwork.Connectivity
  const DS = AstalNetwork.DeviceState

  const cableActivo = () => !!red.wired && red.wired.state === DS.ACTIVATED
  const wifiActiva = () => !!red.wifi?.enabled && red.wifi.state === DS.ACTIVATED
  const tipoPrimario = (): "wired" | "wifi" | "unknown" =>
    red.primary === P.WIRED ? "wired" : red.primary === P.WIFI ? "wifi" : "unknown"
  const calcularTipo = () => determinarTipoRed(tipoPrimario(), cableActivo(), wifiActiva())
  const calcularCalidad = (tipo: TipoRed): CalidadRed => {
    if (tipo === "none") return "offline"
    if (red.connectivity === C.PORTAL) return "portal"
    if (red.connectivity === C.LIMITED || red.connectivity === C.NONE) return "limited"
    return "connected"
  }
  const calcularTooltip = (tipo: TipoRed, calidad: CalidadRed) => {
    const sufijo = calidad === "portal" ? " · Inicia sesión (portal cautivo)"
      : calidad === "limited" ? " · Sin internet" : ""
    if (tipo === "wired") return `Ethernet${sufijo}`
    if (tipo === "wifi") return `${red.wifi?.ssid || "Wi-Fi"}${sufijo}`
    return "Sin conexión"
  }
  const obtenerInstantanea = () => {
    const tipo = calcularTipo()
    const calidad = calcularCalidad(tipo)
    return {
      tipo,
      calidad,
      tooltip: calcularTooltip(tipo, calidad),
    }
  }

  const [instantanea, establecerInstantanea] = createState(obtenerInstantanea())
  const [cantidadBarras, establecerCantidadBarras] = createState(
    instantanea().tipo === "wifi" ? barrasActivas(red.wifi?.strength ?? 0) : 0,
  )
  const sincronizar = () => {
    const dato = obtenerInstantanea()
    establecerInstantanea(dato)
    establecerCantidadBarras(dato.tipo === "wifi" ? barrasActivas(red.wifi?.strength ?? 0) : 0)
  }
  const actualizarVisible = () => { if (visibilidad.visible.get()) sincronizar() }

  let desconectarWifi: (() => void) | null = null
  let desconectarCable: (() => void) | null = null
  const enlazarWifi = () => {
    desconectarWifi?.()
    desconectarWifi = red.wifi
      ? cicloVida.conectarSenales(red.wifi, ["notify::strength", "notify::ssid", "notify::internet", "notify::enabled", "notify::state"], actualizarVisible)
      : null
  }
  const enlazarCable = () => {
    desconectarCable?.()
    desconectarCable = red.wired
      ? cicloVida.conectarSenales(red.wired, ["notify::state", "notify::internet"], actualizarVisible)
      : null
  }
  enlazarWifi()
  enlazarCable()
  cicloVida.conectarSenales(red, ["notify::connectivity", "notify::primary"], actualizarVisible)
  cicloVida.conectarSenales(red, ["notify::wifi"], () => { enlazarWifi(); actualizarVisible() })
  cicloVida.conectarSenales(red, ["notify::wired"], () => { enlazarCable(); actualizarVisible() })
  cicloVida.suscribir(visibilidad.refrescar, () => {
    if (visibilidad.refrescar.get()) sincronizar()
  })

  return (
    <box
      cssClasses={instantanea((dato) => ["network", dato.tipo === "wired" ? "wired" : dato.calidad])}
      valign={Gtk.Align.CENTER}
      $={(self: Gtk.Widget) => tituloBarra(self, instantanea((dato) => dato.tooltip))}
      visible={instantanea((dato) => dato.tipo !== "none")}
    >
      <box
        cssClasses={instantanea((dato) => dato.tipo === "none" ? ["network-bars", "offline"] : ["network-bars"])}
        spacing={1}
        valign={Gtk.Align.CENTER}
        visible={instantanea((dato) => dato.tipo !== "wired")}
      >
        <For each={() => INDICES_BARRAS}>
          {(indice) => (
            <box
              cssClasses={cantidadBarras((cantidad) => clasesBarraRed(indice, cantidad))}
              valign={Gtk.Align.END}
            />
          )}
        </For>
      </box>
      <label cssClasses={["network-wired-glyph"]} label={GLIFO_ETHERNET} visible={instantanea((dato) => dato.tipo === "wired")} />
      <label
        cssClasses={["network-status-glyph"]}
        label="󰀦"
        visible={instantanea((dato) => dato.calidad === "portal" || dato.calidad === "limited")}
      />
    </box>
  )
}
