// Volumen por DISPOSITIVO de audio (las tarjetas de "Volumen" y "Micrófono" de Quick
// Settings): quién aplica el preset guardado y —lo que no existía— quién lo mantiene al día.
//
// **El fallo que lo motiva: un preset que solo se ESCRIBÍA desde el deslizador.** Las claves
// `dev:spk:<aparato>` / `dev:mic:<aparato>` de `audioPresets.json` nacían y se actualizaban en
// un único sitio, los dos manejadores del deslizador de Quick Settings (arrastre y casilla del
// número). Pero se APLICABAN al construirse las filas del submenú de audio, una vez por sesión.
// O sea que cualquier volumen puesto por otra vía —las teclas de volumen de Hyprland, la rueda
// sobre la pastilla de la barra, `wpctl`, pavucontrol— actualizaba el sonido pero **no** el
// preset, que se quedaba con lo que el deslizador dejó allí semanas atrás. La primera vez que
// se dibujaba la tarjeta, ese valor rancio se escribía encima del volumen vivo y el sonido
// pegaba un salto.
//
// Y el salto no se quedaba en la sesión: el `notify::volume` del altavoz por defecto alimenta
// `guardarEstadoSistema` (`QuickSettings.tsx`), que lo copia a `system_state.json`, que es lo
// que `inicializador/init.sh` repone en el arranque siguiente. Síntoma exacto reportado: *"si
// lo dejo en 50 % cuando vuelvo puede estar en 80 %"*, junto con *"parece solo afectar cuando
// abro esa sección"*. Silencioso de manual: ningún error, y tres almacenes del mismo número
// (WirePlumber en `default-routes`, `system_state.json` y este preset) de los cuales solo uno
// se quedaba atrás.
//
// **La regla que lo arregla: el preset SIGUE al volumen real.** Aquí se escucha
// `notify::volume` de cada endpoint y se anota el valor vivo, venga de donde venga. Con eso el
// preset no puede quedar rancio, así que aplicarlo ya no puede pisar nada.
//
// **Solo se sincroniza lo que YA existe** (`recordarPreset` sale si la clave no está). Un
// aparato sin preset es un aparato del que el usuario no ha dicho nada: ahí manda WirePlumber,
// que guarda el volumen por ruta en `~/.local/state/wireplumber/default-routes` y lo repone él
// solo. La clave la crea el deslizador de Quick Settings, y a partir de ese momento esto la
// mantiene al día. Sin esa condición, cada aparato enumerado estrenaría un preset con el
// volumen que trajera y pasaríamos a IMPONERLO en cada arranque — justo el pisotón que se
// quiere quitar, con otro origen.
//
// **Se aplica cuando el aparato APARECE, no cuando se mira la lista.** Es la otra mitad del
// arreglo y arregla de paso un hueco: unos cascos USB enchufados a mitad de sesión no
// recuperaban su volumen hasta que abrías el submenú.

import AstalWp from "gi://AstalWp"
import { audioPresets, recordarPreset, type TipoMezcla } from "./presetsApps"
import { aplicarAlInicializar, olvidarEndpoint } from "./escrituraVolumen"
import { VOLUMEN_MAX } from "./volumenAmplificado"
import { crudoDesdePorcentajeMic } from "./volumenMicrofono"

/**
 * Identidad estable de un endpoint para el preset. **Una sola implementación a propósito**,
 * igual que `clavePreset` para las apps: la comparte la fila de Quick Settings, y si las dos
 * divergieran la fila guardaría bajo una clave que esto no busca nunca.
 *
 * `ep.name` viene a null en el perfil ALSA clásico (medido en esta máquina: los cuatro
 * altavoces y los dos micros con `name = null`), y sin el respaldo la clave colapsaba
 * literalmente a `dev:spk:null` para todos.
 */
export function claveDispositivo(tipo: TipoMezcla, ep: any): string {
  const estable = ep.name || ep.description || `id:${ep.id}`
  return `dev:${tipo === "speaker" ? "spk" : "mic"}:${estable}`
}

/** Tope por tipo, en la escala CRUDA de PipeWire (el micro tiene la suya; ver su módulo). */
function topeDe(tipo: TipoMezcla): number {
  return tipo === "speaker" ? VOLUMEN_MAX : crudoDesdePorcentajeMic(VOLUMEN_MAX * 100)
}

function clamp(v: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, v)) }

/**
 * Endpoints ya atendidos, por id de PipeWire, con lo que hay que soltar en la baja: el
 * manejador que anota y, si la restauración sigue en curso, su cancelación.
 */
type Atendido = { manejador: number; cancelar: (() => void) | null }
const atendidos = new Map<number, Atendido>()

/**
 * Ventana en la que NO se anota lo que llegue: es el eco de nuestra propia escritura de
 * restauración, que vuelve como `notify::volume` unos ms después. Anotarlo sería inocuo
 * (mismo valor) salvo por el redondeo de la curva cúbica de PipeWire, que devuelve
 * 0.2000000031 donde se escribió 0.20 y dejaría el fichero reescribiéndose sin motivo.
 */
const ECO_MS = 400

function atender(tipo: TipoMezcla, ep: any) {
  if (atendidos.has(ep.id)) return

  const clave = claveDispositivo(tipo, ep)
  const reg: Atendido = { manejador: 0, cancelar: null }
  let hasta = 0

  // NO se escribe aquí: un aparato recién aparecido aún no acepta escrituras (ver
  // `aplicarAlInicializar`). Antes se escribía en el acto y fallaba mudo: con `volume = 0`
  // la escritura era un no-op con aviso de AstalWp (issue #322), y la ventana de eco
  // abierta a continuación se tragaba el `notify::volume` real que llegaba ~1 ms después —
  // o sea que unos cascos USB o Bluetooth conectados a mitad de sesión NUNCA recibían su
  // preset. Mientras dure la restauración no se anota nada: lo que llegue son los valores
  // de inicialización y los ecos de nuestra propia escritura, no decisiones del usuario.
  if (audioPresets.get()[clave] !== undefined) {
    reg.cancelar = aplicarAlInicializar(ep, () => {
      const preset = audioPresets.get()[clave]
      return preset === undefined ? undefined : clamp(preset, 0, topeDe(tipo))
    }, {
      alEscribir: () => { hasta = Date.now() + ECO_MS },
      alTerminar: () => { reg.cancelar = null },
    })
  }

  reg.manejador = ep.connect("notify::volume", () => {
    if (reg.cancelar !== null || Date.now() < hasta) return
    recordarPreset(clave, ep.volume)
  })
  atendidos.set(ep.id, reg)
}

function olvidar(ep: any) {
  const reg = atendidos.get(ep.id)
  if (reg === undefined) return
  try { ep.disconnect(reg.manejador) } catch { }
  reg.cancelar?.()
  atendidos.delete(ep.id)
  olvidarEndpoint(ep.id)
}

let iniciado = false

/**
 * Arranca el vigilante. Se llama una vez desde `app.ts`. El barrido inicial cubre lo que ya
 * estuviera enumerado; a partir de ahí mandan las señales de alta y baja de AstalWp.
 */
export function initPresetsDispositivos() {
  if (iniciado) return
  iniciado = true

  let audio: AstalWp.Audio | null = null
  try { audio = AstalWp.get_default()?.audio ?? null } catch { audio = null }
  if (!audio) {
    console.error("[presetsDispositivos] AstalWp no disponible: los presets por dispositivo no se aplicarán")
    return
  }

  const enganchar = (tipo: TipoMezcla, vivos: any[], alta: string, baja: string) => {
    for (const ep of vivos) atender(tipo, ep)
    audio!.connect(alta, (_a: any, ep: any) => atender(tipo, ep))
    audio!.connect(baja, (_a: any, ep: any) => olvidar(ep))
  }
  enganchar("speaker", audio.get_speakers(), "speaker-added", "speaker-removed")
  enganchar("mic", audio.get_microphones(), "microphone-added", "microphone-removed")
}
