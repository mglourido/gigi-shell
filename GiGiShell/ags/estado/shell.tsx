import { createState, onCleanup } from "ags"
import { notifPanelVisible, openNotifPanel, closeNotifPanel, notifSettingsVisible, setNotifSettingsVisible } from "../modulos/notificaciones/store"
import GLib from "gi://GLib"

export const [calendarVisible, setCalendarVisible] = createState(false)
export function toggleCalendar() { setCalendarVisible(!calendarVisible.get()) }

export const [nightLightActive, setNightLightActive] = createState(false)
export const [nightLightTemp, setNightLightTemp] = createState(4500)
export const [osdVisible, setOsdVisible] = createState(false)
export const [micOsdVisible, setMicOsdVisible] = createState(false)

// ── Panel visibility ─────────────────────────────────────────────────────────
// Cada panel tiene su propio estado. anyPanelVisible se deriva de ellos.
export const [powerMenuVisible, setPowerMenuVisible] = createState(false)
export const [quickSettingsVisible, setQuickSettingsVisible] = createState(false)
export const [functionsMenuVisible, setFunctionsMenuVisible] = createState(false)
export const [trayMenuVisible, setTrayMenuVisible] = createState(false)

// Ventana de ajustes general (abierta desde el engranaje de QuickSettings). Es un
// overlay a pantalla completa e independiente del ciclo de vida de los paneles del
// bar, igual que la ventana de ajustes de notificaciones.
export const [settingsPanelVisible, setSettingsPanelVisible] = createState(false)
export function openSettingsPanel() {
  setNotifSettingsVisible(false)
  cerrarPanelesParaAjustes()
  setSettingsPanelVisible(true)
}
export function alternarPanelAjustes() {
  if (settingsPanelVisible.get()) setSettingsPanelVisible(false)
  else openSettingsPanel()
}
// ── Diálogos de polkit y la ventana de Ajustes ────────────────────────────────
// El agente de polkit (hyprpolkitagent) dibuja su diálogo como una ventana
// NORMAL (un toplevel xdg). La ventana de Ajustes es una superficie layer-shell
// en la capa OVERLAY, y en wlroots una capa OVERLAY se compone SIEMPRE por
// encima de cualquier toplevel: no hay regla de ventana que pueda invertir ese
// orden. Por eso el diálogo de la contraseña quedaba tapado y había que cerrar
// Ajustes para llegar a él.
//
// La única salida es que la ventana de Ajustes se aparte mientras el diálogo
// está en pantalla: baja a la capa BOTTOM (por encima del fondo de escritorio,
// por debajo de los toplevels) y suelta el teclado. Sigue viéndose detrás, así
// que no se pierde el contexto, y vuelve sola a OVERLAY al terminar.
//
// Su propio contador de referencias evita que dos operaciones solapadas
// devuelvan la ventana arriba mientras la otra sigue pidiendo contraseña.
export const [privilegedPromptActive, setPrivilegedPromptActive] = createState(false)
let _privilegedCount = 0
export async function withPrivilegedPrompt<T>(fn: () => Promise<T>): Promise<T> {
  _privilegedCount++
  setPrivilegedPromptActive(true)
  try {
    return await fn()
  } finally {
    _privilegedCount = Math.max(0, _privilegedCount - 1)
    if (_privilegedCount === 0) setPrivilegedPromptActive(false)
  }
}

export const [qsView, setQsView] = createState<"main" | "wifi" | "bluetooth" | "display" | "audio" | "mic" | "camara">("main")
export const [infoSsid, setInfoSsid] = createState<string | null>(null)

// anyPanelVisible = true si CUALQUIER panel está abierto.
// La barra observa esto para no ocultarse mientras haya un panel abierto.
// Abrir un panel cierra el resto (exclusividad mutua).
import { orionVisible, hidePanel as cerrarOrion } from "../modulos/orion/state"

// ── Registro centralizado de paneles ─────────────────────────────────────────
// Única fuente de verdad. Para que un panel nuevo mantenga la barra visible
// mientras está abierto, basta con añadir su estado a este array (antes la lista
// se duplicaba en get() y subscribe(), con riesgo de que divergieran).
type PanelState = { get: () => boolean; subscribe: (cb: () => void) => unknown }

const panelStates: PanelState[] = [
  powerMenuVisible,
  quickSettingsVisible,
  functionsMenuVisible,
  trayMenuVisible,
  notifPanelVisible,
  calendarVisible,
]

// Orion NO va en `panelStates` a propósito. Es una ventana OVERLAY propia,
// anclada abajo y con su keymode exclusivo: no cuelga de la barra ni se abre
// desde ella, así que retenerla desplegaba la barra cada vez que se abría el
// lanzador — dos cosas distintas pegadas por el registro. La barra sigue su
// propia regla (hover, pin, auto-ocultado) mientras Orion está abierto.

export const anyPanelVisible = {
  get: () => panelStates.some((s) => s.get()),
  subscribe: (cb: (v: boolean) => void) => {
    const notify = () => cb(panelStates.some((s) => s.get()))
    const bajas = panelStates
      .map((s) => s.subscribe(notify))
      .filter((baja): baja is () => void => typeof baja === "function")

    return () => bajas.forEach((baja) => baja())
  },
}

// ── Auto-cierre de paneles al salir el ratón ──────────────────────────────────
// Devuelve handlers onEnter/onLeave para un <Gtk.EventControllerMotion>. Al
// salir el puntero del panel se espera graceMs y se cierra; al volver a entrar
// se cancela. Centraliza el patrón que ya usaban MenuEnergia y NotificationPanel
// para que todos los paneles del bar se comporten igual.
//
// `visible` (opcional): el estado de visibilidad del panel. Con él se activan dos
// protecciones contra el auto-cierre espurio al abrir un panel desde OTRO panel
// (p.ej. el botón de notificaciones de QuickSettings, que cierra QS y abre el panel
// de notificaciones dejando un hueco entre el botón y el panel nuevo):
//   1. El ratón DEBE haber entrado en el panel al menos una vez antes de que un
//      "leave" pueda armar el cierre. Así, abrir un panel y no llegar a pasar el
//      ratón por encima nunca lo cierra solo.
//   2. Un "leave" disparado mientras el panel ya no es visible (unmap) se ignora,
//      evitando que un panel que se está cerrando arme un closeAllPanels tardío
//      que arrastre al panel recién abierto.
type BoolAccessor = { get: () => boolean; subscribe: (cb: () => void) => unknown }

export function panelAutoClose(close: () => void, graceMs = 300, visible?: BoolAccessor) {
  let timer: number | null = null
  let hasEntered = false
  let disposed = false
  const cancel = () => {
    if (timer !== null) { GLib.source_remove(timer); timer = null }
  }
  // Cada vez que el panel se abre, exige un nuevo "enter" real antes de auto-cerrar.
  const bajaVisible = visible
    ? visible.subscribe(() => {
      if (visible.get()) { hasEntered = false; cancel() }
    })
    : null

  const dispose = () => {
    if (disposed) return
    disposed = true
    cancel()
    if (typeof bajaVisible === "function") bajaVisible()
  }

  onCleanup(dispose)

  return {
    onEnter: () => { hasEntered = true; cancel() },
    onLeave: () => {
      cancel()
      if (visible && !hasEntered) return           // aún no se ha pasado el ratón por encima
      if (visible && !visible.get()) return         // el panel ya se está cerrando
      timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, graceMs, () => {
        close()
        timer = null
        return GLib.SOURCE_REMOVE
      })
    },
    cancel,
    dispose,
  }
}

export function openPowerMenu() {
  setQuickSettingsVisible(false)
  setFunctionsMenuVisible(false)
  setTrayMenuVisible(false)
  setPowerMenuVisible(true)
}

export function openQuickSettings() {
  setPowerMenuVisible(false)
  setFunctionsMenuVisible(false)
  setTrayMenuVisible(false)
  setQuickSettingsVisible(true)
  closeNotifPanel()
}

export function closeAllPanels() {
  setPowerMenuVisible(false)
  setQuickSettingsVisible(false)
  setFunctionsMenuVisible(false)
  setTrayMenuVisible(false)
  closeNotifPanel()
}

/** Cierra los paneles que NO están en `closeAllPanels`: el calendario y Orion.
 *
 * Viven fuera de ese registro porque no son paneles de la barra (Orion es una
 * ventana OVERLAY propia con su propio ciclo de vida, y el calendario se abre
 * desde el reloj), así que hay que cerrarlos aparte.
 */
export function cerrarPanelesNoBarra() {
  setCalendarVisible(false)
  if (orionVisible.get()) cerrarOrion()
}

/** Deja la pantalla libre antes de abrir una de las DOS ventanas de ajustes (la
 * general y la de notificaciones).
 *
 * Ambas son layer-shell OVERLAY ancladas a los cuatro bordes: lo que quede
 * abierto no se ve, pero sigue vivo — reteniendo la barra por `anyPanelVisible`,
 * con sus temporizadores y sus sondeos corriendo — y reaparece intacto al cerrar
 * los ajustes, como si no se hubiera hecho nada. `closeAllPanels()` no basta:
 * Orion y el calendario no forman parte de él.
 *
 * `conservarNotificaciones` es para el engranaje de la cabecera del panel de
 * notificaciones: ese botón ALTERNA la ventana de ajustes, así que cerrar el
 * panel desde el que se abre dejaría al usuario sin nada al volver a pulsarlo.
 */
export function cerrarPanelesParaAjustes(opciones: { conservarNotificaciones?: boolean } = {}) {
  setPowerMenuVisible(false)
  setQuickSettingsVisible(false)
  setFunctionsMenuVisible(false)
  setTrayMenuVisible(false)
  if (!opciones.conservarNotificaciones) closeNotifPanel()
  cerrarPanelesNoBarra()
}

// Las dos ventanas de ajustes también se excluyen entre sí, y la de
// notificaciones se abre desde sitios que no pasan por ninguna función de aquí
// (el engranaje de la cabecera y el botón «editar» de una tarjeta), así que el
// cierre cuelga de su propio estado en vez de duplicarse en cada sitio.
notifSettingsVisible.subscribe(() => {
  if (!notifSettingsVisible.get()) return
  setSettingsPanelVisible(false)
  cerrarPanelesParaAjustes({ conservarNotificaciones: true })
})

/** Abre Quick Settings cerrando los demás paneles, o lo cierra si ya está abierto. */
/** Abre el menú de energía cerrando los demás paneles, o lo cierra si ya está abierto. */
export function alternarMenuEnergia() {
  if (powerMenuVisible.get()) closeAllPanels()
  else openPowerMenu()
}

export function alternarQuickSettings() {
  if (quickSettingsVisible.get()) closeAllPanels()
  else openQuickSettings()
}

/** Abre las notificaciones cerrando los demás paneles, o las cierra si ya están abiertas. */
export function alternarPanelNotificaciones() {
  if (notifPanelVisible.get()) {
    closeNotifPanel()
  } else {
    closeAllPanels()
    openNotifPanel()
  }
}

// ── Toggle manual de la barra ────────────────────────────────────────────────
// La petición es global porque llega por IPC, pero cada Bar decide localmente si le
// corresponde comparando su salida con el monitor enfocado de Hyprland.
export const [solicitudAlternarBar, setSolicitudAlternarBar] = createState(0)

/** Invierte la visibilidad real: muestra y fija la barra si estaba oculta, o la
 * oculta aunque el auto-ocultado esté desactivado si estaba visible. */
export function alternarBarPorTecla() {
  setSolicitudAlternarBar(solicitudAlternarBar.get() + 1)
}

// ── Brillo ───────────────────────────────────────────────────────────────────
// El brillo vive en `display/brightness.ts` (dos backends: panel interno vía sysfs, o
// monitor externo vía DDC/CI). Se reexporta aquí porque este módulo es el hub de estado.
export {
  brightness,
  setBrightness,
  brightnessSupported,
  brightnessOsdVisible,
  showBrightnessOSD,
  applyBrightness,
  stepBrightness,
} from "../servicios/pantalla/brightness"
