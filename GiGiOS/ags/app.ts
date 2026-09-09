import app from "ags/gtk4/app"
import style from "./estilos/out.css"
import Barra from "./modulos/barra/Barra"
import Lagarto from "./modulos/mascotas/Lagarto"
import MenuEnergia from "./modulos/menu-energia/MenuEnergia"
import OSD, { showOSD } from "./modulos/osd/OSD"
import { showMicOSD } from "./modulos/osd/MicOSD"
import QuickSettings from "./modulos/ajustes-rapidos/QuickSettings"
import NotificationPopup from "./modulos/notificaciones/NotificationPopup"
import NotificationPanel from "./modulos/notificaciones/NotificationPanel"
import SettingsWindow from "./modulos/notificaciones/settings/SettingsWindow"
import PanelCalendario from "./modulos/calendario/PanelCalendario"
import SettingsPanel from "./modulos/ajustes/SettingsPanel"
import Orion from "./modulos/orion/Orion"
import { togglePanel as alternarPanelOrion } from "./modulos/orion/state"
import { orionEnabled } from "./modulos/ajustes/preferences"
import { startCleanupEngine } from "./modulos/notificaciones/cleanup/cleanupEngine"
import { runAppSettingsMigration } from "./modulos/notificaciones/settings/runMigration"
import { initAutoDnd } from "./modulos/notificaciones/autoDnd/watcher"
import { initNotifDaemonCheck } from "./modulos/notificaciones/daemon/comprobacion"
import { initTrayApps } from "./modulos/ajustes/trayApps"
import { initGamingState } from "./servicios/energia/gamingState"
import { initBrilloAhorro } from "./servicios/energia/brilloAhorro"
import { inicializarCamara } from "./servicios/camara/init.ts"
import { initTlpAuto } from "./servicios/energia/tlpAuto"
import { initInactividadAhorro } from "./servicios/pantalla/inactividadAhorro"
import { inicializarMantenerDespierto } from "./servicios/energia/mantenerDespierto"
import { initGamemode, toggleGamemode } from "./servicios/energia/gamemode"
import { alternarSuspensionFalsa, entrarSuspensionFalsa, initSuspensionFalsa } from "./servicios/energia/suspensionFalsa"
import { sfSustituirReal } from "./servicios/energia/powerState"
import { execAsync } from "ags/process"
import { initPuenteWakeUp } from "./servicios/energia/wakeUpSuspensionFalsa"
import { initOpacidadAhorro } from "./servicios/energia/opacidadAhorro"
import { initOpacidadVentanas } from "./servicios/energia/opacidadVentanas"
import { initFondoShellVar } from "./servicios/apariencia/fondoShellVar"
import { iniciarCierreAjustesAlCambiarEscritorio } from "./servicios/escritorios/cierreAlCambiarEscritorio"
import { inicializarReloj } from "./modulos/calendario/reloj/estadoReloj"
import { initPlanificadorFondos } from "./servicios/fondos/planificador"
import { initAcentoAdaptativo } from "./servicios/fondos/acento"
import { initPresetsApps } from "./servicios/multimedia/presetsApps"
import { initPresetsDispositivos } from "./servicios/multimedia/presetsDispositivos"
import { alternarBarPorTecla, alternarMenuEnergia, alternarPanelAjustes, alternarPanelNotificaciones, alternarQuickSettings, showBrightnessOSD, stepBrightness, toggleCalendar } from "./estado/shell"

app.start({
  css: style,
  requestHandler(argv, response) {
    if (argv.includes("volume-osd")) {
      showOSD()
      response("ok")
      return
    }
    if (argv.includes("mic-osd")) {
      showMicOSD()
      response("ok")
      return
    }
    if (argv.includes("brightness-osd")) {
      showBrightnessOSD()
      response("ok")
      return
    }
    // Las teclas de brillo pasan por aquí en vez de llamar a `brightnessctl` desde el
    // keybind: así funcionan con los dos backends (panel interno o DDC/CI) y el estado
    // del shell no se desincroniza del monitor. Ver `servicios/pantalla/brightness.ts`.
    if (argv.includes("brightness-up")) {
      stepBrightness(0.1)
      response("ok")
      return
    }
    if (argv.includes("brightness-down")) {
      stepBrightness(-0.1)
      response("ok")
      return
    }
    // Mismo interruptor que el botón de mando de Quick Settings, por si algún día
    // se quiere una tecla. La respuesta dice en qué estado queda.
    if (argv.includes("toggle-gamemode")) {
      response(toggleGamemode() ? "on" : "off")
      return
    }
    // Suspensión falsa. Se expone como `request` y no solo como botón porque es el punto
    // de entrada que necesitan las otras tres superficies: el atajo de teclado (que además
    // tiene que ser `locked = true` para existir con hyprlock delante), el menú de energía
    // —cuyas acciones son COMANDOS de shell, `comando: string`, y no admiten una llamada
    // interna sin cambiar el tipo— y cualquier automatismo del usuario.
    // "Suspender" de todo el sistema pasa por aquí —el menú de energía y el botón físico de
    // encendido— en vez de llamar a `systemctl suspend` cada uno por su cuenta. El motivo es
    // el ajuste «sustituir la suspensión real por la falsa»: sin un punto único, encenderlo
    // arreglaría la inactividad y dejaría el botón de encendido suspendiendo de verdad, que
    // es exactamente el caso que el usuario quiere evitar y encima el más fácil de pulsar sin
    // pensar. Quien llama tiene un `|| systemctl suspend` de reserva por si AGS no responde:
    // sin AGS no hay nadie que pueda hacer una suspensión falsa, así que la real es la
    // degradación correcta (misma REGLA DE ORO que idle-action.sh).
    if (argv.includes("suspend")) {
      if (sfSustituirReal.get()) {
        entrarSuspensionFalsa().catch((e) => console.error("[suspend] suspensión falsa falló:", e))
        response("falsa")
      } else {
        execAsync(["systemctl", "suspend"]).catch((e) => console.error("[suspend] falló:", e))
        response("real")
      }
      return
    }
    // Entrada SIN alternar. La pide la TAPA del portátil («Suspensión falsa» en
    // Ajustes > Energía, hypr/gigios/tapa.lua): cerrar la tapa estando ya dentro
    // tiene que dejarla puesta, y `toggle-suspension-falsa` haría justo lo
    // contrario — sacar de ella con la tapa cerrada y nadie delante de la pantalla.
    // Es un request aparte y no un parámetro del de arriba porque `suspend` significa
    // otra cosa: allí la falsa solo entra si el usuario la ha puesto a sustituir a la
    // real, y aquí la ha pedido por su nombre.
    if (argv.includes("suspension-falsa-entrar")) {
      entrarSuspensionFalsa().catch((e) => console.error("[suspension-falsa] entrada falló:", e))
      response("ok")
      return
    }
    if (argv.includes("toggle-suspension-falsa")) {
      response(alternarSuspensionFalsa() ? "on" : "off")
      return
    }
    if (argv.includes("toggle-orion")) {
      alternarPanelOrion()
      response("ok")
      return
    }
    if (argv.includes("toggle-bar")) {
      alternarBarPorTecla()
      response("ok")
      return
    }
    // Lo usa GiGiOS.boton_apagado() (hypr/gigios/boton-apagado.lua) cuando el botón físico
    // está configurado para abrir el menú en vez de ejecutar una acción directa.
    if (argv.includes("toggle-power-menu")) {
      alternarMenuEnergia()
      response("ok")
      return
    }
    if (argv.includes("toggle-quicksettings")) {
      alternarQuickSettings()
      response("ok")
      return
    }
    if (argv.includes("toggle-settings")) {
      alternarPanelAjustes()
      response("ok")
      return
    }
    if (argv.includes("toggle-notifications")) {
      alternarPanelNotificaciones()
      response("ok")
      return
    }
    // El calendario era el único panel sin `request`: solo se abría pinchando el reloj de la barra.
    // Con la barra autoocultada eso obliga a ir a buscarla, y no había forma de atarlo a una tecla.
    if (argv.includes("toggle-calendar")) {
      toggleCalendar()
      response("ok")
      return
    }
    response("unknown request")
  },
  main() {
    app.get_monitors().flatMap(Barra)
    // Mascota puramente cosmética: se monta siempre (ventana barata, oculta por
    // `visible`) para que el toggle de Ajustes se aplique en caliente, igual
    // que spotifyBarEnabled. El try/catch la aísla de las demás ventanas por
    // si el sprite no carga en una máquina nueva.
    try { app.get_monitors().map(Lagarto) } catch (e) { console.error("[app] Lagarto failed:", e) }
    app.get_monitors().map(MenuEnergia)
    app.get_monitors().map(OSD)
    // Resumen inicial simultáneo: cada tarjeta aplica su propia condición (el
    // volumen se omite si arranca silenciado o a cero, y el brillo si ya está al
    // máximo), pero las que procedan aparecen juntas.
    setTimeout(() => {
      showOSD(true)
      showBrightnessOSD(true)
    }, 1200)
    app.get_monitors().map(QuickSettings)
    app.get_monitors().map(NotificationPopup)
    app.get_monitors().map(NotificationPanel)
    app.get_monitors().map(SettingsWindow)
    // La construcción debe ocurrir dentro del contexto reactivo de main(). Si
    // está desactivado no se crea la ventana, por lo que tampoco puede arrancar
    // el polling ni ningún proceso auxiliar de Orion.
    if (orionEnabled.get()) {
      app.get_monitors().map(Orion)
    }
    try { app.get_monitors().map(PanelCalendario) } catch(e) { console.error("[app] PanelCalendario failed:", e) }
    app.get_monitors().map(SettingsPanel)
    // Las dos ventanas de ajustes tapan la pantalla entera y no viven en ningún
    // escritorio: se cierran al cambiar de workspace. Va a t=0 (una conexión de
    // señal, coste nulo) para que no queden abiertas si el cambio ocurre pronto.
    iniciarCierreAjustesAlCambiarEscritorio()
    // Deja el Wake up apagado: es por sesión, y un wakeup.json heredado seguiría
    // vetando la suspensión sin que ninguna UI lo enseñe. NO se aparta con los
    // demás (abajo): su único trabajo es limpiar estado heredado peligroso, y es
    // un borrado de fichero — retrasar justo eso no tiene sentido.
    inicializarMantenerDespierto()
    // Misma razón, mismo sitio: un registro de GameMode huérfano de un AGS muerto
    // dejaría el gobernador de CPU en `performance` sin UI donde apagarlo. Es un
    // `pkill` acotado a nuestro argv0, así que tampoco tiene sentido apartarlo.
    initGamemode()
    // Y por tercera vez la misma razón: un `suspension-falsa.json` heredado de un AGS
    // muerto lleva un pid que el kernel pudo reciclar, y con el pid vivo la guarda de
    // `blocked()` da el veto por bueno — el equipo dejaría de suspenderse para siempre sin
    // que nada lo diga. Además descongela las apps que aquel AGS dejara congeladas.
    initSuspensionFalsa()
    // Quita la transparencia de los paneles si el ahorro ya está activo al arrancar.
    // A t=0 y no con los init* de abajo porque SE VE: apartarlo cuatro segundos serían
    // cuatro segundos de paneles translúcidos que luego cambian solos a la vista. Es un
    // CssProvider y una suscripción, así que no compite con nada.
    initOpacidadAhorro()
    // Su gemelo para las ventanas del compositor. Mismo t=0 y por lo mismo, y encima
    // aquí es gratis: la primera pasada solo lanza el `hyprctl` si lo que quiere no es
    // ya lo que el config aplicó al cargarse (lo compara contra el fichero en disco).
    initOpacidadVentanas()
    // Publica `--bg-shell` para que los tooltips y los menús emergentes sigan
    // "Color de fondo global" igual que la barra. A t=0 y no con los init* de
    // abajo porque el fondo del shell se ve desde el primer fotograma.
    initFondoShellVar()

    // ── Trabajo de fondo, apartado del pintado inicial ────────────────────────
    // Nada de esto se ve: son vigilantes y un barrido de limpieza. Corriendo aquí
    // competían con la construcción de las ventanas (una por monitor) justo cuando
    // el escritorio se está pintando, y alguno no es gratis — initAutoDnd e
    // initGamingState consultan `isGameClient`, que puede acabar parseando los ~161
    // .desktop del sistema (Gio.AppInfo.get_all) para decidir si una ventana es un
    // juego. Es el mismo gesto que el resumen de OSD de arriba.
    //
    // Apartarlos es seguro porque NINGUNO depende de eventos ocurridos mientras
    // esperan: initTrayApps e initGamingState SIEMBRAN de lo que haya vivo al
    // arrancar (`tray.get_items()` / `hypr.get_clients()`) antes de suscribirse, así
    // que a los 4 s ven un superconjunto de lo que verían ahora; initAutoDnd adopta
    // el estado del DND al empezar; e initNotifDaemonCheck va suscrito a
    // NameOwnerChanged (y de hecho gana fiabilidad: a los pocos ms del arranque el
    // dueño del nombre de notificaciones aún se está resolviendo).
    //
    // Sobre initGamingState: escribe runtime-state.json para que bash lo lea. Su
    // único consumidor es la pausa del escáner de descargas de oom-monitor.sh, que
    // ahora ni siquiera barre hasta el segundo 60 — el flag lleva ahí mucho antes.
    setTimeout(() => {
      startCleanupEngine()
      runAppSettingsMigration()
      initAutoDnd()
      initTrayApps()
      initGamingState()
      // Después de NotificationPopup: es quien construye el AstalNotifd que reclama el nombre.
      initNotifDaemonCheck()
      // Arma el temporizador de la próxima alarma. Va aquí y no a t=0 porque NO siembra de
      // eventos: lee la lista del disco, que no cambia mientras espera, y las alarmas puntuales
      // vencidas ya se desactivaron al cargar el módulo. Cuatro segundos de margen no pueden
      // hacer que se pierda un vencimiento: el planificador se arma contra el reloj de pared.
      inicializarReloj()
      // Mismo criterio: el fondo del arranque ya lo puso `wallpaper.sh` desde el
      // autostart de Hyprland, y este solo vigila el próximo cambio de franja
      // contra el reloj de pared — cuatro segundos no pueden perderle ninguno.
      initPlanificadorFondos()
      // Mismo apartado y mismo criterio: el shell ya está pintado con el azul de
      // reserva del tema —un tema completo, no un estado a medias— y esto solo lo
      // tiñe cuando el extractor conteste. Además lanza un `python3`, que es justo
      // lo que no debe competir con la construcción de las ventanas.
      initAcentoAdaptativo()
      // Las tres medidas de ahorro que actúan sobre el SISTEMA (brillo del panel, perfil
      // de TLP y tiempos de hypridle). Van aquí por el mismo criterio: siembran del
      // ESTADO —`powerSaveActive` ya está resuelto y sus apuntes están en disco—, no de
      // eventos ocurridos mientras esperan, así que cuatro segundos no les pierden nada.
      // Su primera pasada es además la recuperación de un apunte huérfano que pudiera
      // haber dejado un AGS muerto con el ahorro puesto (brillo bajo, tiempos cortos).
      // Cámaras: enumeración por udev y reposición de los controles guardados.
      // Mismo criterio que los anteriores — siembra de lo VIVO (le pregunta a udev
      // qué hay), no de eventos ocurridos mientras espera, así que a los 4 s ve un
      // superconjunto de lo que habría visto a t=0. Sin cámara enchufada no deja
      // absolutamente nada corriendo.
      inicializarCamara()
      initBrilloAhorro()
      initTlpAuto()
      initInactividadAhorro()
      // Vigilante del volumen por aplicación. Aplica los presets de `audioPresets.json`
      // a los streams que aparecen, que hasta ahora SOLO ocurría con el submenú
      // "Aplicaciones" de Quick Settings abierto: una app lanzada con el panel cerrado
      // sonaba al volumen que ella quisiera. Mismo criterio de apartado que el resto —
      // su barrido inicial atiende a lo que ya estuviera sonando, así que cuatro
      // segundos no le pierden ningún stream, solo lo atienden un poco más tarde.
      initPresetsApps()
      // Y el mismo vigilante para el volumen POR DISPOSITIVO. Restaura el preset del
      // aparato al APARECER (no al mirar la lista, que es lo que hacía Quick Settings) y
      // —lo que faltaba— lo mantiene al día con el volumen real, de modo que no pueda
      // quedar rancio y pisar el volumen vivo. Ver la cabecera de su módulo: ese pisotón
      // acababa en `system_state.json` y de ahí en el arranque siguiente.
      initPresetsDispositivos()
      // El puente «Wake up + al vencer la inactividad, entrar en suspensión falsa». Aquí y
      // no a t=0 porque no limpia nada peligroso: solo pone un Gio.FileMonitor sobre el
      // aviso que deja idle-action.sh al vetar, y los avisos que pudieran caer en estos
      // cuatro segundos son de la sesión anterior y los descarta su ventana de validez.
      initPuenteWakeUp()
    }, 4000)
  },
})
