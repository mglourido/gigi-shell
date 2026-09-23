// servicios/camara/bloqueo.ts
//
// El interruptor "Cámara bloqueada" (killswitch por software).
//
// AGS no bloquea nada por su cuenta: los nodos `/dev/video*` son de `root:video` y quien decide
// sus permisos es udev. Todo el trabajo lo hace el helper root-owned `/usr/local/bin/gigios-camara`
// (fuente versionada en `system/camara/gigios-camara.sh`), autorizado sin contraseña por
// `/etc/sudoers.d/gigios-camara` SOLO para sus dos verbos. Mismo esquema que
// `servicios/energia/tlp.ts` y `servicios/seguridad/clamav.ts`; el porqué de cada decisión —y en
// especial por qué la regla udev se llama `71-` y no `99-`— está en la cabecera del helper y en la
// sección de cámara de `docs/hyprland-modulos.md`.
//
// ── LEER EL ESTADO NO NECESITA SUDO, Y POR ESO NO PASA POR LA REGLA ──────────────────────────
// El estado ES la presencia de `/etc/udev/rules.d/71-gigios-camara-bloqueada.rules`, que es
// world-readable. Se consulta con `gigios-camara status` (sin sudo) para no duplicar aquí el
// conocimiento de esa ruta: el día que cambie, cambia en un sitio. Preguntarle al sistema es
// además lo único que no puede mentir — el fichero puede haberlo puesto o quitado alguien desde
// un TTY, que es justo la escotilla de emergencia que el helper documenta.
//
// ── SIN HELPER NO SE PINTA EL INTERRUPTOR ───────────────────────────────────────────────────
// En un equipo donde el paso `sistema` del instalador no llegó a correr, el helper no existe y
// `bloqueoDisponible` queda en falso: la UI oculta el interruptor en vez de enseñar uno que
// fallaría con "command not found" al pulsarlo. El resto de la sección de cámara —controles,
// vista previa, detector de uso— no depende de nada de esto y sigue funcionando.
import { createState } from "ags"
import { execAsync } from "ags/process"
import GLib from "gi://GLib"

const HELPER = "/usr/local/bin/gigios-camara"

export const [camaraBloqueada, setCamaraBloqueada] = createState(false)
/** Hay helper instalado, o sea que el interruptor puede existir. */
export const [bloqueoDisponible, setBloqueoDisponible] = createState(false)
/** Una orden en vuelo: la UI deshabilita el interruptor mientras dura. `udevadm settle` puede
 *  tardar un instante y dos pulsaciones seguidas se pisarían. */
export const [bloqueoOcupado, setBloqueoOcupado] = createState(false)

function hayHelper(): boolean {
  return GLib.file_test(HELPER, GLib.FileTest.IS_EXECUTABLE)
}

/** Relee el estado del sistema. Barato: un proceso que solo hace un `test -f`. */
export async function refrescarBloqueo() {
  if (!hayHelper()) {
    setBloqueoDisponible(false)
    // Y NO se toca `camaraBloqueada`: sin helper no se sabe nada, y dejarlo en `false` sería
    // afirmar que la cámara está libre. La UI no lo enseña de todos modos.
    return
  }
  setBloqueoDisponible(true)
  try {
    const salida = await execAsync([HELPER, "status"])
    setCamaraBloqueada(salida.trim().startsWith("blocked"))
  } catch (e) {
    console.error("[camara] status del bloqueo:", e)
  }
}

/** Bloquea o desbloquea. Devuelve el estado real leído DESPUÉS de la orden, que no tiene por qué
 *  ser el pedido: si `udevadm` falla, el helper avisa y el interruptor debe volverse atrás en vez
 *  de quedarse mintiendo. */
export async function fijarBloqueo(bloquear: boolean): Promise<boolean> {
  if (!hayHelper()) return camaraBloqueada.get()
  setBloqueoOcupado(true)
  try {
    await execAsync(["sudo", "-n", HELPER, bloquear ? "block" : "unblock"])
  } catch (e) {
    // `sudo -n` (no interactivo) falla en vez de quedarse esperando una contraseña que nadie va a
    // teclear: un panel no tiene dónde pedirla, y sin `-n` el proceso se quedaría colgado con el
    // interruptor a medias para siempre.
    console.error("[camara] bloqueo:", e)
  }
  await refrescarBloqueo()
  setBloqueoOcupado(false)
  return camaraBloqueada.get()
}

export function alternarBloqueo() {
  void fijarBloqueo(!camaraBloqueada.get())
}
