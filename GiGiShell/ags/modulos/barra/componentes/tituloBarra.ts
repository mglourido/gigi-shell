import GLib from "gi://GLib"
import { Gtk } from "ags/gtk4"

import { colgarDeBarra } from "./anclaBarra"

/**
 * El «title» de un widget de la barra: sustituye al `tooltipText` nativo.
 *
 * El tooltip de GTK se ancla al borde inferior del WIDGET (`gtk_tooltip_position`: sus
 * bounds + 4 px, sin nada equivalente al `pointing_to` de un popover), y los iconos de
 * la barra miden de 14 a 30 px centrados en 38: cada título salía a una distancia
 * distinta de la barra y ningún margen CSS en el nodo `tooltip` —que es uno para todos—
 * lo puede corregir. Este es un popover sin flecha colgado con `colgarDeBarra`, así que
 * sale a `SEPARACION_BARRA` como todos los menús. El aspecto es el del `tooltip` nativo
 * (`%titulo-flotante` en style.scss) y los tiempos, los de GTK: 500 ms la primera vez y
 * casi inmediato al pasar de un icono a otro con un título recién abierto.
 *
 * `fuente` puede ser un texto fijo, un `Accessor` (se sigue en vivo mientras el título
 * está abierto) o una función que se evalúa al abrirlo. Vacío o nulo = sin título.
 */
export type FuenteTitulo = string | (() => string | null | undefined)

const ESPERA_MS = 500
const ESPERA_NAVEGANDO_MS = 60
const VENTANA_NAVEGACION_MS = 500

let titulosAbiertos = 0
let ultimoCierreMs = 0

const ahoraMs = () => GLib.get_monotonic_time() / 1000

export function tituloBarra(widget: Gtk.Widget, fuente: FuenteTitulo) {
  const leer = () => {
    const texto = typeof fuente === "function" ? fuente() : fuente
    return texto ? String(texto) : ""
  }
  const suscribir = typeof fuente === "function" && typeof (fuente as any).subscribe === "function"
    ? (fuente as any).subscribe.bind(fuente) as (alCambiar: () => void) => () => void
    : null

  let temporizador = 0
  let popover: Gtk.Popover | null = null
  let soltarSuscripcion: (() => void) | null = null
  // Como el tooltip nativo: tras un clic no vuelve hasta que el puntero sale y entra.
  let bloqueado = false

  const cancelar = () => {
    if (temporizador) GLib.source_remove(temporizador)
    temporizador = 0
  }

  const ocultar = () => {
    cancelar()
    soltarSuscripcion?.()
    soltarSuscripcion = null
    const actual = popover
    if (!actual) return
    popover = null
    titulosAbiertos = Math.max(0, titulosAbiertos - 1)
    ultimoCierreMs = ahoraMs()
    try { actual.popdown() } catch (_) {}
    try { actual.unparent() } catch (_) {}
  }

  const mostrar = () => {
    temporizador = 0
    const texto = leer()
    if (!texto || popover || !widget.get_mapped()) return

    const etiqueta = new Gtk.Label({ label: texto, wrap: true, max_width_chars: 50, xalign: 0 })
    const nuevo = new Gtk.Popover({
      has_arrow: false,
      autohide: false,
      can_focus: false,
      can_target: false,
      child: etiqueta,
    })
    nuevo.add_css_class("titulo-barra")
    nuevo.set_parent(widget)
    colgarDeBarra(nuevo)
    popover = nuevo
    titulosAbiertos++
    soltarSuscripcion = suscribir?.(() => {
      const actual = leer()
      if (actual) etiqueta.set_label(actual)
      else ocultar()
    }) ?? null
    nuevo.popup()
  }

  const programar = () => {
    if (bloqueado || popover || temporizador) return
    const navegando = titulosAbiertos > 0 || ahoraMs() - ultimoCierreMs < VENTANA_NAVEGACION_MS
    temporizador = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      navegando ? ESPERA_NAVEGANDO_MS : ESPERA_MS,
      () => {
        mostrar()
        return GLib.SOURCE_REMOVE
      },
    )
  }

  const movimiento = new Gtk.EventControllerMotion()
  movimiento.connect("enter", programar)
  movimiento.connect("leave", () => {
    bloqueado = false
    ocultar()
  })
  widget.add_controller(movimiento)

  const clic = new Gtk.GestureClick({ button: 0 })
  clic.set_propagation_phase(Gtk.PropagationPhase.CAPTURE)
  clic.connect("pressed", () => {
    bloqueado = true
    ocultar()
  })
  widget.add_controller(clic)

  // Un widget que se oculta bajo el puntero no recibe `leave`.
  widget.connect("unmap", () => {
    bloqueado = false
    ocultar()
  })
}
