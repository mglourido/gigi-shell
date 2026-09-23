// servicios/energia/tapaPortatil.ts
//
// Qué hace el portátil al CERRAR LA TAPA (Ajustes > Energía) + detección de si
// esta máquina tiene tapa y de si el interruptor es nuestro de verdad.
//
// El shell NO ejecuta la acción: solo persiste la preferencia. Quien la ejecuta es
// `GiGiShell.tapa_cerrada()` (hypr/gigios/tapa.lua), atada en gigios/keybinds.lua a
// `switch:on:Lid Switch` con `locked = true` — así la tapa responde aunque AGS no
// esté vivo y con la sesión bloqueada, que es como se cierra casi siempre.
//
// El vocabulario de acciones sale del botón de encendido y comparte con él las
// implementaciones en Lua: "suspender" significa lo mismo en los dos sitios (pasa
// por AGS para respetar la suspensión falsa), y lo mismo "bloquear" (pasa por
// bloquear.sh). Lo que se poda es lo que no tiene sentido a ciegas — abrir el menú
// de energía con la tapa cerrada es un menú invisible. Lo que se añade es
// "suspensionFalsa", que solo la tapa ofrece.
//
// La parte delicada es la misma que con el botón: systemd-logind gestiona la tapa
// a nivel de asiento (`HandleLidSwitch`, `suspend` de fábrica) sin pasar por el
// compositor. Pero aquí NO se le quita desde /etc: `ignore` valdría también para
// el saludador y para una sesión caída, y cerrar el portátil en la pantalla de
// login lo dejaría encendido dentro de la mochila. Se le quita con un INHIBIDOR
// (`handle-lid-switch`, sin privilegios) que sostiene
// hypr/scripts/tapa-inhibidor.sh mientras Hyprland viva. Por eso lo que se
// comprueba abajo no es un fichero de /etc sino que el inhibidor esté PUESTO.
import GLib from "gi://GLib"
import { createState } from "ags"
import { execAsync } from "ags/process"

export const ACCIONES_TAPA = [
  "suspender",
  // Propia de la tapa: el botón de encendido no la ofrece. Allí "suspender" ya entra
  // en la falsa cuando el usuario la ha puesto a sustituir a la real; aquí se pide
  // por su nombre, así que entra siempre. La implementa gigios/tapa.lua por el
  // request `suspension-falsa-entrar` de app.ts — ENTRAR y no alternar, porque cerrar
  // la tapa estando ya dentro tiene que dejarla puesta.
  "suspensionFalsa",
  "hibernar",
  "bloquear",
  "pantalla",
  "apagar",
  "nada",
] as const

export type AccionTapa = typeof ACCIONES_TAPA[number]

/** Valor de fábrica: lo que hacía logind antes de que existiera este ajuste. */
export const ACCION_TAPA_PREDETERMINADA: AccionTapa = "suspender"

/** Convierte datos persistidos desconocidos en una acción segura. */
export function normalizarAccionTapa(valor: unknown): AccionTapa {
  return ACCIONES_TAPA.some((accion) => accion === valor)
    ? valor as AccionTapa
    : ACCION_TAPA_PREDETERMINADA
}

/**
 * ¿Tiene tapa esta máquina? El interruptor ACPI de la tapa publica
 * `/proc/acpi/button/lid/<algo>`, y un sobremesa no tiene ninguno. Se resuelve una
 * sola vez al cargar el módulo: no es algo que cambie en caliente.
 *
 * Se usa para OCULTAR la tarjeta entera, que es la excepción al criterio de "una
 * tarjeta se pinta siempre aunque no haya soporte" (el brillo, las firmas de
 * ClamAV): allí el ajuste sigue significando algo y lo que falta es el backend;
 * aquí, sin tapa, la pregunta no existe.
 */
export const hayTapa = tieneInterruptorDeTapa()

/** El interruptor ACPI de la tapa publica `/proc/acpi/button/lid/<algo>`; un
 *  sobremesa no publica ninguno. Un directorio de /proc con una entrada no merece
 *  un enumerador asíncrono de Gio. */
function tieneInterruptorDeTapa(): boolean {
  try {
    const dir = GLib.Dir.open("/proc/acpi/button/lid", 0)
    const primera = dir.read_name()
    dir.close()
    return !!primera
  } catch {
    return false
  }
}

// ── ¿Quién manda sobre la tapa? ───────────────────────────────────────────────
// `null` = todavía no se sabe (la consulta es asíncrona y puede fallar). Se
// distingue de `false` a propósito, igual que en botonEncendido.ts: no poder
// comprobarlo no es lo mismo que saber que está mal.
const [tapaCedidaAHyprland, _setTapaCedida] = createState<boolean | null>(null)
export { tapaCedidaAHyprland }

/**
 * ¿Está puesto el inhibidor de `handle-lid-switch`? Sin sondeo: lo pone el
 * autostart una vez por sesión, así que basta con mirarlo al abrir la sección.
 * `systemd-inhibit --list` no necesita privilegios.
 *
 * Se busca el nombre del inhibidor (`GiGiShell`) y no solo el tipo: otro programa
 * podría estar inhibiendo la tapa por su cuenta, y eso no querría decir que
 * nuestro bind vaya a ejecutarse.
 */
export function comprobarTapa() {
  if (!GLib.find_program_in_path("systemd-inhibit")) return
  execAsync(["systemd-inhibit", "--list", "--no-legend", "--no-pager"])
    .then((salida) => _setTapaCedida(
      String(salida).split("\n").some((linea) =>
        linea.includes("handle-lid-switch") && linea.includes("GiGiShell")),
    ))
    .catch(() => _setTapaCedida(null))
}
