// servicios/energia/suspensionFalsa/tlp.ts
//
// El perfil TLP mientras dure la suspensión falsa. El ajuste es un SELECTOR de tres valores
// (`SfTlp`) y no un booleano, y el tercero no es un adorno: **"no-tocar" significa que no se
// impone nada y por tanto no se restaura nada**, que es distinto de imponer "normal". Con el
// booleano de `tlpAuto` no se podía expresar «déjalo como esté», y lo que hubiera puesto el
// usuario o el modo ahorro se habría perdido en cada suspensión falsa.
//
// AGS NO TOCA /etc. Todo pasa por `../tlp.ts`, que delega en el helper root-owned
// `/usr/local/bin/gigios-tlp-apply` autorizado en sudoers SOLO para sus dos argumentos
// fijos. Aquí no se lanza ningún proceso propio: reescribir esa llamada duplicaría la
// gestión de `tlpBusy` y dos `tlp start` a la vez se pisan.
//
// ── LA DISCIPLINA, QUE ES LA DEL BRILLO ───────────────────────────────────────────────
// Al salir se restaura **solo si al salir sigue puesto el perfil que pusimos nosotros**. Si
// el usuario lo cambió a mano desde Ajustes durante la suspensión falsa, manda lo suyo. Y si
// el helper falló al entrar, `tlpMode` nunca llegó a valer lo que le pedimos, así que la
// misma comparación descubre que no se impuso nada y la salida es un no-op — sin necesidad
// de una segunda bandera que pudiera mentir.
//
// ── EL RESIDUO ES FÍSICO, Y POR ESO SE ESPERA AL HELPER ───────────────────────────────
// TLP escribe /etc y sobrevive al proceso: un AGS que muera aquí deja el portátil en
// "ahorro" para siempre (visible solo si el usuario abre Ajustes > Energía). Contra eso no
// hay apunte en disco propio porque no hace falta: el helper anota el modo activo en
// `/etc/gigios/tlp/active`, así que el valor real nunca se pierde — lo que se pierde es la
// INTENCIÓN de volver, y eso lo resuelve el usuario con un clic. Lo que sí hay que evitar es
// perder la restauración por una carrera: `setTlpMode` se traga la llamada si `tlpBusy` está
// puesto (guarda contra dos `tlp start` simultáneos), y una restauración tragada dejaría el
// perfil de ahorro puesto sin un solo error. De ahí `esperarTlpLibre()`.
import { esperar } from "./espera"
import type { EfectorSuspensionFalsa } from "./efectores"
import { tlpAvailable, tlpBusy, tlpMode, setTlpMode, type TlpMode } from "../tlp"
import { sfPerfilTlp } from "../powerState"

/** Techo de la espera al helper. `tlp start` tarda ~1 s aquí; 6 s es holgura, no un plazo
 *  realista. Pasado el techo se intenta igualmente en vez de rendirse en silencio: en el
 *  peor caso `setTlpMode` no hace nada y la comparación de `restaurar()` lo detecta. */
const ESPERA_MAXIMA_MS = 6000
const PASO_MS = 100

/** El perfil que IMPUSIMOS nosotros, y al que hay que volver. `null` = no se impuso nada
 *  (ajuste en "no-tocar", TLP no disponible, o ya estaba puesto el que queríamos). */
let impuesto: TlpMode | null = null
let previo: TlpMode | null = null

async function esperarTlpLibre(): Promise<void> {
  let esperado = 0
  while (tlpBusy.get() && esperado < ESPERA_MAXIMA_MS) {
    await esperar(PASO_MS)
    esperado += PASO_MS
  }
}

export const efectorTlp: EfectorSuspensionFalsa = {
  nombre: "tlp",

  async aplicar() {
    // Sin TLP, sin helper o sin batería real (`tlpAvailable`): no-op limpio. Es el caso del
    // sobremesa, donde la tarjeta ni siquiera se pinta en Ajustes.
    if (!tlpAvailable) return

    const objetivo = sfPerfilTlp.get()
    if (objetivo !== "ahorro" && objetivo !== "normal") return   // "no-tocar"

    const actual = tlpMode.get()
    // Ya está puesto: no se impone NADA, y por eso tampoco se apunta. Restaurar después
    // volvería a lanzar el helper para dejarlo justo donde ya estaba.
    if (actual === objetivo) return

    await esperarTlpLibre()
    previo = actual
    impuesto = objetivo
    // Optimista a propósito: `setTlpMode` solo mueve `tlpMode` si el helper sale bien, así
    // que si falla la comparación de `restaurar()` verá que el perfil vivo no es el nuestro
    // y no tocará nada. La bandera dice «lo intenté», la verdad la tiene `tlpMode`.
    setTlpMode(objetivo)
  },

  async restaurar() {
    if (impuesto === null || previo === null) return

    const esperabaVolverA = previo
    const nuestro = impuesto
    // Se limpia ANTES de esperar: `restaurar()` tiene que ser idempotente y la espera de
    // abajo cede el bucle, así que una segunda llamada (el atajo pulsado dos veces, o el
    // `init` del arranque siguiente) no puede encontrarse el apunte todavía puesto.
    impuesto = null
    previo = null

    await esperarTlpLibre()
    // El usuario lo cambió a mano durante la suspensión falsa, o el helper nunca llegó a
    // aplicar lo nuestro: en los dos casos no hay nada que deshacer. Manda lo que hay.
    if (tlpMode.get() !== nuestro) return
    setTlpMode(esperabaVolverA)
  },
}
