import { Gtk } from "ags/gtk4"
import { createState, onCleanup } from "ags"
import Interruptor from "../../../componentes/Interruptor.tsx"
import { crearReconstruccionCoalescida } from "../../../utilidades/coalescer.ts"
import { alarmas, alternarAlarma, eliminarAlarma } from "./estadoReloj.ts"
import { textoProximaActivacion, textoRepeticion } from "./planificadorAlarmas.ts"
import type { Alarma } from "./tipos.ts"
import type { Visible } from "./visible.ts"

/**
 * Lista de alarmas, con las activas arriba.
 *
 * Se reconstruye entera al cambiar la lista, como el resto de listas del panel. Aquí además evita un
 * problema propio: el texto «En 3 h 12 min» es derivado del reloj, y si cada fila lo mantuviera vivo
 * con su propio temporizador tendríamos una alarma por fila tickeando para actualizar una frase
 * aproximada. Se recalcula al reconstruir y al abrir la sección, que es cuando se mira.
 *
 * **Lo de «al abrir la sección» hay que hacerlo, no solo decirlo.** Esta lista solo se suscribía a
 * `alarmas`, así que el «En 3 h 12 min» era el que se calculó cuando se construyó el panel — al
 * arrancar la sesión— y ahí se quedaba mientras no se tocara ninguna alarma. Por eso recibe ahora
 * `visible`: al hacerse visible la sección se reconstruye, que sigue sin costar ningún temporizador.
 */
export function ListaAlarmas(
  { visible, alEditar }: { visible: Visible; alEditar: (alarma: Alarma) => void },
): Gtk.Widget {
  const lista = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6 })
  lista.set_css_classes(["reloj-lista-alarmas"])

  function fila(alarma: Alarma): Gtk.Widget {
    const proxima = textoProximaActivacion(alarma, Date.now())
    const [activa] = createState(alarma.activa)

    return (
      <box cssClasses={alarma.activa ? ["reloj-alarma", "activa"] : ["reloj-alarma"]} spacing={7}>
        <box orientation={Gtk.Orientation.VERTICAL} hexpand spacing={1}>
          <label cssClasses={["reloj-alarma-hora"]} label={alarma.hora} halign={Gtk.Align.START} />
          <label
            cssClasses={["reloj-alarma-etiqueta"]}
            label={alarma.etiqueta.trim() === "" ? "Alarma" : alarma.etiqueta}
            halign={Gtk.Align.START}
            xalign={0}
          />
          <box spacing={6}>
            <label cssClasses={["reloj-alarma-chip"]} label={textoRepeticion(alarma)} halign={Gtk.Align.START} />
            <label
              cssClasses={["reloj-alarma-proxima"]}
              label={proxima ?? ""}
              visible={proxima !== null}
              halign={Gtk.Align.START}
            />
          </box>
        </box>
        <Interruptor activo={activa} alAlternar={() => alternarAlarma(alarma.id)} />
        <button cssClasses={["cal-icon-btn", "small"]} tooltipText="Editar" onClicked={() => alEditar(alarma)}>
          <label label="󰏫" />
        </button>
        <button cssClasses={["cal-icon-btn", "small", "peligro"]} tooltipText="Eliminar" onClicked={() => eliminarAlarma(alarma.id)}>
          <label label="󰆴" />
        </button>
      </box>
    ) as unknown as Gtk.Widget
  }

  function reconstruir() {
    let hijo = lista.get_first_child()
    while (hijo) {
      const siguiente = hijo.get_next_sibling()
      lista.remove(hijo)
      hijo = siguiente
    }

    const todas = alarmas.get()
    if (todas.length === 0) {
      lista.append(
        (
          <box cssClasses={["cal-agenda-empty"]} orientation={Gtk.Orientation.VERTICAL} spacing={4}>
            <label cssClasses={["cal-empty-icon"]} label="󰀠" />
            <label cssClasses={["cal-empty-sub"]} label="No hay alarmas" />
          </box>
        ) as unknown as Gtk.Widget,
      )
      return
    }

    const activas = todas.filter((a) => a.activa).sort((a, b) => a.hora.localeCompare(b.hora))
    const inactivas = todas.filter((a) => !a.activa).sort((a, b) => a.hora.localeCompare(b.hora))

    for (const alarma of activas) lista.append(fila(alarma))
    if (inactivas.length > 0) {
      lista.append(
        (
          <label cssClasses={["reloj-separador"]} label="Desactivadas" halign={Gtk.Align.START} />
        ) as unknown as Gtk.Widget,
      )
      for (const alarma of inactivas) lista.append(fila(alarma))
    }
  }

  const repintado = crearReconstruccionCoalescida(reconstruir)
  const bajas = [
    alarmas.subscribe(repintado.programar),
    // Al ocultarse no se reconstruye: sería levantar filas para nadie. `programar` colapsa además
    // el caso de abrir la sección justo cuando cambia la lista.
    visible.subscribe(() => { if (visible.get()) repintado.programar() }),
  ]
  onCleanup(() => {
    repintado.cancelar()
    for (const baja of bajas) if (typeof baja === "function") baja()
  })
  repintado.ahora()

  return lista as unknown as Gtk.Widget
}
