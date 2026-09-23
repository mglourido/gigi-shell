// servicios/energia/suspensionFalsa/efectores.ts
//
// Los EFECTORES de la suspensión falsa: cada cosa que se apaga, en su propio módulo, con
// una interfaz de dos métodos. El orquestador (`../suspensionFalsa.ts`) no sabe qué hace
// ninguno; solo los recorre en orden al entrar y **en orden inverso** al salir.
//
// Por qué una lista y no diez llamadas escritas a mano en el orquestador:
//
//  · El orden inverso al salir es una REGLA DEL DISEÑO, no una casualidad. La lista lo
//    garantiza sola. Escrito a mano, el día que alguien añada un efector al final de la
//    entrada y al final de la salida, el deshielo de las apps dejará de ir primero — y ese
//    fallo concreto (una app congelada recibiendo entrada antes de descongelarse, que llega
//    al escritorio con una cola de basura) no se parece en nada a su causa.
//  · Un efector que falla NO puede impedir que salgan los demás. Si el helper de TLP no
//    está instalado, o `brightnessctl` no encuentra el LED, la sesión tiene que volver
//    igual. De ahí el try/catch por efector en el orquestador y no alrededor del bucle.
//
// Contrato que debe cumplir cada efector, y no es negociable:
//
//  1. `restaurar()` solo deshace **lo que ese efector impuso de verdad**. Si no llegó a
//     aplicar nada (ajuste en "no tocar", hardware ausente, el usuario ya lo tenía así),
//     restaurar es un no-op. Es la misma disciplina de `brilloAhorro.ts` (`ultimoAplicado`)
//     y del watcher de auto-DND (`autoOwned`): lo que tocó el usuario mientras tanto MANDA.
//  2. `aplicar()` y `restaurar()` tienen que ser idempotentes: se pueden llamar dos veces
//     seguidas sin romper nada. El orquestador ya se guarda de no hacerlo, pero un crash a
//     mitad de la secuencia y el `init` del arranque siguiente pueden solaparse.
//  3. Nada de esperas largas: la salida la está esperando una persona con la pantalla
//     encendida. Lo que tarde, que lo lance y vuelva.

import { efectorDnd } from "./dnd"
import { efectorLeds } from "./leds"
import { efectorTlp } from "./tlp"
import { efectorPerfilEnergia } from "./perfilEnergia"
import { efectorBluetooth } from "./bluetooth"
import { efectorAudio } from "./audio"
import { efectorCongelarApps } from "./congelarApps"

export interface EfectorSuspensionFalsa {
  /** Para los logs. Aparece en el error si `aplicar`/`restaurar` revientan. */
  nombre: string
  aplicar(): void | Promise<void>
  restaurar(): void | Promise<void>
}

/**
 * Los efectores, EN ORDEN DE ENTRADA. La salida los recorre al revés, así que el último de
 * esta lista es el primero en deshacerse: por eso congelar apps va el último (lo único que
 * puede perder datos del usuario, y lo primero que hay que deshelar).
 */
export const EFECTORES: EfectorSuspensionFalsa[] = [
  // El DND va EL PRIMERO, y no por orden de llegada: es lo único de esta lista que decide si
  // el usuario se entera de algo mientras dure la suspensión falsa, y al salir tiene que ser
  // lo ÚLTIMO en deshacerse (la lista se recorre al revés) — devolver los popups antes de
  // haber restaurado LEDs, TLP y apps sería enseñárselos a un escritorio a medio volver.
  // Trae además la mitad de la decisión de sonido: ver la cabecera de `dnd.ts`, «el
  // despertador mudo».
  efectorDnd,
  // Se rellena por partes (ver docs/suspension-falsa.md, «Plan de implementación»):
  //   fase 4 → dnd  ✔ (el sonido no necesita efector: lo resuelve `decidirSonido` leyendo el
  //                    estado de este mismo módulo, sin nada que aplicar ni que restaurar)
  //   fase 5 → leds, tlp, bluetooth, audio  ✔  (el brillo se RETIRÓ: ver brilloAhorro.ts,
  //            «LA SUSPENSIÓN FALSA NO TOCA EL BRILLO»)
  //   después → perfilEnergia ✔ (power-profiles-daemon, para las máquinas sin TLP)
  //   fase 8 → congelarApps  ✔ (SIEMPRE el último de la lista)

  // Puntos 8-9 de la secuencia de entrada del documento, en su orden. Entre ellos el orden
  // es indiferente (son subsistemas independientes que no se leen entre sí); lo que importa
  // es que van DESPUÉS de apagar la pantalla y ANTES de congelar nada.
  efectorLeds,
  efectorTlp,
  // El hermano de TLP para las máquinas donde TLP no está —cualquier sobremesa, donde
  // `tlpAvailable` es falso porque no hay batería—, y donde por tanto la lista se quedaba
  // sin un solo control de energía de CPU. Va justo detrás porque son la misma pregunta
  // hecha a dos subsistemas distintos, y entre ellos el orden da igual: TLP escribe /etc y
  // PPD habla por D-Bus, no se leen el uno al otro. Es además el que más vatios mueve de
  // toda la lista (7-12 W medidos con RAPL; ver la cabecera de `perfilEnergia.ts`).
  efectorPerfilEnergia,
  // Los dos opcionales de «Qué más se apaga» del documento, los dos apagados por defecto.
  efectorBluetooth,
  efectorAudio,
  // ⚠️ EL ÚLTIMO, Y TIENE QUE SEGUIR SIÉNDOLO. Es lo único que puede perder datos del
  // usuario, y por el recorrido inverso de la salida es también lo primero que se deshace:
  // una app congelada que recibe eventos de entrada antes de descongelarse llega al
  // escritorio con una cola de basura. Nada nuevo va detrás de esta línea.
  efectorCongelarApps,
]
