// servicios/energia/suspensionFalsa.ts
//
// "Suspensión falsa": apagar todo lo que se puede apagar SIN detener el kernel. La red
// sigue viva, los procesos siguen corriendo y el reloj no da un salto — pero la pantalla
// está negra, el escritorio quieto y la batería no se evapora. Es el punto medio para
// dejar el equipo desatendido sin matar una descarga, una compilación o un backup a medias.
//
// **El porqué largo, con las trampas medidas, está en docs/suspension-falsa.md. Léelo
// antes de tocar este fichero.** Aquí solo va lo que hay que tener delante:
//
// ── ESTE MÓDULO ES UN ORQUESTADOR, NO UN SUBSISTEMA ───────────────────────────────────
// Casi todo lo que hace falta ya estaba escrito: `idle-action.sh` apaga la pantalla con la
// forma correcta del dispatcher, `powerState.ts` tiene los flags que callan cava, la
// mascota, la preview y el sondeo de fondo, `brilloAhorro.ts` sabe bajar el brillo dejando
// apunte en disco. Lo nuevo es el ORDEN y el estado. Si algo parece que falta, buscarlo
// antes de escribirlo.
//
// ── EL ESTADO VIVE EN RAM, Y ESO ES EL DISEÑO ─────────────────────────────────────────
// La tentación evidente es encender `forcePowerSave` y dejar que el modo ahorro haga el
// resto. NO: ese ajuste está PERSISTIDO, así que un AGS que muera aquí dejaría al usuario
// en ahorro forzado permanente —brillo bajo, paneles opacos— sin ninguna pista de por qué.
// Con el estado en RAM, un crash devuelve el escritorio a su sitio, que es el modo de fallo
// que se quiere. Las dos excepciones son las que dejan residuo FÍSICO (el brillo, que por
// DDC se graba en la firmware del monitor, y el perfil TLP, que escribe /etc): esas ya
// tienen apunte en disco y restauración diferida en su propio módulo.
//
// ── EL FICHERO DE ESTADO ES PARA BASH, Y LLEVA GUARDA DE PID ──────────────────────────
// `~/.config/gigios/suspension-falsa.json`, mismo contrato que `wakeup.json`, porque el
// consumidor es el mismo: `blocked()` de `hypr/scripts/idle-action.sh`, que sin esto
// suspendería de verdad a los 20 min con las descargas que se quería proteger. El `pid` no
// es información, es la mitad de una guarda: sin él un AGS caído dejaría la suspensión real
// vetada PARA SIEMPRE, en silencio y sin UI donde apagarlo. La otra mitad es la reescritura
// del fichero al arrancar (`initSuspensionFalsa`), porque los pid se reciclan.
//
// ── EL ORDEN DE LA SECUENCIA IMPORTA ──────────────────────────────────────────────────
// Apagar la pantalla es lo PRIMERO, no lo último: con DPMS off el compositor deja de emitir
// frame callbacks y todo cliente Wayland bien educado deja de pintar solo. Es el ahorro más
// grande y es gratis; todo lo que venga después ya corre con el sistema medio dormido.
// (Ocultar las ventanas de AGS sigue mereciendo la pena, pero por otra cosa: son timers y
// wakeups de CPU, no GPU. Ojo con la trampa que costó lo suyo: DESMAPEAR LA VENTANA NO PARA
// LOS TIMERS — cuelgan del proceso, no de la superficie. Quien los suelta es `refrescar` de
// `estado/visibilidadBarra.ts`, y por eso `Barra.tsx` mira la suspensión falsa en la primera
// rama de `checkVisibility()`. Ver «El lever más grande» en el documento.)

import GLib from "gi://GLib"
import Gio from "gi://Gio"
import { createState } from "ags"
import { execAsync } from "ags/process"
import { fijarMotivoSuspensionFalsa, sfBloquear, sfMinutosSuspensionReal, sfSustituirReal } from "./powerState"
import { mantenerDespiertoActivo } from "./mantenerDespierto"
import { reiniciarHypridle } from "../pantalla/reinicioHypridle"
import { EFECTORES } from "./suspensionFalsa/efectores"
import { closeAllPanels } from "../../estado/shell"

const RUTA_ESTADO = `${GLib.get_user_config_dir()}/gigios/suspension-falsa.json`
const IDLE_ACTION = `${GLib.get_home_dir()}/.config/hypr/scripts/idle-action.sh`
const instanteActual = () => Math.floor(Date.now() / 1000)

/** ¿Hay una suspensión falsa puesta? Lo consume la UI y, por OR, las suspensiones del
 *  shell de `powerState.ts` (vía `fijarMotivoSuspensionFalsa`). */
export const [suspensionFalsaActiva, _setActiva] = createState(false)

/** Segundos que faltan para la suspensión REAL, o `null` si no hay plazo — porque el
 *  ajuste está a 0, porque no hay suspensión falsa, o porque un Wake up lo tiene
 *  suprimido (ver `plazoSuprimidoPorWakeUp`). */
export const [segundosParaSuspensionReal, _setRestante] = createState<number | null>(null)

/** Por qué el plazo de suspensión real no va a cumplirse, o `null` si sí va a cumplirse.
 *  Son dos motivos distintos y la UI tiene que poder decir CUÁL:
 *   · "wake-up"   → temporal: hay un Wake up vivo y al soltarlo el plazo se rearma.
 *   · "sustituto" → permanente mientras el ajuste esté puesto: no hay ninguna suspensión
 *                   real a la que salir, así que el plazo no es que esté en pausa, es que
 *                   no existe. */
export const [motivoPlazoInactivo, _setMotivoPlazo] =
  createState<"wake-up" | "sustituto" | null>(null)

/** El plazo existe pero NO va a saltar porque hay un Wake up vivo. Es un estado propio y no
 *  un `null` a secas para que la UI pueda DECIRLO: un plazo que calladamente no se cumple es
 *  peor que no ofrecerlo. */
export const [plazoSuprimidoPorWakeUp, _setSuprimido] = createState(false)

let arrancado = false
/** Epoch absoluto en el que toca suspender de verdad, o null. Absoluto y no un contador
 *  por lo mismo que en `wakeup.json`: así el lado bash lo resuelve contra el reloj de
 *  pared sin que nadie tenga que venir a reescribir el fichero. */
let instanteSuspension: number | null = null
let temporizador: number | null = null
/** Guarda de reentrada. `entrar()` y `salir()` son asíncronos (los efectores lanzan
 *  procesos) y sus disparadores son un atajo de teclado y un botón: doblar la pulsación
 *  es lo normal, no lo raro. */
let enTransicion = false

function obtenerPidPropio(): number {
  try {
    return new Gio.Credentials().get_unix_pid()
  } catch (error) {
    console.error("[suspension-falsa] no se pudo obtener el pid:", error)
    return 0
  }
}

/** El fichero que lee `blocked()` de idle-action.sh. Se escribe SÍNCRONO y ANTES de tocar
 *  nada: entre marcar el estado y apagar la pantalla no puede haber una ventana en la que
 *  hypridle decida suspender de verdad. */
function escribirEstado(activa: boolean) {
  try {
    const directorio = GLib.path_get_dirname(RUTA_ESTADO)
    if (!GLib.file_test(directorio, GLib.FileTest.EXISTS)) {
      GLib.mkdir_with_parents(directorio, 0o755)
    }
    GLib.file_set_contents(RUTA_ESTADO, JSON.stringify({
      active: activa,
      until: activa ? instanteSuspension : null,
      pid: obtenerPidPropio(),
      // Informativo para quien lea el fichero: el que suspende de verdad al vencer el
      // plazo es ESTE proceso, no bash. Bash solo veta.
      thenSuspend: activa && instanteSuspension !== null,
      // ⚠️ ESTA CLAVE VIAJA AUNQUE `active` SEA FALSE, y es lo que la hace distinta de todas
      // las demás del fichero. «Sustituir la suspensión real por la falsa» tiene que vetar la
      // suspensión de hypridle SIEMPRE, no solo mientras haya una suspensión falsa puesta —
      // si solo valiera estando dentro, la primera inactividad del día suspendería de verdad
      // y en el equipo que tiene este ajuste encendido eso es justo lo que no debe pasar.
      substitute: sfSustituirReal.get(),
    }))
  } catch (error) {
    console.error("[suspension-falsa] no se pudo escribir el estado:", error)
  }
}

// ── El plazo de suspensión real ────────────────────────────────────────────────────────
// Regla, y es la que resuelve el cruce con el Wake up: **con un Wake up vivo el plazo no
// salta**, se entrara en el orden que fuera (Wake up y luego suspensión falsa, o al revés).
// El Wake up promete que el equipo no se suspende; dejar que el temporizador de otra
// función lo suspendiera sería exactamente el fallo que el Wake up existe para impedir.
// Al soltarse el Wake up el plazo se REARMA desde ese instante: suspender de golpe en
// cuanto se suelta sorprende, empezar a contar es lo que el usuario espera.

function detenerTemporizador() {
  if (temporizador === null) return
  try { GLib.source_remove(temporizador) } catch (_) {}
  temporizador = null
}

function replanificarPlazo() {
  detenerTemporizador()
  const minutos = sfMinutosSuspensionReal.get()
  // Con el sustituto puesto el plazo NO se pospone: deja de tener sentido. «Suspensión falsa
  // 40 min y luego suspender de verdad» es una contradicción cuando el usuario ha dicho que
  // en este equipo la suspensión real no se usa —normalmente porque no vuelve—, y cumplirlo
  // sería precisamente dejarle el equipo colgado mientras no está. Gana el sustituto, que es
  // el ajuste más general y el que se activa a sabiendas.
  const sustituto = sfSustituirReal.get()
  const suprimido = !sustituto && mantenerDespiertoActivo.get()
  const hayPlazo = suspensionFalsaActiva.get() && minutos > 0
  _setSuprimido(hayPlazo && suprimido)
  _setMotivoPlazo(!hayPlazo ? null : sustituto ? "sustituto" : suprimido ? "wake-up" : null)

  if (!suspensionFalsaActiva.get() || minutos <= 0 || suprimido || sustituto) {
    instanteSuspension = null
    _setRestante(null)
    if (suspensionFalsaActiva.get()) escribirEstado(true)
    return
  }

  instanteSuspension = instanteActual() + minutos * 60
  _setRestante(minutos * 60)
  escribirEstado(true)
  programarTick()
}

/**
 * El tick de la cuenta atrás, con la cadencia AJUSTADA A LO QUE SE PUEDE LEER.
 *
 * Antes era un `timeout_add_seconds(…, 1, …)` fijo: con un plazo de 40 min eran 2 400
 * despertares del bucle principal —cada uno un wakeup de CPU— para refrescar un número que
 * NADIE PUEDE VER. Durante la suspensión falsa la barra está desmapeada y los paneles
 * cerrados (`closeAllPanels()` en la entrada), así que los tres consumidores de
 * `segundosParaSuspensionReal` —el chip de la barra, `OpcionesSuspensionFalsa` y la tarjeta
 * de Ajustes— no están en pantalla. Es sondeo puro, y en la función cuyo motivo de existir
 * es dejar el equipo quieto.
 *
 * La cadencia sale de la única granularidad que la UI llega a enseñar (`textoRestante`:
 * minutos por encima del minuto, segundos por debajo):
 *
 *   · queda más de `UMBRAL_TICK_FINO_S` → se duerme hasta el siguiente múltiplo de minuto,
 *     que es cuando la cifra CAMBIA. Ni un despertar antes.
 *   · queda menos → un tick por segundo, porque ahí la UI sí cuenta segundos.
 *
 * Un plazo de 40 min pasa de 2 400 despertares a unos 100, sin perder ni una cifra. Y el
 * instante de disparo no depende de la cadencia: cada vuelta se recalcula contra
 * `instanteSuspension`, que es un epoch ABSOLUTO, así que no acumula deriva ni se pasa de
 * largo si el bucle llega tarde.
 */
const UMBRAL_TICK_FINO_S = 90

function programarTick() {
  detenerTemporizador()
  if (instanteSuspension === null) return

  const restante = instanteSuspension - instanteActual()
  if (restante <= 0) {
    _setRestante(0)
    // Con `.catch`: `programarTick` se llama desde un callback de GLib, donde un rechazo sin
    // atender no tiene a nadie encima que lo recoja y se pierde sin traza.
    suspenderDeVerdad().catch((e) => console.error("[suspension-falsa] suspender de verdad:", e))
    return
  }
  _setRestante(restante)

  // El siguiente despertar: el cambio de cifra más próximo, y nunca más allá del plazo.
  // `% 60` alinea con el minuto en curso en vez de contar 60 s desde ahora, que es lo que
  // haría que la cifra saltara a destiempo (mismo criterio que `msHastaSiguienteTick` del
  // reloj de la barra).
  const espera = restante > UMBRAL_TICK_FINO_S
    ? Math.min(restante - UMBRAL_TICK_FINO_S, restante % 60 || 60)
    : 1

  temporizador = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, espera, () => {
    temporizador = null
    // El plazo pudo caerse mientras dormíamos (salida, Wake up, sustituto): `replanificarPlazo`
    // ya limpió `instanteSuspension` y aquí no hay nada que rearmar.
    if (instanteSuspension === null) return GLib.SOURCE_REMOVE
    programarTick()
    return GLib.SOURCE_REMOVE
  })
}

/**
 * Sale de la suspensión falsa y SOLO ENTONCES suspende. El orden no es cosmético:
 * suspender con las apps congeladas deja el freezer puesto al despertar (el freezer es del
 * cgroup, no del proceso que lo pidió: la app se queda "sin responder" sin un solo error en
 * ningún log), y suspender sin quitar el veto es pedirle a `idle-action.sh` que ignore la
 * orden que acabamos de dar.
 */
async function suspenderDeVerdad() {
  // Cinturón y tirantes. `replanificarPlazo()` ya no arma el temporizador con el sustituto
  // puesto, pero el ajuste puede encenderse DESPUÉS de armarlo: entre el `timeout_add` y su
  // vencimiento pasan minutos, y esta función es la única de todo el shell que llama a
  // `systemctl suspend`. Comprobarlo aquí cuesta una línea y cierra la carrera entera.
  if (sfSustituirReal.get()) return
  await salirSuspensionFalsa()
  try {
    await execAsync(["systemctl", "suspend"])
  } catch (error) {
    console.error("[suspension-falsa] systemctl suspend falló:", error)
  }
}

// ── Entrada y salida ───────────────────────────────────────────────────────────────────

export async function entrarSuspensionFalsa(): Promise<void> {
  if (suspensionFalsaActiva.get() || enTransicion) return
  enTransicion = true
  try {
    // 1. Marcar el estado. PRIMERO, para que nadie corra un tick de mantenimiento —ni
    //    hypridle decida suspender— durante los pasos siguientes.
    _setActiva(true)
    replanificarPlazo()          // escribe el fichero (con o sin plazo)
    fijarMotivoSuspensionFalsa(true)

    // 2. Apagar la pantalla. Por `idle-action.sh` y no con un `hyprctl` propio: allí está
    //    la forma de TABLA del dispatcher. `hl.dsp.dpms('off')` con un STRING es un toggle
    //    silencioso —tira el 'off', invierte el estado y responde `ok` con rc 0—, y eso ya
    //    costó una vez la pantalla negra que ni una tecla despertaba.
    ejecutarIdleAction("dpms-off")

    // 3. Bloquear, si procede. Es además la PUERTA DE SALIDA (ver el documento): con la
    //    pantalla apagada por nuestra mano, hypridle no emite ningún `on-resume`, así que
    //    el desbloqueo de hyprlock es lo que dispara la vuelta. Con el bloqueo desactivado
    //    la única salida es el atajo de teclado, que por eso es `locked = true`.
    if (sfBloquear.get()) bloquearYEsperarDesbloqueo()

    // 4-6. Cerrar los paneles abiertos: quedarían montados detrás del bloqueo, con sus
    //      timers corriendo, y al volver el usuario se encontraría el escritorio como lo
    //      dejó salvo por un panel abierto que ya no recuerda haber abierto.
    closeAllPanels()

    // 7-10. Lo físico y lo destructible, cada uno en su efector y aislado de los demás.
    for (const efector of EFECTORES) {
      try {
        await efector.aplicar()
      } catch (error) {
        console.error(`[suspension-falsa] efector "${efector.nombre}" falló al aplicar:`, error)
      }
    }
  } finally {
    enTransicion = false
  }
}

export async function salirSuspensionFalsa(): Promise<void> {
  if (!suspensionFalsaActiva.get() || enTransicion) return
  enTransicion = true
  try {
    // Los efectores AL REVÉS. Lo primero que se deshace es lo último que se hizo: congelar
    // apps. Una app congelada que recibe eventos de entrada antes de descongelarse llega al
    // escritorio con una cola de basura.
    for (const efector of [...EFECTORES].reverse()) {
      try {
        await efector.restaurar()
      } catch (error) {
        console.error(`[suspension-falsa] efector "${efector.nombre}" falló al restaurar:`, error)
      }
    }

    detenerTemporizador()
    instanteSuspension = null
    _setRestante(null)
    _setSuprimido(false)
    _setActiva(false)
    fijarMotivoSuspensionFalsa(false)
    escribirEstado(false)

    // La pantalla se enciende sola (una tecla ya la encendió, o la enciende hyprlock al
    // desbloquear), pero no si la salida vino del atajo con la pantalla todavía negra.
    ejecutarIdleAction("dpms-on")

    // Rearmar hypridle. hypridle NO repite un `on-timeout` ya disparado: sin esto los
    // contadores se quedan vencidos y la pantalla no se volvería a apagar sola en toda la
    // sesión. Es lo mismo que ya hace el Wake up al apagarse.
    reiniciarHypridle().catch(() => {})
  } finally {
    enTransicion = false
  }
}

/** Devuelve el estado en el que queda. Es lo que consumen el atajo, la función de la barra
 *  y `ags request toggle-suspension-falsa`. */
export function alternarSuspensionFalsa(): boolean {
  if (suspensionFalsaActiva.get()) {
    salirSuspensionFalsa().catch((e) => console.error("[suspension-falsa] salida falló:", e))
    return false
  }
  entrarSuspensionFalsa().catch((e) => console.error("[suspension-falsa] entrada falló:", e))
  return true
}

/**
 * Bloquea y —esto es lo importante— SE ENTERA DEL DESBLOQUEO.
 *
 * Es la puerta de salida de toda la función, y el punto de diseño que más fácil se rompe.
 * Con la pantalla apagada POR NUESTRA MANO, hypridle no emite ningún `on-resume`: solo los
 * emite de un timeout que disparó él. Así que colgar la salida de ese evento deja la sesión
 * dentro de la suspensión falsa SIN FORMA DE VOLVER — y con las ventanas de AGS desmapeadas
 * no hay ni UI donde apagarlo. Hyprland tampoco publica un evento de session-lock que se
 * pueda escuchar.
 *
 * Por eso el lanzador de hyprlock se invoca DESDE AQUÍ con `Gio.Subprocess` en vez de por `idle-action.sh`:
 * así hay un hijo al que esperar, y `wait_async` avisa exactamente cuando el usuario
 * desbloquea. Cero sondeo y cero latencia.
 *
 * El caso de que ya hubiera un hyprlock puesto antes de entrar es real (el listener de los
 * 11 min, o el usuario) y no se puede resolver igual: ese proceso no es hijo nuestro. Ahí se
 * cae a un sondeo lento —`hayHyprlock()` cada 5 s, sin lanzar ningún proceso: ver su
 * cabecera—, que junto a una pantalla apagada no cuesta nada y es infinitamente mejor que la
 * alternativa, que es no volver nunca. Y NO se lanza un segundo hyprlock: no tiene guarda de
 * instancia única (0.9.6) y arrancaría un proceso de verdad encima del bloqueo.
 */
function bloquearYEsperarDesbloqueo() {
  if (hayHyprlock()) {
    vigilarDesbloqueoPorSondeo()
    return
  }

  try {
    // bloquear.sh prepara la misma cola de fondos que los demás caminos y hace exec,
    // así que wait_async sigue observando al proceso hyprlock, sin shell intermedia.
    const hyprlock = Gio.Subprocess.new([`${GLib.get_home_dir()}/.config/hypr/scripts/bloquear.sh`], Gio.SubprocessFlags.NONE)
    hyprlock.wait_async(null, (_origen, resultado) => {
      try { hyprlock.wait_finish(resultado) }
      catch (error) { console.error("[suspension-falsa] espera del bloqueo falló:", error) }
      // Si otro camino bloqueó entre hayHyprlock() y la guarda del lanzador,
      // este hijo termina enseguida. Seguimos al bloqueo real antes de salir.
      if (hayHyprlock()) {
        vigilarDesbloqueoPorSondeo()
        return
      }
      // El desbloqueo es la orden de volver. Si la salida ya ocurrió por otra vía (el atajo,
      // el plazo), `salirSuspensionFalsa()` sale sola por su guarda.
      salirSuspensionFalsa().catch((e) => console.error("[suspension-falsa] salida tras desbloqueo:", e))
    })
  } catch (error) {
    // Sin bloqueo no se cancela la entrada: la suspensión falsa sigue siendo útil y el atajo
    // sigue siendo la salida. Pero hay que decirlo, porque el usuario pidió que se bloqueara.
    console.error("[suspension-falsa] no se pudo lanzar hyprlock:", error)
  }
}

/**
 * ¿Hay un hyprlock vivo? Recorriendo /proc, SIN LANZAR NADA — y ese es todo el punto.
 *
 * Antes esto era `GLib.spawn_command_line_sync("pidof hyprlock")`, que tiene dos problemas
 * y el segundo es el caro:
 *
 *  1. Es SÍNCRONO sobre el bucle de GTK. Un fork + exec + enlazado dinámico bloqueando el
 *     hilo que atiende la UI, y encima repetido cada 5 s durante toda la suspensión falsa.
 *  2. `pidof` hace exactamente este mismo recorrido de /proc, solo que después de pagar el
 *     proceso. Hacerlo aquí es estrictamente más barato: mismos datos, cero forks.
 *
 * De regalo se va la dependencia de que `pidof` esté instalado, que antes decidía en
 * silencio si el camino del sondeo llegaba a existir — y sin él la rama daba «no bloqueado»
 * y se lanzaba un SEGUNDO hyprlock encima del que ya estaba (no tiene guarda de instancia
 * única, ver la cabecera de arriba).
 *
 * Solo `comm`: es el nombre del ejecutable tal cual, no la línea de órdenes, así que no lo
 * confunde un `grep hyprlock` ni un editor con el fichero abierto. Y nunca lanza: un PID que
 * muere entre listar el directorio y leerlo es lo normal, no un error.
 */
function hayHyprlock(): boolean {
  try {
    const dir = Gio.File.new_for_path("/proc")
      .enumerate_children("standard::name", Gio.FileQueryInfoFlags.NONE, null)
    try {
      for (let info = dir.next_file(null); info !== null; info = dir.next_file(null)) {
        const nombre = info.get_name()
        // Solo los procesos. /proc lleva además una veintena de entradas de texto
        // (`meminfo`, `stat`…) que no hay ni que abrir.
        if (!/^\d+$/.test(nombre)) continue
        try {
          const [ok, bytes] = GLib.file_get_contents(`/proc/${nombre}/comm`)
          if (ok && new TextDecoder().decode(bytes).trim() === "hyprlock") return true
        } catch (_) {
          // El proceso murió entre el listado y la lectura: no es un caso de error.
        }
      }
    } finally {
      dir.close(null)
    }
  } catch (error) {
    // Sin /proc legible no se puede saber. Se responde «no hay» porque es lo que deja
    // funcionar al camino normal (lanzar hyprlock y esperar al hijo, que no sondea nada);
    // el sondeo es el plan B y perderlo no encierra a nadie.
    console.error("[suspension-falsa] no se pudo mirar /proc:", error)
  }
  return false
}

/** Plan B del de arriba: mirar si hyprlock sigue vivo cada 5 s mientras dure. Se para solo
 *  en cuanto la suspensión falsa termina, venga la salida de donde venga.
 *
 *  Los 5 s se conservan a propósito y NO se estiran para ahorrar: son la latencia con la que
 *  el escritorio vuelve cuando la salida cae por este camino, y el ahorro ya se lo llevó
 *  quitar el fork (ver `hayHyprlock`). Alargar la espera se pagaría en el único sitio donde
 *  hay una persona mirando una pantalla encendida a ver si pasa algo. */
function vigilarDesbloqueoPorSondeo() {
  GLib.timeout_add_seconds(GLib.PRIORITY_LOW, 5, () => {
    if (!suspensionFalsaActiva.get()) return GLib.SOURCE_REMOVE
    if (hayHyprlock()) return GLib.SOURCE_CONTINUE
    salirSuspensionFalsa().catch((e) => console.error("[suspension-falsa] salida tras desbloqueo:", e))
    return GLib.SOURCE_REMOVE
  })
}

/** Un `idle-action.sh <acción>` y a otra cosa. No se espera al resultado: la entrada la
 *  dispara una persona que ya se está levantando de la silla, y el script es fail-open por
 *  diseño (no devuelve nada útil que mirar). */
function ejecutarIdleAction(accion: string) {
  execAsync([IDLE_ACTION, accion]).catch((error) => {
    console.error(`[suspension-falsa] idle-action.sh ${accion} falló:`, error)
  })
}

/**
 * Arranca el módulo. Va a t=0 en `app.ts`, junto a `inicializarMantenerDespierto()` e
 * `initGamemode()` y NO con los `init*` apartados a los 4 s, por el mismo motivo que
 * aquellos: su primer trabajo es LIMPIAR ESTADO HEREDADO PELIGROSO. Un
 * `suspension-falsa.json` de un AGS muerto tiene un pid que el kernel puede haber reciclado
 * —y si el nuevo dueño de ese pid está vivo, la guarda de `blocked()` da el veto por bueno y
 * el equipo no se suspende nunca más, en silencio—. Cuatro segundos de ventana para eso no
 * se justifican con nada.
 */
export function initSuspensionFalsa(): void {
  if (arrancado) return
  arrancado = true

  // Estado limpio en cada arranque: la suspensión falsa es POR SESIÓN. No se hereda.
  instanteSuspension = null
  _setActiva(false)
  _setRestante(null)
  _setSuprimido(false)
  escribirEstado(false)

  // La otra mitad de la limpieza: deshacer lo que dejara puesto un AGS muerto. Cada efector
  // sabe si tiene algo que restaurar (contrato de `efectores.ts`), así que llamarlos aquí es
  // barato y es la única red que hay para las apps que se quedaron congeladas — el freezer
  // no se suelta al morir quien lo pidió.
  for (const efector of [...EFECTORES].reverse()) {
    try {
      const r = efector.restaurar()
      if (r instanceof Promise) r.catch((e) => console.error(`[suspension-falsa] ${efector.nombre}:`, e))
    } catch (error) {
      console.error(`[suspension-falsa] efector "${efector.nombre}" falló en el arranque:`, error)
    }
  }

  // Encender/apagar el Wake up mientras hay una suspensión falsa puesta suprime o rearma el
  // plazo (ver el bloque del plazo, arriba). Cambiar los minutos en Ajustes con la función
  // ya activa también reprograma: es lo mismo que hace el Wake up con su campo de minutos.
  mantenerDespiertoActivo.subscribe(() => { if (suspensionFalsaActiva.get()) replanificarPlazo() })
  sfMinutosSuspensionReal.subscribe(() => { if (suspensionFalsaActiva.get()) replanificarPlazo() })
  // El sustituto hace dos cosas al cambiar, y las dos hacen falta: republica el fichero para
  // que bash empiece (o deje) de vetar la suspensión de hypridle EN EL ACTO —sin esperar a la
  // próxima entrada en suspensión falsa, que podría no llegar en horas— y recalcula el plazo,
  // que al encenderlo deja de existir y al apagarlo vuelve.
  sfSustituirReal.subscribe(() => {
    escribirEstado(suspensionFalsaActiva.get())
    replanificarPlazo()
  })
}
