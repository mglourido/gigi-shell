// Cadena de indicadores de estado de la barra: los eslabones que hay entre la
// bandeja y la pastilla de quick settings (actualizaciones de kernel/GPU, captura
// de pantalla y notificaciones).
//
// Dos cosas que la cadena resuelve y que por separado no salían:
//
// 1. **Realce en cascada hacia la derecha.** Pasar el ratón por CUALQUIER eslabón
//    lo realza a él y a todos los que quedan a su derecha, hasta quick settings.
//    Así el realce se lee como una banda que sale de quick settings en vez de como
//    una isla suelta en mitad de la barra. Se propaga solo hacia la derecha: lo que
//    queda a la izquierda del cursor no se ilumina.
// 2. **Sin costuras.** Los eslabones se tocan y el que se enciende por arrastre pierde
//    sus esquinas (`cadena-continua`), así que la banda es un rectángulo liso desde la
//    cabecera —que conserva las suyas— hasta quick settings. Lo único que queda por
//    coser es el final: `JuntaCadena`, UNA sola, entre el último eslabón y quick
//    settings, que sí conserva sus cuatro esquinas; ver `.cadena-junta` en
//    `estilos/style.scss`.
//
// El estado es POR BARRA (una instancia por monitor, creada en `Barra.tsx` y pasada
// como prop): compartirlo en el módulo encendería también la cadena de la barra del
// otro monitor, donde no hay ningún puntero.
import { createComputed, createState, onCleanup, type Accessor } from "ags"
import { Gtk } from "ags/gtk4"

/**
 * Orden IZQUIERDA → DERECHA de los eslabones. El número es lo único que decide qué
 * se enciende con qué, así que un eslabón nuevo va con el índice de su posición
 * real en la barra (y renumerando los de su derecha).
 */
export const ESLABON = {
  actualizacionesKernel: 0,
  actualizacionesGpu: 1,
  capturaPantalla: 2,
  notificaciones: 3,
} as const

export interface CadenaEstado {
  /** Cierto si el eslabón debe ir realzado (el cursor está en él o a su izquierda). */
  resaltado(indice: number): Accessor<boolean>
  /** `base` más `cadena-resaltada` cuando toca; para `cssClasses`. */
  clases(indice: number, base: string[]): Accessor<string[]>
  /** Cierto si hay algún eslabón encendido, o sea si la banda existe. */
  activa: Accessor<boolean>
  entrar(indice: number): void
  salir(indice: number): void
}

const SIN_CURSOR = -1

export function crearCadenaEstado(): CadenaEstado {
  // El cursor solo puede estar en UN eslabón a la vez, así que el estado es su
  // índice y no un conjunto de eslabones dentro. Con un conjunto, un `leave` que no
  // llegue (GTK no siempre lo entrega al saltar el puntero de golpe — medido warpando
  // el cursor de un eslabón a otro) deja el anterior encendido para siempre; aquí lo
  // corrige el `enter` siguiente. Y el orden entrada/salida al cruzar de un eslabón al
  // de al lado da igual: `salir` solo apaga si el que se va es el que está marcado.
  const [actual, fijarActual] = createState<number>(SIN_CURSOR)

  return {
    resaltado: (indice) => actual((a) => a !== SIN_CURSOR && indice >= a),
    clases: (indice, base) =>
      actual((a) => {
        if (a === SIN_CURSOR || indice < a) return base
        // `cadena-continua` = encendido por arrastre, con otro eslabón encendido a su
        // izquierda. Ese pierde su esquina redondeada izquierda: dos bordes curvos
        // suavizados —el suyo y el relleno de la junta que lo abraza— nunca casan
        // píxel a píxel y dejaban una hebra clara siguiendo la curva. Sin curva no hay
        // nada que casar, y la junta que hay debajo queda tapada del todo. El eslabón
        // que está BAJO el cursor conserva la suya: es donde arranca la banda.
        const clases = [...base, "cadena-resaltada"]
        if (indice > a) clases.push("cadena-continua")
        return clases
      }),
    activa: actual((a) => a !== SIN_CURSOR),
    entrar: (indice) => fijarActual(indice),
    salir: (indice) => { if (actual.get() === indice) fijarActual(SIN_CURSOR) },
  }
}

/**
 * Detector de cursor de un eslabón. Va como hijo del widget que se quiere sensible
 * (el botón entero, no solo la pastilla).
 *
 * El `onCleanup` no es decorativo: los eslabones se ocultan solos (la captura al
 * dejar de grabar, las actualizaciones al instalarlas) y un widget que desaparece
 * bajo el cursor NO recibe `leave`, así que sin esto la cadena se quedaría
 * encendida para siempre.
 */
export function SensorCadena({ cadena, indice }: { cadena: CadenaEstado; indice: number }) {
  onCleanup(() => cadena.salir(indice))
  return (
    <Gtk.EventControllerMotion
      onEnter={() => cadena.entrar(indice)}
      onLeave={() => cadena.salir(indice)}
    />
  )
}

/**
 * Cierre de la cadena contra la pastilla de quick settings. Va UNA sola, en
 * `Barra.tsx`, entre el último eslabón y el botón de quick settings — no una por
 * eslabón: entre dos eslabones encendidos no hay nada que coser (se tocan y el de la
 * derecha va sin esquinas), y una junta ahí solo conseguía pintar su relleno DEBAJO de
 * la pastilla, dos capas del mismo blanco translúcido que sumaban una hebra más clara
 * siguiendo el arco. Quick settings sí conserva sus cuatro esquinas, y ahí es donde la
 * junta hace falta.
 *
 * `forzado` la rellena sin cursor: lo usa el panel de notificaciones abierto, que deja
 * su pastilla realzada y necesita seguir cosida a quick settings.
 */
export function JuntaCadena({
  cadena,
  forzado,
}: {
  cadena: CadenaEstado
  forzado?: Accessor<boolean>
}) {
  const clases = forzado
    ? createComputed([cadena.activa, forzado], (activa, extra) =>
        activa || extra ? ["cadena-junta", "cadena-resaltada"] : ["cadena-junta"],
      )
    : cadena.activa((a) => (a ? ["cadena-junta", "cadena-resaltada"] : ["cadena-junta"]))
  return <box cssClasses={clases} />
}
