// Icono de la barra (inmediatamente a la izquierda del botón de notificaciones) que
// avisa de que algo está capturando la pantalla: compartir por portal (Discord,
// OBS, Zoom, navegador) o grabar en local (wf-recorder y cía.).
//
// No hay polling aquí: hypr/scripts/screencast-monitor.sh escribe
// ~/.config/gigios/screencast.json y esto lo observa con un Gio.FileMonitor,
// igual que Actualizaciones. Sustituye al antiguo indicador, que hacía un
// `pgrep -x wf-recorder` cada 2 s POR MONITOR y no veía los screencasts.
//
// Es un eslabón de la cadena de estado (ver `componentes/cadenaEstado.tsx`): no se
// pulsa, pero sí se realza con el cursor y enciende a los de su derecha.
import { Gtk } from "ags/gtk4"
import { datosCapturaPantalla } from "../../../../servicios/pantalla/captura"
import { tooltipCaptura } from "../../../../servicios/pantalla/capturaDatos"
import { ESLABON, SensorCadena, type CadenaEstado } from "../../componentes/cadenaEstado"
import { tituloBarra } from "../../componentes/tituloBarra"

export default function CapturaPantalla({ cadena }: { cadena: CadenaEstado }) {
  const indice = ESLABON.capturaPantalla

  return (
    <box
      visible={datosCapturaPantalla((datos) => datos.active)}
      valign={Gtk.Align.CENTER}
      $={(self: Gtk.Widget) => tituloBarra(self, datosCapturaPantalla(tooltipCaptura))}
    >
      <SensorCadena cadena={cadena} indice={indice} />
      {/* El pulso vive en el ICONO, no en la pastilla: en la pastilla haría
          parpadear también el fondo del realce y la junta con el eslabón
          siguiente, que es justo lo que tiene que quedarse quieto. */}
      <box
        cssClasses={cadena.clases(indice, ["bar-pill", "sc-pill"])}
        halign={Gtk.Align.CENTER}
        valign={Gtk.Align.CENTER}
      >
        <label cssClasses={["recording", "screencast-indicator"]} label="󰑊" />
      </box>
    </box>
  )
}
