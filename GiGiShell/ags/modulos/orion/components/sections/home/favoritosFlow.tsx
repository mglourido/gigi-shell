// Rejilla de apps favoritas de la sección Inicio: orden editable por
// arrastre, persistido en `data/favorites.ts`. Ver `../HomeSection.tsx` para
// cómo se combina con la franja de métricas de `estadisticasSistema.tsx`.

import { Gtk } from "ags/gtk4"
import Gio from "gi://Gio"
import Gdk from "gi://Gdk"
import GObject from "gi://GObject"
import GLib from "gi://GLib"
import { showAppContext, hidePanel } from "../../../state"
import { favorites, setFavorites, saveFavorites, type FavoriteApp } from "../../../data/favorites"
import { checkExecExists } from "../../../data/appResolver"
import { launchApp } from "../../../data/launch"
import { activarDobleClic } from "../../shared/dobleClic"
import { crearIconoApp, construirTileApp } from "../../shared/tarjetaApp"
import { vaciarFlowBox } from "../../shared/gtkUtils"
import { getAppInfos } from "../../../data/appsInfo"
import { registrarInvalidadorCatalogo } from "../../../data/catalogo"

// Cache of appId/execName → Gio.Icon for rendering favorites. Se construye
// sobre la lista ya compartida de `getAppInfos()` en vez de escanear
// `Gio.AppInfo.get_all()` por su cuenta, y se invalida junto con el resto del
// catálogo — antes no caducaba nunca en toda la sesión.
let _iconCache: Map<string, Gio.Icon | null> | null = null
function lookupGioIcon(appId: string, execName: string): Gio.Icon | null {
  if (!_iconCache) {
    _iconCache = new Map()
    for (const a of getAppInfos()) {
      const id  = a.get_id()
      const ex  = a.get_executable()
      const ico = a.get_icon()
      if (id) _iconCache.set(id, ico)
      if (ex) _iconCache.set(ex, ico)
    }
  }
  return _iconCache.get(appId) ?? _iconCache.get(execName) ?? null
}

registrarInvalidadorCatalogo(() => { _iconCache = null })

// ── Drag-to-reorder state ─────────────────────────────────────────────────────
// Kept module-level so buildAppFlowBtn (also module-level) can access appsFlow
let _appsFlow: Gtk.FlowBox | null = null
const _btnApp  = new Map<Gtk.Widget, FavoriteApp>()   // button → app (for sort & drop)
let _draggedId: string | null = null
let _workOrder: string[] = []    // current display order during drag
let _origOrder: string[] = []    // order before drag started (for cancel restore)

function _displayOrder(): string[] {
  return favorites.get().filter(a => checkExecExists(a.exec)).map(a => a.id)
}

function _commitOrder() {
  const favMap = new Map(favorites.get().map(f => [f.id, f]))
  const visible = _workOrder.map(id => favMap.get(id)).filter((f): f is FavoriteApp => !!f)
  const hidden  = favorites.get().filter(f => !checkExecExists(f.exec))
  const next = [...visible, ...hidden]
  setFavorites(next)
  saveFavorites(next)
}

// ── Component ────────────────────────────────────────────────────────────────

function buildAppFlowBtn(app: FavoriteApp): Gtk.Button {
  const btn = new Gtk.Button({ cssClasses: ["apps-tile"] })
  btn.tooltip_text = app.name

  const execName = app.exec.split(" ")[0].split("/").pop() ?? app.exec
  const gicon = lookupGioIcon(app.id, execName)
  construirTileApp(btn, crearIconoApp(gicon, app.iconName, 38), app.name)

  // El doble clic lanza directo; se veta mientras hay un arrastre en curso
  // para que soltar un tile sobre sí mismo no lo abra de paso.
  const estaSuprimido = activarDobleClic(btn, () => {
    launchApp(app.exec)
    hidePanel()
  }, () => !_draggedId)

  btn.connect("clicked", () => {
    if (estaSuprimido()) return
    if (_draggedId) return  // ignore clicks that are actually drag-starts
    try {
      showAppContext({
        id: app.id, name: app.name, iconName: app.iconName, gicon,
        execRaw: app.exec, execName, appId: app.id,
        // Los favoritos guardan el id del `.desktop`, no su ruta: se resuelve
        // aquí para que el panel derecho pueda identificar el paquete. Un
        // favorito cuya app ya no existe devuelve `""` y la detección cae en el
        // binario, que es exactamente el caso en que tampoco lo encontrará —
        // por eso el panel deja el motivo escrito en vez de un botón muerto.
        desktopFile: Gio.DesktopAppInfo.new(app.id)?.get_filename() ?? "",
        launch: () => launchApp(app.exec),
      })
    } catch (_) {}
  })

  // ── Drag source ───────────────────────────────────────────────────────────
  const src = new Gtk.DragSource({ actions: Gdk.DragAction.MOVE })
  src.connect("prepare", () => {
    _origOrder = _displayOrder()
    _workOrder = [..._origOrder]
    _draggedId = app.id
    return Gdk.ContentProvider.new_for_value(app.id)
  })
  src.connect("drag-begin", (self: any) => {
    btn.set_css_classes(["apps-tile", "app-dragging"])
    const pic = new Gtk.WidgetPaintable({ widget: btn })
    self.set_icon(pic, 20, 20)
  })
  src.connect("drag-end", () => {
    btn.set_css_classes(["apps-tile"])
    if (_draggedId) {
      // Drag cancelled — restore original order without saving
      _workOrder = [..._origOrder]
      _appsFlow?.invalidate_sort()
      _draggedId = null
    }
  })
  btn.add_controller(src)

  // ── Drop target (receives hover from other items' drag) ────────────────────
  const dst = new Gtk.DropTarget({ actions: Gdk.DragAction.MOVE })
  dst.set_gtypes([GObject.TYPE_STRING])
  dst.connect("motion", () => {
    if (_draggedId && _draggedId !== app.id) {
      const from = _workOrder.indexOf(_draggedId)
      const to   = _workOrder.indexOf(app.id)
      if (from !== -1 && to !== -1 && from !== to) {
        const next = [..._workOrder]
        next.splice(from, 1)
        next.splice(to, 0, _draggedId)
        _workOrder = next
        _appsFlow?.invalidate_sort()
      }
    }
    return Gdk.DragAction.MOVE
  })
  dst.connect("drop", () => {
    _draggedId = null   // cleared before drag-end fires → drag-end won't restore
    // Defer rebuild to next main-loop iteration so GTK4 can finish the DnD
    // protocol before we remove/recreate the FlowBox children.
    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => { _commitOrder(); return GLib.SOURCE_REMOVE })
    return true
  })
  btn.add_controller(dst)

  return btn
}

export function HomeSection() {
  // ── Apps FlowBox ──────────────────────────────────────────────────────────
  const appsFlow = new Gtk.FlowBox()
  _appsFlow = appsFlow
  appsFlow.set_css_classes(["apps-grid"])
  appsFlow.selection_mode = Gtk.SelectionMode.NONE
  appsFlow.homogeneous = true
  appsFlow.column_spacing = 6
  appsFlow.row_spacing = 6
  // Igual que el catálogo, limitar la fila evita que el tamaño natural de
  // FlowBox ensanche Orion más allá de su columna de 660 px.
  appsFlow.min_children_per_line = 6
  appsFlow.max_children_per_line = 6

  // Mantiene el orden editable de las aplicaciones visibles.
  appsFlow.set_sort_func((c1: any, c2: any) => {
    const b1 = c1.get_first_child() as Gtk.Widget | null
    const b2 = c2.get_first_child() as Gtk.Widget | null
    const a1 = b1 ? _btnApp.get(b1) : undefined
    const a2 = b2 ? _btnApp.get(b2) : undefined
    if (!a1 || !a2) return 0
    const i1 = _workOrder.indexOf(a1.id)
    const i2 = _workOrder.indexOf(a2.id)
    return (i1 === -1 ? 999 : i1) - (i2 === -1 ? 999 : i2)
  })

  function rebuildApps() {
    _btnApp.clear()
    vaciarFlowBox(appsFlow)

    // Only show apps whose exec resolves; register in _btnApp for sort/drag
    for (const app of favorites.get()) {
      if (!checkExecExists(app.exec)) continue
      const btn = buildAppFlowBtn(app)
      _btnApp.set(btn, app)
      appsFlow.append(btn)
    }

    _workOrder = _displayOrder()
    appsFlow.invalidate_sort()
  }

  // Carga perezosa (igual que `AppsSection`/`RiceSection`): los tiles de favoritos
  // y el `_iconCache` (`Gio.AppInfo.get_all()`) se construyen al mostrar Inicio por
  // primera vez, no al arrancar el shell —donde `NavSections` monta esta sección,
  // por monitor, aunque no se abra Orion—. Un cambio de favoritos (reordenar por
  // arrastre) solo reconstruye si la sección ya se abrió; si no, ya se cargará al
  // abrirla.
  let cargado = false
  favorites.subscribe(() => { if (cargado) rebuildApps() })

  const root = (
    <box cssClasses={["section-home"]} orientation={Gtk.Orientation.VERTICAL}>

      <label label="Aplicaciones" cssClasses={["section-title"]} halign={Gtk.Align.START} />
      {appsFlow as unknown as any}

    </box>
  ) as unknown as Gtk.Widget

  root.connect("map", () => {
    if (cargado) return
    cargado = true
    rebuildApps()
  })

  return root
}
