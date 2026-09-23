import { For, createState } from "ags"
import { Astal, Gdk, Gtk } from "ags/gtk4"
import app from "ags/gtk4/app"
import { execAsync } from "ags/process"
import { closeAllPanels, panelAutoClose, powerMenuVisible } from "../../estado/shell"
import { crearCicloVida } from "../../utilidades/cicloVida"
import { accionesVisibles, type AccionEnergia } from "./acciones"
import { accionesEnergiaOcultas } from "../ajustes/preferences.ts"
import BotonAccion from "./BotonAccion"

export default function MenuEnergia(monitorGdk: Gdk.Monitor) {
  const cicloVida = crearCicloVida()
  const { TOP, BOTTOM, LEFT, RIGHT } = Astal.WindowAnchor
  const autoCierre = panelAutoClose(closeAllPanels, 300, powerMenuVisible)
  const [tecladoActivo, establecerTecladoActivo] = createState(false)

  cicloVida.suscribir(powerMenuVisible, () => establecerTecladoActivo(false))

  const manejarEntradaPuntero = () => {
    autoCierre.onEnter()
    establecerTecladoActivo(true)
  }

  const ejecutarAccion = (comando: string) => {
    execAsync(comando).catch((error) =>
      console.error(`Error en acción de energía: ${error}`)
    )
    closeAllPanels()
  }

  const panel = (
    <box
      cssClasses={["power-menu-container"]}
      orientation={Gtk.Orientation.VERTICAL}
      halign={Gtk.Align.CENTER}
      valign={Gtk.Align.CENTER}
    >
      <Gtk.EventControllerMotion
        onEnter={manejarEntradaPuntero}
        onLeave={autoCierre.onLeave}
      />
      {/* Indexado por id y no por identidad de objeto: las acciones son constantes, así
          que ocultar una solo retira su botón y no reconstruye los demás. */}
      <box cssClasses={["power-menu-strip"]} spacing={0} valign={Gtk.Align.CENTER}>
        <For
          each={accionesEnergiaOcultas((ocultas) => accionesVisibles(ocultas))}
          id={(accion: AccionEnergia) => accion.claseCss}
        >
          {(accion: AccionEnergia) => <BotonAccion accion={accion} ejecutar={ejecutarAccion} />}
        </For>
      </box>
    </box>
  ) as unknown as Gtk.Widget

  return (
    <window
      name="power-menu"
      visible={powerMenuVisible}
      gdkmonitor={monitorGdk}
      layer={Astal.Layer.OVERLAY}
      anchor={TOP | BOTTOM | LEFT | RIGHT}
      exclusivity={Astal.Exclusivity.IGNORE}
      keymode={tecladoActivo((activo) =>
        activo ? Astal.Keymode.ON_DEMAND : Astal.Keymode.NONE)}
      application={app}
      cssClasses={["power-window"]}
    >
      <Gtk.EventControllerKey
        onKeyPressed={(_self, tecla) => {
          if (tecla === Gdk.KEY_Escape) {
            closeAllPanels()
            return true
          }
          return false
        }}
      />
      <box cssClasses={["power-menu-overlay"]} hexpand vexpand>
        <Gtk.GestureClick
          onPressed={(gesto: Gtk.GestureClick, _numero: number, x: number, y: number) => {
            const fondo = gesto.get_widget() as Gtk.Widget
            const encontrado = fondo.pick(x, y, 0)
            let widget: Gtk.Widget | null = encontrado
            while (widget && widget !== fondo) {
              if (widget === panel) return
              widget = widget.get_parent()
            }
            closeAllPanels()
          }}
        />
        {panel as unknown as any}
      </box>
    </window>
  )
}
