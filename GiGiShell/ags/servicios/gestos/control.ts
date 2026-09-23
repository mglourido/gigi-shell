// servicios/gestos/control.ts
//
// Encender/apagar el modo gestos y guardar sus ajustes.
//
// AGS no habla con la cámara ni con el demonio: todo pasa por
// `hypr/scripts/gestos.sh`, que es también quien responde al atajo SUPER+SHIFT+G. Que
// el panel y el teclado usen exactamente el mismo camino es lo que hace que no
// puedan discrepar — la alternativa (que AGS lance el demonio por su cuenta)
// dejaría dos formas de encenderlo con dos ideas distintas de si ya estaba
// encendido.
//
// ── LOS AJUSTES NO SE APLICAN EN CALIENTE: EL DEMONIO SE REINICIA ────────────
// `gestos.py` lee `gestos.json` UNA vez, al arrancar. Recargarlo en vivo
// obligaría a vigilar el fichero desde el bucle de inferencia y a rehacer la
// máquina de estados a mitad de un gesto. Como el modo se enciende a ratos y
// arrancar cuesta ~1 s (0,11 s del modelo y el resto de abrir la cámara), sale
// mucho más barato reiniciarlo: `guardar()` lo hace solo si estaba activo. Es
// el mismo trato que `screencast-monitor`/`updates-monitor` con sus
// interruptores (pkill + relanzar), solo que aquí lo encapsula el script.
import { createState } from "ags"
import { execAsync } from "ags/process"
import GLib from "gi://GLib"
import { gestos } from "./estado.ts"

const RUTA = `${GLib.get_user_config_dir()}/gigios/gestos.json`
const GUION = `${GLib.get_home_dir()}/.config/hypr/scripts/gestos.sh`
const VENV = `${GLib.get_user_data_dir()}/gigios/gestos/venv/bin/python`
const MODELO = `${GLib.get_user_data_dir()}/gigios/gestos/hand_landmarker.task`

/** 1 → 2: el ritmo por defecto pasó de 15 a 30 fps. La cámara entrega 29,6
 *  reales, así que a 15 se tiraba uno de cada dos frames — y el que se tiraba
 *  podía ser el único nítido de un gesto rápido. */
const VERSION = 2
const FPS_VIEJO_POR_DEFECTO = 15

export interface ConfigGestos {
  version: number
  /** Mano abierta desplazándose → cambiar de escritorio. */
  swipe: boolean
  /** Pulgar + índice → agarrar y mover la ventana activa. */
  pellizco: boolean
  /** Puño cerrado → pausa mientras lo mantengas. */
  puno: boolean
  /** Abrir y cerrar la mano dos veces → pausa LARGA (modo de espera), hasta
   *  repetir el mismo gesto. No apaga la cámara: solo deja de obedecer. */
  espera: boolean
  /** Dos pellizcos rápidos → la ventana entra o sale del mosaico (flip-flop).
   *  El arrastre que sigue se adapta solo al modo nuevo. */
  dobleFlotar: boolean
  /** Recorrido horizontal mínimo, en fracción del ancho del cuadro. MENOR =
   *  más sensible. El demonio lo acota a 0,08..0,45. */
  sensibilidad: number
  /** Tiempo muerto tras un cambio de escritorio, antes de admitir el siguiente
   *  (0,20..1,00 s). Es el mando del compromiso: bajarlo permite encadenar
   *  gestos más deprisa, subirlo evita que el gesto de volver la mano a su
   *  sitio deshaga el que acabas de hacer. */
  cooldown: number
  /** Recorrido de la mano que recoloca la ventana UN hueco en el mosaico
   *  (0,05..0,30 del ancho del cuadro). Menor = la ventana salta antes. */
  paso: number
  /** Amplificación del movimiento al arrastrar, **solo para una ventana que ya
   *  estaba flotando** (0,5..4). Una en mosaico no se mueve a coordenadas: se
   *  recoloca por pasos y este número no la afecta. */
  ganancia: number
  /** Frames por segundo del bucle (5..30). Es el mando de consumo. Medido con
   *  el proceso ya en régimen (una medida temprana daba 129%, pero incluía la
   *  carga del modelo): a 1280x720, **15 fps = ~50% de un núcleo** y 5 fps
   *  —el bajón automático sin mano delante— = ~24%. */
  fps: number
  /** `/dev/videoN` concreto, o `null` para la primera cámara de captura. */
  nodo: string | null
}

const FABRICA: ConfigGestos = {
  version: VERSION,
  swipe: true,
  pellizco: true,
  puno: true,
  espera: true,
  dobleFlotar: true,
  sensibilidad: 0.2,
  cooldown: 0.55,
  paso: 0.11,
  ganancia: 1.8,
  fps: 30,
  nodo: null,
}

/** Sube el ritmo a los ficheros escritos antes de la versión 2, PERO solo si
 *  llevaban el valor de fábrica de entonces: quien hubiera bajado el ritmo a
 *  propósito (por batería) lo hizo por un motivo, y subírselo por la espalda
 *  sería exactamente el tipo de cambio silencioso que este repo evita. */
function migrarFps(datos: any): unknown {
  const version = Number(datos?.version) || 1
  if (version < 2 && datos?.fps === FPS_VIEJO_POR_DEFECTO) return FABRICA.fps
  return datos?.fps
}

function leer(): ConfigGestos {
  if (!GLib.file_test(RUTA, GLib.FileTest.EXISTS)) return { ...FABRICA }
  try {
    const [ok, bytes] = GLib.file_get_contents(RUTA)
    if (!ok) return { ...FABRICA }
    const datos = JSON.parse(new TextDecoder().decode(bytes))
    if (!datos || typeof datos !== "object") return { ...FABRICA }
    const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d)
    const num = (v: unknown, d: number, min: number, max: number) =>
      typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : d
    return {
      version: Number(datos.version) || VERSION,
      swipe: bool(datos.swipe, FABRICA.swipe),
      pellizco: bool(datos.pellizco, FABRICA.pellizco),
      puno: bool(datos.puno, FABRICA.puno),
      espera: bool(datos.espera, FABRICA.espera),
      dobleFlotar: bool(datos.dobleFlotar, FABRICA.dobleFlotar),
      sensibilidad: num(datos.sensibilidad, FABRICA.sensibilidad, 0.08, 0.45),
      cooldown: num(datos.cooldown, FABRICA.cooldown, 0.2, 1),
      paso: num(datos.paso, FABRICA.paso, 0.05, 0.3),
      ganancia: num(datos.ganancia, FABRICA.ganancia, 0.5, 4),
      fps: Math.round(num(migrarFps(datos), FABRICA.fps, 5, 30)),
      nodo: typeof datos.nodo === "string" && datos.nodo ? datos.nodo : null,
    }
  } catch (e) {
    console.error("[gestos] config:", e)
    return { ...FABRICA }
  }
}

export const [configGestos, setConfigGestos] = createState<ConfigGestos>(leer())

/** Hay entorno instalado, o sea que el modo puede llegar a arrancar. Sin esto,
 *  Ajustes enseñaría un interruptor que solo sabe fallar. */
export const [gestosDisponibles, setGestosDisponibles] = createState(
  GLib.file_test(VENV, GLib.FileTest.IS_EXECUTABLE) && GLib.file_test(MODELO, GLib.FileTest.EXISTS),
)

/** Una orden en vuelo: el interruptor se deshabilita mientras dura. Encender
 *  tarda ~1 s (abrir la cámara) y dos pulsaciones seguidas se pisarían. */
export const [gestosOcupado, setGestosOcupado] = createState(false)

export function refrescarDisponibilidad() {
  setGestosDisponibles(
    GLib.file_test(VENV, GLib.FileTest.IS_EXECUTABLE) &&
    GLib.file_test(MODELO, GLib.FileTest.EXISTS),
  )
}

async function ejecutar(verbo: "on" | "off") {
  setGestosOcupado(true)
  try {
    await execAsync([GUION, verbo])
  } catch (e) {
    // `gestos.sh` sale con código distinto de 0 cuando el modo NO llegó a
    // levantarse (cámara ocupada, bloqueada, falta el modelo). No es una
    // excepción que haya que propagar: el motivo ya está publicado en
    // `gestos-estado.json` y la UI lo va a leer de ahí, que es la única fuente
    // que también refleja lo que pasó al encenderlo con SUPER+SHIFT+G.
    console.debug("[gestos]", verbo, e)
  } finally {
    setGestosOcupado(false)
  }
}

export async function fijarGestos(activo: boolean) {
  await ejecutar(activo ? "on" : "off")
}

export function alternarGestos() {
  void fijarGestos(!gestos.get().activo)
}

/** Guarda y, si el modo estaba encendido, lo reinicia para que los valores
 *  nuevos surtan efecto. Ver la cabecera. */
export async function guardar(cambios: Partial<ConfigGestos>) {
  const siguiente: ConfigGestos = { ...configGestos.get(), ...cambios, version: VERSION }
  setConfigGestos(siguiente)
  try {
    const directorio = GLib.path_get_dirname(RUTA)
    if (!GLib.file_test(directorio, GLib.FileTest.IS_DIR)) GLib.mkdir_with_parents(directorio, 0o755)
    GLib.file_set_contents(RUTA, JSON.stringify(siguiente, null, 2))
  } catch (e) {
    console.error("[gestos] guardar:", e)
    return
  }
  if (gestos.get().activo) {
    await ejecutar("off")
    await ejecutar("on")
  }
}
