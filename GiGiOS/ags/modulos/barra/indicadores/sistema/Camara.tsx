// Indicador de PRIVACIDAD de la cámara: mientras alguna app tenga abierto un
// `/dev/videoN`, aparece un icono rojo pulsante en la pastilla del sistema, al
// lado del de micrófono. Es su gemelo, y comparte con él las clases `.recording`
// para que "algo te está captando ahora mismo" se vea siempre igual.
//
// Vive en `indicadores/sistema/` y no en un dominio propio porque su pariente
// real no es el micro sino `CapturaPantalla`: los dos son avisos de privacidad
// alimentados por un script de `hypr/scripts/` a través de un JSON, no por una
// biblioteca de audio.
//
// ── AQUÍ NO SE DECIDE NADA, Y ESO ES A PROPÓSITO ────────────────────────────
// La condición "hay cámara Y la está usando alguien" NO se compone en este
// fichero. `usoCamara` deriva `enUso` de la lista de cámaras ocupadas (ver
// `servicios/camara/uso.ts`), así que "en uso" ya implica "hay cámara": un
// `createComputed(() => hayCamara() && camaraEnUso())` sería redundante y,
// peor, volvería a pisar la mina que documenta `audio/Microfono.tsx` — gnim
// suscribe un computed solo a las dependencias que LEYÓ en su primera
// evaluación, y montado dentro de un `<With>` (que es exactamente como lo monta
// `RanuraCondicionalBarra`) esa lista es la definitiva. Con `hayCamara` en false
// al arrancar —la enumeración de udev tarda unos ms— el `&&` cortocircuitaba y
// el indicador se quedaba clavado en false para toda la sesión, sin un error.
// Una sola fuente de verdad no tiene ese problema.
import { createState } from "ags"
import { Gtk } from "ags/gtk4"
import { crearCicloVida } from "../../../../utilidades/cicloVida"
import { descripcionUso, usoCamara } from "../../../../servicios/camara/uso"
import { tituloBarra } from "../../componentes/tituloBarra"

export default function Camara() {
  const cicloVida = crearCicloVida()

  // El texto del tooltip se guarda en un estado propio, alimentado por UNA
  // suscripción explícita. El ciclo de vida no es adorno: este widget lo monta y
  // lo DESMONTA `RanuraCondicionalBarra` en cada encendido y apagado de la
  // cámara —o sea una vez por videollamada, no una por sesión—, así que una
  // suscripción sin dar de baja no "se limpiaría al cerrar el shell": se
  // acumularía una por llamada, actualizando estados de widgets ya muertos.
  const [descripcion, setDescripcion] = createState(descripcionUso(usoCamara.get()))
  // El valor inicial se siembra arriba a mano: `subscribe` no dispara al
  // registrarse, y sin esta siembra el tooltip nacía con el texto de "libre"
  // justo en el instante en que el icono aparece porque NO lo está.
  cicloVida.suscribir(usoCamara, (u) => setDescripcion(descripcionUso(u)))

  return (
    <box
      valign={Gtk.Align.CENTER}
      $={(self: Gtk.Widget) => tituloBarra(self, descripcion)}
      cssClasses={["recording", "camara-indicador"]}
    >
      <label cssClasses={["icon"]} label="󰄀" />
    </box>
  )
}
