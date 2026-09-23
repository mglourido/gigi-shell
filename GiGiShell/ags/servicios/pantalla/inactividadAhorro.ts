// servicios/pantalla/inactividadAhorro.ts
//
// Tiempos de inactividad PROPIOS del modo ahorro: apagar pantalla, bloquear y suspender.
// Hasta ahora los tres eran generales (Ajustes > Energía > "Suspensión e inactividad"), así
// que con la batería al 10 % la pantalla seguía encendida los mismos 10 minutos de siempre
// — más consumo, con diferencia, que todo el sondeo de fondo que congela `freezeBackground`.
//
// ─────────────────────────────────────────────────────────────────────────────────────
// ⚠️ ESTO ESCRIBE EN UN FICHERO DEL USUARIO, Y DE AHÍ TODO EL DISEÑO
// ------------------------------------------------------------------
// hypridle no tiene "perfiles": lee `hypridle.conf` y punto, así que un tiempo distinto
// durante el ahorro obliga a reescribir ESE fichero. El riesgo obvio —AGS muere en ahorro y
// los tiempos cortos se quedan puestos para siempre, sin UI donde notarlo— se cubre con la
// misma forma que `wakeup.json` y el apunte del brillo: los valores generales se apartan a
// `~/.config/gigios/inactividad-normal.json` ANTES de pisarlos, y ese fichero es a la vez
// el apunte y la señal de "hay un override puesto". Si existe al arrancar y el ahorro no
// está activo, se restaura y se borra. Un override huérfano dura, como mucho, hasta el
// siguiente arranque del shell.
//
// Consecuencia obligatoria: mientras el override está puesto, el fichero de hypridle NO
// contiene los valores generales, así que la tarjeta de Ajustes no puede escribir ahí sin
// que la restauración los borre al salir del ahorro. Por eso `guardarInactividadGeneral()`
// es el ÚNICO camino de guardado de esa tarjeta y desvía la escritura al apunte cuando toca.
// Editar los tiempos generales durante el ahorro funciona, simplemente no se ven hasta
// salir de él.
//
// `bloqueoAlSuspender` NO se aparta: no es un tiempo, el ahorro no lo toca y siempre va
// directo al fichero de hypridle.
import GLib from "gi://GLib"
import { parseHypridle, writeHypridle, writeBloqueoAlSuspender, type HypridleConfig, type ListenerKind } from "./hypridle"
import { reiniciarHypridle } from "./reinicioHypridle"
import { aplicarHibernacion, leerHibernacion, type AjusteHibernacion } from "../energia/hibernacion"
import {
  powerSaveActive,
  idleOverrideInPowerSave,
  idleDpmsAhorro,
  idleLockAhorro,
  idleSuspendAhorro,
  type TiempoAhorro,
} from "../energia/powerState"

const ARCHIVO_HYPRIDLE = `${GLib.get_user_config_dir()}/hypr/hypridle.conf`
const ARCHIVO_APUNTE = `${GLib.get_user_config_dir()}/gigios/inactividad-normal.json`

export type ValoresListener = Partial<Record<ListenerKind, { timeout: number; enabled: boolean }>>

let arrancado = false

// ── Apunte de los valores generales ──────────────────────────────────────────

function leerApunte(): ValoresListener | null {
  try {
    const [ok, contenido] = GLib.file_get_contents(ARCHIVO_APUNTE)
    if (!ok) return null
    const datos = JSON.parse(new TextDecoder().decode(contenido))
    const salida: ValoresListener = {}
    for (const clave of ["dpms", "lock", "suspend"] as ListenerKind[]) {
      const v = datos?.[clave]
      if (v && typeof v.timeout === "number" && typeof v.enabled === "boolean") {
        salida[clave] = { timeout: v.timeout, enabled: v.enabled }
      }
    }
    // Un apunte sin ningún listener utilizable no sirve para restaurar nada: se trata como
    // ausente para que la recuperación no deje el fichero de hypridle a medias.
    return Object.keys(salida).length > 0 ? salida : null
  } catch (_) {
    return null
  }
}

function escribirApunte(valores: ValoresListener | null): void {
  try {
    if (valores === null) {
      GLib.unlink(ARCHIVO_APUNTE)
      return
    }
    const dir = GLib.path_get_dirname(ARCHIVO_APUNTE)
    if (!GLib.file_test(dir, GLib.FileTest.EXISTS)) GLib.mkdir_with_parents(dir, 0o755)
    GLib.file_set_contents(ARCHIVO_APUNTE, JSON.stringify(valores))
  } catch (e) {
    console.error("[inactividad] no se pudo guardar el apunte:", e)
  }
}

/** ¿Hay un override del ahorro puesto ahora mismo? Lo decide el apunte, no la RAM. */
export function overrideInactividadActivo(): boolean {
  return leerApunte() !== null
}

// ── Fichero de hypridle ──────────────────────────────────────────────────────

function leerConfig(): HypridleConfig | null {
  try {
    const [ok, contenido] = GLib.file_get_contents(ARCHIVO_HYPRIDLE)
    if (ok) return parseHypridle(new TextDecoder().decode(contenido))
  } catch (_) { /* el llamador conserva valores seguros si no puede leerse */ }
  return null
}

/** Escribe los tres tiempos (y opcionalmente el bloqueo al suspender) y rearma hypridle. */
function escribirConfig(valores: ValoresListener, bloqueoAlSuspender?: boolean): boolean {
  try {
    const [ok, contenido] = GLib.file_get_contents(ARCHIVO_HYPRIDLE)
    if (!ok) return false
    let texto = writeHypridle(new TextDecoder().decode(contenido), valores)
    if (bloqueoAlSuspender !== undefined) texto = writeBloqueoAlSuspender(texto, bloqueoAlSuspender)
    GLib.file_set_contents(ARCHIVO_HYPRIDLE, texto)
    reiniciarHypridle().catch(() => {})
    return true
  } catch (_) {
    // Un fallo de hypridle no debe cerrar el shell ni dejar el apunte descuadrado.
    return false
  }
}

// ── API para la tarjeta de Ajustes ───────────────────────────────────────────

/**
 * Los tiempos GENERALES tal como debe enseñarlos Ajustes. Con el override puesto, el
 * fichero de hypridle contiene los del ahorro: leerlo a pelo pintaría esos como si fueran
 * los de siempre, y el primer guardado los habría convertido en tales de verdad. El
 * `bloqueoAlSuspender` sale siempre del fichero, que es su única fuente.
 */
export function leerInactividadGeneral(): HypridleConfig | null {
  const config = leerConfig()
  if (!config) return null
  const apunte = leerApunte()
  if (!apunte) return config
  return {
    dpms: apunte.dpms ?? config.dpms,
    lock: apunte.lock ?? config.lock,
    suspend: apunte.suspend ?? config.suspend,
    // `hibernate` NO se aparta nunca: el ahorro no lo toca, y además el número que ve el
    // usuario no vive aquí sino en hibernacion.json (esto es solo su espejo). Ver
    // servicios/energia/hibernacion.ts.
    hibernate: config.hibernate,
    bloqueoAlSuspender: config.bloqueoAlSuspender,
  }
}

/**
 * Único camino de guardado de los tiempos GENERALES (`modulos/ajustes/pantalla/Inactividad.tsx`).
 * Con el override puesto van al apunte en vez de al fichero, para que la restauración del
 * final del ahorro devuelva lo último que pidió el usuario y no lo que había antes de editar.
 */
export function guardarInactividadGeneral(
  valores: ValoresListener,
  bloqueoAlSuspender: boolean,
  hibernacion?: AjusteHibernacion,
): void {
  if (overrideInactividadActivo()) {
    escribirApunte(valores)
    // El bloqueo al suspender no forma parte del override: se aplica en el acto. La hibernación
    // TAMPOCO se aparta, pero su reparto sí depende de la suspensión vigente (la del ahorro),
    // así que `conHibernacion` la recalcula contra el fichero, no contra `valores`.
    escribirConfig(conHibernacion({}, hibernacion), bloqueoAlSuspender)
    return
  }
  escribirConfig(conHibernacion(valores, hibernacion), bloqueoAlSuspender)
}

/**
 * Añade a una escritura de tiempos el listener de hibernación que corresponde a la suspensión
 * que ESA MISMA escritura va a dejar puesta, y de paso empuja el retardo a systemd.
 *
 * Va acoplado a cada escritura, y no suelto, por dos motivos:
 *   • el reparto entre los dos mecanismos (alarma RTC durante el S3 vs. listener de hypridle)
 *     depende del tiempo de suspensión, así que CUALQUIER cambio de ese tiempo —incluido entrar
 *     y salir del modo ahorro, que lo cambia sin que el usuario toque nada— obliga a rehacerlo;
 *   • así todo entra en UNA escritura del fichero y UN reinicio de hypridle, en vez de dos.
 *
 * Sin poder leer el fichero no se toca la hibernación: mejor dejarla como estaba que planificarla
 * contra una suspensión inventada.
 */
function conHibernacion(valores: ValoresListener, ajuste?: AjusteHibernacion): ValoresListener {
  const suspension = valores.suspend ?? leerConfig()?.suspend
  if (!suspension) return valores
  return { ...valores, hibernate: aplicarHibernacion(ajuste ?? leerHibernacion(), suspension) }
}

// ── Transiciones ─────────────────────────────────────────────────────────────

/** Traduce un `TiempoAhorro` (minutos) al par que entiende `writeHypridle` (segundos). */
const aListener = (t: TiempoAhorro) => ({ timeout: Math.max(1, Math.round(t.min)) * 60, enabled: t.on })

function valoresDelAhorro(): ValoresListener {
  return {
    dpms: aListener(idleDpmsAhorro.get()),
    lock: aListener(idleLockAhorro.get()),
    suspend: aListener(idleSuspendAhorro.get()),
  }
}

function aplicarOverride(): void {
  const yaPuesto = overrideInactividadActivo()
  if (!yaPuesto) {
    const actual = leerConfig()
    if (!actual) return   // sin poder leer el fichero no se aparta nada: mejor no tocarlo
    // El apunte se escribe ANTES de pisar el fichero. Al revés, morir en esa ventana
    // dejaría los tiempos cortos puestos y sin nada que recordara los buenos.
    escribirApunte({ dpms: actual.dpms, lock: actual.lock, suspend: actual.suspend })
  }
  if (!escribirConfig(conHibernacion(valoresDelAhorro())) && !yaPuesto) {
    // No se pudo escribir: el apunte quedaría mintiendo sobre un override inexistente.
    escribirApunte(null)
  }
}

function quitarOverride(): void {
  const apunte = leerApunte()
  if (apunte === null) return
  if (escribirConfig(conHibernacion(apunte))) escribirApunte(null)
}

function reconciliar(): void {
  const quiere = powerSaveActive.get() && idleOverrideInPowerSave.get()
  if (quiere) aplicarOverride()
  else quitarOverride()
}

// Editar un tiempo desde Ajustes mueve los TRES estados de golpe (la fila guarda los tres
// a la vez, igual que la tarjeta general), y cada uno reescribiría el fichero y reiniciaría
// hypridle por su cuenta: tres `pkill` + tres arranques por cada clic en «+». El rebote los
// junta en una sola escritura. Solo lo usa el camino de EDICIÓN — entrar y salir del ahorro
// va directo, que es un cambio de estado real y no debe esperar a nada.
let reboteEdicion: number | null = null
function reconciliarDiferido(): void {
  if (reboteEdicion !== null) GLib.source_remove(reboteEdicion)
  reboteEdicion = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
    reboteEdicion = null
    reconciliar()
    return GLib.SOURCE_REMOVE
  })
}

/**
 * Arranca el vigilante. Va con el resto de `init*` de fondo del `setTimeout` de 4 s de
 * `app.ts`: siembra del estado (el apunte está en disco y `powerSaveActive` ya está
 * resuelto), no de eventos ocurridos mientras espera. La primera pasada es además la
 * recuperación del override huérfano que pudiera haber dejado un AGS muerto.
 */
export function initInactividadAhorro(): void {
  if (arrancado) return
  arrancado = true

  powerSaveActive.subscribe(reconciliar)
  idleOverrideInPowerSave.subscribe(reconciliar)
  // Editar un tiempo del ahorro mientras está vigente debe verse sin salir y volver a entrar.
  idleDpmsAhorro.subscribe(reconciliarDiferido)
  idleLockAhorro.subscribe(reconciliarDiferido)
  idleSuspendAhorro.subscribe(reconciliarDiferido)

  reconciliar()
}
