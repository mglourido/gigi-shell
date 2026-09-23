import { Gtk, Gdk } from "ags/gtk4"
import { createState } from "ags"
import AstalWp from "gi://AstalWp"
import { crearCicloVida } from "../../../../utilidades/cicloVida"
import { hayUsoDeMicrofono } from "../../../../servicios/multimedia/capturasMicrofono"
import {
  clasificacionPendiente, origenCapturas, sincronizarOrigenes,
} from "../../../../servicios/multimedia/origenCapturas"
import { microfonoAppsIgnoradas } from "../../../ajustes/preferences"

export default function Microfono() {
    const cicloVida = crearCicloVida()
    // Un ÚNICO estado para la visibilidad, recalculado a mano en cada evento.
    //
    // Antes esto era `createComputed(() => hasMic() && isRecording())` sobre dos
    // estados, y el `&&` cortocircuitaba: gnim suscribe un computed a las
    // dependencias que ha LEÍDO en su primera evaluación (y, montado dentro de un
    // <With>, lo hace dentro de un effect scope, donde esa primera lista de
    // dependencias es la definitiva hasta que alguna de ellas cambie). WirePlumber
    // enumera de forma asíncrona —al construirse el bar `audio.microphones` y
    // `audio.recorders` están AMBOS vacíos, los nodos llegan unos ms después—, así
    // que `hasMic()` valía false, `isRecording()` no se llegaba a leer y el computed
    // se suscribía SOLO a hasMic: los `recorder-added` posteriores no invalidaban
    // nada y el icono se quedaba clavado en su false cacheado. Con un solo estado no
    // hay dependencias que rastrear que puedan salir mal.
    const [visible, setVisible] = createState(false)
    const [isMuted, setIsMuted] = createState(false)

    const audio = AstalWp.get_default()?.audio
    let mic = audio?.defaultMicrophone ?? null

    const syncMute = () => setIsMuted(!!mic?.mute)
    const toggleMute = () => {
        if (!mic) return
        const next = !mic.mute
        mic.mute = next
        setIsMuted(next)
    }

    if (audio) {
        // PipeWire puede mantener fuentes virtuales incluso en equipos sin una
        // entrada física. Solo cuentan endpoints asociados a un Device real y
        // cuya ruta no esté marcada explícitamente como no disponible.
        const hasMic = () =>
            (audio.microphones ?? []).some((endpoint) => {
                if (!endpoint.device) return false
                const route = endpoint.route
                return !route || route.available !== AstalWp.Available.NO
            })

        // El micro se considera "activo" si alguna app tiene una captura abierta.
        // AstalWp ya expone esas capturas como `audio.recorders` y emite
        // `recorder-added`/`recorder-removed` al instante, así que en vez de sondear
        // `pactl` cada 2 s (un subproceso por monitor) reaccionamos a las señales:
        // cero subprocesos, cero timers y sin coste cuando no hay nada capturando.
        //
        // NO vale con contar `recorders`: ahí entra todo lo que capture una
        // ENTRADA de audio, incluido el monitor de un altavoz o la salida de otra
        // app. Nuestro propio `cava` (la onda de Spotify) encendía el icono al dar
        // a play. Quién es quién lo decide `capturasMicrofono.ts` con lo que
        // `origenCapturas.ts` averigua por `pactl`; ahí están las medidas.
        const isRecording = () => hayUsoDeMicrofono(
            audio.recorders,
            microfonoAppsIgnoradas.get(),
            origenCapturas.get(),
            // Con una consulta en vuelo, lo aún sin clasificar espera: contarlo
            // haría parpadear el icono al arrancar una captura de sistema.
            clasificacionPendiente.get() ? "espera" : "cuenta",
        )

        // Visible siempre que haya un micro conectado Y alguna app lo esté usando.
        // El mute ya NO oculta el icono: solo cambia su apariencia (ver más abajo),
        // para que se vea que una app tiene el micro abierto aunque esté silenciado.
        //
        // `sincronizarOrigenes` no lanza nada si ya conoce todas las capturas
        // vivas, así que puede ir en el camino común sin miedo a un bucle:
        // recibir un veredicto vuelve a llamar aquí, y esa segunda vez ya no
        // pregunta nada. Esa vuelta es además lo que cierra la carrera de una
        // captura que aparezca con la consulta anterior en vuelo.
        const sync = () => {
            sincronizarOrigenes(audio.recorders)
            setVisible(hasMic() && isRecording())
        }
        sync()

        // TODAS las señales recalculan las DOS condiciones, no "cada una la suya".
        // El veredicto de hardware no puede quedarse cacheado: `microphone-added` es
        // un evento único, y si en ese instante el endpoint aún no tiene `device`
        // (WirePlumber registra el Device y el Endpoint por separado; al iniciar
        // sesión puede llegar el segundo antes que el primero), hasMic salía false y
        // nada volvía a evaluarlo en toda la sesión: el icono ya no aparecía por más
        // que Discord abriera el micro. Recalculando ambas en cada evento, cualquier
        // señal posterior —incluida la del propio recorder— corrige el veredicto.
        cicloVida.conectarSenales(audio, [
            "recorder-added",
            "recorder-removed",
            "microphone-added",
            "microphone-removed",
            "device-added",
            "device-removed",
        ], sync)
        // Cubre el caso de que ya hubiera una captura al arrancar/recargar AGS
        // (el recorder-added pudo emitirse antes de conectar los handlers).
        cicloVida.conectarSenales(audio, ["notify::recorders", "notify::microphones"], sync)
        // Apartar (o recuperar) una captura desde Ajustes tiene que verse al momento:
        // la lista cambia sin que WirePlumber emita nada. Igual el veredicto de
        // `pactl`, que llega unos ms después del evento que lo pidió.
        cicloVida.suscribir(microfonoAppsIgnoradas, sync)
        cicloVida.suscribir(origenCapturas, sync)
        cicloVida.suscribir(clasificacionPendiente, sync)

        let desconectarMicro: (() => void) | null = null
        const bindMic = (next: AstalWp.Endpoint | null) => {
            desconectarMicro?.()
            mic = next
            desconectarMicro = mic ? cicloVida.conectarSenales(mic, ["notify::mute"], syncMute) : null
            syncMute()
        }
        bindMic(mic)
        cicloVida.conectarSenales(audio, ["notify::default-microphone"], () => bindMic(audio.defaultMicrophone))
    }

    return (
        <box
            visible={visible}
            valign={Gtk.Align.CENTER}
            cssClasses={isMuted((m) =>
                m ? ["recording", "mic-indicator", "muted"] : ["recording", "mic-indicator"],
            )}
        >
            <Gtk.GestureClick
                button={Gdk.BUTTON_SECONDARY}
                onPressed={(self) => {
                    toggleMute()
                    self.set_state(Gtk.EventSequenceState.CLAIMED)
                }}
            />
            <label
                cssClasses={["icon"]}
                label={isMuted((m) => (m ? "󰍭" : "󰍬"))}
            />
        </box>
    )
}
