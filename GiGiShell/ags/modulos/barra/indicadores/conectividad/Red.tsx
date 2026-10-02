import AstalNetwork from "gi://AstalNetwork"
import GLib from "gi://GLib"
import { For, createState } from "ags"
import { Gtk } from "ags/gtk4"
import { crearCicloVida } from "../../../../utilidades/cicloVida"
import { barrasActivas, clasesBarraRed, determinarTipoRed } from "./datosRed"
import type { CalidadRed, TipoRed } from "./datosRed"
import type { EstadoVisibilidadBarra } from "../../../../estado/visibilidadBarra"
import { tituloBarra } from "../../componentes/tituloBarra"
import { observarEstadoWifi, refrescarEstadoWifi } from "../../../../servicios/red/estadoWifi"

const GLIFO_ETHERNET = "󰈀"
const INDICES_BARRAS = [0, 1, 2, 3]
// NM puede entregar el dispositivo activado antes de completar su primer chequeo.
// Una sola consulta compartida adelanta el veredicto sin bloquear ni duplicarlo por monitor.
let comprobacionInicialLanzada = false

// Portal cautivo: tras iniciar sesión en él, NM no se entera hasta su siguiente chequeo,
// y mientras no ve conectividad total reintenta con backoff hasta `interval` (300 s por
// defecto). Lo único que forzaba un chequeo era abrir la vista Wi-Fi de Quick Settings,
// así que el glifo de la barra se quedaba en «Inicia sesión» varios minutos con la
// sesión ya iniciada. Mientras dure PORTAL/LIMITED se pide un chequeo cada pocos
// segundos; con FULL (o sin red) el temporizador se retira. Uno solo para todas las
// barras: el veredicto es de NM, no de cada monitor.
const INTERVALO_PORTAL_S = 10
let sondeoPortal = 0
let chequeoEnCurso = false
let vigilanciaPortalInstalada = false

function vigilarPortal(red: AstalNetwork.Network) {
  if (vigilanciaPortalInstalada) return
  vigilanciaPortalInstalada = true
  const C = AstalNetwork.Connectivity
  const pendiente = () => red.connectivity === C.PORTAL || red.connectivity === C.LIMITED
  const chequear = () => {
    if (chequeoEnCurso) return
    chequeoEnCurso = true
    try {
      red.client.check_connectivity_async(null, (_cliente, resultado) => {
        chequeoEnCurso = false
        try { red.client.check_connectivity_finish(resultado) }
        catch (error) { console.warn("No se pudo recomprobar la conectividad:", error) }
      })
    } catch (error) {
      chequeoEnCurso = false
      console.warn("No se pudo iniciar la recomprobación de conectividad:", error)
    }
  }
  const revisar = () => {
    if (pendiente() && !sondeoPortal) {
      sondeoPortal = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, INTERVALO_PORTAL_S, () => {
        if (!pendiente()) { sondeoPortal = 0; return GLib.SOURCE_REMOVE }
        chequear()
        return GLib.SOURCE_CONTINUE
      })
    } else if (!pendiente() && sondeoPortal) {
      GLib.source_remove(sondeoPortal)
      sondeoPortal = 0
    }
  }
  red.connect("notify::connectivity", revisar)
  revisar()
}

export default function Red({ visibilidad }: { visibilidad: EstadoVisibilidadBarra }) {
  const cicloVida = crearCicloVida()
  const red = AstalNetwork.get_default()
  const P = AstalNetwork.Primary
  const C = AstalNetwork.Connectivity
  const DS = AstalNetwork.DeviceState
  const estadoWifi = observarEstadoWifi()

  const cableActivo = () => !!red.wired && red.wired.state === DS.ACTIVATED
  const wifiActiva = () => estadoWifi.get().conectada
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
    if (tipo === "wifi") return `${estadoWifi.get().ssid || "Wi-Fi"}${sufijo}`
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
    instantanea().tipo === "wifi" ? barrasActivas(estadoWifi.get().intensidad) : 0,
  )
  const sincronizar = () => {
    const dato = obtenerInstantanea()
    establecerInstantanea(dato)
    establecerCantidadBarras(dato.tipo === "wifi" ? barrasActivas(estadoWifi.get().intensidad) : 0)
  }
  const actualizarVisible = () => { if (visibilidad.visible.get()) sincronizar() }
  const comprobarConectividadInicial = () => {
    if (comprobacionInicialLanzada || calcularTipo() === "none") return
    if (red.connectivity !== C.UNKNOWN && red.connectivity !== C.NONE) return
    comprobacionInicialLanzada = true
    try {
      red.client.check_connectivity_async(null, (_cliente, resultado) => {
        try { red.client.check_connectivity_finish(resultado) }
        catch (error) { console.warn("No se pudo comprobar la conectividad inicial:", error) }
      })
    } catch (error) {
      console.warn("No se pudo iniciar la comprobación de conectividad:", error)
    }
  }

  let desconectarCable: (() => void) | null = null
  const enlazarCable = () => {
    desconectarCable?.()
    desconectarCable = red.wired
      ? cicloVida.conectarSenales(red.wired, ["notify::state", "notify::internet"], () => {
          actualizarVisible()
          comprobarConectividadInicial()
        })
      : null
  }
  enlazarCable()
  cicloVida.suscribir(estadoWifi, () => { actualizarVisible(); comprobarConectividadInicial() })
  cicloVida.conectarSenales(red, ["notify::connectivity", "notify::primary"], actualizarVisible)
  cicloVida.conectarSenales(red, ["notify::wired"], () => { enlazarCable(); actualizarVisible(); comprobarConectividadInicial() })
  cicloVida.suscribir(visibilidad.refrescar, () => {
    if (visibilidad.refrescar.get()) { refrescarEstadoWifi(); sincronizar() }
  })
  comprobarConectividadInicial()
  vigilarPortal(red)

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
