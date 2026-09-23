// servicios/fondos/planificador.ts
//
// El reloj que hace que las franjas horarias de fondos SIRVAN de algo: duerme
// hasta el próximo límite que de verdad le afecta al fondo que hay puesto y
// entonces pide `wallpaper.sh --auto`.
//
// NO DECIDE NADA. Ni qué fondo toca (eso es `hypr/scripts/lib/seleccion_fondos.py`,
// el único dueño de esa decisión porque también la toma el arranque de la sesión,
// en bash y antes de que AGS exista) ni cuándo es el próximo límite (se lo
// pregunta al mismo script con `next-change`). Aquí solo vive el temporizador,
// que es lo único que bash no puede tener sin convertirse en un daemon más.
//
// UN SOLO TEMPORIZADOR, ARMADO EXACTO, Y NADA DE SONDEO
// ----------------------------------------------------
// No hay tick periódico: se duerme el tiempo exacto que falta y punto. Entre dos
// cambios de franja el coste es literalmente cero — ni un despertar, ni un fork.
// Y el "tiempo que falta" es el del próximo límite RELEVANTE, no el de cualquier
// franja definida: con un grupo puesto mandan solo los tramos de ESE grupo (sus
// variantes no miran las franjas globales), y con un fondo suelto, solo las
// franjas globales. Los tramos de los demás grupos no pueden cambiar nada de lo
// que hay en pantalla, así que despertar por ellos sería trabajo tirado.
//
// El temporizador se REARMA (no se acumula) ante las tres cosas que cambian esa
// cuenta atrás: al vencer, al editarse la config de franjas/grupos, y al cambiar
// el fondo puesto — esto último es nuevo y obligatorio desde que el cálculo
// depende del estado: aplicar un grupo desde Orion cambia por completo cuáles son
// los límites que importan, y sin releerlo el planificador seguiría dormido hasta
// un límite que ya no viene al caso.
//
// ⚠️ LA SUSPENSIÓN SE RESUELVE CON UNA SEÑAL, NO TROCEANDO EL TEMPORIZADOR.
// `GLib.timeout_add` cuenta sobre el reloj MONOTÓNICO, que no avanza mientras el
// equipo está suspendido: una espera de ocho horas armada de una tacada sonaría
// ocho horas de ACTIVIDAD después, y el caso real es justo ese (suspendes de día
// y despiertas de noche con un fondo claro, que es lo que esta función existe
// para evitar). La primera versión lo cubría troceando a 15 min, o sea
// despertando 96 veces al día para no hacer nada casi ninguna. Se cubre igual —y
// además con precisión de segundos en vez de un cuarto de hora de desfase—
// escuchando `PrepareForSleep` de logind: al volver se reevalúa contra el reloj de
// pared y se rearma. Cuesta una suscripción D-Bus y ningún despertar.
//
// FAIL-OPEN hacia "las franjas no cambian el fondo": si el script falla o no
// existe, no se arma nada y no pasa nada más. Lo contrario —insistir, o sortear a
// ciegas— cambiaría el fondo a destiempo y sin motivo visible.

import GLib from "gi://GLib"
import Gio from "gi://Gio"
import { execAsync } from "ags/process"
import { alReanudar } from "../sistema/reanudacion.ts"

const SCRIPTS      = `${GLib.get_user_config_dir()}/hypr/scripts`
const WALLPAPER_SH = `${SCRIPTS}/wallpaper.sh`
const SELECT_PY    = `${SCRIPTS}/wallpaper-select.py`
const CONFIG_PATH  = `${GLib.get_user_config_dir()}/gigios/wallpapers.json`
const ESTADO_PATH  = `${GLib.get_user_config_dir()}/gigios/wallpaper.json`

/** Colchón para no despertar en el filo del límite y leer todavía la franja vieja. */
const MARGEN_S = 2

let temporizador = 0
let arrancado = false
const monitores: Gio.FileMonitor[] = []
const rebotes = new Map<string, number>()

function cancelar() {
  if (temporizador !== 0) {
    GLib.source_remove(temporizador)
    temporizador = 0
  }
}

/**
 * Segundos hasta el próximo límite que afecta al fondo actual, según el motor.
 * `null` = no hay ninguno (no hay franjas, o las que hay no le incumben), y
 * entonces no se arma nada: solo un cambio de config o de fondo puede volver a
 * darle trabajo a esto.
 */
async function segundosHastaElProximoLimite(): Promise<number | null> {
  try {
    const salida = await execAsync(["python3", SELECT_PY, "next-change"])
    const s = Number(String(salida).trim())
    return Number.isFinite(s) && s > 0 ? s : null
  } catch (_) {
    // Sin límites el script sale con 1: no es un error, es "no hay nada que
    // programar". Se trata igual.
    return null
  }
}

async function rearmar() {
  cancelar()
  const restante = await segundosHastaElProximoLimite()
  if (restante === null) return
  temporizador = GLib.timeout_add_seconds(
    GLib.PRIORITY_DEFAULT_IDLE, restante + MARGEN_S, () => {
      temporizador = 0
      void ciclo()
      return GLib.SOURCE_REMOVE
    })
}

async function ciclo() {
  // `--auto` es idempotente y no imprime —ni aplica— nada si el fondo que toca ya
  // es el que está puesto, así que reevaluar de más (al volver de una suspensión,
  // al editar la config) no produce ni un parpadeo.
  try { await execAsync([WALLPAPER_SH, "--auto"]) } catch (_) { /* fail-open */ }
  await rearmar()
}

/** Un fichero que, al cambiar, invalida la cuenta atrás en curso. */
function vigilar(path: string, alCambiar: () => void) {
  try {
    const monitor = Gio.File.new_for_path(path).monitor_file(Gio.FileMonitorFlags.NONE, null)
    monitor.connect("changed", () => {
      const previo = rebotes.get(path)
      if (previo) GLib.source_remove(previo)
      rebotes.set(path, GLib.timeout_add(GLib.PRIORITY_DEFAULT_IDLE, 500, () => {
        rebotes.delete(path)
        alCambiar()
        return GLib.SOURCE_REMOVE
      }))
    })
    // Sin retener la referencia, el GC se lleva el monitor y deja de avisar.
    monitores.push(monitor)
  } catch (_) { /* el fichero aún no existe: se recalculará en el próximo ciclo */ }
}

/**
 * Rearma al volver de una suspensión. Es lo que sustituye al troceo del
 * temporizador — ver el aviso de la cabecera.
 *
 * La suscripción a `PrepareForSleep` nació aquí y hoy vive en
 * `servicios/sistema/reanudacion.ts`, compartida con el tic del reloj y el
 * planificador de alarmas: los tres necesitan lo mismo (recalcular contra el reloj
 * de pared en cuanto CLOCK_MONOTONIC se ha quedado atrás) y una sola suscripción
 * al bus de sistema los sirve a todos. El fallo blando —sin logind, no hay señal y
 * el fondo se corrige en el siguiente límite— sigue siendo el de siempre, ahora
 * dentro del servicio.
 */
function vigilarSuspension() {
  alReanudar(() => void ciclo())
}

/**
 * Arranca el planificador. Idempotente.
 *
 * Va con el resto de `init*` de fondo (el `setTimeout` de 4 s de `app.ts`): no se
 * ve, y no siembra de eventos —lee la hora del reloj de pared, que no depende de
 * cuándo se le pregunte—. El fondo del arranque ya lo puso `wallpaper.sh` desde
 * `gigios/autostart.lua`, así que estos segundos no dejan la pantalla sin nada.
 */
export function initPlanificadorFondos() {
  if (arrancado) return
  arrancado = true

  void ciclo()

  // Editar franjas o tramos cambia cuándo es el próximo límite; cambiar el fondo
  // puesto cambia CUÁLES son los límites que cuentan. En los dos casos basta con
  // rearmar: no hay que reevaluar, porque el fondo que hay es el que se acaba de
  // decidir (o el que el usuario acaba de elegir a mano).
  vigilar(CONFIG_PATH, () => void rearmar())
  vigilar(ESTADO_PATH, () => void rearmar())
  vigilarSuspension()
}
