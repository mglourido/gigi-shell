import Gdk from "gi://Gdk"
import Gio from "gi://Gio"
import GLib from "gi://GLib"
import System from "system"

const RUTA_AYUDANTE = `${GLib.get_home_dir()}/.local/bin/gigishell-vista-escritorio`
const BYTES_CABECERA = 4
/** El recolector de JS no percibe el peso de las texturas: ver `modulos/barra/CLAUDE.md`. Se cuenta
 * en bytes porque aquí una textura mide de 1 a 11 MB. */
const BYTES_ENTRE_RECOLECCIONES = 64 * 1024 * 1024

export interface OpcionesCapturaEscritorios {
  ancho: number
  alto: number
  intervaloMs: number
  intervaloRespaldoMs?: number
  recorte: readonly number[]
  buferes: number
  imagenFija: boolean
  alFotograma: (clave: number, textura: Gdk.Texture) => void
  alNoDisponible: () => void
}

/** Lanza el ayudante en modo `--sesiones`. Si el nombre de un escritorio lleva salto de línea no
 * se envía: rompería el protocolo por líneas. */
export function iniciarCapturaEscritorios(o: OpcionesCapturaEscritorios) {
  const cancelable = new Gio.Cancellable()
  const bytesFotograma = o.ancho * o.alto * 4
  const argumentos = [
    RUTA_AYUDANTE, "--sesiones",
    "--ancho", String(o.ancho),
    "--alto", String(o.alto),
    "--intervalo-ms", String(o.intervaloMs),
    "--recorte", o.recorte.join(","),
    "--buferes", String(o.buferes),
  ]
  if (o.intervaloRespaldoMs) argumentos.push("--intervalo-respaldo-ms", String(o.intervaloRespaldoMs))
  if (o.imagenFija) argumentos.push("--imagen-fija")

  let proceso: Gio.Subprocess
  try {
    // stdin queda en un tubo abierto: el ayudante termina cuando se cierra, también si AGS muere.
    proceso = Gio.Subprocess.new(
      argumentos,
      Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE,
    )
  } catch (_) {
    o.alNoDisponible()
    return { anadir: () => {}, quitar: () => {}, detener: () => {} }
  }

  const entrada = Gio.BufferedInputStream.new_sized(proceso.get_stdout_pipe()!, BYTES_CABECERA + bytesFotograma)
  const stdin = proceso.get_stdin_pipe()!
  const codificador = new TextEncoder()
  let fotogramas = 0
  let bytesDesdeRecoleccion = 0

  const leer = () => {
    if (cancelable.is_cancelled()) return
    const falta = BYTES_CABECERA + bytesFotograma - entrada.get_available()
    if (falta > 0) {
      entrada.fill_async(falta, GLib.PRIORITY_DEFAULT, cancelable, (_fuente, resultado) => {
        try {
          if (entrada.fill_finish(resultado) > 0) leer()
          else if (fotogramas === 0 && !cancelable.is_cancelled()) o.alNoDisponible()
        } catch (_) {
          // Cancelado al cerrar, o el tubo se rompió: la miniatura conserva lo último que tenga.
        }
      })
      return
    }
    try {
      // Cabecera y datos por separado: `get_data` copia, y copiar 11 MB a JS es lo que se evita.
      const cabecera = entrada.read_bytes(BYTES_CABECERA, null).get_data()!
      const clave = new DataView(cabecera.buffer, cabecera.byteOffset, BYTES_CABECERA).getUint32(0, true)
      const datos = entrada.read_bytes(bytesFotograma, null)
      fotogramas++
      try {
        o.alFotograma(clave, Gdk.MemoryTexture.new(
          o.ancho, o.alto, Gdk.MemoryFormat.B8G8R8A8_PREMULTIPLIED, datos, o.ancho * 4,
        ))
      } catch (error) {
        // Un fallo del consumidor no debe cortar la lectura: si no, el ayudante se bloquea escribiendo.
        console.error("Vista de escritorios: fotograma descartado:", error)
      }
      bytesDesdeRecoleccion += bytesFotograma
      if (bytesDesdeRecoleccion >= BYTES_ENTRE_RECOLECCIONES) {
        bytesDesdeRecoleccion = 0
        System.gc()
      }
      leer()
    } catch (error) {
      console.error("Vista de escritorios:", error)
    }
  }
  leer()

  const orden = (texto: string) => {
    try {
      stdin.write_bytes(new GLib.Bytes(codificador.encode(`${texto}\n`)), null)
    } catch (_) {
      // El ayudante ya terminó: ya se avisó por `alNoDisponible` o se está cerrando.
    }
  }

  return {
    anadir: (clave: number, nombre: string) => {
      if (!nombre.includes("\n")) orden(`+${clave} ${nombre}`)
    },
    quitar: (clave: number) => orden(`-${clave}`),
    detener: () => {
      cancelable.cancel()
      proceso.force_exit()
    },
  }
}
