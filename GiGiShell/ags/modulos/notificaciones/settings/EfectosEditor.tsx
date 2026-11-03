// modulos/notificaciones/settings/EfectosEditor.tsx
// El bloque «Qué hacer» del editor de reglas, generado desde el registro de efectos
// (`rules/efectos/index.ts`): el orden del registro es el orden en pantalla, cada efecto dice qué
// control usa y dónde va (sección, fila, «Avanzado», visible solo si…). Añadir un efecto no toca
// este fichero; ver `rules/efectos/README.md`.
import { Gtk } from "ags/gtk4"
import { createComputed, createState, type Accessor } from "ags"
import type { NotifRule } from "../rules/types.ts"
import type { DefinicionEfecto } from "../rules/efectos/tipos.ts"
import { EFECTOS } from "../rules/efectos/index.ts"
import { ControlEfecto } from "./controlesEfecto.tsx"
import { AlternadorEditor } from "./ControlesEditor.tsx"
import textos from "../../../textos/ajustes/notificaciones.json" with { type: "json" }

interface PropiedadesEfectosEditor {
  borrador: Accessor<NotifRule>
  inicial: NotifRule
  cambiarEfectos: (efectos: NotifRule["effects"]) => void
}

export default function EfectosEditor({ borrador, inicial, cambiarEfectos }: PropiedadesEfectosEditor) {
  const [avanzado, setAvanzado] = createState(false)

  const fijar = (def: DefinicionEfecto) => (valor: unknown) => {
    const efectos = { ...borrador.get().effects } as Record<string, unknown>
    if (valor === undefined) delete efectos[def.clave]; else efectos[def.clave] = valor
    cambiarEfectos(efectos as NotifRule["effects"])
  }

  /** Visibilidad combinada: dentro de «Avanzado» y/o condicionada a otros efectos. */
  const visibilidad = (def: DefinicionEfecto): Accessor<boolean> | boolean => {
    const { visibleSi, avanzado: esAvanzado } = def.editor
    if (!visibleSi && !esAvanzado) return true
    if (!visibleSi) return avanzado((a) => a)
    if (!esAvanzado) return borrador((d) => visibleSi(d.effects))
    // Depende de los dos: `createComputed` sigue a ambos estados.
    return createComputed(() => avanzado() && visibleSi(borrador().effects))
  }

  const hijos: Gtk.Widget[] = []
  let botonAvanzadoPuesto = false

  for (let i = 0; i < EFECTOS.length; i++) {
    const def = EFECTOS[i]
    const editor = def.editor

    if (editor.seccion) {
      hijos.push(<label cssClasses={["re-section"]} label={editor.seccion} halign={Gtk.Align.START} /> as Gtk.Widget)
    }
    if (editor.avanzado && !botonAvanzadoPuesto) {
      botonAvanzadoPuesto = true
      hijos.push(
        <button cssClasses={["re-advanced-toggle"]} onClicked={() => setAvanzado(!avanzado.get())}>
          <label label={avanzado((a) => `${a ? "󰅀" : "󰅂"} ${textos.editor.titulos.avanzado}`)} halign={Gtk.Align.START} />
        </button> as Gtk.Widget,
      )
    }

    if (editor.tipo === "interruptor") {
      // Interruptores consecutivos de la misma fila van juntos; la ayuda de la fila, debajo.
      const fila: DefinicionEfecto[] = [def]
      while (i + 1 < EFECTOS.length) {
        const siguiente = EFECTOS[i + 1].editor
        if (siguiente.tipo !== "interruptor" || siguiente.fila !== editor.fila) break
        fila.push(EFECTOS[++i])
      }
      hijos.push(
        <box spacing={4}>
          {fila.map((d) => (
            <AlternadorEditor
              label={d.editor.tipo === "interruptor" ? d.editor.etiqueta : d.clave}
              estado={borrador}
              activo={() => !!(borrador.get().effects as Record<string, unknown>)[d.clave]}
              onChange={(v) => fijar(d)(v)}
            />
          ))}
        </box> as Gtk.Widget,
      )
      const ayuda = fila.map((d) => d.editor.tipo === "interruptor" ? d.editor.ayudaFila : undefined).find(Boolean)
      if (ayuda) hijos.push(<label cssClasses={["re-hint"]} label={ayuda} halign={Gtk.Align.START} wrap={true} /> as Gtk.Widget)
      continue
    }

    const control = ControlEfecto({
      def, borrador, inicial, fijar: fijar(def), cambiarEfectos, visible: visibilidad(def),
    })
    if (control) hijos.push(control)
  }

  return (
    <box orientation={Gtk.Orientation.VERTICAL} spacing={10}>
      {hijos}
    </box>
  )
}
