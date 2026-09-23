import { onCleanup } from "ags"
import { execAsync } from "ags/process"
import { Gdk, Gtk } from "ags/gtk4"
import AstalHyprland from "gi://AstalHyprland"
import GLib from "gi://GLib"
import { findMediaClient } from "../../../../servicios/multimedia/mediaClient"
import { estadoSpotify } from "../../../../servicios/multimedia/mpris"
import { parseTrackId } from "../../../../servicios/spotify/parse"
import { transferToThisDevice } from "../../../../servicios/spotify/SpotifyService"
import CaratulaCompacta from "./CaratulaCompacta"
import OndaSpotify from "./OndaSpotify"
import type { EstadoVisibilidadBarra } from "../../../../estado/visibilidadBarra"

/** Reproductor mínimo de Spotify para el centro de la barra. */
export default function ReproduccionSpotify({ visibilidad }: { visibilidad: EstadoVisibilidadBarra }) {
  const hypr = AstalHyprland.get_default()
  let desmontado = false
  const esperas = new Map<number, () => void>()

  const reproductorActual = () => estadoSpotify.get()?.reproductor ?? null
  const visible = estadoSpotify((estado) => Boolean(estado && (
    estado.esAnuncio || estado.reproductor.title || estado.reproductor.artist
  )))
  const titulo = estadoSpotify((estado) => estado?.titulo ?? "")
  const artista = estadoSpotify((estado) => estado?.artista ?? "")
  const caratula = estadoSpotify((estado) => estado?.caratula ?? "")

  /**
   * MPRIS no distingue si Spotify Connect reproduce aquí o en otro equipo.
   * PipeWire sí: el nodo local solo permanece `running` cuando este cliente rinde audio.
   * Ante un fallo conservamos el comportamiento seguro de play/pausa local.
   */
  const audioEsLocal = async (): Promise<boolean> => {
    try {
      const nodos = JSON.parse(await execAsync(["pw-dump"]))
      return nodos.some((nodo: any) => {
        const propiedades = nodo?.info?.props
        if (!propiedades) return false
        if (!String(propiedades["media.class"] || "").includes("Stream/Output/Audio")) return false
        const aplicacion = `${propiedades["application.name"] || ""} ${propiedades["node.name"] || ""}`.toLowerCase()
        return aplicacion.includes("spotify") && nodo?.info?.state === "running"
      })
    } catch (_) {
      return true
    }
  }

  const esperar = (milisegundos: number) => new Promise<void>((resolver) => {
    const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, milisegundos, () => {
      esperas.delete(id)
      resolver()
      return GLib.SOURCE_REMOVE
    })
    esperas.set(id, resolver)
  })

  // El nodo puede tardar un instante en cambiar a `running` después de play.
  const resolverLocal = async (): Promise<boolean> => {
    if (await audioEsLocal()) return true
    await esperar(350)
    if (desmontado) return true
    return audioEsLocal()
  }

  const notificar = (cuerpo: string) =>
    execAsync(["notify-send", "-a", "Spotify", "-i", "spotify", "Spotify", cuerpo]).catch(() => {})

  /** Conserva la transferencia específica de Spotify Connect y su plan B local. */
  const tomarReproduccion = async () => {
    const resultado = await transferToThisDevice()
    if (desmontado || resultado === "ok") return

    const reproductor = reproductorActual()
    if (resultado === "denied" || resultado === "unavailable") {
      const id = parseTrackId(reproductor?.trackid || "")
      if (id && reproductor?.can_control) {
        try {
          reproductor.open_uri(`spotify:track:${id}`)
          return
        } catch (_) {}
      }
    }

    notificar(resultado === "no-device"
      ? "No se pudo traer el audio: este equipo no aparece como dispositivo de Spotify Connect."
      : "No se pudo traer el audio a este equipo.")
  }

  const enfocarSpotify = () => {
    const cliente = findMediaClient(reproductorActual(), hypr.get_clients?.() ?? [])
    if (!cliente?.address) return

    const direccion = String(cliente.address)
    const normalizada = direccion.startsWith("0x") ? direccion : `0x${direccion}`
    execAsync(["hyprctl", "dispatch", `hl.dsp.focus({window='address:${normalizada}'})`]).catch(() => {})
  }

  onCleanup(() => {
    desmontado = true
    for (const [id, resolver] of esperas) {
      GLib.source_remove(id)
      resolver()
    }
    esperas.clear()
  })

  return (
    <box
      visible={visible}
      cssClasses={["bar-spotify"]}
      spacing={3}
      valign={Gtk.Align.CENTER}
    >
      <box spacing={7}>
        <CaratulaCompacta ruta={caratula} />
        <box
          orientation={Gtk.Orientation.VERTICAL}
          valign={Gtk.Align.CENTER}
          widthRequest={145}
        >
          <label
            cssClasses={["bar-spotify-title"]}
            label={titulo}
            halign={Gtk.Align.START}
            ellipsize={3}
            maxWidthChars={24}
          />
          <label
            cssClasses={["bar-spotify-artist"]}
            label={artista}
            halign={Gtk.Align.START}
            ellipsize={3}
            maxWidthChars={24}
          />
        </box>
      </box>
      <OndaSpotify visibilidad={visibilidad} />
      <Gtk.GestureClick
        button={1}
        onReleased={() => {
          const reproductor = reproductorActual()
          if (!reproductor) return
          if (estadoSpotify.get()?.reproduciendo !== true) {
            reproductor.play_pause()
            return
          }

          resolverLocal().then((local) => {
            const actual = reproductorActual()
            if (desmontado || !actual) return
            if (local) actual.play_pause()
            else tomarReproduccion()
          })
        }}
      />
      <Gtk.GestureClick button={Gdk.BUTTON_SECONDARY} onReleased={enfocarSpotify} />
    </box>
  )
}
