import { Gtk } from "ags/gtk4"
import { onCleanup } from "ags"
import { crearReconstruccionCoalescida } from "../../../utilidades/coalescer.ts"
import { formatearFechaLarga } from "../dominio/fechas.ts"
import { abrirCreacion, agendaSeleccionada, fechaSeleccionada, hoyReactivo } from "../estado.ts"
import { TarjetaEvento } from "./TarjetaEvento.tsx"

/**
 * Agenda del día seleccionado, a la derecha de la vista mensual.
 *
 * Se reconstruye entera al cambiar el día o los eventos, por lo mismo que la rejilla: las filas son
 * widgets sin estado y una lista reactiva por identidad de objeto es justo el patrón que en este
 * proyecto acabó destruyendo widgets con el foco dentro.
 *
 * Las suscripciones comparten una sola reconstrucción coalescida: `agendaSeleccionada` deriva de
 * `fechaSeleccionada`, así que cambiar de día avisaba dos veces y la primera pasada leía la agenda
 * del día anterior. Mismo motivo que en `VistaMes` — ver `utilidades/coalescer.ts`.
 */
export function AgendaDia(): Gtk.Widget {
  const lista = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 4 })
  lista.set_css_classes(["cal-agenda-day-events"])

  const titulo = new Gtk.Label({ label: "" })
  titulo.set_css_classes(["cal-agenda-title"])
  titulo.set_halign(Gtk.Align.START)
  titulo.set_xalign(0)
  titulo.set_wrap(true)

  const subtitulo = new Gtk.Label({ label: "" })
  subtitulo.set_css_classes(["cal-agenda-subtitulo"])
  subtitulo.set_halign(Gtk.Align.START)
  subtitulo.set_xalign(0)

  function reconstruir() {
    const fecha = fechaSeleccionada.get()
    const items = agendaSeleccionada.get()

    titulo.set_label(formatearFechaLarga(fecha))
    subtitulo.set_label(
      fecha === hoyReactivo.get()
        ? items.length === 0 ? "Hoy · sin eventos" : `Hoy · ${items.length} evento${items.length === 1 ? "" : "s"}`
        : items.length === 0 ? "Sin eventos" : `${items.length} evento${items.length === 1 ? "" : "s"}`,
    )

    let hijo = lista.get_first_child()
    while (hijo) {
      const siguiente = hijo.get_next_sibling()
      lista.remove(hijo)
      hijo = siguiente
    }

    if (items.length === 0) {
      lista.append(
        (
          <box cssClasses={["cal-agenda-empty"]} orientation={Gtk.Orientation.VERTICAL} spacing={6} valign={Gtk.Align.CENTER} vexpand>
            <label cssClasses={["cal-empty-icon"]} label="󰃭" />
            <label cssClasses={["cal-empty-title"]} label="Nada para este día" />
          </box>
        ) as unknown as Gtk.Widget,
      )
      return
    }

    for (const item of items) lista.append(TarjetaEvento({ item }))
  }

  const repintado = crearReconstruccionCoalescida(reconstruir)
  const bajas = [
    fechaSeleccionada.subscribe(repintado.programar),
    agendaSeleccionada.subscribe(repintado.programar),
    hoyReactivo.subscribe(repintado.programar),
  ]
  onCleanup(() => {
    repintado.cancelar()
    for (const baja of bajas) if (typeof baja === "function") baja()
  })
  repintado.ahora()

  return (
    <box cssClasses={["cal-agenda-view"]} orientation={Gtk.Orientation.VERTICAL} spacing={0}>
      <box cssClasses={["cal-agenda-header"]} spacing={8}>
        <box orientation={Gtk.Orientation.VERTICAL} spacing={2} hexpand valign={Gtk.Align.CENTER}>
          {titulo}
          {subtitulo}
        </box>
        <button
          cssClasses={["cal-icon-btn", "primario"]}
          valign={Gtk.Align.CENTER}
          onClicked={() => abrirCreacion(fechaSeleccionada.get())}
        >
          <label label="＋" />
        </button>
      </box>
      <Gtk.ScrolledWindow
        vexpand
        hscrollbarPolicy={Gtk.PolicyType.NEVER}
        vscrollbarPolicy={Gtk.PolicyType.AUTOMATIC}
      >
        {lista}
      </Gtk.ScrolledWindow>
    </box>
  ) as unknown as Gtk.Widget
}
