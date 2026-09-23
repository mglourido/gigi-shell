// servicios/energia/botonEncendido.ts
//
// Acción del botón de encendido físico (tecla XF86PowerOff) + comprobación de
// quién manda de verdad sobre esa tecla.
//
// El shell NO ejecuta la acción: solo persiste la preferencia. Quien la ejecuta
// es `GiGiShell.boton_apagado()` (hypr/gigishell/boton-apagado.lua), atado en gigishell/keybinds.lua con
// `bindl = , XF86PowerOff`. Así el botón sigue funcionando aunque AGS no esté
// vivo (con la acción de fábrica) y responde también con la sesión bloqueada.
//
// La parte delicada es que systemd-logind maneja esa misma tecla por su cuenta
// (`HandlePowerKey`, `poweroff` de fábrica) a nivel de asiento, sin pasar por el
// compositor. Si no está en `ignore`, el bind se ejecuta igual pero el apagado de
// logind lo tapa: el ajuste parecería roto sin dar ningún error. Por eso se
// consulta la propiedad REAL de logind por D-Bus (no la presencia del fichero de
// /etc: el usuario puede haberlo puesto en otro sitio, o haberlo cambiado a mano)
// y la sección de Energía avisa cuando la elección no puede cumplirse.
import GLib from "gi://GLib"
import { createState } from "ags"
import { execAsync } from "ags/process"

export const ACCIONES_BOTON_ENCENDIDO = [
  "apagar",
  "suspender",
  "hibernar",
  "bloquear",
  "pantalla",
  "menu",
  "cerrarSesion",
  "reiniciar",
  "nada",
] as const

export type AccionBotonEncendido = typeof ACCIONES_BOTON_ENCENDIDO[number]

/** Valor de fábrica: lo que hacía logind antes de que existiera este ajuste. */
export const ACCION_BOTON_PREDETERMINADA: AccionBotonEncendido = "apagar"

/** Convierte datos persistidos desconocidos en una acción segura. */
export function normalizarAccionBotonEncendido(valor: unknown): AccionBotonEncendido {
  return ACCIONES_BOTON_ENCENDIDO.some((accion) => accion === valor)
    ? valor as AccionBotonEncendido
    : ACCION_BOTON_PREDETERMINADA
}

// ── ¿Quién manda sobre la tecla? ──────────────────────────────────────────────
// `null` = todavía no se sabe (la consulta es asíncrona y puede fallar). Se
// distingue de `false` a propósito: no poder comprobarlo no es lo mismo que saber
// que está mal, y un aviso de configuración lanzado a ciegas es ruido.
const [teclaCedidaAHyprland, _setTeclaCedida] = createState<boolean | null>(null)
export { teclaCedidaAHyprland }

/**
 * Pregunta a logind qué hace con la tecla de encendido. Sin sondeo: cambiarlo
 * exige tocar /etc y recargar el servicio, así que basta con mirarlo al abrir la
 * sección. `busctl` no necesita privilegios para leer la propiedad.
 */
export function comprobarBotonEncendido() {
  if (!GLib.find_program_in_path("busctl")) return
  execAsync([
    "busctl", "--system", "get-property",
    "org.freedesktop.login1", "/org/freedesktop/login1",
    "org.freedesktop.login1.Manager", "HandlePowerKey",
  ])
    // La respuesta es del tipo `s "poweroff"`.
    .then((salida) => _setTeclaCedida(/"ignore"/.test(String(salida))))
    .catch(() => _setTeclaCedida(null))
}
