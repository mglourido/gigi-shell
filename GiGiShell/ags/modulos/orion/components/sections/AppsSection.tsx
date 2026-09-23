// Sección "Aplicaciones" de Orion: catálogo completo de `.desktop`, filtrable
// por categoría y con dos vistas (mosaico / lista). Las apps de Inicio
// (favoritos) son un catálogo aparte — ver `HomeSection.tsx` — pero comparten
// el icono y la tarjeta de mosaico vía `../shared/tarjetaApp`.

import { Gtk } from "ags/gtk4"
import type Gio from "gi://Gio"
import {
  activeSection,
  hidePanel,
  rightPanelVisible,
  showAppContext,
} from "../../state"
import { launchApp } from "../../data/launch"
import { registrarInvalidadorCatalogo } from "../../data/catalogo"
import { getAppInfos } from "../../data/appsInfo"
import { activarDobleClic } from "../shared/dobleClic"
import { crearIconoApp, construirTileApp } from "../shared/tarjetaApp"
import { vaciarCaja, vaciarFlowBox } from "../shared/gtkUtils"
import type {
  ElementoNavegacionBusqueda,
  NavegacionBusqueda,
} from "../shared/NavegacionBusqueda"

interface AppEntry {
  name: string
  iconName: string
  gicon: Gio.Icon | null
  exec: string
  execName: string
  appId: string
  desktopFile: string
  categories: string[]
}

interface Category {
  id: string
  label: string
  gioKey: string
}

interface AppRenderizada {
  widget: Gtk.Widget
  navegable: ElementoNavegacionBusqueda
}

const CATEGORIES: Category[] = [
  { id: "all",        label: "Todas",      gioKey: "" },
  { id: "games",      label: "Juegos",     gioKey: "Game" },
  { id: "multimedia", label: "Multimedia", gioKey: "AudioVideo" },
  { id: "internet",   label: "Internet",   gioKey: "Network" },
  { id: "office",     label: "Oficina",    gioKey: "Office" },
  { id: "dev",        label: "Dev",        gioKey: "Development" },
  { id: "system",     label: "Sistema",    gioKey: "System" },
  { id: "graphics",   label: "Gráficos",   gioKey: "Graphics" },
]

let _appCache: AppEntry[] | null = null

function getAllApps(): AppEntry[] {
  if (_appCache) return _appCache
  _appCache = getAppInfos()
    .map(a => {
      const cmdline = (a.get_commandline() ?? "").replace(/%[fFuUdDnNickvmb]/g, "").trim()
      const cats = (a as any).get_categories?.()?.split(";").filter(Boolean) ?? []
      return {
        name: a.get_name() ?? "",
        iconName: a.get_icon()?.to_string() ?? "application-x-executable",
        gicon: a.get_icon(),
        exec: cmdline,
        execName: a.get_executable() ?? "",
        appId: a.get_id() ?? a.get_name() ?? "",
        // `Gio.AppInfo.get_all()` devuelve `DesktopAppInfo`, así que la ruta del
        // fichero está disponible sin volver a buscarla. La necesita el panel
        // derecho para preguntarle a pacman de qué paquete es la app.
        desktopFile: (a as any).get_filename?.() ?? "",
        categories: cats,
      }
    })
    .filter(a => a.name && a.exec)
    .sort((a, b) => a.name.localeCompare(b.name, "es", { sensitivity: "base" }))
  return _appCache
}

function openAppContext(app: AppEntry) {
  showAppContext({
    id: app.appId,
    name: app.name,
    iconName: app.iconName,
    gicon: app.gicon,
    execRaw: app.exec,
    execName: app.execName,
    appId: app.appId,
    desktopFile: app.desktopFile,
    launch: () => launchApp(app.exec),
  })
}

function launchAppDirect(app: AppEntry) {
  launchApp(app.exec)
  hidePanel()
}

function bindAppActivation(
  boton: Gtk.Button,
  app: AppEntry,
  navegacion: NavegacionBusqueda,
  navegable: ElementoNavegacionBusqueda,
) {
  const estaSuprimido = activarDobleClic(boton, () => {
    navegacion.seleccionarResultado(navegable, false)
    launchAppDirect(app)
  })
  boton.connect("notify::has-focus", () => {
    if (boton.has_focus) navegacion.seleccionarResultado(navegable, false)
  })
  boton.connect("clicked", () => {
    navegacion.seleccionarResultado(navegable, false)
    if (estaSuprimido()) return
    openAppContext(app)
  })
}

function buildAppRow(app: AppEntry, navegacion: NavegacionBusqueda): AppRenderizada {
  const boton = new Gtk.Button({ cssClasses: ["apps-row"], hexpand: true })
  const inner = new Gtk.Box({ spacing: 10 })

  const iconBox = new Gtk.Box({ cssClasses: ["apps-row-icon"], valign: Gtk.Align.CENTER })
  iconBox.append(crearIconoApp(app.gicon, app.iconName, 32))
  inner.append(iconBox)
  inner.append(new Gtk.Label({
    label: app.name,
    cssClasses: ["apps-row-label"],
    halign: Gtk.Align.START,
    hexpand: true,
    ellipsize: 3,
  }))
  boton.set_child(inner)

  const navegable: ElementoNavegacionBusqueda = {
    marcarSeleccionado: (seleccionado) => {
      if (seleccionado) boton.add_css_class("seleccionado")
      else boton.remove_css_class("seleccionado")
    },
    previsualizar: () => {
      if (rightPanelVisible.get()) openAppContext(app)
    },
    enfocar: () => boton.grab_focus(),
    activar: () => openAppContext(app),
  }
  bindAppActivation(boton, app, navegacion, navegable)

  return { widget: boton, navegable }
}

function buildAppTile(app: AppEntry, navegacion: NavegacionBusqueda): AppRenderizada {
  const boton = new Gtk.Button({ cssClasses: ["apps-tile"] })
  construirTileApp(boton, crearIconoApp(app.gicon, app.iconName, 38), app.name)
  const navegable: ElementoNavegacionBusqueda = {
    marcarSeleccionado: (seleccionado) => {
      if (seleccionado) boton.add_css_class("seleccionado")
      else boton.remove_css_class("seleccionado")
    },
    previsualizar: () => {
      if (rightPanelVisible.get()) openAppContext(app)
    },
    enfocar: () => boton.grab_focus(),
    activar: () => openAppContext(app),
  }
  bindAppActivation(boton, app, navegacion, navegable)
  return { widget: boton, navegable }
}

export function AppsSection(navegacion: NavegacionBusqueda) {
  // ── Category pills ────────────────────────────────────────────
  const catsBox = new Gtk.Box({ cssClasses: ["apps-cats"], spacing: 2 })

  const catBtns: Map<string, Gtk.Button> = new Map()

  function refreshCatBtns(cat: string) {
    for (const [id, btn] of catBtns) {
      btn.set_css_classes(id === cat ? ["apps-cat-btn", "active"] : ["apps-cat-btn"])
    }
  }

  for (const cat of CATEGORIES) {
    const btn = new Gtk.Button({
      cssClasses: cat.id === "all" ? ["apps-cat-btn", "active"] : ["apps-cat-btn"],
      label: cat.label,
      valign: Gtk.Align.CENTER,
    })
    btn.connect("clicked", () => {
      refreshCatBtns(cat.id)
      rebuild(cat.id)
    })
    catBtns.set(cat.id, btn)
    catsBox.append(btn)
  }

  // "Todas" uses a visual catalogue; filtered categories stay compact.
  const grid = new Gtk.FlowBox({ cssClasses: ["apps-all-grid"] })
  grid.selection_mode = Gtk.SelectionMode.NONE
  grid.homogeneous = true
  grid.column_spacing = 6
  grid.row_spacing = 6
  grid.min_children_per_line = 6
  grid.max_children_per_line = 6

  const listBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, cssClasses: ["apps-list"] })
  const modeIcon = new Gtk.Image({ iconName: "view-app-grid-symbolic", pixelSize: 13 })
  const modeLabel = new Gtk.Label({ label: "Mosaico", cssClasses: ["apps-mode-label"] })
  const modeButton = new Gtk.Button({ cssClasses: ["apps-mode-toggle"] })
  const modeButtonInner = new Gtk.Box({ spacing: 6 })
  modeButtonInner.append(modeIcon)
  modeButtonInner.append(modeLabel)
  modeButton.set_child(modeButtonInner)
  const countLabel = new Gtk.Label({ cssClasses: ["apps-count"] })
  let currentApps: AppEntry[] = []
  let categoriaActual = "all"
  let gridMode = true
  let navegablesActuales: ElementoNavegacionBusqueda[] = []

  function clearViews() {
    vaciarCaja(listBox)
    vaciarFlowBox(grid)
  }

  function renderMode() {
    clearViews()
    navegablesActuales = []
    grid.visible = gridMode
    listBox.visible = !gridMode
    modeIcon.icon_name = gridMode ? "view-app-grid-symbolic" : "view-list-symbolic"
    modeLabel.label = gridMode ? "Mosaico" : "Lista"
    for (const app of currentApps) {
      const renderizada = gridMode
        ? buildAppTile(app, navegacion)
        : buildAppRow(app, navegacion)
      navegablesActuales.push(renderizada.navegable)
      if (gridMode) grid.append(renderizada.widget)
      else listBox.append(renderizada.widget)
    }
    sincronizarNavegacion()
  }

  function sincronizarNavegacion(): void {
    if (activeSection.get() !== "apps") return
    // Al entrar no hay selección. La primera flecha o Tab seleccionan la
    // primera app; a partir de ahí el modelo aplica el movimiento solicitado.
    navegacion.establecerResultados(navegablesActuales, false, gridMode ? 6 : 1)
  }

  modeButton.connect("clicked", () => {
    gridMode = !gridMode
    renderMode()
  })

  function rebuild(catId: string) {
    categoriaActual = catId
    const gioKey = CATEGORIES.find(c => c.id === catId)?.gioKey ?? ""
    currentApps = getAllApps().filter(a =>
      !gioKey || a.categories.some(c => c === gioKey)
    )

    // Every category change is a fresh render: "Todas" defaults to mosaic,
    // while filtered categories keep their compact list default.
    gridMode = catId === "all"
    countLabel.label = `${currentApps.length} ${currentApps.length === 1 ? "aplicación" : "aplicaciones"}`
    renderMode()
  }

  activeSection.subscribe(sincronizarNavegacion)

  const catsScroll = new Gtk.ScrolledWindow()
  catsScroll.set_css_classes(["apps-cats-scroll"])
  catsScroll.set_policy(Gtk.PolicyType.AUTOMATIC, Gtk.PolicyType.NEVER)
  catsScroll.set_child(catsBox)

  const root = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, cssClasses: ["apps-section"] })
  root.append(catsScroll)
  const meta = new Gtk.Box({ cssClasses: ["apps-meta"], spacing: 6 })
  meta.append(countLabel)
  const spacer = new Gtk.Box({ hexpand: true })
  meta.append(spacer)
  meta.append(modeButton)
  root.append(meta)
  root.append(grid)
  root.append(listBox)

  // Carga perezosa: el catálogo (`Gio.AppInfo.get_all()` sobre los ~161 `.desktop`
  // más un tile con icono por app) se construye al MOSTRAR la sección por primera
  // vez, no al arrancar el shell. `NavSections` monta todas las secciones de una
  // vez y Orion se instancia por monitor en el arranque, así que sin esto ese
  // parseo y sus tiles se pagaban en cada sesión aunque no se abriera Orion.
  // Mismo patrón que `RiceSection`. El `map` llega durante la animación de
  // entrada, antes de que el panel sea interactivo, así que las apps ya están
  // cuando se necesitan para la navegación por teclado.
  let cargado = false
  root.connect("map", () => {
    if (cargado) return
    cargado = true
    rebuild("all")
  })

  // Desinstalar una app desde el panel derecho cambia el catálogo. Se tira la
  // caché y se repinta la categoría que esté puesta — solo si la sección ya se
  // cargó: forzar la carga perezosa desde aquí pagaría el parseo de los ~161
  // `.desktop` en una sección que el usuario aún no ha abierto.
  registrarInvalidadorCatalogo(() => {
    _appCache = null
    if (!cargado) return
    rebuild(categoriaActual)
  })

  return root
}
