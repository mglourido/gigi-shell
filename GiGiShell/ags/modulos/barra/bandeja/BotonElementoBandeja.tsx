import AstalTray from "gi://AstalTray"
import type Gio from "gi://Gio"
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
  let grupoAccionesAplicado: Gio.ActionGroup | null | undefined

  const autoCierre = panelAutoClose(() => boton?.get_popover()?.popdown(), 250)

  const aplicarGrupoAcciones = (destino: Gtk.MenuButton) => {
    const grupo = elemento.actionGroup ?? null
    if (grupo === grupoAccionesAplicado) return
    grupoAccionesAplicado = grupo
    for (const nombre of NOMBRES_GRUPO_ACCIONES) {
      destino.insert_action_group(nombre, grupo)
      destino.get_popover()?.insert_action_group(nombre, grupo)
    }
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
    // Al remapear, GTK puede conservar el hover y enviar motion sin otro enter.
    // También debe cancelar el cierre pendiente al salir del icono hacia el menú.
    movimiento.connect("motion", autoCierre.onEnter)
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
    grupoAccionesAplicado = undefined
    boton = null
  })

  return (
    <menubutton
      cssClasses={["icon-bare", "tray-item"]}
      focusable={false}
      valign={Gtk.Align.CENTER}
      sensitive={createBinding(elemento, "menuModel")((modelo) => modelo !== null)}
      $={(self: Gtk.MenuButton) => {
        boton = self
        aplicarGrupoAcciones(self)
        configurarPopover(self)
        cicloVida.conectarSenales(elemento, ["notify::action-group"], () => {
          aplicarGrupoAcciones(self)
        })
        cicloVida.conectarSenales(self, ["notify::active"], () => {
          autoCierre.cancel()
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
      <Gtk.EventControllerMotion
        onEnter={autoCierre.onEnter}
        onMotion={autoCierre.onEnter}
        onLeave={autoCierre.onLeave}
      />
      {/* El menubutton abre su popover él solo, y `notify::active` llega DESPUÉS del
          popup: el ancla se recalcula aquí, en CAPTURE, antes del toggle. No reclama. */}
      <Gtk.GestureClick
        $={(gesto: Gtk.GestureClick) => gesto.set_propagation_phase(Gtk.PropagationPhase.CAPTURE)}
        onPressed={() => {
          const popover = boton?.get_popover()
          if (popover && !popover.get_visible()) colgarDeBarra(popover)
        }}
      />
      {/* Gtk.MenuButton sustituye su popover al cambiar menuModel y puede abrir el
          nuevo sin otro notify::active: se pierden los controladores y las acciones
          quedan ligadas al proveedor anterior. El popover conserva su superficie;
          GTK actualiza las filas y el tamaño al cambiar el modelo remoto. */}
      <Gtk.PopoverMenu menuModel={createBinding(elemento, "menuModel")} />
      <image gicon={createBinding(elemento, "gicon")} pixelSize={17} />
    </menubutton>
  )
}
