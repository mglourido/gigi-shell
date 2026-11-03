import { Gtk } from "ags/gtk4"
import type { Accessor } from "ags"

export function CampoEditor({
  titulo,
  visible,
  children,
}: {
  titulo: string
  visible?: Accessor<boolean> | boolean
  children?: unknown
}) {
  // gnim salta los hijos falsos (`false`, `null`) solo en el PRIMER nivel de una llamada JSX: los
  // que llegan dentro de `children` reenviados pasan por `append()`, que no los filtra y revienta
  // (`right-hand side of 'in' should be an object`). Se aplanan y filtran aquí para que
  // `{condicion && <x/>}` funcione igual dentro de un campo que fuera de él.
  const hijos = (Array.isArray(children) ? children.flat(Infinity) : [children])
    .filter((hijo) => hijo !== null && hijo !== undefined && hijo !== false && hijo !== true)
  return (
    <box orientation={Gtk.Orientation.VERTICAL} spacing={4} visible={visible}>
      <label cssClasses={["re-field-label"]} label={titulo} halign={Gtk.Align.START} />
      {hijos as any}
    </box>
  )
}

export function AlternadorEditor({
  label,
  estado,
  activo,
  onChange,
}: {
  label: string
  estado: Accessor<unknown>
  activo: () => boolean
  onChange: (activo: boolean) => void
}) {
  return (
    <button
      cssClasses={estado(() => activo() ? ["re-toggle", "active"] : ["re-toggle"])}
      onClicked={() => onChange(!activo())}
    >
      <label label={label} />
    </button>
  )
}
