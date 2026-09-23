import { Gtk } from "ags/gtk4"
import { onCleanup } from "ags"
import { crearReconstruccionCoalescida } from "../../../utilidades/coalescer.ts"
import { DIAS_SEMANA_CORTOS, nombreMes } from "../dominio/fechas.ts"
import {
  cuadricula,
  fechaSeleccionada,
  hoyReactivo,
  indiceMes,
  irAHoy,
  irAMesRelativo,
  mesVisible,
} from "../estado.ts"
import { DiaCalendario } from "./DiaCalendario.tsx"

/**
 * Vista mensual.
 *
 * La rejilla se **reconstruye entera** al cambiar el mes, la selección o los eventos, en vez de
 * mantener 42 celdas reactivas. Son cuarenta y dos botones sin estado: reconstruirlos cuesta menos
 * que sostener tres suscripciones por celda, y evita el `<For>` indexado por identidad de objeto que
 * en este proyecto ya provocó destrucción de widgets en pleno evento de foco (ver `ags/CLAUDE.md`,
 * franjas horarias). No hay sondeo periódico: nada se repinta si no cambia el estado.
 *
 * **Las tres suscripciones comparten UNA reconstrucción coalescida**, y no es un adorno: `indiceMes`
 * deriva de `cuadricula`, así que pasar de mes avisaba dos veces —y `seleccionarFecha()` sobre un
 * día de relleno, tres—, cada una levantando 42 botones otra vez en cada uno de los monitores. La
 * primera de esas pasadas leía además el índice todavía sin invalidar, o sea que pintaba los puntos
 * del mes que acababas de dejar. Ver `utilidades/coalescer.ts`.
 */
export function VistaMes(): Gtk.Widget {
  const contenedorRejilla = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL })
  contenedorRejilla.set_css_classes(["cal-month-grid"])
  // La rejilla NO se estira al alto del panel, y es a propósito: son seis filas fijas (ver
  // `construirCuadriculaMes`), así que en una pantalla de 1440 px cada celda pasaría de 50 a 240 px
  // y el día seleccionado se convertía en una columna gigante. Se queda compacta arriba; el hueco
  // de abajo es de la columna de la agenda, que sí crece.

  const tituloMes = new Gtk.Label({ label: "" })
  tituloMes.set_css_classes(["cal-month-title"])
  tituloMes.set_hexpand(true)
  tituloMes.set_halign(Gtk.Align.START)

  function reconstruir() {
    const celdas = cuadricula.get()
    const seleccionada = fechaSeleccionada.get()
    const indice = indiceMes.get()
    const hoy = hoyReactivo.get()
    const { anio, mes } = mesVisible.get()

    tituloMes.set_label(`${nombreMes(mes)} ${anio}`)

    let hijo = contenedorRejilla.get_first_child()
    while (hijo) {
      const siguiente = hijo.get_next_sibling()
      contenedorRejilla.remove(hijo)
      hijo = siguiente
    }

    const rejilla = new Gtk.Grid()
    rejilla.set_css_classes(["cal-days-grid"])
    rejilla.set_row_homogeneous(true)
    rejilla.set_column_homogeneous(true)

    celdas.forEach((celda, i) => {
      const widget = DiaCalendario({
        celda,
        esHoy: celda.fecha === hoy,
        seleccionado: celda.fecha === seleccionada,
        eventos: indice.get(celda.fecha) ?? [],
      })
      rejilla.attach(widget, i % 7, Math.floor(i / 7), 1, 1)
    })

    contenedorRejilla.append(rejilla)
  }

  const repintado = crearReconstruccionCoalescida(reconstruir)
  const bajas = [
    cuadricula.subscribe(repintado.programar),
    fechaSeleccionada.subscribe(repintado.programar),
    indiceMes.subscribe(repintado.programar),
    hoyReactivo.subscribe(repintado.programar),
  ]
  onCleanup(() => {
    repintado.cancelar()
    for (const baja of bajas) if (typeof baja === "function") baja()
  })
  repintado.ahora()

  const cabeceraDias = new Gtk.Grid()
  cabeceraDias.set_css_classes(["cal-weekday-headers"])
  cabeceraDias.set_column_homogeneous(true)
  DIAS_SEMANA_CORTOS.forEach((dia, i) => {
    const etiqueta = new Gtk.Label({ label: dia })
    etiqueta.set_css_classes(["cal-wd-label"])
    cabeceraDias.attach(etiqueta, i, 0, 1, 1)
  })

  return (
    <box cssClasses={["cal-month-view"]} orientation={Gtk.Orientation.VERTICAL}>
      <box cssClasses={["cal-month-nav"]} spacing={6}>
        {tituloMes}
        <button cssClasses={["cal-btn", "cal-hoy"]} onClicked={() => irAHoy()}>
          <label label="Hoy" cssClasses={["cal-today-label"]} />
        </button>
        <box cssClasses={["cal-month-stepper"]} spacing={1}>
          <button cssClasses={["cal-month-arrow"]} onClicked={() => irAMesRelativo(-1)}>
            <label cssClasses={["cal-month-arrow-icono"]} label="‹" />
          </button>
          <button cssClasses={["cal-month-arrow"]} onClicked={() => irAMesRelativo(1)}>
            <label cssClasses={["cal-month-arrow-icono"]} label="›" />
          </button>
        </box>
      </box>
      {cabeceraDias}
      {contenedorRejilla}
    </box>
  ) as unknown as Gtk.Widget
}
