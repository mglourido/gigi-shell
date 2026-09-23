import GLib from "gi://GLib"
import { createState, createEffect } from "ags"
import { Gtk } from "ags/gtk4"
import { toggleCalendar } from "../../../../estado/shell.tsx";
import { timeFormat, formatClock } from "../../../ajustes/preferences"
import { ticReloj } from "../../../../servicios/sistema/reloj"
import { crearCicloVida } from "../../../../utilidades/cicloVida"
import IndicadorAlarma from "./IndicadorAlarma"
import type { EstadoVisibilidadBarra } from "../../../../estado/visibilidadBarra"
import {
  cronometro,
  iniciarCronometro,
  pausarCronometro,
  temporizador,
} from "../../../calendario/reloj/estadoReloj.ts"
import {
  formatearCronometroCorto,
  formatearRestante,
  msHastaSiguienteTick,
  msHastaSiguienteTickAscendente,
  restanteTemporizador,
  transcurrido,
} from "../../../calendario/reloj/tiempos.ts"

/**
 * Reloj de la barra. Clic izquierdo abre el panel de calendario; **clic derecho maneja el
 * cronómetro** sin tener que abrir nada.
 *
 * El clic derecho es un **interruptor de dos posiciones**: arranca el cronómetro y lo para. Al
 * pararlo **desaparece de la barra pero NO se reinicia** — la medida se conserva y se sigue viendo
 * en el panel, donde está el botón «Reiniciar». Antes eran tres pasos (corriendo → pausado →
 * parado) y el intermedio dejaba una cifra congelada ocupando sitio en la barra sin contar nada:
 * parecía que el clic no había hecho efecto, y hacía falta un tercer clic —que además borraba la
 * medida— para recuperar la hora. Es el mismo cronómetro que el de la pestaña Reloj del panel
 * —comparten `estadoReloj.ts`—, así que lo que se arranca aquí se ve y se maneja allí, y al revés:
 * no hay un segundo cronómetro invisible corriendo por su cuenta.
 *
 * Consecuencia buscada: **desde la barra no se puede borrar la medida.** Reiniciar es destructivo y
 * su sitio es el panel, con una etiqueta que lo diga, no un tercer paso de un gesto a ciegas.
 *
 * **El TEMPORIZADOR también sale aquí, pero SOLO se mira.** No tiene gesto propio ni lo comparte
 * con nadie: se arranca en la pestaña Reloj del panel y la barra se limita a enseñar la cuenta
 * atrás, en **azul**, para no tener que abrir el panel a comprobar cuánto queda. Los dos únicos
 * gestos del reloj siguen siendo los de antes (izquierdo abre el calendario, derecho es del
 * cronómetro), y esa asimetría es deliberada: un tercer gesto sobre una pastilla de 60 px que ya
 * carga dos es más fácil de disparar sin querer que de recordar.
 *
 * **La hora NO cede el sitio nunca.** El orden es fijo —`hora │ temporizador │ cronómetro`— y los
 * contadores se añaden a su derecha según estén activos, cada uno en su color. Que la pastilla
 * sustituyera la hora por un contador es lo que obligaba a pararlo solo para saber qué hora era, en
 * el único sitio de la pantalla donde se mira eso. Posición fija y no «lo que haya, en orden»: si
 * el cronómetro saltara a la izquierda cuando no hay temporizador, la cifra del medio cambiaría de
 * significado según lo que esté activo, y la barra se lee de un vistazo o no se lee.
 *
 * **La pastilla NO tiene tooltip propio.** El único que hay es el del icono de alarma, que sí dice
 * algo que no está a la vista (qué alarmas y cuándo). Describir con un tooltip lo que ya se está
 * leyendo —una hora, una cuenta atrás, los colores que las distinguen— es tapar la barra con una
 * ventana para repetir lo que hay debajo, y encima aparecía al pasar por encima de camino a
 * cualquier otra cosa.
 *
 * **La barra enseña `MM:SS`, sin décimas** (`formatearCronometroCorto`): esta etiqueta está siempre
 * en pantalla y en todos los monitores, y las décimas obligarían a repintarla a 10 Hz para un dígito
 * ilegible a este tamaño. El panel sí las enseña. Como la medida sale de marcas de tiempo, parar el
 * tick —barra oculta— no desvía la cifra ni un milisegundo.
 */
export default function Reloj({ visibilidad }: { visibilidad: EstadoVisibilidadBarra }) {
  const cicloVida = crearCicloVida()

  /**
   * Lo que hay que pintar. La hora está SIEMPRE; `null` en un contador significa «no ocupa sitio».
   *
   * **Los dos contadores no tratan igual la pausa, y es a propósito.** El cronómetro pausado
   * desaparece de la barra (lo que se pide con el clic derecho es pararlo y quitarlo de en medio,
   * sin perder la medida, que sigue viva en el panel). El temporizador pausado se queda: tiene un
   * vencimiento pendiente que se va a reanudar, y esconderlo sería esconder que hay un aviso a
   * medias — se pausa desde el panel, además, así que nadie va a estar buscándolo en la barra.
   */
  interface Vista {
    temporizador: string | null
    cronometro: string | null
    hora: string
  }

  const vistaActual = (): Vista => {
    const t = temporizador.get()
    const c = cronometro.get()
    const ahora = Date.now()
    return {
      temporizador: t.estado === "parado" ? null : formatearRestante(restanteTemporizador(t, ahora)),
      cronometro: c.estado === "corriendo" ? formatearCronometroCorto(transcurrido(c, ahora)) : null,
      hora: formatClock(),
    }
  }

  // Se congela la vista ENTERA, no una cadena: con dos contadores en pantalla, guardar solo el texto
  // del que mandara dejaría al otro con el valor de hace un rato al volver a mostrarse la barra.
  let ultimaVistaRenderizada = vistaActual()
  const [vista, establecerVista] = createState(ultimaVistaRenderizada)

  /** Lo que toca pintar: lo vivo con la barra a la vista, lo congelado mientras está oculta. */
  const vistaVisible = vista((v) => (visibilidad.visible() ? v : ultimaVistaRenderizada))

  // ── Tick de los contadores ─────────────────────────────────────────────────
  // Solo vive mientras algo de lo que se enseña se mueve Y la barra se ve. Se realinea en cada
  // vuelta contra `Date.now()` por lo mismo que el del panel: con `SOURCE_CONTINUE` el retraso se
  // acumula y la cifra se salta segundos a la vista.
  let tick: number | null = null

  const pararTick = () => {
    if (tick !== null) {
      GLib.source_remove(tick)
      tick = null
    }
  }
  cicloVida.registrar(pararTick)

  /**
   * Cuánto falta para el próximo cambio VISIBLE, mire quien mire. `null` = nada se mueve.
   *
   * Es el **mínimo** de las dos esperas, no la de una fuente elegida: cada contador se alinea con su
   * propia función —la cuenta atrás cambia de cifra cuando pasa el resto, la que sube cuando llega
   * al siguiente múltiplo— y con los dos en pantalla hay que despertar para el primero de los dos.
   * Cruzarlas daría un tick anticipado y otro tardío alternándose (ver `tiempos.ts`), y quedarse
   * con la de uno solo dejaría al otro repintándose a destiempo.
   *
   * Un contador en PAUSA no cuenta aquí aunque ocupe sitio: su cifra está congelada y despertar por
   * ella sería repintar lo mismo indefinidamente.
   */
  function esperaTick(): number | null {
    const ahora = Date.now()
    const t = temporizador.get()
    const c = cronometro.get()
    const esperas: number[] = []
    if (t.estado === "corriendo") esperas.push(msHastaSiguienteTick(restanteTemporizador(t, ahora)))
    if (c.estado === "corriendo") esperas.push(msHastaSiguienteTickAscendente(transcurrido(c, ahora), 1000))
    return esperas.length === 0 ? null : Math.min(...esperas)
  }

  function programarTick() {
    pararTick()
    const espera = esperaTick()
    if (espera === null) return
    tick = GLib.timeout_add(GLib.PRIORITY_DEFAULT, espera, () => {
      tick = null
      establecerVista(vistaActual())
      if (visibilidad.visible()) programarTick()
      return GLib.SOURCE_REMOVE
    })
  }

  function sincronizar() {
    // Se rearma siempre, en vez de conservar un tick pendiente como hacía la versión de una sola
    // fuente: al entrar o salir un contador cambia la cadencia, y un tick heredado dejaría la cifra
    // saltando a destiempo. Rearmar es barato —`sincronizar` corre una vez por minuto y en los
    // cambios de estado, no por segundo— y las dos esperas se realinean contra `Date.now()`, así que
    // no se acumula deriva.
    pararTick()
    if (visibilidad.visible()) programarTick()
    establecerVista(vistaActual())
  }

  // Repinta al instante cuando el usuario cambia el formato en Ajustes > Región, fecha y hora.
  cicloVida.suscribir(timeFormat, sincronizar)
  cicloVida.suscribir(ticReloj, sincronizar)
  cicloVida.suscribir(cronometro, sincronizar)
  cicloVida.suscribir(temporizador, sincronizar)

  let wasVisible = visibilidad.refrescar()

  // Única dependencia del efecto: el refresco local de esta barra. El resto
  // se lee con .get() para no re-ejecutar el efecto en cada tick.
  createEffect(() => {
    const visible = visibilidad.refrescar()
    if (!visible && wasVisible) {
      // Al ocultarse: congelar la etiqueta en lo que se muestra AHORA (antes se
      // cacheaba al mostrarse, quedando hasta 1 min desfasado durante el ocultado).
      ultimaVistaRenderizada = vista.get()
    }
    if (visible !== wasVisible) {
      wasVisible = visible
      // El tick cuelga de la visibilidad: al esconderse se suelta y al volver se
      // rearma ya alineado con el valor real, sin haber perdido medida por el camino.
      sincronizar()
      return
    }
    wasVisible = visible
  })

  /**
   * Clic derecho: en marcha lo para, parado o en pausa lo (re)arranca.
   *
   * `iniciarCronometro` sobre uno pausado **continúa** desde donde iba (conserva `acumuladoMs`, ver
   * `tiempos.ts`), no empieza de cero: por eso pararlo no pierde nada y volver a pulsar retoma la
   * misma medida. Reiniciar de verdad es cosa del botón del panel.
   */
  const alternarCronometro = () => {
    if (cronometro.get().estado === "corriendo") pausarCronometro()
    else iniciarCronometro()
  }

  return (
    <button
      valign={Gtk.Align.CENTER}
      cssClasses={["bar-pill-btn"]}
    >
      <box
        cssClasses={["bar-pill", "clock", "clock-pill"]}
        valign={Gtk.Align.CENTER}
        halign={Gtk.Align.CENTER}
        hexpand
        spacing={5}
      >
        {/* Una etiqueta por cifra y no una cadena montada a mano: el color va POR CIFRA, y un único
            `Gtk.Label` no puede llevar dos colores sin meter marcado Pango, que además obligaría a
            escapar el texto. Cada separador es su propia etiqueta por lo mismo — no es de ninguno de
            los dos, y en la cadena única habría heredado el color de quien fuera.

            Las cinco van SIEMPRE montadas y solo cambia su `visible`. Con posiciones fijas, el orden
            no depende de en qué orden se enciendan los contadores; construir y destruir etiquetas
            según hiciera falta sí lo haría.

            El aviso de alarma abre la pastilla y NO lleva separador detrás: aquí el `│` divide
            cifras que si no se leerían como una sola, y un icono no se confunde con un número. */}
        <IndicadorAlarma />
        <label
          valign={Gtk.Align.CENTER}
          label={vistaVisible((v) => v.hora)}
        />
        <label
          cssClasses={["clock-sep"]}
          valign={Gtk.Align.CENTER}
          visible={vistaVisible((v) => v.temporizador !== null)}
          label="│"
        />
        <label
          cssClasses={["clock-temporizador"]}
          valign={Gtk.Align.CENTER}
          visible={vistaVisible((v) => v.temporizador !== null)}
          label={vistaVisible((v) => v.temporizador ?? "")}
        />
        <label
          cssClasses={["clock-sep"]}
          valign={Gtk.Align.CENTER}
          visible={vistaVisible((v) => v.cronometro !== null)}
          label="│"
        />
        <label
          cssClasses={["clock-crono"]}
          valign={Gtk.Align.CENTER}
          visible={vistaVisible((v) => v.cronometro !== null)}
          label={vistaVisible((v) => v.cronometro ?? "")}
        />
      </box>
      <Gtk.GestureClick
        button={1}
        onPressed={() => toggleCalendar()}
      />
      <Gtk.GestureClick
        button={3}
        onPressed={alternarCronometro}
      />
    </button>
  )
}
