import { execAsync } from "ags/process"

/**
 * Rearma los listeners después de cambiar su configuración o liberar un veto.
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
  return execAsync(["bash", "-c", "pkill hypridle; setsid -f hypridle </dev/null >/dev/null 2>&1"])
}
