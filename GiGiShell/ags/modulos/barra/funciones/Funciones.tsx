import { createState } from "ags"
import { Astal, Gdk, Gtk } from "ags/gtk4"
import app from "ags/gtk4/app"
import {
  closeAllPanels,
  functionsMenuVisible,
  panelAutoClose,
  setFunctionsMenuVisible,
} from "../../../estado/shell"
import { crearCicloVida } from "../../../utilidades/cicloVida"
import { margenBajoBarra } from "../componentes/anclaBarra"
import FilaFuncion from "./FilaFuncion"
import { FUNCIONES_BARRA } from "./registro"

const ANCHO_MENU = 185

function alternarMenuFunciones() {
  if (functionsMenuVisible.get()) setFunctionsMenuVisible(false)
  else {
    closeAllPanels()
    setFunctionsMenuVisible(true)
  }
}

export function MenuFunciones(monitorGdk: Gdk.Monitor) {
  const cicloVida = crearCicloVida()
  const { TOP, LEFT } = Astal.WindowAnchor
  const autoCierre = panelAutoClose(() => setFunctionsMenuVisible(false), 300, functionsMenuVisible)
  const [tecladoActivo, establecerTecladoActivo] = createState(false)

  cicloVida.suscribir(functionsMenuVisible, () => establecerTecladoActivo(false))

  const manejarEntrada = () => {
    autoCierre.onEnter()
    establecerTecladoActivo(true)
  }

  return (
    <window
      name="functions-menu"
      visible={functionsMenuVisible}
      gdkmonitor={monitorGdk}
      layer={Astal.Layer.TOP}
      exclusivity={Astal.Exclusivity.NORMAL}
      keymode={tecladoActivo((activo) =>
        activo ? Astal.Keymode.ON_DEMAND : Astal.Keymode.NONE)}
      anchor={TOP | LEFT}
      application={app}
      widthRequest={ANCHO_MENU}
      marginTop={margenBajoBarra()}
      marginLeft={47}
      decorated={false}
      cssClasses={["fn-menu-window"]}
    >
      <Gtk.EventControllerKey
        onKeyPressed={(_self, tecla) => {
          if (tecla === Gdk.KEY_Escape) {
            setFunctionsMenuVisible(false)
            return true
          }
          return false
        }}
      />
      <box cssClasses={["fn-menu"]} orientation={Gtk.Orientation.VERTICAL}>
        <Gtk.EventControllerMotion onEnter={manejarEntrada} onLeave={autoCierre.onLeave} />
        {FUNCIONES_BARRA.map((funcion) => <FilaFuncion funcion={funcion} />)}
      </box>
    </window>
  )
}

export default function Funciones() {
  return (
    <button
      cssClasses={["bar-pill-btn", "own-functions-button"]}
      focusable={false}
      onClicked={alternarMenuFunciones}
    >
      <box
        cssClasses={["bar-pill", "own-functions"]}
        halign={Gtk.Align.CENTER}
        valign={Gtk.Align.CENTER}
      >
        <label label="󰣇" halign={Gtk.Align.CENTER} valign={Gtk.Align.CENTER} hexpand />
      </box>
    </button>
  )
}
