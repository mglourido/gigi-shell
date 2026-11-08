import AstalHyprland from "gi://AstalHyprland"

type Hyprland = ReturnType<typeof AstalHyprland.get_default>

/** Id del escritorio enfocado. Úsese EN VEZ de `hyprland.focused_workspace`.
 *
 *  Reordenar escritorios desde la barra los renumera con `change_id`
 *  (`operaciones.ts`), y Hyprland no emite ningún evento de foco por ello: el
 *  escritorio que se ve es el mismo, solo cambia su número. AstalHyprland solo
 *  actualiza `focused_workspace` con esos eventos, así que se queda con el
 *  número VIEJO hasta el siguiente cambio de escritorio (medido). El escritorio
 *  activo del monitor enfocado sí se corrige, con `sync_monitors`. Forzar un
 *  evento de foco de verdad tampoco sirve: es un cambio de escritorio real y la
 *  pantalla parpadea (medido, con y sin animaciones).
 *
 *  Con un escritorio especial abierto da el normal que hay debajo: el especial
 *  va aparte, en `special_workspace` del monitor. */
export function idEscritorioEnfocado(
  hyprland: Hyprland = AstalHyprland.get_default(),
): number | null {
  try {
    const id = hyprland.get_focused_monitor()?.get_active_workspace()?.get_id()
      ?? hyprland.get_focused_workspace()?.get_id()
    return typeof id === "number" ? id : null
  } catch (_) {
    return null
  }
}
