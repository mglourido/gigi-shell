import Gdk from "gi://Gdk"
import Graphene from "gi://Graphene"
import { Gtk } from "ags/gtk4"

import { barTopMargin } from "../../ajustes/preferences"

/** Alto de la ventana de la barra (el mismo `BAR_HEIGHT` de `Barra.tsx`). */
export const ALTO_BARRA = 38

/**
 * Hueco entre el borde inferior de la barra y TODO lo que flota colgando de ella:
 * títulos, menús de la bandeja y de juegos, popovers de CPU/RAM y de actualizaciones,
 * menú del logo y vista previa de escritorios. Un solo número para que salgan todos a
 * la misma altura.
 */
export const SEPARACION_BARRA = 3

/**
 * Margen superior de una ventana layer-shell que cuelga de la barra (menú del logo,
 * vista previa de escritorios). Sin autoocultado la barra es EXCLUSIVE y el compositor
 * ya baja la ventana por debajo de ella: ahí solo queda el hueco.
 */
export function margenBajoBarra() {
  return barTopMargin(ALTO_BARRA + SEPARACION_BARRA, SEPARACION_BARRA)
}

/**
 * Cuelga un popover de la barra a `SEPARACION_BARRA` de su borde inferior. Llámalo con
 * el popover YA emparentado y justo ANTES de abrirlo, en cada apertura.
 *
 * GtkPopover se ancla al borde inferior de su PADRE, y los iconos de la barra van
 * centrados en sus 38 px con alturas de 14 a 30 px: con un `set_offset` fijo cada menú
 * quedaba a una distancia distinta de la barra según lo alto que fuera su icono. Aquí
 * el rectángulo de anclaje (`pointing_to`, en coordenadas del padre) se estira hasta
 * cubrir la barra de arriba abajo, y así el offset es la separación real.
 *
 * Antes de abrir y no desde una señal del popover: `set_pointing_to` sobre un popover
 * visible lanza un `present_popup`, y en `gtk_popover_show` el flag de visible ya está
 * puesto cuando se emite `realize` — se presentaría dos veces.
 *
 * Con flecha, lo que queda a esa distancia es la PUNTA de la flecha (la cola forma parte
 * de la superficie del popover); sin ella, el borde de `contents` — la sombra no cuenta,
 * GTK la declara como `shadow_width` y queda fuera de la geometría de la ventana.
 */
export function colgarDeBarra(popover: Gtk.Popover) {
  popover.set_position(Gtk.PositionType.BOTTOM)
  popover.set_offset(0, SEPARACION_BARRA)
  const padre = popover.get_parent()
  const nativo = padre?.get_native() as Gtk.Widget | null | undefined
  if (!padre || !nativo) return
  // Un icono de la bandeja dentro de la rejilla de desbordamiento cuelga del popover
  // de esa rejilla, no de la barra: ahí se ancla a su propio icono.
  if (!(nativo instanceof Gtk.Window)) {
    if (popover.get_pointing_to()[0]) popover.set_pointing_to(null)
    return
  }
  const [traducido, punto] = padre.compute_point(nativo, new Graphene.Point({ x: 0, y: 0 }))
  if (!traducido) return
  const ancla = new Gdk.Rectangle({
    x: 0,
    y: -Math.round(punto.y),
    width: Math.max(1, padre.get_width()),
    height: ALTO_BARRA,
  })
  // Reponer el mismo rectángulo sobre un popover abierto lo recolocaría igualmente.
  const [tieneAncla, actual] = popover.get_pointing_to()
  if (tieneAncla && actual.equal(ancla)) return
  popover.set_pointing_to(ancla)
}
