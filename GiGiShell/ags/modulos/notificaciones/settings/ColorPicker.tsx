// modulos/notificaciones/settings/ColorPicker.tsx
// Reusable accent-color picker: "Auto" (clear) + theme preset swatches + free hex entry.
// onChange receives a normalized #rrggbb, or undefined for "auto" (fall back to default).
import { Gtk } from "ags/gtk4"
import { createState } from "ags"
import { COLOR_PRESETS, normalizeHex } from "../rules/color.ts"
import textos from "../../../textos/ajustes/notificaciones.json" with { type: "json" }

export default function ColorPicker({ value, onChange }: {
  value: string | undefined
  onChange: (hex: string | undefined) => void
}) {
  const [current, setCurrent] = createState<string | undefined>(value ? value.toLowerCase() : undefined)
  let entry: Gtk.Entry | null = null

  const pick = (hex: string | undefined) => {
    setCurrent(hex)
    onChange(hex)
    if (entry && entry.text !== (hex ?? "")) entry.text = hex ?? ""
  }

  return (
    <box orientation={Gtk.Orientation.VERTICAL} spacing={6} cssClasses={["cp"]}>
      <box spacing={4}>
        <button
          cssClasses={current((c) => c === undefined ? ["cp-auto", "active"] : ["cp-auto"])}
          tooltipText={textos.colores.sinColor}
          onClicked={() => pick(undefined)}
        >
          <label label={textos.colores.automatico} />
        </button>
        {COLOR_PRESETS.map(p => (
          <button
            cssClasses={current((c) => c === p.hex ? ["cp-swatch", "active"] : ["cp-swatch"])}
            css={`background: ${p.hex};`}
            tooltipText={p.name}
            onClicked={() => pick(p.hex)}
          >
            <label cssClasses={["cp-swatch-check"]} label={current((c) => c === p.hex ? "󰄬" : "")} />
          </button>
        ))}
      </box>
      <Gtk.Entry
        $={(self: Gtk.Entry) => { entry = self }}
        cssClasses={["re-entry"]}
        text={value ?? ""}
        placeholderText={textos.colores.entrada}
        onChanged={(self: Gtk.Entry) => {
          const t = self.text.trim()
          if (t === "") { setCurrent(undefined); onChange(undefined); return }
          const norm = normalizeHex(t)
          // Only commit a valid color; keep the (possibly partial) text while the user types.
          if (norm) { setCurrent(norm); onChange(norm) }
        }}
      />
    </box>
  )
}
