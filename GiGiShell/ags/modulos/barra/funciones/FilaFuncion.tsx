import { With } from "ags"
import { Gtk } from "ags/gtk4"
import ChipEstadoFuncion from "./ChipEstadoFuncion"
import type { FuncionBarra } from "./registro"

export default function FilaFuncion({ funcion }: { funcion: FuncionBarra }) {
  return (
    <box orientation={Gtk.Orientation.VERTICAL}>
      <box>
        <With value={funcion.habilitada}>
          {(activa: boolean) => (
            <button
              cssClasses={activa ? ["fn-menu-button", "active"] : ["fn-menu-button"]}
              focusable={false}
              hexpand
              onClicked={() => funcion.alternar(!funcion.habilitada.get())}
            >
              <box cssClasses={["fn-menu-row"]} spacing={6}>
                <label
                  cssClasses={["fn-menu-label"]}
                  label={funcion.etiqueta}
                  xalign={0}
                  hexpand
                />
                <box cssClasses={["fn-menu-state"]}>
                  <ChipEstadoFuncion funcion={funcion} activa={activa} />
                </box>
              </box>
            </button>
          )}
        </With>
      </box>
      {funcion.expandir ? (
        <box>
          <With value={funcion.habilitada}>
            {(activa: boolean) => activa && funcion.expandir!()}
          </With>
        </box>
      ) : null}
    </box>
  )
}
