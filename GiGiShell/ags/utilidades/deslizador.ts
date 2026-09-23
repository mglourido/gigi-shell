import { Gtk } from "ags/gtk4"

/**
 * Conecta un Gtk.Scale sin permitir que la rueda o el desplazamiento del
 * touchpad cambien su valor. Deshabilitar el controlador interno, en vez de
 * interceptar su señal, deja que el evento llegue al contenedor desplazable.
 */
export function conectarCambioDeslizador(
  escala: Gtk.Scale,
  alCambiar: (valor: number) => void,
) {
  const controladores = escala.observe_controllers()
  for (let indice = 0; indice < controladores.get_n_items(); indice++) {
    const controlador = controladores.get_item(indice)
    if (controlador instanceof Gtk.EventControllerScroll) {
      controlador.set_propagation_phase(Gtk.PropagationPhase.NONE)
      break
    }
  }

  escala.connect("change-value", (_escala, _tipo, valor) => {
    alCambiar(valor)
    return false
  })
}
