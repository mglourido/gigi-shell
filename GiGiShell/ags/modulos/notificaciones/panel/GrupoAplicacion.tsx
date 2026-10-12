import { Gtk } from "ags/gtk4"
import { createState, For, With, type Accessor } from "ags"
import Pango from "gi://Pango"
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
  const [contenidoMontado, setContenidoMontado] = createState(true)

  function alternarPlegado(): void {
    const siguiente = !plegado.get()
    // Montar antes de abrir permite medir la altura real del contenido.
    if (!siguiente) setContenidoMontado(true)
    setPlegado(siguiente)
  }

  return (
    <box orientation={Gtk.Orientation.VERTICAL} spacing={0} cssClasses={["np-app-group"]} hexpand>
      <button
        cssClasses={["np-group-header"]}
        onClicked={alternarPlegado}
      >
        <box spacing={6} valign={Gtk.Align.CENTER}>
          <label
            label="󰅂"
            cssClasses={plegado((valor) => valor
              ? ["np-group-chevron"]
              : ["np-group-chevron", "expanded"])}
            valign={Gtk.Align.CENTER}
          />
          <label
            label={appName}
            cssClasses={["np-group-name"]}
            hexpand
            xalign={0}
            ellipsize={Pango.EllipsizeMode.END}
          />
          <box cssClasses={["np-group-badge"]} valign={Gtk.Align.CENTER}>
            <label
              label={notificaciones((lista) => String(lista.length))}
              cssClasses={["np-group-count"]}
            />
          </box>
        </box>
      </button>

      {/* Desmontar solo al terminar el cierre: hacerlo al pulsar corta la animación.
          Al invertirla, el contenido sigue montado y GTK continúa desde su altura actual. */}
      <Gtk.Revealer
        revealChild={plegado((valor) => !valor)}
        transitionType={Gtk.RevealerTransitionType.SLIDE_DOWN}
        transitionDuration={140}
        onNotifyChildRevealed={(self) => {
          if (plegado.get() && !self.get_reveal_child() && !self.get_child_revealed()) {
            setContenidoMontado(false)
          }
        }}
      >
        <box orientation={Gtk.Orientation.VERTICAL} spacing={0}>
          <With value={contenidoMontado}>
            {(estaMontado: boolean) => estaMontado && (
              <box orientation={Gtk.Orientation.VERTICAL} spacing={0}>
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
      </Gtk.Revealer>
    </box>
  )
}
