// Lado AGS de la desinstalación de apps desde el panel derecho de Orion.
// Aquí solo hay E/S: el script detecta el método (pacman/AUR, Flatpak, Steam o
// borrado de ficheros), ejecuta y notifica el resultado.
//
// El script se resuelve por la ruta canónica del symlink (~/.config/hypr), no
// por la del repo, igual que `launch.ts` con `lanzar-anclado.py`.

import GLib from "gi://GLib"
import app from "ags/gtk4/app"
import { execAsync } from "ags/process"
import { interpretarSalida, type ResultadoDesinstalacion } from "./uninstall.parse"

const SCRIPT = `${GLib.get_user_config_dir()}/hypr/scripts/desinstalar-app.sh`

export type { ResultadoDesinstalacion } from "./uninstall.parse"

/** Lo que el panel derecho sabe de la app, y lo único que el script necesita. */
export interface AppDesinstalable {
  appId: string
  /** Ruta del `.desktop`; cadena vacía si no se conoce (favoritos antiguos). */
  desktopFile: string
  execRaw: string
  name: string
}

// ── Cederle la pantalla al diálogo de contraseña ─────────────────────────────

const SONDEO_MS = 40
// Techo: ~1 s. Si la animación de salida se atasca no puede dejar la
// desinstalación colgada para siempre — se sigue adelante, y lo peor que pasa
// es que el diálogo salga tapado, que es exactamente el comportamiento de antes.
const INTENTOS_MAX = 25

function orionSigueEnPantalla(): boolean {
  try {
    return app.get_windows().some((w: any) => w?.name === "orion" && w?.visible)
  } catch (_) {
    return false
  }
}

/**
 * Espera a que la superficie de Orion esté DESMAPEADA de verdad.
 *
 * Sin esto el diálogo de contraseña sale **por debajo** de Orion y hay que
 * cerrarlo a mano para poder escribir. No es un problema de orden de llamadas
 * que se arregle poniendo `hidePanel()` antes: Orion es una layer-shell
 * `OVERLAY`, y esa capa va por encima de **todas** las ventanas normales por
 * definición del protocolo — el diálogo de polkit es una ventana normal, así que
 * mientras la superficie exista no hay forma de que se dibuje encima. Además
 * Orion tiene keymode `ON_DEMAND`, o sea que también pelea por el teclado.
 *
 * Se sondea el estado real de la ventana en vez de dormir un número fijo de
 * milisegundos: la salida de Orion son ~280 ms de animación más un par de
 * frames, y copiar esa constante aquí la dejaría desincronizada en silencio la
 * primera vez que alguien la retoque.
 */
function esperarOrionOculto(): Promise<void> {
  return new Promise((resolve) => {
    if (!orionSigueEnPantalla()) { resolve(); return }
    let intentos = 0
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, SONDEO_MS, () => {
      intentos++
      if (orionSigueEnPantalla() && intentos < INTENTOS_MAX) return GLib.SOURCE_CONTINUE
      resolve()
      return GLib.SOURCE_REMOVE
    })
  })
}

/**
 * Desinstala la app. **No pregunta nada**: la confirmación es el propio diálogo
 * de contraseña de polkit, que no se puede saltar y que el usuario tiene que
 * atender de todas formas.
 *
 * Quien llama debe haber cerrado Orion ya (`hidePanel()`); aquí se espera a que
 * la superficie desaparezca antes de lanzar nada, por el motivo de arriba.
 *
 * Todo lo que pueda salir mal —el script ausente, un paquete del que dependen
 * otros, un método que no se sabe resolver— lo reporta el propio script por
 * `notify-send`, y tiene que ser así: `pkexec` puede tardar lo que tarde el
 * usuario en teclear la contraseña, y para entonces Orion lleva rato cerrado.
 */
export async function desinstalarApp(objetivo: AppDesinstalable): Promise<ResultadoDesinstalacion> {
  // El script es el único que notifica, así que si falta hay que hablar desde
  // aquí: con Orion ya cerrado, un `return "error"` a secas dejaría al usuario
  // mirando un escritorio en el que no ha pasado absolutamente nada.
  if (!GLib.file_test(SCRIPT, GLib.FileTest.IS_EXECUTABLE)) {
    execAsync([
      "notify-send", "-h", "string:x-gigios-source:system",
      "-h", "string:x-gigios-event:desinstalar.falta-script", "-u", "critical",
      "-a", "Desinstalar", `No se pudo desinstalar «${objetivo.name}»`,
      "Falta hypr/scripts/desinstalar-app.sh: ejecuta bin/link.sh.",
    ]).catch(() => {})
    return "error"
  }
  await esperarOrionOculto()
  try {
    return interpretarSalida(await execAsync([
      SCRIPT, "desinstalar", objetivo.appId, objetivo.desktopFile, objetivo.execRaw, objetivo.name,
    ]))
  } catch (_) {
    return "error"
  }
}
