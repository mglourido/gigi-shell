import { onCleanup } from "ags"
import { Gtk } from "ags/gtk4"
import cairo from "gi://cairo"
import type { EstadoVisibilidadBarra } from "../../../../estado/visibilidadBarra"
import { estadoSpotify } from "../../../../servicios/multimedia/mpris"
import { bordeRgbCaratulaSpotify } from "../../../ajustes/preferences"
import { COLORES_ONDA_RGB } from "./coloresOnda"

const TRAZO = 1
const RADIO = 6
const VUELTA_SEGUNDOS = 8
const FPS_MAXIMO = 30

/** Capa sin entrada ni tamaño propio, animada por el reloj existente de la onda. */
export function crearBordeCaratulaSpotify(visibilidad: EstadoVisibilidadBarra) {
  let fase = 0
  let acumulado = 0
  let degradadoDisponible = true
  let desmontado = false
  const widget = new Gtk.DrawingArea({ visible: false, canTarget: false })

  widget.set_draw_func((_area, cr, ancho, alto) => {
    if (ancho <= TRAZO || alto <= TRAZO) return
    const centroX = ancho / 2
    const centroY = alto / 2
    const angulo = fase * Math.PI * 2
    const alcance = Math.max(ancho, alto) / 2
    const dx = Math.cos(angulo) * alcance
    const dy = Math.sin(angulo) * alcance
    const inicial = COLORES_ONDA_RGB[0]
    cr.setSourceRGBA(inicial[0], inicial[1], inicial[2], 0.9)
    if (degradadoDisponible) {
      try {
        const degradado = new (cairo as any).LinearGradient(centroX - dx, centroY - dy, centroX + dx, centroY + dy)
        for (let indice = 0; indice <= COLORES_ONDA_RGB.length; indice++) {
          const color = COLORES_ONDA_RGB[indice % COLORES_ONDA_RGB.length]
          degradado.addColorStopRGBA(indice / COLORES_ONDA_RGB.length, color[0], color[1], color[2], 0.9)
        }
        cr.setSource(degradado)
      } catch (_) {
        // Un binding sin gradientes degrada a borde fijo y deja de animar.
        degradadoDisponible = false
      }
    }

    const mitad = TRAZO / 2
    const radio = Math.min(RADIO - mitad, (ancho - TRAZO) / 2, (alto - TRAZO) / 2)
    const derecha = ancho - mitad
    const abajo = alto - mitad
    cr.setLineWidth(TRAZO)
    cr.newPath()
    cr.arc(derecha - radio, mitad + radio, radio, -Math.PI / 2, 0)
    cr.arc(derecha - radio, abajo - radio, radio, 0, Math.PI / 2)
    cr.arc(mitad + radio, abajo - radio, radio, Math.PI / 2, Math.PI)
    cr.arc(mitad + radio, mitad + radio, radio, Math.PI, Math.PI * 1.5)
    cr.closePath()
    cr.stroke()
  })

  const sincronizar = () => {
    const mostrar = bordeRgbCaratulaSpotify.get()
      && estadoSpotify.get()?.reproduciendo === true && visibilidad.visible.get()
    if (widget.get_visible() === mostrar) return
    widget.set_visible(mostrar)
    acumulado = 0
  }

  const cancelarAjuste = bordeRgbCaratulaSpotify.subscribe(sincronizar)
  const cancelarSpotify = estadoSpotify.subscribe(sincronizar)
  const cancelarVisibilidad = visibilidad.visible.subscribe(sincronizar)
  sincronizar()

  onCleanup(() => {
    desmontado = true
    cancelarAjuste()
    cancelarSpotify()
    cancelarVisibilidad()
  })

  return {
    widget,
    animar(delta: number) {
      if (desmontado || !widget.get_visible() || !degradadoDisponible) return
      fase = (fase + delta / VUELTA_SEGUNDOS) % 1
      acumulado += delta
      if (acumulado < 1 / FPS_MAXIMO) return
      acumulado %= 1 / FPS_MAXIMO
      widget.queue_draw()
    },
  }
}
