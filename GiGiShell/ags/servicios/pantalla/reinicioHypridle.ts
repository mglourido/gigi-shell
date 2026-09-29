import { execAsync } from "ags/process"

/**
 * Rearma los listeners después de cambiar su configuración o liberar un veto.
 *
 * Va por `hypr/scripts/hypridle.sh` y no por `hypridle` a pelo: el script traduce
 * `~/.config/gigishell/inactividad.json` a las variables que lee hypridle.conf, mata la
 * instancia anterior y espera a que suelte el bus. Un `hypridle` directo arrancaría con los
 * tiempos POR DEFECTO del .conf, no con los del usuario.
 *
 * `setsid -f` + stdio a /dev/null NO es opcional. Un `hypridle &` a secas hereda
 * el stdout de AGS (un pipe de Gio.Subprocess): cuando AGS descarta ese subproceso
 * el extremo de lectura se cierra, y el siguiente log de hypridle recibe SIGPIPE y
 * lo mata — o, si el pipe se mantiene abierto, el `execAsync` no resuelve nunca
 * porque hypridle (un demonio) no cierra su stdout. En ambos casos el reinicio en
 * vivo era poco fiable y el cambio de tiempos/veto no se aplicaba hasta reiniciar
 * la sesión ("la desactivación no funciona"). `setsid -f` lo lanza en su propia
 * sesión, desligado del ciclo de vida y de las tuberías de AGS — el mismo patrón
 * que `clipboard-history.sh start`.
 */
export function reiniciarHypridle(): Promise<string> {
  return execAsync(["bash", "-c", "setsid -f ~/.config/hypr/scripts/hypridle.sh </dev/null >/dev/null 2>&1"])
}
