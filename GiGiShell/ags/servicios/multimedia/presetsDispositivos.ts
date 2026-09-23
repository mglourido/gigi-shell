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
import { fijarVolumenEndpoint } from "./escrituraVolumen"
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

/** Endpoints ya atendidos, por id de PipeWire, con el manejador para soltarlo en la baja. */
const atendidos = new Map<number, number>()

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
  const preset = audioPresets.get()[clave]
  let hasta = 0
  if (preset !== undefined) {
    fijarVolumenEndpoint(ep, clamp(preset, 0, topeDe(tipo)))
    hasta = Date.now() + ECO_MS
  }

  const manejador = ep.connect("notify::volume", () => {
    if (Date.now() < hasta) return
    recordarPreset(clave, ep.volume)
  })
  atendidos.set(ep.id, manejador)
}

function olvidar(ep: any) {
  const manejador = atendidos.get(ep.id)
  if (manejador === undefined) return
  try { ep.disconnect(manejador) } catch { }
  atendidos.delete(ep.id)
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
