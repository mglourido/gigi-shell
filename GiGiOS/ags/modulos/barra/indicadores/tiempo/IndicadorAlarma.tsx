import { createState } from "ags"
import { Gtk } from "ags/gtk4"
import { ticReloj } from "../../../../servicios/sistema/reloj"
import { crearCicloVida } from "../../../../utilidades/cicloVida"
import { alarmas } from "../../../calendario/reloj/estadoReloj.ts"
import {
  VENTANA_ALARMA_INMINENTE_MS,
  avisoAlarmas,
  lineaAvisoAlarma,
} from "../../../calendario/reloj/planificadorAlarmas.ts"
import { tituloBarra } from "../../componentes/tituloBarra"

/**
 * Aviso de alarma próxima. Vive DENTRO de la pastilla del reloj, a la izquierda de la hora.
 *
 * Aparece cuando alguna alarma activa suena dentro de la hora siguiente y se va sola cuando deja de
 * haberlas. En **blanco** —el mismo `$text` que la hora— mientras solo es un recordatorio, y en
 * **naranja** cuando la más próxima entra en los últimos 15 minutos. El salto de color es el aviso
 * de verdad: el icono lleva en pantalla desde una hora antes, así que aparecer no avisa de nada;
 * solo cambiar.
 *
 * **No lleva ni un gesto propio.** Está dentro del botón del reloj, así que hereda los dos que ya
 * tenía (izquierdo abre el calendario, derecho es del cronómetro) y no añade ninguno: pulsarlo
 * abre el calendario, que es justo donde se editan las alarmas. Lo que sí es suyo es el **título**
 * (`tituloBarra`, colgado del icono y no de la pastilla): sobre el icono sale la lista de alarmas.
 *
 * **El refresco va con `ticReloj`, el tic global del minuto**, y no con un temporizador propio: los
 * dos umbrales son de minutos enteros y las alarmas suenan en punto de minuto, así que un tic por
 * minuto los cruza siempre dentro del mismo minuto en que ocurren. Sondear por segundo aquí sería
 * repintar sesenta veces para el mismo resultado, y en todos los monitores.
 */
export default function IndicadorAlarma(): Gtk.Widget {
  const cicloVida = crearCicloVida()

  const calcular = () => {
    const ahora = Date.now()
    const { proximas, inminente } = avisoAlarmas(alarmas.get(), ahora)
    if (proximas.length === 0) return { visible: false, inminente: false, tooltip: "" }
    const minutos = Math.round(VENTANA_ALARMA_INMINENTE_MS / 60_000)
    const cabecera = inminente
      ? `Alarma en menos de ${minutos} min`
      : proximas.length === 1
        ? "Alarma en la próxima hora"
        : `${proximas.length} alarmas en la próxima hora`
    return {
      visible: true,
      inminente,
      tooltip: [cabecera, ...proximas.map((p) => lineaAvisoAlarma(p, ahora))].join("\n"),
    }
  }

  const [aviso, establecerAviso] = createState(calcular())
  const sincronizar = () => establecerAviso(calcular())

  // Las dos fuentes hacen falta: el paso del tiempo acerca las alarmas ya puestas, y editar la lista
  // puede meter o sacar una de la ventana sin que el reloj haya avanzado.
  cicloVida.suscribir(ticReloj, sincronizar)
  cicloVida.suscribir(alarmas, sincronizar)

  return (
    <label
      cssClasses={aviso((a) =>
        a.inminente ? ["clock-alarma", "alarma-inminente"] : ["clock-alarma"],
      )}
      valign={Gtk.Align.CENTER}
      visible={aviso((a) => a.visible)}
      $={(self: Gtk.Widget) => tituloBarra(self, aviso((a) => a.tooltip))}
      label="󰀠"
    />
  ) as unknown as Gtk.Widget
}
