import type { Accessor } from "ags"
import { Gtk, Gdk } from "ags/gtk4"
import { tituloBarra } from "./tituloBarra"

/** Indicador con título; el clic derecho desactiva el modo que representa. */
export default function IndicadorModo({
  activo,
  icono,
  clase,
  titulo,
  alDesactivar,
}: {
  activo: Accessor<boolean>
  icono: string
  clase: string
  titulo: string
  alDesactivar: () => void
}) {
  return (
    <box
      visible={activo}
      valign={Gtk.Align.CENTER}
      cssClasses={["bar-modo", clase]}
      $={(widget: Gtk.Widget) => tituloBarra(widget, titulo)}
    >
      <Gtk.GestureClick
        button={Gdk.BUTTON_SECONDARY}
        onPressed={(gesto) => {
          gesto.set_state(Gtk.EventSequenceState.CLAIMED)
          if (activo.get()) alDesactivar()
        }}
      />
      <label label={icono} />
    </box>
  )
}
