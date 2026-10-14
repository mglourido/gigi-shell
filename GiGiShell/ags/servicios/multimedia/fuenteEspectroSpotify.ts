// Selecciona el stream local de Spotify mientras algún monitor necesita su espectro.
// AstalWp ya vigila PipeWire: aquí solo se conectan señales durante esa adquisición.
import AstalWp from "gi://AstalWp"
import { estadoSpotify } from "./mpris"
import { propsDeStream } from "./presetsApps"
import { streamEsDeReproductor } from "./streamDeReproductor"

export function observarFuenteEspectroSpotify(
  alCambiar: (serial: number | null) => void,
  alCambiarGanancia?: (ganancia: number) => void,
): () => void {
  let wireplumber: AstalWp.Wp | null = null
  let audio: AstalWp.Audio | null = null
  const senalesAudio: number[] = []
  const vigilados = new Map<AstalWp.Stream, number>()
  let serialActual: number | null = null
  let gananciaActual = 0
  let salida: AstalWp.Endpoint | null = null
  let idSalida: number | null = null
  let idEscala: number | null = null
  let cerrado = false

  const revisar = (retirado: AstalWp.Stream | null = null) => {
    if (cerrado) return
    const estado = estadoSpotify.get()
    const reproductor = estado?.reproductor
    const candidatos: AstalWp.Stream[] = []
    try {
      if (estado?.reproduciendo && reproductor && audio) {
        for (const stream of audio.get_streams() ?? []) {
          if (stream === retirado) continue
          if (streamEsDeReproductor(propsDeStream(stream), {
            entry: reproductor.entry, busName: reproductor.bus_name, identity: reproductor.identity,
          })) candidatos.push(stream)
        }
      }
    } catch (_) {}

    for (const [stream, id] of vigilados) {
      if (candidatos.includes(stream)) continue
      try { stream.disconnect(id) } catch (_) {}
      vigilados.delete(stream)
    }
    let elegido: AstalWp.Stream | null = null
    for (const stream of candidatos) {
      try {
        if (!vigilados.has(stream)) {
          vigilados.set(stream, stream.connect("notify", (_stream, propiedad) => {
            const nombre = propiedad.name
            if (nombre === "state" || nombre === "volume" || nombre === "mute"
                || nombre === "target-endpoint" || nombre === "target-serial") revisar()
          }))
        }
        const serial = stream.serial
        // Astal no inicializa el estado al adoptar un nodo ya existente: puede seguir en
        // CREATING hasta su primera transición. Rechazarlo rompería la recarga de AGS.
        // CAVA es pasivo (active=0), así que admitirlo no fuerza a Spotify a reproducir.
        if (stream.state !== AstalWp.NodeState.RUNNING && stream.state !== AstalWp.NodeState.CREATING) continue
        if (!Number.isSafeInteger(serial) || serial <= 0) continue
        if (elegido === null || serial === serialActual) elegido = stream
      } catch (_) {}
    }
    let nuevaSalida: AstalWp.Endpoint | null = null
    let nuevaGanancia = 0
    let siguiente: number | null = null
    try {
      nuevaSalida = elegido?.get_target_endpoint() ?? audio?.get_default_speaker() ?? null
      const volumen = elegido?.volume ?? 0
      if (elegido && !elegido.mute && Number.isFinite(volumen) && volumen > 0
          && (!nuevaSalida || (!nuevaSalida.mute && nuevaSalida.volume > 0))) {
        siguiente = elegido.serial
        // Astal usa volumen cúbico por defecto; PipeWire aplica su cubo a las muestras.
        // El volumen del altavoz solo decide el silencio: no está en este stream capturado.
        nuevaGanancia = wireplumber?.scale === AstalWp.Scale.LINEAR ? volumen : volumen ** 3
        if (!Number.isFinite(nuevaGanancia) || nuevaGanancia <= 0) {
          siguiente = null
          nuevaGanancia = 0
        }
      }
    } catch (_) {}
    if (salida !== nuevaSalida) {
      if (idSalida !== null) { try { salida?.disconnect(idSalida) } catch (_) {} }
      salida = nuevaSalida
      idSalida = null
      try {
        idSalida = salida?.connect("notify", (_salida, propiedad) => {
          if (propiedad.name === "volume" || propiedad.name === "mute") revisar()
        }) ?? null
      } catch (_) {}
    }
    if (nuevaGanancia !== gananciaActual) {
      gananciaActual = nuevaGanancia
      alCambiarGanancia?.(nuevaGanancia)
    }
    if (siguiente === serialActual) return
    serialActual = siguiente
    alCambiar(siguiente)
  }

  try {
    wireplumber = AstalWp.get_default()
    audio = wireplumber?.audio ?? null
    if (audio) {
      senalesAudio.push(audio.connect("stream-added", () => revisar()))
      senalesAudio.push(audio.connect("stream-removed", (_audio, stream) => revisar(stream)))
      senalesAudio.push(audio.connect("notify::default-speaker", () => revisar()))
    }
    idEscala = wireplumber?.connect("notify::scale", () => revisar()) ?? null
  } catch (error) {
    console.error("[espectro] no se pudo observar el audio de Spotify:", error)
  }
  const cancelarSpotify = estadoSpotify.subscribe(() => revisar())
  revisar()

  return () => {
    if (cerrado) return
    cerrado = true
    cancelarSpotify()
    for (const [stream, id] of vigilados) {
      try { stream.disconnect(id) } catch (_) {}
    }
    vigilados.clear()
    for (const id of senalesAudio) {
      try { audio?.disconnect(id) } catch (_) {}
    }
    if (idSalida !== null) { try { salida?.disconnect(idSalida) } catch (_) {} }
    if (idEscala !== null) { try { wireplumber?.disconnect(idEscala) } catch (_) {} }
    salida = null
    wireplumber = null
    audio = null
  }
}
