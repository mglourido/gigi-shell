// modulos/ajustes/pantalla/FilaInactividad.tsx
// Fila de un tiempo de inactividad: etiqueta, selector de minutos e interruptor. La
// comparten la tarjeta general (`Inactividad.tsx`, que escribe en hypridle.conf) y la del
// modo ahorro (`modulos/ajustes/energia/InactividadAhorro.tsx`, que escribe en
// power-save/config.json). Solo es presentación: quién guarda y dónde lo decide el llamador.
import { type Accessor } from "ags"
import { Gtk } from "ags/gtk4"
import Interruptor from "../../../componentes/Interruptor"
import { TituloAjuste } from "../componentes"
import textos from "../../../textos/ajustes/pantalla.json" with { type: "json" }

export function SelectorMinutos({ valor, alCambiar }: { valor: Accessor<number>, alCambiar: (minutos: number) => void }) {
  return (
    <box spacing={6} valign={Gtk.Align.CENTER}>
      <button cssClasses={["sp-step-btn"]} onClicked={() => alCambiar(Math.max(1, valor.get() - 1))}><label label="−" /></button>
      <label cssClasses={["sp-step-val"]} label={valor((minutos: number) => `${minutos} min`)} />
      <button cssClasses={["sp-step-btn"]} onClicked={() => alCambiar(valor.get() + 1)}><label label="+" /></button>
    </box>
  )
}

export default function FilaInactividad({ etiqueta, minutos, fijarMinutos, activo, fijarActivo, guardar }: {
  etiqueta: string
  minutos: Accessor<number>
  fijarMinutos: (valor: number) => void
  activo: Accessor<boolean>
  fijarActivo: (valor: boolean) => void
  guardar: () => void
}) {
  return (
    <box cssClasses={["dev-row"]} spacing={8} valign={Gtk.Align.CENTER}>
      <TituloAjuste label={etiqueta} hexpand halign={Gtk.Align.START} />
      <label cssClasses={["sp-step-val", "off"]} label={textos.suspension.nunca} visible={activo((valor) => !valor)} />
      <box visible={activo}>
        <SelectorMinutos valor={minutos} alCambiar={(valor) => { fijarMinutos(valor); guardar() }} />
      </box>
      <Interruptor activo={activo} alAlternar={() => { fijarActivo(!activo.get()); guardar() }} />
    </box>
  )
}
