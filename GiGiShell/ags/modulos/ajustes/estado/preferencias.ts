// modulos/ajustes/estado/preferencias.ts
//
// Hub de preferencias persistentes de las secciones propias del shell. A diferencia de
// modulos/barra/funciones/estado.ts (que vive SOLO en RAM), estas preferencias se
// persisten en config/preferences.json para sobrevivir a reinicios.
//
// Para añadir una preferencia nueva:
//   1. crea su createState (default = valor de fábrica),
//   2. léela en load(),
//   3. inclúyela en el objeto de save(),
//   4. expón un setter público que mute el estado y llame a save().

import GLib from "gi://GLib"
import Gio from "gi://Gio"
import { createComputed, createState } from "ags"
import { execAsync } from "ags/process"
import { normalizarModoDaltonismo, type ModoDaltonismo } from "../accesibilidad/daltonismo"
import {
  ACCION_BOTON_PREDETERMINADA,
  normalizarAccionBotonEncendido,
  type AccionBotonEncendido,
} from "../../../servicios/energia/botonEncendido"
import {
  ACCION_TAPA_PREDETERMINADA,
  normalizarAccionTapa,
  type AccionTapa,
} from "../../../servicios/energia/tapaPortatil"
import {
  normalizarAccionesOcultas,
} from "../../menu-energia/acciones"
import {
  FONDO_SHELL_PREDETERMINADO,
  normalizarFondoShell,
  type FondoShell,
} from "../personalizacion/fondoShell"

const PREFS_PATH = `${GLib.get_user_config_dir()}/gigios/preferences.json`

// ── Estado reactivo ───────────────────────────────────────────────────────────
// Preview de workspace: captura con grim al cambiar de workspace + popover al
// hacer clic derecho sobre el número. Default: activada (comportamiento actual).
const [wsPreviewEnabled, _setWsPreviewEnabled] = createState(true)
export { wsPreviewEnabled }

// Reproductor de Spotify en el centro de la barra. Al desactivarlo el componente
// se desmonta por completo, por lo que no mantiene polling, timers ni carátulas.
// Default: activado para conservar el comportamiento existente.
const [spotifyBarEnabled, _setSpotifyBarEnabled] = createState(true)
export { spotifyBarEnabled }

// Batería de la barra. Si se desactiva, el widget no se monta y por tanto no
// inicializa AstalBattery ni sus señales. Si se deja activa, Bateria.tsx oculta
// el indicador automáticamente cuando el equipo no expone una batería.
// Default: activada para conservar el comportamiento existente.
const [batteryBarEnabled, _setBatteryBarEnabled] = createState(true)
export { batteryBarEnabled }

// Red de la barra. Al desactivarla, Red.tsx no se monta ni se conecta a las
// señales de AstalNetwork. Si está activa, el propio widget se oculta cuando no
// hay ningún enlace Wi-Fi o Ethernet activo.
const [networkBarEnabled, _setNetworkBarEnabled] = createState(true)
export { networkBarEnabled }

// Indicador puntual de uso del micrófono en la barra. Al desactivarlo, el
// componente no se monta ni escucha cambios de capturas en AstalWp.
const [micIndicatorEnabled, _setMicIndicatorEnabled] = createState(true)
export { micIndicatorEnabled }

// Capturas que NO cuentan como uso del micrófono para ese indicador. **Es una
// escotilla, no el mecanismo**: lo que graba el monitor de un altavoz o la
// salida de otra app se detecta solo (`servicios/multimedia/origenCapturas.ts`
// se lo pregunta a `pactl`), así que en el caso normal esta lista se queda
// vacía. Solo se apunta aquí lo que la detección no cace.
// La clave es el `node.name` del stream (lo que AstalWp publica como
// `description`: "discord_capture", "WEBRTC VoiceEngine"…), no el nombre de la
// app: Discord abre dos streams distintos y solo uno es el micro. Se guarda tal
// cual, sin normalizar a minúsculas — un `node.name` es una identidad exacta,
// igual que en `audioDispositivosOcultos`.
const [microfonoAppsIgnoradas, _setMicrofonoAppsIgnoradas] = createState<string[]>([])
export { microfonoAppsIgnoradas }

// Indicador de captura de pantalla en la barra (compartir por portal + grabadores
// locales). El toggle es MAESTRO y se aplica en caliente: su setter lanza o mata
// hypr/scripts/screencast-monitor.sh, así que apagado no queda ni proceso ni icono.
const [screencastIndicatorEnabled, _setScreencastIndicatorEnabled] = createState(true)
export { screencastIndicatorEnabled }

// OSD flotantes activados por los atajos multimedia. Se controlan por separado
// para poder conservar solo los indicadores que resulten útiles.
const [volumeOsdEnabled, _setVolumeOsdEnabled] = createState(true)
const [micOsdEnabled, _setMicOsdEnabled] = createState(true)
const [brightnessOsdEnabled, _setBrightnessOsdEnabled] = createState(true)
export { volumeOsdEnabled, micOsdEnabled, brightnessOsdEnabled }

// Estado de mute que aplicará inicializador/init.sh al comenzar la sesión.
// Se guardan aquí porque son elecciones del shell, aunque las consume
// un script externo antes de que AGS termine de arrancar.
const [startupVolumeMuted, _setStartupVolumeMuted] = createState(false)
const [startupMicMuted, _setStartupMicMuted] = createState(false)
// El bluetooth funciona igual que los dos de audio: activado apaga la radio,
// desactivado la enciende. Con esto init.sh deja de reponer el `bluetooth` de
// system_state.json, que pasa a ser solo el respaldo de la primera sesión.
const [startupBluetoothOff, _setStartupBluetoothOff] = createState(false)
export { startupVolumeMuted, startupMicMuted, startupBluetoothOff }

// Dispositivos de audio que el usuario ha apartado con el clic derecho en el
// menú de Quick Settings ("spk:<node.name>" / "mic:<node.name>", ver
// `servicios/multimedia/endpointsAudio.ts`). No se normalizan a minúsculas como
// las clases de app: un `node.name` distingue mayúsculas y es una identidad
// exacta, no un texto que el usuario teclee. Lo que el hardware da por MUERTO se
// oculta al margen de esta lista.
const [audioDispositivosOcultos, _setAudioDispositivosOcultos] = createState<string[]>([])
export { audioDispositivosOcultos }

// Apps en segundo plano (BandejaSistema) de la barra. Desactivada, no se monta el
// contenedor ni se renderizan sus iconos, bindings, menús o popovers.
const [trayBarEnabled, _setTrayBarEnabled] = createState(true)
export { trayBarEnabled }

// Botón de notificaciones de la barra. Solo controla BotonNotificaciones; el
// panel, el historial y los controles de Quick Settings siguen disponibles.
const [notificationBarEnabled, _setNotificationBarEnabled] = createState(true)
export { notificationBarEnabled }

// Selector de workspaces de la barra. Solo controla su representación en el
// bar; no cambia la configuración ni los atajos de Hyprland.
const [workspacesBarEnabled, _setWorkspacesBarEnabled] = createState(true)
export { workspacesBarEnabled }

// Mascota lagarto: cuando está activo se pasea por debajo de la barra
// mientras el escritorio activo no tenga clientes o no haya ninguno enfocado
// (ver modulos/mascotas/estado/disparador.ts). Puramente cosmético, así que
// nace DESACTIVADO — a diferencia del resto de indicadores de la barra, aquí
// no hay comportamiento previo que conservar.
const [lagartoBarraEnabled, _setLagartoBarraEnabled] = createState(false)
export { lagartoBarraEnabled }

// Títulos emergentes de las aplicaciones en el selector de workspaces. Al
// desactivarlos, pasar el ratón por un icono no crea el tooltip nativo de GTK.
// Valor predeterminado: activados para conservar el comportamiento existente.
const [titulosAppsWorkspaceActivos, _setTitulosAppsWorkspaceActivos] = createState(true)
export { titulosAppsWorkspaceActivos }

// Máximo de iconos de aplicaciones que muestra cada workspace en la barra.
// Cuatro conserva el comportamiento histórico; el tope evita que una sola
// pastilla pueda ocupar la barra completa en workspaces muy cargados.
export const WORKSPACE_APP_LIMIT_MIN = 1
export const WORKSPACE_APP_LIMIT_MAX = 8
const [workspaceAppLimit, _setWorkspaceAppLimit] = createState(4)
export { workspaceAppLimit }

const clampWorkspaceAppLimit = (value: number): number =>
  Math.max(WORKSPACE_APP_LIMIT_MIN, Math.min(WORKSPACE_APP_LIMIT_MAX, Math.round(value)))

// Máximo de botones de workspace visibles simultáneamente. El workspace enfocado
// siempre entra en la selección; el resto se elige por uso reciente.
export const WORKSPACE_VISIBLE_LIMIT_MIN = 1
export const WORKSPACE_VISIBLE_LIMIT_MAX = 9
const [workspaceVisibleLimit, _setWorkspaceVisibleLimit] = createState(9)
export { workspaceVisibleLimit }

const clampWorkspaceVisibleLimit = (value: number): number =>
  Math.max(WORKSPACE_VISIBLE_LIMIT_MIN, Math.min(WORKSPACE_VISIBLE_LIMIT_MAX, Math.round(value)))

// Auto-ocultado de la barra. Activado (default) = comportamiento actual: la barra
// se retrae y vuelve al pasar el ratón por la hotzone superior. Desactivado, la
// barra queda fija y además pasa a exclusivity EXCLUSIVE (Barra.tsx), de modo que
// Hyprland le reserva su altura y no tapa las ventanas. Se aplica en caliente.
const [barAutoHideEnabled, _setBarAutoHideEnabled] = createState(true)
export { barAutoHideEnabled }

// Aviso de batería baja EN LA BARRA: con la ocultación automática puesta, la barra
// baja y deja de retraerse mientras la batería esté por debajo del umbral y NO se esté
// cargando. Es un aviso pasivo —no roba el foco ni tapa nada, porque la barra sigue en
// exclusivity NORMAL (ver Barra.tsx)— para el caso en que la única señal de carga baja
// vive justo en lo que está escondido. Default: DESACTIVADO, porque cambia solo el
// comportamiento de la barra y eso tiene que pedirse.
const [barraAvisoBateria, _setBarraAvisoBateria] = createState(false)
export { barraAvisoBateria }

// De dónde sale el porcentaje del aviso. Activado (default) reutiliza el umbral del modo
// ahorro (`thresholdPct` de ~/.config/power-save/config.json), que es lo que la mayoría
// querrá: un solo número que gobierna "batería baja" en todo el escritorio. Se toma
// prestado el NÚMERO y nada más — el aviso nunca sigue a `powerSaveActive`, así que el
// ahorro forzado a mano (que también se enciende en un sobremesa sin batería) no baja la
// barra: la condición sigue siendo batería presente, descargando y por debajo del umbral.
const [barraAvisoBateriaUsaUmbralAhorro, _setBarraAvisoBateriaUsaUmbralAhorro] = createState(true)
export { barraAvisoBateriaUsaUmbralAhorro }

// Umbral propio del aviso, en uso solo con el anterior desactivado. El mínimo es 1 y no 0
// a propósito: 0 nunca se cumple (`pct > 0` descarta la lectura transitoria del proxy
// antes de tener el valor real) y sería un ajuste que parece encendido y no hace nada.
export const BARRA_AVISO_BATERIA_MIN = 1
export const BARRA_AVISO_BATERIA_MAX = 100
const [barraAvisoBateriaPct, _setBarraAvisoBateriaPct] = createState(20)
export { barraAvisoBateriaPct }

const clampAvisoBateriaPct = (valor: number): number =>
  Math.max(BARRA_AVISO_BATERIA_MIN, Math.min(BARRA_AVISO_BATERIA_MAX, Math.round(valor)))

// Fondo común de las superficies principales. Se representa mediante una clase
// reactiva en cada ventana para aplicarlo en caliente sin recompilar ni recargar AGS.
// Negro conserva el aspecto histórico; Grafito ofrece la alternativa más clara.
const [fondoShell, _setFondoShell] = createState<FondoShell>(FONDO_SHELL_PREDETERMINADO)
export { fondoShell }

export function clasesFondoShell(...clasesBase: string[]) {
  return fondoShell((fondo) => [...clasesBase, `fondo-shell-${fondo}`])
}

// Acento adaptativo: el color de acento del shell se saca del fondo de escritorio
// en vez de ser el azul fijo del tema. Se aplica en caliente y por una variable
// CSS, no por una clase (ver servicios/fondos/acento.ts): apagarlo devuelve el
// azul al instante sin recompilar ni recargar. Default: DESACTIVADO, porque
// cambia el aspecto de todo el shell y eso tiene que elegirlo el usuario.
const [acentoAdaptativoEnabled, _setAcentoAdaptativoEnabled] = createState(false)
export { acentoAdaptativoEnabled }

// Margen superior efectivo de una superficie anclada arriba (paneles, popups, OSD).
// Con auto-ocultado el bar vive en exclusivity NORMAL: no reserva nada, así que cada
// panel tiene que separarse él mismo los ~38px del bar. Sin auto-ocultado el bar es
// EXCLUSIVE y el compositor ya baja por debajo de él a toda superficie no exclusiva,
// de modo que ese margen propio se sumaría al hueco reservado y dejaría el doble de
// aire. Por eso ahí el margen pasa a 0 (o al mínimo que quiera el llamante).
export function barTopMargin(px: number, offPx = 0) {
  return createComputed(() => barAutoHideEnabled() ? px : offPx)
}

// Monitor de batería (scripts/battery-monitor.sh): el propio script bash lee
// este valor UNA sola vez al arrancar (no hay polling desde bash), así que un
// cambio aquí solo se aplica reiniciando el script/Hyprland. Default: activado.
const [batteryMonitorEnabled, _setBatteryMonitorEnabled] = createState(true)
export { batteryMonitorEnabled }

// Monitor de temperatura (scripts/temp-monitor.sh): igual que el de batería,
// el script bash lo lee UNA sola vez al arrancar (nada de polling), así que
// un cambio aquí solo surte efecto reiniciando el script/Hyprland. Default: activado.
const [tempMonitorEnabled, _setTempMonitorEnabled] = createState(true)
export { tempMonitorEnabled }

// Historial del portapapeles (wl-paste + cliphist). Al desactivarlo se detiene
// la captura de nuevas copias y se limpia lo ya guardado. Default: activado.
const [clipboardHistoryEnabled, _setClipboardHistoryEnabled] = createState(true)
export { clipboardHistoryEnabled }

// Limpieza del portapapeles al comenzar la sesión de Hyprland. La consume el
// script limpiar-portapapeles.sh desde gigios/autostart.lua. Default: desactivada.
const [limpiezaPortapapelesAlIniciar, _setLimpiezaPortapapelesAlIniciar] = createState(false)
export { limpiezaPortapapelesAlIniciar }

// Anclaje de ventanas al escritorio de lanzamiento (hypr/scripts/anclaje.py).
// La consumen los DOS lanzadores que usan ese motor: rofi-launch.py (SUPER+SPACE)
// y lanzar-anclado.py (por el que Orion abre sus apps, modulos/orion/data/launch.ts).
// Es una sola clave a propósito — para quien la usa es una única función, y
// partirla solo permitiría dejarla a medias; el nombre dice "Rofi" porque ya está
// escrito en el preferences.json de la máquina y renombrarlo apagaría el anclaje
// en silencio. Ninguno de los dos es un daemon: nacen de cero en cada lanzamiento,
// leen esta clave al arrancar y el cambio se aplica en el siguiente — sin pkill ni
// re-exec, al revés que los monitores.
// Default: activado.
const [anclarVentanasRofi, _setAnclarVentanasRofi] = createState(true)
export { anclarVentanasRofi }

// Escáner de apps al iniciar sesión (gigios/escaner-apps.lua). Vigila 30 s
// las ventanas que se abren solas (autostart, restauración de sesión) y al terminar
// salta al escritorio donde hayan quedado. El script NO es un daemon: nace en
// gigios/autostart.lua, mira y muere, así que lee esta clave una vez y el cambio se
// aplica en la próxima sesión — no hace falta pkill ni re-exec.
// Default: DESACTIVADO, porque mover el escritorio activo por su cuenta es
// intrusivo y debe optarse a ello.
const [escanerAppsInicio, _setEscanerAppsInicio] = createState(false)
export { escanerAppsInicio }

// La SEGUNDA ventana de un escritorio nace al lado y no debajo
// (hypr/gigios/reparto-ventanas.lua). Con una sola ventana en mosaico, el eje del
// corte lo decidía `dwindle:smart_split`, o sea el cuadrante donde tuvieras el
// ratón: con el puntero abajo el escritorio salía partido en dos franjas
// horizontales, distinto en cada arranque. Activado fuerza `preselect right`,
// pase lo que pase con el ratón; de la tercera ventana en adelante manda otra
// vez el puntero. Lo lee el config de Hyprland, no el shell, así que el setter
// tiene que recargar Hyprland (`util.prefs()` se lee una vez por ejecución).
// Default: activado.
const [segundaVentanaAlLado, _setSegundaVentanaAlLado] = createState(true)
export { segundaVentanaAlLado }

// Absorber SUPER + tecla que no sea un atajo (hypr/gigios/nop-binds.lua). Hyprland
// solo se traga una tecla si algún bind la captura, así que sin esto SUPER+C
// escribe una "c" en la aplicación; `catchall` no sirve porque el compositor
// solo lo admite dentro de un submap. Bajo config Lua los binds sordos se
// recalculan SOLOS en cada recarga: el módulo lee esta preferencia y enumera los
// atajos ya registrados, así que no hay fichero generado ni script de por medio.
// Default: activado.
const [absorberSuperSinAtajo, _setAbsorberSuperSinAtajo] = createState(true)
export { absorberSuperSinAtajo }

// Menú Orion. app.ts consulta este valor antes de importar el módulo: cuando
// está desactivado no se crea su ventana ni se cargan watchers/servicios de
// Orion. El cambio se aplica en el siguiente arranque o recarga de AGS.
const [orionEnabled, _setOrionEnabled] = createState(true)
export { orionEnabled }

// Página inicial de Orion. Desactivado conserva Inicio; activado abre directamente
// el catálogo de aplicaciones. Se aplica en caliente en la siguiente apertura.
const [orionAppsDefault, _setOrionAppsDefault] = createState(false)
export { orionAppsDefault }

// Conserva la última sección de Orion entre cierres dentro de la sesión actual.
// La sección recordada no se persiste: tras reiniciar AGS vuelve a mandar la
// página inicial configurada arriba. Default: desactivado.
const [orionRecordarUltimaSeccion, _setOrionRecordarUltimaSeccion] = createState(false)
export { orionRecordarUltimaSeccion }

// Monitor de actualizaciones (scripts/updates-monitor.sh) + icono de la barra.
// El toggle MAESTRO se aplica en caliente (su setter lanza/mata el script y el
// icono se monta/desmonta con este estado). Default: activado.
const [updatesMonitorEnabled, _setUpdatesMonitorEnabled] = createState(true)
export { updatesMonitorEnabled }

// Recomprobación periódica del monitor de actualizaciones. Lo lee el script bash
// UNA sola vez al arrancar (como batteryMonitor): al desactivarlo comprueba una
// vez y sale. Un cambio solo surte efecto reiniciando el script (reactivar el
// maestro lo relanza). Default: activado.
const [updatesPeriodicEnabled, _setUpdatesPeriodicEnabled] = createState(true)
export { updatesPeriodicEnabled }

// Horas entre comprobaciones periódicas. También leído UNA vez al arrancar por el
// script. Default: 3.
const [updatesIntervalHours, _setUpdatesIntervalHours] = createState(3)
export { updatesIntervalHours }

// Congelar tareas de fondo mientras juegas. Lo leen los scripts bash a través de
// hypr/scripts/lib/gaming-gate.sh, que retiene el sondeo PRESCINDIBLE (monitor de
// actualizaciones, SMART y unidades systemd) mientras haya un juego delante y lo
// reanuda al cerrarlo. Se lee EN VIVO (con caché de 30 s), no una sola vez al
// arrancar como los toggles de evento: es un control de recursos, así que apagarlo
// descongela sin reiniciar nada. NO afecta a los seguidores de eventos de seguridad
// ni al termómetro — ver la cabecera de gaming-gate.sh. Default: activado.
const [gamingFreezeEnabled, _setGamingFreezeEnabled] = createState(true)
export { gamingFreezeEnabled }

// Detección de juegos en marcha (servicios/juegos/registro.ts). Es lo que alimenta la
// pastilla de juegos de la barra, el auto-DND por juego, la onda de Spotify y el
// `gaming` de runtime-state.json. Al apagarlo el registro suelta las señales por
// ventana (`notify::title/class/fullscreen`) y deja de recoger evidencia de /proc y de
// los `.desktop`: quien no juega se ahorra ese trabajo por completo, y `gaming` pasa a
// ser `false` de forma permanente para todos los que leen el fichero (ver gamingState.ts
// y hypr/scripts/lib/gaming-gate.sh). Se aplica EN CALIENTE en los dos sentidos.
// Default: activado.
const [escanerJuegos, _setEscanerJuegos] = createState(true)
export { escanerJuegos }

// Pausar la luz nocturna mientras haya un juego abierto (servicios/pantalla/service.ts).
// Se mira que el juego EXISTA, no que tenga el foco: "no me la enciendas hasta que salga
// del juego" — irse al escritorio un momento a mitad de partida no debe teñir la pantalla
// de naranja y volver a quitarlo al hacer alt-tab. Depende del registro de juegos, así que
// con `escanerJuegos` apagado no hay nada que detectar y la pausa no se dispara nunca (su
// tarjeta se retira de Ajustes, igual que la de congelar tareas). Default: activado, como
// "congelar tareas al jugar": las dos son lo mismo —el equipo se aparta mientras juegas—.
const [pausaLuzNocturnaJuegos, _setPausaLuzNocturnaJuegos] = createState(true)
export { pausaLuzNocturnaJuegos }

// Clases de ventana que pausan la luz nocturna igual que un juego, para lo que el
// detector no reconoce (un emulador, un juego sin `.desktop`, un launcher propio) o
// simplemente no es un juego. Se guardan como subcadenas en minúsculas y se comparan
// contra class/initialClass — mismo formato y mismo comparador que
// `autoDndFullscreenApps` (`servicios/ventanas/coincidenciaClases.ts`), pero SIN exigir
// pantalla completa: aquí el contrato es "mientras la ventana esté abierta", el mismo que
// para los juegos. Cuelga del interruptor de arriba, pero NO del escáner de juegos: se
// compara clase contra clase, así que funciona con la detección apagada. Default: vacía.
const [pausaLuzNocturnaApps, _setPausaLuzNocturnaApps] = createState<string[]>([])
export { pausaLuzNocturnaApps }

// No molestar automático: cuando está activo, un watcher en el shell
// (modulos/notificaciones/autoDnd) enciende notifd.dontDisturb mientras haya un
// juego corriendo o una app de la lista de abajo en pantalla completa. Silencia
// SOLO los popups para el usuario; el procesamiento e historial siguen. Default: desactivado.
const [autoDndEnabled, _setAutoDndEnabled] = createState(false)
export { autoDndEnabled }

// Lista de clases de ventana que, al ponerse en pantalla completa, también
// disparan el No molestar automático (además de los juegos). Se guarda como
// substrings en minúsculas y se compara contra class/initialClass. Default: vacía.
const [autoDndFullscreenApps, _setAutoDndFullscreenApps] = createState<string[]>([])
export { autoDndFullscreenApps }

// Duración de los popups de notificación, en milisegundos. Tres familias, porque no
// necesitan el mismo tiempo en pantalla: una notificación corriente se lee de un vistazo,
// un aviso del sistema (reparar un USB, un análisis) informa del resultado de algo que se
// pidió, y uno con botones hay que poder accionarlo. Son SUELOS, no valores fijos: un
// emisor puede pedir más con su `expire_timeout` y una regla puede fijar el tiempo exacto
// (`popupMs`, Ajustes > Notificaciones > Reglas/Sistema), que gana a todo esto.
// Los defaults son los que tenía cableados popup/logica.ts.
const [popupDuracionNormalMs, _setPopupDuracionNormalMs] = createState(5500)
export { popupDuracionNormalMs }
const [popupDuracionSistemaMs, _setPopupDuracionSistemaMs] = createState(10000)
export { popupDuracionSistemaMs }
const [popupDuracionAccionesMs, _setPopupDuracionAccionesMs] = createState(20000)
export { popupDuracionAccionesMs }

// Formato del reloj de la barra: "24h" (por defecto, p. ej. 14:30) o "12h"
// (02:30 PM). Lo lee modulos/barra/indicadores/tiempo/Reloj.tsx de forma reactiva, así que el cambio
// se ve al instante sin reiniciar. Vive en "Región, fecha y hora".
export type TimeFormat = "24h" | "12h"
const [timeFormat, _setTimeFormat] = createState<TimeFormat>("24h")
export { timeFormat }

// Corrección global de color para daltonismo. Solo puede haber un shader de
// pantalla activo en Hyprland, de modo que el propio tipo representa también la
// exclusividad entre los tres modos. "ninguno" conserva la imagen original.
const [modoDaltonismo, _setModoDaltonismo] = createState<ModoDaltonismo>("ninguno")
export { modoDaltonismo }

// Acción del botón de encendido físico. Quien la ejecuta es
// hypr/gigios/boton-apagado.lua (bindl sobre XF86PowerOff), que relee esta clave
// en cada pulsación: no hay proceso al que relanzar, así que el setter solo
// persiste. El valor de fábrica es "apagar", que es lo que hacía logind antes.
const [botonApagado, _setBotonApagado] = createState<AccionBotonEncendido>(ACCION_BOTON_PREDETERMINADA)
export { botonApagado }

// Acción al cerrar la tapa del portátil. Mismo contrato que `botonApagado`: la
// ejecuta hypr/gigios/tapa.lua (bind sobre `switch:on:Lid Switch`) releyendo esta
// clave en cada cierre, así que el setter solo persiste. El valor de fábrica es
// "suspender", que es lo que hacía logind antes.
const [accionTapa, _setAccionTapa] = createState<AccionTapa>(ACCION_TAPA_PREDETERMINADA)
export { accionTapa }

// Excepción de "docked": no hacer nada al cerrar la tapa si hay una pantalla
// externa. De fábrica ENCENDIDA, y no es un capricho — es lo que hacía logind
// (HandleLidSwitchDocked=ignore) y que se perdía en silencio al quitarle la tapa.
const [tapaIgnorarConPantallaExterna, _setTapaIgnorarConPantallaExterna] = createState(true)
export { tapaIgnorarConPantallaExterna }

// Acciones retiradas del menú de energía (ids de modulos/menu-energia/acciones.ts).
// Se guardan las OCULTAS y no las visibles a propósito: así una acción nueva aparece
// sola en los perfiles que ya existen, en vez de quedarse invisible por no estar en
// una lista escrita antes de que existiera. La lista nunca puede vaciar el menú del
// todo (ver normalizarAccionesOcultas).
const [accionesEnergiaOcultas, _setAccionesEnergiaOcultas] = createState<string[]>([])
export { accionesEnergiaOcultas }

// Formatea una hora según la preferencia. En 12h calculamos AM/PM a mano en vez
// de usar %p: en locales como es_US.UTF-8 %p viene vacío y el reloj quedaría
// ambiguo ("09:09 " sin sufijo). Así el formato es independiente del idioma.
export function formatClock(dt: GLib.DateTime = GLib.DateTime.new_now_local(), fmt: TimeFormat = timeFormat.get()): string {
  if (fmt === "12h") {
    const period = dt.get_hour() < 12 ? "AM" : "PM"
    return `${dt.format("%I:%M") ?? ""} ${period}`
  }
  return dt.format("%H:%M") ?? ""
}

// Normaliza una lista de clases: minúsculas, sin espacios sobrantes, sin vacíos
// ni duplicados. Se aplica tanto al cargar como al añadir, así el watcher y la UI
// nunca ven basura.
function sanitizeApps(apps: unknown[]): string[] {
  const out: string[] = []
  for (const a of apps) {
    if (typeof a !== "string") continue
    const norm = a.trim().toLowerCase()
    if (norm.length > 0 && !out.includes(norm)) out.push(norm)
  }
  return out
}

// ── Carga inicial ─────────────────────────────────────────────────────────────
function load() {
  try {
    const [ok, content] = GLib.file_get_contents(PREFS_PATH)
    if (!ok) return
    const saved = JSON.parse(new TextDecoder().decode(content))
    if (typeof saved.workspacePreview === "boolean") _setWsPreviewEnabled(saved.workspacePreview)
    if (typeof saved.spotifyBar === "boolean") _setSpotifyBarEnabled(saved.spotifyBar)
    if (typeof saved.batteryBar === "boolean") _setBatteryBarEnabled(saved.batteryBar)
    if (typeof saved.networkBar === "boolean") _setNetworkBarEnabled(saved.networkBar)
    if (typeof saved.micIndicator === "boolean") _setMicIndicatorEnabled(saved.micIndicator)
    if (typeof saved.screencastIndicator === "boolean") _setScreencastIndicatorEnabled(saved.screencastIndicator)
    if (typeof saved.volumeOsd === "boolean") _setVolumeOsdEnabled(saved.volumeOsd)
    if (typeof saved.micOsd === "boolean") _setMicOsdEnabled(saved.micOsd)
    if (typeof saved.brightnessOsd === "boolean") _setBrightnessOsdEnabled(saved.brightnessOsd)
    if (typeof saved.startupVolumeMuted === "boolean") _setStartupVolumeMuted(saved.startupVolumeMuted)
    if (typeof saved.startupMicMuted === "boolean") _setStartupMicMuted(saved.startupMicMuted)
    if (typeof saved.startupBluetoothOff === "boolean") _setStartupBluetoothOff(saved.startupBluetoothOff)
    if (Array.isArray(saved.microfonoAppsIgnoradas)) {
      _setMicrofonoAppsIgnoradas(
        saved.microfonoAppsIgnoradas.filter((c: unknown): c is string => typeof c === "string" && c.length > 0),
      )
    }
    if (Array.isArray(saved.audioDispositivosOcultos)) {
      _setAudioDispositivosOcultos(
        saved.audioDispositivosOcultos.filter((c: unknown): c is string => typeof c === "string" && c.length > 0),
      )
    }
    if (typeof saved.trayBar === "boolean") _setTrayBarEnabled(saved.trayBar)
    if (typeof saved.notificationBar === "boolean") _setNotificationBarEnabled(saved.notificationBar)
    if (typeof saved.workspacesBar === "boolean") _setWorkspacesBarEnabled(saved.workspacesBar)
    if (typeof saved.lagartoBarra === "boolean") _setLagartoBarraEnabled(saved.lagartoBarra)
    if (typeof saved.titulosAppsWorkspace === "boolean") {
      _setTitulosAppsWorkspaceActivos(saved.titulosAppsWorkspace)
    }
    if (typeof saved.workspaceAppLimit === "number" && Number.isFinite(saved.workspaceAppLimit)) {
      _setWorkspaceAppLimit(clampWorkspaceAppLimit(saved.workspaceAppLimit))
    }
    if (typeof saved.workspaceVisibleLimit === "number" && Number.isFinite(saved.workspaceVisibleLimit)) {
      _setWorkspaceVisibleLimit(clampWorkspaceVisibleLimit(saved.workspaceVisibleLimit))
    }
    if (typeof saved.barAutoHide === "boolean") _setBarAutoHideEnabled(saved.barAutoHide)
    if (typeof saved.barraAvisoBateria === "boolean") _setBarraAvisoBateria(saved.barraAvisoBateria)
    if (typeof saved.barraAvisoBateriaUsaUmbralAhorro === "boolean") {
      _setBarraAvisoBateriaUsaUmbralAhorro(saved.barraAvisoBateriaUsaUmbralAhorro)
    }
    if (typeof saved.barraAvisoBateriaPct === "number" && Number.isFinite(saved.barraAvisoBateriaPct)) {
      _setBarraAvisoBateriaPct(clampAvisoBateriaPct(saved.barraAvisoBateriaPct))
    }
    _setFondoShell(normalizarFondoShell(saved.fondoShell))
    if (typeof saved.acentoAdaptativo === "boolean") {
      _setAcentoAdaptativoEnabled(saved.acentoAdaptativo)
    }
    if (typeof saved.batteryMonitor === "boolean") _setBatteryMonitorEnabled(saved.batteryMonitor)
    if (typeof saved.tempMonitor === "boolean") _setTempMonitorEnabled(saved.tempMonitor)
    if (typeof saved.clipboardHistory === "boolean") _setClipboardHistoryEnabled(saved.clipboardHistory)
    if (typeof saved.limpiezaPortapapelesAlIniciar === "boolean") {
      _setLimpiezaPortapapelesAlIniciar(saved.limpiezaPortapapelesAlIniciar)
    }
    if (typeof saved.anclarVentanasRofi === "boolean") {
      _setAnclarVentanasRofi(saved.anclarVentanasRofi)
    }
    if (typeof saved.escanerAppsInicio === "boolean") {
      _setEscanerAppsInicio(saved.escanerAppsInicio)
    }
    if (typeof saved.segundaVentanaAlLado === "boolean") {
      _setSegundaVentanaAlLado(saved.segundaVentanaAlLado)
    }
    if (typeof saved.absorberSuperSinAtajo === "boolean") {
      _setAbsorberSuperSinAtajo(saved.absorberSuperSinAtajo)
    }
    if (typeof saved.orion === "boolean") _setOrionEnabled(saved.orion)
    if (typeof saved.orionAppsDefault === "boolean") _setOrionAppsDefault(saved.orionAppsDefault)
    if (typeof saved.orionRecordarUltimaSeccion === "boolean") {
      _setOrionRecordarUltimaSeccion(saved.orionRecordarUltimaSeccion)
    }
    if (typeof saved.updatesMonitor === "boolean") _setUpdatesMonitorEnabled(saved.updatesMonitor)
    if (typeof saved.updatesPeriodic === "boolean") _setUpdatesPeriodicEnabled(saved.updatesPeriodic)
    if (typeof saved.updatesIntervalHours === "number" && saved.updatesIntervalHours >= 1) {
      _setUpdatesIntervalHours(Math.floor(saved.updatesIntervalHours))
    }
    if (typeof saved.gamingFreeze === "boolean") _setGamingFreezeEnabled(saved.gamingFreeze)
    if (typeof saved.escanerJuegos === "boolean") _setEscanerJuegos(saved.escanerJuegos)
    if (typeof saved.pausaLuzNocturnaJuegos === "boolean") {
      _setPausaLuzNocturnaJuegos(saved.pausaLuzNocturnaJuegos)
    }
    if (Array.isArray(saved.pausaLuzNocturnaApps)) {
      _setPausaLuzNocturnaApps(sanitizeApps(saved.pausaLuzNocturnaApps))
    }
    if (typeof saved.autoDnd === "boolean") _setAutoDndEnabled(saved.autoDnd)
    if (Array.isArray(saved.autoDndFullscreenApps)) {
      _setAutoDndFullscreenApps(sanitizeApps(saved.autoDndFullscreenApps))
    }
    // Duraciones de popup: se ignoran los valores fuera de [1 s, 60 s] igual que hace
    // popup/logica.ts al acotar, para que un preferences.json tocado a mano no deje popups
    // eternos ni invisibles.
    const duracionValida = (v: unknown): v is number =>
      typeof v === "number" && v >= 1000 && v <= 60000
    if (duracionValida(saved.popupDuracionNormalMs)) _setPopupDuracionNormalMs(saved.popupDuracionNormalMs)
    if (duracionValida(saved.popupDuracionSistemaMs)) _setPopupDuracionSistemaMs(saved.popupDuracionSistemaMs)
    if (duracionValida(saved.popupDuracionAccionesMs)) _setPopupDuracionAccionesMs(saved.popupDuracionAccionesMs)
    if (saved.timeFormat === "12h" || saved.timeFormat === "24h") _setTimeFormat(saved.timeFormat)
    _setModoDaltonismo(normalizarModoDaltonismo(saved.modoDaltonismo))
    // Sin guarda de `typeof`: normalizar ya devuelve el valor de fábrica ante
    // cualquier cosa que no sea una acción conocida (ausente incluida).
    _setBotonApagado(normalizarAccionBotonEncendido(saved.botonApagado))
    _setAccionTapa(normalizarAccionTapa(saved.accionTapa))
    if (typeof saved.tapaIgnorarConPantallaExterna === "boolean") {
      _setTapaIgnorarConPantallaExterna(saved.tapaIgnorarConPantallaExterna)
    }
    _setAccionesEnergiaOcultas(normalizarAccionesOcultas(saved.accionesEnergiaOcultas))
  } catch (e) { /* archivo ausente o corrupto → nos quedamos con los defaults */ }
}

// ── Persistencia ──────────────────────────────────────────────────────────────
function save() {
  try {
    const dir = GLib.path_get_dirname(PREFS_PATH)
    if (!GLib.file_test(dir, GLib.FileTest.EXISTS)) GLib.mkdir_with_parents(dir, 0o755)
    const config = {
      workspacePreview: wsPreviewEnabled.get(),
      spotifyBar: spotifyBarEnabled.get(),
      batteryBar: batteryBarEnabled.get(),
      networkBar: networkBarEnabled.get(),
      micIndicator: micIndicatorEnabled.get(),
      screencastIndicator: screencastIndicatorEnabled.get(),
      volumeOsd: volumeOsdEnabled.get(),
      micOsd: micOsdEnabled.get(),
      brightnessOsd: brightnessOsdEnabled.get(),
      startupVolumeMuted: startupVolumeMuted.get(),
      startupMicMuted: startupMicMuted.get(),
      startupBluetoothOff: startupBluetoothOff.get(),
      microfonoAppsIgnoradas: microfonoAppsIgnoradas.get(),
      audioDispositivosOcultos: audioDispositivosOcultos.get(),
      trayBar: trayBarEnabled.get(),
      notificationBar: notificationBarEnabled.get(),
      workspacesBar: workspacesBarEnabled.get(),
      titulosAppsWorkspace: titulosAppsWorkspaceActivos.get(),
      lagartoBarra: lagartoBarraEnabled.get(),
      workspaceAppLimit: workspaceAppLimit.get(),
      workspaceVisibleLimit: workspaceVisibleLimit.get(),
      barAutoHide: barAutoHideEnabled.get(),
      barraAvisoBateria: barraAvisoBateria.get(),
      barraAvisoBateriaUsaUmbralAhorro: barraAvisoBateriaUsaUmbralAhorro.get(),
      barraAvisoBateriaPct: barraAvisoBateriaPct.get(),
      fondoShell: fondoShell.get(),
      acentoAdaptativo: acentoAdaptativoEnabled.get(),
      batteryMonitor: batteryMonitorEnabled.get(),
      tempMonitor: tempMonitorEnabled.get(),
      clipboardHistory: clipboardHistoryEnabled.get(),
      limpiezaPortapapelesAlIniciar: limpiezaPortapapelesAlIniciar.get(),
      anclarVentanasRofi: anclarVentanasRofi.get(),
      escanerAppsInicio: escanerAppsInicio.get(),
      absorberSuperSinAtajo: absorberSuperSinAtajo.get(),
      segundaVentanaAlLado: segundaVentanaAlLado.get(),
      orion: orionEnabled.get(),
      orionAppsDefault: orionAppsDefault.get(),
      orionRecordarUltimaSeccion: orionRecordarUltimaSeccion.get(),
      updatesMonitor: updatesMonitorEnabled.get(),
      updatesPeriodic: updatesPeriodicEnabled.get(),
      updatesIntervalHours: updatesIntervalHours.get(),
      gamingFreeze: gamingFreezeEnabled.get(),
      escanerJuegos: escanerJuegos.get(),
      pausaLuzNocturnaJuegos: pausaLuzNocturnaJuegos.get(),
      pausaLuzNocturnaApps: pausaLuzNocturnaApps.get(),
      autoDnd: autoDndEnabled.get(),
      autoDndFullscreenApps: autoDndFullscreenApps.get(),
      popupDuracionNormalMs: popupDuracionNormalMs.get(),
      popupDuracionSistemaMs: popupDuracionSistemaMs.get(),
      popupDuracionAccionesMs: popupDuracionAccionesMs.get(),
      timeFormat: timeFormat.get(),
      modoDaltonismo: modoDaltonismo.get(),
      botonApagado: botonApagado.get(),
      accionTapa: accionTapa.get(),
      tapaIgnorarConPantallaExterna: tapaIgnorarConPantallaExterna.get(),
      accionesEnergiaOcultas: accionesEnergiaOcultas.get(),
    }
    GLib.file_set_contents(PREFS_PATH, JSON.stringify(config, null, 2))
  } catch (e) { /* no-op: un fallo de escritura no debe romper la UI */ }
}

// ── Setters públicos (mutan estado + persisten) ───────────────────────────────
export function setWsPreviewEnabled(on: boolean) {
  _setWsPreviewEnabled(on)
  save()
}
export function setSpotifyBarEnabled(on: boolean) {
  _setSpotifyBarEnabled(on)
  save()
}
export function setBatteryBarEnabled(on: boolean) {
  _setBatteryBarEnabled(on)
  save()
}
export function setNetworkBarEnabled(on: boolean) {
  _setNetworkBarEnabled(on)
  save()
}
export function setMicIndicatorEnabled(on: boolean) {
  _setMicIndicatorEnabled(on)
  save()
}
// Maestro del indicador de captura: se aplica en caliente. Al activar lanza el
// script; al desactivar lo mata y borra screencast.json para que el icono
// desaparezca al instante y no quede proceso sondeando.
export function setScreencastIndicatorEnabled(on: boolean) {
  _setScreencastIndicatorEnabled(on)
  save()
  if (on) {
    execAsync([`${GLib.get_user_config_dir()}/hypr/scripts/screencast-monitor.sh`]).catch(() => {})
  } else {
    execAsync(["pkill", "-f", "screencast-monitor.sh"]).catch(() => {})
    try { Gio.File.new_for_path(`${GLib.get_user_config_dir()}/gigios/screencast.json`).delete(null) } catch (_) {}
  }
}
export function setVolumeOsdEnabled(on: boolean) {
  _setVolumeOsdEnabled(on)
  save()
}
export function setMicOsdEnabled(on: boolean) {
  _setMicOsdEnabled(on)
  save()
}
export function setBrightnessOsdEnabled(on: boolean) {
  _setBrightnessOsdEnabled(on)
  save()
}
export function setStartupVolumeMuted(on: boolean) {
  _setStartupVolumeMuted(on)
  save()
}
export function setStartupMicMuted(on: boolean) {
  _setStartupMicMuted(on)
  save()
}
export function setStartupBluetoothOff(on: boolean) {
  _setStartupBluetoothOff(on)
  save()
}
/** Flip-flop: aparta la captura del indicador de micrófono o la devuelve a la
 * cuenta. Devuelve el estado nuevo (true = ahora está ignorada). */
export function alternarAppMicrofonoIgnorada(clave: string): boolean {
  const actuales = microfonoAppsIgnoradas.get()
  const estaba = actuales.includes(clave)
  _setMicrofonoAppsIgnoradas(estaba ? actuales.filter((c) => c !== clave) : [...actuales, clave])
  save()
  return !estaba
}
/** Flip-flop: aparta el dispositivo o lo devuelve a la lista. Devuelve el estado
 * nuevo por si el llamador quiere reaccionar. */
export function alternarDispositivoAudioOculto(clave: string): boolean {
  const actuales = audioDispositivosOcultos.get()
  const estaba = actuales.includes(clave)
  _setAudioDispositivosOcultos(estaba ? actuales.filter((c) => c !== clave) : [...actuales, clave])
  save()
  return !estaba
}
export function setTrayBarEnabled(on: boolean) {
  _setTrayBarEnabled(on)
  save()
}
export function setNotificationBarEnabled(on: boolean) {
  _setNotificationBarEnabled(on)
  save()
}
export function setWorkspacesBarEnabled(on: boolean) {
  _setWorkspacesBarEnabled(on)
  save()
}
export function setTitulosAppsWorkspaceActivos(activos: boolean) {
  _setTitulosAppsWorkspaceActivos(activos)
  save()
}
export function setLagartoBarraEnabled(on: boolean) {
  _setLagartoBarraEnabled(on)
  save()
}
export function setWorkspaceAppLimit(value: number) {
  if (!Number.isFinite(value)) return
  const limit = clampWorkspaceAppLimit(value)
  if (workspaceAppLimit.get() === limit) return
  _setWorkspaceAppLimit(limit)
  save()
}
export function setWorkspaceVisibleLimit(value: number) {
  if (!Number.isFinite(value)) return
  const limit = clampWorkspaceVisibleLimit(value)
  if (workspaceVisibleLimit.get() === limit) return
  _setWorkspaceVisibleLimit(limit)
  save()
}
export function setBarAutoHideEnabled(on: boolean) {
  _setBarAutoHideEnabled(on)
  save()
}
export function setBarraAvisoBateria(on: boolean) {
  if (barraAvisoBateria.get() === on) return
  _setBarraAvisoBateria(on)
  save()
}
export function setBarraAvisoBateriaUsaUmbralAhorro(on: boolean) {
  if (barraAvisoBateriaUsaUmbralAhorro.get() === on) return
  _setBarraAvisoBateriaUsaUmbralAhorro(on)
  save()
}
export function setBarraAvisoBateriaPct(valor: number) {
  if (!Number.isFinite(valor)) return
  const pct = clampAvisoBateriaPct(valor)
  if (barraAvisoBateriaPct.get() === pct) return
  _setBarraAvisoBateriaPct(pct)
  save()
}
export function setFondoShell(fondo: FondoShell) {
  const siguiente = normalizarFondoShell(fondo)
  if (fondoShell.get() === siguiente) return
  _setFondoShell(siguiente)
  save()
}
// Sin efecto secundario: quien escucha es `servicios/fondos/acento.ts`, suscrito a
// este estado. Que el setter no llame al extractor es lo que permite que encender
// el ajuste y cambiar de fondo pasen por el mismo camino y no puedan discrepar.
export function setAcentoAdaptativoEnabled(on: boolean) {
  if (acentoAdaptativoEnabled.get() === on) return
  _setAcentoAdaptativoEnabled(on)
  save()
}
export function setBatteryMonitorEnabled(on: boolean) {
  _setBatteryMonitorEnabled(on)
  save()
}
export function setTempMonitorEnabled(on: boolean) {
  _setTempMonitorEnabled(on)
  save()
}
export function setClipboardHistoryEnabled(on: boolean) {
  _setClipboardHistoryEnabled(on)
  save()
  const action = on ? "start" : "stop"
  execAsync([`${GLib.get_user_config_dir()}/hypr/scripts/clipboard-history.sh`, action]).catch(() => {})
}
export function setLimpiezaPortapapelesAlIniciar(activa: boolean) {
  _setLimpiezaPortapapelesAlIniciar(activa)
  save()
}
export function setAnclarVentanasRofi(on: boolean) {
  _setAnclarVentanasRofi(on)
  save()
}
// Sin setter maestro: el script solo corre al iniciar sesión, así que no hay
// proceso vivo al que relanzar ni matar. Basta con persistirlo.
export function setEscanerAppsInicio(on: boolean) {
  _setEscanerAppsInicio(on)
  save()
}
// Se aplica en CALIENTE: gigios/nop-binds.lua relee esta preferencia y recalcula
// los binds sordos en CADA recarga (enumerando los atajos ya registrados por los
// módulos anteriores), así que basta con persistir y recargar — ya no hay
// fichero generado ni script que regenerar, y los atajos nuevos de keybinds se
// recogen solos en la misma recarga.
export function setAbsorberSuperSinAtajo(on: boolean) {
  _setAbsorberSuperSinAtajo(on)
  save()   // síncrono: preferences.json ya está en disco cuando el reload lo relea
  execAsync(["hyprctl", "reload"]).catch(() => {})
}
// Mismo trato que setAbsorberSuperSinAtajo, y por el mismo motivo: quien lee
// esta preferencia es el config de Hyprland, que la cachea en `util.prefs()`
// durante toda la ejecución. Sin la recarga el interruptor se vería cambiado y
// no haría nada hasta el siguiente arranque.
export function setSegundaVentanaAlLado(on: boolean) {
  _setSegundaVentanaAlLado(on)
  save()   // síncrono: preferences.json ya está en disco cuando el reload lo relea
  execAsync(["hyprctl", "reload"]).catch(() => {})
}
export function setOrionEnabled(on: boolean) {
  _setOrionEnabled(on)
  save()
}
export function setOrionAppsDefault(on: boolean) {
  _setOrionAppsDefault(on)
  save()
}
export function setOrionRecordarUltimaSeccion(activo: boolean) {
  _setOrionRecordarUltimaSeccion(activo)
  save()
}
// Maestro del monitor de actualizaciones: se aplica en caliente. Al activar lanza
// el script (que relee prefs y arranca); al desactivar lo mata y borra updates.json
// para que el icono desaparezca al instante.
export function setUpdatesMonitorEnabled(on: boolean) {
  _setUpdatesMonitorEnabled(on)
  save()
  if (on) {
    execAsync([`${GLib.get_user_config_dir()}/hypr/scripts/updates-monitor.sh`]).catch(() => {})
  } else {
    execAsync(["pkill", "-f", "updates-monitor.sh"]).catch(() => {})
    try { Gio.File.new_for_path(`${GLib.get_user_config_dir()}/gigios/updates.json`).delete(null) } catch (_) {}
  }
}
export function setUpdatesPeriodicEnabled(on: boolean) {
  _setUpdatesPeriodicEnabled(on)
  save()
}
export function setUpdatesIntervalHours(h: number) {
  const n = Math.floor(h)
  if (!Number.isFinite(n) || n < 1) return
  _setUpdatesIntervalHours(n)
  save()
}
export function setTimeFormat(fmt: TimeFormat) {
  _setTimeFormat(fmt)
  save()
}
export function setModoDaltonismo(modo: ModoDaltonismo) {
  const siguiente = normalizarModoDaltonismo(modo)
  if (modoDaltonismo.get() === siguiente) return
  _setModoDaltonismo(siguiente)
  save()
  // GiGiShell.daltonismo la define gigios/daltonismo.lua en la config de Hyprland y
  // es visible desde eval (comparte el estado Lua del config). El propio config
  // la re-ejecuta en cada recarga para restaurar el modo guardado; pasárselo aquí
  // evita releer el JSON en el camino interactivo. Mismos nombres de modo.
  execAsync(["hyprctl", "eval", `GiGiShell.daltonismo("${siguiente}")`]).catch((error) => {
    console.error("[accesibilidad] No se pudo aplicar la corrección de color:", error)
  })
}
// Sin setter maestro y sin recarga de Hyprland: el bind es fijo (siempre llama al
// mismo script) y el script relee la preferencia en cada pulsación. Basta con
// persistirla; el cambio se aplica en la pulsación siguiente.
export function setBotonApagado(accion: AccionBotonEncendido) {
  const siguiente = normalizarAccionBotonEncendido(accion)
  if (botonApagado.get() === siguiente) return
  _setBotonApagado(siguiente)
  save()
}
// Igual que setBotonApagado: sin recarga de Hyprland, porque el bind es fijo y
// gigios/tapa.lua relee la preferencia en cada cierre de tapa.
export function setAccionTapa(accion: AccionTapa) {
  const siguiente = normalizarAccionTapa(accion)
  if (accionTapa.get() === siguiente) return
  _setAccionTapa(siguiente)
  save()
}
export function setTapaIgnorarConPantallaExterna(on: boolean) {
  if (tapaIgnorarConPantallaExterna.get() === on) return
  _setTapaIgnorarConPantallaExterna(on)
  save()
}
/** Muestra u oculta una acción del menú de energía. Si el cambio dejaría el menú
 *  vacío, `normalizarAccionesOcultas` lo impide y el estado no cambia: el interruptor
 *  de la última acción visible se pinta insensible, así que en la UI no llega a pasar. */
export function setAccionEnergiaOculta(id: string, oculta: boolean) {
  const actuales = accionesEnergiaOcultas.get()
  const siguiente = normalizarAccionesOcultas(
    oculta ? [...actuales, id] : actuales.filter((a) => a !== id),
  )
  if (siguiente.length === actuales.length && siguiente.every((a, i) => a === actuales[i])) return
  _setAccionesEnergiaOcultas(siguiente)
  save()
}
export function setAutoDndEnabled(on: boolean) {
  _setAutoDndEnabled(on)
  save()
}
// No hay setter "maestro" que relance nada: los scripts releen `gamingFreeze` del
// JSON en vivo, así que basta con persistirlo. Apagarlo descongela en <=30 s (el TTL
// de la caché del gate) sin reiniciar ningún monitor.
export function setGamingFreezeEnabled(on: boolean) {
  _setGamingFreezeEnabled(on)
  save()
}
// Tampoco necesita relanzar nada: el registro de juegos está suscrito a este estado y
// se conecta o se desconecta solo (servicios/juegos/registro.ts), y gamingState.ts
// reescribe runtime-state.json en el acto para que el lado bash lo vea sin esperar a
// que se abra o se cierre una ventana.
export function setEscanerJuegos(on: boolean) {
  if (escanerJuegos.get() === on) return
  _setEscanerJuegos(on)
  save()
}
// Tampoco relanza nada: `service.ts` está suscrito a este estado y reconcilia hyprsunset
// en el acto, así que encenderla con un juego ya abierto apaga la luz al momento y
// apagarla la devuelve sin esperar al tick de 60 s.
export function setPausaLuzNocturnaJuegos(on: boolean) {
  _setPausaLuzNocturnaJuegos(on)
  save()
}
/** Añade una clase a la lista que pausa la luz nocturna. Normaliza y evita duplicados. */
export function addPausaLuzNocturnaApp(cls: string) {
  _setPausaLuzNocturnaApps(sanitizeApps([...pausaLuzNocturnaApps.get(), cls]))
  save()
}
/** Quita una clase (comparación exacta contra el valor ya normalizado). */
export function removePausaLuzNocturnaApp(cls: string) {
  _setPausaLuzNocturnaApps(pausaLuzNocturnaApps.get().filter((a) => a !== cls))
  save()
}
/** Acota a [1 s, 60 s]: los mismos límites que aplica popup/logica.ts al pintar. */
function acotarDuracion(ms: number): number {
  return Math.min(Math.max(Math.round(ms), 1000), 60000)
}
export function setPopupDuracionNormalMs(ms: number) {
  _setPopupDuracionNormalMs(acotarDuracion(ms))
  save()
}
export function setPopupDuracionSistemaMs(ms: number) {
  _setPopupDuracionSistemaMs(acotarDuracion(ms))
  save()
}
export function setPopupDuracionAccionesMs(ms: number) {
  _setPopupDuracionAccionesMs(acotarDuracion(ms))
  save()
}
/** Añade una clase a la lista de apps fullscreen. Normaliza y evita duplicados. */
export function addAutoDndApp(cls: string) {
  const next = sanitizeApps([...autoDndFullscreenApps.get(), cls])
  _setAutoDndFullscreenApps(next)
  save()
}
/** Quita una clase (comparación exacta contra el valor ya normalizado). */
export function removeAutoDndApp(cls: string) {
  _setAutoDndFullscreenApps(autoDndFullscreenApps.get().filter((a) => a !== cls))
  save()
}

load()
