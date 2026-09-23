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
  return (
    <box orientation={Gtk.Orientation.VERTICAL} spacing={4} cssClasses={["re-field"]} visible={visible}>
      <label cssClasses={["re-field-label"]} label={titulo} halign={Gtk.Align.START} />
      {children as any}
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
