// Lectura del desenlace de `hypr/scripts/desinstalar-app.sh desinstalar`.
// Puro: no importa GTK, GLib ni Gio, y por eso lo cubre `uninstall.parse.test.ts`
// con el runner de node.
//
// Es poca cosa, pero decide si se borra el favorito y si se tira la caché del
// catálogo, así que conviene que esa decisión esté probada y no enterrada en un
// `.then()` dentro de un widget.

/**
 * - `ok`        — hecho, la app ya no está.
 * - `externo`   — se ha delegado en otro programa (Steam) y **no vamos a saber**
 *                 si el usuario confirma. Ni se ha borrado nada todavía, ni la
 *                 pantalla vuelve a ser nuestra.
 * - `cancelado` — el usuario cerró el diálogo de contraseña.
 * - `error`     — no se pudo; el motivo va por notificación.
 */
export type ResultadoDesinstalacion = "ok" | "externo" | "cancelado" | "error"

const CONOCIDOS: readonly string[] = ["ok", "externo", "cancelado"]

/**
 * El script imprime una sola palabra por stdout y sale con 0 pase lo que pase
 * (ver el comentario de su bloque `desinstalar`). Aquí se lee la ÚLTIMA palabra
 * porque cualquier ruido previo —una traza de pacman, un aviso de un helper— no
 * debe cambiar el veredicto.
 *
 * Todo lo que no sea exactamente una de las palabras conocidas es `error`. Dar
 * por buena una salida que no entendemos significaría borrar el favorito de una
 * app que quizá sigue instalada.
 */
export function interpretarSalida(salida: string): ResultadoDesinstalacion {
  const palabra = salida.trim().split(/\s+/).pop() ?? ""
  return CONOCIDOS.includes(palabra) ? (palabra as ResultadoDesinstalacion) : "error"
}
