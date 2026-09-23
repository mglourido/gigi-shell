import { Gtk } from "ags/gtk4"
import type { AccionEnergia } from "./acciones"

export default function BotonAccion({
  accion,
  ejecutar,
}: {
  accion: AccionEnergia
  ejecutar: (comando: string) => void
}) {
  return (
    <button
      cssClasses={["power-button", accion.claseCss]}
      onClicked={() => ejecutar(accion.comando)}
      focusable={false}
    >
      <box
        cssClasses={["power-button-content"]}
        orientation={Gtk.Orientation.VERTICAL}
        spacing={8}
        halign={Gtk.Align.CENTER}
        valign={Gtk.Align.CENTER}
        hexpand
        vexpand
      >
        <box
          cssClasses={["power-icon-frame"]}
          halign={Gtk.Align.CENTER}
          valign={Gtk.Align.CENTER}
          widthRequest={56}
          heightRequest={56}
        >
          <label
            cssClasses={["power-icon"]}
            label={accion.icono}
            halign={Gtk.Align.CENTER}
            valign={Gtk.Align.CENTER}
            xalign={0.5}
            yalign={0.5}
            justify={Gtk.Justification.CENTER}
            widthRequest={56}
            heightRequest={56}
            hexpand
            vexpand
          />
        </box>
        <label
          cssClasses={["power-label"]}
          label={accion.etiqueta}
          halign={Gtk.Align.CENTER}
          xalign={0.5}
          hexpand
        />
      </box>
    </button>
  )
}
