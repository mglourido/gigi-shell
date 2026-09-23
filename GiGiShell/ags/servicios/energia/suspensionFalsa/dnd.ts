// servicios/energia/suspensionFalsa/dnd.ts
//
// El efector de **No molestar** de la suspensión falsa: tapa los popups mientras el usuario
// no está, y —esto es lo que no se ve de fuera— **decide quién gobierna el SONIDO** durante
// ese rato. Las dos cosas van juntas en este fichero porque son la misma pregunta con dos
// respuestas: *¿este silencio lo pidió el usuario o lo pusimos nosotros?*
//
// ── POR QUÉ IMPORTA TANTO: EL DESPERTADOR MUDO ────────────────────────────────────────
// Las alarmas, el temporizador y el cronómetro NO reproducen nada por su cuenta: emiten una
// notificación normal con los hints de sonido y decide `decidirSonido()`
// (`modulos/notificaciones/sonido/decision.ts`). Y allí el No molestar **calla el sonido**, sin
// que una notificación crítica se lo salte — las dos cosas son deliberadas y no se tocan.
// Consecuencia: encender el DND normal al entrar en suspensión falsa dejaría **las alarmas
// mudas**, y el ajuste «silenciar alarmas» no tendría nada que silenciar. Un despertador que
// no suena porque el equipo estaba en suspensión falsa es el peor fallo posible de esta
// función, y es completamente silencioso: no hay error, no hay log, solo un usuario que se
// queda dormido. Ver «Alarmas, temporizador y No molestar» en docs/suspension-falsa.md.
//
// La salida es distinguir los dos DND. Este módulo publica `silencioDeSuspensionFalsa()`, que
// es lo que `decidirSonido` recibe como `dndSuspensionFalsa`: con él, el sonido pasa a
// gobernarlo los dos ajustes (`sfSilenciarNotificaciones`, `sfSilenciarReloj`) en vez del DND,
// y el reloj suena por defecto. El DND **manual** del usuario no cambia en absoluto: si estaba
// puesto antes de entrar, sigue callando todo, alarmas incluidas — ni lo tocamos ni lo
// levantamos.
//
// ── LA DISCIPLINA `autoOwned`, Y POR QUÉ ESTÁ DUPLICADA ───────────────────────────────
// Es la misma de `modulos/notificaciones/autoDnd/watcher.ts`: solo apagamos el DND al salir si
// lo encendimos nosotros, y si el usuario lo apaga a mano mientras tanto, manda lo suyo. No se
// reutiliza aquel código porque **su estado es privado del módulo y describe otra condición**
// (juego o app a pantalla completa): un solo par de banderas compartido por dos dueños
// independientes se pisaría en el peor momento —el auto-DND soltando el DND que puso la
// suspensión falsa al cerrarse un juego, o al revés— y ese fallo tampoco da error, solo
// notificaciones que aparecen cuando no debían. Dos dueños, dos banderas.
//
// Efecto colateral conocido y aceptado: nuestras escrituras las ve el watcher del auto-DND por
// `notify::dont-disturb` y las lee como manuales (pone su `autoOwned` a false y, al apagar
// nosotros, su `userOptedOut` a true). Lo único que provoca es que el auto-DND no vuelva a
// encenderse hasta que su condición se limpie y se dispare otra vez — inofensivo, y arreglarlo
// exigiría tocar un módulo que no es de esta función.

import AstalNotifd from "gi://AstalNotifd"
import { sfNoMolestar } from "../powerState"
import type { EfectorSuspensionFalsa } from "./efectores"

/** ¿Hay una suspensión falsa en curso? Se lleva **aquí dentro** y no se importa de
 *  `../suspensionFalsa`, que es quien nos llama: ese import cerraría el ciclo
 *  suspensionFalsa → efectores → dnd → suspensionFalsa. `aplicar()`/`restaurar()` son
 *  exactamente los dos instantes en que ese dato cambia, así que no hace falta más. */
let activa = false

/** ¿El DND vigente lo encendimos NOSOTROS? Solo entonces lo apagamos al salir. */
let propio = false

/** El usuario apagó el DND a mano durante la suspensión falsa. Manda lo suyo: a partir de ahí
 *  ni lo re-encendemos ni seguimos gobernando el sonido — nos ha pedido oír las cosas. */
let usuarioSolto = false

/** Guarda para distinguir nuestras escrituras de las manuales en `notify::dont-disturb`. */
let escrituraPropia = false

let vigilando = false

function daemon(): AstalNotifd.Notifd | null {
  try {
    return AstalNotifd.get_default()
  } catch (error) {
    console.error("[suspension-falsa/dnd] no hay daemon de notificaciones:", error)
    return null
  }
}

function fijarDnd(notifd: AstalNotifd.Notifd, valor: boolean): void {
  escrituraPropia = true
  try {
    notifd.dontDisturb = valor
  } finally {
    escrituraPropia = false
  }
}

/** Se conecta una sola vez, y solo cuando hace falta (la primera entrada). Suscribirse en el
 *  arranque haría trabajo por una función que puede no usarse en toda la sesión. */
function vigilarCambiosManuales(notifd: AstalNotifd.Notifd): void {
  if (vigilando) return
  vigilando = true
  notifd.connect("notify::dont-disturb", () => {
    if (escrituraPropia || !activa) return
    if (notifd.dontDisturb) {
      // Encendido a mano estando nosotros dentro: el DND pasa a ser del usuario, así que ya
      // no es nuestro (no lo apagaremos al salir) y su silencio manda sobre los dos ajustes.
      propio = false
      usuarioSolto = false
    } else {
      propio = false
      usuarioSolto = true
    }
  })
}

/**
 * ¿Gobierna la suspensión falsa el silencio de audio ahora mismo?
 *
 * Es la entrada `dndSuspensionFalsa` de `decidirSonido`. Verdadero cuando hay una suspensión
 * falsa en curso **y** el silencio vigente no es una decisión del usuario:
 *
 *  · Sin suspensión falsa → false. Nada cambia respecto de lo de siempre.
 *  · Con DND MANUAL puesto (de antes de entrar, o encendido a mano durante) → false: silencio
 *    total, alarmas incluidas, que es lo que pide quien enciende el No molestar.
 *  · Con el usuario habiendo apagado el DND a mano durante la suspensión falsa → false
 *    también: nos ha dicho que quiere oír, y los ajustes no están para contradecirle.
 *  · En lo demás → true, y mandan `sfSilenciarNotificaciones` / `sfSilenciarReloj`. Ojo a que
 *    esto incluye el caso «el ajuste de DND está apagado»: los dos ajustes de sonido son
 *    independientes del DND y silenciar el audio sin tapar los popups es una combinación
 *    perfectamente pedible.
 */
export function silencioDeSuspensionFalsa(): boolean {
  if (!activa || usuarioSolto) return false
  const notifd = daemon()
  if (notifd === null) return activa
  // DND encendido que no es nuestro = lo puso el usuario: no lo pisamos ni en el sonido.
  return !(notifd.dontDisturb && !propio)
}

export const efectorDnd: EfectorSuspensionFalsa = {
  nombre: "dnd",

  aplicar() {
    // Se marca SIEMPRE, incluso con el ajuste de DND apagado: lo que gobierna el sonido es
    // estar en suspensión falsa, no haber encendido el No molestar.
    activa = true
    usuarioSolto = false

    const notifd = daemon()
    if (notifd === null) return
    vigilarCambiosManuales(notifd)

    if (!sfNoMolestar.get()) return
    // Ya estaba puesto: es del usuario. Ni lo tocamos ni lo apagaremos al salir (`propio`
    // se queda en false), y su silencio seguirá mandando sobre los ajustes.
    if (notifd.dontDisturb) return

    fijarDnd(notifd, true)
    propio = true
  },

  restaurar() {
    // Solo se deshace lo que se impuso de verdad (contrato de `efectores.ts`). Se comprueba
    // además que el DND siga encendido: si alguien lo apagó por otra vía, escribir `false`
    // otra vez sería inocuo pero mentiría en la traza de `notify::dont-disturb` de los demás.
    const notifd = daemon()
    if (propio && notifd !== null && notifd.dontDisturb) fijarDnd(notifd, false)
    propio = false
    usuarioSolto = false
    activa = false
  },
}
