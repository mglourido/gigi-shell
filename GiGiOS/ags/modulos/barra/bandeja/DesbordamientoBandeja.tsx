import AstalTray from "gi://AstalTray"
import GLib from "gi://GLib"
import { For, type Accessor } from "ags"
import { Gtk } from "ags/gtk4"

import { panelAutoClose } from "../../../estado/shell"
import { crearCicloVida } from "../../../utilidades/cicloVida"
import { crearControlPopoverAnclado } from "../componentes/controlPopoverAnclado"
import BotonElementoBandeja from "./BotonElementoBandeja"
import { agruparEnFilas } from "./rejilla"
import type { ControlVisibilidadBarra } from "../../../estado/visibilidadBarra"

export default function DesbordamientoBandeja({
  elementos,
  visibilidad,
}: {
  elementos: Accessor<AstalTray.TrayItem[]>
  visibilidad: ControlVisibilidadBarra
}) {
  const cicloVida = crearCicloVida()
  const controlMenu = crearControlPopoverAnclado(visibilidad)
  let boton: Gtk.MenuButton | null = null
  let popover: Gtk.Popover | null = null
  let fuenteAnimacionCierre = 0
  let hijosAbiertos = 0
  let dentroDesbordamiento = false
  let eliminado = false

  const cancelarCierreAnimado = () => {
    if (fuenteAnimacionCierre) GLib.source_remove(fuenteAnimacionCierre)
    fuenteAnimacionCierre = 0
    popover?.remove_css_class("closing")
  }

  const cerrarAnimado = () => {
    if (eliminado || hijosAbiertos > 0) return
    const actual = popover
    if (!actual || !actual.get_visible() || fuenteAnimacionCierre) return
    actual.add_css_class("closing")
    fuenteAnimacionCierre = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 160, () => {
      fuenteAnimacionCierre = 0
      actual.remove_css_class("closing")
      if (!eliminado) actual.popdown()
      return GLib.SOURCE_REMOVE
    })
  }

  const autoCierre = panelAutoClose(cerrarAnimado, 250)
  const entrar = () => {
    dentroDesbordamiento = true
    cancelarCierreAnimado()
    autoCierre.onEnter()
  }
  const salir = () => {
    dentroDesbordamiento = false
    autoCierre.onLeave()
  }
  const alCambiarMenuHijo = (abierto: boolean) => {
    if (eliminado) return
    hijosAbiertos = Math.max(0, hijosAbiertos + (abierto ? 1 : -1))
    if (!abierto && hijosAbiertos === 0 && !dentroDesbordamiento) autoCierre.onLeave()
  }

  const filas = elementos((lista) => agruparEnFilas(lista, 4))
  const rejilla = (
    <box orientation={Gtk.Orientation.VERTICAL} spacing={2} cssClasses={["tray-overflow-grid"]}>
      <Gtk.EventControllerMotion onEnter={entrar} onLeave={salir} />
      <For each={filas}>
        {(elementosFila) => (
          <box spacing={2}>
            {elementosFila.map((elemento) => (
              <BotonElementoBandeja
                elemento={elemento}
                visibilidad={visibilidad}
                alCambiarMenu={alCambiarMenuHijo}
              />
            ))}
          </box>
        )}
      </For>
    </box>
  )

  cicloVida.registrar(() => {
    eliminado = true
    autoCierre.dispose()
    cancelarCierreAnimado()
    if (popover) {
      try { popover.popdown() } catch (_) {}
    }
    controlMenu.cerrar()
    if (boton) {
      try { boton.set_popover(null) } catch (_) {}
    }
    popover = null
    boton = null
    hijosAbiertos = 0
  })

  return (
    <menubutton
      cssClasses={["icon-bare", "tray-item", "tray-overflow"]}
      focusable={false}
      valign={Gtk.Align.CENTER}
      $={(self: Gtk.MenuButton) => {
        boton = self
        const menu = new Gtk.Popover({
          has_arrow: false,
          autohide: false,
          child: rejilla,
        })
        menu.add_css_class("tray-popover")
        menu.add_css_class("tray-overflow-popover")
        menu.set_offset(0, 8)  // despeja la barra, igual que el menú de cada icono
        menu.connect("closed", () => {
          cancelarCierreAnimado()
          controlMenu.cerrar()
        })
        popover = menu
        self.set_popover(menu)
        cicloVida.conectarSenales(self, ["notify::active"], () =>
          controlMenu.establecer(self.active),
        )
      }}
    >
      <Gtk.EventControllerMotion onEnter={entrar} onLeave={salir} />
      <Gtk.GestureClick
        $={(gesture: Gtk.GestureClick) => gesture.set_propagation_phase(Gtk.PropagationPhase.CAPTURE)}
        onPressed={(gesture: Gtk.GestureClick) => {
          if (controlMenu.estaAbierto() && hijosAbiertos === 0) {
            cerrarAnimado()
            gesture.set_state(Gtk.EventSequenceState.CLAIMED)
          } else {
            gesture.set_state(Gtk.EventSequenceState.DENIED)
          }
        }}
      />
      <label cssClasses={["tray-overflow-chevron"]} label={"\uf054"} />
    </menubutton>
  )
}
