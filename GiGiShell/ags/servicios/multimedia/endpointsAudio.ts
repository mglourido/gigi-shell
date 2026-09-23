/** Qué endpoints de audio merecen salir en una lista, y cuál es su etiqueta.
 *
 * Puro y sin GTK ni AstalWp a propósito: se prueba con `node --test`. Los
 * consumidores (Quick Settings) traducen sus `AstalWp.Endpoint` a `InfoEndpoint`
 * antes de llamar aquí.
 *
 * ── Por qué hay endpoints que no deberían verse ──────────────────────────────
 *
 * PipeWire publica un nodo por cada *perfil activo* de cada tarjeta, esté o no
 * enchufado nada a la otra punta del cable. En esta máquina eso significa tres
 * salidas y dos entradas para UN solo dispositivo real (unos cascos USB):
 *
 *   - `alsa_output.pci-…hdmi-stereo`     ← HDMI de la GPU (el monitor no tiene altavoces)
 *   - `alsa_output.usb-…analog-stereo`   ← los cascos, lo único que suena
 *   - `alsa_output.pci-…iec958-stereo`   ← S/PDIF de la placa, sin cable óptico
 *   - `alsa_input.usb-…mono-fallback`    ← el micro de los cascos
 *   - `alsa_input.pci-…analog-stereo`    ← entrada analógica de la placa, sin nada en ningún jack
 *
 * La ÚLTIMA es demostrablemente inútil y el hardware lo dice: ALSA marca sus
 * puertos (micrófono frontal, trasero y línea de entrada) como `not available`,
 * o sea que la detección de jack no ve nada conectado. Eso llega a AstalWp como
 * `route.available == AstalWp.Available.NO` y es lo que mira `esEndpointMuerto`.
 *
 * Las dos digitales NO son detectables así, y conviene saber por qué antes de
 * intentarlo: el S/PDIF **no tiene detección de jack** (su disponibilidad es
 * siempre `UNKNOWN`), y el HDMI está literalmente `available` porque el monitor
 * está conectado y su ELD anuncia que acepta audio — que no tenga altavoces no
 * es algo que el ordenador pueda saber. Para esas manda el usuario: clic derecho
 * sobre la tarjeta la aparta, y reaparece plegada en "Ocultos" para devolverla.
 *
 * Hubo un intento anterior de resolverlo automáticamente —un interruptor global
 * que escondía TODO lo que casara con `esSalidaDigital`— y se retiró: acertaba
 * en esta máquina por casualidad, pero es una regla por clase para un problema
 * que es por aparato (una TV o una barra de sonido por HDMI sí valen, y una
 * salida analógica que no uses no la tocaba). `esSalidaDigital` sigue viva
 * porque el switch-on-connect la necesita para no adoptar nunca una pantalla.
 */

/** Espejo de `AstalWp.Available`. Se replica para no importar GI desde código puro. */
export const DISPONIBLE_DESCONOCIDA = 0
export const DISPONIBLE_NO = 1
export const DISPONIBLE_SI = 2

export type InfoEndpoint = {
  id: number
  /** `node.name` de PipeWire, o "" si aún no se conoce. */
  nodeName: string
  /** Disponibilidad de la ruta ACTIVA, o `null` si el endpoint no tiene ninguna. */
  disponibilidadRuta: number | null
  /** Disponibilidad de cada ruta conocida (puede venir vacía). */
  disponibilidadRutas: number[]
}

/** Identidad PERSISTENTE de un endpoint, para la lista de ocultos.
 *
 * El `id` no vale: es un id global de PipeWire y cambia cada vez que el nodo se
 * recrea (medido aquí al conmutar el perfil de la tarjeta interna: 57 → 72), o
 * sea que ocultar algo duraría hasta el siguiente `hyprctl reload`. El
 * `node.name` sí sobrevive a reinicios y describe el aparato y su perfil
 * (`alsa_output.pci-0000_01_00.1.hdmi-stereo`), que es exactamente la
 * granularidad que se quiere ocultar. El prefijo separa salidas de entradas
 * porque un sink y su monitor comparten nombre base.
 *
 * El fallback por id existe para no quedarse sin clave, pero es DELIBERADAMENTE
 * malo (no sobrevive a una recreación): un endpoint sin `node.name` es uno que
 * WirePlumber aún no ha terminado de publicar, no un caso a soportar. */
export function claveEndpoint(kind: "spk" | "mic", info: InfoEndpoint): string {
  return `${kind}:${info.nodeName || `id:${info.id}`}`
}

/** Salida (o entrada) que viaja por un cable digital de vídeo o por S/PDIF.
 *
 * Es el mismo criterio —y a propósito la misma expresión— que usa el
 * switch-on-connect de Quick Settings para no adoptar nunca una salida de
 * pantalla como destino al recrearse su nodo. Vive aquí para que las dos reglas
 * no puedan divergir. */
export function esSalidaDigital(nodeName: string): boolean {
  return /hdmi|displayport|iec958|spdif/i.test(nodeName)
}

/** ¿El hardware afirma que no hay nada conectado a este endpoint?
 *
 * Solo `NO` cuenta como muerto. `UNKNOWN` es el valor de todo lo que no tiene
 * detección de jack (USB, S/PDIF, Bluetooth) y tratarlo como muerto vaciaría la
 * lista entera. */
export function esEndpointMuerto(info: InfoEndpoint): boolean {
  if (info.disponibilidadRuta === DISPONIBLE_NO) return true
  // Sin ruta activa, pero con rutas conocidas y todas no disponibles: la tarjeta
  // existe y ningún puerto suyo tiene nada enchufado.
  if (info.disponibilidadRuta === null && info.disponibilidadRutas.length > 0)
    return info.disponibilidadRutas.every((d) => d === DISPONIBLE_NO)
  return false
}

export type OpcionesReparto = {
  /** Tipo de lista, para componer la clave persistente. */
  kind: "spk" | "mic"
  /** Claves que el usuario ha apartado con el clic derecho. */
  ocultos: readonly string[]
  /** El endpoint por defecto nunca se aparta, pase lo que pase. */
  idActivo: number | null
}

export type RepartoEndpoints<T> = {
  /** Lo que se pinta como tarjetas, en el orden de entrada. */
  visibles: T[]
  /** Lo que va al desplegable "Ocultos", en el orden de entrada. */
  ocultos: T[]
}

/** Reparte la lista en "se ve" / "está apartado", conservando orden e IDENTIDAD.
 *
 * Que devuelva las mismas referencias importa: las listas alimentan `<For>`, que
 * indexa por identidad de objeto, así que fabricar envoltorios reconstruiría
 * todas las filas en cada emisión (ver la auditoría de `<For>` en el CLAUDE.md
 * de `ags/`).
 *
 * Tres reglas, y el orden entre ellas es lo único que hay que respetar:
 *  1. **Lo muerto no sale por ningún lado.** No es una elección del usuario que
 *     se pueda deshacer desde la UI, así que tampoco tiene sentido enseñarlo en
 *     "Ocultos" — sería una fila que no se puede recuperar porque no hay nada
 *     que recuperar.
 *  2. **El activo siempre se ve**, aunque esté marcado como oculto. Esconder
 *     por dónde está saliendo el audio es peor que el problema que se arregla.
 *     La UI ya no deja marcar el activo (ver `alternarOculto` en
 *     `QuickSettings.tsx`), así que esto es la red para una marca **heredada**:
 *     una clave guardada antes de esa regla, o un dispositivo que se apartó
 *     estando inactivo y que luego vuelve a ser el default por su cuenta.
 *  3. **Y entonces no se cuenta también como oculto**: aparecería a la vez
 *     arriba y en el contador de abajo.
 */
export function repartirEndpoints<T>(
  lista: readonly T[],
  info: (item: T) => InfoEndpoint,
  { kind, ocultos, idActivo }: OpcionesReparto,
): RepartoEndpoints<T> {
  const marcados = new Set(ocultos)
  const reparto: RepartoEndpoints<T> = { visibles: [], ocultos: [] }
  for (const item of lista) {
    const i = info(item)
    if (esEndpointMuerto(i)) continue
    if (idActivo !== null && i.id === idActivo) { reparto.visibles.push(item); continue }
    if (marcados.has(claveEndpoint(kind, i))) reparto.ocultos.push(item)
    else reparto.visibles.push(item)
  }
  return reparto
}

/** Etiqueta legible y DISTINGUIBLE, partida en dos líneas.
 *
 * `description` es lo que enseñan Discord y pavucontrol ("SIMGOT EW300 DSP
 * Estéreo analógico") y es lo correcto, pero en una fila estrecha con
 * `ellipsize` al final se recorta justo la mitad única cuando varias salidas
 * comparten tarjeta. La versión anterior resolvía eso quedándose SOLO con
 * `device.profile.description`, y el remedio salió peor que la enfermedad: las
 * filas pasaron a llamarse "Estéreo analógico", "Estéreo digital (HDMI)" y
 * "Mono" — sin una palabra sobre QUÉ aparato es, y con dos filas distintas
 * (los cascos USB y la entrada de la placa) leyéndose las dos "Estéreo
 * analógico". De ahí las dos líneas: arriba el aparato, abajo el perfil.
 *
 * `node.nick` es el nombre corto del aparato ("SIMGOT EW300 DSP", "ALC897
 * Digital") y en el HDMI trae además el modelo del monitor leído del EDID
 * ("XG27AQDMES"), que es bastante más útil que "GA106 High Definition Audio
 * Controller". Si falta, se recompone quitándole a `description` el sufijo del
 * perfil, que es literalmente cómo la construye WirePlumber. */
export function etiquetaEndpoint(campos: {
  nick?: string | null
  descripcion?: string | null
  perfil?: string | null
  nombre?: string | null
}): { titulo: string; subtitulo: string } {
  const perfil = (campos.perfil ?? "").trim()
  const descripcion = (campos.descripcion ?? "").trim()
  const nick = (campos.nick ?? "").trim()

  let titulo = nick
  if (!titulo && descripcion) {
    titulo = perfil && descripcion.endsWith(perfil)
      ? descripcion.slice(0, descripcion.length - perfil.length).trim()
      : descripcion
  }
  if (!titulo) titulo = (campos.nombre ?? "").trim()
  if (!titulo) titulo = perfil || "Desconocido"

  // Sin nada que añadir, no se pinta una segunda línea repitiendo la primera.
  const subtitulo = perfil && perfil !== titulo ? perfil : ""
  return { titulo, subtitulo }
}
