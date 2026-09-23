import { Gtk } from "ags/gtk4"
import Pango from "gi://Pango"

type PropiedadesTextoInformativo = {
  label: any
  cssClasses?: string[]
  halign?: Gtk.Align
  [propiedad: string]: any
}

// Mismo motivo que en TituloAjuste: sin envolver, el mínimo de la etiqueta es su
// texto completo. Muchos llamantes ya pasaban `wrap`/`xalign` a mano; ahora es el
// valor por defecto y esas repeticiones son inofensivas (el spread va después).
/** Texto secundario compartido para descripciones y avisos de Ajustes. */
export default function TextoInformativo({
  cssClasses = [],
  halign = Gtk.Align.START,
  ...propiedades
}: PropiedadesTextoInformativo) {
  return (
    <label
      cssClasses={["sp-field-hint", ...cssClasses]}
      halign={halign}
      wrap
      wrapMode={Pango.WrapMode.WORD_CHAR}
      xalign={0}
      {...propiedades}
    />
  )
}
