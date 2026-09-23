// Estado central de Orion: sección activa, búsqueda y panel contextual
// derecho. Es la única pieza que las secciones y `Orion.tsx` comparten —
// evita que cada componente importe a otro directamente.

import { createState } from "ags"
import { resolveSearch } from "./search"
import type { SearchResult } from "./search"
import {
  orionAppsDefault,
  orionRecordarUltimaSeccion,
} from "../ajustes/preferences"

export type SectionId =
  | "inicio" | "apps" | "rice" | "keybinds" | "reactivo"

export const [orionVisible,  setOrionVisible]  = createState(false)
export const [activeSection,  setActiveSection]  = createState<SectionId>("inicio")
export const [searchQuery,    setSearchQuery]    = createState("")
export const [searchResults,  setSearchResults]  = createState<SearchResult[]>([])

// Solo vive durante la sesión actual de AGS. Un reinicio vuelve a respetar la
// página inicial y evita convertir estado de navegación en configuración.
let ultimaSeccionCerrada: SectionId | null = null

function seccionActualRecordable(): SectionId {
  return activeSection.get() === "reactivo" ? originSection : activeSection.get()
}

function recordarSeccionAlCerrar(): void {
  ultimaSeccionCerrada = orionRecordarUltimaSeccion.get()
    ? seccionActualRecordable()
    : null
}

export function preparePanelOpen() {
  setSearchQuery("")
  setSearchResults([])
  setRightPanelVisible(false)
  const seccionInicial: SectionId = orionAppsDefault.get() ? "apps" : "inicio"
  const seccion = orionRecordarUltimaSeccion.get()
    ? ultimaSeccionCerrada ?? seccionInicial
    : seccionInicial
  originSection = seccion
  // No notificar un cambio inexistente conserva también el desplazamiento de
  // la sección montada al volver a abrir Orion.
  if (activeSection.get() !== seccion) setSection(seccion)
}

export function showPanel()   { preparePanelOpen(); setOrionVisible(true) }
export function hidePanel()   { recordarSeccionAlCerrar(); setOrionVisible(false) }

// ── Cierre temporal que NO limpia (suspensión) ───────────────────────────────
//
// Cerrar Orion normalmente es una salida: `finalizarCierrePanel` vacía búsqueda,
// resultados y panel derecho, y la sección vuelve a la de inicio salvo que el
// usuario tenga activado `orionRecordarUltimaSeccion`. Eso está bien cuando
// cierras tú, y está mal cuando Orion se aparta **por obligación**: hoy solo lo
// hace para dejarle la pantalla al diálogo de contraseña de polkit, que es una
// ventana normal y no puede dibujarse sobre una layer-shell OVERLAY. Ahí el
// usuario no ha pedido salir de ningún sitio, así que devolverlo a Inicio le
// pierde el sitio en el que estaba por un motivo puramente técnico.
//
// La suspensión guarda una foto, cierra sin limpiar y la repone al volver.

interface PanelSuspendido {
  seccion: SectionId
  origen: SectionId
  consulta: string
  resultados: SearchResult[]
  app: AppContextItem | null
  panelDerecho: boolean
}

let suspendido: PanelSuspendido | null = null

/** Está Orion apartado a la fuerza (y por tanto su estado, congelado). */
export function panelSuspendido(): boolean { return suspendido !== null }

/**
 * Cierra Orion conservando exactamente dónde estaba. Devuelve `false` si no
 * había nada que suspender (Orion ya cerrado), para que quien llama sepa que no
 * debe reanudar después.
 */
export function suspenderPanel(): boolean {
  if (!orionVisible.get()) return false
  suspendido = {
    seccion: activeSection.get(),
    origen: originSection,
    consulta: searchQuery.get(),
    resultados: searchResults.get(),
    app: rightPanelApp.get(),
    panelDerecho: rightPanelVisible.get(),
  }
  // A propósito SIN `recordarSeccionAlCerrar()`: esto no es una salida, y
  // apuntar la sección aquí ensuciaría el "volver a la última" de la próxima
  // apertura de verdad.
  setOrionVisible(false)
  return true
}

/**
 * Tira la foto sin reabrir: lo que apartó a Orion terminó en otro sitio (el
 * diálogo de Steam) y volver a asomarse solo taparía esa ventana.
 *
 * **Hay que llamarla, no basta con no reanudar**: una foto olvidada deja
 * `finalizarCierrePanel` cortocircuitado para siempre y Orion no volvería a
 * limpiar su estado en ningún cierre posterior. Aquí el cierre pasa a ser uno
 * normal, así que se aplica la limpieza que se había saltado.
 */
export function descartarSuspension(): void {
  if (suspendido === null) return
  suspendido = null
  finalizarCierrePanel()
}

/**
 * Devuelve Orion a donde estaba.
 *
 * `soltarApp` sirve para el caso en que la app del panel derecho ya no existe
 * (se acaba de desinstalar): reponerla dejaría una ficha fantasma con un botón
 * «Abrir» que no abre nada.
 *
 * Si el usuario volvió a abrir Orion por su cuenta mientras tanto, la foto se
 * descarta sin tocar nada: lo que él acaba de hacer manda sobre lo que había.
 */
export function reanudarPanel(opciones: { soltarApp?: boolean } = {}): void {
  const foto = suspendido
  suspendido = null
  if (!foto) return
  if (orionVisible.get()) return

  originSection = foto.origen
  if (activeSection.get() !== foto.seccion) setSection(foto.seccion)

  if (!opciones.soltarApp) {
    setSearchQuery(foto.consulta)
    setSearchResults(foto.resultados)
    setRightPanelApp(foto.app)
    setRightPanelVisible(foto.panelDerecho)
  } else if (foto.consulta.trim()) {
    // La app ya no existe, así que unos resultados congelados la seguirían
    // listando y al pulsarla no pasaría nada — el mismo fantasma que evita
    // `data/catalogo.ts` en la rejilla. Se repite la consulta, que con el
    // catálogo ya invalidado devuelve la lista sin ella (y reabre el panel
    // derecho sobre el primer resultado, como en cualquier búsqueda).
    setQuery(foto.consulta)
  } else {
    setSearchQuery("")
    setSearchResults([])
    setRightPanelApp(null)
    setRightPanelVisible(false)
  }

  // Sin `preparePanelOpen()`, que es justo lo que reinicia búsqueda y sección.
  setOrionVisible(true)
}
export function togglePanel() {
  if (orionVisible.get()) hidePanel()
  else showPanel()
}

type SectionListener = (id: SectionId) => void
const sectionListeners: SectionListener[] = []
export function onSectionChange(fn: SectionListener) { sectionListeners.push(fn) }

export function setSection(section: SectionId) {
  setActiveSection(section)
  sectionListeners.forEach(fn => fn(section))
}

// Section the user was in before a reactive search redirected them
let originSection: SectionId = "inicio"

/** Limpia el estado cuando la ventana ya ha terminado de salir de pantalla. */
export function finalizarCierrePanel() {
  if (orionVisible.get()) return
  // Una suspensión no es un cierre: la limpieza de aquí abajo es exactamente lo
  // que hay que saltarse para poder volver al mismo sitio (ver `suspenderPanel`).
  if (suspendido !== null) return
  recordarSeccionAlCerrar()
  setSearchQuery("")
  setSearchResults([])
  setRightPanelVisible(false)
  if (ultimaSeccionCerrada !== null) {
    originSection = ultimaSeccionCerrada
    if (activeSection.get() !== ultimaSeccionCerrada) setSection(ultimaSeccionCerrada)
    return
  }
  if (activeSection.get() !== "inicio") setSection("inicio")
  originSection = "inicio"
}

// Si se desactiva y se vuelve a activar sin abrir Orion entre medias, no debe
// reaparecer una sección guardada por una configuración anterior.
orionRecordarUltimaSeccion.subscribe(() => {
  if (!orionRecordarUltimaSeccion.get()) ultimaSeccionCerrada = null
})

export function setQuery(query: string) {
  setSearchQuery(query)

  if (!query.trim()) {
    setSearchResults([])
    hideRightPanel()
    // If we redirected to reactive, go back to where they came from
    if (activeSection.get() === "reactivo") setSection(originSection)
    return
  }

  const resolved = resolveSearch(query, activeSection.get())

  if (resolved.inline) {
    // Active section handles filtering on its own (e.g. keybinds)
    return
  }

  // Remember origin before jumping to reactive
  if (activeSection.get() !== "reactivo") originSection = activeSection.get()
  setSearchResults(resolved.results)
  setSection("reactivo")

  // Auto-preview: if the first result is an app (the list can now mix apps and
  // shortcuts), open its context in the right panel.
  const first = resolved.results[0]
  if (first?.meta?.exec) {
    const execName = first.meta?.execName ?? (first.meta?.exec ?? "").split(" ")[0].split("/").pop() ?? ""
    showAppContext({
      id:       first.id,
      name:     first.title,
      iconName: first.iconName ?? "application-x-executable",
      gicon:    first.icon ?? null,
      execRaw:  first.meta?.exec ?? "",
      execName,
      appId:    first.meta?.appId ?? first.id,
      desktopFile: first.meta?.desktopFile ?? "",
      launch:   () => first.action(),
    })
  } else {
    hideRightPanel()
  }
}

// ── App context / right panel ─────────────────────────────────────────────────

export interface AppContextItem {
  id: string
  name: string
  iconName: string
  gicon?: any | null   // Gio.Icon — kept as `any` to avoid importing Gio in state
  execRaw: string   // full exec string
  execName: string  // bare binary name
  appId: string
  // Ruta del `.desktop`, para poder preguntarle a pacman quién lo posee. Es la
  // pregunta que mejor identifica el paquete: el `Exec` puede ser un envoltorio
  // (`sh -c`, `env`) y resolvería al intérprete. Vacío = no se conoce (un
  // favorito guardado antes de que existiera este campo), y entonces la
  // detección cae en el binario, que sigue funcionando en la mayoría de casos.
  desktopFile?: string
  launch: () => void
}

export const [rightPanelApp,     setRightPanelApp]     = createState<AppContextItem | null>(null)
export const [rightPanelVisible, setRightPanelVisible] = createState(false)

export function showAppContext(item: AppContextItem) {
  setRightPanelApp(item)
  setRightPanelVisible(true)
}

export function hideRightPanel() { setRightPanelVisible(false) }
