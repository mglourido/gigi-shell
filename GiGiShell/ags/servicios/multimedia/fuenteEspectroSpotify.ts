// Selecciona el stream local de Spotify mientras algún monitor necesita su espectro.
// AstalWp ya vigila PipeWire: aquí solo se conectan señales durante esa adquisición.
import AstalWp from "gi://AstalWp"
import { estadoSpotify } from "./mpris"
import { propsDeStream } from "./presetsApps"
import { streamEsDeReproductor } from "./streamDeReproductor"

export function observarFuenteEspectroSpotify(alCambiar: (serial: number | null) => void): () => void {
  let audio: AstalWp.Audio | null = null
  const senalesAudio: number[] = []
  const vigilados = new Map<AstalWp.Stream, number>()
  let serialActual: number | null = null
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
    let siguiente: number | null = null
    for (const stream of candidatos) {
      try {
        if (!vigilados.has(stream)) vigilados.set(stream, stream.connect("notify::state", () => revisar()))
        const serial = stream.serial
        // Astal no inicializa el estado al adoptar un nodo ya existente: puede seguir en
        // CREATING hasta su primera transición. Rechazarlo rompería la recarga de AGS.
        // CAVA es pasivo (active=0), así que admitirlo no fuerza a Spotify a reproducir.
        if (stream.state !== AstalWp.NodeState.RUNNING && stream.state !== AstalWp.NodeState.CREATING) continue
        if (!Number.isSafeInteger(serial) || serial <= 0) continue
        if (siguiente === null || serial === serialActual) siguiente = serial
      } catch (_) {}
    }
    if (siguiente === serialActual) return
    serialActual = siguiente
    alCambiar(siguiente)
  }

  try {
    audio = AstalWp.get_default()?.audio ?? null
    if (audio) {
      senalesAudio.push(audio.connect("stream-added", () => revisar()))
      senalesAudio.push(audio.connect("stream-removed", (_audio, stream) => revisar(stream)))
    }
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
    audio = null
  }
}
