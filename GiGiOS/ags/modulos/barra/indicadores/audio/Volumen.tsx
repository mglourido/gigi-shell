import AstalWp from "gi://AstalWp"
import { createState } from "ags"
import { Gtk, Gdk } from "ags/gtk4"
import { crearCicloVida } from "../../../../utilidades/cicloVida"
import { auricularSilenciado, iconoVolumen } from "./datosVolumen"
import type { EstadoVisibilidadBarra } from "../../../../estado/visibilidadBarra"
import { tituloBarra } from "../../componentes/tituloBarra"

// ¿La salida por defecto son auriculares/cascos (BT o cable)?
//
// Por cable NO basta con mirar el sink. Esto asumía el perfil UCM "HiFi" (cada
// salida es un sink propio, con "Headphones" en el node.name), pero con el perfil
// ALSA clásico —el de esta máquina— altavoces y auriculares COMPARTEN un único
// sink cuyos campos son siempre genéricos (`name` null, `icon`
// "audio-card-analog-pci", `description` "Audio Interno Estéreo analógico"): al
// enchufar el jack no cambia ninguno de los tres, cambia el *puerto activo* del
// dispositivo, que Astal expone como `route` ("analog-output-headphones" /
// "Auriculares"). Sin mirar la ruta activa, el cable no se detectaba nunca.
//
// Por BT sí lo delata el endpoint (WirePlumber marca el icono "audio-headset"/
// "audio-headphones"), así que la búsqueda une icon + name + description + ruta
// activa para cubrir ambos casos. Ojo: la ruta ACTIVA (`route`), no la lista
// `routes` — ahí los auriculares siguen figurando aunque suene por los altavoces.
export default function Volumen({ visibilidad }: { visibilidad: EstadoVisibilidadBarra }) {
  const cicloVida = crearCicloVida()
  const wp = AstalWp.get_default()
  if (!wp?.audio) return (<box />)
  const audio = wp.audio

  let speaker: AstalWp.Endpoint | null = audio.defaultSpeaker ?? null

  const [icon, setIcon]   = createState(iconoVolumen(speaker))
  const [appearance, setAppearance] = createState(
    speaker ? (speaker.mute ? "muted" : "normal") : "no-output",
  )
  const [tooltip, setTooltip] = createState(
    speaker ? `${Math.round(speaker.volume * 100)}` : "Sin dispositivo de salida",
  )
  const [slashed, setSlashed] = createState(auricularSilenciado(speaker))

  // Diagonal (esquina inferior-izq → superior-der) sobre el icono de cascos.
  // Trazo con "recorte": primero una línea del color del bar (efecto de corte) y
  // encima la línea clara, para que se lea nítida sobre el glifo.
  const slashArea = new Gtk.DrawingArea()
  slashArea.set_can_target(false)          // no roba clic/scroll del botón
  slashArea.set_halign(Gtk.Align.FILL)
  slashArea.set_valign(Gtk.Align.FILL)
  slashArea.set_visible(slashed.get())
  slashArea.set_draw_func((_a, cr, width, height) => {
    // Diagonal corta y centrada sobre el glifo (no de esquina a esquina).
    const cx = width / 2, cy = height / 2
    const r = Math.min(width, height) * 0.42    // media longitud del trazo
    const u = Math.SQRT1_2                       // dirección ↙→↗ normalizada
    const x0 = cx - r * u, y0 = cy + r * u, x1 = cx + r * u, y1 = cy - r * u
    // Banda diagonal como paralelogramo relleno (evita depender de stroke).
    const band = (half: number) => {
      const dx = x1 - x0, dy = y1 - y0
      const len = Math.hypot(dx, dy) || 1
      const nx = (-dy / len) * half, ny = (dx / len) * half
      cr.moveTo(x0 + nx, y0 + ny)
      cr.lineTo(x1 + nx, y1 + ny)
      cr.lineTo(x1 - nx, y1 - ny)
      cr.lineTo(x0 - nx, y0 - ny)
      cr.closePath()
      cr.fill()
    }
    // recorte con el color del bar (#08080c) y encima la línea clara
    cr.setSourceRGBA(8 / 255, 8 / 255, 12 / 255, 1);          band(1.5)
    cr.setSourceRGBA(226 / 255, 226 / 255, 226 / 255, 0.9);   band(0.8)
  })
  cicloVida.suscribir(slashed, () => { slashArea.set_visible(slashed.get()); slashArea.queue_draw() })

  const sync = () => {
    setIcon(iconoVolumen(speaker))
    setAppearance(speaker ? (speaker.mute ? "muted" : "normal") : "no-output")
    setTooltip(speaker ? `${Math.round(speaker.volume * 100)}` : "Sin dispositivo de salida")
    setSlashed(auricularSilenciado(speaker))
  }

  // Cachea con esta barra oculta: no re-renderiza, mantiene el último estado.
  const update = () => { if (!visibilidad.visible.get()) return; sync() }

  // El altavoz por defecto puede cambiar (auriculares, BT, cambio de salida en QS).
  // Hay que re-enganchar las señales al nuevo dispositivo y actualizar la referencia
  // `speaker`: si no, el icono quedaría del dispositivo viejo y —peor— el clic/scroll
  // controlaría el volumen del dispositivo equivocado. La referencia se actualiza
  // siempre (para las interacciones); el render respeta su visibilidad local.
  let desconectarSpeaker: (() => void) | null = null
  const bindSpeaker = (s: AstalWp.Endpoint | null) => {
    desconectarSpeaker?.()
    speaker = s
    desconectarSpeaker = speaker ? cicloVida.conectarSenales(speaker, [
      "notify::volume",
      "notify::mute",
      "notify::icon",
      "notify::description",
      "notify::route",
    ], update) : null
    update()
  }
  bindSpeaker(speaker)

  cicloVida.conectarSenales(audio, ["notify::default-speaker"], () => bindSpeaker(audio.defaultSpeaker ?? null))

  // Al arrancar, WirePlumber puede no haber poblado aún icon/name/description del
  // endpoint, y además la barra puede ocultarse al arrancar (update() se ignora),
  // así que la detección de cascos fallaba hasta el primer hover. Forzamos varios
  // sync() diferidos —sync() no está condicionado por la visibilidad— para fijar el estado
  // correcto desde el inicio.
  const temporizadores = [400, 1200, 3000].map((retraso) => setTimeout(sync, retraso))
  cicloVida.registrar(() => temporizadores.forEach(clearTimeout))

  // Al volver visible, sincronizar con el estado real del hardware.
  // gnim invoca el callback sin argumentos → hay que leer .get().
  cicloVida.suscribir(visibilidad.refrescar, () => { if (visibilidad.refrescar.get()) sync() })

  const toggleMute = () => { if (speaker) speaker.mute = !speaker.mute }

  return (
    <button
      cssClasses={appearance((state) => state === "no-output"
        ? ["volume", "no-output"]
        : state === "muted" ? ["volume", "bt-muted"] : ["volume"])}
      $={(self: Gtk.Widget) => tituloBarra(self, tooltip)}
      onClicked={toggleMute}
    >
      <Gtk.GestureClick
        button={Gdk.BUTTON_SECONDARY}
        onPressed={toggleMute}
      />
      <Gtk.Overlay $={(self) => { self.add_overlay(slashArea) }}>
        <label
          cssClasses={appearance((state) => state === "muted" ? ["icon-muted"] : [])}
          label={icon}
        />
      </Gtk.Overlay>
      <Gtk.EventControllerScroll
        flags={Gtk.EventControllerScrollFlags.VERTICAL}
        onScroll={(_self, _dx, dy) => {
          if (!speaker) return
          speaker.volume = Math.max(0, Math.min(1.0, speaker.volume - dy * 0.05))
        }}
      />
    </button>
  )
}
