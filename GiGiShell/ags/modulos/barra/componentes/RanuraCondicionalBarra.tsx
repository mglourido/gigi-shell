import { With, type Accessor } from "ags"
import { Gtk } from "ags/gtk4"

/** Conserva la posición de un widget desmontable sin ocupar espacio al ocultarlo. */
export default function RanuraCondicionalBarra({
  estado,
  construir,
}: {
  estado: Accessor<boolean>
  construir: () => any
}) {
  return (
    <Gtk.Revealer
      visible={estado}
      revealChild={estado}
      valign={Gtk.Align.CENTER}
      transitionType={Gtk.RevealerTransitionType.NONE}
      transitionDuration={0}
    >
      <With value={estado}>{(activo: boolean) => activo && construir()}</With>
    </Gtk.Revealer>
  )
}
