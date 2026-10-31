import Gdk from "gi://Gdk"
import Gio from "gi://Gio"
import GLib from "gi://GLib"
import System from "system"

const RUTA_AYUDANTE = `${GLib.get_home_dir()}/.local/bin/gigishell-vista-escritorio`

/** Periodo de refresco con la miniatura abierta (30 fps, el `FPS_VISTA` de
 * `hypr/gigishell/vista-en-vivo.lua`): ver las medidas en `modulos/barra/CLAUDE.md`. Hyprland no da
 * daño real, así que no hay evento al que colgarse. */
const INTERVALO_MS = 33

/** Cada fotograma es una textura de cientos de KB que el recolector de JS no percibe (solo ve el
 * envoltorio pequeño): sin forzarlo, 60 s de contenido cambiante hacían crecer el proceso 55 MB. */
const FOTOGRAMAS_ENTRE_RECOLECCIONES = 15

export interface EventosVistaEnVivo {
  alFotograma: (textura: Gdk.Texture) => void
  /** El ayudante no arrancó o terminó sin dar ni un fotograma. Tras detener() ya no llega. */
  alNoDisponible: () => void
}

/** Arranca el ayudante que captura `nombreEscritorio` y devuelve cómo detenerlo. El proceso vive
 * solo mientras la miniatura está abierta, y sus fotogramas BGRA de tamaño fijo llegan por stdout
 * sin pasar por disco. */
export function iniciarVistaEnVivo(
  nombreEscritorio: string,
  ancho: number,
  alto: number,
  recorte: readonly number[],
  eventos: EventosVistaEnVivo,
): () => void {
  const cancelable = new Gio.Cancellable()
  const bytesFotograma = ancho * alto * 4
  let fotogramas = 0

  let proceso: Gio.Subprocess
  try {
    // stdin queda en un tubo abierto: el ayudante termina cuando se cierra, también si AGS muere.
    proceso = Gio.Subprocess.new(
      [
        RUTA_AYUDANTE,
        "--escritorio", nombreEscritorio,
        "--ancho", String(ancho),
        "--alto", String(alto),
        "--intervalo-ms", String(INTERVALO_MS),
        "--recorte", recorte.join(","),
      ],
      Gio.SubprocessFlags.STDIN_PIPE
        | Gio.SubprocessFlags.STDOUT_PIPE
        | Gio.SubprocessFlags.STDERR_SILENCE,
    )
  } catch (_) {
    eventos.alNoDisponible()
    return () => {}
  }

  // Con el búfer del tamaño de un fotograma, `fill` lo acumula en C y `read_bytes` lo entrega como
  // un GBytes: ningún array de JS de cientos de KB por fotograma.
  const entrada = Gio.BufferedInputStream.new_sized(proceso.get_stdout_pipe()!, bytesFotograma)

  const leer = () => {
    const falta = bytesFotograma - entrada.get_available()
    if (falta > 0) {
      entrada.fill_async(falta, GLib.PRIORITY_DEFAULT, cancelable, (_fuente, resultado) => {
        try {
          if (entrada.fill_finish(resultado) > 0) {
            leer()
          } else if (fotogramas === 0 && !cancelable.is_cancelled()) {
            eventos.alNoDisponible()
          }
        } catch (_) {
          // Cancelado al cerrar, o el tubo se rompió: la miniatura conserva lo último que tenga.
        }
      })
      return
    }
    try {
      const datos = entrada.read_bytes(bytesFotograma, null)
      eventos.alFotograma(Gdk.MemoryTexture.new(
        ancho,
        alto,
        Gdk.MemoryFormat.B8G8R8A8_PREMULTIPLIED,
        datos,
        ancho * 4,
      ))
      if (++fotogramas % FOTOGRAMAS_ENTRE_RECOLECCIONES === 0) System.gc()
      leer()
    } catch (error) {
      console.error("Vista previa de escritorio:", error)
    }
  }
  leer()

  return () => {
    cancelable.cancel()
    proceso.force_exit()
  }
}
