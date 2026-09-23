import AstalTray from "gi://AstalTray"
import { createBinding } from "ags"
import { Gtk } from "ags/gtk4"

import { crearCicloVida } from "../../../utilidades/cicloVida"
import { panelAutoClose } from "../../../estado/shell"
import { colgarDeBarra } from "../componentes/anclaBarra"
import { crearControlPopoverAnclado } from "../componentes/controlPopoverAnclado"
import { limitarMenuBandeja } from "./limitesMenu"
import type { ControlVisibilidadBarra } from "../../../estado/visibilidadBarra"

const NOMBRES_GRUPO_ACCIONES = ["dbusmenu", "tray", "indicator", "item", "app", "unity"]

export interface PropiedadesBotonElementoBandeja {
  elemento: AstalTray.TrayItem
  visibilidad: ControlVisibilidadBarra
  alCambiarMenu?: (abierto: boolean) => void
}

/** Un icono StatusNotifierItem y su menú GTK nativo. El modelo D-Bus se entrega
 * directamente a GTK para que los GVariant no pasen por memoria administrada JS. */
export default function BotonElementoBandeja({
  elemento,
  visibilidad,
  alCambiarMenu,
}: PropiedadesBotonElementoBandeja) {
  const cicloVida = crearCicloVida()
  const controlMenu = crearControlPopoverAnclado(visibilidad, alCambiarMenu)
  let boton: Gtk.MenuButton | null = null
  let popoverConfigurado: Gtk.Popover | null = null
  let limpiarLimites: (() => void) | null = null

  const autoCierre = panelAutoClose(() => boton?.get_popover()?.popdown(), 250)

  const aplicarGrupoAcciones = (destino: Gtk.MenuButton) => {
    const grupo = elemento.actionGroup ?? null
    for (const nombre of NOMBRES_GRUPO_ACCIONES) destino.insert_action_group(nombre, grupo)
  }

  const configurarPopover = (destino: Gtk.MenuButton) => {
    const popover = destino.get_popover()
    if (!popover) return
    popover.add_css_class("tray-popover")
    popover.set_has_arrow(false)
    popover.set_autohide(false)
    colgarDeBarra(popover)

    if (popoverConfigurado === popover) return
    if (popoverConfigurado) controlMenu.cerrar()
    limpiarLimites?.()
    limpiarLimites = limitarMenuBandeja(popover)
    popoverConfigurado = popover
    const movimiento = new Gtk.EventControllerMotion()
    movimiento.connect("enter", autoCierre.onEnter)
    movimiento.connect("leave", autoCierre.onLeave)
    popover.add_controller(movimiento)
    popover.connect("closed", () => {
      // Un cambio de menuModel puede sustituir el popover antes de que el viejo
      // termine de cerrar. Ese evento tardío no pertenece al menú actual.
      if (boton?.get_popover() === popover) controlMenu.cerrar()
    })
  }

  cicloVida.registrar(() => {
    autoCierre.dispose()
    if (boton?.get_popover()) {
      try { boton.get_popover()?.popdown() } catch (_) {}
    }
    controlMenu.cerrar()
    limpiarLimites?.()
    limpiarLimites = null
    popoverConfigurado = null
    boton = null
  })

  return (
    <menubutton
      cssClasses={["icon-bare", "tray-item"]}
      focusable={false}
      valign={Gtk.Align.CENTER}
      menuModel={createBinding(elemento, "menuModel")}
      $={(self: Gtk.MenuButton) => {
        boton = self
        aplicarGrupoAcciones(self)
        configurarPopover(self)
        cicloVida.conectarSenales(self, ["notify::active"], () => {
          if (!self.active) {
            controlMenu.cerrar()
            return
          }
          aplicarGrupoAcciones(self)
          configurarPopover(self)
          try { elemento.about_to_show() } catch (_) {}
          controlMenu.abrir()
        })
      }}
    >
      <Gtk.EventControllerMotion onEnter={autoCierre.onEnter} onLeave={autoCierre.onLeave} />
      {/* El menubutton abre su popover él solo, y `notify::active` llega DESPUÉS del
          popup: el ancla se recalcula aquí, en CAPTURE, antes del toggle. No reclama. */}
      <Gtk.GestureClick
        $={(gesto: Gtk.GestureClick) => gesto.set_propagation_phase(Gtk.PropagationPhase.CAPTURE)}
        onPressed={() => {
          const popover = boton?.get_popover()
          if (popover && !popover.get_visible()) colgarDeBarra(popover)
        }}
      />
      <image gicon={createBinding(elemento, "gicon")} pixelSize={17} />
    </menubutton>
  )
}
