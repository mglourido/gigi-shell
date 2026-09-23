// servicios/energia/suspensionFalsa/ledsFiltro.ts
//
// QUÉ LED es «retroiluminación» y cuál no. Aparte del efector para poder probarlo con
// `node --test`: aquel importa gi y no se puede cargar fuera de la sesión.
//
// El objetivo del ajuste es apagar el **delator visual** de que el equipo no está suspendido
// de verdad: la retroiluminación del teclado, la luz del logo, el LED de encendido. NO es
// «poner a cero todo lo que publique la clase `leds`», y la diferencia no es cosmética
// porque bajo esa clase conviven tres cosas muy distintas:
//
//  1. **Iluminación** (`*::kbd_backlight`, `*::illumination`, `platform::power`…). Es lo que
//     se quiere apagar. Nadie más las escribe, así que bajarlas y reponerlas es limpio.
//  2. **LEDs de estado del teclado** (capslock, numlock, scrolllock, compose, kana). Los
//     ESCRIBE EL KERNEL: llevan un trigger `kbd-*` y el subsistema de entrada los reescribe
//     en cada cambio de estado del bloqueo. Apagarlos es a la vez inútil (vuelven solos al
//     siguiente pulso) y mentiroso (el numlock encendido con su LED apagado), y si la
//     restauración fallara el usuario se queda con un indicador que miente hasta el próximo
//     toque de tecla. Además ya están apagados salvo que el bloqueo esté puesto, o sea que
//     no delatan nada mientras el equipo duerme.
//  3. **LEDs de red y de almacenamiento** (`enp4s0-0::lan`, `phy0::…`, `mmc0::`…). Los
//     gobierna el propio adaptador y su encendido es información de hardware, no adorno. Y
//     apagar la luz de la tarjeta de red mientras la red sigue viva —que es precisamente el
//     motivo de existir de la suspensión falsa— es apagar el indicador de lo único que se
//     está prometiendo mantener.
//
// La regla resultante: se apaga lo que NO es (2) ni (3). Es una lista de exclusión y no una
// de inclusión a propósito: un `*::kbd_backlight` de un portátil que aún no conocemos tiene
// que entrar solo, y equivocarse por exceso aquí cuesta una luz apagada de más durante la
// suspensión, no un LED que miente.

/** Sufijos de los LEDs de ESTADO del teclado. Se comprueban además del trigger porque no
 *  todos lo llevan: en esta máquina `input9::compose` sale con trigger `none` y es
 *  exactamente igual de indicador de estado que su vecino `input9::capslock`, que sí trae
 *  `kbd-capslock`. Con solo el trigger se colaría. */
const SUFIJOS_ESTADO_TECLADO = [
  "capslock", "numlock", "scrolllock", "compose", "kana", "shiftlock",
]

/** Sufijos/fragmentos de los LEDs gobernados por un aparato (red, almacenamiento). */
const FRAGMENTOS_APARATO = [
  "::lan", "::wlan", "::link", "::activity", "::rx", "::tx", "::disk", "::mmc",
]

/**
 * ¿Se puede apagar este LED durante la suspensión falsa?
 *
 * @param nombre  el del directorio de `/sys/class/leds` (= el `-d` de brightnessctl).
 * @param trigger el trigger ACTIVO (el que va entre corchetes en `…/trigger`), o "" si no
 *                se pudo leer — que se trata como «sin trigger», no como motivo de descarte:
 *                un fallo de lectura no puede dejar la función sin hacer nada en silencio.
 */
export function esLedApagable(nombre: string, trigger: string): boolean {
  const n = nombre.toLowerCase()
  const t = trigger.trim().toLowerCase()

  // Grupo (2), por trigger: cualquier `kbd-*` lo escribe el subsistema de entrada.
  if (t.startsWith("kbd-")) return false
  // Grupo (2), por nombre: los que no declaran trigger. Se compara por SUFIJO y no con un
  // `includes()` suelto — la lección de las listas de juegos: buscar subcadenas hace que un
  // nombre corto case dentro de otro que no tiene nada que ver.
  if (SUFIJOS_ESTADO_TECLADO.some((s) => n.endsWith(s))) return false
  // Grupo (3). Aquí sí es fragmento, pero anclado al separador `::` de la convención de
  // nombres del kernel (`<dispositivo>:<color>:<función>`), que es la frontera real.
  if (FRAGMENTOS_APARATO.some((f) => n.includes(f))) return false
  // Un trigger de red por si el nombre no lo delata (`netdev` es el genérico).
  if (t === "netdev" || t.startsWith("mmc") || t.startsWith("disk-")) return false

  return true
}

/** El trigger activo de un fichero `/sys/class/leds/<x>/trigger`, que lista TODOS los
 *  disponibles y marca el vigente entre corchetes (`none rfkill [kbd-capslock] …`).
 *  Cadena vacía si no hay ninguno marcado. */
export function triggerActivo(contenido: string): string {
  const m = /\[([^\]]*)\]/.exec(contenido)
  return m ? m[1] : ""
}
