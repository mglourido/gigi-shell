// modulos/ajustes/personalizacion/AjusteDuracionPopups.tsx
// Bloque "Duración de los avisos en pantalla" de Notificaciones > General.
// Tres campos, uno por familia de popup (app / sistema / con botones), en segundos.
// Aquí solo se persisten las preferencias: quien las aplica es
// modulos/notificaciones/popup/pila.ts al programar el descarte de cada popup.
//
// Se editan en SEGUNDOS aunque se guarden en milisegundos: es la unidad en la que el
// usuario piensa este ajuste ("que dure 3 segundos") y la que evita teclear cuatro ceros.
import { Gtk } from "ags/gtk4"
import type { Accessor } from "ags"
import { EncabezadoAjuste, TextoInformativo, TituloSubseccion } from "../componentes"
import textos from "../../../textos/ajustes/personalizacion.json" with { type: "json" }
import {
  popupDuracionNormalMs, setPopupDuracionNormalMs,
  popupDuracionSistemaMs, setPopupDuracionSistemaMs,
  popupDuracionAccionesMs, setPopupDuracionAccionesMs,
} from "../preferences"

/** ms → texto en segundos, sin decimales cuando son redondos (5500 → "5,5"; 10000 → "10"). */
function aSegundos(ms: number): string {
  const s = ms / 1000
  return (Number.isInteger(s) ? String(s) : s.toFixed(1)).replace(".", ",")
}

/** Texto en segundos → ms. Acepta coma o punto; `null` si no hay un número utilizable. */
function aMilisegundos(texto: string): number | null {
  const s = parseFloat(texto.trim().replace(",", "."))
  return Number.isFinite(s) && s > 0 ? Math.round(s * 1000) : null
}

/** Una familia: etiqueta + segundos. El botón "Guardar" de abajo aplica las tres. */
interface Familia {
  titulo: string
  placeholder: string
  valor: Accessor<number>
  fijar: (ms: number) => void
}

export default function AjusteDuracionPopups() {
  const familias: Familia[] = [
    {
      titulo: textos.duracionPopups.normal.titulo,
      placeholder: textos.duracionPopups.normal.placeholder,
      valor: popupDuracionNormalMs,
      fijar: setPopupDuracionNormalMs,
    },
    {
      titulo: textos.duracionPopups.sistema.titulo,
      placeholder: textos.duracionPopups.sistema.placeholder,
      valor: popupDuracionSistemaMs,
      fijar: setPopupDuracionSistemaMs,
    },
    {
      titulo: textos.duracionPopups.acciones.titulo,
      placeholder: textos.duracionPopups.acciones.placeholder,
      valor: popupDuracionAccionesMs,
      fijar: setPopupDuracionAccionesMs,
    },
  ]
  const entradas = new Map<Familia, Gtk.Entry>()

  // Guardar aplica las tres y repinta cada campo desde el estado YA acotado: si se teclea
  // 200 o "abc", lo que queda a la vista es el valor real que se va a usar, no lo tecleado.
  const guardar = () => {
    for (const familia of familias) {
      const entrada = entradas.get(familia)
      if (!entrada) continue
      const ms = aMilisegundos(entrada.get_text())
      if (ms !== null) familia.fijar(ms)
      entrada.set_text(aSegundos(familia.valor.get()))
    }
  }

  return (
    <box orientation={Gtk.Orientation.VERTICAL} spacing={8} cssClasses={["sp-field"]} hexpand>
      <EncabezadoAjuste
        titulo={textos.duracionPopups.titulo}
        informacion={textos.duracionPopups.descripcion}
        halign={Gtk.Align.START}
        propiedadesInformacion={{ wrap: true, lines: 2, maxWidthChars: 62, xalign: 0 }}
      />

      <box orientation={Gtk.Orientation.VERTICAL} spacing={6}>
        <TituloSubseccion label={textos.duracionPopups.subtitulo} halign={Gtk.Align.START} />
        {familias.map((familia) => (
          <box spacing={6} valign={Gtk.Align.CENTER}>
            <label cssClasses={["adnd-app-name"]} label={familia.titulo} halign={Gtk.Align.START} hexpand />
            <entry
              cssClasses={["sp-num-input"]}
              widthChars={5}
              xalign={1}
              placeholderText={familia.placeholder}
              $={(self: Gtk.Entry) => {
                entradas.set(familia, self)
                self.set_text(aSegundos(familia.valor.get()))
              }}
              onActivate={guardar}
            />
            <label cssClasses={["adnd-app-name"]} label={textos.duracionPopups.unidad} />
          </box>
        ))}
        <TextoInformativo label={textos.duracionPopups.ayuda} halign={Gtk.Align.START} wrap maxWidthChars={62} xalign={0} />
        <box halign={Gtk.Align.START}>
          <button cssClasses={["sp-add-rule"]} onClicked={guardar} valign={Gtk.Align.CENTER}>
            <label label={textos.duracionPopups.guardar} />
          </button>
        </box>
      </box>
    </box>
  )
}
