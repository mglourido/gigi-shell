// servicios/sistema/reanudacion.ts
//
// Un único punto de escucha para "el equipo acaba de volver de una suspensión".
//
// POR QUÉ HACE FALTA
// ------------------
// Todos los temporizadores del shell son `GLib.timeout_add*`, que cuelgan de
// `g_get_monotonic_time` → CLOCK_MONOTONIC, y **ese reloj se congela durante la
// suspensión** (medido en esta máquina: 127,8 s de desfase contra CLOCK_BOOTTIME
// tras cinco suspensiones). No es que se pierdan ticks: el temporizador reanuda
// con el resto que le quedaba, así que al despertar mide tiempo DESPIERTO y no
// tiempo de pared. Para un sondeo periódico eso suele ser lo que quieres; para
// cualquier cosa atada a la hora del reloj (el tic del minuto, una alarma) es un
// desfase que no se corrige solo.
//
// logind emite `PrepareForSleep` en el bus de SISTEMA: `true` al irse a dormir y
// `false` al volver, que es el que interesa. Es una difusión sin privilegios —
// hypridle, que corre como usuario, vive de esta misma señal.
//
// UNA SOLA SUSCRIPCIÓN PARA TODOS
// -------------------------------
// La suscripción se hace **perezosa, en el primer `alReanudar`**, y se comparte:
// varios servicios interesados no abren varias conexiones al bus. Antes esto
// vivía suelto dentro de `servicios/fondos/planificador.ts` (que fue el primero
// en necesitarlo, por las franjas horarias de fondos: suspendes de día y
// despiertas de noche); ahora aquel usa este servicio y el código del bus está
// en un solo sitio.
//
// FALLO BLANDO A PROPÓSITO
// ------------------------
// Sin logind, o si el bus no está, no hay señal y no se levanta ninguna
// excepción: se degrada a "cada servicio se corregirá en su siguiente ciclo",
// que es exactamente el comportamiento que había antes de existir este fichero.
// Y una escucha que lance NO puede llevarse por delante a las demás: se avisa y
// se sigue con la siguiente.

import Gio from "gi://Gio"

const ETIQUETA = "reanudacion"

type Escucha = () => void

const escuchas: Escucha[] = []
let suscrito = false

function avisar() {
  // Una línea por reanudación, no por escucha. Sin ella este camino es INVISIBLE: si la señal
  // dejara de llegar (logind cambiado, permisos del bus, la suscripción perdida en un refactor)
  // el síntoma sería un reloj que se desfasa despacio y una alarma que un día no suena — nada
  // que puedas mirar. Con la traza, `ags.log` dice si el despertar se procesó y a cuántos.
  console.info(`[${ETIQUETA}] reanudado tras suspensión: ${escuchas.length} escucha(s)`)
  for (const escucha of escuchas) {
    try {
      escucha()
    } catch (e) {
      console.warn(`[${ETIQUETA}] una escucha de reanudación falló:`, e)
    }
  }
}

function suscribir() {
  try {
    const bus = Gio.bus_get_sync(Gio.BusType.SYSTEM, null)
    bus.signal_subscribe(
      "org.freedesktop.login1",
      "org.freedesktop.login1.Manager",
      "PrepareForSleep",
      "/org/freedesktop/login1",
      null,
      Gio.DBusSignalFlags.NONE,
      (_c, _s, _p, _i, _sig, params) => {
        // `true` = nos vamos a dormir; `false` = ya hemos vuelto, que es cuando el
        // reloj monotónico se ha quedado atrás y hay que recalcular.
        const [durmiendo] = params.deep_unpack() as [boolean]
        if (!durmiendo) avisar()
      },
    )
  } catch (_) {
    // Sin logind no hay señal de resume; ver "fallo blando" en la cabecera.
  }
}

/**
 * Registra `escucha` para que corra **al volver de una suspensión**, no al entrar.
 *
 * Se llama ya con la sesión despierta, así que dentro se puede leer el reloj de
 * pared (`Date.now()`, `GLib.DateTime.new_now_local()`) y rearmar temporizadores
 * contra él. No se desregistra: los consumidores son servicios de sesión que
 * viven lo que vive el shell.
 */
export function alReanudar(escucha: Escucha): void {
  escuchas.push(escucha)
  if (!suscrito) {
    suscrito = true
    suscribir()
  }
}
