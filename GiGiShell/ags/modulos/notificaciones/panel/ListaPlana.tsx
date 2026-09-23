import { Gtk } from "ags/gtk4"
import { createComputed, createState, For, onCleanup, type Accessor } from "ags"
import {
  activeAppFilter,
  notifications,
  type StoredNotification,
} from "../store"
import ItemNotificacion from "./item/ItemNotificacion"

export interface PropiedadesListaNotificaciones {
  conservarScroll: (actualizar: () => void) => void
  limite: Accessor<number>
}

export default function ListaPlana({
  conservarScroll,
  limite,
}: PropiedadesListaNotificaciones) {
  // Este componente solo existe mientras el panel está abierto en modo lista.
  const [lista, setLista] = createState<StoredNotification[]>(
    notifications.get().slice().reverse(),
  )
  onCleanup(notifications.subscribe(() => {
    conservarScroll(() => setLista(notifications.get().slice().reverse()))
  }))

  // `slice` conserva la identidad usada por <For>; ampliar el límite no reconstruye filas.
  const montadas = createComputed([lista, limite], (notificaciones, cantidad) =>
    notificaciones.slice(0, cantidad))

  return (
    <box orientation={Gtk.Orientation.VERTICAL} spacing={2}>
      <For each={montadas}>
        {(notificacion: StoredNotification) => (
          <box visible={activeAppFilter((filtro) =>
            filtro === "all" || filtro === notificacion.appName)}>
            <ItemNotificacion notif={notificacion} />
          </box>
        )}
      </For>
    </box>
  )
}
