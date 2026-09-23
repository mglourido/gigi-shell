// Mantiene el equipo despierto durante el plazo solicitado. El JSON usa el
// contrato que consume hypr/scripts/idle-action.sh y no es persistencia de UI.

import GLib from "gi://GLib"
import Gio from "gi://Gio"
import { createState } from "ags"
import { reiniciarHypridle } from "../pantalla/reinicioHypridle"
import { interpretarMinutos, normalizarTextoMinutos } from "./tiempoMantenerDespierto"

const RUTA_ESTADO = `${GLib.get_user_config_dir()}/gigios/wakeup.json`
/** AJUSTES del Wake up, que NO es lo mismo que su estado. `wakeup.json` es estado vivo con
 *  guarda de pid y se reescribe a `active:false` en cada arranque (`inicializarMantenerDespierto`),
 *  así que guardar ahí una preferencia sería guardarla en un fichero que se borra solo.
 *  Y tampoco puede ir en `preferences.json` ni en `power-save/config.json`: los dos se
 *  reescriben ENTEROS por su propio escritor único, y un segundo escritor sobre el mismo
 *  JSON se pisa (es la misma razón por la que la suspensión falsa tiene fichero propio en
 *  vez de colarse en `runtime-state.json`). De ahí este tercer fichero, minúsculo y con un
 *  solo escritor: este módulo. */
const RUTA_OPCIONES = `${GLib.get_user_config_dir()}/gigios/wakeup-opciones.json`
const instanteActual = () => Math.floor(Date.now() / 1000)

export const [mantenerDespiertoActivo, establecerMantenerDespiertoActivo] = createState(false)
export const [mantenerPantallaActiva, establecerMantenerPantallaActiva] = createState(false)
export const [minutosMantenerDespierto, establecerMinutosMantenerDespierto] = createState("")
/** Segundos restantes, o null cuando no existe límite. */
export const [tiempoRestanteMantenerDespierto, establecerTiempoRestanteMantenerDespierto] =
  createState<number | null>(null)

/**
 * «Al vencer la inactividad, entrar en suspensión falsa».
 *
 * Hoy el Wake up solo VETA: cuando hypridle quiere suspender, `idle-action.sh` se traga la
 * acción y no pasa nada — el equipo se queda encendido, con la pantalla apagada por el
 * listener de DPMS y nada más. Con esta opción, ese mismo momento se aprovecha para ENTRAR
 * en suspensión falsa: el escritorio queda apagado de cara al usuario y el Wake up sigue
 * cumpliendo su promesa, porque la suspensión falsa no detiene el kernel y la descarga, la
 * compilación o la sesión SSH siguen vivas.
 *
 * Quien decide es AGS, no bash: el script sigue vetando el `systemctl suspend` exactamente
 * igual y no aprende ninguna regla nueva (ver el puente en `wakeUpSuspensionFalsa.ts`).
 *
 * Es un AJUSTE, no estado de sesión, y por eso se persiste: el Wake up se apaga en cada
 * arranque a propósito, pero «cómo quiero que se comporte cuando lo encienda» no debería
 * haber que recordárselo cada vez.
 */
export const [suspensionFalsaAlVencer, establecerSuspensionFalsaAlVencer] =
  createState(leerOpcionSuspensionFalsaAlVencer())

let instanteLimite: number | null = null
let temporizador: number | null = null

/** Lectura tolerante del ajuste: cualquier problema degrada a `false`, que es el
 *  comportamiento de siempre (vetar y nada más). Un fichero corrupto no puede acabar
 *  metiendo al usuario en una suspensión falsa que no pidió. */
function leerOpcionSuspensionFalsaAlVencer(): boolean {
  try {
    const [ok, contenido] = GLib.file_get_contents(RUTA_OPCIONES)
    if (!ok) return false
    const datos = JSON.parse(new TextDecoder().decode(contenido))
    return datos?.suspensionFalsaAlVencer === true
  } catch (_) {
    return false
  }
}

function guardarOpciones() {
  try {
    const directorio = GLib.path_get_dirname(RUTA_OPCIONES)
    if (!GLib.file_test(directorio, GLib.FileTest.EXISTS)) {
      GLib.mkdir_with_parents(directorio, 0o755)
    }
    GLib.file_set_contents(RUTA_OPCIONES, JSON.stringify({
      suspensionFalsaAlVencer: suspensionFalsaAlVencer.get(),
    }))
  } catch (error) {
    console.error("[mantener-despierto] no se pudieron guardar las opciones:", error)
  }
}

function obtenerPidPropio(): number {
  try {
    return new Gio.Credentials().get_unix_pid()
  } catch (error) {
    console.error("[mantener-despierto] no se pudo obtener el pid:", error)
    return 0
  }
}

function escribirEstado(activo: boolean) {
  try {
    const directorio = GLib.path_get_dirname(RUTA_ESTADO)
    if (!GLib.file_test(directorio, GLib.FileTest.EXISTS)) {
      GLib.mkdir_with_parents(directorio, 0o755)
    }
    GLib.file_set_contents(RUTA_ESTADO, JSON.stringify({
      active: activo,
      until: activo ? instanteLimite : null,
      screen: mantenerPantallaActiva.get(),
      pid: obtenerPidPropio(),
    }))
  } catch (error) {
    console.error("[mantener-despierto] no se pudo escribir el estado:", error)
  }
}

/**
 * Avisa de que el plazo se ha agotado. Solo se emite en la CADUCIDAD, nunca cuando el usuario
 * apaga la función a mano: ahí ya sabe lo que ha hecho y el aviso sobra. Va con identidad
 * (`x-gigios-event`) para que sea configurable desde Ajustes > Notificaciones > Sistema.
 */
function notificarFin() {
  try {
    Gio.Subprocess.new(
      ["notify-send", "-a", "Wake up", "-h", "string:x-gigios-source:system",
       "-h", "string:x-gigios-event:energia.wake-up-fin",
       "Wake up", "Se acabó el plazo: el equipo vuelve a suspenderse con normalidad."],
      Gio.SubprocessFlags.NONE,
    )
  } catch (error) {
    console.error("[mantener-despierto] no se pudo notificar el fin:", error)
  }
}

function detenerTemporizador() {
  if (temporizador === null) return
  try { GLib.source_remove(temporizador) } catch (_) {}
  temporizador = null
}

function iniciarTemporizador() {
  detenerTemporizador()
  if (instanteLimite === null) return
  temporizador = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
    const restante = instanteLimite === null ? null : instanteLimite - instanteActual()
    if (restante === null) {
      temporizador = null
      return GLib.SOURCE_REMOVE
    }
    if (restante <= 0) {
      temporizador = null
      fijarMantenerDespiertoActivo(false)
      notificarFin()
      return GLib.SOURCE_REMOVE
    }
    establecerTiempoRestanteMantenerDespierto(restante)
    return GLib.SOURCE_CONTINUE
  })
}

function programarCaducidad() {
  const minutos = interpretarMinutos(minutosMantenerDespierto.get())
  instanteLimite = minutos === null ? null : instanteActual() + minutos * 60
  establecerTiempoRestanteMantenerDespierto(
    instanteLimite === null ? null : instanteLimite - instanteActual(),
  )
  escribirEstado(true)
  iniciarTemporizador()
}

export function fijarMantenerDespiertoActivo(activo: boolean) {
  if (activo) {
    establecerMantenerDespiertoActivo(true)
    programarCaducidad()
    return
  }
  if (!mantenerDespiertoActivo.get()) return
  establecerMantenerDespiertoActivo(false)
  instanteLimite = null
  establecerTiempoRestanteMantenerDespierto(null)
  detenerTemporizador()
  escribirEstado(false)
  reiniciarHypridle().catch(() => {})
}

/** Cambiar los minutos en activo reprograma la cuenta atrás inmediatamente. */
export function fijarMinutosMantenerDespierto(texto: string) {
  establecerMinutosMantenerDespierto(normalizarTextoMinutos(texto))
  if (mantenerDespiertoActivo.get()) programarCaducidad()
}

/** Publica en caliente si también debe mantenerse encendida la pantalla. */
export function fijarMantenerPantallaActiva(activa: boolean) {
  establecerMantenerPantallaActiva(activa)
  if (mantenerDespiertoActivo.get()) escribirEstado(true)
}

/** Cambia y persiste «al vencer la inactividad, entrar en suspensión falsa». No hace falta
 *  reescribir `wakeup.json`: el lado bash no conoce esta opción ni tiene por qué —lo único
 *  que hace es vetar, como siempre— y quien la consume es el puente de AGS. */
export function fijarSuspensionFalsaAlVencer(activa: boolean) {
  establecerSuspensionFalsaAlVencer(activa)
  guardarOpciones()
}

/** Limpia al iniciar cualquier veto heredado de otra sesión de AGS. */
export function inicializarMantenerDespierto(): void {
  escribirEstado(false)
}
