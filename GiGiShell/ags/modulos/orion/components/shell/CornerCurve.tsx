import { onCleanup } from "ags"
import { Gtk } from "ags/gtk4"
import { fondoShell } from "../../../ajustes/preferences"
import { transparenciaSuspendida } from "../../../../servicios/energia/powerState"

const RADIO = 24
const GROSOR_BORDE = 0.5
const COLOR_NEGRO = [8, 12]
const COLOR_POR_TEMA: Record<string, number[]> = { grafito: [24, 32], gris: [32, 32] }

/**
 * Cuña que rellena el hueco entre el panel de Orion y su curva exterior, a
 * cada lado (`left`). Widget propio en vez de CSS `border-radius`: el hueco
 * necesita el color de fondo del shell, no un simple recorte del panel.
 */
export default function CornerCurve({ left = true }: { left?: boolean }): Gtk.DrawingArea {
  const area = new Gtk.DrawingArea()
  area.set_size_request(RADIO, RADIO)
  area.set_valign(Gtk.Align.END)
  area.set_css_classes(["orion-curva-lateral", left ? "izquierda" : "derecha"])

  area.set_draw_func((_area, cr, width, height) => {
    // La cuña es Cairo, no CSS: consulta la misma preferencia para no dejar una
    // esquina negra al cambiar el resto del shell a Grafito.
    const [rojoVerde, azul] = COLOR_POR_TEMA[fondoShell.get()] ?? COLOR_NEGRO
    cr.setSourceRGBA(rojoVerde / 255, rojoVerde / 255, azul / 255, transparenciaSuspendida.get() ? 1 : 0.94)

    if (left) {
      cr.moveTo(width, height)
      cr.lineTo(0, height)
      // Centro en (0, 0).
      cr.arcNegative(0, 0, RADIO, Math.PI / 2, 0)
      cr.lineTo(width, height)
    } else {
      cr.moveTo(0, height)
      cr.lineTo(width, height)
      // Centro en (width, 0).
      cr.arc(width, 0, RADIO, Math.PI / 2, Math.PI)
      cr.lineTo(0, height)
    }

    cr.closePath()
    cr.fill()

    // Solo se perfila el arco: cerrar el trazo dibujaría costuras contra el
    // panel y el borde de la pantalla. El color comparte el token CSS del filo.
    const borde = area.get_color()
    cr.setSourceRGBA(borde.red, borde.green, borde.blue, borde.alpha)
    cr.setLineWidth(GROSOR_BORDE)
    cr.newPath()
    if (left) cr.arcNegative(0, 0, RADIO, Math.PI / 2, 0)
    else cr.arc(width, 0, RADIO, Math.PI / 2, Math.PI)
    cr.stroke()
  })

  onCleanup(fondoShell.subscribe(() => area.queue_draw()))
  onCleanup(transparenciaSuspendida.subscribe(() => area.queue_draw()))

  return area
}
