import { createState, onCleanup, type Accessor } from "ags"
import { Gtk } from "ags/gtk4"
import GLib from "gi://GLib"
import { notifications } from "../../store"

// La expansión debe sobrevivir a `markRead`: esa operación reemplaza el objeto
// almacenado y AGS puede reconstruir el componente de la tarjeta.
const [idsExpandidos, establecerIdsExpandidos] = createState<Set<number>>(new Set())
const botonesNotificacion = new Map<number, Gtk.Button>()

// No conservar IDs de notificaciones que ya hayan sido eliminadas.
notifications.subscribe(() => {
  const idsValidos = new Set(notifications.get().map((notificacion) => notificacion.id))
  const actuales = idsExpandidos.get()
  if (![...actuales].some((id) => !idsValidos.has(id))) return
  establecerIdsExpandidos(new Set([...actuales].filter((id) => idsValidos.has(id))))
})

export interface EstadoExpansionItemNotificacion {
  expandida: Accessor<boolean>
  alternar: () => void
  registrarBoton: (boton: Gtk.Button) => void
  restaurarFoco: () => void
}

/** Agrupa el estado de expansión y foco que debe sobrevivir al reemplazo del item. */
export function usarExpansionItemNotificacion(id: number): EstadoExpansionItemNotificacion {
  const expandida = idsExpandidos((ids) => ids.has(id))
  let botonActual: Gtk.Button | null = null

  onCleanup(() => {
    if (botonActual && botonesNotificacion.get(id) === botonActual) {
      botonesNotificacion.delete(id)
    }
  })

  return {
    expandida,
    alternar: () => {
      const siguientes = new Set(idsExpandidos.get())
      if (siguientes.has(id)) siguientes.delete(id)
      else siguientes.add(id)
      establecerIdsExpandidos(siguientes)
    },
    registrarBoton: (boton) => {
      botonActual = boton
      botonesNotificacion.set(id, boton)
    },
    restaurarFoco: () => {
      // `markRead` puede reconstruir el botón. Esperar al siguiente ciclo garantiza
      // que el mapa ya apunte al widget nuevo, no al que acaba de ser destruido.
      GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        botonesNotificacion.get(id)?.grab_focus()
        return GLib.SOURCE_REMOVE
      })
    },
  }
}
