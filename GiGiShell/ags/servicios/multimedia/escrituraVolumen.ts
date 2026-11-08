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

/**
 * ── Un endpoint recién aparecido NO se puede escribir todavía ──────────────────
 *
 * Al llegar `speaker-added` / `stream-added` (y en general la primera vez que un
 * proceso ve un nodo), `ep.volume` aún no está en la escala de la UI. Medido con un
 * sink nulo y con `paplay` sobre él:
 * - nodo creado en vivo → `volume = 0`, y ~1 ms después `notify::volume` con el real;
 * - nodo ya existente, visto por un cliente recién creado → el valor CRUDO de los
 *   canales (0.0689 = 0.41³), y ~1 ms después `notify::volume` con 0.41.
 *
 * Escribir en ese hueco falla de dos maneras, las dos mudas. Con `volume = 0`,
 * AstalWp no hace nada y avisa `astal_wp_node_set_volume: could not get current
 * volume for node N` (issue #322). Con el valor crudo es peor: la escritura se aplica
 * con la curva equivocada y queda la RAÍZ CÚBICA de lo pedido (medido: `= 0.3` →
 * 0.669 = 0.3^(1/3)), o sea un salto de volumen hacia arriba.
 *
 * Y esperar a la primera notificación NO basta: escribir DENTRO de ese manejador,
 * en el acto, también se pierde. Medido con `paplay`: `= 0.2` en el primer
 * `notify::volume` → se lee 1 y no llega nada más, sin aviso; la misma escritura
 * 50 ms después cuaja (notify con 0.2000000031). Y es una carrera, no una regla
 * fija: en una de las pasadas la escritura temprana sí entró. Por eso
 * `aplicarAlInicializar` escribe un momento DESPUÉS de esa notificación y además
 * COMPRUEBA que el valor ha cuajado, reintentando un número acotado de veces.
 *
 * Si la notificación no llega nunca (el endpoint ya estaba inicializado, o arranca
 * de verdad a 0 y no cambia), se aplica pasado `ESPERA_INICIALIZACION_MS`, holgado
 * de sobra frente al ~1 ms medido.
 */
const ESPERA_INICIALIZACION_MS = 500
/** Margen tras la notificación de inicialización, y entre comprobaciones. */
const REINTENTO_MS = 100
/** Tope de escrituras: cubre también el tramo amplificado, que va por `wpctl` y tarda. */
const MAX_INTENTOS = 5

const ESPERA_MS = 60

type Endpoint = { id: number; volume: number }

type Senalable = Endpoint & {
  connect(senal: string, cb: () => void): number
  disconnect(id: number): void
}

/**
 * Aplica a un endpoint RECIÉN APARECIDO el valor que devuelva `objetivo()` en cuanto
 * acepte escrituras, y comprueba que cuaja (ver el bloque de arriba). `objetivo` se
 * vuelve a leer en cada intento: si el preset cambia o desaparece entretanto, manda
 * el actual. `alEscribir` avisa de cada escritura (para abrir ventanas de eco) y
 * `alTerminar` de que el trámite ha acabado, haya cuajado o no. Devuelve la función
 * que lo cancela; llamarla en la baja del endpoint es obligatorio.
 */
export function aplicarAlInicializar(
  ep: Senalable,
  objetivo: () => number | undefined,
  avisos: { alEscribir?: () => void; alTerminar?: () => void } = {},
): () => void {
  let temporizador: number | null = null
  let intentos = 0
  let terminado = false

  const programar = (ms: number) => {
    if (temporizador !== null) GLib.source_remove(temporizador)
    temporizador = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
      temporizador = null
      intentar()
      return GLib.SOURCE_REMOVE
    })
  }

  const terminar = () => {
    if (terminado) return
    terminado = true
    if (temporizador !== null) { GLib.source_remove(temporizador); temporizador = null }
    try { ep.disconnect(manejador) } catch { }
    avisos.alTerminar?.()
  }

  const intentar = () => {
    const valor = objetivo()
    // Tolerancia de 1 punto: la curva cúbica no devuelve el valor exacto escrito.
    if (valor === undefined || Math.abs(ep.volume - valor) <= 0.01 || intentos >= MAX_INTENTOS) {
      terminar()
      return
    }
    intentos++
    fijarVolumenEndpoint(ep, valor)
    avisos.alEscribir?.()
    programar(REINTENTO_MS)
  }

  // La primera notificación es la de inicialización: el valor ya está en su escala.
  // Adelanta la espera larga a `REINTENTO_MS`. Tras la primera escritura ya hay una
  // comprobación en marcha, y el eco de la escritura no debe aplazarla.
  const manejador = ep.connect("notify::volume", () => {
    if (intentos === 0) programar(REINTENTO_MS)
  })
  programar(ESPERA_INICIALIZACION_MS)
  return terminar
}

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

/**
 * Suelta el estado de un endpoint que ha desaparecido. Sin esto el mapa crecía con
 * una entrada por cada stream que sonara en la sesión (los ids de PipeWire no se
 * reutilizan pronto, así que nunca se pisaban). Lo llaman los vigilantes de presets
 * en `*-removed`. Un `wpctl` ya en vuelo no se ve afectado: guarda su propio estado.
 */
export function olvidarEndpoint(id: number): void {
  const estado = estados.get(id)
  if (!estado) return
  cancelarPendiente(estado)
  estados.delete(id)
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
