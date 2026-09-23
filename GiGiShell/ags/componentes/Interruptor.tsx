import type { Accessor } from "ags"
import { Gtk } from "ags/gtk4"

type PropiedadesInterruptor = {
  activo: Accessor<boolean>
  alAlternar: () => void
  clasesAdicionales?: string[]
  sensible?: boolean | Accessor<boolean>
  visible?: boolean | Accessor<boolean>
}

/**
 * Interruptor visual compartido por los ajustes del shell.
 *
 * La geometría completa vive aquí para evitar que una fila estire el botón
 * o que pista y punto se construyan de forma distinta entre secciones.
 */
export default function Interruptor({
  activo,
  alAlternar,
  clasesAdicionales = [],
  sensible = true,
  visible = true,
}: PropiedadesInterruptor) {
  const clasesBoton = activo((estaActivo) => estaActivo
    ? ["qs-toggle", ...clasesAdicionales, "on"]
    : ["qs-toggle", ...clasesAdicionales])

  return (
    <button
      cssClasses={clasesBoton}
      valign={Gtk.Align.CENTER}
      sensitive={sensible}
      visible={visible}
      onClicked={alAlternar}
    >
      <box cssClasses={["qs-toggle-track"]}>
        <box cssClasses={activo((estaActivo) => estaActivo
          ? ["qs-toggle-dot", "on"]
          : ["qs-toggle-dot"])} />
      </box>
    </button>
  )
}
