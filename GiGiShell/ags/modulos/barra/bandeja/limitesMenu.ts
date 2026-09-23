import GLib from "gi://GLib"
import Pango from "gi://Pango"
import { Gtk } from "ags/gtk4"

const ANCHO_MAXIMO = 260
const ALTO_MAXIMO = 480
const CARACTERES_MAXIMOS_ETIQUETA = 24

interface EstadoLimites {
  ocupado: boolean
  eliminado: boolean
  fuenteIdle: number
  paginas: Gtk.SelectionModel
  idCambioPaginas: number
}

const estados = new WeakMap<Gtk.Popover, EstadoLimites>()

function limitarEtiquetas(widget: Gtk.Widget) {
  if (widget instanceof Gtk.Label) {
    widget.set_max_width_chars(CARACTERES_MAXIMOS_ETIQUETA)
    widget.set_ellipsize(Pango.EllipsizeMode.END)
    widget.set_wrap(false)
  }
  for (let hijo = widget.get_first_child(); hijo; hijo = hijo.get_next_sibling()) {
    limitarEtiquetas(hijo)
  }
}

function aplicarLimites(popover: Gtk.Popover, estado: EstadoLimites) {
  if (estado.eliminado || estado.ocupado) return
  const pila = popover.get_child()
  if (!(pila instanceof Gtk.Stack)) return

  limitarEtiquetas(pila)
  pila.queue_resize()
  const entradas: Array<{ hijo: Gtk.Widget; nombre: string | null }> = []
  for (let indice = 0; indice < estado.paginas.get_n_items(); indice++) {
    const pagina = estado.paginas.get_item(indice) as Gtk.StackPage | null
    if (!pagina) continue
    const hijo = pagina.get_child()
    if (!hijo.has_css_class("tray-menu-scroll")) {
      entradas.push({ hijo, nombre: pagina.get_name() })
    }
  }

  estado.ocupado = true
  try {
    for (const { hijo, nombre } of entradas) {
      const [, anchoNatural] = hijo.measure(Gtk.Orientation.HORIZONTAL, -1)
      const ancho = Math.min(anchoNatural, ANCHO_MAXIMO)
      const [, altoNatural] = hijo.measure(Gtk.Orientation.VERTICAL, ancho)
      const alto = Math.min(altoNatural, ALTO_MAXIMO)

      pila.remove(hijo)
      const desplazamiento = new Gtk.ScrolledWindow({
        cssClasses: ["tray-menu-scroll"],
        hscrollbarPolicy: Gtk.PolicyType.AUTOMATIC,
        vscrollbarPolicy: Gtk.PolicyType.AUTOMATIC,
        propagateNaturalWidth: true,
        propagateNaturalHeight: true,
        maxContentWidth: ANCHO_MAXIMO,
        maxContentHeight: ALTO_MAXIMO,
        widthRequest: ancho,
        heightRequest: alto,
      })
      desplazamiento.set_child(hijo)
      if (nombre) pila.add_named(desplazamiento, nombre)
      else pila.add_child(desplazamiento)
    }
  } finally {
    estado.ocupado = false
  }
}

/** Configura una vez un Gtk.PopoverMenu remoto y devuelve una limpieza idempotente. */
export function limitarMenuBandeja(popover: Gtk.Popover): () => void {
  const existente = estados.get(popover)
  if (existente) return () => eliminarLimites(popover, existente)

  const pila = popover.get_child()
  if (!(pila instanceof Gtk.Stack)) return () => {}
  const paginas = pila.get_pages()
  const estado: EstadoLimites = {
    ocupado: false,
    eliminado: false,
    fuenteIdle: 0,
    paginas,
    idCambioPaginas: 0,
  }

  const programar = () => {
    if (estado.eliminado || estado.ocupado || estado.fuenteIdle) return
    estado.fuenteIdle = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      estado.fuenteIdle = 0
      aplicarLimites(popover, estado)
      return GLib.SOURCE_REMOVE
    })
  }
  estado.idCambioPaginas = paginas.connect("items-changed", programar)
  estados.set(popover, estado)
  aplicarLimites(popover, estado)
  programar()
  return () => eliminarLimites(popover, estado)
}

function eliminarLimites(popover: Gtk.Popover, estado: EstadoLimites) {
  if (estado.eliminado) return
  estado.eliminado = true
  if (estado.fuenteIdle) GLib.source_remove(estado.fuenteIdle)
  estado.fuenteIdle = 0
  if (estado.idCambioPaginas) {
    try { estado.paginas.disconnect(estado.idCambioPaginas) } catch (_) {}
  }
  estado.idCambioPaginas = 0
  estados.delete(popover)
}
