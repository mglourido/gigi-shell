import { Gtk } from "ags/gtk4"
import { createState } from "ags"
import AstalWp from "gi://AstalWp"
import { micOsdVisible, setMicOsdVisible } from "../../estado/shell"
import { micOsdEnabled } from "../ajustes/preferences"
import { fraccionMostradaMic, porcentajeMic } from "../../servicios/multimedia/volumenMicrofono"

let micOsdTimeout: number | null = null
let micOsdReady = false
setTimeout(() => { micOsdReady = true }, 3000)

function hideMicOSD() {
    setMicOsdVisible(false)
    if (micOsdTimeout) clearTimeout(micOsdTimeout)
    micOsdTimeout = null
}

export function showMicOSD() {
    // Algunos dispositivos publican un cambio de mute al inicializar PipeWire.
    // No tiene valor mostrarlo durante el arranque de la sesión.
    if (!micOsdReady || !micOsdEnabled.get()) {
        hideMicOSD()
        return
    }
    setMicOsdVisible(true)
    if (micOsdTimeout) {
        clearTimeout(micOsdTimeout)
    }
    micOsdTimeout = setTimeout(() => {
        setMicOsdVisible(false)
        micOsdTimeout = null
    }, 2000)
}

micOsdEnabled.subscribe(() => {
    if (!micOsdEnabled.get()) hideMicOSD()
})

function getMicOsdIcon(v: number, muted: boolean) {
    if (muted || v === 0) return "󰍭" // Muted mic icon
    return "󰍬" // Unmuted mic icon
}

export function TarjetaMicrofonoOSD({
    onSetup,
}: {
    onSetup?: (self: Gtk.Box) => void
} = {}) {
    const wp = AstalWp.get_default()
    const audio = wp?.audio
    let microphone: AstalWp.Endpoint | null = audio?.defaultMicrophone ?? null

    // El progreso/porcentaje se enseña relativo a MIC_SAFE_MAX, no al 0-1 crudo
    // de PipeWire — si no, un mismo volumen real mostraría "40%" aquí y "100%" en
    // QuickSettings. La conversión NO se reimplementa aquí: vive en
    // `servicios/multimedia/volumenMicrofono.ts`, que es lo que garantiza que las
    // tres vistas (pastilla, submenú y este OSD) digan el mismo número.
    const micFraction = fraccionMostradaMic

    const [icon, setIcon] = createState(microphone ? getMicOsdIcon(microphone.volume, microphone.mute) : "󰍭")
    const [vol, setVol] = createState(micFraction(microphone?.volume ?? 0))
    const [percent, setPercent] = createState(microphone ? `${porcentajeMic(microphone.volume)}` : "—")
    const [muted, setMuted] = createState(microphone?.mute ?? true)

    const updateVars = () => {
        if (!microphone) {
            setIcon("󰍭")
            setVol(0)
            setPercent("—")
            setMuted(true)
            return
        }
        setIcon(getMicOsdIcon(microphone.volume, microphone.mute))
        setVol(micFraction(microphone.volume))
        setPercent(`${porcentajeMic(microphone.volume)}`)
        setMuted(microphone.mute || microphone.volume === 0)
    }

    let volumeId = 0
    let muteId = 0
    const bindMicrophone = (next: AstalWp.Endpoint | null) => {
        if (microphone && volumeId) microphone.disconnect(volumeId)
        if (microphone && muteId) microphone.disconnect(muteId)
        microphone = next
        volumeId = muteId = 0
        if (microphone) {
            volumeId = microphone.connect("notify::volume", () => {
                updateVars()
            })
            muteId = microphone.connect("notify::mute", () => {
                updateVars()
            })
        }
        updateVars()
    }
    bindMicrophone(microphone)
    audio?.connect("notify::default-microphone", () => bindMicrophone(audio.defaultMicrophone ?? null))

    return (
        <box
            visible={micOsdVisible}
            cssClasses={muted((isMuted) => [
                "osd-container",
                "osd-microphone",
                isMuted ? "osd-muted" : "osd-active",
            ])}
            orientation={Gtk.Orientation.HORIZONTAL}
            halign={Gtk.Align.CENTER}
            valign={Gtk.Align.START}
            overflow={Gtk.Overflow.HIDDEN}
            spacing={15}
            $={(self: Gtk.Box) => { onSetup?.(self) }}
        >
            <label cssClasses={["osd-icon"]} label={icon} />
            <box cssClasses={["osd-progress-container"]} valign={Gtk.Align.CENTER} hexpand>
                <Gtk.ProgressBar
                    cssClasses={["osd-progress"]}
                    fraction={vol}
                    valign={Gtk.Align.CENTER}
                    hexpand
                />
            </box>
            <label cssClasses={["osd-percentage"]} label={percent} />
        </box>
    )
}
