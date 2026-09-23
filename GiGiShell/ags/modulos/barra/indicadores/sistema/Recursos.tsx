import { Gtk, Gdk } from "ags/gtk4"
import { execAsync } from "ags/process"
import { panelAutoClose } from "../../../../estado/shell"
import {
  adquirirDetalleProcesos,
  adquirirMetricas,
  procesoCpu,
  procesoRam,
  ramUsadaGiB,
  usoCpu,
} from "../../../../servicios/sistema/recursos"
import { crearCicloVida } from "../../../../utilidades/cicloVida"
import { colgarDeBarra } from "../../componentes/anclaBarra"
import { crearControlPopoverAnclado } from "../../componentes/controlPopoverAnclado"
import type { ControlVisibilidadBarra } from "../../../../estado/visibilidadBarra"

export default function Recursos({ visibilidad }: { visibilidad: ControlVisibilidadBarra }) {
  const cicloVida = crearCicloVida()
  const controlMenu = crearControlPopoverAnclado(visibilidad)
  let popoverActivo: Gtk.Popover | null = null
  let etiquetaCpu: Gtk.Label | null = null
  let etiquetaRam: Gtk.Label | null = null
  let soltarMetricas: (() => void) | null = null
  let soltarDetalle: (() => void) | null = null

  const autoCierre = panelAutoClose(() => { if (popoverActivo) popoverActivo.popdown() }, 250)

  const finalizarPopover = (popover: Gtk.Popover) => {
    if (popoverActivo !== popover) return
    popoverActivo = null
    etiquetaCpu = null
    etiquetaRam = null
    soltarDetalle?.()
    soltarDetalle = null
    controlMenu.cerrar()
    try { popover.unparent() } catch (_) {}
  }

  cicloVida.suscribir(procesoCpu, (texto) => etiquetaCpu?.set_label(texto))
  cicloVida.suscribir(procesoRam, (texto) => etiquetaRam?.set_label(texto))

  const sincronizarConsumo = () => {
    if (visibilidad.refrescar.get()) {
      if (!soltarMetricas) soltarMetricas = adquirirMetricas()
    } else {
      soltarMetricas?.()
      soltarMetricas = null
    }
  }
  cicloVida.suscribir(visibilidad.refrescar, sincronizarConsumo)
  sincronizarConsumo()
  cicloVida.registrar(() => {
    soltarMetricas?.()
    soltarMetricas = null
    soltarDetalle?.()
    soltarDetalle = null
    autoCierre.dispose()
    const popover = popoverActivo
    if (popover) {
      try { popover.popdown() } catch (_) {}
      finalizarPopover(popover)
    }
    controlMenu.cerrar()
  })

  const construirTarjeta = () => {
    const tarjeta = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 0 })
    tarjeta.add_css_class("cpuram-popup")

    const movimiento = new Gtk.EventControllerMotion()
    movimiento.connect("enter", autoCierre.onEnter)
    movimiento.connect("leave", autoCierre.onLeave)
    tarjeta.add_controller(movimiento)

    const cabecera = new Gtk.Label({ label: "Procesos top", xalign: 0 })
    cabecera.add_css_class("cpuram-popup-header")
    tarjeta.append(cabecera)

    const crearFila = (icono: string, tipo: string, texto: string) => {
      const fila = new Gtk.Box({ spacing: 8 })
      fila.add_css_class("cpuram-popup-row")
      const iconoLabel = new Gtk.Label({ label: icono })
      iconoLabel.add_css_class("cpuram-popup-ic")
      iconoLabel.add_css_class(tipo)
      const valor = new Gtk.Label({ label: texto, xalign: 0 })
      valor.add_css_class("cpuram-popup-val")
      fila.append(iconoLabel)
      fila.append(valor)
      tarjeta.append(fila)
      return valor
    }

    etiquetaCpu = crearFila("󰻠", "cpu", procesoCpu.get())
    etiquetaRam = crearFila("󰍛", "ram", procesoRam.get())
    return tarjeta
  }

  const alternarPopover = (ancla: Gtk.Widget) => {
    if (popoverActivo) {
      popoverActivo.popdown()
      return
    }

    const popover = new Gtk.Popover()
    popover.add_css_class("cpuram-popover")
    popover.set_has_arrow(true)
    popover.set_autohide(false)
    popover.set_child(construirTarjeta())
    popover.set_parent(ancla)
    colgarDeBarra(popover)
    popoverActivo = popover
    soltarDetalle = adquirirDetalleProcesos()
    controlMenu.abrir()

    popover.connect("closed", () => finalizarPopover(popover))
    popover.popup()
  }

  return (
    <box cssClasses={["bar-pill", "cpuram"]} spacing={3}>
      <Gtk.EventControllerMotion onEnter={autoCierre.onEnter} onLeave={autoCierre.onLeave} />
      <Gtk.GestureClick
        button={Gdk.BUTTON_PRIMARY}
        onPressed={(gesto: any) => alternarPopover((gesto as Gtk.GestureClick).get_widget())}
      />
      <Gtk.GestureClick
        button={Gdk.BUTTON_SECONDARY}
        onPressed={() => execAsync("kitty --class floating_terminal -e btop").catch(console.error)}
      />
      <label cssClasses={["icon"]} label="󰻠" />
      <label cssClasses={["label"]} label={usoCpu((uso) => `${uso}%`)} />
      <label cssClasses={["icon", "icon-sep"]} label="󰍛" />
      <label cssClasses={["label"]} label={ramUsadaGiB((ram) => `${ram}G`)} />
    </box>
  )
}
