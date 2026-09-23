// utilidades/abrirTerminal.ts
//
// Abre un comando en la primera terminal disponible ($terminal del sistema = kitty,
// con fallback foot/alacritty/wezterm/xterm) y la deja abierta al terminar (--hold /
// "pulsa Enter") para que se pueda leer la salida. Es el sitio para lanzar cualquier
// acción que necesite pedir la contraseña de sudo INTERACTIVAMENTE: al vivir dentro de
// una terminal de verdad, `sudo` puede preguntarla ahí mismo, sin depender de un agente
// de polkit ni de una regla NOPASSWD.
//
// Extraído de `modulos/barra/indicadores/sistema/Actualizaciones.tsx` (`sudo pacman
// -Syu` / `sudo dnf upgrade` / …), que fue el primer sitio que lo necesitó; ver también
// Ajustes > Pantalla > Suspensión (preparar/quitar la hibernación).
import { execAsync } from "ags/process"

/**
 * Devuelve la promesa de `execAsync` para que el llamante pueda encadenar algo cuando la
 * terminal se cierra (p. ej. releer un estado que la acción pudo haber cambiado). El error
 * se registra aquí SIEMPRE —con la `etiqueta` de quien llama, para poder distinguir el
 * origen en el log— y se relanza para que un `.then()` posterior no se ejecute como si
 * hubiera ido bien; quien no necesite reaccionar puede simplemente encadenar `.catch(() => {})`.
 */
export function abrirEnTerminal(cmd: string, etiqueta: string): Promise<string> {
  if (!cmd) return Promise.reject(new Error(`[${etiqueta}] comando vacío`))
  const picker = `
    hold_cmd="$1"
    for t in kitty foot alacritty wezterm xterm; do
      command -v "$t" >/dev/null 2>&1 || continue
      case "$t" in
        kitty) exec kitty --hold sh -lc "$hold_cmd";;
        foot)  exec foot sh -lc "$hold_cmd; printf '\\nPulsa Enter para cerrar…'; read _";;
        *)     exec "$t" -e sh -lc "$hold_cmd; printf '\\nPulsa Enter para cerrar…'; read _";;
      esac
    done
    exit 127`
  return execAsync(["bash", "-c", picker, "bash", cmd]).catch((e) => {
    console.error(`[${etiqueta}] no se pudo abrir la terminal:`, e)
    throw e
  })
}
