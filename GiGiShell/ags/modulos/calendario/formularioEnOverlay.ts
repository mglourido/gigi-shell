import { Gtk } from "ags/gtk4"
import { createRoot } from "ags"

/**
 * Monta y desmonta un formulario (evento o alarma) como capa de un `Gtk.Overlay`.
 *
 * **Cada formulario se construye en su propio ámbito (`createRoot`), y no es opcional** (issue
 * #343). El montaje se dispara desde la suscripción al estado de edición, o sea desde un `set`
 * hecho en un `onClicked`: ahí `Scope.current` es `null`, y cada `onCleanup` que registra el JSX
 * de gnim daba `ags-CRITICAL … out of tracking context: will not be able to cleanup` y se perdía —
 * las señales y suscripciones del formulario no se daban de baja nunca. Usar el ámbito del panel
 * (`getScope().run`) apagaría el aviso pero acumularía los `onCleanup` de cada apertura hasta que
 * se destruyera el panel. Mismo razonamiento que `utilidades/coalescer.ts`.
 */
export function crearFormularioEnOverlay(overlay: Gtk.Overlay) {
  let vivo: Gtk.Widget | null = null
  let desecharAmbito: (() => void) | null = null

  function desmontar(): void {
    if (vivo) {
      overlay.remove_overlay(vivo)
      vivo = null
    }
    desecharAmbito?.()
    desecharAmbito = null
  }

  /** Sustituye el formulario actual por el que devuelva `construir`. */
  function montar(construir: () => Gtk.Widget): void {
    desmontar()
    const formulario = createRoot((desechar) => {
      desecharAmbito = desechar
      return construir()
    })
    // El fondo oscurecido se estira A MANO: un hijo de `Gtk.Overlay` se mide por su tamaño
    // natural, así que sin esto el velo solo cubría la tarjeta y el resto del panel seguía
    // pareciendo pulsable.
    formulario.set_hexpand(true)
    formulario.set_vexpand(true)
    formulario.set_halign(Gtk.Align.FILL)
    formulario.set_valign(Gtk.Align.FILL)
    overlay.add_overlay(formulario)
    vivo = formulario
  }

  return { montar, desmontar }
}
