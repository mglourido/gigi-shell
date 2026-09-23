import { Gtk } from "ags/gtk4"
import { claseColor } from "../dominio/tipos.ts"
import type { EventoCalendario } from "../dominio/tipos.ts"
import type { CeldaMes } from "../dominio/fechas.ts"
import { seleccionarFecha } from "../estado.ts"

const MAX_PUNTOS = 4

/**
 * Una celda de la cuadrícula del mes.
 *
 * Es un widget **sin estado**: recibe todo por parámetros y la reconstruye `VistaMes` cuando cambia
 * el mes, la selección o los eventos. Suscribirse aquí dentro pondría 42 suscriptores por monitor,
 * y habría que darlos de baja a mano en cada repintado.
 */
export function DiaCalendario({
  celda,
  esHoy,
  seleccionado,
  eventos,
}: {
  celda: CeldaMes
  esHoy: boolean
  seleccionado: boolean
  eventos: EventoCalendario[]
}): Gtk.Widget {
  const clases = ["cal-day-cell"]
  if (!celda.delMes) clases.push("other-month")
  if (esHoy) clases.push("today")
  if (seleccionado) clases.push("selected")
  if (eventos.length > 0) clases.push("con-eventos")

  const puntos = eventos.slice(0, MAX_PUNTOS).map((ev) => (
    <box cssClasses={["cal-event-dot", claseColor(ev.color)]} widthRequest={5} heightRequest={5} />
  ))
  // El «+N» sustituye al último punto en vez de añadirse: con cinco eventos, cinco puntos y un
  // contador no caben en una celda de la rejilla y desbordan la fila entera.
  if (eventos.length > MAX_PUNTOS) {
    puntos[MAX_PUNTOS - 1] = <label cssClasses={["cal-day-mas"]} label={`+${eventos.length - MAX_PUNTOS + 1}`} />
  }

  const tooltip = eventos.length === 0
    ? (esHoy ? "Hoy" : "")
    : eventos.slice(0, 6).map((e) => e.titulo).join("\n") +
      (eventos.length > 6 ? `\n… y ${eventos.length - 6} más` : "")

  return (
    <button
      cssClasses={clases}
      tooltipText={tooltip}
      onClicked={() => seleccionarFecha(celda.fecha)}
    >
      <box orientation={Gtk.Orientation.VERTICAL} spacing={2} valign={Gtk.Align.CENTER}>
        <label cssClasses={["cal-day-num"]} label={String(celda.dia)} halign={Gtk.Align.CENTER} />
        <box cssClasses={["cal-event-dots"]} halign={Gtk.Align.CENTER} spacing={2} heightRequest={6}>
          {puntos}
        </box>
      </box>
    </button>
  ) as unknown as Gtk.Widget
}
