import { Gtk } from "ags/gtk4"
import { claseColor, esEditable } from "../dominio/tipos.ts"
import { textoIntervalo } from "../dominio/agenda.ts"
import type { EventoEnDia } from "../dominio/agenda.ts"
import { abrirEdicion, borradoPendiente, eliminarEvento, establecerBorradoPendiente } from "../estado.ts"

/**
 * Una fila de la agenda.
 *
 * **Los controles de editar y borrar solo aparecen si el origen concede escritura.** Un evento de un
 * calendario de Google compartido en modo lectura se muestra igual que los demás —sigue siendo
 * información útil— pero sin botones: ofrecerlos y que la API respondiera 403 al pulsarlos sería
 * peor que no ofrecerlos.
 *
 * El borrado pide confirmación en la propia fila (`borradoPendiente`) en vez de abrir un diálogo:
 * el panel ya usa el overlay para el formulario, y anidar un segundo modal encima obliga a resolver
 * qué se cierra con Escape.
 */
export function TarjetaEvento({ item }: { item: EventoEnDia }): Gtk.Widget {
  const { evento } = item
  const editable = esEditable(evento)
  const pendiente = borradoPendiente((id) => id === evento.id)

  const detalles: Gtk.Widget[] = []
  if (evento.ubicacion) {
    detalles.push(
      <label
        cssClasses={["cal-event-desc"]}
        label={`󰍎  ${evento.ubicacion}`}
        halign={Gtk.Align.START}
        xalign={0}
        wrap
      /> as unknown as Gtk.Widget,
    )
  }
  if (evento.descripcion) {
    detalles.push(
      <label
        cssClasses={["cal-event-desc"]}
        label={evento.descripcion}
        halign={Gtk.Align.START}
        xalign={0}
        wrap
        maxWidthChars={40}
      /> as unknown as Gtk.Widget,
    )
  }

  return (
    <box cssClasses={["cal-agenda-event-row"]} spacing={8}>
      <box
        cssClasses={["cal-event-color-stripe", claseColor(evento.color)]}
        widthRequest={3}
      />
      <box orientation={Gtk.Orientation.VERTICAL} hexpand spacing={1}>
        <label cssClasses={["cal-event-title"]} label={evento.titulo} halign={Gtk.Align.START} xalign={0} wrap />
        <box spacing={6}>
          <label cssClasses={["cal-event-time"]} label={textoIntervalo(item)} halign={Gtk.Align.START} />
          <label
            cssClasses={["cal-event-origen"]}
            label={evento.origen === "google" ? "Google" : ""}
            visible={evento.origen === "google"}
          />
          <label
            cssClasses={["cal-event-solo-lectura"]}
            label="Solo lectura"
            visible={!editable}
            tooltipText="Este calendario no concede permisos de escritura"
          />
        </box>
        {detalles}
      </box>

      <box cssClasses={["cal-event-actions"]} spacing={2} valign={Gtk.Align.START} visible={editable}>
        <box visible={pendiente((p) => !p)} spacing={2}>
          <button cssClasses={["cal-icon-btn"]} tooltipText="Editar" onClicked={() => abrirEdicion(evento)}>
            <label label="󰏫" />
          </button>
          <button
            cssClasses={["cal-icon-btn"]}
            tooltipText="Eliminar"
            onClicked={() => establecerBorradoPendiente(evento.id)}
          >
            <label label="󰆴" />
          </button>
        </box>
        <box visible={pendiente} spacing={2}>
          <button
            cssClasses={["cal-icon-btn", "peligro"]}
            tooltipText="Confirmar eliminación"
            onClicked={() => eliminarEvento(evento.id)}
          >
            <label label="Eliminar" />
          </button>
          <button
            cssClasses={["cal-icon-btn"]}
            tooltipText="Cancelar"
            onClicked={() => establecerBorradoPendiente(null)}
          >
            <label label="✕" />
          </button>
        </box>
      </box>
    </box>
  ) as unknown as Gtk.Widget
}
