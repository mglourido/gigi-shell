// GTK4 no distingue clic simple de doble clic en la señal "clicked": ambos la
// disparan, el segundo justo después del primero. Tres sitios de Orion
// necesitaban "un clic abre el contexto, doble clic lanza directo" (filas de
// Apps, resultados de la búsqueda reactiva, tarjetas de Inicio) y cada uno
// reimplementaba el mismo guardián por su cuenta.

import { Gtk } from "ags/gtk4"
import GLib from "gi://GLib"

const VENTANA_SUPRESION_MS = 350

/**
 * Engancha un `Gtk.GestureClick` en fase CAPTURE que detecta el doble clic y
 * ejecuta `alDobleClic`. Devuelve `estaSuprimido()`, que el handler de
 * "clicked" del botón debe consultar (y que se autolimpia al leerla) antes de
 * ejecutar su propia acción de clic simple.
 *
 * La supresión también se libera por temporizador y no solo al consultarla:
 * Orion puede ocultarse antes de que GTK emita el "clicked" final del segundo
 * clic, y sin el temporizador la guarda se quedaría en `true` para el
 * siguiente clic tras reabrir el panel.
 *
 * `puedeActivar` deja que el llamador vete el doble clic sin perder la
 * detección (p. ej. Inicio, que ignora el gesto mientras hay un
 * arrastre en curso).
 */
export function activarDobleClic(
  boton: Gtk.Button,
  alDobleClic: () => void,
  puedeActivar: () => boolean = () => true,
): () => boolean {
  let suprimido = false
  const gesto = new Gtk.GestureClick()
  gesto.set_button(1)
  gesto.propagation_phase = Gtk.PropagationPhase.CAPTURE
  gesto.connect("pressed", (_gesto, pulsaciones) => {
    if (pulsaciones !== 2 || !puedeActivar()) return
    suprimido = true
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, VENTANA_SUPRESION_MS, () => {
      suprimido = false
      return GLib.SOURCE_REMOVE
    })
    alDobleClic()
  })
  boton.add_controller(gesto)

  return () => {
    const estaba = suprimido
    suprimido = false
    return estaba
  }
}
