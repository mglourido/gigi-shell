// servicios/multimedia/capturasMicrofono.ts
//
// Quién está usando el MICRÓFONO — que NO es lo mismo que `audio.recorders`.
//
// ── El fallo que originó este módulo ─────────────────────────────────────────
// El indicador de micro de la barra se encendía al **dar a play en Spotify**.
// No había ningún micro abierto: `audio.recorders` son todos los nodos
// `Stream/Input/Audio` de PipeWire, y "entrada de audio" incluye capturar el
// MONITOR de un altavoz o la salida de otra aplicación. Medido con Spotify
// reproduciendo (`wpctl status`):
//
//   cava            input_FL < SIMGOT EW300 DSP:monitor_FL   ← el monitor del sink
//   discord_capture input_FL < spotify:output_FL             ← la salida de Spotify
//   WEBRTC VoiceEngine input_MONO < SIMGOT EW300 DSP:capture_MONO  ← el micro DE VERDAD
//
// Los tres son `Stream/Input/Audio` y los tres llegaban como "alguien graba".
// Y `cava` es **nuestro propio proceso**: `servicios/multimedia/espectro.ts` lo
// lanza para la onda de la barra en cuanto Spotify reproduce, así que el shell
// se estaba delatando a sí mismo — de ahí que el bug pareciera "Spotify usa el
// micro".
//
// ── Se clasifica solo, con DOS campos del propio stream ──────────────────────
// No hace falta ir apuntando apps a mano: PipeWire ya etiqueta lo que es cada
// captura, y `pactl -f json list source-outputs` lo entrega junto. Medido con
// los tres casos vivos:
//
//   node.name            source        stream.capture.sink
//   WEBRTC VoiceEngine   60            —                    → micrófono
//   cava                 59            true                 → el MONITOR de un altavoz
//   discord_capture      4294967295    —                    → enganchado a otro stream
//
// `stream.capture.sink` la pone el propio PipeWire a todo lo que graba la salida
// de un altavoz, tanto por la API nativa (cava) como por la de PulseAudio
// (comprobado con `parec -d <sink>.monitor`, que es como graba OBS). Y
// `4294967295` es `PA_INVALID_INDEX`: el stream no cuelga de ninguna fuente
// porque va unido nodo a nodo a la salida de otra app. Ninguno es el micro.
//
// La lista manual (`microfonoAppsIgnoradas`) queda solo como escotilla para lo
// que esto no cace; el caso normal no la necesita.
//
// ── Por qué `pactl` y no leer el nodo desde el propio proceso ────────────────
// Sería mejor, y no se puede: AstalWp expone `Endpoint.description`, `.serial` y
// poco más — la propiedad `node` (el `WpNode` de debajo) está marcada
// `introspectable="0"` en el GIR, así que desde GJS no hay props que leer. La
// otra vía sería abrir una conexión propia a WirePlumber con `gi://Wp` (existe
// `Wp-0.5.typelib`), pero **medido: `Wp.Core.connect_()` desde gjs mata el
// proceso** (sale con rc=1 sin ni un mensaje). Eso, dentro del shell, es la
// barra entera cayéndose. `pactl` es un proceso corto, ya lo usa QuickSettings
// para los clientes en silencio, y solo se lanza cuando aparece una captura
// que no conocemos (ver `origenCapturas.ts`).
//
// Este fichero es lógica pura (sin GTK ni subprocesos, con test); quien lanza
// `pactl` y publica el resultado es `servicios/multimedia/origenCapturas.ts`.

/** Lo mínimo que este módulo necesita de un `AstalWp.Endpoint`. */
export type CapturaAudio = { name: string | null; description: string | null; serial: number }

/** De dónde saca el audio una captura. `sistema` = no es un micrófono. */
export type OrigenCaptura = "microfono" | "sistema"

/** `PA_INVALID_INDEX`: el stream no está enganchado a ninguna fuente. */
export const FUENTE_INVALIDA = 4294967295

/**
 * Capturas que no cuentan NUNCA, al margen de la clasificación y de la lista
 * del usuario.
 *
 * Solo `cava`, y solo porque es un proceso del propio shell (`espectro.ts`).
 * No es una excepción cosmética: al conocer su veredicto de antemano, el caso
 * que originó el bug —dar a play en Spotify— **no lanza ni un subproceso** y no
 * puede hacer parpadear el icono mientras `pactl` contesta.
 */
export const CAPTURAS_IGNORADAS_SIEMPRE = ["cava"]

/**
 * Identidad de una captura. `description` es el `node.name` del stream
 * ("cava", "discord_capture", "WEBRTC VoiceEngine"); `name` es su `media.name`
 * ("recStream", "game capture"), que es descripción del momento, no identidad.
 * Se conserva tal cual, sin normalizar a minúsculas: un `node.name` distingue
 * mayúsculas (mismo criterio que `audioDispositivosOcultos`).
 */
export function claveCaptura(captura: CapturaAudio): string {
  return (captura.description ?? captura.name ?? "").trim()
}

/** Etiqueta para la UI: el `media.name`, si aporta algo más que la identidad. */
export function detalleCaptura(captura: CapturaAudio): string {
  const nombre = (captura.name ?? "").trim()
  const clave = claveCaptura(captura)
  return nombre && nombre !== clave ? nombre : ""
}

/** ¿Se ignora sin preguntar a nadie? (nuestro propio cava) */
export function ignoradaSiempre(captura: CapturaAudio): boolean {
  return CAPTURAS_IGNORADAS_SIEMPRE.includes(claveCaptura(captura))
}

/**
 * `pactl -f json list source-outputs` → `object.serial` : origen.
 *
 * El `index` de un source-output **es** el `object.serial` del nodo, que es lo
 * que AstalWp publica como `endpoint.serial`: el emparejamiento es exacto y no
 * hay que adivinar por nombre. Una entrada que no se pueda leer se omite, y
 * quien la consulte la tratará como desconocida.
 */
export function clasificarCapturas(json: string): Map<number, OrigenCaptura> {
  const origenes = new Map<number, OrigenCaptura>()
  const datos = JSON.parse(json)
  if (!Array.isArray(datos)) return origenes
  for (const salida of datos) {
    const serial = Number(salida?.index)
    if (!Number.isFinite(serial)) continue
    // Las propiedades de PipeWire llegan como CADENAS, también los booleanos.
    const grabaAltavoz = salida?.properties?.["stream.capture.sink"] === "true"
    const fuente = Number(salida?.source)
    const sinFuente = !Number.isFinite(fuente) || fuente === FUENTE_INVALIDA
    origenes.set(serial, grabaAltavoz || sinFuente ? "sistema" : "microfono")
  }
  return origenes
}

/**
 * Qué hacer con una captura que aún no está clasificada.
 *
 * `cuenta` es el fail-safe y el estado de reposo: sin `pactl`, o con la
 * clasificación fallando, el indicador se comporta como si no existiera —
 * callar un micro abierto es el único fallo inaceptable aquí.
 *
 * `espera` es para el rato (~50 ms) en el que la consulta está EN VUELO: ahí lo
 * desconocido está a punto de resolverse, y contarlo hace **parpadear** el aviso
 * de micrófono cada vez que arranca una captura de sistema.
 */
export type ModoSinClasificar = "cuenta" | "espera"

/** ¿Esta captura es uso del micrófono? */
export function esUsoDeMicrofono(
  captura: CapturaAudio,
  ignoradas: string[],
  origenes: Map<number, OrigenCaptura>,
  sinClasificar: ModoSinClasificar = "cuenta",
): boolean {
  const clave = claveCaptura(captura)
  // Un stream sin identidad no se puede apartar desde la UI, pero sí clasificar.
  if (clave !== "" && (ignoradaSiempre(captura) || ignoradas.includes(clave))) return false
  const origen = origenes.get(captura.serial)
  if (origen === undefined) return sinClasificar === "cuenta"
  return origen !== "sistema"
}

/** ¿Hay alguna app usando el micrófono de verdad? */
export function hayUsoDeMicrofono(
  recorders: CapturaAudio[] | null,
  ignoradas: string[],
  origenes: Map<number, OrigenCaptura>,
  sinClasificar: ModoSinClasificar = "cuenta",
): boolean {
  return (recorders ?? []).some((c) => esUsoDeMicrofono(c, ignoradas, origenes, sinClasificar))
}

/**
 * Capturas cuyo origen todavía no se conoce. Las que se ignoran siempre no
 * cuentan: preguntar por ellas sería lanzar un `pactl` para nada.
 */
export function capturasSinClasificar(
  recorders: CapturaAudio[] | null,
  origenes: Map<number, OrigenCaptura>,
): CapturaAudio[] {
  return (recorders ?? []).filter((c) => !origenes.has(c.serial) && !ignoradaSiempre(c))
}

/** ¿Dos clasificaciones dicen lo mismo? Evita publicar un mapa nuevo idéntico. */
export function mismosOrigenes(
  a: Map<number, OrigenCaptura>,
  b: Map<number, OrigenCaptura>,
): boolean {
  if (a.size !== b.size) return false
  for (const [serial, origen] of a) if (b.get(serial) !== origen) return false
  return true
}
