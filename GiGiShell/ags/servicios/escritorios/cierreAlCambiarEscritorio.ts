import AstalHyprland from "gi://AstalHyprland"

import { setSettingsPanelVisible } from "../../estado/shell"
import { setNotifSettingsVisible } from "../../modulos/notificaciones/store"

let iniciado = false

/** Cierra las dos ventanas de ajustes (la general y la de notificaciones) cuando se
 * cambia de escritorio.
 *
 * Ambas son superficies layer-shell en la capa OVERLAY ancladas a los cuatro bordes:
 * NO pertenecen a ningún escritorio, así que al cambiar de workspace se quedan
 * tapando por completo el escritorio nuevo. Los paneles de la barra sí se cierran
 * solos al salir el ratón (`panelAutoClose`), pero estas dos no tienen ese gesto:
 * se cierran con Escape, con el clic en el backdrop o volviendo a pulsar su botón.
 *
 * Se escuchan las dos señales a propósito: `notify::focused-workspace` no salta al
 * cambiar de monitor enfocado teniendo el mismo workspace activo en cada uno, y el
 * evento crudo cubre `focusedmon` además de las dos variantes de `workspace`.
 * Cerrar dos veces es idempotente, así que el solape no molesta.
 */
export function iniciarCierreAjustesAlCambiarEscritorio(): void {
  if (iniciado) return
  iniciado = true
  const hypr = AstalHyprland.get_default()

  const cerrar = () => {
    setSettingsPanelVisible(false)
    setNotifSettingsVisible(false)
  }

  hypr.connect("event", (_origen: unknown, nombre: string) => {
    if (nombre === "workspace" || nombre === "workspacev2" || nombre === "focusedmon") cerrar()
  })
  hypr.connect("notify::focused-workspace", cerrar)
}
