// modulos/orion/components/sections/rice/comunes.ts
//
// Piezas compartidas por las cuatro vistas de la sección "Temas": la rejilla, el
// editor de franjas, el de un grupo y el de un fondo suelto.
//
// Todo esto es GTK imperativo, como el resto de la sección. NO se usa `<For>` en
// ninguna de estas vistas y no es un olvido: son listas que se reconstruyen
// enteras al editarlas, y `<For>` indexa por identidad de objeto — el patrón que
// ya provocó destrucción de widgets en pleno evento de foco y el SIGSEGV de las
// franjas horarias de Ajustes > Pantalla. Reconstruir una lista de cinco filas
// es gratis; perder el shell no.

import { Gtk } from "ags/gtk4"
import GLib from "gi://GLib"
import Pango from "gi://Pango"
import { loadThumbnails } from "../../../services/wallpaperThumbs"
import { aMinutos } from "../../../data/wallpaperSchedule"

/**
 * Miniatura de UNA imagen.
 *
 * `podar: false` es obligatorio: sin él, pedir una sola miniatura borraría de la
 * caché las de todos los demás fondos (ver el aviso en `wallpaperThumbs.ts`).
 */
export function miniatura(path: string, ancho: number, alto: number, clase = "rice-chip-img"): Gtk.Box {
  const caja = new Gtk.Box({ cssClasses: ["rice-thumb-viewport"] })
  caja.set_overflow(Gtk.Overflow.HIDDEN)
  caja.set_size_request(ancho, alto)

  const hueco = new Gtk.Box({ cssClasses: ["rice-thumb-placeholder"] })
  hueco.set_size_request(ancho, alto)
  caja.append(hueco)

  loadThumbnails([path], (_p, tex) => {
    const anterior = caja.get_first_child()
    if (!anterior) return
    const pic = new Gtk.Picture({ cssClasses: [clase] })
    pic.set_paintable(tex)
    pic.content_fit = Gtk.ContentFit.COVER
    pic.set_size_request(ancho, alto)
    caja.remove(anterior)
    caja.append(pic)
  }, { podar: false })

  return caja
}

export function etiqueta(texto: string, clases: string[], xalign = 0): Gtk.Label {
  const l = new Gtk.Label({ label: texto, cssClasses: clases })
  l.set_xalign(xalign)
  // Las explicaciones suelen ocupar varias frases. Sin wrap, su ancho mínimo es
  // el de la línea completa y GTK ensancha Orion antes de que el viewport pueda
  // recortarla. Al envolver, el mínimo pasa a ser el de una palabra y el texto
  // se adapta al ancho estable del panel.
  if (clases.includes("rice-help")) l.set_wrap(true)
  return l
}

export function boton(texto: string, clases: string[], alPulsar: () => void): Gtk.Button {
  const b = new Gtk.Button({ label: texto, cssClasses: clases })
  b.connect("clicked", alPulsar)
  return b
}

/** Fila horizontal con separación; el atajo que más se repite aquí. */
export function fila(spacing = 6, clases: string[] = []): Gtk.Box {
  return new Gtk.Box({ spacing, cssClasses: clases })
}

export function columna(spacing = 6, clases: string[] = []): Gtk.Box {
  return new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing, cssClasses: clases })
}

/**
 * Campo de hora "HH:MM".
 *
 * Confirma al salir del campo y con Enter — así se puede teclear la hora entera
 * antes de que nadie la interprete. Una hora inválida NO se propaga: el campo
 * revierte al valor bueno, porque guardar basura dejaría la franja sin efecto sin
 * ninguna señal visible (el motor descarta las entradas mal formadas).
 */
export function campoHora(valor: string, alConfirmar: (nuevo: string) => void): Gtk.Entry {
  const entry = new Gtk.Entry({
    text: valor,
    cssClasses: ["rice-hora"],
    maxLength: 5,
    widthChars: 5,
    xalign: 0.5,
  })

  const confirmar = () => {
    const texto = entry.get_text().trim()
    if (aMinutos(texto) === null) {
      entry.set_text(valor)     // revierte: nunca se guarda una hora inservible
      return
    }
    if (texto !== valor) alConfirmar(texto)
  }

  entry.connect("activate", confirmar)
  const foco = new Gtk.EventControllerFocus()
  foco.connect("leave", confirmar)
  entry.add_controller(foco)
  return entry
}

/** Chip pulsable de dos estados (aptitud de un fondo, selección de una franja). */
export function chip(texto: string, activo: boolean, alPulsar: () => void): Gtk.Button {
  const b = new Gtk.Button({
    label: texto,
    cssClasses: activo ? ["rice-chip", "on"] : ["rice-chip"],
  })
  b.connect("clicked", alPulsar)
  return b
}

export function nombreDe(path: string): string {
  return GLib.path_get_basename(path).replace(/\.[^.]+$/, "")
}

/** Cabecera de una subvista, con su vuelta atrás. */
export function cabeceraVuelta(titulo: string, alVolver: () => void): Gtk.Box {
  const caja = fila(8, ["rice-subheader"])
  const atras = new Gtk.Button({ cssClasses: ["rice-back-btn"] })
  atras.set_child(new Gtk.Image({ iconName: "go-previous-symbolic" }))
  atras.connect("clicked", alVolver)
  caja.append(atras)
  const t = etiqueta(titulo, ["rice-subtitle"])
  t.set_hexpand(true)
  t.set_ellipsize(Pango.EllipsizeMode.END)
  t.set_tooltip_text(titulo)
  caja.append(t)
  return caja
}
