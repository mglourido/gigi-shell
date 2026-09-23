// servicios/camara/persistencia.ts
//
// Los ajustes de cámara en `~/.config/gigios/camara.json`.
//
// ── POR QUÉ ESTO EXISTE (y no es un capricho) ───────────────────────────────
// Los controles V4L2 NO viven en la cámara: viven en el driver del kernel, en
// la estructura que se crea al registrar el dispositivo. Consecuencia: se van
// al desenchufar la webcam, al suspender con algunos hubs USB, al recargar
// `uvcvideo` y, por supuesto, al reiniciar. Un usuario que ajusta el brillo
// porque su webcam sale oscura tiene que volver a ajustarlo en cada arranque, y
// nada le avisa de que se ha perdido — simplemente vuelve a salir oscura.
//
// Así que se guarda lo que el usuario elige y se REPONE: al iniciar sesión y
// también en cada `add` de udev, que es cuando vuelve a hacer falta.
//
// ── LA CLAVE ES EL APARATO, NO EL NODO ──────────────────────────────────────
// Se indexa por `Camara.clave` (serial, o vendor:product) y NUNCA por
// `/dev/videoN`: ese número lo reparte el kernel por orden de aparición, así que
// enchufar la webcam en otro puerto —o arrancar con una capturadora puesta— la
// renumera y los ajustes de una acabarían aplicados a la otra. Ver `claveDe()`
// en `dispositivos.ts`.
//
// Fuera del repo, como todo el estado de usuario: `~/.config/gigios/` (ver la
// sección "Runtime config & secrets live OUTSIDE the repo" del CLAUDE.md raíz).
import GLib from "gi://GLib"
import { createState } from "ags"
import { camaras, camaraPorClave, type Camara } from "./dispositivos.ts"
import { fijarControles, leerControles } from "./controles.ts"

const RUTA = `${GLib.get_user_config_dir()}/gigios/camara.json`

/** Sube cuando el formato deje de poder leerse tal cual. Hoy solo se escribe;
 *  existe para que el día que haga falta migrar se sepa desde dónde. */
const VERSION = 1

export interface AjustesCamara {
  /** Nombre visto la última vez. Solo para poder enseñar "Logitech C920
   *  (desconectada)" en la lista sin tener el aparato delante. */
  nombre?: string
  /** `nombre del control` → valor. Solo lo que el usuario ha tocado. */
  controles: Record<string, number>
}

export interface EstadoCamara {
  version: number
  /** Clave de la cámara preferida por el usuario. Ver la advertencia en
   *  `camaraPreferida` sobre hasta dónde llega esa preferencia. */
  preferida: string | null
  dispositivos: Record<string, AjustesCamara>
}

const VACIO: EstadoCamara = { version: VERSION, preferida: null, dispositivos: {} }

function leer(): EstadoCamara {
  // AUSENTE NO ES UN ERROR, y distinguirlo importa: `GLib.file_get_contents`
  // **lanza** cuando el fichero no existe (no devuelve `ok = false`, que es lo
  // que parece por la firma). Sin esta comprobación previa, el caso NORMAL de
  // cualquier equipo recién instalado —todavía no se ha guardado ningún ajuste
  // de cámara— entraba por el `catch` y dejaba un `Gjs-Console-CRITICAL` en el
  // log en cada inicio de sesión, anunciando como avería lo que es el estado de
  // fábrica. El `catch` se queda para lo que sí es una avería: un JSON corrupto.
  if (!GLib.file_test(RUTA, GLib.FileTest.EXISTS)) return { ...VACIO }
  try {
    const [ok, bytes] = GLib.file_get_contents(RUTA)
    if (!ok) return { ...VACIO }
    const datos = JSON.parse(new TextDecoder().decode(bytes))
    if (!datos || typeof datos !== "object") return { ...VACIO }
    return {
      version: Number(datos.version) || VERSION,
      preferida: typeof datos.preferida === "string" ? datos.preferida : null,
      dispositivos: datos.dispositivos && typeof datos.dispositivos === "object" ? datos.dispositivos : {},
    }
  } catch (e) {
    // Un JSON corrupto NO puede tumbar el shell ni dejar la cámara sin UI: se
    // degrada al estado vacío, igual que hace el config Lua con sus JSON.
    console.error("[camara] leyendo camara.json:", e)
    return { ...VACIO }
  }
}

export const [estadoCamara, setEstadoCamara] = createState<EstadoCamara>(leer())

function guardar(siguiente: EstadoCamara) {
  setEstadoCamara(siguiente)
  try {
    const directorio = GLib.path_get_dirname(RUTA)
    if (!GLib.file_test(directorio, GLib.FileTest.EXISTS)) GLib.mkdir_with_parents(directorio, 0o755)
    GLib.file_set_contents(RUTA, JSON.stringify(siguiente, null, 2))
  } catch (e) {
    console.error("[camara] guardando camara.json:", e)
  }
}

/** Los ajustes guardados de una cámara (nunca `null`: si no hay, van vacíos). */
export function ajustesDe(clave: string): AjustesCamara {
  return estadoCamara.get().dispositivos[clave] ?? { controles: {} }
}

/** Recuerda UN control. Se llama al soltar el slider, no en cada píxel del
 *  arrastre: escribir el fichero 60 veces por segundo no aporta nada y además
 *  despierta a cualquiera que lo esté monitorizando. */
export function recordarControl(camara: Camara, nombre: string, valor: number) {
  const actual = estadoCamara.get()
  const previos = actual.dispositivos[camara.clave] ?? { controles: {} }
  guardar({
    ...actual,
    dispositivos: {
      ...actual.dispositivos,
      [camara.clave]: {
        nombre: camara.nombre,
        controles: { ...previos.controles, [nombre]: valor },
      },
    },
  })
}

/** Olvida lo guardado de una cámara. Lo usa el botón "Restablecer": si se
 *  devolvieran los controles a los valores de fábrica pero se dejara el fichero
 *  como estaba, el siguiente arranque volvería a imponer los viejos y el botón
 *  parecería no haber servido de nada. */
export function olvidarCamara(clave: string) {
  const actual = estadoCamara.get()
  if (!(clave in actual.dispositivos)) return
  const dispositivos = { ...actual.dispositivos }
  delete dispositivos[clave]
  guardar({ ...actual, dispositivos })
}

/** La cámara preferida del usuario.
 *
 *  ⚠️ Su alcance es ESTE shell: la vista previa, la sección de ajustes y lo que
 *  el indicador nombra por defecto. **No hay ninguna "cámara por defecto" en
 *  Linux** — a diferencia del audio, donde WirePlumber tiene
 *  `default.configured.audio.source`, ni V4L2 ni PipeWire publican nada
 *  equivalente para vídeo, y Firefox, Chrome o Zoom eligen con su propio
 *  selector interno. Prometer en la UI que esto cambia la cámara de una
 *  videollamada sería mentir. */
export function camaraPreferida(): Camara | null {
  return camaraPorClave(estadoCamara.get().preferida) ?? camaras.get()[0] ?? null
}

export function fijarPreferida(clave: string | null) {
  guardar({ ...estadoCamara.get(), preferida: clave })
}

/** Repone en el aparato los controles guardados. Idempotente y silenciosa: si
 *  no hay nada guardado no lanza ni un proceso.
 *
 *  Devuelve los controles ya releídos del aparato, porque "sin error" no
 *  significa "aplicado" (ver `fijarControl` en `controles.ts`). */
export async function restaurarControles(camara: Camara) {
  const guardados = ajustesDe(camara.clave).controles
  if (!Object.keys(guardados).length) return leerControles(camara.nodo)
  await fijarControles(camara.nodo, guardados)
  return leerControles(camara.nodo)
}

/** Repone TODAS las cámaras presentes. Es lo que se llama al arrancar y en cada
 *  hotplug; sin cámaras conocidas no hace absolutamente nada. */
export async function restaurarTodas() {
  for (const camara of camaras.get()) {
    if (Object.keys(ajustesDe(camara.clave).controles).length) {
      await restaurarControles(camara)
    }
  }
}
