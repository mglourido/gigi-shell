import app from "ags/gtk4/app"
import { Astal, Gtk, Gdk } from "ags/gtk4"
import { createComputed, createState, onCleanup } from "ags"
import AstalHyprland from "gi://AstalHyprland"
import { cpuRamHabilitado } from "./funciones/estado"

import Reloj from "./indicadores/tiempo/Reloj"
import Funciones, { MenuFunciones } from "./funciones/Funciones"
import Escritorios from "./escritorios/Escritorios"
import IndicadorJuegos from "./juegos/IndicadorJuegos"
import BandejaSistema from "./bandeja/BandejaSistema"
import Bluetooth from "./indicadores/conectividad/Bluetooth"
import Red from "./indicadores/conectividad/Red"
import Volumen from "./indicadores/audio/Volumen"
import Bateria from "./indicadores/energia/Bateria"
import Recursos from "./indicadores/sistema/Recursos"
import CapturaPantalla from "./indicadores/sistema/CapturaPantalla"
import IndicadorMantenerDespierto from "./funciones/IndicadorMantenerDespierto"
import Microfono from "./indicadores/audio/Microfono"
import Camara from "./indicadores/sistema/Camara"
import Gestos from "./indicadores/sistema/Gestos"
import BotonNotificaciones from "./indicadores/notificaciones/BotonNotificaciones"
import Actualizaciones from "./indicadores/sistema/Actualizaciones"
import BotonMenuEnergia from "./controles/BotonMenuEnergia"
import ReproduccionSpotify from "./multimedia/spotify/ReproduccionSpotify"
import RanuraCondicionalBarra from "./componentes/RanuraCondicionalBarra"
import { crearCadenaEstado, JuntaCadena } from "./componentes/cadenaEstado"
import { obtenerControlVisibilidadBarra } from "../../estado/visibilidadBarra"
import { suscribirPantallaCompleta } from "../../servicios/escritorios/pantallaCompleta"
import { spotifyBarSuspended } from "../../servicios/energia/powerState"
import { barAutoHideEnabled, batteryBarEnabled, fondoShell, micIndicatorEnabled, networkBarEnabled, notificationBarEnabled, screencastIndicatorEnabled, spotifyBarEnabled, trayBarEnabled, workspacesBarEnabled, updatesMonitorEnabled } from "../ajustes/preferences"
import { camaraEnUso } from "../../servicios/camara/uso"
import { gestosActivos } from "../../servicios/gestos/estado"
import { anyPanelVisible, alternarQuickSettings, solicitudAlternarBar } from "../../estado/shell"
import { notifPanelVisible } from "../notificaciones/store"
import { suspensionFalsaActiva } from "../../servicios/energia/suspensionFalsa"
import { avisoBateriaBaja } from "../../servicios/energia/avisoBateriaBarra"

export default function Barra(gdkmonitor: Gdk.Monitor) {
  const { TOP, LEFT, RIGHT } = Astal.WindowAnchor
  const visibilidad = obtenerControlVisibilidadBarra(gdkmonitor)
  // Realce encadenado de los indicadores de estado. Uno POR BARRA: compartirlo
  // encendería también la cadena del monitor donde no está el puntero.
  const cadena = crearCadenaEstado()
  const mostrarSpotify = createComputed(() => spotifyBarEnabled() && !spotifyBarSuspended())
  const { visible, fijarVisible: setVisible, fijarRefrescar: setWidgetsRefresh } = visibilidad
  const [isHovered, setIsHovered] = createState(false)
  const [isWsDragging, setIsWsDragging] = createState(false)
  const [isWsPreview, setIsWsPreview] = createState(false)
  const [barKeyboardActive, setBarKeyboardActive] = createState(false)
  const [barPinnedByKey, setBarPinnedByKey] = createState(false)
  const [barOcultaPorTecla, setBarOcultaPorTecla] = createState(false)
  // Hay una ventana en pantalla completa REAL en el escritorio activo de esta salida.
  const [barTapada, setBarTapada] = createState(false)
  let hideTimer: ReturnType<typeof setTimeout> | null = null
  let showTimer: ReturnType<typeof setTimeout> | null = null
  let startupTimer: ReturnType<typeof setTimeout> | null = null
  let keyboardCount = 0
  let shownAt = 0
  let lastY = 0
  const BAR_HEIGHT = 38

  // La barra arranca visible y con refresco activo. Las suscripciones no ejecutan
  // su callback al registrarse, así que este estado inicial debe ser explícito para
  // que widgets como el reloj no pinten una caché vacía hasta el primer hover.
  setWidgetsRefresh(true)
  setVisible(true)
  // Cubre la animación CSS (300ms) para que lastY no tenga valores del bar oculto
  const SHOW_LOCK_MS = 320
  const CLOSE_GUARD_Y = 8

  function trackMotion(x: number, y: number) {
    setIsHovered(true)
    if (visible()) lastY = y
  }

  function trackEnter(x: number, y: number) {
    setIsHovered(true)
    if (visible()) lastY = y
  }

  function handleShow() {
    if (showTimer) clearTimeout(showTimer)
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null }
    if (!visible()) lastY = 0  // limpiar coordenada del bar oculto (y=38 relativo)
    setWidgetsRefresh(true)
    showTimer = setTimeout(() => {
      shownAt = Date.now()
      setVisible(true)
      showTimer = null
    }, 200)
  }

  // Muestra el bar YA, sin el delay de handleShow ni los guards de handleHide.
  // Para los casos en que el bar debe quedarse fijo: pin por teclado y
  // auto-ocultado desactivado en Barra y escritorios.
  function showNow() {
    if (showTimer) { clearTimeout(showTimer); showTimer = null }
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null }
    setWidgetsRefresh(true)
    shownAt = Date.now()
    setVisible(true)
  }

  // Ocultado explícito por teclado: no depende del auto-ocultado, del hover ni
  // de los guards de salida, porque debe prevalecer sobre la preferencia de bar fijo.
  function hideNow() {
    if (showTimer) { clearTimeout(showTimer); showTimer = null }
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null }
    setVisible(false)
    setWidgetsRefresh(false)
  }

  function handleHide() {
    if (showTimer) { clearTimeout(showTimer); showTimer = null }
    if (!visible()) return
    if (!barAutoHideEnabled.get()) return
    if (barPinnedByKey.get()) return
    if (hideTimer) clearTimeout(hideTimer)
    hideTimer = setTimeout(() => {
      if (barAutoHideEnabled.get() && !isHovered() && !anyPanelVisible.get() && !visibilidad.menuAbierto.get() && !isWsPreview.get() && !isWsDragging() && !barPinnedByKey.get()) {
        if (Date.now() - shownAt < SHOW_LOCK_MS) return
        if (lastY <= CLOSE_GUARD_Y) return
        setVisible(false)
        setWidgetsRefresh(false)
      }
    }, 300)
  }

  // Una sola ruta decide la visibilidad local de esta salida.
  const checkVisibility = () => {
    // Durante la suspensión falsa manda ella y nadie más: la ventana está desmapeada y los
    // sondeos de los widgets, sueltos. Va lo PRIMERO porque cualquier otra rama de aquí
    // abajo puede llamar a `showNow()`/`handleShow()` y volver a encender `refrescar` —
    // basta con que algo mueva `anyPanelVisible` o el auto-ocultado mientras dormimos— y el
    // ahorro se perdería sin un solo síntoma visible, que es justo con la pantalla apagada
    // cuando nadie lo notaría.
    if (suspensionFalsaActiva.get()) {
      setWidgetsRefresh(false)
      return
    }
    // Pantalla completa real en esta salida: Hyprland ya oculta la barra bajando su
    // capa a alpha 0, pero la superficie sigue MAPEADA y GTK la sigue renderizando
    // (~2,5 % de CPU medidos, con y sin pantalla completa: es render, no sondeo — los
    // widgets ni corren aquí). Bajarla de verdad —misma ruta física que el ocultado
    // por teclado— la saca de pantalla y GTK deja de dibujarla (~0,07 %). No hay salto
    // de las ventanas de debajo: en pantalla completa el compositor ya ignora la zona
    // exclusiva de la barra, así que soltar su reserva no recoloca nada; al salir se
    // restaura. Va ANTES del pin/hover: durante la pantalla completa la barra no debe
    // reaparecer al pasar el ratón por arriba.
    if (barTapada.get()) {
      hideNow()
    } else if (barOcultaPorTecla.get()) {
      hideNow()
    } else if (!barAutoHideEnabled.get()) {
      showNow()
    } else if (isHovered() || anyPanelVisible.get() || visibilidad.menuAbierto.get() || isWsPreview.get()) {
      handleShow()
    } else {
      handleHide()
    }
  }

  const bajas = [
    isHovered.subscribe(checkVisibility),
    anyPanelVisible.subscribe(checkVisibility),
    visibilidad.menuAbierto.subscribe(checkVisibility),
    isWsPreview.subscribe(checkVisibility),
    isWsDragging.subscribe(() => { if (!isWsDragging.get()) checkVisibility() }),
  ]

  bajas.push(barPinnedByKey.subscribe(() => {
    if (barPinnedByKey.get()) showNow()
    else checkVisibility()
  }))
  bajas.push(barOcultaPorTecla.subscribe(checkVisibility))

  // ── Suspensión falsa: DESMAPEAR NO PARA LOS TIMERS ────────────────────────────────
  // La ventana se desmapea sola (ver el `visible` del <window>, más abajo), pero eso solo
  // apaga el RENDER. `refrescar` es el otro lever, el de los SONDEOS, y hasta aquí no lo
  // movía nadie más que el hover y el auto-ocultado: con la barra fija —`barAutoHide` en
  // false, que es el caso de este equipo— se quedaba en `true` toda la suspensión falsa y
  // `Recursos.tsx` seguía leyendo /proc/stat y /proc/meminfo CADA 4 s con la pantalla
  // apagada. Es exactamente lo que el documento dice que esta función quita («un widget
  // oculto no ejecuta sus GLib.timeout_add»), y no era verdad: lo apagaba la ventana, no el
  // sondeo. Los consumidores de `refrescar` (Recursos, Batería, Red, Volumen, Reloj) ya
  // saben soltar y readquirir; aquí solo hay que decírselo.
  //
  // Al SALIR no se restaura a `true` a ciegas: se vuelve a pasar por `checkVisibility()`,
  // que es la única ruta que decide la visibilidad local de esta salida. Forzar `true`
  // dejaría la barra sondeando retraída si la suspensión falsa terminó con el puntero fuera
  // y el auto-ocultado puesto — o sea el estado que este bloque viene a evitar.
  bajas.push(suspensionFalsaActiva.subscribe(checkVisibility))

  // Auto-ocultado desactivado en Barra y escritorios → el bar baja al instante y ya
  // no vuelve a ocultarse; al reactivarlo, checkVisibility decide (se retraerá si
  // no hay hover ni paneles abiertos).
  bajas.push(barAutoHideEnabled.subscribe(checkVisibility))

  // ── Aviso de batería baja (Ajustes > Barra) ──────────────────────────────────────
  // Se dispara en el FLANCO, no mientras la condición dure, y esa es toda la diferencia
  // entre un aviso y una barra clavada: baja la barra UNA vez —exactamente lo mismo que
  // hace revelarla con el puntero— y a partir de ahí manda el auto-ocultado de siempre,
  // así que se esconde sola al pasar el ratón por encima y apartarlo. NO va a
  // `checkVisibility()`: cualquier condición sostenida ahí dentro reimpondría la barra en
  // cada evento (hover, panel, escritorio) y dejaría al usuario sin poder ocultarla hasta
  // enchufar el cargador. Tampoco toca la exclusividad de la ventana, que sigue en NORMAL
  // flotando sobre las ventanas: reservar sus 38 px al cruzar el umbral recolocaría TODAS
  // las ventanas de la salida y volvería a recolocarlas al enchufar. Un aviso no mueve el
  // escritorio.
  let avisoBateriaPrevio = avisoBateriaBaja.get()
  bajas.push(avisoBateriaBaja.subscribe(() => {
    const aviso = avisoBateriaBaja.get()
    const previo = avisoBateriaPrevio
    avisoBateriaPrevio = aviso
    // Solo el flanco de subida. Al enchufar el cargador no se hace NADA: la barra se
    // queda como esté y se retraerá por su cuenta cuando toque, que es lo que haría
    // cualquier otra revelación.
    if (!aviso || previo) return
    // Pantalla completa real y suspensión falsa mandan sobre esto, igual que en
    // `checkVisibility()`: ni una película ni la pantalla apagada quieren una barra
    // asomando. El aviso se pierde, y es lo correcto — no hay nadie mirando.
    if (barTapada.get() || suspensionFalsaActiva.get()) return
    // Ocultada a mano con el atajo: se levanta esa marca en vez de ignorarla. Dejarla
    // puesta y llamar a `showNow()` dejaría la barra visible con `barOcultaPorTecla` en
    // true, y el primer `checkVisibility()` que pasara por cualquier otro motivo la
    // volvería a esconder de golpe — un parpadeo sin causa aparente. Levantarla equivale
    // a que el usuario hubiera vuelto a pulsar el atajo, y el aviso sigue siendo
    // descartable con el ratón como cualquier otro.
    if (barOcultaPorTecla.get()) setBarOcultaPorTecla(false)
    showNow()
  }))

  // Actualiza barTapada cuando aparece/desaparece una pantalla completa real en el
  // escritorio activo de esta salida. checkVisibility (suscrito abajo) hace el resto.
  bajas.push(suscribirPantallaCompleta(gdkmonitor, setBarTapada))
  bajas.push(barTapada.subscribe(checkVisibility))

  const hyprland = AstalHyprland.get_default()
  const nombreMonitor = gdkmonitor.get_connector() ?? ""
  const esMonitorEnfocado = () => {
    const enfocado = (hyprland as any).focusedMonitor ?? (hyprland as any).get_focused_monitor?.()
    if (nombreMonitor && enfocado?.name) return enfocado.name === nombreMonitor
    const geometria = gdkmonitor.get_geometry()
    return enfocado?.x === geometria.x && enfocado?.y === geometria.y
  }
  bajas.push(solicitudAlternarBar.subscribe(() => {
    if (!esMonitorEnfocado()) return
    const ocultar = visible.get()
    setBarPinnedByKey(!ocultar)
    setBarOcultaPorTecla(ocultar)
  }))

  // Auto-ocultado inicial: el bar arranca visible para que se vea al iniciar
  // sesión, pero checkVisibility() solo corre dentro de los .subscribe(), que no
  // disparan en el arranque. Sin esto, el bar quedaba fijo hasta el primer hover.
  // Tras un breve margen, si no hay hover ni paneles abiertos, se oculta solo.
  // (Hide directo: omite los guards de flicker —lastY/SHOW_LOCK— que no aplican
  // en el arranque, donde lastY=0 los bloquearía.)
  // (El aviso de batería baja entra aquí porque en el arranque no hay flanco que
  // escuchar: si la sesión empieza ya por debajo del umbral y descargando, la barra
  // simplemente no se retrae en este primer ocultado. Sigue siendo una revelación
  // normal — se esconde en cuanto el ratón la roce y se aparte.)
  startupTimer = setTimeout(() => {
    startupTimer = null
    if (barAutoHideEnabled.get() && !avisoBateriaBaja.get() && !isHovered() && !anyPanelVisible.get() && !visibilidad.menuAbierto.get() && !isWsPreview.get() && !isWsDragging() && !barPinnedByKey.get()) {
      setVisible(false)
      setWidgetsRefresh(false)
    }
  }, 2000)

  const interaccionWorkspaces = {
    cambiarArrastre: setIsWsDragging,
    cambiarVistaPrevia: setIsWsPreview,
    adquirirTeclado: () => {
      keyboardCount++
      if (keyboardCount === 1) setBarKeyboardActive(true)
    },
    liberarTeclado: () => {
      keyboardCount = Math.max(0, keyboardCount - 1)
      if (keyboardCount === 0) setBarKeyboardActive(false)
    },
  }

  onCleanup(() => {
    if (hideTimer) clearTimeout(hideTimer)
    if (showTimer) clearTimeout(showTimer)
    if (startupTimer) clearTimeout(startupTimer)
    bajas.forEach((baja) => { if (typeof baja === "function") baja() })
  })

  // La franja para revelar la barra al pasar el ratón por arriba aparece cuando está
  // retraída, PERO no durante una pantalla completa: ahí la barra se queda abajo a
  // propósito (la ventana en pantalla completa manda) y no debe reaparecer al rozar.
  const mostrarHotzone = createComputed(
    [visible, barTapada, suspensionFalsaActiva],
    (v, tapada, dormido) => !v && !tapada && !dormido,
  )

  const hotzone = <window
    name="bar-hotzone"
    visible={mostrarHotzone}
    gdkmonitor={gdkmonitor}
    layer={Astal.Layer.TOP}
    exclusivity={Astal.Exclusivity.NORMAL}
    anchor={TOP | LEFT | RIGHT}
    application={app}
    heightRequest={1}
    marginTop={0}
  >
    <box hexpand vexpand>
      <Gtk.EventControllerMotion
        onEnter={() => setIsHovered(true)}
        onLeave={() => setIsHovered(false)}
        onMotion={() => setIsHovered(true)} />
    </box>
  </window>

  const bar = <window
    name="bar"
    // DESMAPEADA durante la suspensión falsa, no solo retraída con `marginTop`. La
    // diferencia no es cosmética —con DPMS off no se ve nada de todas formas—: una ventana
    // meramente fuera de pantalla sigue ejecutando los `GLib.timeout_add` de repintado de
    // sus widgets (el reloj, los chips, los medidores de CPU/RAM/red), y eso es justo lo
    // que la suspensión falsa viene a quitar. El ahorro aquí es de timers y de wakeups de
    // CPU; el de GPU ya lo dio gratis el `dpms off`. Ver «El lever más grande, y es gratis»
    // en docs/suspension-falsa.md.
    visible={suspensionFalsaActiva((dormido: boolean) => !dormido)}
    gdkmonitor={gdkmonitor}
    layer={Astal.Layer.TOP}
    // Con auto-ocultado el bar flota sobre las ventanas (NORMAL): reservar zona
    // exclusiva para una superficie que se retrae dejaría un hueco muerto de 38px.
    // Sin auto-ocultado es un bar fijo clásico, así que pasa a EXCLUSIVE y Hyprland
    // le reserva su altura en vez de taparles el borde superior a las ventanas.
    exclusivity={createComputed(
      [barAutoHideEnabled, barOcultaPorTecla],
      (autoOcultar, ocultaPorTecla) => autoOcultar || ocultaPorTecla
        ? Astal.Exclusivity.NORMAL
        : Astal.Exclusivity.EXCLUSIVE,
    )}
    focusable={true}
    anchor={TOP | LEFT | RIGHT}
    application={app}
    // El bar vive en NONE: como es una capa siempre mapeada, en reposo (y sobre todo
    // al iniciar sesión, cuando es la única superficie) no debe poder recibir el foco
    // de teclado del compositor, o se lo queda y hay que clicar la app recién abierta.
    // Solo elevamos a ON_DEMAND mientras un renumerado de escritorios está activo;
    // la vista de escritorios adquiere y libera el teclado durante esa interacción.
    // El hover normal no pide teclado.
    keymode={barKeyboardActive((on) => on ? Astal.Keymode.ON_DEMAND : Astal.Keymode.NONE)}
    marginTop={visible((v) => v ? 0 : -BAR_HEIGHT)}
    cssClasses={createComputed(() => [
      "Bar",
      visible() ? "bar-visible" : "bar-hidden",
      `fondo-shell-${fondoShell()}`,
    ])}
  >
    <Gtk.EventControllerMotion
      onEnter={trackEnter}
      onLeave={() => {
        if (barPinnedByKey.get()) setBarPinnedByKey(false)
        setIsHovered(false)
      }}
      onMotion={trackMotion}
    />
    <Gtk.GestureClick
      onPressed={() => setIsHovered(true)}
    />
    <centerbox>
      <box $type="start" halign={Gtk.Align.START} spacing={6}>
        <Reloj visibilidad={visibilidad} />
        <box spacing={1}>
          <Funciones />
          <RanuraCondicionalBarra
            estado={workspacesBarEnabled}
            construir={() => Escritorios(gdkmonitor, visibilidad, interaccionWorkspaces)}
          />
        </box>
        <IndicadorJuegos visibilidad={visibilidad} />
      </box>

      <box $type="center" halign={Gtk.Align.CENTER} spacing={8}>
        {/* La ranura desmonta el contenido cuando la preferencia o el ahorro lo
            desactivan. OndaSpotify libera su reloj de frames mediante onCleanup. */}
        <RanuraCondicionalBarra
          estado={mostrarSpotify}
          construir={() => <ReproduccionSpotify visibilidad={visibilidad} />}
        />
      </box>

      <box $type="end" halign={Gtk.Align.END} spacing={10} cssClasses={["bar-end-box"]}>
        <RanuraCondicionalBarra
          estado={trayBarEnabled}
          construir={() => <BandejaSistema visibilidad={visibilidad} />}
        />
        <box cssClasses={["bar-status-pair"]} spacing={0}>
          <RanuraCondicionalBarra
            estado={updatesMonitorEnabled}
            construir={() => <Actualizaciones visibilidad={visibilidad} cadena={cadena} />}
          />
          {/* La ranura conserva esta posición al montar y desmontar el indicador
              desde Ajustes, entre Actualizaciones y Notificaciones. */}
          <RanuraCondicionalBarra
            estado={screencastIndicatorEnabled}
            construir={() => <CapturaPantalla cadena={cadena} />}
          />
          <RanuraCondicionalBarra
            estado={notificationBarEnabled}
            construir={() => <BotonNotificaciones cadena={cadena} />}
          />
          {/* Cierre de la cadena: cose la banda del realce con las esquinas
              redondeadas de quick settings. Ver `componentes/cadenaEstado.tsx`. */}
          <JuntaCadena cadena={cadena} forzado={notifPanelVisible} />
          <button
            cssClasses={["bar-pill-btn"]}
            onClicked={alternarQuickSettings}
          >
            <box cssClasses={["bar-pill", "qs-system-pill"]}>
              {/* Wake up: montado siempre y escondido con `visible`, no con un <With>.
                  No es una preferencia que se pueda apagar, así que no hay remontaje en
                  caliente del que protegerse con una caja propia. Vive DENTRO de la
                  pastilla del sistema, como el resto de indicadores de estado. */}
              <IndicadorMantenerDespierto />
              <Bluetooth />
              <RanuraCondicionalBarra estado={micIndicatorEnabled} construir={() => <Microfono />} />
              {/* Cámara en uso: mismo sitio y mismo trato que el micro, porque
                  responde a la misma pregunta ("¿me está captando algo?") y se
                  lee de un vistazo al tenerlos juntos. La ranura NO es aquí un
                  interruptor de Ajustes sino la propia condición de uso: un
                  aviso de privacidad no se puede apagar, y así el indicador se
                  monta solo mientras hay algo que avisar y desaparece sin
                  descolocar al resto de la pastilla. */}
              <RanuraCondicionalBarra estado={camaraEnUso} construir={() => <Camara />} />
              {/* Modo gestos. Va INMEDIATAMENTE detrás del de cámara y no en
                  otro sitio: con el modo encendido los dos aparecen juntos, y
                  se leen de un golpe como una sola frase ("la cámara está
                  encendida, y es el escritorio quien mira"). La ranura tampoco
                  es un interruptor de Ajustes sino la propia actividad del
                  modo, igual que la de al lado. */}
              <RanuraCondicionalBarra estado={gestosActivos} construir={() => <Gestos />} />
              <RanuraCondicionalBarra
                estado={networkBarEnabled}
                construir={() => <Red visibilidad={visibilidad} />}
              />
              <Volumen visibilidad={visibilidad} />
              <RanuraCondicionalBarra
                estado={batteryBarEnabled}
                construir={() => <Bateria visibilidad={visibilidad} />}
              />
            </box>
          </button>
        </box>
        <box spacing={3}>
          {/* CPU/RAM es una "función" del menú del logo Arch: desactivada por
              defecto. La ranura la desmonta cuando se apaga y conserva su posición
              inmediatamente a la izquierda de Power al volver a activarla. */}
          <RanuraCondicionalBarra
            estado={cpuRamHabilitado}
            construir={() => <Recursos visibilidad={visibilidad} />}
          />
          <BotonMenuEnergia />
        </box>
      </box>
    </centerbox>
  </window>

  return [hotzone, bar, MenuFunciones(gdkmonitor)]
}
