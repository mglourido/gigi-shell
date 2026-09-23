import GLib from "gi://GLib"
import { execAsync } from "ags/process"

/** Escribir un volumen POR ENCIMA del 150 % no se puede hacer con AstalWp.
 *
 * `astal_wp_node_set_volume` **recorta a 1.5** (está en el propio .gir:
 * "The volume is clamped to be between 0 and 1.5"), y lo hace en silencio:
 * `ep.volume = 2.0` no da error, deja 1.5 y la lectura posterior confirma 1.5 —
 * así que un deslizador que llegue al 200 % se quedaría clavado a dos tercios de
 * su recorrido sin una sola pista de por qué (medido con gjs: `set 2.0` →
 * `1.5000000000000002`).
 *
 * PipeWire sí acepta más: `wpctl set-volume @DEFAULT_AUDIO_SOURCE@ 1.7` deja
 * `Volume: 1.70` y **AstalWp lo LEE bien** (`ep.volume` → 1.6999…). O sea que el
 * recorte es solo del setter. Por eso el tramo amplificado se escribe con
 * `wpctl` y el resto sigue yendo por la propiedad, que es instantánea y no
 * cuesta un proceso.
 *
 * ── Por qué hay estrangulador ────────────────────────────────────────────────
 *
 * Arrastrar el deslizador emite un `change-value` por píxel. Con la propiedad
 * eso es gratis; con `wpctl` sería un proceso por evento. Se mantiene **una
 * escritura en vuelo como mucho** por endpoint y al terminar se lanza el último
 * valor pendiente, igual que las escrituras DDC del brillo.
 *
 * ⚠️ La ruta rápida CANCELA lo que haya pendiente, y al revés: si un `wpctl` ya
 * lanzado termina cuando el usuario ya ha bajado por debajo de 1.5, se re-aplica
 * el pendiente. Sin eso, soltar el deslizador bajando desde el tramo amplificado
 * podía dejar el volumen en el valor alto que iba en vuelo.
 */

/** Tope del setter de AstalWp. Por encima hay que ir por `wpctl`. */
export const LIMITE_ASTAL = 1.5

const ESPERA_MS = 60

type Endpoint = { id: number; volume: number }

type Estado = { pendiente: number; enVuelo: boolean; temporizador: number | null }

const estados = new Map<number, Estado>()

function estadoDe(id: number): Estado {
  let e = estados.get(id)
  if (!e) {
    e = { pendiente: 0, enVuelo: false, temporizador: null }
    estados.set(id, e)
  }
  return e
}

function cancelarPendiente(estado: Estado) {
  if (estado.temporizador !== null) {
    GLib.source_remove(estado.temporizador)
    estado.temporizador = null
  }
}

function programarAmplificado(ep: Endpoint, estado: Estado) {
  if (estado.temporizador !== null || estado.enVuelo) return
  estado.temporizador = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ESPERA_MS, () => {
    estado.temporizador = null
    const valor = estado.pendiente
    if (valor <= LIMITE_ASTAL) {
      fijarVolumenEndpoint(ep, valor)
      return GLib.SOURCE_REMOVE
    }
    estado.enVuelo = true
    execAsync(["wpctl", "set-volume", `${ep.id}`, valor.toFixed(2)])
      .catch(() => { })
      .finally(() => {
        estado.enVuelo = false
        // Lo que haya llegado mientras tanto manda sobre lo que se acaba de escribir.
        if (estado.pendiente !== valor) fijarVolumenEndpoint(ep, estado.pendiente)
      })
    return GLib.SOURCE_REMOVE
  })
}

/** Fija el volumen de un endpoint aceptando el tramo amplificado (>150 %). */
export function fijarVolumenEndpoint(ep: Endpoint, valor: number): void {
  const estado = estadoDe(ep.id)
  estado.pendiente = valor
  if (valor <= LIMITE_ASTAL) {
    cancelarPendiente(estado)
    try { ep.volume = valor } catch { }
    return
  }
  programarAmplificado(ep, estado)
}
