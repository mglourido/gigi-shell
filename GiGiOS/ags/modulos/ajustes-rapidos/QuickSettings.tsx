import app from "ags/gtk4/app"
import { Astal, Gtk, Gdk } from "ags/gtk4"
import { createState, For, With, createComputed, onCleanup } from "ags"
import { createBinding } from "ags"
import { execAsync } from "ags/process"
import GLib from "gi://GLib"
import ProfileAvatar from "../ajustes/ProfileAvatar"
import Interruptor from "../../componentes/Interruptor"
import {
  barTopMargin, clasesFondoShell,
  audioDispositivosOcultos, alternarDispositivoAudioOculto,
} from "../ajustes/preferences"
import {
  porcentajeMic,
  crudoDesdePorcentajeMic,
} from "../../servicios/multimedia/volumenMicrofono"
import {
  VOLUMEN_MAX,
  PASO_VOLUMEN,
  ajustarVolumen,
} from "../../servicios/multimedia/volumenAmplificado"
import { fijarVolumenEndpoint } from "../../servicios/multimedia/escrituraVolumen"
import {
  audioPresets,
  setAudioPresets,
  guardarAudioPresets as saveAudioPresets,
  clavePreset,
  nombreDeProps,
  propsDeStream,
  type TipoMezcla,
} from "../../servicios/multimedia/presetsApps"
import { claveDispositivo } from "../../servicios/multimedia/presetsDispositivos"
import { claveApp, esClienteDeSistema } from "../../servicios/multimedia/identidadApps"
import { presentacionApp, tieneEntradaEscritorio } from "../../servicios/multimedia/presentacionApps"
import {
  esSalidaDigital,
  esEndpointMuerto,
  etiquetaEndpoint,
  claveEndpoint,
  repartirEndpoints,
  type InfoEndpoint,
} from "../../servicios/multimedia/endpointsAudio"
import AstalWp from "gi://AstalWp"
import AstalNetwork from "gi://AstalNetwork"
import AstalBluetooth from "gi://AstalBluetooth"
import AstalNotifd from "gi://AstalNotifd"
import AstalHyprland from "gi://AstalHyprland"
import { ticReloj } from "../../servicios/sistema/reloj"
import { alReanudar } from "../../servicios/sistema/reanudacion.ts"
import Gio from "gi://Gio"
import GdkPixbuf from "gi://GdkPixbuf"
import cairo from "gi://cairo"
import {
  quickSettingsVisible,
  closeAllPanels,
  alternarPanelNotificaciones,
  nightLightTemp,
  qsView,
  setQsView,
  infoSsid,
  setInfoSsid,
  openSettingsPanel,

  brightness
} from "../../estado/shell"
import { applyBrightness, brightnessSupported } from "../../servicios/pantalla/brightness"
import { gamemodeAvailable, gamemodeActive, toggleGamemode } from "../../servicios/energia/gamemode"
import { forcePowerSave, setForcePowerSave, powerSaveActive } from "../../servicios/energia/powerState"
import { GLIFO_JUEGO as GAME_GLYPH } from "../../servicios/juegos/iconos"
import { clipWindowInputToContent } from "../../utilidades/inputRegion"
import * as Spotify from "../../servicios/spotify/SpotifyService"
import {
  matchScalePreset,
  resolutionOptions,
  refreshOptions,
  SCALE_PRESETS,
} from "../../servicios/pantalla/modes"
import {
  monitors, saveDisplayConfig,
  applyPatch, acquirePoll, releasePoll,
  initDisplayService, setManualTemp, nightOn, toggleNightNow,
} from "../../servicios/pantalla/service"
import { DisplaySelect } from "../../servicios/pantalla/controls"
import { InlineEditableValue } from "../../componentes/InlineEditableValue"
import { conectarCambioDeslizador } from "../../utilidades/deslizador"
import { obtenerGlifoAplicacion as getIcon } from "../../servicios/aplicaciones/glifos"
import { obtenerEntradaEscritorio } from "../../servicios/aplicaciones/entradasEscritorio"
import {
  reabrirVentanaRestauracion,
  resolverRestauracionBluetooth,
  valorBluetoothParaGuardar,
} from "../../servicios/bluetooth/estadoInicio"
import { getBluetoothTileInfo } from "../../servicios/bluetooth/tileState"
import { isLiveStreamLength, resolveMediaLengthSeconds, safeMediaPosition } from "../../servicios/multimedia/mediaProgress"
import { findMediaClient } from "../../servicios/multimedia/mediaClient"
import {
  obtenerEstadoReproductor,
  reproductoresMultimedia,
  revisionMultimedia,
} from "../../servicios/multimedia/mpris"
// Cámara. La capa de servicio (udev, v4l2-ctl, persistencia, vista previa) ya
// existe entera en `servicios/camara/`; aquí solo se consume.
import { camaras, hayCamara, type Camara } from "../../servicios/camara/dispositivos"
import {
  etiquetaControl,
  fijarControl,
  leerControles,
  restablecerControles,
  type Control,
} from "../../servicios/camara/controles"
import {
  estadoCamara,
  fijarPreferida,
  olvidarCamara,
  recordarControl,
} from "../../servicios/camara/persistencia"
import { camaraEnUso, descripcionUso, usoCamara } from "../../servicios/camara/uso"
import {
  alternarBloqueo, bloqueoDisponible, bloqueoOcupado, camaraBloqueada,
} from "../../servicios/camara/bloqueo"
import { abrirVistaPrevia, cerrarVistaPrevia } from "../../servicios/camara/vistaPrevia"
import {
  componerFilas,
  geometriaControl,
  mismasFilas,
  resolverCamaraVisible,
  resumenTileCamara,
  type FilaControlCamara,
} from "./camaraQsDatos"
import { crearCicloVida } from "../../utilidades/cicloVida"

const WIFI_SIGNAL_BARS = 4

function activeWifiBars(strength: number) {
  if (strength >= 80) return 4
  if (strength >= 60) return 3
  if (strength >= 35) return 2
  if (strength >= 15) return 1
  return 0
}

function wifiSignalBarClasses(strength: number) {
  const active = activeWifiBars(strength)

  return Array.from({ length: WIFI_SIGNAL_BARS }, (_, i) => {
    const classes = ["qs-wifi-signal-bar", `bar-${i + 1}`]
    if (i < active) classes.push("active")
    return classes
  })
}

function focusSearchAndType(entry: Gtk.Entry, char: string) {
  entry.text = entry.text + char
  entry.set_position(-1)
  entry.grab_focus()
}

function isTextInputWidget(widget: Gtk.Widget | null) {
  if (!widget) return false
  const editable = widget as any
  return widget instanceof Gtk.Entry
    || (typeof editable.get_text === "function" && typeof editable.set_text === "function")
}

function handleSearchSectionKey(controller: Gtk.EventControllerKey, entry: Gtk.Entry, keyval: number, state: Gdk.ModifierType) {
  const widget = controller.get_widget()
  const root = widget?.get_root() as any
  const focus = root?.get_focus?.() as Gtk.Widget | null
  if (isTextInputWidget(focus)) return false

  const s = state as unknown as number
  const CTRL = 4, ALT = 8, SUPER = 0x4000000
  if ((s & CTRL) || (s & ALT) || (s & SUPER)) return false

  if (keyval === Gdk.KEY_BackSpace) {
    entry.text = entry.text.slice(0, -1)
    entry.set_position(-1)
    entry.grab_focus()
    return true
  }

  const cp = Gdk.keyval_to_unicode(keyval)
  if (cp < 0x20) return false

  focusSearchAndType(entry, String.fromCodePoint(cp))
  return true
}

// ── Auto-Switch Audio (Switch-on-Connect) ───────────────────────────────────
// Al conectar un dispositivo de audio pasa a ser la salida/entrada por defecto.
// `speaker-added` NO significa "alguien acaba de enchufar algo", y creerlo costó
// dos bugs distintos — los dos dejaban el sonido en el HDMI de la GPU, que aquí no
// tiene NADA conectado (es una salida interna), y el default así fijado se persiste
// (`default.configured.audio.sink`), así que el estropicio sobrevivía al reinicio:
//
// 1. AstalWp lo emite también por cada endpoint que YA existía al arrancar el shell
//    (medido: HDMI y analógico, ~8 ms entre medias). Esa ráfaga de enumeración hacía
//    que se pusiera por defecto CADA sink, en execAsync concurrentes donde ganaba el
//    último en *terminar* — moneda al aire en cada arranque. → gate de asentamiento.
//
// 2. Y lo emite otra vez cada vez que un nodo se RECREA. El HDMI/DP no es un
//    dispositivo que se enchufe: su nodo se destruye y se recrea al reconfigurar los
//    monitores (`hyprctl reload`, DPMS, apagar la pantalla), y esa recreación llega
//    aquí indistinguible de unos cascos recién puestos. → nunca es destino.
//
// El gate de (1) no cubre (2) —la recreación llega mucho después de arrancar— ni al
// revés, así que hacen falta los dos.
const AUDIO_SETTLE_MS = 1500

// El nombre de nodo es la única señal fiable para reconocer una salida de pantalla:
// `Endpoint.name` viene a null, y el `icon` es el mismo ("audio-card-analog-pci") en
// el HDMI que en el analógico. Las claves de `wpctl inspect` no se traducen; la
// `description` sí, así que buscar "(HDMI)" ahí dependería del locale.
//
// El endpoint YA lo lleva en `node.name` (`get_pw_property`), así que el `wpctl
// inspect` queda solo de red: en el instante de `speaker-added` las propiedades
// del proxy pueden no estar pobladas todavía, y ahí sí hace falta preguntar fuera.
const nodeNameOf = async (ep: AstalWp.Endpoint): Promise<string> => {
  const propio = nodeNameSync(ep)
  if (propio) return propio
  const out = await execAsync(["wpctl", "inspect", String(ep.id)]).catch(() => "")
  return /node\.name\s*=\s*"([^"]+)"/.exec(out)?.[1] ?? ""
}
const nodeNameSync = (ep: AstalWp.Endpoint): string => {
  try { return ep.get_pw_property("node.name") ?? "" } catch { return "" }
}
const isDisplayOutput = esSalidaDigital

/** Traduce un `AstalWp.Endpoint` a los cuatro datos que necesita el filtro puro
 * de `servicios/multimedia/endpointsAudio.ts`. Todo va entre try: `route` es un
 * boxed que puede venir a null mientras WirePlumber aún enumera. */
function infoEndpoint(ep: AstalWp.Endpoint): InfoEndpoint {
  let disponibilidadRuta: number | null = null
  let disponibilidadRutas: number[] = []
  try { disponibilidadRuta = ep.route ? ep.route.available : null } catch { }
  try { disponibilidadRutas = (ep.routes ?? []).map((r) => r.available) } catch { }
  return { id: ep.id, nodeName: nodeNameSync(ep), disponibilidadRuta, disponibilidadRutas }
}

/** Fija el endpoint por defecto de forma PERSISTENTE.
 *
 * ⚠️ Esto NO puede hacerse con `pw-metadata … default.audio.sink`, y era justo
 * lo que hacía: `default.audio.sink` es la clave que dice cuál es el default
 * AHORA, y su dueño es WirePlumber, que la **recalcula entera** en cada rescan
 * (alta o baja de un nodo, cambio de perfil, el nodo HDMI recreándose al
 * reconfigurar monitores…). El resultado era un cambio que se oía al instante y
 * se deshacía solo unos segundos después, sin ningún error por medio: el
 * síntoma reportado de "cambia de repente a la salida digital" y, peor, "al
 * tocar el volumen del analógico vuelve a saltar" — porque tocar el slider
 * dispara este mismo `activate`, que escribía la clave equivocada y provocaba el
 * rescan que lo revertía.
 *
 * La clave de PREFERENCIA es `default.configured.audio.sink|source`, y encima
 * WirePlumber guarda ahí una PILA de todo lo que se ha configurado alguna vez
 * (`~/.local/state/wireplumber/default-nodes`, con sufijos `.0`, `.1`…: ver
 * `/usr/share/wireplumber/scripts/default-nodes/state-default-nodes.lua`). En su
 * selección, estar en la pila suma +20001-posición, o sea que un dispositivo
 * configurado una vez gana a cualquier otro por prioridad de sesión. Como AGS
 * nunca escribía esa clave desde aquí, los cascos USB no llegaban a entrar en la
 * pila y el HDMI —que sí estaba, puesto por el switch-on-connect de arriba, que
 * siempre usó `wpctl`— ganaba cada rescan.
 *
 * `wpctl set-default` escribe exactamente esa clave, y de paso ahorra tener que
 * traducir el id a `node.name` con un `pactl | awk`. */
const setDefaultEndpoint = (id: number) =>
  execAsync(["wpctl", "set-default", String(id)])

try {
  const wp = AstalWp.get_default()
  const audio = wp?.audio
  if (audio) {
    let settled = false
    let settleTimer: number | null = null

    const armSettle = () => {
      if (settleTimer !== null) GLib.source_remove(settleTimer)
      settleTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, AUDIO_SETTLE_MS, () => {
        settleTimer = null
        // Sin endpoints todavía, WirePlumber no ha enumerado nada: seguir esperando,
        // o la ráfaga que está por llegar se tomaría por conexiones reales.
        if (audio.get_speakers().length === 0) armSettle()
        else settled = true
        return GLib.SOURCE_REMOVE
      })
    }
    armSettle()

    // Un solo `set-default` por ráfaga: si entran dos endpoints casi a la vez, dos
    // execAsync concurrentes pueden resolverse en cualquier orden. Esto los colapsa
    // y deja ganar al último *pedido*, no al último en terminar.
    const switchOnConnect = (skipDisplayOutputs: boolean) => {
      let pending: AstalWp.Endpoint | null = null
      let timer: number | null = null
      return (ep: AstalWp.Endpoint) => {
        pending = ep
        if (timer !== null) GLib.source_remove(timer)
        timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
          timer = null
          const target = pending
          pending = null
          if (target === null) return GLib.SOURCE_REMOVE
          void (async () => {
            if (skipDisplayOutputs && isDisplayOutput(await nodeNameOf(target))) return
            // Un endpoint que el hardware da por muerto tampoco es destino, y aquí
            // el caso NO es teórico: la entrada analógica de la placa (sin nada en
            // ningún jack) se recrea al cambiar el perfil de la tarjeta y llegaba
            // como "micrófono recién conectado", robándole la entrada a los cascos.
            if (esEndpointMuerto(infoEndpoint(target))) return
            await execAsync(["wpctl", "set-default", String(target.id)])
          })().catch(() => {})
          return GLib.SOURCE_REMOVE
        })
      }
    }
    const switchSpeaker = switchOnConnect(true)
    const switchMic = switchOnConnect(false)

    audio.connect("speaker-added", (_, speaker) => {
      if (!settled) { armSettle(); return }
      switchSpeaker(speaker)
    })
    audio.connect("microphone-added", (_, mic) => {
      if (!settled) { armSettle(); return }
      switchMic(mic)
    })
  }
} catch (e) {
  console.error("Failed to init audio switch-on-connect", e)
}

// ── Presets de volumen por aplicación ─────────────────────────────────────────
// El almacén y el vigilante que los aplica viven en
// `servicios/multimedia/presetsApps.ts`: aquí solo queda la UI. Estaban en este fichero
// y esa era la causa del fallo — la aplicación del preset colgaba del sondeo de abajo,
// que solo corre con el submenú abierto, así que una app lanzada con Quick Settings
// cerrado se quedaba con su propio volumen. Ver la cabecera de ese módulo.

// ── Mezcla de aplicaciones: de dónde salen las filas ────────────────────────────
//
// **Antes esto era un sondeo `pactl` cada 2 s** (dos subprocesos por vuelta, ~6 ms) que
// reconstruía la lista entera mientras el submenú estuviera abierto. Se ha ido casi todo:
// AstalWp ya publica los streams nativamente —`audio.streams` son los `Stream/Output/Audio`
// (los sink-inputs de Pulse) y `audio.recorders` los de entrada—, con lista reactiva y
// `notify::volume` por stream. De paso se llevó por delante tres apaños que existían SOLO
// para sostener el sondeo:
//   - el `<For>` deliberadamente **sin `id`**, que reconstruía todas las filas cada 2 s
//     porque era la reconstrucción lo que re-sembraba el volumen mostrado;
//   - el **congelado de 2,5 s** tras tocar el deslizador, para que la siguiente vuelta del
//     sondeo no pisara lo que el usuario estaba arrastrando;
//   - la **firma** `streamsSignature`, que comparaba la lista consigo misma para no
//     republicar objetos nuevos idénticos.
// Hoy cada fila se engancha al volumen de SU stream, así que un cambio hecho desde fuera
// (pavucontrol, `wpctl`, la propia app) se ve al instante en vez de hasta 2 s después.
//
// **Lo que NO puede ser nativo: las apps "en silencio".** Esas filas salen de la lista de
// CLIENTES de PulseAudio, y un cliente de Pulse es un concepto del servidor Pulse que
// WirePlumber no modela — AstalWp no lo expone por ningún lado. Así que ahí sigue un
// `pactl -f json list clients`, pero **sin temporizador**: se pide al abrir el submenú y se
// refresca por eventos (cambia la lista de streams, o Hyprland abre una ventana nueva). Una
// app que empieza o deja de sonar cambia los streams; una app recién lanzada abre una
// ventana. Sin ningún reloj de por medio.
/** Una fila de la mezcla. `stream` a null = app abierta que ahora mismo no suena. */
type FilaApp = { clave: string; props: Record<string, any>; stream: any | null }

const audioWp = (() => {
  try { return AstalWp.get_default()?.audio ?? null } catch { return null }
})()

// ── Apps en silencio (solo altavoces) ──
// El submenú de micrófono nunca las ha tenido: un cliente de Pulse no implica captura, y
// listarlos ahí metía Spotify o el navegador como si estuvieran grabando.
const [clientesSilenciosos, setClientesSilenciosos] = createState<any[]>([])
let mezclaRefs = 0
let refrescoPendiente: number | null = null

function refrescarClientes() {
  if (mezclaRefs === 0) return
  execAsync(["bash", "-c", "pactl -f json list clients 2>/dev/null"])
    .then(salida => {
      const crudo = JSON.parse(salida)
      setClientesSilenciosos(Array.isArray(crudo) ? crudo : (crudo ? [crudo] : []))
    })
    .catch(() => setClientesSilenciosos([]))
}

/** Coalesce: abrir una app dispara varios eventos seguidos (ventana + cliente + stream). */
function pedirRefresco() {
  if (refrescoPendiente !== null || mezclaRefs === 0) return
  refrescoPendiente = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
    refrescoPendiente = null
    refrescarClientes()
    return GLib.SOURCE_REMOVE
  })
}

let idVentanaNueva: number | null = null
const idsAudio: number[] = []

/**
 * El submenú declara que quiere la lista; el refcount la sostiene para todas las
 * instancias (una por monitor). Sin temporizadores: solo la petición inicial y los
 * enganches a eventos, que se sueltan al cerrar.
 */
function activarMezclaApps() {
  mezclaRefs++
  if (mezclaRefs > 1) return
  refrescarClientes()
  // Una app que empieza o deja de sonar cambia de lado (fila viva ↔ fila en silencio), y
  // eso solo lo sabe la lista de clientes. Se engancha a las señales de AstalWp y NO a la
  // lista ya compuesta: refrescar clientes recompone las filas, así que escuchar la
  // composición sería un bucle de 400 ms perpetuo.
  if (audioWp && idsAudio.length === 0) {
    for (const senal of ["stream-added", "stream-removed"]) {
      idsAudio.push(audioWp.connect(senal, () => pedirRefresco()))
    }
  }
  if (idVentanaNueva === null) {
    const hypr = AstalHyprland.get_default()
    // Una app recién lanzada abre su cliente de Pulse sin crear ningún stream (un
    // navegador, Spotify antes de darle a play): sin esta señal no aparecería hasta que
    // algo más moviera la lista. Abrir ventana es el evento que sí ocurre siempre.
    idVentanaNueva = hypr.connect("client-added", () => pedirRefresco())
  }
}

function desactivarMezclaApps() {
  mezclaRefs = Math.max(0, mezclaRefs - 1)
  if (mezclaRefs > 0) return
  if (refrescoPendiente !== null) { GLib.source_remove(refrescoPendiente); refrescoPendiente = null }
  if (idVentanaNueva !== null) {
    try { AstalHyprland.get_default().disconnect(idVentanaNueva) } catch { }
    idVentanaNueva = null
  }
  while (idsAudio.length) {
    try { audioWp?.disconnect(idsAudio.pop()!) } catch { }
  }
}

/** Filas de un submenú: los streams vivos y, para altavoces, las apps en silencio. */
function filasMezcla(tipo: QsAudioKind, streams: any[], clientes: any[]): FilaApp[] {
  const filas: FilaApp[] = []
  // Deduplicación por IDENTIDAD, no por el nombre visible: el cliente de captura de Brave
  // se anuncia como "Brave input" y su stream como "Brave", así que comparando cadenas
  // salían dos filas de la misma app.
  const identidades = new Set<string>()
  for (const stream of streams) {
    const props = propsDeStream(stream)
    identidades.add(claveApp(props))
    filas.push({ clave: `s${stream.id}`, props, stream })
  }
  if (tipo !== "speaker") return filas
  for (const cliente of clientes) {
    const props = cliente.properties
    const clave = claveApp(props)
    if (!clave || identidades.has(clave)) continue
    if (esClienteDeSistema(props)) continue
    if (!tieneEntradaEscritorio(props)) continue
    identidades.add(clave)
    filas.push({ clave: `c${clave}`, props, stream: null })
  }
  return filas
}

// Throttle de escritura durante el arrastre: change-value se dispara en cada píxel, así
// que en vez de un pactl por tick coalescemos a ~60 ms con "trailing" (último valor gana).
function makeVolThrottle(apply: (v: number) => void) {
  let lastVol = 0
  let lastTs = 0
  let timer: number | null = null
  return (v: number) => {
    lastVol = v
    if (timer !== null) return
    const wait = Math.max(0, 60 - (Date.now() - lastTs))
    timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, wait, () => {
      timer = null
      lastTs = Date.now()
      apply(lastVol)
      return GLib.SOURCE_REMOVE
    })
  }
}

// ── Display config & startup apply ────────────────────────────────────────────
// Toda la lógica de pantalla (config load/save, prefs por monitor, poller,
// applyPatch, re-aplicación al arranque, globales y scheduler de luz nocturna)
// vive en display/service.ts — fuente única compartida con la sección Pantalla
// de Ajustes. saveDisplayConfig se importa de ahí y sigue sirviendo al brillo y
// la luz nocturna de este panel.
initDisplayService()

// Algunos adaptadores USB aparecen en BlueZ pero quedan bloqueados por rfkill
// (`PowerState: off-blocked`). En ese estado `bluetoothctl power on` falla con
// org.bluez.Error.Blocked: primero hay que desbloquear la radio y dar tiempo a
// BlueZ para actualizar/crear el controlador. Los portátiles sin bloqueo siguen
// la misma ruta; si no tienen `rfkill`, bluetoothctl conserva el fallback normal.
let bluetoothPowerChanging = false

function bluetoothPowerDelay(ms: number) {
  return new Promise<void>((resolve) => {
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
      resolve()
      return GLib.SOURCE_REMOVE
    })
  })
}

function bluetoothPowerError(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

async function setBluetoothPower(powered: boolean, notifyOnError = true) {
  if (bluetoothPowerChanging) return false
  if (!AstalBluetooth.get_default()?.adapter) return false
  bluetoothPowerChanging = true

  try {
    if (!powered) {
      await execAsync(["bluetoothctl", "power", "off"])
      return true
    }

    // Un dongle puede no estar sujeto a rfkill; no abortamos si el comando no
    // existe o no encuentra radios porque BlueZ aún puede encender el adaptador.
    try {
      await execAsync(["rfkill", "unblock", "bluetooth"])
    } catch (error) {
      console.warn(`No se pudo desbloquear Bluetooth con rfkill: ${bluetoothPowerError(error)}`)
    }

    // Al desbloquear algunos dongles el kernel inicia por sí mismo una transición
    // `off-enabling`; durante ese intervalo BlueZ responde Error.Busy. Otros USB
    // desaparecen unos segundos de BlueZ mientras se reenumeran y vuelven ya
    // encendidos. Dejamos que avance y comprobamos ambas vías en cada intento.
    await bluetoothPowerDelay(250)
    let lastError: unknown = new Error("BlueZ no encontró un controlador Bluetooth")
    for (let attempt = 0; attempt < 16; attempt++) {
      if (AstalBluetooth.get_default()?.isPowered) return true
      try {
        await execAsync(["bluetoothctl", "power", "on"])
        return true
      } catch (error) {
        lastError = error
        await bluetoothPowerDelay(350)
      }
    }
    if (AstalBluetooth.get_default()?.isPowered) return true
    throw lastError
  } catch (error) {
    console.error(`No se pudo ${powered ? "encender" : "apagar"} Bluetooth: ${bluetoothPowerError(error)}`)
    if (notifyOnError) {
      execAsync([
        "notify-send",
        "Bluetooth",
        `No se pudo ${powered ? "encender" : "apagar"} el adaptador`,
      ]).catch(() => {})
    }
    return false
  } finally {
    bluetoothPowerChanging = false
  }
}

function toggleBluetoothPower(bt: any) {
  const objetivo = !bt.isPowered
  // Una acción explícita del usuario cierra la restauración de arranque y pasa a ser la
  // intención vigente: manda lo que acaba de pedir, no lo que había guardado, y es lo que se
  // volverá a aplicar la próxima vez que el dongle reaparezca. Sin cerrar la restauración,
  // encender el BT dentro de la ventana de asentamiento haría que se lo volviera a apagar
  // en la cara.
  finalizarRestauracionBluetooth(objetivo)
  return setBluetoothPower(objetivo)
}

// ── System State Persistence (Wifi, BT, Vol) ──────────────────────────────────
const RUTA_ESTADO_SISTEMA = `${GLib.get_user_config_dir()}/gigios/system_state.json`

function cargarEstadoSistemaGuardado(): Record<string, unknown> {
  if (!GLib.file_test(RUTA_ESTADO_SISTEMA, GLib.FileTest.EXISTS)) return {}

  try {
    const [ok, contenido] = GLib.file_get_contents(RUTA_ESTADO_SISTEMA)
    if (ok) {
      const estado = JSON.parse(new TextDecoder().decode(contenido))
      if (estado && typeof estado === "object" && !Array.isArray(estado)) return estado
    }
  } catch (error) {
    console.warn(`No se pudo leer el estado del sistema: ${bluetoothPowerError(error)}`)
  }
  return {}
}

const estadoSistemaGuardado = cargarEstadoSistemaGuardado()

// Intención Bluetooth del usuario: nace del disco, la fija su pulsación del interruptor y la
// adopta cualquier cambio externo hecho con la restauración ya cerrada y el adaptador presente.
// Es a la vez el OBJETIVO de la restauración y el valor que se persiste. Antes eran dos
// variables —`objetivoBluetoothInicial`, congelada en el arranque, y
// `ultimoEstadoBluetoothConfirmado`, la que se guardaba— y en cuanto la restauración se reabre a
// mitad de sesión (ver `reabrirVentanaRestauracion`) podían decir cosas distintas: la ventana
// nueva habría restaurado el valor del arranque en vez del último que pidió el usuario.
let intencionBluetooth: boolean | null = typeof estadoSistemaGuardado.bluetooth === "boolean"
  ? estadoSistemaGuardado.bluetooth
  : null
let restauracionBluetoothCompletada = intencionBluetooth === null
let restauracionBluetoothEnCurso = false

// Ventana de asentamiento del adaptador. BlueZ registra el adaptador y solo DESPUÉS lo
// enciende por su cuenta (`AutoEnable`); entre las dos cosas el adaptador existe y está
// apagado, que es indistinguible de "el usuario lo dejó apagado". Sin esta espera la
// restauración se cerraba ahí y el power-on posterior de BlueZ se guardaba como decisión
// del usuario: el "apagado" se perdía en cada arranque. Ver `resolverRestauracionBluetooth`.
// Se cuenta desde que el adaptador APARECE, no desde que arranca AGS —igual que el gate de
// audio de arriba—: es un dongle USB y puede tardar en enumerarse, así que una gracia
// contada desde el arranque del shell expiraría antes de que BlueZ llegue siquiera a verlo.
const BT_SETTLE_MS = 5000
let bluetoothAsentado = false
let temporizadorAsentadoBt: number | null = null
/** Última generación vista del adaptador; su alta reabre la ventana de restauración. */
let habiaAdaptadorBluetooth = false

function armarAsentadoBluetooth() {
  if (bluetoothAsentado || temporizadorAsentadoBt !== null) return
  if (!AstalBluetooth.get_default()?.adapter) return
  temporizadorAsentadoBt = GLib.timeout_add(GLib.PRIORITY_DEFAULT, BT_SETTLE_MS, () => {
    temporizadorAsentadoBt = null
    bluetoothAsentado = true
    // Reevalúa: si el estado ya coincidía y solo faltaba asentarse, esto la cierra.
    void restaurarEstadoInicialBluetooth()
    return GLib.SOURCE_REMOVE
  })
}

function finalizarRestauracionBluetooth(intencion?: boolean) {
  bluetoothAsentado = true
  if (temporizadorAsentadoBt !== null) {
    GLib.source_remove(temporizadorAsentadoBt)
    temporizadorAsentadoBt = null
  }
  restauracionBluetoothCompletada = true
  if (intencion !== undefined) intencionBluetooth = intencion
}

/**
 * Reabre la ventana de restauración: el adaptador que tenemos delante es NUEVO para BlueZ, así
 * que su `AutoEnable` va a encenderlo igual que en el arranque y hay que volver a corregirlo.
 * Ver `reabrirVentanaRestauracion` para el porqué; aquí solo se aplica el estado que devuelve.
 */
function rearmarRestauracionBluetooth() {
  const ventana = reabrirVentanaRestauracion(intencionBluetooth)
  if (temporizadorAsentadoBt !== null) {
    GLib.source_remove(temporizadorAsentadoBt)
    temporizadorAsentadoBt = null
  }
  restauracionBluetoothCompletada = ventana.completada
  bluetoothAsentado = ventana.asentado
  // Con intención nula las dos llamadas son no-ops: la ventana nace ya cerrada.
  armarAsentadoBluetooth()
  void restaurarEstadoInicialBluetooth()
}

/**
 * Reabre la ventana también AL DESPERTAR, y no sobra con el alta del adaptador.
 *
 * Que el dongle se reenumere al volver de una suspensión depende del hardware y del modo de
 * suspensión: si el kernel lo recupera con `reset_resume` el objeto de BlueZ nunca desaparece,
 * así que no hay alta que observar — pero el controlador sí ha pasado por un reinicio y BlueZ
 * puede volver a encenderlo. Esto cubre ese caso; cuando sí hay reenumeración las dos rutas se
 * solapan y la segunda reapertura es idempotente.
 *
 * Fail-open: sin logind no hay señal y se degrada al comportamiento de antes.
 */
function vigilarSuspensionBluetooth() {
  // La suscripción al `PrepareForSleep` de logind es común a todo el shell y vive en
  // `servicios/sistema/reanudacion.ts`: aquí había una segunda conexión al bus de sistema
  // haciendo exactamente lo mismo que la de los fondos. El fail-open (sin logind no hay señal
  // y se degrada al comportamiento de antes) está ahora dentro del servicio.
  alReanudar(rearmarRestauracionBluetooth)
}

/**
 * Y la reabre también cuando la radio pasa por un BLOQUEO de rfkill.
 *
 * Tercera vía por la que BlueZ enciende el controlador sin que lo pida nadie, y la única que se
 * reproduce sin privilegios: `rfkill block bluetooth` deja el adaptador en `PowerState:
 * off-blocked` **sin darlo de baja** (el objeto de `org.bluez` sigue ahí), así que no hay alta que
 * observar; al desbloquear, BlueZ lo enciende él solo. Medido en esta máquina con la restauración
 * ya cerrada y `bluetooth: false` en disco: block + unblock terminaba con `Powered: yes` y el
 * fichero reescrito a `true` — el mismo borrado del "apagado" del usuario que los otros dos casos.
 *
 * Se engancha a `off-blocked` (la entrada al bloqueo) y no al encendido posterior, porque es lo
 * único que distingue este encendido de uno que el usuario haya pedido a mano con `bluetoothctl` o
 * blueman: esos **sí** se adoptan, y pelearse con ellos sería peor que el bug. `on-disabling` y
 * `off-enabling`, que son los estados por los que pasa un apagado/encendido normal, se ignoran a
 * propósito.
 */
function vigilarBloqueoRadioBluetooth() {
  try {
    const bus = Gio.bus_get_sync(Gio.BusType.SYSTEM, null)
    bus.signal_subscribe(
      "org.bluez",
      "org.freedesktop.DBus.Properties",
      "PropertiesChanged",
      null,
      "org.bluez.Adapter1",
      Gio.DBusSignalFlags.NONE,
      (_c, _s, _p, _i, _sig, params) => {
        // `lookup_value` de la clave suelta, no `recursiveUnpack()` del `a{sv}` entero: el mismo
        // criterio que la ingesta de notificaciones.
        const estado = params
          .get_child_value(1)
          .lookup_value("PowerState", GLib.VariantType.new("s"))
        if (estado?.get_string()[0] === "off-blocked") rearmarRestauracionBluetooth()
      },
    )
  } catch (error) {
    console.warn(`No se pudo vigilar el bloqueo de radio Bluetooth: ${bluetoothPowerError(error)}`)
  }
}

let temporizadorGuardadoSistema: number | null = null
function programarGuardadoEstadoSistema(demora: number) {
  if (temporizadorGuardadoSistema !== null) GLib.source_remove(temporizadorGuardadoSistema)
  temporizadorGuardadoSistema = GLib.timeout_add(GLib.PRIORITY_DEFAULT, demora, () => {
    try {
      const directorio = GLib.path_get_dirname(RUTA_ESTADO_SISTEMA)
      if (!GLib.file_test(directorio, GLib.FileTest.EXISTS)) GLib.mkdir_with_parents(directorio, 0o755)
      
      const wp = AstalWp.get_default()
      const altavoz = wp?.audio?.defaultSpeaker
      const red = AstalNetwork.get_default()
      const bluetooth = AstalBluetooth.get_default()
      
      const configuracion = {
        wifi: red?.wifi?.enabled ?? true,
        bluetooth: valorBluetoothParaGuardar(
          intencionBluetooth,
          restauracionBluetoothCompletada,
          !!bluetooth?.adapter,
          bluetooth?.isPowered ?? false,
        ),
        volume: altavoz?.volume ?? 0.5,
        mute: altavoz?.mute ?? false
      }
      GLib.file_set_contents(RUTA_ESTADO_SISTEMA, JSON.stringify(configuracion))
    } catch (error) {
      console.warn(`No se pudo guardar el estado del sistema: ${bluetoothPowerError(error)}`)
    }
    temporizadorGuardadoSistema = null
    return GLib.SOURCE_REMOVE
  })
}

function guardarEstadoSistema() {
  programarGuardadoEstadoSistema(2000)
}

function guardarEstadoSistemaAhora() {
  programarGuardadoEstadoSistema(0)
}

function registrarEstadoBluetoothConfirmado() {
  const bluetooth = AstalBluetooth.get_default()
  if (restauracionBluetoothCompletada && bluetooth?.adapter)
    intencionBluetooth = bluetooth.isPowered
}

async function restaurarEstadoInicialBluetooth() {
  if (restauracionBluetoothCompletada || restauracionBluetoothEnCurso) return

  const bluetooth = AstalBluetooth.get_default()
  const estado = resolverRestauracionBluetooth(
    intencionBluetooth,
    !!bluetooth?.adapter,
    bluetooth?.isPowered ?? false,
    bluetoothAsentado,
  )
  if (estado.completada) {
    restauracionBluetoothCompletada = true
    return
  }
  if (estado.accion === null) return

  restauracionBluetoothEnCurso = true
  try {
    await setBluetoothPower(estado.accion, false)
  } finally {
    restauracionBluetoothEnCurso = false
    const bluetoothActual = AstalBluetooth.get_default()
    const estadoActual = resolverRestauracionBluetooth(
      intencionBluetooth,
      !!bluetoothActual?.adapter,
      bluetoothActual?.isPowered ?? false,
      bluetoothAsentado,
    )
    if (estadoActual.completada) {
      restauracionBluetoothCompletada = true
      registrarEstadoBluetoothConfirmado()
      guardarEstadoSistemaAhora()
    }
  }
}

try {
  const wp = AstalWp.get_default()
  const network = AstalNetwork.get_default()
  const bt = AstalBluetooth.get_default()
  
  if (network?.wifi) network.wifi.connect("notify::enabled", guardarEstadoSistema)
  if (bt) {
    const sincronizarEstadoBluetooth = () => {
      // Un adaptador que pasa de ausente a presente es una GENERACIÓN NUEVA para BlueZ, no el
      // mismo de antes: al volver de una suspensión el dongle USB se reenumera y su AutoEnable
      // lo enciende otra vez. Reabrir aquí la ventana de restauración es lo que impide que ese
      // encendido se adopte como decisión del usuario y borre su "apagado" del disco.
      const hayAdaptador = !!bt.adapter
      if (hayAdaptador !== habiaAdaptadorBluetooth) {
        habiaAdaptadorBluetooth = hayAdaptador
        if (hayAdaptador) rearmarRestauracionBluetooth()
      }
      armarAsentadoBluetooth()
      void restaurarEstadoInicialBluetooth()
      registrarEstadoBluetoothConfirmado()
      guardarEstadoSistemaAhora()
    }
    bt.connect("notify::is-powered", sincronizarEstadoBluetooth)
    bt.connect("notify::adapter", sincronizarEstadoBluetooth)
    bt.connect("adapter-added", sincronizarEstadoBluetooth)
    // `adapter-removed` también, y no es simetría gratuita: es lo único que baja
    // `habiaAdaptadorBluetooth` cuando el adaptador desaparece ya apagado (ahí AstalBluetooth
    // no emite `notify::is-powered`, porque su valor no cambia), y sin esa bajada la vuelta del
    // dongle no se vería como generación nueva.
    bt.connect("adapter-removed", sincronizarEstadoBluetooth)
    vigilarSuspensionBluetooth()
    vigilarBloqueoRadioBluetooth()
  }
  if (wp?.audio) {
    wp.audio.connect("notify::default-speaker", () => {
      const spk = wp.audio?.defaultSpeaker
      if (spk) {
        spk.connect("notify::volume", guardarEstadoSistema)
        spk.connect("notify::mute", guardarEstadoSistema)
      }
      guardarEstadoSistema()
    })
    if (wp.audio.defaultSpeaker) {
      wp.audio.defaultSpeaker.connect("notify::volume", guardarEstadoSistema)
      wp.audio.defaultSpeaker.connect("notify::mute", guardarEstadoSistema)
    }
  }
} catch(e) {}

// AstalBluetooth enumera los adaptadores de forma asíncrona. El primer idle cubre
// los ya disponibles y las señales de arriba reintentan cuando BlueZ registra uno;
// hasta entonces las demás escrituras conservan el valor Bluetooth leído del disco.
GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
  // Siembra la generación vista: el adaptador que ya esté aquí no es un alta, su ventana de
  // restauración es la del arranque y ya está abierta. Sin sembrarlo, la primera señal la
  // contaría como generación nueva y reiniciaría el asentamiento sin motivo.
  habiaAdaptadorBluetooth = !!AstalBluetooth.get_default()?.adapter
  armarAsentadoBluetooth()
  void restaurarEstadoInicialBluetooth()
  registrarEstadoBluetoothConfirmado()
  try {
    const network = AstalNetwork.get_default()
    if (network?.wifi) {
      if (estadoSistemaGuardado.wifi === false && network.wifi.enabled)
        execAsync(["nmcli", "radio", "wifi", "off"]).catch(() => {})
      else if (estadoSistemaGuardado.wifi === true && !network.wifi.enabled)
        execAsync(["nmcli", "radio", "wifi", "on"]).catch(() => {})
    }
  } catch(e) {}
  return GLib.SOURCE_REMOVE
})

// ── Utilities ──────────────────────────────────────────────────────────────────

function getTime() { return GLib.DateTime.new_now_local().format("%H:%M") ?? "" }
function getDate() { return GLib.DateTime.new_now_local().format("%A, %-d %B") ?? "" }
function clamp(v: number, lo = 0, hi = 1) { return Math.max(lo, Math.min(hi, v)) }

function toDb(v: number) {
  if (v <= 0.0001) return "-∞"
  // PulseAudio/Pipewire use a cubic curve for perceived volume
  // dB = 20 * log10(v^3) = 60 * log10(v)
  return (60 * Math.log10(v)).toFixed(0)
}

/** Etiqueta de un endpoint, en dos líneas: aparato arriba, perfil abajo.
 * La regla vive en `servicios/multimedia/endpointsAudio.ts` (pura y con test);
 * aquí solo se leen las propiedades de PipeWire. */
function endpointLabel(e: AstalWp.Endpoint): { titulo: string; subtitulo: string } {
  const prop = (k: string) => { try { return e.get_pw_property(k) } catch { return null } }
  return etiquetaEndpoint({
    nick: prop("node.nick"),
    descripcion: e.description,
    perfil: prop("device.profile.description"),
    nombre: e.name,
  })
}

const getBand = (freq: number) => {
  if (freq >= 5900) return "6GHz"
  if (freq >= 4900) return "5GHz"
  if (freq > 0) return "2.4GHz"
  return "—"
}

/** Create a Gtk.Scale (0..1) that stays in sync with a reactive value. */
function makeScale(
  classes: string[],
  getValue: () => number,
  setValue: (v: number) => void,
  subscribe?: (cb: () => void) => void,
  layout: {
    hexpand?: boolean; heightRequest?: number; widthRequest?: number; max?: number
    /** Redondeo/imantado del valor antes de escribirlo (ver `volumenAmplificado.ts`).
     * Los deslizadores de volumen pasan `ajustarVolumen`; el resto no ajusta nada. */
    ajustar?: (v: number) => number
    /** Pinta el deslizador de naranja mientras el valor pasa del 100 %
     * (amplificación por software). Solo para los de volumen. */
    marcarAmplificado?: boolean
  } = {},
): Gtk.Scale {
  const max = layout.max ?? 1
  const ajustar = layout.ajustar ?? ((v: number) => v)
  const adj = new Gtk.Adjustment({
    lower: 0, upper: max,
    stepIncrement: PASO_VOLUMEN, pageIncrement: PASO_VOLUMEN * 5,
  })
  adj.value = clamp(getValue(), 0, max)
  // La clase se recalcula desde el VALOR, no desde quién lo cambió: así también
  // se pinta cuando el volumen lo sube otra herramienta (pavucontrol, `wpctl`).
  const marcarAmplificado = (v: number) => {
    if (!layout.marcarAmplificado) return
    const debe = v > 1
    if (scale.cssClasses.includes("amplificado") === debe) return
    scale.cssClasses = debe ? [...classes, "amplificado"] : classes
  }
  const scale = new Gtk.Scale({
    orientation: Gtk.Orientation.HORIZONTAL,
    adjustment: adj,
    drawValue: false,
    hexpand: layout.hexpand ?? true,
    valign: Gtk.Align.CENTER,
  })
  if (layout.heightRequest !== undefined) scale.heightRequest = layout.heightRequest
  if (layout.widthRequest !== undefined) scale.widthRequest = layout.widthRequest
  scale.cssClasses = classes
  marcarAmplificado(adj.value)
  // Se suscribe DESPUÉS de construir la escala: `marcarAmplificado` la toca.
  if (subscribe) {
    subscribe(() => {
      const v = clamp(getValue(), 0, max)
      adj.value = v
      marcarAmplificado(v)
    })
  }

  // El imán tiene que VERSE, y no basta con escribir el valor imantado: el
  // manejador de `change-value` corre ANTES del predeterminado de GTK, que
  // después pone en el ajuste el valor crudo del ratón — o sea que el relleno se
  // quedaría en el 98,3 % mientras por debajo se escribe el 100 %. Se corrige en
  // un `idle`, ya con GTK fuera; mientras arrastras lo pisa el siguiente evento
  // de movimiento (el tirador sigue al ratón, como debe) y al parar, encaja.
  let correccionPendiente = false
  conectarCambioDeslizador(scale, (val) => {
    const v = ajustar(clamp(val, 0, max))
    setValue(v)
    marcarAmplificado(v)
    if (v === val || correccionPendiente) return
    correccionPendiente = true
    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      correccionPendiente = false
      adj.value = clamp(ajustar(adj.value), 0, max)
      return GLib.SOURCE_REMOVE
    })
  })
  return scale
}

// ── Section 1: Header ─────────────────────────────────────────────────────────

function QsHeader() {
  const notifd = AstalNotifd.get_default()
  const [time, setTime] = createState(getTime())
  const [date, setDate] = createState(getDate())
  const notifs = createBinding(notifd, "notifications")
  const dnd = createBinding(notifd, "dontDisturb")

  // Reloj alineado al minuto y COMPARTIDO con el de la barra
  // (`servicios/sistema/reloj.ts`): `getTime()` no enseña segundos, así que el
  // `setInterval` de 1 s de antes recalculaba la misma cadena 59 de cada 60
  // veces (y por monitor). `ticReloj` ya es un único temporizador de sesión,
  // armado exacto al siguiente cambio de minuto — aquí solo hace falta
  // suscribirse, sin timer propio que abrir y cerrar con la visibilidad del panel.
  ticReloj.subscribe(() => {
    setTime(getTime())
    setDate(getDate())
  })

  return (
    <box cssClasses={["qs-header"]} spacing={0}>
      <box orientation={Gtk.Orientation.VERTICAL} valign={Gtk.Align.CENTER} hexpand>
        <label cssClasses={["qs-clock"]} label={time} halign={Gtk.Align.START} />
        <label cssClasses={["qs-date"]} label={date} halign={Gtk.Align.START} />
      </box>
      <box spacing={6} valign={Gtk.Align.CENTER} halign={Gtk.Align.END} cssClasses={["qs-header-actions"]}>
        {/* Modo ahorro: fuerza el ahorro de energía (forcePowerSave), el mismo
            interruptor de Ajustes > Energía. A la izquierda del modo juego. */}
        <button
          cssClasses={["bar-pill", "nb-pill"]}
          onClicked={() => setForcePowerSave(!forcePowerSave.get())}
        >
          <label
            cssClasses={forcePowerSave((a) => a ? ["nb-icon", "ps-icon", "active"] : ["nb-icon", "ps-icon"])}
            label="󰌪"
          />
        </button>
        {/* Modo juego (Feral GameMode). Oculto si el paquete no está instalado:
            sin `gamemoded` el botón no podría hacer nada. */}
        <button
          visible={gamemodeAvailable}
          cssClasses={["bar-pill", "nb-pill"]}
          onClicked={toggleGamemode}
        >
          <label
            cssClasses={gamemodeActive((a) => a ? ["nb-icon", "gm-icon", "active"] : ["nb-icon", "gm-icon"])}
            label={GAME_GLYPH}
          />
        </button>
        {/* Clic: abre el panel. Clic DERECHO: alterna el "no molestar" del
            daemon, igual que el botón de notificaciones de la barra
            (`modulos/barra/indicadores/notificaciones/BotonNotificaciones.tsx`).
            El icono refleja el estado para que el silencio no sea invisible. */}
        <button
          cssClasses={["bar-pill", "nb-pill"]}
          onClicked={alternarPanelNotificaciones}
        >
          <Gtk.GestureClick
            button={3}
            onPressed={() => { notifd.dontDisturb = !notifd.dontDisturb }}
          />
          <label
            cssClasses={createComputed([dnd, notifs], (d, n) =>
              d ? ["nb-icon", "dnd"] : n.length > 0 ? ["nb-icon", "has-notifs"] : ["nb-icon"])}
            label={dnd((d) => d ? "󰪑" : "󰂚")}
          />
        </button>
      </box>
    </box>
  )
}

// ── Section 2: Tiles ──────────────────────────────────────────────────────────

// ── Section 2: Tiles ──────────────────────────────────────────────────────────

// ── Network Speed Logic (Global) ──────────────────────────────────────────────
const [netSpeed, setNetSpeed] = createState({ up: "0B", down: "0B" })
let lastBytes = { up: 0, down: 0, time: 0 }

const formatSpeed = (bytes: number) => {
  if (bytes < 1024) return `${Math.round(bytes)}B/s`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`
}

const sampleNetSpeed = () => {
  execAsync(["bash", "-c", "cat /proc/net/dev"]).then(out => {
    const lines = out.trim().split("\n")
    let totalDown = 0, totalUp = 0
    lines.forEach(line => {
      if (!line.includes(":")) return
      const [iface, data] = line.split(":")
      if (iface.includes("lo")) return

      const parts = data.trim().split(/\s+/)
      const down = parseInt(parts[0])
      const up = parseInt(parts[8])
      if (!isNaN(down)) totalDown += down
      if (!isNaN(up)) totalUp += up
    })

    const now = Date.now()
    if (lastBytes.time > 0) {
      const delta = (now - lastBytes.time) / 1000
      setNetSpeed({
        down: formatSpeed((totalDown - lastBytes.down) / delta),
        up: formatSpeed((totalUp - lastBytes.up) / delta)
      })
    }
    lastBytes = { down: totalDown, up: totalUp, time: now }
  }).catch(() => { })
}

// El muestreo de velocidad solo corre mientras QS está abierto (se abre poco):
// arranca al abrir y se detiene al cerrar, en vez de un timer eterno gateado que
// despertaba la CPU 1×/s siempre. Al abrir se resiembra lastBytes para que el
// primer tick no calcule un pico sobre todo el tiempo que estuvo cerrado.
let netSpeedTimer: number | null = null
// OJO: el callback de subscribe en gnim se invoca SIN argumentos, hay que leer
// .get() dentro (no `subscribe((v) => …)`, que daría v === undefined siempre).
quickSettingsVisible.subscribe(() => {
  if (quickSettingsVisible.get()) {
    if (netSpeedTimer !== null) return
    lastBytes = { up: 0, down: 0, time: 0 }
    sampleNetSpeed()
    netSpeedTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
      sampleNetSpeed()
      return GLib.SOURCE_CONTINUE
    })
  } else if (netSpeedTimer !== null) {
    GLib.source_remove(netSpeedTimer)
    netSpeedTimer = null
    setNetSpeed({ up: "0B", down: "0B" })
  }
})

function QsTile({ icon, iconWidget, label, subtitle, active, onToggle, onRightClick, subtitleWidthRequest, subtitleMaxWidthChars, claseActiva, avisoActivo, visible = true }: {
  icon: any, iconWidget?: any, label: any, subtitle: any, active: any, onToggle: () => void, onRightClick?: () => void, subtitleWidthRequest?: number,
  /** Tope de ancho NATURAL del subtítulo, en caracteres. `ellipsize` por sí solo
   *  no acota nada: baja el ancho MÍNIMO de la etiqueta, pero su natural sigue
   *  siendo el texto entero, y la rejilla es `homogeneous` — o sea que un
   *  subtítulo largo (el nombre de una webcam: "HP True Vision FHD Camera: HP T")
   *  ensancha su columna, la otra con ella y el panel entero. Mismo remedio que
   *  el `maxWidthChars` del título del popup de notificaciones. */
  subtitleMaxWidthChars?: number,
  /** Clase EXTRA mientras `active` es cierto. La usa la cámara para pintar de
   *  rojo el "alguien está mirando" sobre el resaltado normal (que ahí significa
   *  "no está bloqueada"), en vez del azul de Wi-Fi o Bluetooth. Sale de la misma
   *  derivación que el resto de clases para no acabar con dos fuentes de verdad
   *  del mismo hecho, que es justo lo que le pasó al tile de Bluetooth. */
  claseActiva?: string,
  /** Cuándo aplicar `claseActiva`, si no basta con `active`. Lo usa la cámara:
   *  "alguien está mirando" y "no está bloqueada" son dos hechos distintos que
   *  pueden discrepar —bloquear no corta una captura ya abierta—, así que el
   *  aviso rojo no puede colgar del mismo booleano que el resaltado. Exige que
   *  `active` sea también un accessor, para que los dos entren en el mismo
   *  cómputo y no puedan contradecirse. */
  avisoActivo?: any,
  visible?: any,
}) {
  const construir = (activo: boolean, aviso: boolean) => {
    const clases = ["qs-tile"]
    if (activo) clases.push("active")
    if (aviso && claseActiva) clases.push(claseActiva)
    return clases
  }
  const classes = avisoActivo !== undefined
    ? createComputed([active, avisoActivo], construir)
    : typeof active === "function"
      ? active((a: boolean) => construir(a, a))
      : construir(!!active, !!active)
  return (
    <button cssClasses={classes} onClicked={onToggle} hexpand visible={visible}>
      <Gtk.GestureClick
        button={Gdk.BUTTON_SECONDARY}
        onPressed={onRightClick}
      />
      <box spacing={6} valign={Gtk.Align.CENTER} hexpand>
        {iconWidget || <label cssClasses={["qs-tile-icon"]} label={icon} />}
        <box orientation={Gtk.Orientation.VERTICAL} spacing={0} hexpand>
          <label cssClasses={["qs-tile-label"]} label={label} halign={Gtk.Align.START} />
          <label
            cssClasses={["qs-tile-sub"]}
            label={subtitle}
            halign={Gtk.Align.START}
            xalign={0}
            widthRequest={subtitleWidthRequest}
            maxWidthChars={subtitleMaxWidthChars}
            ellipsize={3}
          />
        </box>
        <label cssClasses={["qs-tile-arrow"]} label="󰅂" halign={Gtk.Align.END} />
      </box>
    </button>
  )
}

// Header "← título [acciones]" compartido por los submenús (Volumen, Micrófono,
// Pantalla, Bluetooth, Wi-Fi). `children` es el slot de acciones a la derecha
// (buscador, botón de ajustes, scan, toggle...), que cada submenú compone a
// mano porque varía bastante entre ellos.
function QsMenuHeader({ title, onBack, titleHexpand = true, children }: {
  title: any, onBack: () => void, titleHexpand?: boolean, children?: any
}) {
  return (
    <box spacing={6} cssClasses={["qs-wifi-header"]} valign={Gtk.Align.CENTER}>
      <button cssClasses={["qs-icon-btn"]} onClicked={onBack}><label label="󰅁" /></button>
      <label cssClasses={["qs-section-label"]} label={title} hexpand={titleHexpand} halign={Gtk.Align.START} />
      {children}
    </box>
  )
}

// Clúster "icono + columna(nombre + subtítulo)" compartido por la fila de
// dispositivo Bluetooth, la fila de red Wi-Fi y la fila de stream de audio.
// `icon` y `subtitle` se pasan como nodos JSX ya construidos por el caller
// (el icono de Wi-Fi es un box de barras de señal, no un <label>) — el botón
// envolvente, los gestos y el trailing de cada fila se quedan en el caller.
function QsRowLabel({ icon, title, titleClass = "qs-wifi-name", subtitle, spacing = 8, valign }: {
  icon: any, title: any, titleClass?: string, subtitle?: any, spacing?: number, valign?: Gtk.Align
}) {
  return (
    <box spacing={spacing} valign={valign}>
      {icon}
      <box orientation={Gtk.Orientation.VERTICAL} hexpand>
        <label label={title} halign={Gtk.Align.START} ellipsize={3} cssClasses={[titleClass]} />
        {subtitle}
      </box>
    </box>
  )
}

function QsTiles({ onWifiClick, onBluetoothClick, onDisplayClick, onAudioClick, onMicClick, onCamaraClick }: {
  onWifiClick: () => void,
  onBluetoothClick: () => void,
  onDisplayClick: () => void,
  onAudioClick: () => void,
  onMicClick: () => void,
  onCamaraClick: () => void
}) {
  const network = AstalNetwork.get_default()
  const wifi = network.wifi
  const bt = AstalBluetooth.get_default()
  const hypr = AstalHyprland.get_default()

  // Tile de red consciente de ethernet: si network.primary es WIRED y el cable
  // está activo, muestra el nombre del perfil de NetworkManager (p. ej. "Casa");
  // si no, mantiene el comportamiento WiFi de siempre mostrando el SSID.
  const NET_P  = AstalNetwork.Primary
  const NET_DS = AstalNetwork.DeviceState
  const ETHERNET_GLYPH = "󰈀"   // nf-md-ethernet
  const computeNetTile = () => {
    const wired = network.wired
    const onWired = network.primary === NET_P.WIRED
      && !!wired && wired.state === NET_DS.ACTIVATED
    if (onWired) return {
      icon: ETHERNET_GLYPH,
      label: network.client.get_primary_connection()?.get_id() || "Ethernet",
      active: true,
    }
    return { icon: "󰤨", label: wifi?.ssid || "Wi-Fi", active: wifi?.enabled ?? false }
  }
  const [netTile, setNetTile] = createState(computeNetTile())
  const syncNetTile = () => setNetTile(computeNetTile())
  network.connect("notify::primary", syncNetTile)
  network.connect("notify::wired", syncNetTile)
  network.connect("notify::wifi", syncNetTile)
  if (wifi) {
    wifi.connect("notify::ssid", syncNetTile)
    wifi.connect("notify::enabled", syncNetTile)
    wifi.connect("notify::strength", syncNetTile)
  }
  if (network.wired) {
    network.wired.connect("notify::state", syncNetTile)
  }
  network.client.connect("notify::primary-connection", syncNetTile)
  network.client.get_primary_connection()?.connect("notify::id", syncNetTile)
  quickSettingsVisible.subscribe(() => {
    if (quickSettingsVisible.get()) syncNetTile()
  })
  const wifiStrength = wifi ? createBinding(wifi, "strength") : null

  // Estado ÚNICO del tile de Bluetooth: icono, texto y CSS (`active`) salen del
  // mismo objeto y del mismo setter. Antes el CSS venía por su cuenta de un
  // `createComputed` sobre `createBinding(bt, "isPowered")` mientras el texto
  // salía de aquí: dos lecturas del mismo hecho actualizadas por handlers
  // distintos de `notify::is-powered`, que GObject invoca en orden de conexión.
  // El del texto se conecta aquí (construcción del componente) y el del binding
  // al renderizar, o sea después, así que el CSS iba un handler por detrás y los
  // dos se contradecían — medido: `CSS=ACTIVE` con `TEXTO="Desactivado"`. Con una
  // sola fuente no hay dos relojes que sincronizar.
  const leerBtInfo = () => getBluetoothTileInfo(!!bt.adapter, bt.isPowered, bt.get_devices())
  const [btInfoState, setBtInfoState] = createState(leerBtInfo())
  const syncBtInfo = () => setBtInfoState(leerBtInfo())
  bt.connect("notify::is-powered", syncBtInfo)
  // Conectar/desconectar un dispositivo YA emparejado no toca la lista, así que
  // `notify::devices` no salta y el tile se quedaba en "Desconectado" con los
  // cascos puestos. `is-connected` ("true si alguno de los devices está
  // conectado") es justo esa señal.
  bt.connect("notify::is-connected", syncBtInfo)
  bt.connect("notify::devices", syncBtInfo)
  bt.connect("notify::adapter", syncBtInfo)
  bt.connect("adapter-added", syncBtInfo)
  bt.connect("adapter-removed", syncBtInfo)
  // Y un resembrado al ABRIR el panel, igual que el tile de red.
  //
  // No sustituye a las señales: cubre que se pierda alguna. `btInfoState` es una FOTO, y una foto
  // que se pierda una emisión miente el resto de la sesión; el interruptor del submenú de
  // Bluetooth es un `createBinding`, que relee la propiedad y por tanto se recompone solo. Esa
  // asimetría es exactamente el síntoma reportado —el texto en "Desactivado" con el interruptor
  // encendido—, así que la foto necesita un punto de reconciliación con lo real, y abrir el panel
  // es el único momento en que alguien mira el tile. No se ha aislado qué emisión concreta se
  // pierde (el ciclo quitar/poner adaptador de AstalBluetooth acaba siempre en un `sync()` que
  // debería notificar), así que esto ataca la clase entera en vez de un caso.
  quickSettingsVisible.subscribe(() => { if (quickSettingsVisible.get()) syncBtInfo() })

  // Monitor enfocado: antes un sondeo `hyprctl activeworkspace -j | jq` cada 5s
  // (con el panel abierto). `focused-monitor` es una propiedad real de
  // AstalHyprland con `notify`, así que se sigue por evento — mismo patrón que
  // los tiles de red y Bluetooth de arriba, incluido el resembrado al abrir
  // por si se pierde una emisión con el panel cerrado.
  const leerMonitor = () => hypr.get_focused_monitor()?.name ?? "Monitor"
  const [monitor, setMonitor] = createState(leerMonitor())
  const syncMonitor = () => setMonitor(leerMonitor())
  hypr.connect("notify::focused-monitor", syncMonitor)
  quickSettingsVisible.subscribe(() => { if (quickSettingsVisible.get()) syncMonitor() })

  const wp = AstalWp.get_default()
  const speaker = wp?.audio?.defaultSpeaker
  const mic = wp?.audio?.defaultMicrophone

  const speakerVol = speaker ? createBinding(speaker, "volume") : null
  const speakerMute = speaker ? createBinding(speaker, "mute") : null
  const micVol = mic ? createBinding(mic, "volume") : null
  const micMute = mic ? createBinding(mic, "mute") : null

  // Icono, subtítulo y resaltado del tile de cámara, del MISMO objeto y el mismo
  // cómputo (la lección del tile de Bluetooth). Las cuatro dependencias van en la
  // forma de ARRAY: con la forma de función y un `&&` por medio, `createComputed`
  // solo se suscribe a lo que leyó en la primera pasada — ver el comentario largo
  // de `indicadores/audio/Microfono.tsx`.
  const infoCamara = createComputed(
    [camaras, estadoCamara, usoCamara, camaraBloqueada],
    (lista, estado, uso, bloqueada) => resumenTileCamara(lista, estado.preferida, uso, bloqueada),
  )

  function volIcon(v: number, m: boolean) {
    if (m || v === 0) return "󰝟"
    if (v < 0.33) return "󰕿"
    if (v < 0.66) return "󰖀"
    return "󰕾"
  }

  return (
    <box cssClasses={["qs-tiles"]} spacing={6} hexpand homogeneous>
      <box orientation={Gtk.Orientation.VERTICAL} spacing={6} hexpand>
        <QsTile
          icon={netTile((t) => t.icon)}
          iconWidget={
            <box cssClasses={["qs-tile-net-icon"]} valign={Gtk.Align.CENTER}>
              <label
                cssClasses={["qs-tile-icon"]}
                label={ETHERNET_GLYPH}
                visible={netTile((t) => t.icon === ETHERNET_GLYPH)}
              />
              <box
                cssClasses={["qs-tile-icon", "qs-tile-wifi-signal"]}
                spacing={1}
                valign={Gtk.Align.CENTER}
                visible={netTile((t) => t.icon !== ETHERNET_GLYPH)}
              >
                <For each={wifiStrength ? wifiStrength((s) => wifiSignalBarClasses(s ?? 0)) : () => wifiSignalBarClasses(0)}>
                  {(classes) => <box cssClasses={classes} valign={Gtk.Align.END} />}
                </For>
              </box>
            </box>
          }
          label={netTile((t) => t.label)}
          subtitle={netSpeed((s) => `󰇚${s.down} 󰕒${s.up}`)}
          subtitleWidthRequest={96}
          active={netTile((t) => t.active)}
          onToggle={onWifiClick}
          onRightClick={() => wifi && execAsync(["bash", "-c", wifi.enabled ? "nmcli radio wifi off" : "nmcli radio wifi on"])}
        />
        <QsTile
          icon={speakerVol && speakerMute ? speakerVol((v) => volIcon(v, speakerMute())) : "󰕾"}
          label="Volumen"
          subtitle={speakerVol ? speakerVol((v) => `${Math.round(v * 100)}`) : "—"}
          active={speakerMute ? speakerMute((m) => !m) : true}
          onToggle={onAudioClick}
          onRightClick={() => { if (speaker) speaker.mute = !speaker.mute }}
        />
        <QsTile
          icon="󰍹"
          label="Pantalla"
          subtitle={monitor}
          active={nightOn}
          onToggle={onDisplayClick}
          onRightClick={() => toggleNightNow()}
        />
      </box>
      <box orientation={Gtk.Orientation.VERTICAL} spacing={6} hexpand>
        <QsTile
          icon={btInfoState((i) => i.icon)}
          label="Bluetooth"
          subtitle={btInfoState((i) => i.label)}
          active={btInfoState((i) => i.active)}
          onToggle={onBluetoothClick}
          onRightClick={() => { void toggleBluetoothPower(bt) }}
        />
        <QsTile
          icon={micMute ? micMute((m) => m ? "󰍭" : "󰍬") : "󰍬"}
          label="Micrófono"
          // `porcentajeMic`, NO `v * 100`: la entrada tiene su propia escala (ver
          // `servicios/multimedia/volumenMicrofono.ts`). Con el crudo, esta
          // pastilla decía 40 mientras su propio submenú decía 100.
          subtitle={micVol ? micVol((v) => `${porcentajeMic(v)}`) : "—"}
          active={micMute ? micMute((m) => !m) : true}
          onToggle={onMicClick}
          onRightClick={() => { if (mic) mic.mute = !mic.mute }}
        />
        {/* Cámara. `visible` atado a `hayCamara`: en un sobremesa sin webcam el
            tile NO existe (GTK no asigna ni reserva espacio a un hijo invisible,
            así que tampoco deja el hueco ni el `spacing` de la columna). Aparece
            y desaparece en caliente al enchufar o quitar una USB, porque
            `hayCamara` cuelga de los `uevent` de udev. */}
        <QsTile
          visible={hayCamara}
          icon={infoCamara((i) => i.icono)}
          label="Cámara"
          subtitle={infoCamara((i) => i.subtitulo)}
          // El nombre de una webcam es largo ("HP True Vision FHD Camera: HP T")
          // y sin tope ensancharía la rejilla y con ella todo el panel.
          subtitleMaxWidthChars={16}
          active={infoCamara((i) => i.activo)}
          avisoActivo={infoCamara((i) => i.enUso)}
          claseActiva="qs-tile-camara-uso"
          onToggle={onCamaraClick}
          // Clic derecho = bloquear/desbloquear, que es lo que anuncia el
          // resaltado, igual que en los demás tiles. La guarda de "ocupado" es
          // la misma que deja insensible el interruptor del submenú: `udevadm
          // settle` tarda un instante y dos órdenes seguidas se pisarían.
          onRightClick={() => {
            if (bloqueoDisponible.get() && !bloqueoOcupado.get()) alternarBloqueo()
          }}
        />
      </box>
    </box>
  )
}


// ── Section 3: Media Player ───────────────────────────────────────────────────

const ACENTO_MEDIA_PREDETERMINADO = "#89b4fa"

type RGB = [number, number, number]

function hexToRgb(hex: string): [number, number, number] {
  const raw = hex.replace("#", "")
  return [
    parseInt(raw.slice(0, 2), 16),
    parseInt(raw.slice(2, 4), 16),
    parseInt(raw.slice(4, 6), 16),
  ]
}

function rgbToCss([r, g, b]: [number, number, number]): string {
  return `rgb(${r}, ${g}, ${b})`
}

function rgbToHsl([r, g, b]: [number, number, number]): [number, number, number] {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l]

  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h = 0
  if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0)
  else if (max === gn) h = (bn - rn) / d + 2
  else h = (rn - gn) / d + 4
  return [h / 6, s, l]
}

function hslToRgb([h, s, l]: [number, number, number]): [number, number, number] {
  if (s === 0) {
    const v = Math.round(l * 255)
    return [v, v, v]
  }

  const hue2rgb = (p: number, q: number, t: number) => {
    if (t < 0) t += 1
    if (t > 1) t -= 1
    if (t < 1 / 6) return p + (q - p) * 6 * t
    if (t < 1 / 2) return q
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
    return p
  }

  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  return [
    Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
    Math.round(hue2rgb(p, q, h) * 255),
    Math.round(hue2rgb(p, q, h - 1 / 3) * 255),
  ]
}

// One UI 8 deriva de la semilla una paleta tonal APAGADA (muteada): tanto el
// tinte del fondo como el seekbar tienen saturación baja. Medido sobre la misma
// carátula, Samsung usa fondo≈HSL(_,0.36,0.18) y seekbar≈HSL(_,0.21,0.51). El
// hue se preserva siempre; lo que corregimos aquí es la SATURACIÓN (antes íbamos
// demasiado saturados) y clavamos el tono.

// Tinte del fondo: oscuro y MUTEADO. Se pinta a alpha bajo para que la carátula
// se siga viendo por debajo (como en el teléfono).
function oneUiBgTone(rgb: [number, number, number]): [number, number, number] {
  const [h, s] = rgbToHsl(rgb)
  const sat = Math.min(0.42, s * 0.6 + 0.06) // apagado, tope ~Samsung 0.36–0.42
  const lum = 0.18 + Math.min(1, s) * 0.05   // ~0.18–0.23
  return hslToRgb([h, sat, lum])
}

// Seekbar / acento activo: mismo hue, periwinkle MUTEADO y de tono medio,
// legible sobre el fondo oscuro (Samsung ≈ HSL(_,0.21,0.51)).
function oneUiFgTone(rgb: [number, number, number]): [number, number, number] {
  const [h, s] = rgbToHsl(rgb)
  const sat = Math.min(0.30, s * 0.4 + 0.08)
  return hslToRgb([h, sat, 0.55])
}

// Tono COMPAÑERO de las ondas: sale de la misma semilla que el resto de la tarjeta,
// pero con reglas propias, para que las dos ondas no sean el mismo color repetido a
// distinto alfa. Tres diferencias respecto a `oneUiFgTone`, y las tres importan:
// gira el hue ~27° (análogo — un giro mayor se pelea con la carátula, del que sale
// el color), sube algo la saturación y sobre todo lo **aclara** (0.68 frente a 0.55).
// La luminosidad es lo que de verdad separa las dos ondas cuando la carátula es
// monocroma y el giro de hue no se aprecia: ahí la diferencia de color no existiría
// y seguirían distinguiéndose por claridad.
function oneUiOndaTone(rgb: [number, number, number]): [number, number, number] {
  const [h, s] = rgbToHsl(rgb)
  const hue = (h + 0.075) % 1
  const sat = Math.min(0.46, s * 0.55 + 0.16)
  return hslToRgb([hue, sat, 0.68])
}

function cssRgbToTuple(rgb: string): [number, number, number] {
  const values = rgb.match(/\d+/g)?.map(Number)
  if (!values || values.length < 3) return hexToRgb(ACENTO_MEDIA_PREDETERMINADO)
  return [values[0], values[1], values[2]]
}

// Los tres tonos derivados de la semilla se calculan MEMORIZADOS por cadena de
// acento. No es una micro-optimización gratuita: `progressArea` los pedía en cada
// frame de las ondas (30 fps), y cada llamada hace un `match` con regex, dos
// conversiones RGB→HSL→RGB y varias asignaciones de array. El acento solo cambia
// cuando cambia la carátula, así que todo eso era trabajo repetido y basura para el
// GC en el único sitio del shell que dibuja continuamente.
type TonosAcento = { fondo: RGB; acento: RGB; companero: RGB }
let tonosMemo: { clave: string; tonos: TonosAcento } | null = null

function tonosDeAcento(css: string): TonosAcento {
  if (tonosMemo === null || tonosMemo.clave !== css) {
    const semilla = cssRgbToTuple(css)
    tonosMemo = {
      clave: css,
      tonos: {
        fondo: oneUiBgTone(semilla),
        acento: oneUiFgTone(semilla),
        companero: oneUiOndaTone(semilla),
      },
    }
  }
  return tonosMemo.tonos
}

function formatMediaTime(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0:00"
  const total = Math.floor(value)
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${minutes}:${seconds.toString().padStart(2, "0")}`
}

// Extrae el color "semilla" de la carátula igual que hace la máquina monet de
// One UI 8 (Material Color Utilities → Score): puntúa por CROMA + población, sin
// sesgo de luminancia. El código viejo penalizaba/premiaba por luminancia
// ("darkFit") y calidez ("warmBias"), lo que a veces elegía un color distinto al
// de Samsung → de ahí las inversiones "aquí oscuro / allí claro".
function dominantPixbufColor(pixbuf: GdkPixbuf.Pixbuf): [number, number, number] {
  const pixels = pixbuf.get_pixels()
  const width = pixbuf.get_width()
  const height = pixbuf.get_height()
  const channels = pixbuf.get_n_channels()
  const rowstride = pixbuf.get_rowstride()
  const step = Math.max(1, Math.floor(Math.min(width, height) / 28))
  const buckets = new Map<string, { r: number; g: number; b: number; chroma: number; count: number }>()
  let total = 0

  for (let y = 0; y < height; y += step) {
    const row = y * rowstride
    for (let x = 0; x < width; x += step) {
      const i = row + x * channels
      const r = pixels[i]
      const g = pixels[i + 1]
      const b = pixels[i + 2]
      const max = Math.max(r, g, b)
      const min = Math.min(r, g, b)
      const chroma = max - min // 0..255, proxy perceptual de croma (HCT-lite)
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b

      total += 1
      // Descarta casi-negro, casi-blanco y casi-gris; el resto SÍ compite,
      // incluidos colores oscuros y saturados (Samsung sí los elige de semilla).
      if (lum < 14 || lum > 236 || chroma < 16) continue

      const qr = r >> 5
      const qg = g >> 5
      const qb = b >> 5
      const key = `${qr},${qg},${qb}`
      const bucket = buckets.get(key) || { r: 0, g: 0, b: 0, chroma: 0, count: 0 }
      bucket.r += r
      bucket.g += g
      bucket.b += b
      bucket.chroma += chroma
      bucket.count += 1
      buckets.set(key, bucket)
    }
  }

  // Score al estilo Material: proporción·0.7 + (croma-48)·peso. El croma manda,
  // pero un color muy poblado y algo menos saturado puede ganar (como en monet).
  const TARGET_CHROMA = 48
  let best: { r: number; g: number; b: number; chroma: number; count: number } | null = null
  let bestScore = -Infinity
  for (const bucket of buckets.values()) {
    const proportion = total > 0 ? bucket.count / total : 0
    const chroma = (bucket.chroma / bucket.count) / 255 * 100 // 0..100
    if (chroma < 5) continue
    const proportionScore = proportion * 100 * 0.7
    const chromaScore = chroma < TARGET_CHROMA
      ? (chroma - TARGET_CHROMA) * 0.1
      : (chroma - TARGET_CHROMA) * 0.3
    const score = proportionScore + chromaScore
    if (!best || score > bestScore) {
      best = bucket
      bestScore = score
    }
  }
  if (!best || best.count <= 0) return hexToRgb(ACENTO_MEDIA_PREDETERMINADO)

  return [
    Math.round(best.r / best.count),
    Math.round(best.g / best.count),
    Math.round(best.b / best.count),
  ]
}

function QsMedia() {
  const hypr = AstalHyprland.get_default()

  const [title, setTitle] = createState("Sin reproducción")
  const [artist, setArtist] = createState("")
  const [isPlaying, setIsPlaying] = createState(false)
  const [prog, setProg] = createState(0)
  const [positionLabel, setPositionLabel] = createState("")
  const [durationLabel, setDurationLabel] = createState("")
  const [hasProgress, setHasProgress] = createState(false)
  const [hasPlayer, setHasPlayer] = createState(false)
  const [cover, setCover] = createState("")
  const [playerIndex, setPlayerIndex] = createState(0)
  const [numPlayers, setNumPlayers] = createState(0)
  const [playerName, setPlayerName] = createState("")
  const [coverAccent, setCoverAccent] = createState(ACENTO_MEDIA_PREDETERMINADO)
  const [trackId, setTrackIdState] = createState<string | null>(null)
  const [isAdState, setIsAd] = createState(false)
  const [liked, setLiked] = createState(false)
  const [likeVisible, setLikeVisible] = createState(false)
  const [canLike, setCanLike] = createState(false)
  let lastQueriedId: string | null = null

  const playerGlyph = new Gtk.Label({
    cssClasses: ["qs-media-app-glyph"],
    visible: false,
    valign: Gtk.Align.CENTER,
  })

  const playerIcon = new Gtk.Image({
    iconName: "audio-x-generic-symbolic",
    pixelSize: 14,
    cssClasses: ["qs-media-app-icon"],
    valign: Gtk.Align.CENTER,
  })

  const playerAppIcon = new Gtk.Box({
    valign: Gtk.Align.CENTER,
    marginBottom: 6,
  })
  playerAppIcon.append(playerGlyph)
  playerAppIcon.append(playerIcon)

  const resolverIconoReproductor = (player: any): Gio.Icon | null => {
    const entry = String(player.entry || "").trim()
    const busId = String(player.bus_name || "")
      .replace(/^org\.mpris\.MediaPlayer2\./i, "")
      .replace(/\.instance[^.]*$/i, "")
    const identity = String(player.identity || "")
    // El índice compartido ya cachea Gio.AppInfo y se invalida cuando cambian las
    // aplicaciones instaladas; evitar otro recorrido y otra caché por monitor.
    return obtenerEntradaEscritorio({ class: entry, initialClass: busId })?.icono
      ?? obtenerEntradaEscritorio({ class: identity })?.icono
      ?? null
  }

  // El corazón solo necesita credenciales: "Me gusta" también funciona en cuentas
  // free. Se resuelve una vez (async) y se cachea aquí para leerlo síncronamente en
  // update(); si la API niega la biblioteca, `isLiked` responde `denied` y se oculta.
  let desmontado = false
  Spotify.isConfigured().then((configurado) => {
    if (desmontado) return
    setCanLike(configurado)
    update()
  })

  let currentP: any = null
  let mediaContentWidget: Gtk.Widget | null = null
  let switchingPlayer = false
  const fallbackLengths = new Map<string, number>()
  const pendingLengthQueries = new Set<string>()
  const lengthQueryAttempts = new Map<string, number>()
  const primedFirefoxTracks = new Set<string>()
  let sessionBus: Gio.DBusConnection | null = null

  // Firefox tiene una carrera conocida en su bridge MPRIS: si el servicio se
  // registra después de durationchange, Metadata nace sin mpris:length y no lo
  // vuelve a calcular hasta el siguiente comando que cambia el estado. Un ciclo
  // Pause/Play consecutivo conserva el estado PLAYING y fuerza ese cálculo. Solo
  // se usa una vez por pista, con el panel abierto y si ambos comandos existen.
  const primeFirefoxLength = (busName: string): boolean => {
    try {
      sessionBus ??= Gio.bus_get_sync(Gio.BusType.SESSION, null)
      const call = (method: "Pause" | "Play") => sessionBus!.call_sync(
        busName,
        "/org/mpris/MediaPlayer2",
        "org.mpris.MediaPlayer2.Player",
        method,
        null,
        null,
        Gio.DBusCallFlags.NONE,
        500,
        null,
      )
      call("Pause")
      call("Play")
      return true
    } catch (_) {
      return false
    }
  }

  const temporizadoresTransitorios = new Set<number>()
  let duracionActual: number | null = null

  // ── Arrastre de la cabeza de reproducción ───────────────────────────────────
  // `puedeBuscar` se refresca en cada sondeo desde `can_seek`; sin él el tirador
  // se ofrecería también en fuentes que no admiten Seek (radios, streams en vivo).
  // Se trata `undefined` como "sí": hay reproductores que no publican la propiedad
  // y sí obedecen SetPosition, y esconder el tirador ahí sería peor que intentarlo.
  let puedeBuscar = false
  let arrastrando = false
  // `progressArea` se construye más abajo (con el resto del lienzo de ondas) y
  // `update()` ya ha corrido para entonces: la petición de repintado va por esta
  // indirección para no leer la constante antes de su inicialización.
  let repintarProgreso: () => void = () => {}
  let fraccionArrastre = 0
  let hoverProgreso = false
  // Tras un Seek el reproductor tarda en publicar la nueva posición (hasta el
  // siguiente tick de 1 s). Sin esta gracia el sondeo devolvía la posición VIEJA y
  // la barra saltaba hacia atrás un instante antes de aterrizar donde se soltó.
  let posicionBuscada: number | null = null
  let buscadaHastaUs = 0
  const SEEK_GRACIA_US = 1_500_000
  const SEEK_TOLERANCIA_S = 1.5

  /** Actualiza solo los datos que avanzan con el tiempo; es la única ruta sondeada. */
  const actualizarPosicion = () => {
    const p = currentP
    if (!p || duracionActual === null) {
      if (puedeBuscar) { puedeBuscar = false; repintarProgreso() }
      arrastrando = false
      posicionBuscada = null
      setHasProgress(false)
      setProg(0)
      setPositionLabel("")
      setDurationLabel("")
      return
    }

    const buscableAhora = p.can_seek !== false
    if (buscableAhora !== puedeBuscar) { puedeBuscar = buscableAhora; repintarProgreso() }

    // Mientras el dedo está en la barra la fuente de verdad es el gesto, no el
    // reproductor: dejar entrar el sondeo aquí haría vibrar el tirador bajo el ratón.
    if (arrastrando) return

    const posicion = safeMediaPosition(p.position, duracionActual)
    if (posicionBuscada !== null) {
      const llego = Math.abs(posicion - posicionBuscada) <= SEEK_TOLERANCIA_S
      if (llego || GLib.get_monotonic_time() > buscadaHastaUs) posicionBuscada = null
      else return
    }
    setHasProgress(true)
    setProg(posicion / duracionActual)
    setPositionLabel(formatMediaTime(posicion))
    setDurationLabel(formatMediaTime(duracionActual))
  }

  /** Lleva la reproducción a `fraccion` (0..1) de la pista. */
  const buscarEnPista = (fraccion: number) => {
    const p = currentP
    if (!p || duracionActual === null || duracionActual <= 0) return
    const destino = Math.max(0, Math.min(duracionActual, fraccion * duracionActual))
    try { p.position = destino } catch (_) { return }
    posicionBuscada = destino
    buscadaHastaUs = GLib.get_monotonic_time() + SEEK_GRACIA_US
    setProg(destino / duracionActual)
    setPositionLabel(formatMediaTime(destino))
  }

  /** Recalcula la duración únicamente cuando cambia el estado MPRIS o el jugador. */
  const actualizarDuracion = () => {
    const p = currentP
    if (!p) {
      duracionActual = null
      actualizarPosicion()
      return
    }

    let duracionMprisCruda: unknown = null
    try { duracionMprisCruda = p.get_meta?.("mpris:length")?.deep_unpack?.() } catch (_) {}

    const claveProgreso = `${p.bus_name || ""}\0${p.trackid || ""}\0${p.title || ""}`
    const duracionDirecta = resolveMediaLengthSeconds(p.length, duracionMprisCruda)
    duracionActual = duracionDirecta ?? fallbackLengths.get(claveProgreso) ?? null

    if (duracionActual !== null) {
      actualizarPosicion()
      return
    }

    actualizarPosicion()

    // Un directo SÍ publica duración, solo que imposible (un Int64 gigante). No
    // hay nada que recuperar: los rodeos de abajo buscan un `mpris:length` que
    // aún no ha llegado, y aquí ya llegó. Insistir costaría un Pause+Play en
    // Firefox — un corte de audio real — por cada retransmisión.
    if (isLiveStreamLength(p.length, duracionMprisCruda)) return

    const esFirefox = String(p.bus_name || "").toLowerCase().includes("firefox")
    const puedePrepararFirefox = esFirefox
      && quickSettingsVisible.get()
      && obtenerEstadoReproductor(p)?.reproduciendo === true
      && p.can_pause
      && p.can_play
      && !primedFirefoxTracks.has(claveProgreso)

    if (puedePrepararFirefox) {
      primedFirefoxTracks.add(claveProgreso)
      if (primeFirefoxLength(p.bus_name)) {
        const idTemporizador = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
          temporizadoresTransitorios.delete(idTemporizador)
          if (!desmontado && currentP === p) actualizarDuracion()
          return GLib.SOURCE_REMOVE
        })
        temporizadoresTransitorios.add(idTemporizador)
        return
      }
    }

    // Astal puede conservar Metadata vacío al registrar Firefox. Consultamos la
    // fuente MPRIS real con un límite corto y cacheamos la duración encontrada.
    const intentos = lengthQueryAttempts.get(claveProgreso) ?? 0
    if (intentos >= 3 || pendingLengthQueries.has(claveProgreso)) return

    const nombreReproductor = String(p.bus_name || "").replace(/^org\.mpris\.MediaPlayer2\./, "")
    if (!nombreReproductor) return
    lengthQueryAttempts.set(claveProgreso, intentos + 1)
    pendingLengthQueries.add(claveProgreso)
    execAsync(["playerctl", "-p", nombreReproductor, "metadata", "mpris:length"])
      .then((salida) => {
        if (desmontado) return
        const duracionAlternativa = resolveMediaLengthSeconds(0, salida.trim())
        if (duracionAlternativa !== null) {
          fallbackLengths.set(claveProgreso, duracionAlternativa)
          while (fallbackLengths.size > 32) {
            const masAntigua = fallbackLengths.keys().next().value
            if (masAntigua === undefined) break
            fallbackLengths.delete(masAntigua)
          }
        }
        pendingLengthQueries.delete(claveProgreso)
        if (duracionAlternativa !== null && currentP === p) actualizarDuracion()
      })
      .catch(() => pendingLengthQueries.delete(claveProgreso))
  }

  /** Metadatos y reproducción llegan por señales desde el servicio MPRIS único. */
  const update = () => {
    const players = reproductoresMultimedia.get()
    setNumPlayers(players.length)
    if (players.length === 0) {
      currentP = null
      duracionActual = null
      setHasPlayer(false)
      actualizarPosicion()
      return
    }

    let idx = playerIndex.get()
    if (idx >= players.length) {
      idx = 0
      setPlayerIndex(0)
    }

    const p = players[idx]
    if (!p) {
      currentP = null
      duracionActual = null
      setHasPlayer(false)
      actualizarPosicion()
      return
    }

    const estado = obtenerEstadoReproductor(p)
    if (!estado) return
    currentP = p
    setHasPlayer(true)
    const rawTrackId = estado.trackIdCrudo
    const ad = estado.esAnuncio
    const id = Spotify.parseTrackId(rawTrackId)
    const esSpotify = estado.esSpotify
    setIsAd(ad)
    setTitle(estado.titulo)
    setArtist(estado.artista)

    setLikeVisible(esSpotify && canLike.get() && !ad && id !== null)

    // Consultar "liked" solo al CAMBIAR de track (no en cada tick de 1 s).
    if (!ad && id && canLike.get()) {
      if (id !== lastQueriedId) {
        lastQueriedId = id
        setTrackIdState(id)
        Spotify.isLiked(id).then((estado) => {
          if (desmontado || lastQueriedId !== id) return
          if (estado === "denied") {
            setCanLike(false)
            setLikeVisible(false)
            return
          }
          if (estado !== "unavailable") setLiked(estado === "liked")
        })
      }
    } else {
      lastQueriedId = null
    }

    setIsPlaying(estado.reproduciendo)
    setCover(estado.caratula)
    setPlayerName(p.identity || p.bus_name.split(".").pop() || "Player")
    const entry = String(p.entry || "").replace(/\.desktop$/i, "")
    const busId = String(p.bus_name || "")
      .replace(/^org\.mpris\.MediaPlayer2\./i, "")
      .replace(/\.instance[^.]*$/i, "")
    const identity = String(p.identity || "")
    const glyph = getIcon(entry, busId, p.bus_name, identity, identity.replace(/\s+/g, "-"))

    if (glyph) {
      playerGlyph.set_label(glyph)
      playerGlyph.set_visible(true)
      playerIcon.set_visible(false)
    } else {
      const appIcon = resolverIconoReproductor(p)
      if (appIcon) playerIcon.set_from_gicon(appIcon)
      else playerIcon.set_from_icon_name("audio-x-generic-symbolic")
      playerGlyph.set_visible(false)
      playerIcon.set_visible(true)
    }
    actualizarDuracion()
  }

  const switchPlayer = (step: -1 | 1) => {
    const players = reproductoresMultimedia.get()
    if (players.length <= 1 || switchingPlayer) return

    const widget = mediaContentWidget
    if (!widget) {
      setPlayerIndex((playerIndex.get() + step + players.length) % players.length)
      update()
      return
    }

    switchingPlayer = true
    const direction = step > 0 ? "next" : "prev"
    const exitClass = `switch-out-${direction}`
    const enterClass = `switch-enter-${direction}`
    widget.add_css_class(exitClass)

    const idSalida = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 110, () => {
      temporizadoresTransitorios.delete(idSalida)
      if (desmontado) return GLib.SOURCE_REMOVE
      const currentPlayers = reproductoresMultimedia.get()
      if (currentPlayers.length > 1) {
        setPlayerIndex((playerIndex.get() + step + currentPlayers.length) % currentPlayers.length)
        update()
      }

      // Coloca el nuevo contenido, todavía invisible, al lado opuesto. Un frame
      // después retiramos la clase para que la transición base lo lleve al centro.
      widget.remove_css_class(exitClass)
      widget.add_css_class(enterClass)
      const idEntrada = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {
        temporizadoresTransitorios.delete(idEntrada)
        if (desmontado) return GLib.SOURCE_REMOVE
        widget.remove_css_class(enterClass)
        const idFin = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 130, () => {
          temporizadoresTransitorios.delete(idFin)
          switchingPlayer = false
          return GLib.SOURCE_REMOVE
        })
        temporizadoresTransitorios.add(idFin)
        return GLib.SOURCE_REMOVE
      })
      temporizadoresTransitorios.add(idEntrada)
      return GLib.SOURCE_REMOVE
    })
    temporizadoresTransitorios.add(idSalida)
  }

  const nextPlayer = () => switchPlayer(1)
  const prevPlayer = () => switchPlayer(-1)

  const focusPlayerWindow = () => {
    const player = reproductoresMultimedia.get()[playerIndex.get()]
    const client = findMediaClient(player, hypr.get_clients?.() ?? [])
    if (!client?.address) return

    const address = String(client.address)
    const normalized = address.startsWith("0x") ? address : `0x${address}`
    closeAllPanels()
    execAsync(["hyprctl", "dispatch", `hl.dsp.focus({window='address:${normalized}'})`]).catch(() => {})
  }

  // El sondeo de posición solo corre con el panel abierto: al cerrar se REMUEVE el
  // timer, no basta con saltarse el cuerpo. Antes se armaba una vez y vivía toda la
  // sesión comprobando la visibilidad — 86.400 despertares del bucle principal al día
  // (y por monitor) para no hacer nada. Mismo patrón que netSpeedTimer (el
  // reloj, arriba, ya no lo necesita: comparte el tic de minuto de la barra).
  update()
  let mediaTimer: number | null = null
  const cancelarRevision = revisionMultimedia.subscribe(update)
  const cancelarVisibilidad = quickSettingsVisible.subscribe(() => {
    if (quickSettingsVisible.get()) {
      update()
      if (mediaTimer === null) {
        mediaTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
          actualizarPosicion()
          return GLib.SOURCE_CONTINUE
        })
      }
    } else if (mediaTimer !== null) {
      GLib.source_remove(mediaTimer)
      mediaTimer = null
    }
  })

  // Fondo con Gtk.Picture (el background-image CSS no renderiza en este contenedor).
  const coverPicture = new Gtk.Picture()
  coverPicture.set_content_fit(Gtk.ContentFit.COVER)
  coverPicture.set_can_shrink(true)
  coverPicture.set_hexpand(true)
  coverPicture.set_vexpand(true)

  // La Picture propaga el tamaño natural de la imagen (grande) y desbordaba la tarjeta.
  // Un ScrolledWindow con propagate_natural_height=false + min/max_content_height
  // CORTA la altura del fondo pase lo que pase con la imagen. Es el hijo principal
  // del Overlay; así el Overlay no puede crecer más que la tarjeta.
  // 94 hasta que las ondas pidieron aire: el bloque de metadatos subió 5 px y el pie
  // (barra, ondas, botones y tiempos) bajó 3, y la tarjeta NO tenía holgura — medido
  // con `grim`, el contenido ocupaba los 94 justos, así que crece con ellos. Tiene
  // que ir a la par que el `min-height` de `.qs-media` en style.scss: aquí es el
  // alto que se pide al contenido y a los DrawingArea del fondo (filtro y scrim).
  const CARD_H = 108
  // 70% del ancho útil: (panel 330 - padding panel 20 - padding media 28) × 0.7.
  const MEDIA_SOURCE_MAX_W = 197
  const MEDIA_SOURCE_MAX_CHARS = 32
  // El contenido útil de la tarjeta son 282 px. Sin este tope, el tamaño natural
  // de una etiqueta larga se propaga al Overlay antes de que `ellipsize` actúe.
  const MEDIA_METADATA_MAX_CHARS = 42
  const MEDIA_TIME_MAX_CHARS = 10
  const bgCap = new Gtk.ScrolledWindow()
  bgCap.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.NEVER)
  bgCap.set_propagate_natural_height(false)
  bgCap.set_min_content_height(CARD_H)
  bgCap.set_max_content_height(CARD_H)
  bgCap.set_hexpand(true)
  bgCap.set_child(coverPicture)
  const applyCover = () => {
    const c = cover.get()
    // Los anuncios SÍ pintan carátula si Spotify la publica; si no hay imagen,
    // cover queda "" y cae al fondo base como antes.
    if (!c || c.startsWith("http")) { coverPicture.set_paintable(null); return }
    const path = c.startsWith("file://") ? c.slice(7) : c
    try {
      const pixbuf = GdkPixbuf.Pixbuf.new_from_file(path)
      // Guardamos la semilla cruda; el tono (fondo oscuro / seekbar claro) se
      // deriva en cada sitio de dibujo con oneUiBgTone / oneUiFgTone.
      setCoverAccent(rgbToCss(dominantPixbufColor(pixbuf)))
      coverPicture.set_paintable(Gdk.Texture.new_for_pixbuf(pixbuf))
    } catch (_) { coverPicture.set_paintable(null) }
  }
  const cancelarCaratula = cover.subscribe(applyCover)
  const cancelarAnuncioCaratula = isAdState.subscribe(applyCover)
  applyCover()

  // bgCap es una Picture/ScrolledWindow (textura) y colorFilter/coverScrim son
  // Gtk.DrawingArea (superficie cairo): a escala fraccional (p. ej. 1.25) cada
  // una redondea su alto físico por su cuenta, y aunque pidan el mismo CARD_H
  // pueden acabar 1px más cortas que el fondo que deben cubrir. cr.paint() ya
  // cubre TODO el clip del DrawingArea, pero no puede pintar fuera de él — así
  // que se les añade un margen inferior negativo (`.qs-media-bleed` en
  // estilos/style.scss, fuera del clamp ≥0 de la propiedad margin-bottom de
  // GtkWidget) para que sobresalgan por abajo; el `overflow: HIDDEN` de
  // `.qs-media` recorta ese sobrante.
  const colorFilter = new Gtk.DrawingArea()
  colorFilter.set_can_target(false)
  colorFilter.set_halign(Gtk.Align.FILL)
  colorFilter.set_valign(Gtk.Align.FILL)
  colorFilter.set_hexpand(true)
  colorFilter.set_vexpand(true)
  colorFilter.set_content_width(1)
  colorFilter.set_content_height(CARD_H)
  colorFilter.add_css_class("qs-media-bleed")
  colorFilter.set_draw_func((_area, cr, _width, _height) => {
    if (!cover.get()) return
    const [r, g, b] = tonosDeAcento(coverAccent.get()).fondo
    // Alpha medio: unifica el color pero DEJA VER la carátula por debajo, como
    // hace One UI (no un bloque opaco).
    cr.setSourceRGBA(r / 255, g / 255, b / 255, 0.45)
    // paint() cubre todo el clip real del DrawingArea. Un rectángulo de `height`
    // unidades podía terminar entre píxeles con escalas fraccionales (p. ej. 1.25)
    // y dejar la última fila parcialmente sin filtrar.
    cr.paint()
  })
  const queueColorFilter = () => colorFilter.queue_draw()
  const cancelarFiltroCaratula = cover.subscribe(queueColorFilter)
  const cancelarFiltroAnuncio = isAdState.subscribe(queueColorFilter)
  const cancelarFiltroAcento = coverAccent.subscribe(queueColorFilter)

  const coverScrim = new Gtk.DrawingArea()
  coverScrim.set_can_target(false)
  coverScrim.set_halign(Gtk.Align.FILL)
  coverScrim.set_valign(Gtk.Align.FILL)
  coverScrim.set_hexpand(true)
  coverScrim.set_vexpand(true)
  coverScrim.set_content_width(1)
  coverScrim.set_content_height(CARD_H)
  coverScrim.add_css_class("qs-media-bleed")
  coverScrim.set_draw_func((_area, cr, _width, height) => {
    if (!cover.get()) return
    // Degradado vertical real: arriba casi transparente (se ve la carátula), abajo
    // oscuro para dar contraste al texto/controles. Igual que One UI.
    try {
      const grad = new (cairo as any).LinearGradient(0, 0, 0, height)
      grad.addColorStopRGBA(0, 0, 0, 0, 0.10)
      grad.addColorStopRGBA(0.55, 0, 0, 0, 0.30)
      grad.addColorStopRGBA(1, 0, 0, 0, 0.58)
      cr.setSource(grad)
      cr.paint()
    } catch (_) {
      // Fallback si el binding de GJS no expone LinearGradient: scrim plano.
      cr.setSourceRGBA(0, 0, 0, 0.34)
      cr.paint()
    }
  })
  const queueCoverScrim = () => coverScrim.queue_draw()
  const cancelarScrimCaratula = cover.subscribe(queueCoverScrim)
  const cancelarScrimAnuncio = isAdState.subscribe(queueCoverScrim)

  // La barra de progreso ocupa los 4 px de abajo; el resto del área lo llenan dos
  // ondas viajeras que salen de ella hacia arriba, dentro del tramo ya reproducido.
  // El alto pedido (20) NO lo paga el layout: `.qs-media-progress-ondas` lo devuelve
  // con un margen superior negativo (ver style.scss).
  const PROGRESO_ALTO = 20
  const PROGRESO_BARRA = 4
  // El tirador de arrastre es un círculo CENTRADO en la barra: su mitad inferior
  // cae por debajo de los 4 px de la barra, que antes era el borde del lienzo — ahí
  // GTK lo recortaba y se veía medio círculo plano. Se pide esa holgura extra de
  // alto y `.qs-media-progress-ondas` la devuelve con un margen inferior negativo
  // (igual que ya hacía arriba con las ondas), así el layout de la tarjeta no cambia.
  const TIRADOR_R = 5.5
  const TIRADOR_R_ACTIVO = 6.5
  const PROGRESO_HOLGURA = Math.ceil(TIRADOR_R_ACTIVO - PROGRESO_BARRA / 2)
  // Las ondas NACEN EN LA BARRA, no unos píxeles por encima: el medio píxel de
  // solape con su borde superior evita que el antialiasing deje una línea de aire
  // entre el relleno y la barra.
  const ONDA_SOLAPE = 0.5
  // `velocidad` es px/s **hacia la derecha**: las dos ondas viajan en el MISMO
  // sentido, naciendo al principio de la barra y avanzando hasta la cabeza de
  // reproducción (el envolvente de entrada y el de salida son lo que hace visible
  // ese nacer y morir). Van en el orden en que se pintan: primero la de detrás
  // —más rápida y de onda más corta— y encima la de delante, más lenta y algo más
  // alta. La diferencia de velocidad es lo que hace que la trasera **alcance** a
  // la delantera: unas veces asoma por encima de su cresta y otras queda dentro de
  // su relleno, que es justo el efecto pedido. Con la misma velocidad no se
  // adelantarían nunca y se leerían como una sola onda gruesa.
  // La amplitud está topada por la línea del ARTISTA, que queda justo encima: la
  // cresta llega a `amplitud` px sobre la barra y a partir de ~13,5 cruza el texto —
  // medido con `grim` sobre la tarjeta.
  //
  // **Cada onda es un tren de PULSOS SUELTOS, no una senoidal continua.** Esto es una
  // corrección, y la razón por la que no basta con alargar la onda: una senoidal
  // llena la barra de crestas pegadas *por definición* — al estirarla salen menos
  // lomos, pero siguen siendo uno tras otro sin un hueco donde descansar la vista, y
  // eso es lo que satura. Aquí cada pulso es una campana de Gauss de anchura `ancho`,
  // y entre el final de uno y el principio del siguiente se deja `hueco` px de barra
  // **plana, onda a 0**: se ven dos o tres ondas con aire entre ellas, no un tren.
  //
  // Los dos parámetros son independientes y conviene no confundirlos, que ha costado
  // un par de vueltas: `ancho` es lo que ocupa cada onda (su ancho visible son
  // `ONDA_ANCHO_VISIBLE` sigmas) y `hueco` es el margen vacío entre una y la
  // siguiente. Cada cuánto se crea una — el `espaciado` de antes — ya no se escribe a
  // mano: **sale de sumar los dos**, así que tocar `ancho` no descuadra el margen.
  //
  // La vida ya no sale de batir dos senos (ver `alturaPulso`): **cada pulso nace con
  // su propia altura** y la conserva mientras viaja, así que unos pasan altos y otros
  // bajos. Es lo mismo que se buscaba con el batido, pero por pulso y sin que la
  // altura cambie bajo los pies del que ya está en pantalla.
  const ONDAS = [
    {
      // Va DETRÁS pero con el trazo MÁS marcado que la grande, no al revés: si la de
      // delante es la opaca, la trasera se pierde bajo su relleno justo cuando la
      // adelanta, que es el momento que da sentido a que sean dos. Los dos alfas son
      // ALTOS (0,95 y 0,80): con 0,62 y 0,45 el trazo se diluía sobre la carátula y
      // apenas se veía la onda — el orden entre ellos es lo que importa, no que sean
      // discretos.
      // Su altura es CASI la de la grande (11,5 frente a 13), no la mitad: con una
      // claramente menor deja de leerse como otra onda y parece el eco de la otra.
      // Lo que las distingue es el ritmo, la velocidad y el TONO — esta usa el
      // compañero (`oneUiOndaTone`) y la de delante el mismo acento que la barra.
      amplitud: 11.5, alfa: 0.95, grosor: 1.1, tono: "companero" as const,
      ancho: 9, hueco: 30, velocidad: 20, semilla: 7,
    },
    {
      // Los dos ritmos resultantes son PARECIDOS (78 y 66 px entre pulsos) y las dos
      // `velocidad` casi iguales (20 y 16), y las dos cosas son deliberadas: así los
      // pulsos de una y otra nacen más o menos a la par al principio de la barra y
      // solo se van separando conforme avanzan. Con ritmos muy distintos (84/110 y
      // 30/15, que es como estuvo) cada onda iba a su aire y se leían como dos cosas
      // sin relación. La diferencia que queda es la que interesa: la pequeña emite
      // antes, así que **cambia de altura más a menudo** que la grande, y la ligera
      // diferencia de velocidad hace que se alcancen y se crucen despacio.
      amplitud: 13.0, alfa: 0.80, grosor: 1.4, tono: "acento" as const,
      ancho: 11, hueco: 34, velocidad: 16, semilla: 31,
    },
  ]
  // Ancho visible de un pulso en sigmas: más allá de dos sigmas a cada lado la
  // campana ya no se distingue de la barra, así que es lo que cuenta como "ocupado"
  // al repartir el hueco.
  const ONDA_ANCHO_VISIBLE = 4
  // **Cada pulso varía en ALTURA Y EN ANCHO, no solo en altura.** Con el ancho fijo,
  // dos pulsos de altura parecida salían calcados y el tramo se leía repetitivo — y
  // eso se nota sobre todo cuando la barra dibujada es corta (al principio de la
  // pista, o en una canción larga), porque ahí caben pocos y cada uno tiene que
  // aguantar la mirada él solo. La variación ENTRE pulsos es POCA pero perceptible:
  // la base va del 82 % al 100 % de `amplitud` y `ancho` del 92 % al 122 % del suyo.
  // Lo que sí recorre todo el rango es el latido de cada uno en el tiempo, ver
  // `alturaPulso`.
  //
  // Los dos SUELOS son altos, y ese es el ajuste que costó encontrar: con rangos
  // amplios (0,42 de altura, 0,65 de ancho) el extremo bajo no aportaba variedad,
  // solo estorbaba — salían agujas y pulsos aplastados que no se leen como una onda,
  // y el conjunto parecía irregular en vez de vivo. Si hay que retocar esto, muévete
  // en el suelo; el techo apenas cambia nada.
  //
  // El ancho máximo lo topa el `hueco`, que con 1,22× sigue dejando barra plana entre
  // pulsos.
  const ONDA_PULSO_BASE_MIN = 0.82
  const ONDA_PULSO_ANCHO_MIN = 0.92
  const ONDA_PULSO_ANCHO_MAX = 1.22
  // Duración del ciclo de cada pulso, en segundos: un bajón más el descanso que le
  // sigue. Sorteado por pulso, ver `alturaPulso`. **El rango es ANCHO a propósito.**
  // Con 2,8-4,6 las fases ya salían descorrelacionadas (medido: correlación entre
  // pulsos vecinos −0,10), pero todos se movían casi a la misma velocidad —entre el
  // más rápido y el más lento había un factor 1,5— y eso el ojo lo lee como que suben
  // y bajan a la vez. Aquí el factor real es 2,3.
  //
  // Y son ciclos LARGOS —de 6 a 14 s— porque esto es una onda, no un indicador: todo
  // movimiento tiene que resultar lento y progresivo. Con 2,4-6,0 s el bajón más
  // breve duraba 0,67 s de ida y vuelta, o sea que la altura cambiaba a **4,5 alturas
  // por segundo** en su punto más rápido y se veía como un tirón. Con estos valores
  // el bajón más breve dura 2,7 s y el pico baja a 0,99 alturas/s.
  const ONDA_CICLO_MIN = 6.0
  const ONDA_CICLO_MAX = 14.0
  // Parte del ciclo ocupada por el bajón. El resto (25-55 %) es descanso arriba, y
  // ese descanso es el "margen" entre un movimiento y el siguiente: al sortearse por
  // pulso, los bajones no se encadenan a intervalos regulares.
  const ONDA_BAJON_MIN = 0.45
  const ONDA_BAJON_MAX = 0.75
  // Profundidad del bajón: hasta dónde cae respecto de su altura de reposo. Se quedó
  // en 0,85 y no más: la profundidad es la otra mitad de lo brusco que se ve el
  // movimiento —cuanto más hondo, más recorrido en el mismo tiempo—, y bajar hasta un
  // hilo de onda solo salía suave con ciclos aún más largos.
  const ONDA_BAJON_FONDO_MIN = 0.55
  const ONDA_BAJON_FONDO_MAX = 0.85
  // Ruido determinista por índice de pulso (el mismo truco que `OndaSpotify`): sin
  // estado y sin acumular nada entre frames. Lo que fija es la IDENTIDAD del pulso k
  // —su ancho, su ritmo y su fase—, que no cambia mientras cruza la barra.
  // Las constantes son las del hash clásico de GLSL y **no son intercambiables**: con
  // las que había (127.1 / 311.7) el reparto para índices consecutivos sale sesgado
  // —11 de 24 valores caían en el cuartil alto y solo 1 en el segundo—, así que los
  // periodos se agolpaban todos en la parte lenta del rango. Con estas el reparto es
  // 4/5/9/6 por cuartil. Si se tocan, hay que volver a medirlo.
  const ruidoPulso = (indice: number): number => {
    const seno = Math.sin(indice * 12.9898 + 78.233) * 43758.5453
    return seno - Math.floor(seno)
  }
  // **El pulso NO respira sin parar: descansa arriba y de vez en cuando pega un
  // bajón.** Antes era un seno continuo entre casi 0 y el 100 %, y tenía dos defectos
  // medidos sobre 1.200 muestras: pasaba **más tiempo abajo que arriba** (38 % por
  // encima del 70 % de su altura frente a un 35 % por debajo del 30 %), y como un
  // seno no tiene descansos, los movimientos iban encadenados uno tras otro sin
  // respiro. El modelo de bajones da 75 % arriba / 11 % abajo.
  //
  // Tres factores, cada uno sorteado del índice del pulso y fijo de por vida:
  //
  // 1. **Base** — su altura en reposo, donde pasa la mayor parte del tiempo. Varía
  //    POCO entre pulsos (82 %–100 %): se parecen entre sí, que es lo que se buscaba.
  // 2. **Ciclo y fase** — cada cuánto le toca bajar y en qué momento arranca.
  // 3. **Bajón** — qué parte del ciclo dura el movimiento (`ONDA_BAJON_*`) y hasta
  //    dónde cae (`ONDA_BAJON_FONDO_*`). Lo que queda del ciclo es descanso arriba, y
  //    **ese descanso es el margen aleatorio entre un movimiento y el siguiente**.
  //
  // El movimiento en sí es un coseno completo (baja y vuelve, sin esquinas); lo
  // aleatorio son solo los cuatro sorteos, nunca el valor de un frame.
  const alturaPulso = (indice: number, tiempo: number): number => {
    const base = ONDA_PULSO_BASE_MIN + (1 - ONDA_PULSO_BASE_MIN) * ruidoPulso(indice + 4091)
    const ciclo = ONDA_CICLO_MIN + (ONDA_CICLO_MAX - ONDA_CICLO_MIN) * ruidoPulso(indice)
    const duracion = ONDA_BAJON_MIN + (ONDA_BAJON_MAX - ONDA_BAJON_MIN) * ruidoPulso(indice + 3571)
    const fondo = ONDA_BAJON_FONDO_MIN
      + (ONDA_BAJON_FONDO_MAX - ONDA_BAJON_FONDO_MIN) * ruidoPulso(indice + 6151)
    const avance = (tiempo / ciclo + ruidoPulso(indice + 2027)) % 1
    if (avance >= duracion) return base
    return base * (1 - fondo * (0.5 - 0.5 * Math.cos((2 * Math.PI * avance) / duracion)))
  }
  // El desplazamiento del índice descorrelaciona las dos tiradas: sin él, el pulso
  // más alto sería siempre además el más ancho y la variación se notaría la mitad.
  const anchoPulso = (indice: number): number =>
    ONDA_PULSO_ANCHO_MIN + (ONDA_PULSO_ANCHO_MAX - ONDA_PULSO_ANCHO_MIN) * ruidoPulso(indice + 1013)
  // El relleno bajo la curva lleva **el mismo alfa y la misma rampa** en las dos
  // ondas (referida a la cresta de la MÁS ALTA, no a la de cada una); lo único que
  // cambia entre ellas es el COLOR, ver `tono`. Con un alfa por onda, la pequeña se
  // leía como "sin fondo" al lado de la grande; y con la rampa referida a la amplitud
  // propia, dos puntos a la misma altura salían de distinta intensidad, que es la
  // otra mitad de lo mismo. Al ser semitransparente, el relleno de la onda de detrás
  // se ve a través del de delante y los dos se mezclan donde se cruzan — con dos
  // tonos distintos ese cruce ya no es solo más opaco, es otro color.
  const ONDA_RELLENO = 0.75
  const ONDA_RELLENO_ALTO = Math.max(...ONDAS.map((onda) => onda.amplitud))
  // Medio trazo del más grueso: es lo que sobresale de la ruta al dibujarla, y lo
  // que hay que descontar del lienzo para que la cresta no toque el borde.
  const ONDA_MARGEN_TRAZO = Math.max(...ONDAS.map((onda) => onda.grosor)) / 2
  // Tramo en el que la onda entra y se apaga. Va MUY sobrado en la salida (38 px, no
  // los 12 de antes) porque la onda tiene que **desaparecer** acercándose a la cabeza
  // de reproducción, no acabarse: con un tramo corto la amplitud se desploma en un
  // palmo y el ojo lo lee igual que un corte. Actúan sobre la amplitud y también
  // sobre el alfa del trazo (ver el degradado longitudinal más abajo).
  const ONDA_ENTRADA = 30
  const ONDA_SALIDA = 38
  // Paso de muestreo de la curva, en px. La ruta se traza con BÉZIERS (ver `trazar`), no
  // con segmentos rectos, así que este número ya no decide lo redonda que se ve la onda:
  // decide solo cuánto se parece al perfil real. Con 2 px la desviación máxima frente a
  // la campana exacta es de 0,014 px (medida sobre 30 s de animación) — un tercio de lo
  // que daban los segmentos rectos con paso 1, y con la mitad de puntos.
  const ONDA_PASO = 2
  const ONDA_FPS = 30
  const ONDA_FPS_AHORRO = 20

  // Más allá de 4,5 sigmas la campana de un pulso vale 4·10⁻⁵ de su altura: sobre la
  // cresta más alta (13 px) es medio milésimo de píxel, o sea nada que el antialiasing
  // pueda pintar. Se guarda al cuadrado porque así se compara, sin raíces. El límite es
  // holgado a propósito —con 3,5 ya era invisible (7 píxeles distintos de 133.000 al
  // rasterizar a 4 aumentos)— porque lo que ahorra es el `Math.exp` del vecino lejano y
  // eso ya lo consigue de sobra; apurarlo solo acercaría el corte a la zona visible.
  const ONDA_CORTE_SIGMAS2 = 4.5 * 4.5
  // Buffers de la polilínea, REUTILIZADOS entre frames y entre las dos ondas. Antes
  // cada onda construía un `Array<[number, number]>` nuevo por frame: a 30 fps son
  // ~300 arrays pequeños por segundo creados solo para tirarlos, y esto es lo único
  // del shell que dibuja de forma continua.
  let puntosX = new Float64Array(0)
  let puntosY = new Float64Array(0)

  let tiempoOndas = 0
  // 0 = ondas planas, 1 = amplitud completa. Se cruza en vez de conmutarse para que
  // pausar no dé un salto.
  let energiaOndas = 0
  let ultimoFrameOndas = 0
  let acumuladoOndas = 0
  let idTickOndas: number | null = null

  const suave = (t: number) => {
    const v = Math.min(1, Math.max(0, t))
    return v * v * (3 - 2 * v)
  }

  const progressArea = new Gtk.DrawingArea()
  progressArea.set_hexpand(true)
  progressArea.set_content_width(1)
  progressArea.set_content_height(PROGRESO_ALTO + PROGRESO_HOLGURA)
  progressArea.add_css_class("qs-media-progress-ondas")
  progressArea.set_draw_func((_area, cr, width, height) => {
    const barHeight = PROGRESO_BARRA
    const radius = Math.min(barHeight / 2, 3)
    const drawRoundRect = (x: number, y: number, w: number, h: number) => {
      const r = Math.min(radius, w / 2, h / 2)
      cr.newPath()
      cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0)
      cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2)
      cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI)
      cr.arc(x + r, y + r, r, Math.PI, 1.5 * Math.PI)
      cr.closePath()
    }

    // La barra se ancla ABAJO —lo que hay por encima es el lienzo de las ondas, y
    // centrarla las dejaría sin sitio— pero por debajo se reserva `PROGRESO_HOLGURA`
    // para la mitad inferior del tirador.
    const y = Math.max(0, height - barHeight - PROGRESO_HOLGURA)
    drawRoundRect(0, y, width, barHeight)
    cr.setSourceRGBA(0, 0, 0, 0.42)
    cr.fill()

    // Los dos tonos salen de la MISMA semilla (el acento de la carátula) por reglas
    // distintas; ver `oneUiOndaTone`. La barra usa siempre el de acento.
    const tonos = tonosDeAcento(coverAccent.get())
    const [r, g, b] = tonos.acento

    // El tirador se pinta SIEMPRE al final, encima de las ondas, y por eso vive en
    // una función: el cuerpo de abajo tiene varias salidas tempranas (sin relleno,
    // sin energía de ondas) y en todas debe seguir viéndose la cabeza.
    const pintarTirador = () => {
      if (!puedeBuscar) return
      const radio = arrastrando || hoverProgreso ? TIRADOR_R_ACTIVO : TIRADOR_R
      // Centro acotado a los bordes: en 0 % y en 100 % el círculo quedaría medio
      // fuera del lienzo y GTK lo recortaría en plano.
      const cx = Math.max(radio, Math.min(width - radio, fillW))
      const cy = y + barHeight / 2
      cr.newPath()
      cr.arc(cx, cy, radio, 0, 2 * Math.PI)
      cr.setSourceRGBA(0, 0, 0, 0.35)
      cr.fill()
      cr.newPath()
      cr.arc(cx, cy, radio - 1.5, 0, 2 * Math.PI)
      cr.setSourceRGBA(r / 255, g / 255, b / 255, 1)
      cr.fill()
    }

    const fraccion = arrastrando ? fraccionArrastre : prog.get()
    const fillW = Math.max(0, Math.min(width, width * fraccion))
    if (fillW <= 0) { pintarTirador(); return }
    drawRoundRect(0, y, fillW, barHeight)
    cr.setSourceRGBA(r / 255, g / 255, b / 255, 1)
    cr.fill()

    if (energiaOndas < 0.004) { pintarTirador(); return }
    const base = y + ONDA_SOLAPE
    cr.setLineCap(cairo.LineCap.ROUND)
    cr.setLineJoin(cairo.LineJoin.ROUND)
    // Techo real del lienzo: por encima de `y = 0` está el borde del DrawingArea y
    // ahí GTK recorta el dibujo. Subir `amplitud` más allá de esto NO hace la onda
    // más alta — la deja **cortada en plano**, que es el síntoma con el que se
    // descubrió. Se reduce la amplitud para que quepa en vez de dejar que la corte el
    // borde; con los valores actuales (cresta 13 px de 16 disponibles) no actúa.
    const amplitudMaxima = Math.max(0, base - ONDA_MARGEN_TRAZO)
    for (const onda of ONDAS) {
      const [or_, og, ob] = tonos[onda.tono]
      const amplitud = Math.min(onda.amplitud, amplitudMaxima) * energiaOndas
      // `sobre - desfase` y no `+`: restar desplaza el pulso hacia la derecha según
      // avanza el tiempo, que es el sentido de marcha pedido.
      const desfase = tiempoOndas * onda.velocidad
      const espaciado = ONDA_ANCHO_VISIBLE * onda.ancho + onda.hueco

      // **La identidad de cada pulso se tabula UNA vez por onda y frame.**
      // `alturaPulso` y `anchoPulso` dependen SOLO del índice del pulso (y del tiempo,
      // que es el mismo para todo el frame), pero el bucle de abajo las pedía en cada
      // x y para los tres vecinos: cada pulso se recalculaba del orden de cien veces
      // por frame, y cada `alturaPulso` son cinco `Math.sin` del hash. En la barra
      // caben media docena de pulsos, así que se calculan esos y el bucle solo lee.
      const primerPulso = Math.floor(-desfase / espaciado) - 1
      const ultimoPulso = Math.floor((fillW - desfase) / espaciado) + 1
      const alturas: number[] = []
      const sigmas: number[] = []
      for (let indice = primerPulso; indice <= ultimoPulso; indice++) {
        alturas.push(alturaPulso(indice + onda.semilla, tiempoOndas))
        sigmas.push(onda.ancho * anchoPulso(indice + onda.semilla))
      }

      // Los puntos se calculan UNA vez y se recorren dos: `fill` consume la ruta, así
      // que el trazo tendría que rehacerla — y con dos bucles independientes el
      // relleno y su contorno podrían separarse un píxel.
      const total = Math.floor(fillW / ONDA_PASO) + 1
      if (puntosX.length < total) {
        puntosX = new Float64Array(total + 64)
        puntosY = new Float64Array(total + 64)
      }
      for (let punto = 0; punto < total; punto++) {
        const sobre = Math.min(punto * ONDA_PASO, fillW)
        const envolvente = suave(sobre / ONDA_ENTRADA) * suave((fillW - sobre) / ONDA_SALIDA)
        // Posición en ciclos: la parte entera identifica al pulso, que es lo que fija
        // su ancho y el ritmo de su latido. Se miran también los vecinos porque en la frontera
        // entre dos ciclos el de al lado todavía aporta cola; sin ellos ahí saldría un
        // escalón. El sigma se toma del pulso VECINO, no del actual: es su campana la
        // que se está evaluando.
        const ciclo = (sobre - desfase) / espaciado
        const actual = Math.floor(ciclo)
        let forma = 0
        for (let indice = actual - 1; indice <= actual + 1; indice++) {
          const distancia = (ciclo - (indice + 0.5)) * espaciado
          const sigma = sigmas[indice - primerPulso]
          const distancia2 = distancia * distancia
          // Fuera del alcance visible del vecino no se evalúa la campana: con el
          // espaciado actual (66-78 px entre pulsos, sigma ~9-13) eso descarta uno o
          // dos de los tres en casi todo el recorrido, y con ellos su `Math.exp`.
          if (distancia2 > ONDA_CORTE_SIGMAS2 * sigma * sigma) continue
          forma += alturas[indice - primerPulso] * Math.exp(-distancia2 / (2 * sigma * sigma))
        }
        puntosX[punto] = sobre
        puntosY[punto] = base - amplitud * envolvente * Math.min(1, forma)
      }
      if (total < 2) continue

      // **La ruta va con BÉZIERS y no con `lineTo`, y eso es lo que quita el borde de
      // sierra.** Una polilínea deja un quiebro de pendiente en CADA muestra, y un
      // quiebro del eje se convierte en una esquina visible en el borde exterior del
      // trazo, amplificada por su medio grosor: las crestas —donde más curva hay— salían
      // con un techo plano de dos o tres facetas. Bajar el paso lo disimula pero no lo
      // quita, porque el defecto no es de resolución sino de continuidad: por fino que se
      // muestree, la pendiente sigue saltando en cada punto.
      //
      // **Y es peor cuanto mayor sea la escala de la pantalla.** El paso está en píxeles
      // LÓGICOS, así que en este equipo (2K a escala 1,25) cada faceta mide 1,25 píxeles
      // de pantalla, no uno; a escala 2 medirían dos. Una Bézier no tiene ese problema:
      // cairo la subdivide con su tolerancia de planitud medida en píxeles de DISPOSITIVO,
      // o sea que se mantiene suave sea cual sea la escala, sin muestrear más aquí.
      //
      // La conversión es la Catmull-Rom uniforme a Bézier cúbica: la tangente en cada
      // punto es la de sus vecinos, (p2 − p0) / 2, y los tiradores caen a un tercio del
      // tramo. Pasa exactamente por todas las muestras (no las suaviza ni las redondea, que
      // aplanaría los picos) y empalma con pendiente continua, que es justo lo que faltaba.
      // En los extremos el vecino que falta se sustituye por el propio punto: media
      // tangente en el primer y el último tramo, donde la envolvente ya tiene la onda plana.
      const trazar = () => {
        cr.newPath()
        cr.moveTo(puntosX[0], puntosY[0])
        for (let punto = 0; punto < total - 1; punto++) {
          const anteriorY = puntosY[punto > 0 ? punto - 1 : 0]
          const desdeY = puntosY[punto]
          const hastaY = puntosY[punto + 1]
          const siguienteY = puntosY[punto + 2 < total ? punto + 2 : total - 1]
          const desdeX = puntosX[punto]
          const hastaX = puntosX[punto + 1]
          const tercio = (hastaX - desdeX) / 3
          cr.curveTo(
            desdeX + tercio, desdeY + (hastaY - anteriorY) / 6,
            hastaX - tercio, hastaY - (siguienteY - desdeY) / 6,
            hastaX, hastaY,
          )
        }
      }

      // **Relleno y trazo se pintan en un GRUPO y se enmascaran juntos.** Aplanar la
      // onda contra la barra al llegar a la cabeza NO la hace desaparecer: el
      // degradado del relleno es vertical y su borde inferior está siempre al alfa
      // máximo, así que por muy fina que quede la lámina se sigue viendo una banda
      // maciza hasta el final — ese era el "no llegan a cero". Un degradado
      // longitudinal en cada uno tampoco vale: cairo pinta con UNA fuente por
      // operación y el relleno ya gasta la suya en el degradado vertical. La máscara
      // se aplica al resultado ya compuesto, que es lo único que apaga las dos cosas
      // a la vez y de forma idéntica.
      cr.pushGroup()

      // Relleno: la misma curva cerrada contra la barra. El degradado se desvanece
      // hacia arriba para que el área no tape la carátula.
      trazar()
      cr.lineTo(puntosX[total - 1], base)
      cr.lineTo(puntosX[0], base)
      cr.closePath()
      const alfaRelleno = ONDA_RELLENO * energiaOndas
      try {
        // Mismo fallback que `coverScrim`: si el binding de GJS no expone
        // LinearGradient, se rellena plano en vez de quedarse sin área.
        const grad = new (cairo as any).LinearGradient(0, base - ONDA_RELLENO_ALTO, 0, base)
        grad.addColorStopRGBA(0, or_ / 255, og / 255, ob / 255, 0)
        grad.addColorStopRGBA(1, or_ / 255, og / 255, ob / 255, alfaRelleno)
        cr.setSource(grad)
      } catch (_) {
        cr.setSourceRGBA(or_ / 255, og / 255, ob / 255, alfaRelleno * 0.6)
      }
      cr.fill()

      trazar()
      cr.setLineWidth(onda.grosor)
      cr.setSourceRGBA(or_ / 255, og / 255, ob / 255, onda.alfa * energiaOndas)
      cr.stroke()

      cr.popGroupToSource()
      try {
        // Solo cuenta el alfa de la máscara; el color de sus paradas es irrelevante.
        const mascara = new (cairo as any).LinearGradient(0, 0, fillW, 0)
        const entrada = Math.min(0.45, ONDA_ENTRADA / fillW)
        const salida = Math.min(0.45, ONDA_SALIDA / fillW)
        mascara.addColorStopRGBA(0, 0, 0, 0, 0)
        mascara.addColorStopRGBA(entrada, 0, 0, 0, 1)
        mascara.addColorStopRGBA(1 - salida, 0, 0, 0, 1)
        mascara.addColorStopRGBA(1, 0, 0, 0, 0)
        cr.mask(mascara)
      } catch (_) {
        // Sin máscara la onda se ve entera (como antes), no se pierde.
        cr.paint()
      }
    }

    pintarTirador()
  })
  const queueProgress = () => progressArea.queue_draw()
  repintarProgreso = queueProgress

  // ── Arrastre / clic para buscar en la pista ─────────────────────────────────
  // El gesto de arrastre cubre también el clic simple: GTK emite `drag-begin` y
  // `drag-end` con desplazamiento 0, así que pulsar en un punto salta a él sin
  // necesidad de un `GestureClick` aparte.
  const fraccionEnX = (x: number): number => {
    const ancho = progressArea.get_width()
    if (ancho <= 0) return 0
    return Math.max(0, Math.min(1, x / ancho))
  }

  const previsualizarArrastre = (fraccion: number) => {
    fraccionArrastre = fraccion
    if (duracionActual !== null) setPositionLabel(formatMediaTime(fraccion * duracionActual))
    progressArea.queue_draw()
  }

  let inicioArrastreX = 0
  const gestoBusqueda = new Gtk.GestureDrag()
  gestoBusqueda.set_button(Gdk.BUTTON_PRIMARY)
  gestoBusqueda.connect("drag-begin", (_g: any, x: number) => {
    if (!puedeBuscar || duracionActual === null) return
    inicioArrastreX = x
    arrastrando = true
    previsualizarArrastre(fraccionEnX(x))
  })
  gestoBusqueda.connect("drag-update", (_g: any, dx: number) => {
    if (!arrastrando) return
    previsualizarArrastre(fraccionEnX(inicioArrastreX + dx))
  })
  gestoBusqueda.connect("drag-end", (_g: any, dx: number) => {
    if (!arrastrando) return
    const fraccion = fraccionEnX(inicioArrastreX + dx)
    // Se suelta el arrastre ANTES de buscar: `buscarEnPista` publica la posición
    // nueva en `prog`, y con la bandera aún puesta el dibujo seguiría leyendo
    // `fraccionArrastre` y el sondeo siguiente no podría corregir nada.
    arrastrando = false
    buscarEnPista(fraccion)
    progressArea.queue_draw()
  })
  progressArea.add_controller(gestoBusqueda)

  const punteroProgreso = new Gtk.EventControllerMotion()
  punteroProgreso.connect("enter", () => { hoverProgreso = true; progressArea.queue_draw() })
  punteroProgreso.connect("leave", () => { hoverProgreso = false; progressArea.queue_draw() })
  progressArea.add_controller(punteroProgreso)

  const frameOndas = (_widget: any, reloj: any): boolean => {
    const ahoraUs = reloj.get_frame_time()
    const transcurrido = ultimoFrameOndas ? (ahoraUs - ultimoFrameOndas) / 1e6 : 1 / 60
    ultimoFrameOndas = ahoraUs
    acumuladoOndas += Math.min(0.1, transcurrido)
    if (acumuladoOndas < 1 / (powerSaveActive.get() ? ONDA_FPS_AHORRO : ONDA_FPS)) return true
    const delta = acumuladoOndas
    acumuladoOndas = 0
    tiempoOndas += delta

    const objetivo = isPlaying.get() ? 1 : 0
    energiaOndas += (objetivo - energiaOndas) * (1 - Math.exp(-delta / 0.24))
    progressArea.queue_draw()

    if (objetivo === 0 && energiaOndas < 0.004) {
      energiaOndas = 0
      progressArea.queue_draw()
      idTickOndas = null
      return false
    }
    return true
  }

  // El reloj de frames solo vive con el panel abierto y con la barra a la vista: es
  // el mismo criterio que ya usan el temporizador de posición y `OndaSpotify`.
  const sincronizarOndas = () => {
    const necesario = quickSettingsVisible.get() && hasProgress.get()
      && (isPlaying.get() || energiaOndas > 0)
    if (necesario && idTickOndas === null) {
      ultimoFrameOndas = 0
      acumuladoOndas = 0
      idTickOndas = progressArea.add_tick_callback(frameOndas)
    } else if (!necesario && idTickOndas !== null) {
      progressArea.remove_tick_callback(idTickOndas)
      idTickOndas = null
      // Sin frames que la crucen, la energía tiene que caer de golpe: si no, al
      // reabrir el panel las ondas reaparecerían con la amplitud congelada.
      if (!isPlaying.get()) energiaOndas = 0
    }
  }

  const cancelarProgreso = prog.subscribe(queueProgress)
  const cancelarProgresoAcento = coverAccent.subscribe(queueProgress)
  const cancelarOndasReproduccion = isPlaying.subscribe(sincronizarOndas)
  const cancelarOndasProgreso = hasProgress.subscribe(sincronizarOndas)
  const cancelarOndasPanel = quickSettingsVisible.subscribe(sincronizarOndas)
  sincronizarOndas()

  const mediaContent = (
    <box
      orientation={Gtk.Orientation.VERTICAL}
      spacing={4}
      hexpand
      heightRequest={CARD_H}
      cssClasses={["qs-media-content"]}
      $={(self) => { mediaContentWidget = self }}
    >
      <box spacing={4} cssClasses={["qs-media-switcher-row"]}>
        {playerAppIcon}
        <label
          cssClasses={["qs-media-source"]}
          label={playerName}
          widthRequest={MEDIA_SOURCE_MAX_W}
          xalign={0}
          ellipsize={3}
          maxWidthChars={MEDIA_SOURCE_MAX_CHARS}
        />
        <box hexpand />
        <box spacing={0} valign={Gtk.Align.CENTER} visible={numPlayers((n) => n > 1)}>
          <button cssClasses={["qs-media-switch"]} onClicked={prevPlayer}>
            <label label="󰅁" />
          </button>
          <label
            cssClasses={["qs-media-count"]}
            label={playerIndex((i) => `${i + 1}/${numPlayers()}`)}
            halign={Gtk.Align.CENTER}
          />
          <button cssClasses={["qs-media-switch"]} onClicked={nextPlayer}>
            <label label="󰅂" />
          </button>
        </box>
      </box>

      <box spacing={10} vexpand valign={Gtk.Align.CENTER} cssClasses={["qs-media-meta"]}>
        <box orientation={Gtk.Orientation.VERTICAL} spacing={2} hexpand valign={Gtk.Align.CENTER}>
          <label
            cssClasses={["qs-media-title"]}
            label={title}
            hexpand
            halign={Gtk.Align.FILL}
            xalign={0}
            ellipsize={3}
            maxWidthChars={MEDIA_METADATA_MAX_CHARS}
          />
          <label
            cssClasses={["qs-media-artist"]}
            label={artist}
            hexpand
            halign={Gtk.Align.FILL}
            xalign={0}
            ellipsize={3}
            maxWidthChars={MEDIA_METADATA_MAX_CHARS}
          />
        </box>
      </box>
      <box orientation={Gtk.Orientation.VERTICAL} spacing={0} cssClasses={["qs-media-footer"]}>
        <box visible={hasProgress}>
          {progressArea}
        </box>
        {/* `centerbox` para que el corazón no entre en el centrado: el slot central
            lleva solo prev/play/next y queda centrado en toda la fila pase lo que pase
            a los lados. */}
        <centerbox valign={Gtk.Align.CENTER}>
          {/* Los dos tiempos van con `canTarget={false}` porque `.qs-media-time` lleva
              `margin-top: -3px` y esta fila se PRUEBA ANTES que la del progreso (GTK4
              recorre los hijos al revés al elegir destino): siendo alcanzables se
              tragaban la pulsación en los últimos píxeles de la barra y el arrastre no
              llegaba a empezar. No pierden nada: son texto sin interacción. */}
          <box $type="start" hexpand valign={Gtk.Align.CENTER}>
            <label
              cssClasses={["qs-media-time"]}
              label={positionLabel}
              canTarget={false}
              halign={Gtk.Align.START}
              hexpand
              marginEnd={10}
              ellipsize={3}
              maxWidthChars={MEDIA_TIME_MAX_CHARS}
            />
            <button
              cssClasses={["qs-media-btn", "qs-media-like"]}
              visible={likeVisible}
              halign={Gtk.Align.END}
              marginEnd={2}
              onClicked={() => {
                const id = trackId.get()
                if (!id) return
                const next = !liked.get()
                setLiked(next) // optimista
                Spotify.setLiked(id, next).then((ok) => {
                  if (!desmontado && !ok && trackId.get() === id) setLiked(!next)
                })
              }}
            >
              <label label={liked((v) => v ? "󰋑" : "󰋕")} />
            </button>
          </box>
          <box
            $type="center"
            spacing={2}
            halign={Gtk.Align.CENTER}
            valign={Gtk.Align.CENTER}
            cssClasses={["qs-media-controls"]}
          >
            <button cssClasses={["qs-media-btn"]} onClicked={() => {
              const p = reproductoresMultimedia.get()[playerIndex.get()]
              if (p) {
                const name = p.bus_name.replace("org.mpris.MediaPlayer2.", "")
                execAsync(["playerctl", "-p", name, "previous"]).catch(() => {})
              }
            }}>
              <label label="󰒮" />
            </button>
            <button cssClasses={["qs-media-btn"]} onClicked={() => {
              const p = reproductoresMultimedia.get()[playerIndex.get()]
              if (p) p.play_pause()
            }}>
              <label label={isPlaying((v) => v ? "󰏤" : "󰐊")} />
            </button>
            <button cssClasses={["qs-media-btn"]} onClicked={() => {
              const p = reproductoresMultimedia.get()[playerIndex.get()]
              if (p) {
                const name = p.bus_name.replace("org.mpris.MediaPlayer2.", "")
                execAsync(["playerctl", "-p", name, "next"]).catch(() => {})
              }
            }}>
              <label label="󰒭" />
            </button>
          </box>
          <label
            $type="end"
            cssClasses={["qs-media-time"]}
            label={durationLabel}
            canTarget={false}
            halign={Gtk.Align.END}
            valign={Gtk.Align.CENTER}
            marginStart={10}
            ellipsize={3}
            maxWidthChars={MEDIA_TIME_MAX_CHARS}
          />
        </centerbox>
      </box>
    </box>
  )

  onCleanup(() => {
    desmontado = true
    cancelarRevision()
    cancelarVisibilidad()
    cancelarCaratula()
    cancelarAnuncioCaratula()
    cancelarFiltroCaratula()
    cancelarFiltroAnuncio()
    cancelarFiltroAcento()
    cancelarScrimCaratula()
    cancelarScrimAnuncio()
    cancelarProgreso()
    cancelarProgresoAcento()
    cancelarOndasReproduccion()
    cancelarOndasProgreso()
    cancelarOndasPanel()
    if (idTickOndas !== null) {
      progressArea.remove_tick_callback(idTickOndas)
      idTickOndas = null
    }
    if (mediaTimer !== null) GLib.source_remove(mediaTimer)
    for (const id of temporizadoresTransitorios) GLib.source_remove(id)
    temporizadoresTransitorios.clear()
    pendingLengthQueries.clear()
  })

  return (
    <box
      cssClasses={["qs-media"]}
      visible={hasPlayer}
      overflow={Gtk.Overflow.HIDDEN}
    >
      <Gtk.GestureClick
        button={Gdk.BUTTON_SECONDARY}
        onReleased={focusPlayerWindow}
      />
      <Gtk.EventControllerScroll
        flags={Gtk.EventControllerScrollFlags.VERTICAL | Gtk.EventControllerScrollFlags.DISCRETE}
        onScroll={(_self, _dx, dy) => {
          if (numPlayers.get() <= 1 || dy === 0) return false
          if (dy > 0) nextPlayer()
          else prevPlayer()
          return true
        }}
      />
      <Gtk.Overlay $={(self: any) => {
        // colorFilter/coverScrim van en un Overlay INTERNO cuyo child principal
        // es bgCap, no en el externo junto a mediaContent: así su tamaño real
        // sale directamente de la asignación de bgCap en vez de duplicarla con
        // otra constante (CARD_H) que puede redondear distinto a escala
        // fraccional (p. ej. 1.25) y dejar sin cubrir la última fila del fondo.
        const bgOverlay = new Gtk.Overlay()
        bgOverlay.set_child(bgCap)
        bgOverlay.add_overlay(colorFilter)
        bgOverlay.add_overlay(coverScrim)
        self.set_child(bgOverlay)
        self.add_overlay(mediaContent)
        self.set_measure_overlay(mediaContent, true)
      }} />
    </box>
  )
}

// ── Section 4: Volume ─────────────────────────────────────────────────────────

// `QsAudioMenu` (altavoces) y `QsMicMenu` (micrófono) eran casi el mismo
// componente (header, sección "dispositivos"/"apps" con For, volúmenes,
// presets, mute...), solo cambiaba sink↔source, la lista de streams y las
// etiquetas en español. `QsAudioMenuBase` concentra la lógica parametrizada
// por `kind`; `QsAudioMenu`/`QsMicMenu` quedan como wrappers de una línea.
// Alias del tipo del servicio de presets: así `clavePreset(kind, …)` no puede
// desalinearse con lo que aplica el vigilante.
type QsAudioKind = TipoMezcla

function QsAudioMenuBase({ kind, onBack }: { kind: QsAudioKind; onBack: () => void }) {
  const isSpk = kind === "speaker"
  const wp = AstalWp.get_default()
  const [audioMode, setAudioMode] = createState<"devices" | "apps">("devices")
  // Las filas de la mezcla son REACTIVAS (ver el bloque "Mezcla de aplicaciones"): la
  // lista de streams la publica AstalWp y solo las apps en silencio pasan por `pactl`.
  // `presets`/`setPresets` son alias para no tocar el resto de la función.
  const streams = createComputed(
    [createBinding(audioWp!, isSpk ? "streams" : "recorders"), clientesSilenciosos],
    (vivos: any[], clientes: any[]) => filasMezcla(kind, vivos, clientes),
  )
  const presets = audioPresets
  const setPresets = setAudioPresets

  if (!wp.audio) return <box />

  function deviceIcon(vol: number, mute: boolean) {
    if (isSpk) {
      if (mute || vol === 0) return "󰝟"
      if (vol < 0.33) return "󰕿"
      if (vol < 0.66) return "󰖀"
      return "󰕾"
    }
    return mute ? "󰍭" : "󰍬"
  }

  // Esta instancia solo declara si "quiere" la lista (panel abierto ∧ vista propia ∧
  // modo apps); el refcount compartido la sostiene mientras haya ≥1 instancia activa —
  // hay una por monitor. `wanting` evita contar mal al re-disparar syncRefresh. Los
  // streams vivos no dependen de esto (son una lista reactiva, gratis); lo que se
  // enciende y se apaga es la consulta de clientes de Pulse y su enganche a eventos.
  let wanting = false
  const shouldRefresh = () =>
    quickSettingsVisible.get() && qsView.get() === (isSpk ? "audio" : "mic") && audioMode.get() === "apps"
  const syncRefresh = () => {
    const want = shouldRefresh()
    if (want === wanting) return
    wanting = want
    // Solo el submenú de altavoces tiene filas de apps en silencio; el de micrófono es
    // enteramente reactivo y no necesita sostener nada.
    if (!isSpk) return
    if (want) activarMezclaApps(); else desactivarMezclaApps()
  }
  audioMode.subscribe(syncRefresh)
  quickSettingsVisible.subscribe(syncRefresh)
  qsView.subscribe(syncRefresh)

  const todosLosEndpoints = createBinding(wp.audio, isSpk ? "speakers" : "microphones")
  const listaViva = () => (isSpk ? wp.audio.get_speakers() : wp.audio.get_microphones())

  // ── UN SOLO id activo, y por qué antes salían DOS filas en azul ─────────────
  // El resaltado se calculaba con `isDefault() || localDefaultId() === ep.id`, o
  // sea dos fuentes de verdad para el mismo hecho, y `localDefaultId` solo se
  // ponía (al pulsar) pero **no se quitaba nunca**: su corrector era
  // `notify::default-speaker`, que esta versión de AstalWp no emite. Bastaba con
  // que el cambio pedido no cuajara —y no cuajaba, por lo de la clave de
  // metadata que documenta `setDefaultEndpoint`— para que el optimista se
  // quedara clavado en el analógico mientras `isDefault` se iba al digital: las
  // dos filas marcadas a la vez, exactamente el síntoma reportado.
  //
  // Ahora hay un único estado. Se siembra y se corrige leyendo `is-default` de
  // los endpoints (esa señal SÍ llega), y al pulsar se adelanta el valor para
  // tener respuesta inmediata; en cuanto WirePlumber confirma —o desmiente— la
  // lectura real lo pisa. Contradecirse es imposible: solo puede haber un id.
  const idPorDefectoReal = (): number | null => {
    const marcado = listaViva().find((e) => e.isDefault)
    if (marcado) return marcado.id
    return (isSpk ? wp.audio.defaultSpeaker?.id : wp.audio.defaultMicrophone?.id) ?? null
  }
  const [idActivo, setIdActivo] = createState<number | null>(idPorDefectoReal())
  const revisarDefault = () => {
    const id = idPorDefectoReal()
    if (id !== null) setIdActivo(id)
  }

  // Hay que reenganchar `notify::is-default` cada vez que cambia la lista: los
  // endpoints se destruyen y se recrean (perfil de tarjeta, USB reenumerado, el
  // nodo HDMI al reconfigurar monitores) y los handlers se irían con ellos.
  const desconectores: Array<() => void> = []
  const soltarHandlers = () => { while (desconectores.length) desconectores.pop()!() }
  const engancharDefaults = () => {
    soltarHandlers()
    for (const ep of listaViva()) {
      const h = ep.connect("notify::is-default", revisarDefault)
      desconectores.push(() => { try { ep.disconnect(h) } catch { } })
    }
    revisarDefault()
  }
  engancharDefaults()
  todosLosEndpoints.subscribe(engancharDefaults)
  const handlerDefaultAudio = wp.audio.connect(
    isSpk ? "notify::default-speaker" : "notify::default-microphone", revisarDefault)
  onCleanup(() => {
    soltarHandlers()
    try { wp.audio.disconnect(handlerDefaultAudio) } catch { }
  })

  // ── Reparto en "se ve" / "está apartado" ───────────────────────────────────
  // Fuera lo que el hardware da por muerto (no vuelve por ningún lado) y aparte
  // lo que el usuario ha escondido con el clic derecho. Preserva las referencias
  // de los endpoints, así que los `<For>` de abajo —que indexan por identidad—
  // no reconstruyen filas al recalcularse.
  const tipoClave = isSpk ? "spk" : "mic"
  const reparto = createComputed(() =>
    repartirEndpoints(todosLosEndpoints(), infoEndpoint, {
      kind: tipoClave,
      ocultos: audioDispositivosOcultos(),
      idActivo: idActivo(),
    }))
  const endpoints = reparto((r) => r.visibles)
  const endpointsOcultos = reparto((r) => r.ocultos)
  const hayOcultos = reparto((r) => r.ocultos.length > 0)
  // Plegado por defecto y **por sesión**: es una lista de descarte, no algo que
  // se venga a consultar. Se repliega sola al quedarse vacía, para no dejar una
  // cabecera "Ocultos (0)" desplegada sobre nada.
  const [ocultosAbiertos, setOcultosAbiertos] = createState(false)
  hayOcultos.subscribe(() => { if (!hayOcultos.get()) setOcultosAbiertos(false) })

  // ⚠️ El dispositivo EN USO no se puede apartar, y no es una restricción
  // cosmética: `repartirEndpoints` lo mantiene visible mientras sea el activo,
  // así que marcarlo no se nota **en ese momento** — pero deja una trampa
  // armada. El caso real: apartas los cascos USB sin querer, luego los
  // desenchufas, el default se va al HDMI y los cascos ya no aparecen en la
  // lista justo cuando los vuelves a enchufar para elegirlos. Se rechaza en el
  // origen en vez de aceptar un clic que no hace nada visible hoy y muerde
  // dentro de una semana.
  const alternarOculto = (ep: AstalWp.Endpoint) => {
    if (idActivo.get() === ep.id) return
    alternarDispositivoAudioOculto(claveEndpoint(tipoClave, infoEndpoint(ep)))
  }

  return (
    <box cssClasses={[isSpk ? "qs-audio-menu" : "qs-mic-menu"]} orientation={Gtk.Orientation.VERTICAL} spacing={8}>
      <QsMenuHeader title={isSpk ? "Volumen" : "Micrófono"} onBack={onBack}>
        <button
          cssClasses={["qs-icon-btn"]}
          onClicked={() => {
            // setAudioMode dispara syncRefresh (suscrito a audioMode), que arranca o
            // detiene el sondeo según corresponda.
            setAudioMode(audioMode.get() === "devices" ? "apps" : "devices")
          }}
        ><label label={audioMode((m) => m === "devices" ? "󰓃" : "󰋎")} /></button>
      </QsMenuHeader>

      <Gtk.ScrolledWindow
        cssClasses={["qs-wifi-list-scroll"]}
        hscrollbarPolicy={Gtk.PolicyType.NEVER}
        vscrollbarPolicy={Gtk.PolicyType.AUTOMATIC}
        vexpand
      >
        <box orientation={Gtk.Orientation.VERTICAL} spacing={8}>
          <box orientation={Gtk.Orientation.VERTICAL} spacing={4} visible={audioMode((m) => m === "devices")}>
            <label cssClasses={["qs-dropdown-header"]} label={isSpk ? "DISPOSITIVOS DE SALIDA" : "DISPOSITIVOS DE ENTRADA"} halign={Gtk.Align.START} />
            <box orientation={Gtk.Orientation.VERTICAL} spacing={4}>
              {/* Con `id`: `reparto` se recomputa cada vez que cambia el
                  dispositivo ACTIVO o la lista de ocultos, y sin él eso reconstruía
                  todas las filas —tirando y rehaciendo cuatro deslizadores por un
                  clic—. El id de AstalWp es el id global de PipeWire: un nodo
                  recreado trae uno nuevo, así que la fila sí se rehace cuando debe. */}
              <For each={endpoints} id={(ep: AstalWp.Endpoint) => ep.id}>
                {(ep: AstalWp.Endpoint) => {
                  const vol = createBinding(ep, "volume")
                  const mute = createBinding(ep, "mute")
                  // Una sola fuente: `idActivo` (ver el bloque de arriba). No se
                  // vuelve a mirar `isDefault` aquí — mezclarlo con el optimista
                  // es lo que pintaba dos filas activas a la vez.
                  const activeClasses = idActivo((id) =>
                    id === ep.id ? ["qs-audio-item", "active"] : ["qs-audio-item"])

                  // Dos líneas: aparato y perfil. Con una sola, y esa una siendo el
                  // perfil, dos filas distintas se leían igual ("Estéreo analógico"
                  // para los cascos USB y para la entrada de la placa) y ninguna
                  // decía de qué aparato hablaba. La segunda se omite si no aporta.
                  const etiqueta = endpointLabel(ep)

                  // La CLAVE del preset sale de `presetsDispositivos.ts`, la MISMA que
                  // usa el vigilante que lo aplica y lo mantiene al día — mismo criterio
                  // que la de las apps, y por el mismo motivo: dos implementaciones que
                  // divergen dejan la fila guardando bajo una clave que nadie lee.
                  const devKey = claveDispositivo(isSpk ? "speaker" : "mic", ep)
                  // El micro tiene su propia escala: el 100 % de la UI es
                  // `MIC_SAFE_MAX` de la curva cruda de PipeWire
                  // (`servicios/multimedia/volumenMicrofono.ts`; hoy 1.00, o sea el
                  // máximo real). `aPorcentaje`/`desdePorcentaje`
                  // son la MISMA conversión que usan la pastilla y el OSD: tenerla en
                  // un solo sitio es lo que impide que dos vistas del mismo micro
                  // enseñen números distintos, que es justo lo que pasaba.
                  // El tope es el 200 %: por encima del 100 % es amplificación por
                  // software, igual que el 153 % de pavucontrol pero sin su límite
                  // de +11 dB (ver `volumenAmplificado.ts`). Para el micro el tope
                  // se expresa en su propia escala, no en fracción cruda.
                  const maxVol = isSpk ? VOLUMEN_MAX : crudoDesdePorcentajeMic(VOLUMEN_MAX * 100)
                  const aPorcentaje = (v: number) => isSpk ? Math.round(v * 100) : porcentajeMic(v)
                  const desdePorcentaje = (p: number) =>
                    isSpk ? clamp(p / 100, 0, VOLUMEN_MAX) : crudoDesdePorcentajeMic(p)
                  // ⚠️ AQUÍ NO SE RESTAURA NADA, y no es un olvido. Esta fila aplicaba
                  // el preset guardado la primera vez que se construía, una vez por
                  // sesión, y ESA era la causa del salto de volumen: el preset solo se
                  // escribía desde el deslizador de aquí abajo, así que cualquier volumen
                  // puesto con las teclas, la rueda de la barra, `wpctl` o pavucontrol lo
                  // dejaba rancio, y abrir el submenú escribía el valor viejo encima del
                  // vivo. De ahí se colaba a `system_state.json` por el `notify::volume`
                  // del altavoz por defecto y de ahí al arranque siguiente vía `init.sh`
                  // ("lo dejo en 50 % y vuelve en 80 %"). Restaurar y sincronizar viven
                  // ahora juntos en `servicios/multimedia/presetsDispositivos.ts`, y
                  // además se aplica cuando el aparato APARECE, no cuando se mira la
                  // lista: unos cascos enchufados a mitad de sesión no recuperaban su
                  // volumen hasta que abrías esto.

                  const scale = makeScale(
                    ["qs-slider", isSpk ? "speaker" : "mic"],
                    () => ep.volume,
                    (v) => {
                      // `fijarVolumenEndpoint`, NO `ep.volume = v`: el setter de
                      // AstalWp recorta a 1.5 en silencio (ver el módulo).
                      fijarVolumenEndpoint(ep, v)
                      const p = { ...presets.get() }
                      p[devKey] = v
                      setPresets(p)
                      saveAudioPresets(p)
                    },
                    // Se DESCONECTA al morir la fila. Sin esto cada reconstrucción
                    // dejaba un manejador vivo sobre el endpoint, escribiendo en el
                    // ajuste de un deslizador ya desechado: no da error, solo va
                    // acumulando trabajo por cada clic en un dispositivo.
                    (cb) => {
                      const manejador = ep.connect("notify::volume", cb)
                      onCleanup(() => { try { ep.disconnect(manejador) } catch { } })
                    },
                    {
                      heightRequest: 4, max: maxVol, marcarAmplificado: true,
                      ajustar: (v) => ajustarVolumen(v, maxVol),
                    },
                  )

                  // Elegir este dispositivo. El `id` de AstalWp ES el id global de
                  // PipeWire, así que `wpctl` lo entiende tal cual: se fue de aquí el
                  // `pactl list … | awk` que lo traducía a `node.name` (y con él la
                  // escritura de `default.audio.sink`, la clave equivocada que
                  // provocaba el salto a la salida digital — ver `setDefaultEndpoint`).
                  const activate = async () => {
                    setIdActivo(ep.id)          // adelanto visual; `revisarDefault` manda
                    await setDefaultEndpoint(ep.id).catch(() => { })
                    // Arrastrar además lo que YA está sonando: WirePlumber solo
                    // reasigna los streams que siguen al default, y quien tenga un
                    // destino fijado se quedaría en el dispositivo viejo.
                    const name = nodeNameSync(ep) || (await nodeNameOf(ep))
                    if (!name) return
                    execAsync(["bash", "-c",
                      isSpk
                        ? `pactl list short sink-inputs | awk '{print $1}' | xargs -r -I{} pactl move-sink-input {} "${name}"`
                        : `pactl list short source-outputs | awk '{print $1}' | xargs -r -I{} pactl move-source-output {} "${name}"`
                    ]).catch(() => { })
                  }
                  const toggleMute = () => {
                    ep.mute = !ep.mute
                  }

                  return (
                    <box orientation={Gtk.Orientation.VERTICAL} spacing={3} cssClasses={activeClasses}>
                      {/* Clic derecho = apartar. Va en la tarjeta ENTERA y no en un
                          botón porque cualquier botón aquí competiría con el clic
                          izquierdo, que ya está tomado por "elegir este dispositivo"
                          en el nombre y en el slider. El clic derecho estaba libre en
                          toda la tarjeta y no colisiona con el arrastre del slider,
                          que es primario. */}
                      <Gtk.GestureClick
                        button={Gdk.BUTTON_SECONDARY}
                        onPressed={() => alternarOculto(ep)}
                      />
                      <box hexpand>
                        <Gtk.GestureClick
                          button={Gdk.BUTTON_PRIMARY}
                          onPressed={activate}
                        />
                        <box orientation={Gtk.Orientation.VERTICAL} hexpand>
                          <label cssClasses={["qs-audio-name"]} label={etiqueta.titulo} ellipsize={3} halign={Gtk.Align.START} />
                          <label
                            cssClasses={["qs-audio-sub"]}
                            label={etiqueta.subtitulo}
                            visible={etiqueta.subtitulo !== ""}
                            ellipsize={3}
                            halign={Gtk.Align.START}
                          />
                        </box>
                      </box>
                      <box spacing={5} valign={Gtk.Align.CENTER}>
                        <button cssClasses={["qs-audio-card-btn"]} onClicked={toggleMute}>
                          <label cssClasses={["qs-audio-icon"]} label={createComputed(() => deviceIcon(vol(), mute()))} />
                        </button>
                        <box spacing={5} valign={Gtk.Align.CENTER} hexpand>
                          <box hexpand valign={Gtk.Align.CENTER}>
                            <Gtk.GestureClick
                              button={Gdk.BUTTON_PRIMARY}
                              onPressed={activate}
                            />
                            {scale}
                          </box>
                          <InlineEditableValue
                            display={vol((v) => `${aPorcentaje(v)}`)}
                            getValue={() => aPorcentaje(ep.volume)}
                            onCommit={(value) => {
                              const v = desdePorcentaje(value)
                              fijarVolumenEndpoint(ep, v)
                              const p = { ...presets.get(), [devKey]: v }
                              setPresets(p)
                              saveAudioPresets(p)
                            }}
                            min={0} max={VOLUMEN_MAX * 100}
                            labelClass="qs-audio-vol-pct"
                            tooltip=""
                            widthRequest={26}
                          />
                        </box>
                      </box>
                    </box>
                  )
                }}
              </For>
            </box>

            {/* Cajón de descarte: plegado, debajo de todo y solo si hay algo que
                devolver. Es la otra mitad del clic derecho — sin él, apartar un
                dispositivo sería un viaje de ida y habría que ir a editar el JSON
                a mano para recuperarlo. */}
            <box orientation={Gtk.Orientation.VERTICAL} spacing={4} visible={hayOcultos}>
              <button
                cssClasses={["qs-audio-ocultos-cab"]}
                onClicked={() => setOcultosAbiertos(!ocultosAbiertos.get())}
              >
                <box spacing={6}>
                  <label cssClasses={["qs-audio-ocultos-flecha"]} label={ocultosAbiertos((a) => a ? "󰅀" : "󰅂")} />
                  <label
                    cssClasses={["qs-dropdown-header"]}
                    label={endpointsOcultos((l) => `OCULTOS (${l.length})`)}
                    halign={Gtk.Align.START}
                    hexpand
                  />
                </box>
              </button>
              <box orientation={Gtk.Orientation.VERTICAL} spacing={3} visible={ocultosAbiertos}>
                <For each={endpointsOcultos} id={(ep: AstalWp.Endpoint) => ep.id}>
                  {(ep: AstalWp.Endpoint) => {
                    // Fila compacta a propósito: sin slider ni mute. Un dispositivo
                    // apartado no se maneja desde aquí, solo se devuelve a la lista.
                    const etiqueta = endpointLabel(ep)
                    const restaurar = () => alternarOculto(ep)
                    return (
                      <box cssClasses={["qs-audio-oculto"]} spacing={6}>
                        {/* Los dos botones, por simetría con la tarjeta: el clic
                            derecho es el mismo flip-flop, y el ojo lo hace
                            descubrible para quien no sepa que existe. */}
                        <Gtk.GestureClick button={Gdk.BUTTON_SECONDARY} onPressed={restaurar} />
                        <box orientation={Gtk.Orientation.VERTICAL} hexpand>
                          <label cssClasses={["qs-audio-name"]} label={etiqueta.titulo} ellipsize={3} halign={Gtk.Align.START} />
                          <label
                            cssClasses={["qs-audio-sub"]}
                            label={etiqueta.subtitulo}
                            visible={etiqueta.subtitulo !== ""}
                            ellipsize={3}
                            halign={Gtk.Align.START}
                          />
                        </box>
                        <button
                          cssClasses={["qs-audio-card-btn"]}
                          onClicked={restaurar}
                          valign={Gtk.Align.CENTER}
                        ><label cssClasses={["qs-audio-icon"]} label="󰈈" /></button>
                      </box>
                    )
                  }}
                </For>
              </box>
            </box>
          </box>

          <box orientation={Gtk.Orientation.VERTICAL} spacing={4} visible={audioMode((m) => m === "apps")}>
            <label cssClasses={["qs-dropdown-header"]} label={isSpk ? "MEZCLA DE APLICACIONES" : "MEZCLA DE ENTRADAS"} halign={Gtk.Align.START} />
            <box orientation={Gtk.Orientation.VERTICAL} spacing={6}>
              <For each={streams} id={(f: FilaApp) => f.clave}>
                {(fila: FilaApp) => {
                  const props = fila.props
                  const stream = fila.stream
                  const enSilencio = stream === null
                  // La CLAVE del preset sale de `presetsApps.ts`, la MISMA que usa el
                  // vigilante para aplicar. Estaba duplicada a mano aquí y ya costó un
                  // fallo silencioso (la fila de mic guardaba con `mic:` y el poller
                  // aplicaba con `app:mic:`, así que el preset no se releía nunca).
                  const nombreCrudo = nombreDeProps(props)
                  const key = clavePreset(kind, nombreCrudo)
                  // Lo que se ENSEÑA es otra cosa: `application.name` lo pone la app y
                  // llega como binario en minúscula ("spotify") o con sufijo de rol
                  // ("Brave input"). `presentacionApp` lo resuelve —nombre e icono—
                  // contra el `.desktop` instalado; ver `identidadApps.ts`. La clave no
                  // puede seguirle: cambiarla invalidaría `audioPresets.json` y el
                  // vigilante no puede depender de GTK.
                  // Un JUEGO no tiene `.desktop`, así que aquí puede llegar un icono de
                  // recurso (el PNG de `steam_icon_<appid>`) o, sin ninguno, el glifo de
                  // juego de la barra en vez del icono genérico de audio — ver
                  // `presentacionApps.ts`. Las tres formas son excluyentes.
                  const { nombre: name, icono: icon, gicono, glifo } = presentacionApp(props, kind)
                  const iconoFila = glifo
                    ? <label cssClasses={["qs-stream-icon", "qs-stream-glifo"]} label={glifo} />
                    : gicono
                      ? <Gtk.Image gicon={gicono} cssClasses={["qs-stream-icon"]} />
                      : <Gtk.Image iconName={icon} cssClasses={["qs-stream-icon"]} />

                  const presetVal = presets.get()[key]
                  const [currentVol, setCurrentVol] = createState(
                    stream ? stream.volume : (presetVal !== undefined ? presetVal : 1.0),
                  )

                  // El volumen del stream se ESCUCHA. Antes se re-sembraba reconstruyendo
                  // la fila en cada vuelta del sondeo, de ahí que el `<For>` fuera sin
                  // `id` a propósito y que hubiera un congelado de 2,5 s tras tocar el
                  // deslizador para que la vuelta siguiente no lo pisara. Con la señal no
                  // hace falta ninguna de las dos cosas, y un cambio hecho desde fuera
                  // (pavucontrol, `wpctl`, la propia app) se ve al momento.
                  //
                  // La guarda de 300 ms es contra nuestro PROPIO eco: el tramo amplificado
                  // se escribe con `wpctl` (ver `escrituraVolumen.ts`), que tarda, y sin
                  // ella un valor en vuelo volvería como notificación y daría un tirón al
                  // deslizador que el usuario está arrastrando.
                  let ultimaEscritura = 0
                  const avisarCambio: Array<() => void> = []
                  if (stream) {
                    const manejador = stream.connect("notify::volume", () => {
                      if (Date.now() - ultimaEscritura < 300) return
                      setCurrentVol(stream.volume)
                      for (const avisar of avisarCambio) avisar()
                    })
                    onCleanup(() => { try { stream.disconnect(manejador) } catch { } })
                  }

                  const applyVol = (v: number) => {
                    if (!stream) return
                    ultimaEscritura = Date.now()
                    fijarVolumenEndpoint(stream, v)
                  }
                  // El modo "media" (slider ancho tipo Spotify) solo existe para
                  // altavoces; las entradas de micrófono siempre usan el slider "mic".
                  const isMedia = isSpk && (nombreCrudo.toLowerCase().includes("spotify") || props["media.name"])
                  const streamScale = makeScale(
                    isMedia ? ["qs-slider", "media"] : ["qs-slider", isSpk ? "app" : "mic"],
                    () => currentVol.get(),
                    (v) => {
                      setCurrentVol(v)
                      const p = { ...presets.get() }
                      p[key] = v
                      setPresets(p)
                      saveAudioPresets(p)
                      applyVol(v)
                    },
                    // Re-lee el valor cuando el volumen lo cambia OTRO (la propia app,
                    // pavucontrol): sin esto el deslizador se quedaría donde lo dejó el
                    // usuario mientras el número de al lado ya dice otra cosa.
                    (cb) => avisarCambio.push(cb),
                    // El tope de AstalWp es 1.5 y los presets llegan al 200 %; de ese
                    // tramo se encarga `fijarVolumenEndpoint`. Aquí el 200 % solo sube el
                    // techo del deslizador (el mismo boost por app que da pavucontrol).
                    {
                      heightRequest: 4, max: VOLUMEN_MAX, marcarAmplificado: true,
                      ajustar: (v) => ajustarVolumen(v),
                    },
                  )

                  return (
                    <box orientation={Gtk.Orientation.VERTICAL} spacing={0} cssClasses={["qs-wifi-item", "qs-audio-app-item"]}>
                      <box spacing={6} valign={Gtk.Align.CENTER}>
                        <QsRowLabel
                          icon={iconoFila}
                          title={name}
                          titleClass="qs-section-label"
                          spacing={6}
                        />
                        <InlineEditableValue
                          display={currentVol((v) => `${Math.round(v * 100)}`)}
                          getValue={() => currentVol.get() * 100}
                          onCommit={(value) => {
                            const v = value / 100
                            setCurrentVol(v)
                            const p = { ...presets.get(), [key]: v }
                            setPresets(p)
                            saveAudioPresets(p)
                            applyVol(v)
                          }}
                          min={0} max={VOLUMEN_MAX * 100}
                          labelClass={enSilencio ? ["qs-section-pct", "is-silent"] : ["qs-section-pct"]}
                          tooltip=""
                          widthRequest={26}
                        />
                      </box>
                      <box spacing={6}>
                        {streamScale}
                        {enSilencio && <label label={isSpk ? "󰝟" : "󰍭"} cssClasses={["qs-audio-silent-icon"]} />}
                      </box>
                    </box>
                  )
                }}
              </For>
            </box>
          </box>
        </box>
      </Gtk.ScrolledWindow>
    </box>
  )
}

function QsAudioMenu({ onBack }: { onBack: () => void }) {
  return <QsAudioMenuBase kind="speaker" onBack={onBack} />
}

function QsMicMenu({ onBack }: { onBack: () => void }) {
  return <QsAudioMenuBase kind="mic" onBack={onBack} />
}

// ── Section 5: Brightness ─────────────────────────────────────────────────────

function QsDisplayMenu({ onBack }: { onBack: () => void }) {
  const [selectedName, setSelectedName] = createState<string>("")
  const [editingBrightness, setEditingBrightness] = createState(false)
  const [editingTemp, setEditingTemp] = createState(false)
  let brightnessEntry: Gtk.Entry
  let tempEntry: Gtk.Entry

  const commitBrightness = () => {
    const parsed = Number.parseInt(brightnessEntry?.text.trim() ?? "", 10)
    const value = Number.isFinite(parsed)
      ? Math.max(0, Math.min(100, parsed))
      : Math.round(brightness.get() * 100)
    applyBrightness(value / 100)
    saveDisplayConfig()
    if (brightnessEntry) brightnessEntry.text = String(value)
    setEditingBrightness(false)
  }

  const editBrightness = () => {
    if (!brightnessEntry) return
    brightnessEntry.text = String(Math.round(brightness.get() * 100))
    setEditingBrightness(true)
    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      brightnessEntry.grab_focus()
      brightnessEntry.select_region(0, -1)
      return GLib.SOURCE_REMOVE
    })
  }

  const commitTemp = () => {
    const parsed = Number.parseInt(tempEntry?.text.trim() ?? "", 10)
    const value = Number.isFinite(parsed)
      ? Math.max(1500, Math.min(6000, parsed))
      : nightLightTemp.get()
    setManualTemp(value)
    if (tempEntry) tempEntry.text = String(value)
    setEditingTemp(false)
  }

  const editTemp = () => {
    if (!tempEntry) return
    tempEntry.text = String(nightLightTemp.get())
    setEditingTemp(true)
    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      tempEntry.grab_focus()
      tempEntry.select_region(0, -1)
      return GLib.SOURCE_REMOVE
    })
  }

  // El poller de monitores vive en display/service (ref-counted, compartido con
  // la sección Pantalla de Ajustes). Este menú lo adquiere solo con QS abierto Y
  // en la vista "display", y lo libera al salir.
  const evalPoll = () => {
    if (quickSettingsVisible.get() && qsView.get() === "display") acquirePoll()
    else releasePoll()
  }
  quickSettingsVisible.subscribe(evalPoll)
  qsView.subscribe(evalPoll)

  // Corrige la selección si el monitor elegido desaparece (desconexión) o si aún
  // no hay ninguno: cae al enfocado o al primero.
  const fixSelection = () => {
    const list = monitors.get()
    if (list.length && !list.some((m: any) => m.name === selectedName.get())) {
      const f = list.find((m: any) => m.focused) || list[0]
      setSelectedName(f ? f.name : "")
    }
  }
  monitors.subscribe(fixSelection)
  fixSelection()

  const selected = createComputed(() => {
    const list = monitors()
    const name = selectedName()
    return list.find((m: any) => m.name === name) || null
  })

  const enabledCount = () => monitors().filter((m: any) => !m.disabled).length
  const canDisable = (mon: any) => mon.disabled || enabledCount() > 1

  const brightScale = makeScale(
    ["qs-slider", "brightness"],
    () => brightness.get(),
    (v) => {
      applyBrightness(v)
      saveDisplayConfig()
    },
    (cb) => brightness.subscribe(cb),
  )

  const tempScale = makeScale(
    ["qs-slider", "temperature"],
    () => (nightLightTemp.get() - 1500) / 4500,
    (v) => setManualTemp(Math.round(v * 4500 + 1500)),
    (cb) => nightLightTemp.subscribe(cb),
  )
  nightLightTemp.subscribe(() => { tempScale.adjustment.value = (nightLightTemp.get() - 1500) / 4500 })

  return (
    <overlay cssClasses={["display-select-host"]} hexpand>
    <box cssClasses={["qs-display-menu"]} orientation={Gtk.Orientation.VERTICAL} spacing={5} hexpand>
      <QsMenuHeader title="Pantalla" onBack={onBack} />

      {/* Selector de monitor — innecesario si solo hay una pantalla. */}
      <With value={createComputed(() => monitors().length > 1)}>
        {(hasMultipleMonitors: boolean) => hasMultipleMonitors && (
          <box orientation={Gtk.Orientation.VERTICAL} spacing={5}>
            <label
              cssClasses={["qs-dropdown-header", "qs-display-detected-title"]}
              label="PANTALLAS DETECTADAS"
              halign={Gtk.Align.START}
              marginStart={10}
              marginEnd={10}
            />
            <box cssClasses={["qs-display-monitor-tabs"]} spacing={6} marginStart={10} marginEnd={10}>
              {/* Indexado por conector: `monitors` se repuebla con objetos NUEVOS en
                  cada sondeo de `hyprctl monitors -j` (cada 2 s mientras esta vista
                  está abierta), así que sin clave bastaba mover el foco de pantalla
                  para rehacer todas las pastillas. El punto de foco es lo único que
                  cambia, y por eso se lee del state en vez del objeto capturado. */}
              <For each={monitors} id={(m: any) => m.name}>
                {(m: any) => (
                  <button
                    cssClasses={selectedName((n) => n === m.name ? ["qs-display-monitor-pill", "active"] : ["qs-display-monitor-pill"])}
                    onClicked={() => setSelectedName(m.name)}
                  >
                    <box spacing={5} valign={Gtk.Align.CENTER}>
                      <label
                        cssClasses={["qs-display-monitor-dot"]}
                        label="●"
                        visible={monitors((lista: any[]) =>
                          !!lista.find((actual: any) => actual.name === m.name)?.focused)}
                      />
                      <label label={m.name} ellipsize={3} maxWidthChars={14} />
                    </box>
                  </button>
                )}
              </For>
            </box>
          </box>
        )}
      </With>

      {/* Gestión del monitor seleccionado */}
      <box cssClasses={["qs-section", "qs-display-panel"]} orientation={Gtk.Orientation.VERTICAL} spacing={6}
        visible={createComputed(() => monitors().length > 1)}>
        {/* Encendido */}
        <box spacing={6} visible={createComputed(() => monitors().length > 1)}>
          <label cssClasses={["qs-section-icon"]} label="󰍹" />
          <label cssClasses={["qs-section-label"]} label="Encendido" hexpand halign={Gtk.Align.START} />
          <Interruptor
            activo={createComputed(() => { const s = selected(); return s ? !s.disabled : false })}
            alAlternar={() => {
              const s = selected(); if (!s) return
              if (!s.disabled && !canDisable(s)) return // guarda: no apagar el último activo
              applyPatch(s, { enabled: s.disabled })
            }}
          />
        </box>

        {/* Controles (ocultos si el monitor está apagado) */}
        <box orientation={Gtk.Orientation.VERTICAL} spacing={3}
          visible={createComputed(() => { const s = selected(); return !!s && !s.disabled })}>

          {/* Los ajustes de modo solo son útiles al gestionar varias pantallas. */}
          <With value={createComputed(() => monitors().length > 1)}>
            {(hasMultipleMonitors: boolean) => hasMultipleMonitors && (
              <box orientation={Gtk.Orientation.VERTICAL} spacing={3}>
                {/* Resolución (lista general — Hyprland acepta modos no nativos) */}
                <box orientation={Gtk.Orientation.VERTICAL} spacing={0} cssClasses={["qs-display-compact-field"]}>
                  <label cssClasses={["qs-dropdown-header"]} label="RESOLUCIÓN" halign={Gtk.Align.START} />
                  <DisplaySelect
                    compact
                    current={createComputed(() => { const s = selected(); return s ? `${s.width}×${s.height}` : "—" })}
                    options={createComputed(() => {
                      const s = selected()
                      if (!s || s.disabled) return []
                      return resolutionOptions(s.availableModes).map(o => ({
                        label: o.label, value: o.key, active: s.width === o.w && s.height === o.h,
                      }))
                    })}
                    onSelect={(value) => {
                      const s = selected(); if (!s) return
                      applyPatch(s, { mode: `${value}@${s.refreshRate.toFixed(2)}Hz` })
                    }}
                  />
                </box>

                {/* Frecuencia */}
                <box orientation={Gtk.Orientation.VERTICAL} spacing={0} cssClasses={["qs-display-compact-field"]}>
                  <label cssClasses={["qs-dropdown-header"]} label="FRECUENCIA" halign={Gtk.Align.START} />
                  <DisplaySelect
                    compact
                    current={createComputed(() => { const s = selected(); return s ? `${Math.round(s.refreshRate)} Hz` : "—" })}
                    options={createComputed(() => {
                      const s = selected()
                      if (!s || s.disabled) return []
                      return refreshOptions(s.availableModes).map(o => ({
                        label: `${o.hz} Hz`, value: o.raw, active: Math.round(s.refreshRate) === o.hz,
                      }))
                    })}
                    onSelect={(value) => {
                      const s = selected(); if (!s) return
                      applyPatch(s, { mode: `${s.width}x${s.height}@${value}Hz` })
                    }}
                  />
                </box>

                {/* Escala */}
                <box orientation={Gtk.Orientation.VERTICAL} spacing={0} cssClasses={["qs-display-compact-field"]}>
                  <label cssClasses={["qs-dropdown-header"]} label="ESCALA" halign={Gtk.Align.START} />
                  <DisplaySelect
                    compact
                    current={createComputed(() => { const s = selected(); return s ? matchScalePreset(s.scale).toFixed(2) : "—" })}
                    options={createComputed(() => {
                      const s = selected()
                      if (!s || s.disabled) return []
                      const cur = matchScalePreset(s.scale)
                      return SCALE_PRESETS.map(sc => ({ label: sc.toFixed(2), value: String(sc), active: sc === cur }))
                    })}
                    onSelect={(value) => {
                      const s = selected(); if (!s) return
                      applyPatch(s, { scale: Number(value) })
                    }}
                  />
                </box>
              </box>
            )}
          </With>

          {/* Duplicar (mirror) — solo con 2+ monitores */}
          <box orientation={Gtk.Orientation.VERTICAL} spacing={0} cssClasses={["qs-display-compact-field"]}
            visible={createComputed(() => monitors().length > 1)}>
            <label cssClasses={["qs-dropdown-header"]} label="DUPLICAR EN" halign={Gtk.Align.START} />
            <DisplaySelect
              compact
              current={createComputed(() => {
                const s = selected()
                return s && s.mirrorOf && s.mirrorOf !== "none" ? s.mirrorOf : "Ninguno"
              })}
              options={createComputed(() => {
                const s = selected()
                if (!s) return []
                const noMirror = !s.mirrorOf || s.mirrorOf === "none"
                const opts = [{ label: "Ninguno", value: "none", active: noMirror }]
                for (const m of monitors()) {
                  if (m.name === s.name) continue
                  opts.push({ label: m.name, value: m.name, active: s.mirrorOf === m.name })
                }
                return opts
              })}
              onSelect={(value) => {
                const s = selected(); if (!s) return
                applyPatch(s, { mirrorOf: value })
              }}
            />
          </box>
        </box>
      </box>

      {/* Brillo + Luz nocturna. El brillo solo se muestra si hay backend (panel interno o
          DDC/CI); ver `display/brightness.ts`. */}
      <box cssClasses={["qs-section", "qs-display-panel"]} orientation={Gtk.Orientation.VERTICAL} spacing={6}>
        <box orientation={Gtk.Orientation.VERTICAL} spacing={0} visible={brightnessSupported}>
          <box spacing={6}>
            <label cssClasses={["qs-section-icon", "bright"]} label="󰃟" />
            <label cssClasses={["qs-section-label"]} label="Brillo" hexpand halign={Gtk.Align.START} />
            <button
              cssClasses={["qs-inline-value-btn"]}
              visible={editingBrightness((editing) => !editing)}
              onClicked={editBrightness}
            >
              <label cssClasses={["qs-section-pct"]} label={brightness((v) => `${Math.round(v * 100)}`)} />
            </button>
            <Gtk.Entry
              cssClasses={["qs-inline-number-input"]}
              visible={editingBrightness}
              maxLength={3}
              widthChars={3}
              widthRequest={28}
              heightRequest={16}
              xalign={1}
              inputPurpose={Gtk.InputPurpose.DIGITS}
              $={(self: Gtk.Entry) => {
                brightnessEntry = self
                self.text = String(Math.round(brightness.get() * 100))
              }}
              onActivate={commitBrightness}
            >
              <Gtk.EventControllerFocus onLeave={commitBrightness} />
            </Gtk.Entry>
          </box>
          {brightScale}
        </box>

        <box orientation={Gtk.Orientation.VERTICAL} spacing={2} cssClasses={["qs-night-light-block"]}>
          <box spacing={6}>
            <label cssClasses={["qs-section-icon", "night"]} label="󰌾" />
            <label cssClasses={["qs-section-label"]} label="Luz nocturna" hexpand halign={Gtk.Align.START} />
            <button
              cssClasses={["qs-inline-value-btn"]}
              visible={editingTemp((editing) => !editing)}
              onClicked={editTemp}
            >
              <label cssClasses={["qs-section-pct"]} label={nightLightTemp((t) => `${t}K`)} />
            </button>
            <Gtk.Entry
              cssClasses={["qs-inline-number-input"]}
              visible={editingTemp}
              maxLength={4}
              widthChars={4}
              widthRequest={34}
              heightRequest={16}
              xalign={1}
              inputPurpose={Gtk.InputPurpose.DIGITS}
              $={(self: Gtk.Entry) => {
                tempEntry = self
                self.text = String(nightLightTemp.get())
              }}
              onActivate={commitTemp}
            >
              <Gtk.EventControllerFocus onLeave={commitTemp} />
            </Gtk.Entry>
            <Interruptor activo={nightOn} alAlternar={() => toggleNightNow()} />
          </box>
          {tempScale}
        </box>
      </box>
    </box>
    </overlay>
  )
}

// ── Section 5b: Cámara ────────────────────────────────────────────────────────
//
// Hermano de `QsDisplayMenu`: cabecera + `qs-section`, y los mismos mandos
// (`makeScale`, `InlineEditableValue`, `Interruptor`, `DisplaySelect`).
//
// Lo que NO se parece a los demás submenús: aquí la lista de mandos se GENERA
// de lo que publica el aparato. El juego de controles lo decide el firmware —
// una C920 publica ~15 y una webcam integrada barata dos—, así que una lista
// fija de sliders estaría medio muerta en la mitad de las máquinas sin dar
// ningún error. Ver la cabecera de `servicios/camara/controlesDatos.ts`.

function QsCamaraMenu({ onBack }: { onBack: () => void }) {
  const ciclo = crearCicloVida()
  const [claveSel, setClaveSel] = createState<string>("")
  // La ESTRUCTURA (qué mandos hay) y los VALORES van por separado, porque
  // cambian a ritmos distintos: la primera casi nunca (otra cámara, un hotplug,
  // un desbloqueo) y los segundos en cada escritura. Publicar los valores en la
  // misma lista hacía que el `<For>` desparentara y volviera a parentar sus
  // filas en cada lectura aunque los mandos fueran los mismos (ver
  // `mismasFilas`), y en GTK4 desparentar es desmapear y desrealizar. Con
  // `equals` por claves, `filas` solo emite cuando de verdad cambia la lista de
  // mandos; lo que se mueve a cada rato es `controles`, al que se suscribe cada
  // fila sin tocar la jerarquía de widgets.
  const [controles, setControles] = createState<Control[]>([])
  const [filas, setFilas] = createState<FilaControlCamara[]>([], { equals: mismasFilas })
  const [cargando, setCargando] = createState(false)

  /** Publica una lectura: primero los valores, para que una fila recién
   *  construida por el `<For>` ya nazca con los buenos. */
  const publicar = (claveCamara: string, lista: Control[]) => {
    setControles(lista)
    setFilas(componerFilas(claveCamara, lista))
  }

  // Las tres dependencias en la forma de ARRAY, no un `() => a() && b()`:
  // `createComputed` con función solo se suscribe a lo que llegó a LEER en la
  // primera pasada, así que un `&&` que cortocircuite deja fuera para siempre a
  // la dependencia que no se evaluó (comentario largo en
  // `modulos/barra/indicadores/audio/Microfono.tsx`).
  const camaraSel = createComputed(
    [camaras, claveSel, estadoCamara],
    (lista, clave, estado) => resolverCamaraVisible(lista, clave, estado.preferida),
  )

  // Una lectura en vuelo puede terminar DESPUÉS de que la cámara haya cambiado
  // (un hotplug, o el usuario tocando el selector): publicar esa lista tardía
  // dejaría los mandos con los valores y los rangos de OTRO aparato, sin un solo
  // error por medio. El contador descarta lo que llega fuera de tiempo.
  let generacion = 0

  const recargar = async () => {
    const camara = camaraSel.get()
    const gen = ++generacion
    if (!camara) {
      publicar("", [])
      setCargando(false)
      return
    }
    setCargando(true)
    const lista = await leerControles(camara.nodo)
    if (gen !== generacion) return
    publicar(camara.clave, lista)
    setCargando(false)
  }

  // Escritura "de una vez" (interruptor, desplegable, número tecleado).
  //
  // RELEER después no es opcional: encender o apagar un automático cambia el
  // `inactive` de los controles que gobierna —`white_balance_temperature` mientras
  // `white_balance_automatic` está puesto, `exposure_time_absolute` mientras
  // `auto_exposure` es automático— y V4L2 no emite nada al respecto. Sin la
  // relectura, el mando dependiente se queda deshabilitado (o habilitado)
  // MINTIENDO hasta que se cierra y se reabre el panel.
  const escribir = (nombre: string, valor: number) => {
    const camara = camaraSel.get()
    if (!camara) return
    void fijarControl(camara.nodo, nombre, valor).then((ok) => {
      if (!ok) return
      recordarControl(camara, nombre, valor)
      return recargar()
    })
  }

  // Igual que el menú de Pantalla adquiere y suelta su poller: aquí no hay
  // sondeo, pero sí procesos (`v4l2-ctl`) y una ventana de mpv que no pueden
  // quedarse vivos con el panel cerrado.
  let vistaActiva = false
  const evaluarVista = () => {
    const ahora = quickSettingsVisible.get() && qsView.get() === "camara"
    if (ahora === vistaActiva) return
    vistaActiva = ahora
    // Al ENTRAR se relee siempre. Los controles no viven en la cámara sino en el
    // driver, y pueden haber cambiado por fuera mientras el panel estaba cerrado
    // (otra app, `v4l2-ctl` a mano, un desenchufe que los devolvió a fábrica);
    // no existe ninguna señal que avise de eso.
    if (ahora) void recargar()
    else cerrarVistaPrevia()
  }
  ciclo.suscribir(quickSettingsVisible, evaluarVista)
  ciclo.suscribir(qsView, evaluarVista)
  // Y al desmontarse el panel, por si se destruye sin pasar por "main".
  ciclo.registrar(() => cerrarVistaPrevia())

  // Bloquear o desbloquear cambia lo que `v4l2-ctl` puede LEER, no solo lo que las apps pueden
  // abrir: con la cámara bloqueada los nodos quedan en modo 000 y `--list-ctrls-menus` falla por
  // permisos. Sin releer aquí, desbloquear dejaría la vista con el cartel de "bloqueada" y sin un
  // solo mando hasta salir y volver a entrar.
  ciclo.suscribir(camaraBloqueada, () => { if (vistaActiva) void recargar() })

  // Hotplug. `camaras` cambia en caliente con los `uevent` de udev.
  ciclo.suscribir(camaras, (lista) => {
    if (!lista.length) {
      // La última cámara se ha ido: el tile ya se ha ocultado solo y quedarse
      // aquí sería una vista sin nada que ajustar y con sliders apuntando a un
      // `/dev/videoN` que ya no existe (escribir ahí falla en un `execAsync` que
      // nadie mira, o sea sin más síntoma que "no hace nada").
      generacion++
      publicar("", [])
      setCargando(false)
      cerrarVistaPrevia()
      if (qsView.get() === "camara") onBack()
      return
    }
    const elegida = resolverCamaraVisible(lista, claveSel.get(), estadoCamara.get().preferida)
    if (elegida && elegida.clave !== claveSel.get()) setClaveSel(elegida.clave)
    // Se relee aunque la clave no cambie: reenchufar la misma cámara la renumera
    // (`/dev/video2` → `/dev/video0`) y el nodo capturado sería el viejo.
    if (vistaActiva) void recargar()
  })

  const seleccionar = (clave: string) => {
    setClaveSel(clave)
    // Se recuerda como preferida, que en este shell significa "la que nombra el
    // tile y la que abre la vista previa" — y NADA más: en Linux no existe una
    // cámara por defecto del sistema (ver `camaraPreferida` en `persistencia.ts`).
    fijarPreferida(clave)
    void recargar()
  }

  const restablecer = () => {
    const camara = camaraSel.get()
    if (!camara) return
    const gen = ++generacion
    setCargando(true)
    void restablecerControles(camara.nodo).then((lista) => {
      // Las DOS cosas. Devolver el aparato a los valores de fábrica sin olvidar
      // lo guardado haría que el siguiente arranque (`restaurarControles`)
      // volviera a imponer los viejos, y el botón parecería no haber servido de
      // nada un rato después, ya sin nadie mirando.
      olvidarCamara(camara.clave)
      if (gen !== generacion) return
      publicar(camara.clave, lista)
      setCargando(false)
    })
  }

  // ── Una fila por control ──────────────────────────────────────────────────
  //
  // El `<For>` va indexado por `fila.clave`, que lleva la cámara delante del
  // nombre del control: la fila se construye UNA vez y su geometría (min, max,
  // step) se congela ahí, así que reutilizarla para otra cámara dejaría el
  // deslizador con la escala equivocada. Todo lo que sí cambia —valor, inactivo,
  // opciones— se lee del accessor `vivo`, nunca del objeto capturado.
  const FilaControl = (fila: FilaControlCamara) => {
    const cicloFila = crearCicloVida()
    const nombre = fila.control.nombre
    const vivo = createComputed(
      [controles],
      (lista) => lista.find((c) => c.nombre === nombre) ?? fila.control,
    )
    // `inactivo` = encadenado a un automático encendido. Escribir en él NO da
    // error y NO hace nada (`v4l2-ctl` devuelve 0 tan contento), así que el mando
    // tiene que quedarse muerto en vez de dejar arrastrar algo que no mueve la
    // imagen. Un contenedor insensible arrastra a sus hijos en GTK4.
    const sensible = vivo((c) => !c.inactivo)

    const cabecera = (clases: string[]) => (
      <box spacing={6} hexpand>
        <label
          cssClasses={clases}
          label={etiquetaControl(nombre)}
          hexpand
          halign={Gtk.Align.START}
          ellipsize={3}
        />
        {/* Por qué está apagado, dicho donde se ve. Sin esto el mando parece roto. */}
        <label
          cssClasses={["qs-camara-inactivo"]}
          label="automático"
          visible={vivo((c) => c.inactivo)}
        />
      </box>
    )

    if (fila.control.tipo === "int") {
      const geo = geometriaControl(fila.control)
      // Valor local mientras se arrastra: sin él, la relectura que llega al
      // soltar (o la que dispara un control vecino) reescribiría `adj.value` en
      // mitad del gesto y daría un tirón al deslizador.
      let pendiente: number | null = null
      let temporizador: number | null = null

      // `v4l2-ctl` es un PROCESO por llamada y `change-value` se dispara en cada
      // píxel del arrastre: sin estrangular, medio segundo de gesto son decenas
      // de procesos. Mismo throttle que el volumen (60 ms, último valor gana).
      const aplicar = makeVolThrottle((valor: number) => {
        const camara = camaraSel.get()
        if (camara) void fijarControl(camara.nodo, nombre, valor)
      })

      // Persistir y releer SOLO al soltar. `conectarCambioDeslizador` no expone
      // un evento de soltado —`change-value` es lo único que llega, y llega
      // igual con el ratón que con las flechas—, así que "soltar" se aproxima
      // con 300 ms de silencio. Escribir el JSON y lanzar otro `v4l2-ctl` por
      // píxel no aporta nada y despierta a cualquiera que vigile el fichero.
      const asentar = (valor: number) => {
        if (temporizador !== null) GLib.source_remove(temporizador)
        temporizador = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
          temporizador = null
          const camara = camaraSel.get()
          if (camara) recordarControl(camara, nombre, valor)
          void recargar().then(() => {
            pendiente = null
            // La relectura ya publicó `filas` con `pendiente` todavía puesto, así
            // que el deslizador no se enteró: se encaja aquí con lo que el
            // aparato dice de verdad (que puede no ser lo pedido — `v4l2-ctl`
            // acota en silencio).
            escala.adjustment.value = geo.aPosicion(vivo.get().valor)
          })
          return GLib.SOURCE_REMOVE
        })
      }
      cicloFila.registrar(() => {
        if (temporizador !== null) GLib.source_remove(temporizador)
      })

      const escala = makeScale(
        ["qs-slider", "qs-camara-slider"],
        () => pendiente ?? geo.aPosicion(vivo.get().valor),
        (posicion) => {
          pendiente = posicion
          const valor = geo.aValor(posicion)
          aplicar(valor)
          asentar(valor)
        },
        // ⚠️ SE ESCUCHA LO QUE SE LEE: `vivo`, no el estado del que deriva. Esta
        // suscripción iba al estado (antes `filas`, hoy sería `controles`) y el
        // deslizador se quedaba **un cambio por detrás para siempre**: al
        // restablecer, las etiquetas pasaban a 0 y 32 y el relleno de la barra
        // seguía clavado en 40 y 10 (medido en píxeles sobre la captura del
        // panel), sin ningún error de por medio. No lo trajo el reparto
        // estructura/valores de arriba: estaba desde antes, con `filas`.
        //
        // La causa está en `DEPRECATED_createComputedArgs` (`gnim/jsx/state.ts`)
        // y hacen falta las dos mitades: (1) el derivado solo refresca su caché
        // de dependencias DENTRO de su propia suscripción al origen, así que un
        // suscriptor del origen registrado antes que él —y este lo estaba: se
        // engancha al construir la fila, antes de que ningún binding del JSX
        // toque `vivo`— corre primero; y (2) su `get()` de reserva
        // (`value !== nil ? value : compute()`) solo vuelve a `peek()` una
        // dependencia **si su hueco de caché está vacío**, y `makeScale` lo
        // llena al sembrar `adj.value` en la construcción. Reproducido con la
        // propia librería bajo node: suscrito al origen lee el valor viejo,
        // suscrito al derivado lee el nuevo.
        (cb) => { cicloFila.suscribir(vivo, () => cb()) },
        // El deslizador se mueve en PASOS, no en el valor crudo: hay controles
        // con `step=16` o `step=64` y escribir fuera de esa rejilla se redondea
        // en silencio. Ver `geometriaControl`.
        { max: geo.pasos, ajustar: (p: number) => Math.round(p) },
      )

      return (
        <box
          cssClasses={["qs-camara-control"]}
          orientation={Gtk.Orientation.VERTICAL}
          spacing={0}
          sensitive={sensible}
        >
          <box spacing={6}>
            {cabecera(["qs-section-label"])}
            <InlineEditableValue
              display={vivo((c) => `${c.valor}`)}
              getValue={() => vivo.get().valor}
              onCommit={(valor: number) => {
                // El componente ya acota a min..max; falta imantar al `step` del
                // aparato, o el número tecleado no sería el que acaba puesto.
                pendiente = null
                escribir(nombre, geo.aValor(geo.aPosicion(valor)))
              }}
              min={fila.control.min}
              max={fila.control.max}
              labelClass="qs-section-pct"
              maxLength={5}
              widthRequest={40}
            />
          </box>
          {escala}
        </box>
      )
    }

    if (fila.control.tipo === "bool") {
      return (
        <box cssClasses={["qs-camara-control"]} spacing={6} sensitive={sensible}>
          {cabecera(["qs-section-label"])}
          <Interruptor
            activo={vivo((c) => c.valor !== 0)}
            sensible={sensible}
            alAlternar={() => escribir(nombre, vivo.get().valor !== 0 ? 0 : 1)}
          />
        </box>
      )
    }

    // `menu`: las opciones las publica el aparato (`--list-ctrls-menus`), no una
    // tabla nuestra — "50 Hz"/"60 Hz" en `power_line_frequency`, los cuatro modos
    // de `auto_exposure`…
    return (
      <box
        cssClasses={["qs-camara-control", "qs-display-compact-field"]}
        orientation={Gtk.Orientation.VERTICAL}
        spacing={0}
        sensitive={sensible}
      >
        {cabecera(["qs-dropdown-header"])}
        <DisplaySelect
          compact
          current={vivo((c) => c.opciones.find((o) => o.valor === c.valor)?.etiqueta ?? String(c.valor))}
          options={vivo((c) => c.opciones.map((o) => ({
            label: o.etiqueta,
            value: String(o.valor),
            active: o.valor === c.valor,
          })))}
          onSelect={(value: string) => escribir(nombre, Number(value))}
        />
      </box>
    )
  }

  return (
    // El overlay con `display-select-host` es obligatorio: es donde `DisplaySelect`
    // cuelga su lista desplegada (no usa un Gtk.Popover para no robarle el foco al
    // panel). Sin él, los desplegables de menú no se abren y no avisan.
    <overlay cssClasses={["display-select-host"]} hexpand>
    <box cssClasses={["qs-camara-menu"]} orientation={Gtk.Orientation.VERTICAL} spacing={5} hexpand>
      <QsMenuHeader title="Cámara" onBack={onBack} />

      {/* Aviso discreto de privacidad: quién la tiene abierta. */}
      <box cssClasses={["qs-camara-aviso"]} spacing={6} visible={camaraEnUso}>
        <label cssClasses={["qs-camara-aviso-icono"]} label="󰄉" />
        <label
          cssClasses={["qs-camara-aviso-texto"]}
          label={usoCamara((u) => descripcionUso(u))}
          hexpand
          halign={Gtk.Align.START}
          ellipsize={3}
        />
      </box>

      {/* Killswitch. `visible` atado a `bloqueoDisponible`: en un equipo donde el paso
          `sistema` del instalador no llegó a correr no existe el helper root-owned, y un
          interruptor que fallara con "command not found" al pulsarlo es peor que no tenerlo.
          El resto de esta vista no depende de él.

          Insensible mientras hay una orden en vuelo: `udevadm settle` tarda un instante y dos
          pulsaciones seguidas se pisarían, dejando el interruptor y el sistema en desacuerdo. */}
      <box
        cssClasses={["qs-section", "qs-camara-bloqueo"]}
        spacing={8}
        visible={bloqueoDisponible}
      >
        <label
          cssClasses={camaraBloqueada((b) =>
            b ? ["qs-section-icon", "bloqueada"] : ["qs-section-icon"])}
          label={camaraBloqueada((b) => (b ? "󰄚" : "󰄀"))}
        />
        <box orientation={Gtk.Orientation.VERTICAL} hexpand halign={Gtk.Align.START}>
          <label cssClasses={["qs-section-label"]} label="Cámara bloqueada" halign={Gtk.Align.START} />
          {/* Lo que el interruptor NO hace, dicho donde se decide. Bloquear impide ABRIR la
              cámara; no cierra un descriptor ya abierto, así que una videollamada en curso
              sigue viendo imagen hasta que suelte el dispositivo. Callarlo dejaría al usuario
              creyendo que ha cortado algo que sigue emitiendo. */}
          <label
            cssClasses={["qs-camara-bloqueo-nota"]}
            label={createComputed([camaraBloqueada, camaraEnUso], (bloqueada, enUso) =>
              bloqueada && enUso
                ? "Una app la tenía abierta: seguirá viéndola hasta que la cierre"
                : "Impide que las apps la abran")}
            wrap
            halign={Gtk.Align.START}
          />
        </box>
        <Interruptor
          activo={camaraBloqueada}
          alAlternar={alternarBloqueo}
          sensible={bloqueoOcupado((ocupado) => !ocupado)}
        />
      </box>

      {/* Selector — no se pinta con una sola cámara, igual que el de monitores. */}
      <box
        cssClasses={["qs-section", "qs-camara-selector"]}
        orientation={Gtk.Orientation.VERTICAL}
        spacing={0}
        visible={createComputed([camaras], (lista) => lista.length > 1)}
      >
        <label cssClasses={["qs-dropdown-header"]} label="CÁMARA" halign={Gtk.Align.START} />
        <DisplaySelect
          compact
          current={camaraSel((c: Camara | null) => c?.nombre ?? "—")}
          options={createComputed([camaras, camaraSel], (lista, actual) =>
            lista.map((c) => ({ label: c.nombre, value: c.clave, active: c.clave === actual?.clave })))}
          onSelect={seleccionar}
        />
      </box>

      <box cssClasses={["qs-section", "qs-camara-panel"]} orientation={Gtk.Orientation.VERTICAL} spacing={4}>
        {/* Ni sección vacía ni sliders muertos: lo que hay es lo que se dice. */}
        {/* Con la cámara BLOQUEADA, `v4l2-ctl` falla por permisos y la lista sale vacía: el
            texto de "no expone controles" sería falso y mandaría a buscar un problema en el
            aparato. La causa se dice tal cual. */}
        <label
          cssClasses={["qs-camara-vacio"]}
          label={camaraBloqueada((b) => b
            ? "Cámara bloqueada: desbloquéala para ajustarla"
            : "Esta cámara no expone controles ajustables")}
          wrap
          halign={Gtk.Align.CENTER}
          visible={createComputed([filas, cargando], (lista, ocupado) => !ocupado && lista.length === 0)}
        />
        <Gtk.ScrolledWindow
          cssClasses={["qs-camara-scroll"]}
          hscrollbarPolicy={Gtk.PolicyType.NEVER}
          vscrollbarPolicy={Gtk.PolicyType.AUTOMATIC}
          propagateNaturalHeight
          maxContentHeight={340}
        >
          <box orientation={Gtk.Orientation.VERTICAL} spacing={4}>
            <For each={filas} id={(fila: FilaControlCamara) => fila.clave}>
              {(fila: FilaControlCamara) => FilaControl(fila)}
            </For>
          </box>
        </Gtk.ScrolledWindow>
      </box>

      <box cssClasses={["qs-camara-acciones"]} spacing={6} homogeneous>
        <button
          cssClasses={["qs-camara-btn"]}
          sensitive={hayCamara}
          onClicked={() => {
            const camara = camaraSel.get()
            if (camara) abrirVistaPrevia(camara)
          }}
        >
          <box spacing={6} halign={Gtk.Align.CENTER}>
            <label cssClasses={["qs-camara-btn-icono"]} label="󰄀" />
            <label label="Probar" />
          </box>
        </button>
        <button
          cssClasses={["qs-camara-btn", "restablecer"]}
          sensitive={hayCamara}
          onClicked={restablecer}
        >
          <box spacing={6} halign={Gtk.Align.CENTER}>
            <label cssClasses={["qs-camara-btn-icono"]} label="󰑐" />
            <label label="Restablecer" />
          </box>
        </button>
      </box>
    </box>
    </overlay>
  )
}

// ── Section 6: Footer ─────────────────────────────────────────────────────────

function QsFooter() {
  const user = GLib.get_user_name() ?? "user"
  const host = GLib.get_host_name() ?? "host"
  const initials = user.slice(0, 2).toUpperCase()

  return (
    <box cssClasses={["qs-footer"]} spacing={10}>
      <box cssClasses={["qs-user-block"]} spacing={10} hexpand halign={Gtk.Align.START}>
        <ProfileAvatar
          size={30}
          fallbackLabel={initials}
          fallbackCssClasses={["qs-avatar"]}
          borderWidth={1}
          borderRgba={[139 / 255, 120 / 255, 1, 0.3]}
        />
        <box orientation={Gtk.Orientation.VERTICAL} spacing={1} valign={Gtk.Align.CENTER}>
          <label cssClasses={["qs-username"]} label={user} halign={Gtk.Align.START} />
          <label cssClasses={["qs-hostname"]} label={`@${host}`} halign={Gtk.Align.START} />
        </box>
      </box>

      <button
        cssClasses={["qs-icon-btn", "qs-user-settings-btn"]}
        onClicked={() => openSettingsPanel()}
        valign={Gtk.Align.CENTER}
      >
        <label label="󰒓" />
      </button>

    </box>
  )
}


// ── Bluetooth Menu ────────────────────────────────────────────────────────────
function QsBluetoothMenu({ onBack }: { onBack: () => void }) {
  const bt = AstalBluetooth.get_default()
  const btPowered = createBinding(bt, "isPowered")
  const [btSupported, setBtSupported] = createState(!!bt.adapter)
  const [devices, setDevices] = createState<any[]>(bt.get_devices())
  const [scanning, setScanning] = createState(false)
  const [showUnnamed, setShowUnnamed] = createState(false)
  const [buffering, setBuffering] = createState(false)
  const [search, setSearch] = createState("")

  const matchesSearch = (dev: any, query: string) => {
    if (!query) return true
    return [dev.alias, dev.name, dev.address]
      .some((v) => v && String(v).toLowerCase().includes(query))
  }

  // ── Cambios de PROPIEDAD de cada dispositivo ────────────────────────────────
  // `notify::devices` y `device-added`/`device-removed` solo hablan de ALTAS y
  // BAJAS en la lista: si un dispositivo YA descubierto cambia de nombre o de
  // estado, no salta ninguna señal del objeto raíz — el mismo agujero que ya
  // documenta el tile más arriba ("`notify::devices` no salta y el tile se
  // quedaba en Desconectado con los cascos puestos").
  //
  // Durante el discovery ese caso es la NORMA, no la excepción: BlueZ publica el
  // dispositivo en cuanto lo oye, con solo la MAC, y resuelve el nombre unos
  // segundos más tarde. Antes eso se tapaba con un `setInterval(update, 1000)`
  // que vivía lo que durase el escaneo. Escuchar a cada dispositivo cuesta lo
  // mismo de escribir, no despierta a nadie cuando no pasa nada, y de paso cubre
  // lo que el intervalo NO cubría: fuera de un escaneo no había refresco
  // ninguno, así que conectar unos cascos desde el propio aparato no se veía en
  // la lista hasta el siguiente escaneo.
  //
  // Las suscripciones se rehacen en cada `update()` (altas nuevas) y se sueltan
  // las de los dispositivos que ya no están: sin eso, un escaneo largo en una
  // zona concurrida deja cientos de handlers colgando de objetos muertos.
  const devSignals = new Map<any, number[]>()
  const DEV_PROPS = [
    "notify::alias", "notify::name", "notify::icon",
    "notify::connected", "notify::paired", "notify::trusted",
  ]
  const wireDevices = (lista: any[]) => {
    const vivos = new Set(lista)
    for (const [dev, ids] of devSignals) {
      if (vivos.has(dev)) continue
      for (const id of ids) { try { dev.disconnect(id) } catch {} }
      devSignals.delete(dev)
    }
    for (const dev of lista) {
      if (devSignals.has(dev)) continue
      const ids: number[] = []
      // El guard de `inBtView` va DENTRO del handler, no alrededor del connect:
      // el mismo criterio que el resto de señales de esta vista — se sigue
      // suscrito, pero con el QS cerrado o en otra pestaña no se reconstruye
      // nada. Evaluarlo aquí lo congelaría al valor del momento del alta.
      for (const sig of DEV_PROPS) {
        try { ids.push(dev.connect(sig, () => { if (inBtView()) update() })) } catch {}
      }
      devSignals.set(dev, ids)
    }
  }

  const update = () => {
    if (buffering.get()) return
    const lista = bt.get_devices()
    wireDevices(lista)
    setDevices(lista)
  }

  // ── El discovery vive lo que dura la VISTA, no un contador ──────────────────
  // Antes el escaneo era una RÁFAGA con `duration` (5 s al entrar, 15 s desde el
  // botón) y al agotarse se llamaba a `stop_discovery()`. Sin discovery activo
  // BlueZ no vuelve a oír a nadie: a partir de ese segundo 5 la lista quedaba
  // CONGELADA mientras el usuario seguía mirándola, y poner un aparato en modo
  // visible después de entrar en la sección no aparecía nunca — había que pulsar
  // refrescar a mano, que es exactamente el síntoma reportado. Ahora el discovery
  // se arranca al entrar en la vista (o al encender el BT dentro de ella) y solo
  // se corta donde ya se cortaba: al salir de la sección o al cerrar el panel
  // (`stopScan`, que sigue siendo el único que apaga la radio de búsqueda).
  //
  // Queda un solo temporizador, el de `buffering`: los 2 s iniciales en los que la
  // lista no se recompone mientras BlueZ vuelca de golpe su caché.
  let scanStartTimer: number | null = null
  // Reintento del vigilante de abajo; no acota nada, solo espacia los reintentos.
  let scanRetryTimer: number | null = null
  let discoveringId: { adapter: any, id: number } | null = null
  // Con tres caídas seguidas se deja de insistir: si BlueZ no sostiene el
  // discovery (adaptador que desaparece, rfkill a medias), reintentar cada 2 s
  // sería un bucle invisible. El botón de refrescar rearma la cuenta.
  const MAX_REINTENTOS_DISCOVERY = 3
  let reintentosDiscovery = 0

  const clearScanRetry = () => {
    if (scanRetryTimer !== null) { clearTimeout(scanRetryTimer); scanRetryTimer = null }
  }

  const desvigilarDiscovery = () => {
    if (!discoveringId) return
    try { discoveringId.adapter.disconnect(discoveringId.id) } catch {}
    discoveringId = null
  }

  // BlueZ puede dar de baja el discovery por su cuenta (el adaptador se reinicia,
  // otro cliente D-Bus llama a StopDiscovery, un bloqueo de rfkill). Eso no emite
  // ningún error para nosotros: `scanning` se quedaría en `true` con la radio
  // parada, o sea el bug de antes disfrazado de icono encendido. Se vigila
  // `notify::discovering` del adaptador y se rearranca mientras la vista siga
  // abierta. El handler se cuelga del adaptador CONCRETO y se suelta al cambiarlo,
  // porque el objeto muere y renace con cada reenumeración del dongle.
  const vigilarDiscovery = (adapter: any) => {
    if (discoveringId?.adapter === adapter) return
    desvigilarDiscovery()
    try {
      const id = adapter.connect("notify::discovering", () => {
        if (adapter.discovering || !scanning.get()) return
        // Caída ajena: la vista sigue abierta y nosotros creíamos estar escaneando.
        setScanning(false)
        setBuffering(false)
        if (!inBtView() || !bt.isPowered) return
        if (reintentosDiscovery >= MAX_REINTENTOS_DISCOVERY) return
        reintentosDiscovery++
        clearScanRetry()
        scanRetryTimer = setTimeout(() => { scanRetryTimer = null; scan() }, 2000)
      })
      discoveringId = { adapter, id }
    } catch {}
  }

  const stopScan = () => {
    if (scanStartTimer !== null) { clearTimeout(scanStartTimer); scanStartTimer = null }
    clearScanRetry()
    reintentosDiscovery = 0
    if (scanning.get()) {
      // Las banderas se bajan ANTES de parar: `notify::discovering` llega después
      // del viaje por D-Bus y el vigilante de arriba lo leería como caída ajena.
      setBuffering(false)
      setScanning(false)
      try { bt.adapter?.stop_discovery() } catch {}
    }
    desvigilarDiscovery()
  }

  const scan = () => {
    if (scanning.get() || !btSupported.get() || !bt.isPowered) return
    const adapter = bt.adapter
    if (!adapter) return

    try {
      adapter.start_discovery()
      setScanning(true)
      setBuffering(true)
    } catch (error) {
      console.warn(`No se pudo iniciar el escaneo Bluetooth: ${bluetoothPowerError(error)}`)
      setScanning(false)
      setBuffering(false)
      return
    }
    vigilarDiscovery(adapter)

    if (scanStartTimer !== null) clearTimeout(scanStartTimer)
    scanStartTimer = setTimeout(() => {
      scanStartTimer = null
      setBuffering(false)
      update()
    }, 2000)
  }

  // El botón de refrescar ya no "enciende" el escaneo (ahora está siempre en
  // marcha dentro de la vista): reinicia el ciclo de inquiry y rearma la cuenta de
  // reintentos, que es lo único que puede hacer un usuario cuando la lista se ha
  // quedado a medias.
  const rescan = () => {
    reintentosDiscovery = 0
    stopScan()
    scan()
  }

  // A diferencia de NetworkManager (que reescanea solo al encender la radio WiFi),
  // BlueZ NO inicia discovery al encender el adaptador: hay que llamar a
  // start_discovery() explícitamente. Por eso, además de escanear al ENTRAR en la
  // vista con el BT ya encendido, hay que reintentar el escaneo cuando el usuario
  // enciende el BT estando ya dentro de la sección. El adaptador puede tardar unos
  // ms en estar disponible tras el power-on, así que reintentamos brevemente.
  let powerOnTimer: number | null = null
  const clearPowerOnTimer = () => {
    if (powerOnTimer !== null) { clearTimeout(powerOnTimer); powerOnTimer = null }
  }
  const autoScan = () => {
    if (!btSupported.get() || !bt.isPowered || scanning.get()) return
    if (bt.adapter) { scan(); return }
    // Adaptador aún no listo tras el power-on: reintenta una vez cuando aparezca.
    clearPowerOnTimer()
    powerOnTimer = setTimeout(() => {
      powerOnTimer = null
      if (inBtView() && bt.isPowered && bt.adapter && !scanning.get()) scan()
    }, 600)
  }

  // Al cerrar el panel: cortar el discovery y todos sus timers (antes la radio
  // seguía escaneando en background hasta agotar el `duration`).
  // Al abrir, resembrar `btSupported` por lo mismo que el tile: es una foto y el adaptador puede
  // haber ido y venido con el panel cerrado.
  quickSettingsVisible.subscribe(() => {
    if (quickSettingsVisible.get()) setBtSupported(!!bt.adapter)
    else { stopScan(); clearPowerOnTimer() }
  })

  // Solo refrescamos la lista mientras la vista Bluetooth está visible. Con el QS
  // cerrado o en otra pestaña ignoramos las señales: antes cada notify::devices
  // reconstruía la lista aunque nadie la mirara (mismo patrón que el menú WiFi).
  const inBtView = () => qsView.get() === "bluetooth"
  const syncAdapter = () => {
    const supported = !!bt.adapter
    setBtSupported(supported)
    if (!supported) {
      stopScan()
      clearPowerOnTimer()
      setDevices([])
    } else if (inBtView()) {
      update()
      autoScan()
    }
  }
  // Al encender el BT dentro de la sección: refresco inmediato + escaneo activo.
  bt.connect("notify::is-powered", () => { if (inBtView()) { update(); autoScan() } })
  bt.connect("notify::devices", () => { if (inBtView()) update() })
  bt.connect("notify::adapter", syncAdapter)
  bt.connect("adapter-added", syncAdapter)
  bt.connect("adapter-removed", syncAdapter)
  bt.connect("device-added", () => { if (inBtView()) update() })
  bt.connect("device-removed", () => { if (inBtView()) update() })

  const isMac = (str: string) => /^([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})$/i.test(str)
  const hasRealName = (dev: any) => {
    if (dev.alias && !isMac(dev.alias)) return true;
    if (dev.name && !isMac(dev.name)) return true;
    return false;
  }

  const getDeviceIcon = (dev: any) => {
    const name = (dev.name || dev.alias || "").toLowerCase()
    if (name.includes("head") || name.includes("auric") || dev.icon_name?.includes("head")) return "󰋋"
    if (name.includes("speak") || name.includes("altav") || dev.icon_name?.includes("speak")) return "󰓃"
    if (name.includes("phone") || name.includes("móvil") || dev.icon_name?.includes("phone")) return "󰏲"
    if (name.includes("mouse") || name.includes("ratón") || dev.icon_name?.includes("mouse")) return "󰍽"
    if (name.includes("keyboard") || name.includes("teclado") || dev.icon_name?.includes("keyboard")) return "󰌌"
    return "󰂯"
  }

  const pairedBinding = createComputed(() => {
    const arr = devices() || []
    const query = search().trim().toLowerCase()
    return arr.filter(d => (d.paired || d.connected) && matchesSearch(d, query)).sort((a, b) => {
      if (a.connected !== b.connected) return a.connected ? -1 : 1;
      const nameA = (a.alias || a.name || a.address || "").toLowerCase();
      const nameB = (b.alias || b.name || b.address || "").toLowerCase();
      return nameA.localeCompare(nameB);
    })
  })

  const availableBinding = createComputed(() => {
    const arr = devices() || []
    const query = search().trim().toLowerCase()
    return arr.filter(d => !d.paired && !d.connected && hasRealName(d) && matchesSearch(d, query)).sort((a, b) => {
      const nameA = (a.alias || a.name || "").toLowerCase();
      const nameB = (b.alias || b.name || "").toLowerCase();
      return nameA.localeCompare(nameB);
    })
  })

  const unnamedBinding = createComputed(() => {
    const arr = devices() || []
    const query = search().trim().toLowerCase()
    return arr.filter(d => !d.paired && !d.connected && !hasRealName(d) && matchesSearch(d, query)).sort((a, b) => {
      const nameA = (a.address || "").toLowerCase();
      const nameB = (b.address || "").toLowerCase();
      return nameA.localeCompare(nameB);
    })
  })

  const renderDevice = (dev: any) => {
    const connectedBinding = createBinding(dev, "connected");
    const aliasBinding = createBinding(dev, "alias");
    
    return (
      <button
        cssClasses={connectedBinding((c) => {
          const classes = ["qs-wifi-item"];
          if (c) classes.push("active");
          else if (dev.paired) classes.push("known");
          return classes;
        })}
        onClicked={() => {
          if (dev.connected) {
            execAsync(["bluetoothctl", "disconnect", dev.address]).catch(() => {})
          } else {
            execAsync(["bluetoothctl", "connect", dev.address]).catch(() => {})
          }
        }}
      >
        <box spacing={8}>
          <QsRowLabel
            icon={<label cssClasses={["qs-wifi-icon"]} label={aliasBinding(() => getDeviceIcon(dev))} />}
            title={aliasBinding((a) => {
              if (a && !isMac(a)) return a;
              if (dev.name && !isMac(dev.name)) return dev.name;
              return dev.address || "Desconocido";
            })}
            subtitle={
              <label
                label={connectedBinding((c) => c ? "Conectado" : dev.paired ? "Vinculado" : "Disponible")}
                halign={Gtk.Align.START}
                cssClasses={["qs-wifi-sec"]}
              />
            }
          />
          <label
            label="󰄬"
            cssClasses={["qs-wifi-lock"]}
            halign={Gtk.Align.END}
            visible={connectedBinding}
          />
        </box>
      </button>
    )
  }

  // Al entrar en la vista Bluetooth: refresco inmediato desde la caché + escaneo
  // activo (mismo patrón que WiFi). autoScan() respeta el guard de `scanning` y no
  // hace nada si el BT está apagado. Al salir, stopScan() corta el discovery.
  qsView.subscribe(() => {
    if (qsView.get() !== "bluetooth") { stopScan(); clearPowerOnTimer(); return }
    update()
    autoScan()
  })

  const searchEntry = new Gtk.Entry()
  searchEntry.set_css_classes(["qs-wifi-search-entry"])
  searchEntry.set_placeholder_text("Buscar dispositivos")
  searchEntry.set_hexpand(true)
  searchEntry.set_text(search())
  searchEntry.connect("changed", () => setSearch(searchEntry.text))

  return (
    <box cssClasses={["qs-bluetooth-menu"]} orientation={Gtk.Orientation.VERTICAL} spacing={8}>
      <Gtk.EventControllerKey
        onKeyPressed={(self, keyval, _keycode, state) => btSupported.get()
          ? handleSearchSectionKey(self, searchEntry, keyval, state)
          : false}
      />
      <QsMenuHeader title="Bluetooth" onBack={onBack} titleHexpand={false}>
        <box cssClasses={["qs-wifi-search"]} spacing={0} hexpand valign={Gtk.Align.CENTER} visible={btSupported}>
          {searchEntry}
        </box>
        <button
          cssClasses={["qs-icon-btn"]}
          visible={btSupported}
          onClicked={() => execAsync("blueman-manager").catch(() => {})}
        ><label label="󰒓" /></button>
        <button
          cssClasses={scanning((s) => s ? ["qs-icon-btn", "scanning"] : ["qs-icon-btn"])}
          visible={btSupported}
          sensitive={createComputed(() => btSupported() && btPowered())}
          onClicked={() => rescan()}
        ><label label="󰑐" /></button>
        <Interruptor
          activo={btPowered}
          clasesAdicionales={["qs-header-toggle"]}
          visible={btSupported}
          alAlternar={() => { void toggleBluetoothPower(bt) }}
        />
      </QsMenuHeader>

      <Gtk.ScrolledWindow
        cssClasses={["qs-wifi-list-scroll"]}
        visible={btSupported}
        hscrollbarPolicy={Gtk.PolicyType.NEVER}
        vscrollbarPolicy={Gtk.PolicyType.AUTOMATIC}
        vexpand
      >
        <box orientation={Gtk.Orientation.VERTICAL} spacing={8}>
          <box orientation={Gtk.Orientation.VERTICAL} spacing={2} visible={pairedBinding((arr) => arr.length > 0)}>
            <label cssClasses={["qs-dropdown-header"]} label="VINCULADOS" halign={Gtk.Align.START} />
            <For each={pairedBinding}>
              {renderDevice}
            </For>
          </box>

          <box orientation={Gtk.Orientation.VERTICAL} spacing={2} visible={availableBinding((arr) => arr.length > 0)}>
            <label cssClasses={["qs-dropdown-header"]} label="DISPONIBLES" halign={Gtk.Align.START} />
            <For each={availableBinding}>
              {renderDevice}
            </For>
          </box>

          <box orientation={Gtk.Orientation.VERTICAL} spacing={2} visible={unnamedBinding((arr) => arr.length > 0)}>
            <button
              cssClasses={["qs-dropdown-header"]}
              onClicked={() => setShowUnnamed(!showUnnamed.get())}
            >
              <box spacing={6}>
                <label label="OTROS DISPOSITIVOS (MAC)" cssClasses={["qs-bt-unnamed-label"]} />
                <label label={showUnnamed((s) => s ? "󰅀" : "󰅂")} cssClasses={["qs-bt-unnamed-chevron"]} />
              </box>
            </button>
            <revealer revealChild={showUnnamed} transitionType={Gtk.RevealerTransitionType.SLIDE_DOWN} transitionDuration={200}>
              <box orientation={Gtk.Orientation.VERTICAL} spacing={2}>
                <For each={unnamedBinding}>
                  {renderDevice}
                </For>
              </box>
            </revealer>
          </box>

          <label
            label={search((q) => q.trim() ? "Sin resultados" : "No se encontraron dispositivos")}
            cssClasses={["qs-bt-empty-label"]}
            visible={createComputed(() =>
              pairedBinding().length === 0 && availableBinding().length === 0 && unnamedBinding().length === 0
            )}
          />
        </box>
      </Gtk.ScrolledWindow>

      <box
        cssClasses={["qs-bt-unsupported"]}
        orientation={Gtk.Orientation.VERTICAL}
        spacing={8}
        visible={btSupported((supported) => !supported)}
        valign={Gtk.Align.CENTER}
        vexpand
      >
        <label cssClasses={["qs-bt-unsupported-icon"]} label="󰂲" />
        <label cssClasses={["qs-bt-unsupported-title"]} label="Bluetooth no compatible" />
        <label
          cssClasses={["qs-bt-unsupported-description"]}
          label="Este equipo no tiene ningún adaptador Bluetooth disponible."
          justify={Gtk.Justification.CENTER}
          wrap
        />
      </box>
    </box>
  )
}

// ── WiFi Menu ─────────────────────────────────────────────────────────────────

function QsWifiMenu({ onBack }: { onBack: () => void }) {
  const network = AstalNetwork.get_default()
  const wifi = network.wifi
  const [scanning, setScanning] = createState(false)

  if (!wifi) {
    const getWiredInfo = () => {
      const wired = network.wired
      const active = !!wired && wired.state === AstalNetwork.DeviceState.ACTIVATED
      return {
        active,
        name: active
          ? network.client.get_primary_connection()?.get_id() || "Ethernet"
          : "Red",
      }
    }
    const [wiredInfo, setWiredInfo] = createState(getWiredInfo())
    const syncWiredInfo = () => setWiredInfo(getWiredInfo())

    if (network.wired) {
      network.wired.connect("notify::state", syncWiredInfo)
    }
    network.connect("notify::wired", syncWiredInfo)
    network.client.connect("notify::primary-connection", syncWiredInfo)
    network.client.get_primary_connection()?.connect("notify::id", syncWiredInfo)
    qsView.subscribe(() => {
      if (qsView.get() === "wifi") syncWiredInfo()
    })

    return (
      <box cssClasses={["qs-wifi-menu"]} orientation={Gtk.Orientation.VERTICAL} spacing={8}>
        <QsMenuHeader title="Ethernet" onBack={onBack}>
          <button
            cssClasses={["qs-icon-btn"]}
            onClicked={() => execAsync("nm-connection-editor")}
          ><label label="󰒓" /></button>
        </QsMenuHeader>
        <label
          label={wiredInfo((info) => info.active
            ? `Conexión Ethernet activa · ${info.name}`
            : "No se encontró ningún dispositivo Wi-Fi")}
          halign={Gtk.Align.CENTER}
        />
      </box>
    )
  }

  const [apsVar, setApsVar] = createState<any[]>(wifi.get_access_points())
  const [passwordTarget, setPasswordTarget] = createState<string | null>(null)
  const [passwordStr, setPasswordStr] = createState("")
  const [passwordError, setPasswordError] = createState(false)
  const [wifiState, setWifiState] = createState({ ssid: wifi.ssid || "", connecting: null as string | null })
  const [savedSsids, setSavedSsids] = createState<string[]>([])
  const [search, setSearch] = createState("")

  const getBand = (freq: number) => {
    if (freq >= 5900) return "6GHz"
    if (freq >= 4900) return "5GHz"
    if (freq > 0) return "2.4GHz"
    return "—"
  }

  const updateSaved = () => {
    execAsync(["bash", "-c", "nmcli -t -f NAME,TYPE connection show | grep 802-11-wireless | cut -d: -f1"])
      .then((out) => setSavedSsids(out.split("\n").filter(Boolean)))
      .catch(() => { })
  }
  savedSsids.subscribe(() => setWifiState({ ...wifiState() }))

  // Solo procesamos señales de red mientras la vista WiFi está visible. Con QS
  // cerrado (qsView vuelve a "main") o en otra pestaña las ignoramos: antes cada
  // notify::connectivity lanzaba un pipeline nmcli|grep|cut aunque nadie mirara,
  // y una conexión dispara varias transiciones seguidas.
  const inWifiView = () => qsView.get() === "wifi"

  wifi.connect("notify::access-points", () => { if (inWifiView()) setApsVar(wifi.get_access_points()) })
  wifi.connect("notify::active-access-point", () => {
    if (!inWifiView()) return
    setApsVar(wifi.get_access_points())
    setWifiState({ ...wifiState(), ssid: wifi.ssid || "" })
  })
  wifi.connect("notify::ssid", () => {
    if (!inWifiView()) return
    setWifiState({ ...wifiState(), ssid: wifi.ssid || "" })
  })
  network.connect("notify::connectivity", () => {
    if (!inWifiView()) return
    setWifiState({ ...wifiState() })
    updateSaved()
  })

  // NM rechaza rescans muy seguidos (~10s). El escaneo automático al abrir la vista
  // respeta ese margen; el botón manual fuerza el intento.
  let lastScan = 0
  const rescan = (force = false) => {
    if (scanning.get()) return
    if (!wifi.enabled) return   // radio apagada: escanear es imposible y nmcli falla
    const now = Date.now()
    if (!force && now - lastScan < 10000) {
      setApsVar(wifi.get_access_points())
      updateSaved()
      return
    }
    lastScan = now
    setScanning(true)
    execAsync(["nmcli", "device", "wifi", "rescan"]).finally(() => {
      setTimeout(() => setScanning(false), 2000)
      updateSaved()
      setApsVar(wifi.get_access_points())
    })
  }

  // Al entrar en la vista WiFi: refresco inmediato desde la caché de NM + lista de
  // guardadas + escaneo activo (throttled). Reemplaza el rescan que hacía onWifiClick
  // y el `nmcli device wifi list` de arranque por monitor; ahora todo es perezoso.
  qsView.subscribe(() => {
    if (qsView.get() !== "wifi") {
      // Al salir de la vista se descarta el intento de contraseña a medias: el
      // menú no se desmonta (solo se oculta con `visible`), así que sin esto el
      // formulario seguía ahí al volver a entrar.
      setPasswordTarget(null)
      setPasswordStr("")
      setPasswordError(false)
      return
    }
    setApsVar(wifi.get_access_points())
    setWifiState({ ...wifiState(), ssid: wifi.ssid || "" })
    updateSaved()
    // Con la radio apagada no tiene sentido escanear ni sondear conectividad:
    // ambos nmcli fallarían/serían inútiles. La lista de guardadas (updateSaved)
    // sí se muestra para poder reconectar al reactivar el WiFi.
    if (wifi.enabled) {
      rescan()
      // Fuerza a NM a re-evaluar la conectividad ahora (en vez de esperar su chequeo
      // periódico de ~5 min). Así, si el usuario acaba de iniciar sesión en el portal,
      // el estado portal→full se limpia al instante tanto aquí como en el glifo del bar.
      execAsync(["nmcli", "networking", "connectivity", "check"]).catch(() => { })
    }
  })

  const wifiEnabled = createBinding(wifi, "enabled")
  const searchEntry = new Gtk.Entry()
  searchEntry.set_css_classes(["qs-wifi-search-entry"])
  searchEntry.set_placeholder_text("Buscar redes")
  searchEntry.set_hexpand(true)
  searchEntry.set_text(search())
  searchEntry.connect("changed", () => setSearch(searchEntry.text))

  // El formulario de contraseña vive FIJO entre la cabecera y la lista, NO dentro
  // del <For>. Metido en la lista, cada refresco de APs (el rescan manual, pero
  // sobre todo los notify::access-points que NM emite solo al fluctuar la señal)
  // reconstruía el Gtk.Entry: al re-pedir el foco por código GTK selecciona todo
  // el texto (gtk-entry-select-on-focus), y el reordenado de la lista además lo
  // desplazaba de sitio. Fijo y construido una sola vez —solo se rehace si cambia
  // `passwordTarget`, nunca al teclear— el campo queda quieto y sin reselección.
  const connectWithPassword = () => {
    const ssid = passwordTarget()
    if (!ssid) return
    const pass = passwordStr()
    if (!pass) return
    setWifiState({ ...wifiState(), connecting: ssid })
    setPasswordTarget(null)
    setPasswordError(false)
    execAsync(["bash", "-c", `timeout 20 nmcli device wifi connect "${ssid}" password "${pass}"`])
      .then(() => {
        setPasswordStr("")
        setWifiState({ ...wifiState(), connecting: null })
        updateSaved()
      })
      .catch(e => {
        console.error("WiFi Connect Error:", e)
        setWifiState({ ...wifiState(), connecting: null })
        setPasswordStr("")
        setPasswordError(true)
        setPasswordTarget(ssid)   // contraseña incorrecta: volver a pedirla
      })
  }

  const cerrarPassword = () => {
    setPasswordTarget(null)
    setPasswordStr("")
    setPasswordError(false)
  }

  const formularioPassword = (target: string) => (
    <box orientation={Gtk.Orientation.VERTICAL} cssClasses={["qs-wifi-item", "password-prompt"]} spacing={6}>
      <label
        label={passwordError((err) => err
          ? `Contraseña incorrecta · ${target}`
          : `Contraseña para ${target}`)}
        halign={Gtk.Align.START}
        cssClasses={passwordError((err) => err
          ? ["qs-wifi-password-label", "error"]
          : ["qs-wifi-password-label"])}
      />
      <box spacing={6}>
        <Gtk.Entry
          $={(self: Gtk.Entry) => {
            // grab_focus() en el `$` es prematuro: el widget todavía no está
            // insertado, así que no toma el foco. Se pide en un idle, ya montado.
            // set_position(-1) deshace la selección total que GTK hace al enfocar
            // por código, dejando el cursor al final.
            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
              if (self.get_root()) {
                self.grab_focus()
                self.set_position(-1)
              }
              return GLib.SOURCE_REMOVE
            })
          }}
          placeholderText="Escribe y presiona Enter"
          visibility={false}
          hexpand
          text={passwordStr()}
          onChanged={(self) => setPasswordStr(self.text)}
          onActivate={connectWithPassword}
        />
        <button cssClasses={["qs-icon-btn"]} onClicked={connectWithPassword}>
          <label label="󰄬" />
        </button>
        <button cssClasses={["qs-icon-btn"]} onClicked={cerrarPassword}>
          <label label="󰅖" />
        </button>
      </box>
    </box>
  )

  return (
    <box cssClasses={["qs-wifi-menu"]} orientation={Gtk.Orientation.VERTICAL} spacing={8}>
      <Gtk.EventControllerKey
        onKeyPressed={(self, keyval, _keycode, state) => {
          // Con el formulario de contraseña abierto, las pulsaciones van a ese
          // campo, no al buscador de redes (si no, escribir la contraseña
          // filtraba la lista y el foco saltaba al buscador).
          if (passwordTarget()) return false
          return handleSearchSectionKey(self, searchEntry, keyval, state)
        }}
      />
      <QsMenuHeader title="Wi-Fi" onBack={onBack} titleHexpand={false}>
        <box cssClasses={["qs-wifi-search"]} spacing={0} hexpand valign={Gtk.Align.CENTER}>
          {searchEntry}
        </box>
        <button
          cssClasses={["qs-icon-btn"]}
          onClicked={() => execAsync("nm-connection-editor")}
        ><label label="󰒓" /></button>
        <button
          cssClasses={scanning((s) => s ? ["qs-icon-btn", "scanning"] : ["qs-icon-btn"])}
          onClicked={() => rescan(true)}
        ><label label="󰑐" /></button>
        <Interruptor
          activo={wifiEnabled}
          alAlternar={() => execAsync(["bash", "-c", wifi.enabled ? "nmcli radio wifi off" : "nmcli radio wifi on"])}
        />
      </QsMenuHeader>

      {/* La <box> NO es decorativa: un <With> cuyo valor cambia DESPUÉS de construirse
          añade su hijo con `append`, o sea AL FINAL del contenedor. Colgado a pelo de
          `qs-wifi-menu`, el formulario acababa debajo de la lista en vez de aquí.
          Dentro de su propia caja es el único hijo y el final es su sitio. El caso
          cerrado devuelve `<box />` y no `false` (ver la sección de `<With>` en
          CLAUDE.md: sin hijo, el scope anterior no se dispone). */}
      <box orientation={Gtk.Orientation.VERTICAL} visible={passwordTarget((t) => !!t)}>
        <With value={passwordTarget}>
          {(target: string | null) => target ? formularioPassword(target) : <box />}
        </With>
      </box>

      <Gtk.ScrolledWindow
        cssClasses={["qs-wifi-list-scroll"]}
        hscrollbarPolicy={Gtk.PolicyType.NEVER}
        vscrollbarPolicy={Gtk.PolicyType.AUTOMATIC}
        vexpand
      >
        <box orientation={Gtk.Orientation.VERTICAL} spacing={2}>
          <Gtk.GestureClick onPressed={() => setInfoSsid(null)} />
          <For each={() => {
            const seen = new Set()
            const query = search().trim().toLowerCase()
            const unique = apsVar()
              .filter(ap => ap.ssid)
              .filter(ap => !query || ap.ssid.toLowerCase().includes(query))
              .sort((a, b) => {
                const connected = wifiState.get().ssid
                if (a.ssid === connected) return -1
                if (b.ssid === connected) return 1
                return b.strength - a.strength
              })
              .filter(ap => {
                if (seen.has(ap.ssid)) return false
                seen.add(ap.ssid)
                return true
              })
            return unique
          }}>
            {(ap: any) => {
              const isSecure = ap.flags > 0 || ap.wpaFlags > 0 || ap.rsnFlags > 0

              let secType = "Abierta · Portal Cautivo"
              if (ap.rsnFlags > 0 && ap.wpaFlags > 0) secType = "WPA/WPA2"
              else if (ap.rsnFlags > 0) secType = "WPA2"
              else if (ap.wpaFlags > 0) secType = "WPA"
              else if (ap.flags > 0) secType = "WEP"

              return (
                <box orientation={Gtk.Orientation.VERTICAL} spacing={0}>
                  <button
                    cssClasses={wifiState((s) => {
                    const active = s.ssid === ap.ssid
                    const isPortal = active && network.connectivity === AstalNetwork.Connectivity.PORTAL
                    const isKnown = !active && savedSsids.get().includes(ap.ssid) && isSecure
                    return ["qs-wifi-item", active ? "active" : "", isPortal ? "portal" : "", isKnown ? "known" : ""].filter(Boolean)
                  })}
                  onClicked={() => {
                    if (wifiState().ssid === ap.ssid) {
                      if (network.connectivity === AstalNetwork.Connectivity.PORTAL) {
                        execAsync("xdg-open http://nmcheck.gnome.org/check_network_status.txt")
                      }
                      return
                    }
                    setWifiState({ ...wifiState(), connecting: ap.ssid })
                    // Intentar reactivar conexion guardada primero, si falla, intentar crear nueva conexion (max 10s wait)
                    execAsync(["bash", "-c", `timeout 5 nmcli connection up "${ap.ssid}" || timeout 10 nmcli device wifi connect "${ap.ssid}"`])
                      .then(() => setWifiState({ ...wifiState(), connecting: null }))
                      .catch(e => {
                        console.error("WiFi Connect Error:", e)
                        setWifiState({ ...wifiState(), connecting: null })
                        if (isSecure) {
                          setPasswordStr("")
                          setPasswordError(false)
                          setPasswordTarget(ap.ssid)
                        }
                      })
                  }}
                >
                  <Gtk.GestureClick
                    button={Gdk.BUTTON_SECONDARY}
                    onPressed={() => setInfoSsid(infoSsid() === ap.ssid ? null : ap.ssid)}
                  />
                  <box spacing={8}>
                    <QsRowLabel
                      icon={
                        <box cssClasses={["qs-wifi-icon", "qs-wifi-signal"]} spacing={1} valign={Gtk.Align.CENTER}>
                          <For each={() => wifiSignalBarClasses(ap.strength ?? 0)}>
                            {(classes) => <box cssClasses={classes} valign={Gtk.Align.END} />}
                          </For>
                        </box>
                      }
                      title={ap.ssid}
                      subtitle={
                        <label label={netSpeed((ns) => {
                          const s = wifiState.get()
                          if (s.connecting === ap.ssid) return "Conectando..."
                          if (s.ssid === ap.ssid) {
                            if (network.connectivity === AstalNetwork.Connectivity.PORTAL) {
                              return "󰀦 Autenticación necesaria"
                            }
                            return `󰇚${ns.down} 󰕒${ns.up}`
                          }
                          return secType
                        })} halign={Gtk.Align.START} cssClasses={["qs-wifi-sec"]} />
                      }
                    />
                    <label
                      halign={Gtk.Align.END}
                      label={wifiState((s) => {
                        const active = s.ssid === ap.ssid
                        if (active && network.connectivity === AstalNetwork.Connectivity.PORTAL) return "󰅍"
                        if (isSecure && !active) return "󰌾"
                        return ""
                      })}
                      cssClasses={wifiState((s) => {
                        const active = s.ssid === ap.ssid
                        if (active && network.connectivity === AstalNetwork.Connectivity.PORTAL) return ["qs-wifi-portal-icon"]
                        if (isSecure && !active) return ["qs-wifi-lock"]
                        return []
                      })}
                      visible={wifiState((s) => {
                        const active = s.ssid === ap.ssid
                        return (active && network.connectivity === AstalNetwork.Connectivity.PORTAL) || (isSecure && !active)
                      })}
                    />
                  </box>
                </button>
                <revealer
                  revealChild={infoSsid((s) => s === ap.ssid)}
                  transitionType={Gtk.RevealerTransitionType.SLIDE_DOWN}
                  transitionDuration={200}
                >
                  <box cssClasses={["qs-wifi-info-section"]} orientation={Gtk.Orientation.VERTICAL} spacing={4}>
                    <box spacing={8}>
                      <label cssClasses={["qs-wifi-info-label"]} label="Banda:" />
                      <label cssClasses={["qs-wifi-info-value"]} label={getBand(ap.frequency)} />
                      <label cssClasses={["qs-wifi-info-sep"]} label="•" />
                      <label cssClasses={["qs-wifi-info-label"]} label="Frecuencia:" />
                      <label cssClasses={["qs-wifi-info-value"]} label={`${ap.frequency} MHz`} />
                    </box>
                    <box spacing={8}>
                      <label cssClasses={["qs-wifi-info-label"]} label="Señal:" />
                      <label cssClasses={["qs-wifi-info-value"]} label={`${ap.strength}%`} />
                      <label cssClasses={["qs-wifi-info-sep"]} label="•" />
                      <label cssClasses={["qs-wifi-info-label"]} label="Seguridad:" />
                      <label cssClasses={["qs-wifi-info-value"]} label={secType} />
                    </box>
                  </box>
                </revealer>
              </box>
            )
            }}
          </For>
        </box>
      </Gtk.ScrolledWindow>
    </box>
  )
}

// ── Main Window ───────────────────────────────────────────────────────────────

export default function QuickSettings(gdkmonitor: Gdk.Monitor) {
  const { TOP, RIGHT } = Astal.WindowAnchor
  const PANEL_TOTAL_WIDTH = 350
  const PANEL_PANEL_WIDTH = 330
  const PANEL_TOP = 37
  // Techo de seguridad del arranque de la entrada. El reloj de frames sólo corre mientras
  // la superficie está mapeada, así que si no llegara ningún tick con allocación la
  // entrada debe arrancar igual: quedarse en `qs-preparing` es quedarse en opacity 0, o
  // sea un panel abierto e invisible. Fail-open, como en NotificationPanel y Orion.
  const PANEL_PREPARE_CAP_MS = 120
  const PANEL_ENTER_MS = 280
  // La salida vertical necesita cruzar el borde con suficiente antelación para
  // que el último muestreo visible no sea una franja del pie. Se calcula sobre
  // la altura real porque las vistas internas de QS no miden todas lo mismo.
  const PANEL_EXIT_CLEARANCE_RATIO = 0.2
  // Tiempo mínimo en el reloj de fotogramas antes de desmapear. La salida CSS
  // dura 220 ms; después se exige además un frame final ya fuera de pantalla.
  const PANEL_EXIT_MS = 280

  let qsPanelRef: any = null
  let qsAnimationRef: any = null
  let qsWindowRef: any = null
  const [qsRendered, setQsRendered] = createState(quickSettingsVisible.get())
  // Pedir foco ON_DEMAND al mapear el layer-surface hace que Hyprland deje el
  // puntero asociado a la superficie nueva hasta el siguiente motion. Si el
  // ratón sigue sobre el botón del bar, el clic para cerrar se pierde. El panel
  // empieza sin foco y solo lo solicita cuando el puntero entra de verdad en él;
  // así los Entry y Escape siguen funcionando al interactuar con su contenido.
  const [qsKeyboardActive, setQsKeyboardActive] = createState(false)
  const [qsExitCss, setQsExitCss] = createState(".qs-wrapper {}")
  let enterTickId: number | null = null
  let enterCapTimer: number | null = null
  let entrancePending = false
  let entranceGuardTimer: number | null = null
  let exitTickId: number | null = null
  let hoverCloseTimer: number | null = null
  let entranceActive = false
  // Recorte de la región de entrada; se asigna tras construir la ventana. Debe re-ejecutarse al
  // terminar la animación de entrada (el transform de deslizamiento falsea la medida mientras corre).
  let reclipInput: ((inmediato?: boolean) => void) | null = null

  function cancelExitWait(): void {
    if (exitTickId === null || !qsAnimationRef) return
    qsAnimationRef.remove_tick_callback(exitTickId)
    exitTickId = null
  }

  function finishExit(): void {
    setQsRendered(false)
    exitTickId = null
    // Reiniciar el contenido solo después de que `visible=false` se haya
    // aplicado; hacerlo antes podía redimensionar el panel aún visible.
    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      if (!quickSettingsVisible.get() && !qsRendered.get()) {
        setQsView("main")
        setInfoSsid(null)
      }
      return GLib.SOURCE_REMOVE
    })
  }

  function cancelHoverClose(): void {
    if (hoverCloseTimer === null) return
    GLib.source_remove(hoverCloseTimer)
    hoverCloseTimer = null
  }

  function pointerIsOverQuickSettings(): boolean {
    try {
      const surface = qsWindowRef?.get_surface()
      const pointer = qsWindowRef?.get_display()?.get_default_seat()?.get_pointer()
      if (!surface || !pointer) return false
      const [inside] = surface.get_device_position(pointer)
      return inside
    } catch (_) {
      return false
    }
  }

  function handlePointerEnter(): void {
    cancelHoverClose()
    setQsKeyboardActive(true)
  }

  function handlePointerLeave(): void {
    cancelHoverClose()
    if (entranceActive || !quickSettingsVisible.get()) return
    hoverCloseTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
      hoverCloseTimer = null
      if (quickSettingsVisible.get() && !pointerIsOverQuickSettings()) closeAllPanels()
      return GLib.SOURCE_REMOVE
    })
  }

  /** Suelta el tick y el techo de la preparación, ganen o pierdan. */
  function cancelPrepare(): void {
    if (enterTickId !== null) {
      qsAnimationRef?.remove_tick_callback(enterTickId)
      enterTickId = null
    }
    if (enterCapTimer !== null) {
      GLib.source_remove(enterCapTimer)
      enterCapTimer = null
    }
  }

  /** Arranca el deslizamiento visible. Idempotente: la gana el tick o el techo, no ambos. */
  function startEntrance(): void {
    if (!entrancePending) return
    entrancePending = false
    cancelPrepare()
    // Región completa mientras dura la entrada; la silueta real la fija el reclip
    // del guard de abajo. Medir aquí NO vale: `qs-preparing` ya trae su propio
    // `translateY(-220px)` (no solo la clase de la animación), y GTK4 pliega el
    // transform de CSS en la asignación, así que `compute_bounds()` devolvía el
    // panel 220 px más arriba — la región caía fuera de la superficie por arriba y
    // los 220 px inferiores del panel se quedaban sordos al ratón hasta el reclip.
    reclipInput?.(true)
    qsAnimationRef?.remove_css_class("qs-preparing")
    qsAnimationRef?.add_css_class("qs-entering")
    entranceGuardTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PANEL_ENTER_MS, () => {
      entranceActive = false
      entranceGuardTimer = null
      // El transform ya está en identidad: re-medir la región de entrada, que
      // se había calculado desplazada mientras el panel se deslizaba.
      reclipInput?.()
      return GLib.SOURCE_REMOVE
    })
  }

  function beginEntrance(): void {
    entrancePending = false
    cancelPrepare()
    if (entranceGuardTimer !== null) { GLib.source_remove(entranceGuardTimer); entranceGuardTimer = null }
    entranceActive = true
    // Quitar la animación de salida dinámica mientras la ventana aún está oculta.
    setQsExitCss(".qs-wrapper {}")
    qsAnimationRef?.remove_css_class("qs-entering")
    qsAnimationRef?.add_css_class("qs-preparing")
    setQsRendered(true)
    entrancePending = true

    // La animación arranca cuando GTK dice que ya ha medido y pintado, NO a un plazo fijo
    // (eran 32 ms apostados a ciegas). Aquí el tirón no se notaba —el panel es pequeño y
    // su árbol cabe de sobra en dos fotogramas—, pero el plazo fijo sigue siendo una
    // apuesta: basta un arranque con la caché fría, un monitor a 60 Hz o un frame perdido
    // para que la entrada empiece con el layout a medias. Mismo remedio que en
    // NotificationPanel y Orion; el reloj de frames ya sabe cuándo ha terminado.
    let framesSeen = 0
    enterTickId = qsAnimationRef?.add_tick_callback((widget: any) => {
      if (!entrancePending) return false
      // El tick corre en la fase de ACTUALIZACIÓN, antes de pintar, y los primeros pueden
      // llegar sin allocación. Se espera a tener altura real (ya medido) y a un frame más:
      // ese es el primero con el panel preparado ya pintado.
      if ((widget.get_height?.() ?? 0) <= 0) return true
      if (++framesSeen < 2) return true
      enterTickId = null   // ya nos vamos: que cancelPrepare no lo quite dos veces
      startEntrance()
      return false
    }) ?? null

    enterCapTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PANEL_PREPARE_CAP_MS, () => {
      enterCapTimer = null
      startEntrance()
      return GLib.SOURCE_REMOVE
    })
  }

  // Mantener la ventana mapeada durante la salida permite completar el recorrido
  // hacia arriba antes de ocultarla realmente.
  quickSettingsVisible.subscribe(() => {
    cancelHoverClose()
    if (quickSettingsVisible.get()) {
      setQsKeyboardActive(false)
      cancelExitWait()
      beginEntrance()
      return
    }

    setQsKeyboardActive(false)
    entrancePending = false
    cancelPrepare()
    if (entranceGuardTimer !== null) {
      GLib.source_remove(entranceGuardTimer)
      entranceGuardTimer = null
    }
    entranceActive = false
    qsAnimationRef?.remove_css_class("qs-preparing")
    qsAnimationRef?.remove_css_class("qs-entering")
    // Medir la superficie completa (no solo el wrapper) y añadir holgura hace
    // que el borde inferior cruce el límite varios frames antes del final.
    const surfaceHeight = qsWindowRef?.get_surface?.()?.get_height?.() ?? 0
    const windowHeight = qsWindowRef?.get_height?.() ?? 0
    const wrapperHeight = qsAnimationRef?.get_height?.() ?? 0
    const exitBaseHeight = Math.max(1, Math.ceil(Math.max(
      surfaceHeight,
      windowHeight,
      wrapperHeight,
    )))
    const exitDistance = Math.ceil(exitBaseHeight * (1 + PANEL_EXIT_CLEARANCE_RATIO))
    setQsExitCss(`
      @keyframes qs-panel-slide-out-dynamic {
        from { transform: translateY(0); }
        to { transform: translateY(-${exitDistance}px); }
      }
      .qs-wrapper {
        animation: qs-panel-slide-out-dynamic 220ms cubic-bezier(0.4, 0, 1, 1) forwards;
      }
    `)
    cancelExitWait()
    let firstFrameUs: number | null = null
    let finalFramePresented = false
    exitTickId = qsAnimationRef.add_tick_callback((_widget: any, frameClock: any) => {
      const nowUs = frameClock.get_frame_time()
      if (firstFrameUs === null) firstFrameUs = nowUs
      const elapsedMs = (nowUs - firstFrameUs) / 1000
      if (elapsedMs < PANEL_EXIT_MS) return true

      // Este tick dibujará el estado final. Esperar al siguiente garantiza que
      // ese frame llegó al compositor antes de ocultar la superficie.
      if (!finalFramePresented) {
        finalFramePresented = true
        return true
      }

      finishExit()
      return false
    })
  })

  const result = <window
    name="quick-settings"
    namespace="quick-settings"
    visible={qsRendered}
    gdkmonitor={gdkmonitor}
    layer={Astal.Layer.TOP}
    exclusivity={Astal.Exclusivity.NORMAL}
    keymode={qsKeyboardActive((active) =>
      active ? Astal.Keymode.ON_DEMAND : Astal.Keymode.NONE)}
    anchor={TOP | RIGHT}
    application={app}
    widthRequest={PANEL_TOTAL_WIDTH}
    // La zona exclusiva de la barra mide 38px. Igual que PANEL_TOP=37 cuando
    // flota, solapamos 1px al quedar fija para evitar una costura transparente.
    marginTop={barTopMargin(PANEL_TOP, -1)}
    marginRight={0}
    decorated={false}
    cssClasses={clasesFondoShell("qs-window")}
    $={(self: any) => { qsWindowRef = self }}
  >
      <Gtk.EventControllerKey
        onKeyPressed={(_self, keyval) => {
          if (keyval === Gdk.KEY_Escape) {
            if (qsView.get() !== "main") {
              setQsView("main")
            } else {
              closeAllPanels()
            }
            return true
          }
          return false
        }}
      />
      <box
        cssClasses={["qs-wrapper"]}
        css={qsExitCss}
        orientation={Gtk.Orientation.HORIZONTAL}
        spacing={0}
        $={(self: any) => {
          qsAnimationRef = self
          if (quickSettingsVisible.get()) beginEntrance()
        }}
      >
      <box cssClasses={["qs-bar-connector"]} valign={Gtk.Align.START} />
      <box
        cssClasses={["qs-panel"]}
        orientation={Gtk.Orientation.VERTICAL}
        spacing={3}
        overflow={Gtk.Overflow.HIDDEN}
        widthRequest={PANEL_PANEL_WIDTH}
        $={(self: any) => {
          qsPanelRef = self
        }}
      >
        <Gtk.EventControllerMotion
          onEnter={handlePointerEnter}
          onLeave={handlePointerLeave}
        />
        <box orientation={Gtk.Orientation.VERTICAL} spacing={3} visible={qsView((v) => v === "main")}>
          <QsHeader />
          <QsTiles
            onWifiClick={() => setQsView("wifi")}
            onBluetoothClick={() => setQsView("bluetooth")}
            onDisplayClick={() => setQsView("display")}
            onAudioClick={() => setQsView("audio")}
            onMicClick={() => setQsView("mic")}
            onCamaraClick={() => setQsView("camara")}
          />
          <QsMedia />
          <QsFooter />
        </box>

        <box orientation={Gtk.Orientation.VERTICAL} visible={qsView((v) => v === "wifi")}>
          <QsWifiMenu onBack={() => setQsView("main")} />
        </box>

        <box
          orientation={Gtk.Orientation.VERTICAL}
          visible={qsView((v) => v === "display")}
          widthRequest={PANEL_PANEL_WIDTH - 10}
          hexpand
        >
          <QsDisplayMenu onBack={() => setQsView("main")} />
        </box>

        <box orientation={Gtk.Orientation.VERTICAL} visible={qsView((v) => v === "bluetooth")}>
          <QsBluetoothMenu onBack={() => setQsView("main")} />
        </box>

        <box orientation={Gtk.Orientation.VERTICAL} visible={qsView((v) => v === "audio")}>
          <QsAudioMenu onBack={() => setQsView("main")} />
        </box>

        <box orientation={Gtk.Orientation.VERTICAL} visible={qsView((v) => v === "mic")}>
          <QsMicMenu onBack={() => setQsView("main")} />
        </box>

        {/* Cámara. Se construye siempre (como el resto de submenús) pero no lee
            nada hasta que la vista está delante: los procesos de `v4l2-ctl` solo
            se lanzan con el panel abierto y en esta vista. */}
        <box
          orientation={Gtk.Orientation.VERTICAL}
          visible={qsView((v) => v === "camara")}
          widthRequest={PANEL_PANEL_WIDTH - 10}
          hexpand
        >
          <QsCamaraMenu onBack={() => setQsView("main")} />
        </box>
      </box>
      </box>
    </window>

  reclipInput = clipWindowInputToContent(result, qsPanelRef, {
    superficieCompletaMientras: () => entranceActive,
    // El panel cambia de alto sin que nadie avise al recorte: el formulario de
    // contraseña Wi-Fi, las fichas de info de cada red, los desplegables… Sin
    // esto la franja nueva de abajo se quedaba sin entrada y, al pasar el ratón
    // por ella, el panel se daba por abandonado y se cerraba.
    seguirAsignacion: true,
  })
  return result
}
