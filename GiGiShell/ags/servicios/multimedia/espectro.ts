// Espectro de audio real para la onda de la barra (`modulos/barra/multimedia/spotify/OndaSpotify.tsx`).
//
// La FFT la hace `cava` (C + fftw), NO nosotros: hacerla en TypeScript serían ~2,6 M
// multiplicaciones por segundo dentro del bucle principal de GTK, que es exactamente donde
// no puede estar. cava se lanza en modo `raw`/`ascii` y escribe una línea por frame con
// BANDAS valores; aquí solo se parsea. Coste medido del lado del shell: una línea de ~40
// bytes cada 16 ms.
//
// **Un solo proceso para todos los monitores.** `OndaSpotify` se instancia por monitor
// (`app.get_monitors()`), así que el arranque va por REFCOUNT: `adquirirEspectro()` devuelve
// la función de liberación y cava solo vive mientras alguien lo tenga adquirido. Sin eso,
// una máquina con dos pantallas tendría dos procesos capturando el mismo audio.
//
// **Es el MONITOR DEL SINK, no Spotify aislado.** cava no sabe filtrar por aplicación, y
// aislarla exigiría un null-sink dedicado — desproporcionado para una onda de 54 px. Como la
// onda solo se pinta mientras Spotify reproduce, en la práctica es su audio.
//
// **cava sale como "alguien está grabando" y hay que seguir filtrándolo.** Su stream es un
// `Stream/Input/Audio` (captura el monitor del sink), así que AstalWp lo mete en
// `audio.recorders` igual que un micro: mientras esto corría, el indicador de micrófono de la
// barra se encendía al dar a play. Hoy se detecta solo (PipeWire le pone `stream.capture.sink`),
// pero además está apartado a pelo por `node.name` —literalmente `cava`— en
// `CAPTURAS_IGNORADAS_SIEMPRE` de `servicios/multimedia/capturasMicrofono.ts`: saber su veredicto
// de antemano es lo que hace que reproducir música no lance ni un subproceso ni pueda hacer
// parpadear el icono. Si algún día se lanza el proceso con otro nombre de nodo, actualiza esa
// constante o vuelven las dos cosas, sin dar ningún error.
//
// **Fail-open hacia "la onda se mueve".** Si falta cava, si el proceso muere o si no hay
// señal (Spotify Connect reproduciendo en el MÓVIL: el sink local está mudo), esto publica
// `conSenal = false` y el widget vuelve a su animación procedimental. El modo de fallo nunca
// puede ser una onda congelada, que se lee como "el reproductor está roto".

import GLib from "gi://GLib"
import Gio from "gi://Gio"
import { createState } from "ags"

/** Número de barras. Es el contrato con cava (`bars`) y con el widget. */
export const BANDAS = 13

/** Frames por segundo que se le piden a cava. */
const FPS = 60

/** Por debajo de esto una banda se considera silencio. */
const SUELO_SENAL = 0.02

/**
 * Sin ninguna banda por encima del suelo durante este tiempo se declara "no hay señal" y el
 * widget repliega. Es holgado a propósito: un silencio entre estrofas no debe hacer parpadear
 * la fuente de datos.
 */
const GRACIA_SENAL_MS = 1500

/** ¿Está instalado `cava`? Sin él todo esto queda inerte y manda el algoritmo procedimental. */
export const espectroDisponible = GLib.find_program_in_path("cava") !== null

/** Niveles 0..1 por banda, de graves a agudos (el orden que emite cava). */
export const [nivelesEspectro, _setNiveles] = createState<number[]>(new Array(BANDAS).fill(0))

/** ¿Estamos recibiendo audio de verdad ahora mismo? */
export const [espectroConSenal, _setConSenal] = createState(false)

/**
 * `channels = mono` NO es opcional: el default de cava es `stereo`, que EXIGE un número PAR
 * de barras. Con BANDAS impar (13) cava se niega a arrancar —"must have even number of bars
 * with stereo output" por stderr— y además escupe basura por STDOUT, que es justo el flujo de
 * datos. Medido: sin esa clave no sale ni una línea parseable.
 *
 * Ojo al editar: esto es un template literal, así que aquí dentro no puede ir un backtick.
 */
const CONFIG = `
[general]
framerate = ${FPS}
bars = ${BANDAS}
autosens = 1

[input]
method = pipewire
source = auto

[output]
method = raw
raw_target = /dev/stdout
data_format = ascii
ascii_max_range = 100
channels = mono

[smoothing]
noise_reduction = 60
`.trimStart()

let usuarios = 0
let proceso: Gio.Subprocess | null = null
let cancelador: Gio.Cancellable | null = null
let ultimaSenalUs = 0
let idGracia: number | null = null

const ceros = () => new Array(BANDAS).fill(0)

/**
 * El config se escribe en el runtime dir en vez de versionarse: así el fichero no puede
 * divergir de las constantes de arriba (BANDAS y FPS son el contrato con el widget) y no
 * queda un `.conf` suelto en el repo que alguien edite esperando que surta efecto.
 */
function rutaConfig(): string | null {
  try {
    const directorio = GLib.build_filenamev([GLib.get_user_runtime_dir(), "ags"])
    GLib.mkdir_with_parents(directorio, 0o700)
    const ruta = GLib.build_filenamev([directorio, "cava.conf"])
    GLib.file_set_contents(ruta, CONFIG)
    return ruta
  } catch (e) {
    console.error("[espectro] no se pudo escribir el config de cava:", e)
    return null
  }
}

function parsear(linea: string): number[] | null {
  const trozos = linea.split(";")
  const valores: number[] = []
  for (const trozo of trozos) {
    if (trozo === "") continue
    const numero = Number(trozo)
    if (!Number.isFinite(numero)) return null
    valores.push(Math.min(1, Math.max(0, numero / 100)))
  }
  return valores.length === BANDAS ? valores : null
}

/**
 * La caducidad de la señal necesita su propio reloj: si el audio para de golpe, cava sigue
 * emitiendo líneas de ceros y ninguna de ellas puede "apagar" la señal por sí sola sin
 * convertir cada silencio corto en un salto de fuente. Un tick de 500 ms compara contra
 * GRACIA_SENAL_MS y solo entonces cede el mando al algoritmo procedimental.
 */
function armarGracia(): void {
  if (idGracia !== null) return
  idGracia = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
    if (!proceso) { idGracia = null; return GLib.SOURCE_REMOVE }
    const transcurrido = (GLib.get_monotonic_time() - ultimaSenalUs) / 1000
    if (transcurrido > GRACIA_SENAL_MS && espectroConSenal.get()) _setConSenal(false)
    return GLib.SOURCE_CONTINUE
  })
}

function leer(flujo: Gio.DataInputStream, propio: Gio.Subprocess): void {
  flujo.read_line_async(GLib.PRIORITY_DEFAULT, cancelador, (fuente, resultado) => {
    let linea: string | null = null
    try {
      const [bytes] = (fuente as Gio.DataInputStream).read_line_finish(resultado)
      linea = bytes ? new TextDecoder().decode(bytes) : null
    } catch (_) {
      return   // cancelado al parar, o el proceso ha muerto: no hay nada que rescatar
    }
    if (proceso !== propio) return   // ya lo hemos reemplazado
    if (linea === null) { detener(); return }   // EOF: cava se ha ido

    const valores = parsear(linea)
    if (valores) {
      _setNiveles(valores)
      let maximo = 0
      for (const valor of valores) if (valor > maximo) maximo = valor
      if (maximo > SUELO_SENAL) {
        ultimaSenalUs = GLib.get_monotonic_time()
        if (!espectroConSenal.get()) _setConSenal(true)
      }
    }
    leer(flujo, propio)
  })
}

function arrancar(): void {
  if (proceso || !espectroDisponible) return
  const ruta = rutaConfig()
  if (!ruta) return

  try {
    proceso = Gio.Subprocess.new(["cava", "-p", ruta], Gio.SubprocessFlags.STDOUT_PIPE)
  } catch (e) {
    console.error("[espectro] no se pudo lanzar cava:", e)
    proceso = null
    return
  }

  cancelador = new Gio.Cancellable()
  ultimaSenalUs = GLib.get_monotonic_time()
  armarGracia()
  leer(new Gio.DataInputStream({ base_stream: proceso.get_stdout_pipe()! }), proceso)
}

function detener(): void {
  if (idGracia !== null) { GLib.source_remove(idGracia); idGracia = null }
  cancelador?.cancel()
  cancelador = null
  if (proceso) {
    try { proceso.send_signal(15) } catch (e) { console.error("[espectro] no se pudo parar cava:", e) }
    proceso = null
  }
  _setConSenal(false)
  _setNiveles(ceros())
}

/**
 * Adquiere el espectro y devuelve su liberación. Idempotente por llamador: liberar dos veces
 * no descuenta dos veces, porque un `onCleanup` que corra tras un cambio de estado no puede
 * dejar el refcount en negativo y matar el proceso de otro monitor.
 */
export function adquirirEspectro(): () => void {
  let liberado = false
  usuarios++
  if (usuarios === 1) arrancar()
  return () => {
    if (liberado) return
    liberado = true
    usuarios--
    if (usuarios === 0) detener()
  }
}
