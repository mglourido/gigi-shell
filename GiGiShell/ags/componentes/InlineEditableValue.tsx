import { Gtk } from "ags/gtk4"
import { createState } from "ags"
import GLib from "gi://GLib"
import textos from "../textos/ajustes/general.json" with { type: "json" }

type Props = {
  display: any
  getValue: () => number
  onCommit: (value: number) => void
  min: number
  max: number
  labelClass: string | string[]
  tooltip?: string
  suffix?: string
  maxLength?: number
  widthRequest?: number
}

/** A compact value label that turns into a numeric entry when clicked. */
export function InlineEditableValue({
  display, getValue, onCommit, min, max, labelClass,
  tooltip = textos.panel.editarValor, suffix = "", maxLength = 3, widthRequest = 28,
}: Props) {
  const [editing, setEditing] = createState(false)
  let entry: Gtk.Entry
  let stack: Gtk.Stack
  let valueButton: Gtk.Button
  const labelClasses = Array.isArray(labelClass) ? labelClass : [labelClass]

  const commit = () => {
    if (!editing.get()) return
    const parsed = Number.parseInt(entry.text.trim(), 10)
    const value = Number.isFinite(parsed)
      ? Math.max(min, Math.min(max, parsed))
      : Math.round(getValue())
    entry.text = String(value)
    setEditing(false)
    stack.visibleChild = valueButton
    const root = entry.get_root()
    if (root instanceof Gtk.Window) root.set_focus(null)
    onCommit(value)
  }

  const beginEdit = () => {
    entry.text = String(Math.round(getValue()))
    setEditing(true)
    stack.visibleChild = entry
    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      entry.grab_focus()
      entry.select_region(0, -1)
      return GLib.SOURCE_REMOVE
    })
  }

  // `tooltip=""` = sin tooltip. Asignar la cadena vacía a `tooltip-text` deja
  // `has-tooltip` en true y GTK enseña un recuadro vacío al pasar por encima,
  // así que la propiedad no se pone en absoluto.
  const propiedadesTooltip = tooltip ? { tooltipText: tooltip } : {}

  return (
    <Gtk.Stack
      hhomogeneous
      vhomogeneous
      valign={Gtk.Align.CENTER}
      widthRequest={widthRequest}
      $={(self: Gtk.Stack) => { stack = self }}
    >
      <button
        cssClasses={["qs-inline-value-btn"]}
        onClicked={beginEdit}
        {...propiedadesTooltip}
        $={(self: Gtk.Button) => { valueButton = self }}
      >
        <label cssClasses={labelClasses} label={display} />
      </button>
      <Gtk.Entry
        cssClasses={["qs-inline-number-input", "compact"]}
        maxLength={maxLength}
        widthChars={1}
        maxWidthChars={maxLength}
        widthRequest={widthRequest}
        heightRequest={16}
        xalign={1}
        inputPurpose={Gtk.InputPurpose.DIGITS}
        $={(self: Gtk.Entry) => { entry = self; self.text = String(Math.round(getValue())) }}
        onActivate={commit}
      >
        <Gtk.EventControllerFocus onLeave={commit} />
      </Gtk.Entry>
    </Gtk.Stack>
  )
}
