// utilidades/abrirTerminal.ts
//
// Abre un comando en el terminal elegido en Ajustes > Apps predeterminadas (el mismo que
// lanza SUPER+Q) y lo deja abierto al terminar, para poder leer la salida. Es el sitio para
// lanzar cualquier acción que necesite pedir la contraseña de sudo INTERACTIVAMENTE: al vivir
// dentro de una terminal de verdad, `sudo` puede preguntarla ahí mismo, sin depender de un
// agente de polkit ni de una regla NOPASSWD.
//
// Aquí no se nombra ningún terminal. La sintaxis de «ejecuta esto y quédate» cambia de uno a otro,
// y cada uno la declara en su `.desktop` (xdg-terminal-exec: `X-TerminalArgExec`/`ArgHold`);
// `lanzadorTerminal()` la lee y `scripts/abrir-en-terminal.sh` la aplica.
//
// Extraído de `modulos/barra/indicadores/sistema/Actualizaciones.tsx` (`sudo pacman
// -Syu` / `sudo dnf upgrade` / …), que fue el primer sitio que lo necesitó; ver también
// Ajustes > Pantalla > Suspensión (preparar/quitar la hibernación).
import { execAsync } from "ags/process"
import { lanzadorTerminal } from "../servicios/aplicaciones/appsPredeterminadas"
import { RAIZ_REPO } from "./rutas"

const SCRIPT = `${RAIZ_REPO}/ags/scripts/abrir-en-terminal.sh`

/**
 * Devuelve la promesa de `execAsync` para que el llamante pueda encadenar algo cuando la
 * terminal se cierra (p. ej. releer un estado que la acción pudo haber cambiado). El error
 * se registra aquí SIEMPRE —con la `etiqueta` de quien llama, para poder distinguir el
 * origen en el log— y se relanza para que un `.then()` posterior no se ejecute como si
 * hubiera ido bien; quien no necesite reaccionar puede simplemente encadenar `.catch(() => {})`.
 */
export async function abrirEnTerminal(cmd: string, etiqueta: string): Promise<string> {
  try {
    if (!cmd) throw new Error("comando vacío")
    const lanzador = lanzadorTerminal()
    if (!lanzador) throw new Error("no hay ningún terminal instalado")
    return await execAsync(["bash", SCRIPT, cmd, lanzador.argExec, lanzador.argHold, ...lanzador.argv])
  } catch (e) {
    console.error(`[${etiqueta}] no se pudo abrir la terminal:`, e)
    throw e
  }
}
