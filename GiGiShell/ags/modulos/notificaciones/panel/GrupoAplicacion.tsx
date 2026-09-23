import { Gtk } from "ags/gtk4"
import { createState, For, With, type Accessor } from "ags"
import { type StoredNotification } from "../store"
import ItemNotificacion from "./item/ItemNotificacion"

// El <For> de ListaAgrupada está indexado por `appName`, así que el grupo se
// construye UNA vez por aplicación y sobrevive a la llegada de notificaciones: sus
// notificaciones llegan por accessor, no como array fijo. Ese es justo el punto —
// antes el grupo se reconstruía entero en cada cambio del almacén y `plegado`, que
// es estado local, volvía a nacer desplegado.
export default function GrupoAplicacion({
  appName,
  notificaciones,
}: {
  appName: string
  notificaciones: Accessor<StoredNotification[]>
}) {
  const [plegado, setPlegado] = createState(false)
  const noLeidas = notificaciones((lista) =>
    lista.filter((notificacion) => !notificacion.read).length)

  return (
    <box orientation={Gtk.Orientation.VERTICAL} spacing={0} cssClasses={["np-app-group"]}>
      <button
        cssClasses={["np-group-header"]}
        onClicked={() => setPlegado(!plegado.get())}
      >
        <box spacing={6} valign={Gtk.Align.CENTER}>
          <label label={plegado((valor) => valor ? "󰅂" : "󰅀")} cssClasses={["np-group-chevron"]} />
          <label label={appName} cssClasses={["np-group-name"]} hexpand halign={Gtk.Align.START} />
          {/* Ranura fija en vez de `noLeidas > 0 && …`: la insignia aparece y
              desaparece sin que el grupo tenga que reconstruirse. */}
          <box cssClasses={["np-group-badge"]} visible={noLeidas((cantidad) => cantidad > 0)}>
            <label label={noLeidas((cantidad) => String(cantidad))} cssClasses={["np-group-count"]} />
          </box>
          <label
            label={notificaciones((lista) => `${lista.length}`)}
            cssClasses={["np-group-total"]}
          />
        </box>
      </button>

      {/* El contenido plegado se destruye para liberar sus widgets. La caja exterior
          conserva el punto de inserción al volver a desplegar el grupo. */}
      <box>
        <With value={plegado}>
          {(estaPlegado: boolean) => estaPlegado
            ? <box visible={false} />
            : (
              <box orientation={Gtk.Orientation.VERTICAL} spacing={2}>
                {/* Sin `id`, a propósito: el almacén sustituye el objeto de una
                    notificación al marcarla leída (`markRead`), y ese cambio de
                    identidad es lo que refresca su fila — mismo contrato que
                    `ListaPlana`. Lo que no debe reconstruirse es el GRUPO. */}
                <For each={notificaciones}>
                  {(notificacion: StoredNotification) => (
                    <ItemNotificacion notif={notificacion} />
                  )}
                </For>
              </box>
            )}
        </With>
      </box>
    </box>
  )
}
