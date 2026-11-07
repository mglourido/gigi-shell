import { Gtk } from "ags/gtk4"
import { avisoPorDefecto, opcionesAviso } from "../dominio/avisos.ts"
import type { OpcionAviso } from "../dominio/avisos.ts"

export interface CampoAviso {
  widget: Gtk.Widget
  /** Cambia la lista al tipo de evento. Si el valor no vale en el tipo nuevo, se adapta (ver abajo). */
  establecerTodoElDia: (todoElDia: boolean) => void
}

/**
 * Selector del recordatorio: `‹ 10 min antes ›`.
 *
 * **Flechas y no un desplegable.** `Gtk.DropDown` abre un popover, que es otra superficie y le roba
 * el foco al panel layer-shell (por eso `servicios/pantalla/controls.tsx` tiene su propio select en
 * overlay); y ese select flotante dentro del `ScrolledWindow` del formulario se recortaría contra él.
 * Son siete u ocho opciones ordenadas, así que recorrerlas con flechas no cuesta y no crea nada.
 *
 * Como los demás campos del formulario, **no se reconstruye**: cambia la etiqueta y avisa hacia
 * arriba.
 */
export function crearCampoAviso(
  inicial: number | undefined,
  todoElDiaInicial: boolean,
  alCambiar: (minutos: number | undefined) => void,
): CampoAviso {
  let todoElDia = todoElDiaInicial
  let valor = inicial
  let opciones: OpcionAviso[] = opcionesAviso(todoElDia, valor)

  const etiqueta = new Gtk.Label({ label: "", hexpand: true, xalign: 0.5 })
  etiqueta.set_css_classes(["cal-form-entry"])

  const flecha = (texto: string, paso: number, tooltip: string) => {
    const b = new Gtk.Button({ valign: Gtk.Align.CENTER })
    b.set_css_classes(["cal-icon-btn", "small"])
    b.set_child(new Gtk.Label({ label: texto }))
    b.set_tooltip_text(tooltip)
    b.connect("clicked", () => mover(paso))
    return b
  }
  const anterior = flecha("‹", -1, "Opción anterior")
  const siguiente = flecha("›", 1, "Opción siguiente")

  function pintar() {
    const i = opciones.findIndex((o) => o.minutos === valor)
    etiqueta.set_label(opciones[i]?.etiqueta ?? "")
    anterior.set_sensitive(i > 0)
    siguiente.set_sensitive(i < opciones.length - 1)
  }

  function mover(paso: number) {
    const i = opciones.findIndex((o) => o.minutos === valor)
    const destino = opciones[Math.max(0, Math.min(opciones.length - 1, i + paso))]
    if (!destino || destino.minutos === valor) return
    valor = destino.minutos
    pintar()
    alCambiar(valor)
  }

  pintar()

  const caja = new Gtk.Box({ spacing: 5, hexpand: true })
  caja.append(anterior)
  caja.append(etiqueta)
  caja.append(siguiente)

  return {
    widget: caja,
    establecerTodoElDia(nuevo: boolean) {
      if (nuevo === todoElDia) return
      todoElDia = nuevo
      // Los minutos significan cosas distintas en cada tipo («10» son diez minutos antes de la hora,
      // o las 23:50 de la víspera en uno de día completo): se conserva «avisar o no», no el número.
      if (valor !== undefined) {
        valor = avisoPorDefecto(nuevo)
        alCambiar(valor)
      }
      opciones = opcionesAviso(todoElDia, valor)
      pintar()
    },
  }
}
