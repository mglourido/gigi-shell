// modulos/cuenta-atras/CuentaAtras.tsx
//
// Cuenta atrás del BOTÓN DE ENCENDIDO físico: «Apagando el equipo en 5…», con
// «Vuelve a pulsar el botón de encendido para cancelar».
//
// Esta ventana SOLO PINTA. Quien lleva la cuenta y ejecuta la acción es
// hypr/gigishell/boton-apagado.lua (un hl.timer), porque la segunda pulsación y
// la tapa del portátil tienen que consultar el estado dentro de los 100 ms de un
// callback de Hyprland, y preguntarle a este proceso no cabe ahí. Por eso:
//   · `ags request cuenta-atras <accion> <segundos>` la abre (lo manda el Lua);
//   · `ags request cuenta-atras-cerrar` la cierra (el Lua, al cancelar o ejecutar);
//   · «Cancelar» / Esc no se cierran solos: le piden al Lua que cancele
//     (`GiGiShell.boton_cancelar()`), y es el Lua quien cierra — si lo cerrásemos
//     aquí sin más, la acción saldría igual al llegar a 0 con la ventana ya quitada.
//
// El número se calcula contra el reloj monotónico, no contando ticks: un tick que
// llegue tarde no puede alargar la cuenta que se ve respecto a la que corre en Lua.
// Y hay un cierre de seguridad a los `segundos + MARGEN_CIERRE_MS`: si el Lua no
// llega a mandar el cierre (un `hyprctl reload` a media cuenta cancela su timer),
// la ventana no se queda puesta para siempre.
import { createComputed, createState } from "ags"
import { Astal, Gdk, Gtk } from "ags/gtk4"
import app from "ags/gtk4/app"
import { execAsync } from "ags/process"
import GLib from "gi://GLib"
import AstalHyprland from "gi://AstalHyprland"

const MARGEN_CIERRE_MS = 2500
const TICK_MS = 50

interface DescripcionAccion { icono: string; texto: string }

// Sólo las acciones que el Lua protege con cuenta atrás (CON_CUENTA_ATRAS).
const ACCIONES: Record<string, DescripcionAccion> = {
  apagar: { icono: "󰐥", texto: "Apagando el equipo" },
  reiniciar: { icono: "󰜉", texto: "Reiniciando el equipo" },
  suspender: { icono: "󰏤", texto: "Suspendiendo el equipo" },
  hibernar: { icono: "󰒲", texto: "Hibernando el equipo" },
  cerrarSesion: { icono: "󰍃", texto: "Cerrando la sesión" },
}

interface CuentaActiva {
  accion: DescripcionAccion
  /** Monotónico, en µs (GLib.get_monotonic_time). */
  fin: number
  totalUs: number
  /** Conector del monitor enfocado al abrirla: sólo esa ventana coge el teclado. */
  monitor: string
}

const [cuenta, setCuenta] = createState<CuentaActiva | null>(null)
const [restanteUs, setRestanteUs] = createState(0)

let tick: number | null = null
let cierreSeguridad: number | null = null

function pararTemporizadores() {
  if (tick !== null) clearInterval(tick)
  if (cierreSeguridad !== null) clearTimeout(cierreSeguridad)
  tick = cierreSeguridad = null
}

function monitorEnfocado(): string {
  try {
    return AstalHyprland.get_default()?.get_focused_monitor()?.name ?? ""
  } catch (_) {
    return ""
  }
}

/** Abre (o reinicia) la cuenta atrás. Devuelve false si la acción no se conoce. */
export function mostrarCuentaAtras(accion: string, segundos: number): boolean {
  const descripcion = ACCIONES[accion]
  if (!descripcion || !Number.isFinite(segundos) || segundos <= 0) return false
  pararTemporizadores()
  const totalUs = Math.round(segundos * 1_000_000)
  const fin = GLib.get_monotonic_time() + totalUs
  setRestanteUs(totalUs)
  setCuenta({ accion: descripcion, fin, totalUs, monitor: monitorEnfocado() })
  tick = setInterval(() => {
    setRestanteUs(Math.max(0, fin - GLib.get_monotonic_time()))
  }, TICK_MS)
  cierreSeguridad = setTimeout(cerrarCuentaAtras, segundos * 1000 + MARGEN_CIERRE_MS)
  return true
}

export function cerrarCuentaAtras() {
  pararTemporizadores()
  setCuenta(null)
}

/** «Cancelar» / Esc: se lo pide al Lua, que es quien tiene el timer (ver cabecera). */
function pedirCancelacion() {
  execAsync(["hyprctl", "eval", "GiGiShell.boton_cancelar()"])
    .catch((e) => console.error("[cuenta-atras] no se pudo cancelar:", e))
}

export default function CuentaAtras(monitorGdk: Gdk.Monitor) {
  const { TOP, BOTTOM, LEFT, RIGHT } = Astal.WindowAnchor
  const conector = monitorGdk.get_connector() ?? ""
  const visible = cuenta((c) => c !== null)
  const segundos = restanteUs((us) => `${Math.ceil(us / 1_000_000)}`)
  const fraccion = createComputed(() => {
    const c = cuenta()
    return c ? restanteUs() / c.totalUs : 0
  })

  return (
    <window
      name="cuenta-atras"
      namespace="cuenta-atras"
      visible={visible}
      gdkmonitor={monitorGdk}
      layer={Astal.Layer.OVERLAY}
      anchor={TOP | BOTTOM | LEFT | RIGHT}
      exclusivity={Astal.Exclusivity.IGNORE}
      // Teclado EXCLUSIVO sólo en el monitor enfocado: con varias superficies
      // exclusivas a la vez no está claro cuál se lo queda. Mientras dura la
      // cuenta, Esc tiene que llegar aquí y no a la ventana que hubiera debajo.
      keymode={cuenta((c) =>
        c && (!c.monitor || c.monitor === conector) ? Astal.Keymode.EXCLUSIVE : Astal.Keymode.NONE)}
      application={app}
      cssClasses={["cuenta-atras-window"]}
    >
      <Gtk.EventControllerKey
        onKeyPressed={(_self, tecla) => {
          if (tecla === Gdk.KEY_Escape) {
            pedirCancelacion()
            return true
          }
          return false
        }}
      />
      <box cssClasses={["cuenta-atras-fondo"]} hexpand vexpand>
        <box
          cssClasses={["cuenta-atras-tarjeta"]}
          orientation={Gtk.Orientation.VERTICAL}
          halign={Gtk.Align.CENTER}
          valign={Gtk.Align.CENTER}
          hexpand
          spacing={10}
        >
          <label cssClasses={["cuenta-atras-icono"]} label={cuenta((c) => c?.accion.icono ?? "")} />
          <label cssClasses={["cuenta-atras-titulo"]} label={cuenta((c) => c ? `${c.accion.texto} en` : "")} />
          <label cssClasses={["cuenta-atras-numero"]} label={segundos} />
          <Gtk.ProgressBar cssClasses={["cuenta-atras-progreso"]} fraction={fraccion} />
          <label
            cssClasses={["cuenta-atras-ayuda"]}
            label="Vuelve a pulsar el botón de encendido para cancelar"
            wrap
            justify={Gtk.Justification.CENTER}
          />
          <button
            cssClasses={["cuenta-atras-cancelar"]}
            halign={Gtk.Align.CENTER}
            onClicked={pedirCancelacion}
          >
            <label label="Cancelar" />
          </button>
        </box>
      </box>
    </window>
  )
}
