// Volumen por aplicación ("mezcla de aplicaciones" de Quick Settings): el almacén de
// presets y —lo que antes no existía— el vigilante que los APLICA a los streams nuevos.
//
// **El fallo que lo motiva.** Los presets se guardaban bien en `audioPresets.json`, pero
// la única línea que los aplicaba vivía dentro del sondeo `pactl` de `QuickSettings.tsx`,
// y ese sondeo **solo corre con el submenú "Aplicaciones" abierto** (refcount ligado a
// `quickSettingsVisible ∧ qsView ∧ audioMode`). O sea: bajabas Spotify al 57 %, cerrabas
// el panel, reabrías Spotify y sonaba al volumen que trajera la app. El ajuste no se
// perdía —seguía en el JSON—, simplemente no había nadie escuchando cuando aparecía el
// stream. Síntoma exacto reportado: "si edito el volumen en Spotify antes de abrir Quick
// Settings, el cambio de audio no le surte efecto". No es específico de Spotify: le pasa
// a cualquier app que se lance con el panel cerrado.
//
// **Esto es AstalWp, NO `pactl`, y esa fue la segunda versión.** La primera vigilaba con
// un `pactl subscribe` en un subproceso, y funcionaba, pero AstalWp ya publica lo mismo
// nativamente: `audio.streams` / `audio.recorders` (los `Stream/Output|Input/Audio`, o sea
// los sink-inputs y source-outputs de Pulse) con señales `stream-added` / `recorder-added`,
// y cada stream trae `id`, `volume` en la MISMA escala que el `value_percent` de pactl
// (medido: preset 0.20 → `volume` 0.2000000031) y `get_pw_property("application.name")`.
// Cero subprocesos, cero parseo de JSON, cero texto localizable. Lo que se tiró con esa
// primera versión merece quedar escrito porque son trampas reales de aquel camino:
//   - `pactl subscribe` **necesitaba `LC_ALL=C`**: sus mensajes son traducibles y el parseo
//     de "Event 'new' on sink-input #45" dependía del locale.
//   - **El hijo no se moría con AGS.** Gio no mata a los hijos al salir, y el SIGPIPE que
//     normalmente los liquida no llegaba porque ese proceso solo escribe cuando hay un
//     evento: cuatro huérfanos medidos con un solo AGS. Hacía falta un envoltorio `bash`
//     que vigilara el stdin, y dentro de él un `exec 3<&0`, porque POSIX manda redirigir a
//     /dev/null el stdin de todo proceso en segundo plano de un shell sin control de
//     trabajos. Nada de esto existe ya: una señal de GObject no deja huérfanos.
//
// **La corrección tardía.** Una app puede fijar su propio volumen JUSTO DESPUÉS de crear
// el stream (Spotify lo hace: restaura el suyo al conectar). Aplicando solo al aparecer, el
// cliente gana la carrera y el preset vuelve a no verse — mismo síntoma, otra causa. Por
// eso, durante `GRACIA_MS` tras aplicar, se escucha `notify::volume` de ese stream y se
// corrige UNA vez si alguien lo ha pisado. Con `pactl` esto costaba un sondeo extra a los
// 700 ms; aquí es una señal que casi nunca se dispara.
//
// **Se escribe con `fijarVolumenEndpoint`**, no con `stream.volume = v`: el setter de
// AstalWp recorta a 1.5 en silencio y los presets de app llegan al 200 % (ver
// `escrituraVolumen.ts`).
//
// **El preset SIGUE al volumen real (y antes no).** Pasada la gracia el manejador no se
// suelta: cambia de oficio y pasa a ANOTAR lo que el volumen valga. Hasta ahora los presets
// solo se escribían desde los deslizadores de Quick Settings, así que bajar una app desde la
// propia app o desde pavucontrol se respetaba esa sesión y se olvidaba: en la siguiente volvía
// a imponerse el valor viejo del JSON. Solo se anotan claves que YA existen (`recordarPreset`);
// el porqué de esa condición está en esa función, y es lo que impide cambiar un bug por otro.
// La misma regla la aplica `presetsDispositivos.ts` al volumen por dispositivo, que es donde
// el preset rancio salía más caro: acababa copiado a `system_state.json` y repuesto en el
// arranque siguiente.

import GLib from "gi://GLib"
import AstalWp from "gi://AstalWp"
import { createState } from "ags"
import { fijarVolumenEndpoint } from "./escrituraVolumen"

export type TipoMezcla = "speaker" | "mic"

const RUTA_PRESETS = `${GLib.get_user_config_dir()}/gigios/audioPresets.json`

function cargarPresets(): Record<string, number> {
  try {
    const [ok, contenido] = GLib.file_get_contents(RUTA_PRESETS)
    if (ok) return JSON.parse(new TextDecoder().decode(contenido))
  } catch (e) { }
  return {}
}

/** Fuente única de los presets: la UI lee y escribe aquí, el vigilante lee de aquí. */
export const [audioPresets, setAudioPresets] = createState<Record<string, number>>(cargarPresets())

let idGuardado: number | null = null

/** Escritura diferida 2 s: arrastrar el slider dispara decenas de cambios seguidos. */
export function guardarAudioPresets(p: Record<string, number>) {
  if (idGuardado !== null) GLib.source_remove(idGuardado)
  idGuardado = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
    try {
      const dir = GLib.path_get_dirname(RUTA_PRESETS)
      if (!GLib.file_test(dir, GLib.FileTest.EXISTS)) GLib.mkdir_with_parents(dir, 0o700)
      GLib.file_set_contents(RUTA_PRESETS, JSON.stringify(p))
    } catch (e) { }
    idGuardado = null
    return GLib.SOURCE_REMOVE
  })
}

/**
 * Anota en el preset el volumen REAL de algo que ya tenía preset. Es la mitad que faltaba:
 * hasta ahora los presets solo se escribían desde los deslizadores de Quick Settings, así que
 * un volumen puesto por cualquier otra vía (la propia app, pavucontrol, las teclas de volumen,
 * `wpctl`) dejaba el preset RANCIO — y como el preset se sigue aplicando al aparecer el
 * stream, el valor viejo volvía a imponerse en la sesión siguiente. Con esto no puede quedar
 * rancio, así que aplicarlo no puede pisar nada.
 *
 * **Solo toca claves que YA existen, y esa condición es la que evita cambiar de bug.** Anotar
 * también las que no existen convertiría cada app que suena una vez en un preset con el
 * volumen que ella trajera, que a partir de entonces se le IMPONDRÍA en cada arranque: el
 * mismo pisotón que se quiere quitar, con otro origen. La clave la crea el deslizador de Quick
 * Settings —o sea, una decisión explícita del usuario— y a partir de ahí esto la mantiene al
 * día. Lo comparten el vigilante de apps de este módulo y el de dispositivos
 * (`presetsDispositivos.ts`).
 *
 * La tolerancia de 1 punto es la misma que la de la corrección tardía y por el mismo motivo:
 * la curva cúbica de PipeWire no devuelve el valor exacto que se escribió (medido: 0,20 →
 * 0,2000000031), y sin ella el fichero se reescribiría en cada eco.
 */
export function recordarPreset(clave: string, valor: number) {
  const actual = audioPresets.get()
  const guardado = actual[clave]
  if (guardado === undefined) return
  if (!Number.isFinite(valor)) return
  if (Math.abs(guardado - valor) <= 0.01) return
  const p = { ...actual, [clave]: valor }
  setAudioPresets(p)
  guardarAudioPresets(p)
}

/**
 * Propiedades de PipeWire que identifican a una app. Las lee tanto el vigilante (de un
 * `AstalWp.Stream`) como la fila de Quick Settings, y de ahí salen la clave del preset y
 * —vía `identidadApps.ts`— el nombre y el icono que se enseñan.
 */
export const CLAVES_PW = [
  "application.id", "application.process.binary", "application.name",
  "node.name", "media.name", "application.icon_name", "window.icon_name",
  // El PID es lo único que casa un stream con SU ventana de Hyprland sin comparar
  // nombres: es lo que permite darle a un juego el icono que ya sabe resolver el
  // registro de juegos (ver `presentacionApps.ts`).
  "application.process.id",
]

/** Las props de un stream de AstalWp, en el formato plano que espera todo lo demás. */
export function propsDeStream(stream: any): Record<string, any> {
  const props: Record<string, any> = {}
  for (const clave of CLAVES_PW) {
    let valor: any = null
    try { valor = stream.get_pw_property(clave) } catch { valor = null }
    if (valor) props[clave] = valor
  }
  return props
}

/**
 * Nombre crudo de la app: la CLAVE del preset. **Una sola implementación a propósito.** La
 * fila de la UI y el vigilante tienen que llegar a la misma cadena; si divergen, la fila
 * guarda el preset bajo una clave que el vigilante nunca busca y el ajuste deja de
 * aplicarse sin un solo error — ya pasó una vez entre `mic:` y `app:mic:`.
 */
export function nombreDeProps(props: Record<string, any> | null | undefined): string {
  const p = props || {}
  return p["application.name"] || p["node.name"] || p["media.name"]
    || p["application.process.binary"] || "App"
}

/** Clave del preset. La comparte la UI: cambiarla aquí invalidaría los JSON existentes. */
export function clavePreset(tipo: TipoMezcla, nombre: string): string {
  return `app:${tipo === "speaker" ? "spk" : "mic"}:${nombre.toLowerCase()}`
}

// Ids de stream ya atendidos, por tipo. Son ids globales de PipeWire (los de AstalWp), no
// los índices de Pulse: el mismo espacio de nombres que usan las señales, así que un stream
// no puede contarse dos veces. Se limpian en `stream-removed`, que es exacto — con los
// índices de Pulse había que podar contra la lista viva porque PulseAudio los recicla.
const atendidos: Record<TipoMezcla, Set<number>> = { speaker: new Set(), mic: new Set() }

/** Manejador de `notify::volume` vivo por stream, para soltarlo en `stream-removed`. */
const manejadores: Record<TipoMezcla, Map<number, number>> = { speaker: new Map(), mic: new Map() }

/** Ventana en la que se vigila que el cliente no pise el preset recién aplicado. */
const GRACIA_MS = 1500

function audio(): AstalWp.Audio | null {
  try { return AstalWp.get_default()?.audio ?? null } catch { return null }
}

const listaViva = (tipo: TipoMezcla, a: AstalWp.Audio) =>
  tipo === "speaker" ? a.get_streams() : a.get_recorders()

/**
 * Aplica el preset a un stream recién aparecido y vigila `GRACIA_MS` por si el cliente
 * pisa el valor justo después (Spotify lo hace). **Corrige durante TODA la ventana, no una
 * sola vez**, y esa distinción es el bug que costó una ronda: al llegar `stream-added` el
 * `volume` del stream todavía es `0` y el valor de verdad llega en una notificación
 * posterior (medido: `added vol=0` → `notify::volume 1` → …), así que una corrección única
 * se la comía esa notificación de inicialización y el pisotón real, unos cientos de ms más
 * tarde, ya no tenía a nadie escuchando. Pasada la gracia se desengancha del todo: el
 * usuario tiene que poder bajar el volumen desde la propia app sin que esto se lo devuelva.
 */
function atender(tipo: TipoMezcla, stream: any) {
  const vistos = atendidos[tipo]
  if (vistos.has(stream.id)) return
  vistos.add(stream.id)

  const clave = clavePreset(tipo, nombreDeProps(propsDeStream(stream)))
  const preset = audioPresets.get()[clave]

  if (preset !== undefined) fijarVolumenEndpoint(stream, preset)

  // El manejador se engancha AUNQUE no haya preset, y no sobra: la clave la crea el
  // deslizador de Quick Settings a mitad de la vida del stream, y sin estar ya escuchando no
  // habría nadie para anotar los cambios posteriores hasta el siguiente arranque de la app.
  // Sin preset, `recordarPreset` es un no-op hasta que la clave exista.
  //
  // Pasada la gracia el manejador NO se suelta: cambia de oficio. Deja de corregir —bajar el
  // volumen desde la propia app tiene que funcionar— y pasa a ANOTAR, que es lo que impide
  // que el preset se quede rancio y vuelva a imponer el valor viejo en el arranque siguiente.
  let enGracia = preset !== undefined
  const manejador: number = stream.connect("notify::volume", () => {
    if (!enGracia) { recordarPreset(clave, stream.volume); return }
    // Tolerancia de 1 punto: la curva cúbica de PipeWire no devuelve el valor exacto que
    // se escribió (medido: 0.20 → 0.2000000031). Sin ella esto se re-dispararía a sí mismo.
    if (Math.abs(stream.volume - preset!) <= 0.01) return
    fijarVolumenEndpoint(stream, preset!)
  })
  manejadores[tipo].set(stream.id, manejador)
  if (enGracia) {
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, GRACIA_MS, () => {
      enGracia = false
      return GLib.SOURCE_REMOVE
    })
  }
}

/** Se sueltan en `stream-removed`: el manejador vive ahora toda la vida del stream. */
function olvidar(tipo: TipoMezcla, stream: any) {
  atendidos[tipo].delete(stream.id)
  const manejador = manejadores[tipo].get(stream.id)
  if (manejador === undefined) return
  try { stream.disconnect(manejador) } catch { }
  manejadores[tipo].delete(stream.id)
}

let iniciado = false

/**
 * Arranca el vigilante. Se llama una vez desde `app.ts`. El barrido inicial atiende a lo
 * que ya estuviera sonando cuando arrancó el shell (un `hyprctl reload` con Spotify
 * abierto, por ejemplo); a partir de ahí manda la señal.
 */
export function initPresetsApps() {
  if (iniciado) return
  iniciado = true
  const a = audio()
  if (!a) { console.error("[presetsApps] AstalWp no disponible: los presets por app no se aplicarán"); return }

  const enganchar = (tipo: TipoMezcla, senalAlta: string, senalBaja: string) => {
    for (const stream of listaViva(tipo, a)) atender(tipo, stream)
    a.connect(senalAlta, (_a: any, stream: any) => atender(tipo, stream))
    a.connect(senalBaja, (_a: any, stream: any) => olvidar(tipo, stream))
  }
  enganchar("speaker", "stream-added", "stream-removed")
  enganchar("mic", "recorder-added", "recorder-removed")
}
