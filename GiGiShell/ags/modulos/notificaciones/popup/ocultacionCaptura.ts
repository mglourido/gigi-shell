/**
 * Oculta la pila de popups mientras se hace una captura de pantalla completa.
 *
 * Lo pide `hypr/scripts/captura-pantalla.sh` (SUPER+X) con dos requests, uno antes y otro
 * después de `hyprshot`. La vía «limpia» —la regla de capa `no_screen_share` de Hyprland—
 * NO sirve: medido con grim, el compositor no omite la capa sino que pinta un rectángulo
 * NEGRO en su lugar.
 *
 * Solo se oculta la VENTANA, no se toca la pila: los avisos siguen contando su tiempo y lo
 * que llegue durante la captura (el propio «captura guardada» de hyprshot) aparece al volver.
 *
 * Si el script muere entre los dos requests, los popups se quedarían ocultos para siempre
 * sin nada que lo enseñe; de ahí el tope de seguridad, que los devuelve solo.
 */

import { createState } from "ags"
import GLib from "gi://GLib"

const TOPE_OCULTACION_MS = 5000

const [popupsOcultosPorCaptura, setOcultos] = createState(false)
export { popupsOcultosPorCaptura }

let temporizadorTope: number | null = null

function cancelarTope(): void {
  if (temporizadorTope === null) return
  GLib.source_remove(temporizadorTope)
  temporizadorTope = null
}

export function ocultarPopupsParaCaptura(): void {
  cancelarTope()
  temporizadorTope = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TOPE_OCULTACION_MS, () => {
    temporizadorTope = null
    setOcultos(false)
    return GLib.SOURCE_REMOVE
  })
  setOcultos(true)
}

export function mostrarPopupsTrasCaptura(): void {
  cancelarTope()
  setOcultos(false)
}
