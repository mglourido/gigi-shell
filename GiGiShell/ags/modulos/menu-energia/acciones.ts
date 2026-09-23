export interface AccionEnergia {
  /** Identificador estable de la acción: es también su clase CSS y la clave con la
   *  que se guarda en `preferences.json`. No renombrar sin migrar la preferencia. */
  claseCss: string
  icono: string
  etiqueta: string
  comando: string
}

export const ACCIONES_ENERGIA: readonly AccionEnergia[] = [
  // El bloqueo va por bloquear.sh, no por `hyprlock` a pelo: ese script sortea el fondo del
  // bloqueo (hyprlock.conf no puede — hyprlang no sustituye comandos) y lleva la guarda de
  // instancia única que hyprlock no tiene. El `sh -c` NO es adorno: execAsync parte la cadena
  // con `GLib.shell_parse_argv`, que no es una shell y NO expande la `~` — sin él se ejecutaría
  // un fichero llamado literalmente "~/.config/..." y el botón no bloquearía nada.
  { claseCss: "lock", icono: "󰌾", etiqueta: "Bloquear", comando: "sh -c '~/.config/hypr/scripts/bloquear.sh'" },
  // Forma Lua del dispatcher (bajo config Lua la sintaxis legacy `dispatch exit`
  // no existe). Las comillas sobreviven: execAsync con string parsea con
  // GLib.shell_parse_argv, así que llega como un solo argumento.
  { claseCss: "logout", icono: "󰍃", etiqueta: "Salir", comando: 'hyprctl dispatch "hl.dsp.exit()"' },
  // "Suspender" NO llama a `systemctl suspend` directamente, y el rodeo tiene un motivo: el
  // ajuste «sustituir la suspensión real por la falsa» (Ajustes > Energía). Quien decide es
  // AGS, en el `requestHandler` de app.ts. El `||` de reserva cubre el único caso en que ese
  // request no contesta —AGS caído—, y ahí la suspensión real es la respuesta correcta: sin
  // AGS no hay nadie capaz de hacer una suspensión falsa.
  //
  // La cadena la parte `GLib.shell_parse_argv`, que NO entiende `||`, así que hace falta el
  // `sh -c` explícito con el comando entre comillas simples.
  {
    claseCss: "suspend",
    icono: "󰏤",
    etiqueta: "Suspender",
    comando: "sh -c 'ags request suspend || systemctl suspend'",
  },
  // Suspensión falsa: apagar el escritorio SIN detener el kernel (docs/suspension-falsa.md).
  //
  // El comando es un `ags request` y no una llamada interna a propósito: este tipo solo sabe
  // de cadenas que se ejecutan con execAsync, y ese request existe justamente para dar a la
  // función un punto de entrada scriptable (lo comparten el atajo `locked = true` y cualquier
  // automatismo). Es un ALTERNAR, no una entrada: pulsarlo con la suspensión falsa puesta
  // sale de ella.
  //
  // ⚠️ `claseCss` es la clave con la que la acción se guarda en `preferences.json`
  // (`accionesEnergiaOcultas`). Renombrar "fake-suspend" más adelante obliga a migrar la
  // preferencia de todo el que ya la hubiera ocultado, así que no se toca.
  {
    claseCss: "fake-suspend",
    icono: "󰤄",
    etiqueta: "Suspensión falsa",
    comando: "ags request toggle-suspension-falsa",
  },
  { claseCss: "shutdown", icono: "󰐥", etiqueta: "Apagar", comando: "systemctl poweroff" },
  { claseCss: "hibernate", icono: "󰒲", etiqueta: "Hibernar", comando: "systemctl hibernate" },
  { claseCss: "reboot", icono: "󰜉", etiqueta: "Reiniciar", comando: "systemctl reboot" },
]

/** Ids conocidos, en el orden en que se pintan. */
export const IDS_ACCIONES_ENERGIA: readonly string[] = ACCIONES_ENERGIA.map((a) => a.claseCss)

/**
 * Limpia la lista de acciones ocultas que llega de `preferences.json`: descarta lo que
 * no sea un id conocido, quita duplicados y **garantiza que al menos una acción siga
 * visible**. Sin ese tope, ocultarlas todas dejaría un menú de energía vacío desde el
 * que ya no se puede ni bloquear ni apagar, y el único camino de vuelta sería editar
 * el JSON a mano.
 *
 * Cuando la lista pide ocultarlas todas se conserva la primera del orden de
 * `ACCIONES_ENERGIA` (no la primera de la lista recibida) para que el resultado sea el
 * mismo lea quien lea el fichero.
 */
export function normalizarAccionesOcultas(valor: unknown): string[] {
  if (!Array.isArray(valor)) return []
  const ocultas = IDS_ACCIONES_ENERGIA.filter((id) => valor.includes(id))
  if (ocultas.length < IDS_ACCIONES_ENERGIA.length) return ocultas
  return ocultas.slice(1)
}

/** Acciones que se pintan en el menú, respetando el orden de `ACCIONES_ENERGIA`. */
export function accionesVisibles(ocultas: readonly string[]): AccionEnergia[] {
  const fuera = normalizarAccionesOcultas([...ocultas])
  return ACCIONES_ENERGIA.filter((accion) => !fuera.includes(accion.claseCss))
}
