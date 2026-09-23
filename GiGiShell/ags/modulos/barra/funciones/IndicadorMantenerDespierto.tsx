import { createComputed } from "ags"
import { Gtk } from "ags/gtk4"
import {
  mantenerDespiertoActivo,
  mantenerPantallaActiva,
  tiempoRestanteMantenerDespierto,
} from "../../../servicios/energia/mantenerDespierto"
import { textoTooltipMantenerDespierto } from "../../../servicios/energia/tiempoMantenerDespierto"
import { tituloBarra } from "../componentes/tituloBarra"

export default function IndicadorMantenerDespierto() {
  const tooltip = createComputed(
    [tiempoRestanteMantenerDespierto, mantenerPantallaActiva],
    (restante: number | null, pantallaActiva: boolean) =>
      textoTooltipMantenerDespierto(restante, pantallaActiva),
  )

  return (
    <box
      visible={mantenerDespiertoActivo}
      valign={Gtk.Align.CENTER}
      cssClasses={["wakeup-indicator"]}
      $={(self: Gtk.Widget) => tituloBarra(self, tooltip)}
    >
      <label cssClasses={["wakeup-icon"]} label="󰅶" />
    </box>
  )
}
