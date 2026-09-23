import GLib from "gi://GLib"
import { execAsync } from "ags/process"

// Punto ÚNICO por el que Orion abre una app. Antes cada sitio (Apps, Inicio,
// buscador, panel derecho) hacía su propio `sh -c <exec>`, y por eso las apps
// abiertas desde Orion aparecían en el escritorio donde estuvieras al terminar
// de cargar en vez de en el que las lanzaste — al contrario que rofi, que sí
// ancla. `lanzar-anclado.py` hace ese mismo `sh -c` y además observa el socket
// de eventos de Hyprland para anclarlas (ver hypr/scripts/anclaje.py).
//
// El script se resuelve por la ruta canónica del symlink (~/.config/hypr), no
// por la del repo: es donde Hyprland lo tiene y donde lo busca todo lo demás.
const LANZADOR = `${GLib.get_user_config_dir()}/hypr/scripts/lanzar-anclado.py`

/**
 * Lanza `exec` (una línea de shell, como el `Exec` de un `.desktop`) anclando
 * sus ventanas al escritorio actual.
 *
 * El anclaje lo gobierna `anclarVentanasRofi` en preferences.json, que lee el
 * propio script en cada invocación — aquí no se consulta nada, para no tener
 * dos lecturas del mismo ajuste que puedan discrepar.
 *
 * Los errores se tragan igual que en las llamadas que sustituye: si el script
 * falta, `execAsync` rechaza y la app simplemente no se abre, así que se cae al
 * `sh -c` de siempre — degradar a "se abre sin anclar" es preferible a "no se
 * abre".
 */
export function launchApp(exec: string): void {
  const cmd = exec.trim()
  if (!cmd) return
  execAsync([LANZADOR, cmd]).catch(() => {
    execAsync(["sh", "-c", cmd]).catch(() => {})
  })
}
