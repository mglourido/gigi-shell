import GLib from "gi://GLib"
import { createRoot } from "ags"

/**
 * Colapsa en UNA sola ejecución todas las peticiones de reconstrucción de un mismo turno.
 *
 * **Existe porque `gnim` no agrupa notificaciones.** Cada `set` de un estado llama a sus
 * suscriptores de forma síncrona, uno a uno (`jsx/state.ts`), así que un widget suscrito a un
 * estado *y* a un derivado de ese estado se reconstruye dos veces por cambio — y tres si el
 * llamante toca dos estados seguidos, como hace `seleccionarFecha()` sobre un día de relleno.
 * Con la cuadrícula del mes eso eran hasta tres reconstrucciones de 42 botones, en cada monitor,
 * por un solo clic.
 *
 * Peor que el coste: la **primera** de esas pasadas lee el derivado todavía sin invalidar (el
 * `createComputed` de gnim invalida su caché en el mismo recorrido de suscriptores en el que
 * avisa), o sea que pinta los datos del mes anterior y los tira en el mismo turno. Al colapsar,
 * la única pasada que queda ocurre ya con todo asentado.
 *
 * El retraso es un `idle` de baja prioridad, no un temporizador: no hay reloj nuevo, la
 * reconstrucción entra cuando el bucle principal se queda sin trabajo del frame en curso.
 *
 * ## Cada pasada corre en su propio ámbito (`createRoot`), y no es opcional
 *
 * El JSX de gnim registra un `onCleanup` por cada widget con señal o binding (`jsx/jsx.ts`), y ese
 * `onCleanup` va al `Scope` que esté activo (`jsx/scope.ts`). Reconstruir desde el callback del
 * `idle` ocurre **fuera de todo ámbito**: `Scope.current` es `null`, gnim escupe
 * `ags-CRITICAL … Error: out of tracking context: will not be able to cleanup` por cada celda y
 * ningún handler ni suscripción de los widgets que se acaban de tirar se da de baja.
 *
 * Restaurar el ámbito del componente (`getScope().run(...)`) apagaría el aviso pero cambiaría la
 * fuga de sitio: los 42 `onCleanup` de cada pasada se acumularían en el ámbito de la vista, que
 * vive lo que viva el panel, y solo se ejecutarían al destruirlo. Por eso cada reconstrucción abre
 * un ámbito propio y se **desecha el de la pasada anterior** justo antes: las bajas se hacen
 * cuando toca, que es cuando esos widgets dejan de existir.
 */
export function crearReconstruccionCoalescida(reconstruir: () => void) {
  let pendiente: number | null = null
  /** Baja del ámbito de la última pasada; `null` mientras no se haya pintado nada. */
  let desecharAmbito: (() => void) | null = null

  function quitarPendiente(): void {
    if (pendiente !== null) {
      GLib.source_remove(pendiente)
      pendiente = null
    }
  }

  function ejecutar(): void {
    desecharAmbito?.()
    desecharAmbito = null
    createRoot((desechar) => {
      desecharAmbito = desechar
      reconstruir()
    })
  }

  /** Pide una reconstrucción. Llamarla N veces en el mismo turno ejecuta `reconstruir` una vez. */
  function programar(): void {
    if (pendiente !== null) return
    pendiente = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      pendiente = null
      ejecutar()
      return GLib.SOURCE_REMOVE
    })
  }

  /**
   * Reconstruye ya, descartando lo que hubiera pendiente. Para el primer pintado: el widget tiene
   * que devolverse con contenido, no vacío a la espera de un idle.
   */
  function ahora(): void {
    quitarPendiente()
    ejecutar()
  }

  /**
   * Cancela lo pendiente y da de baja los widgets de la última pasada. Es lo que hay que llamar
   * desde el `onCleanup` del componente: sin esto, las señales de las celdas vivas se quedarían
   * conectadas.
   */
  function cancelar(): void {
    quitarPendiente()
    desecharAmbito?.()
    desecharAmbito = null
  }

  return { programar, ahora, cancelar }
}
