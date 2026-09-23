// modulos/orion/components/sections/RiceSection.tsx
//
// Sección "Temas" de Orion (la acción rápida "temas" navega a la sección `rice`).
//
// Cuatro vistas dentro de una misma sección, en un `Gtk.Stack`:
//   rejilla  — lo que se ve al entrar: grupos y fondos sueltos, clic = aplicar
//   franjas  — el editor de las franjas globales
//   grupo    — la línea de 24 h de un grupo
//   fondo    — la ficha de un fondo suelto (aptitud + crear grupo)
//
// LA REJILLA LISTA ENTIDADES, NO FICHEROS. Un grupo ocupa UNA tarjeta: para el
// sistema es un solo fondo, y sus imágenes no aparecen además sueltas. Es lo
// mismo que hace el sorteo, así que lo que ves es lo que puede tocarte.
//
// LO QUE NO SALE AHORA SE ATENÚA EN VEZ DE OCULTARSE. Esconder los fondos no
// aptos dejaría media biblioteca invisible de noche, y sin nada que explicara por
// qué faltan; atenuados se siguen pudiendo aplicar a mano (el filtro es para el
// SORTEO, no una prohibición) y de paso se entiende la función sin leer nada.
//
// EL MODO EDICIÓN ES UN BOTÓN VISIBLE, no un clic derecho. Un menú contextual
// habría salido gratis, pero una función que no se anuncia es una función que no
// existe — es la lección del cronómetro que vivía en el clic derecho del reloj de
// la barra. Con el lápiz activado, un clic abre la ficha en vez de aplicar el
// fondo, y una línea de ayuda lo dice.

import { Gtk } from "ags/gtk4"
import GLib from "gi://GLib"
import Gio from "gi://Gio"
import Pango from "gi://Pango"
import {
  listWallpapers, applyEntidad, applyRandom, entidadesAhora,
  randomOnStart, setRandomOnStart, currentWallpaper, currentGroup,
  wallpapersConfig, ahoraFranjas, adquirirRelojFranjas, WALLPAPER_DIR,
} from "../../data/wallpaperConfig"
import { franjaActual, variantesDe, type Entidad } from "../../data/wallpaperSchedule"
import { loadThumbnails, THUMB_W, THUMB_H } from "../../services/wallpaperThumbs"
import { EditorFranjas } from "./rice/EditorFranjas"
import { EditorGrupo } from "./rice/EditorGrupo"
import { EditorFondo } from "./rice/EditorFondo"
import { etiqueta } from "./rice/comunes"
import Interruptor from "../../../../componentes/Interruptor"
import { TextoInformativo, TituloAjuste } from "../../../ajustes/componentes"

type Vista =
  | { v: "rejilla" }
  | { v: "franjas" }
  | { v: "grupo"; id: string }
  | { v: "fondo"; path: string }

export function RiceSection() {
  const root = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, cssClasses: ["rice-content"] })

  const pila = new Gtk.Stack()
  pila.set_transition_type(Gtk.StackTransitionType.CROSSFADE)
  pila.set_transition_duration(120)
  // Gtk.Stack es verticalmente homogéneo por defecto: la ficha corta de un
  // fondo heredaría la altura natural de toda la rejilla, aunque esta estuviera
  // oculta, y el viewport conservaría un desplazamiento que ya no corresponde.
  // El ancho sí permanece homogéneo para que ninguna transición mueva el panel.
  pila.set_vhomogeneous(false)

  let modoEdicion = false
  let vista: Vista = { v: "rejilla" }

  // ── Vista rejilla ───────────────────────────────────────────────────────────
  const rejilla = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL })

  const header = new Gtk.Box({ cssClasses: ["rice-header"], spacing: 8 })
  const titulo = new Gtk.Label({
    label: "Fondos de pantalla", cssClasses: ["rice-section-title"],
    halign: Gtk.Align.START, hexpand: true,
  })
  header.append(titulo)

  const botonIcono = (icono: string, tip: string, alPulsar: () => void) => {
    const b = new Gtk.Button({ cssClasses: ["rice-random-btn"], widthRequest: 27, heightRequest: 27 })
    b.set_child(new Gtk.Image({ iconName: icono, cssClasses: ["rice-random-icon"] }))
    b.set_tooltip_text(tip)
    b.connect("clicked", alPulsar)
    return b
  }

  const btnFranjas = botonIcono("alarm-symbolic", "Franjas horarias", () => ir({ v: "franjas" }))
  const btnEditar  = botonIcono("document-edit-symbolic", "Editar fondos y grupos", () => {
    modoEdicion = !modoEdicion
    reconstruirRejilla()
  })
  const btnRandom  = botonIcono("media-playlist-shuffle-symbolic", "Fondo aleatorio", () => applyRandom())
  header.append(btnFranjas)
  header.append(btnEditar)
  header.append(btnRandom)
  rejilla.append(header)

  // Chip con la franja vigente. No es adorno: "¿por qué ha cambiado el fondo?" no
  // se respondía en ningún sitio, que es el mismo agujero que tapó el chip de
  // franja activa en Ajustes > Pantalla.
  const chipFranja = etiqueta("", ["rice-franja-actual"])
  rejilla.append(chipFranja)

  const ayudaEdicion = etiqueta(
    "Modo edición: pulsa un fondo para configurarlo.", ["rice-help", "edicion"])
  ayudaEdicion.set_visible(false)
  rejilla.append(ayudaEdicion)

  // ── Fila del toggle "aleatorio al iniciar" ─────────────────────────────────
  const toggleRow = new Gtk.Box({ cssClasses: ["rice-toggle-row"], spacing: 8 })
  const tText = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, hexpand: true, halign: Gtk.Align.START })
  tText.append(TituloAjuste({ label: "Fondo aleatorio al iniciar Hyprland" }))
  tText.append(TextoInformativo({
    label: "Si lo apagas, al arrancar se mantiene el último fondo elegido (cambiando de versión si toca).",
    wrap: true,
    maxWidthChars: 54,
    xalign: 0,
  }))
  toggleRow.append(tText)
  toggleRow.append(Interruptor({
    activo: randomOnStart,
    alAlternar: () => setRandomOnStart(!randomOnStart.get()),
  }))
  rejilla.append(toggleRow)

  const flow = new Gtk.FlowBox({ cssClasses: ["rice-grid"] })
  flow.selection_mode      = Gtk.SelectionMode.NONE
  flow.column_spacing      = 8
  flow.row_spacing         = 8
  flow.min_children_per_line = 3
  flow.max_children_per_line = 3
  flow.homogeneous         = true
  rejilla.append(flow)

  pila.add_named(rejilla, "rejilla")
  root.append(pila)

  // clave (ruta o `grupo:<id>`) -> botón, para resaltar lo puesto reactivamente
  const btnByKey = new Map<string, Gtk.Button>()
  const viewportByPath = new Map<string, Gtk.Box>()

  const claveDe = (e: Entidad) => e.tipo === "grupo" ? `grupo:${e.grupo.id}` : e.path

  const syncHighlight = () => {
    // Con un grupo puesto, la tarjeta que se resalta es la del GRUPO, no la de la
    // variante: la identidad de lo aplicado es el grupo, y la variante es un
    // detalle que cambia solo con la hora.
    const grupo = currentGroup.get()
    const actual = grupo ? `grupo:${grupo}` : currentWallpaper.get()
    for (const [clave, btn] of btnByKey) {
      const base = btn.get_css_classes().filter(c => c !== "wp-current")
      btn.set_css_classes(clave === actual ? [...base, "wp-current"] : base)
    }
  }

  // Cada reconstrucción invalida a la anterior: las miniaturas de una pasada en
  // vuelo pueden llegar después de que la rejilla se haya rehecho (un fondo
  // añadido mientras se generaban), y deben descartarse.
  let generation = 0

  const reconstruirRejilla = () => {
    const mine = ++generation
    btnByKey.clear()
    viewportByPath.clear()
    flow.remove_all()

    const cfg = wallpapersConfig.get()
    const ahora = ahoraFranjas.get()
    const vigente = franjaActual(cfg, ahora)
    chipFranja.set_label(vigente ? `Ahora: ${vigente.nombre}` : "Sin franjas horarias")
    chipFranja.set_visible(true)
    ayudaEdicion.set_visible(modoEdicion)
    btnEditar.set_css_classes(modoEdicion
      ? ["rice-random-btn", "activo"] : ["rice-random-btn"])

    const lista = entidadesAhora()

    // Se reserva toda la rejilla antes de pedir las imágenes: si los botones se
    // añaden a la vez que las miniaturas, FlowBox recalcula sus columnas en cada
    // una y los fondos parecen encogerse durante la carga.
    for (const e of lista) {
      const portada = e.tipo === "grupo" ? e.portada : e.path
      const clases = ["rice-thumb"]
      if (!e.activo) clases.push("inactivo")
      if (e.tipo === "grupo") clases.push("es-grupo")

      const placeholder = new Gtk.Box({ cssClasses: ["rice-thumb-placeholder"], hexpand: true })
      placeholder.set_size_request(THUMB_W, THUMB_H)

      // El viewport conserva el tamaño de la tarjeta y recorta la imagen cuando
      // el hover la amplía; así la rejilla y el borde nunca se desplazan.
      const viewport = new Gtk.Box({ cssClasses: ["rice-thumb-viewport"], hexpand: true })
      viewport.set_overflow(Gtk.Overflow.HIDDEN)
      viewport.set_size_request(THUMB_W, THUMB_H)
      viewport.append(placeholder)

      // Las insignias van en un overlay sobre la miniatura: dentro del viewport
      // las recortaría el `overflow: hidden` del hover.
      const overlay = new Gtk.Overlay()
      overlay.set_child(viewport)

      if (e.tipo === "grupo") {
        const insignia = etiqueta(`◆ ${variantesDe(e.grupo).length}`, ["rice-badge"])
        insignia.set_halign(Gtk.Align.END)
        insignia.set_valign(Gtk.Align.START)
        overlay.add_overlay(insignia)

        const nombre = etiqueta(e.grupo.nombre, ["rice-badge", "nombre"])
        nombre.set_halign(Gtk.Align.START)
        nombre.set_valign(Gtk.Align.END)
        nombre.set_ellipsize(Pango.EllipsizeMode.END)
        nombre.set_max_width_chars(16)
        overlay.add_overlay(nombre)
      }

      const btn = new Gtk.Button({ cssClasses: clases, hexpand: true })
      btn.set_child(overlay)
      btn.set_tooltip_text(
        e.tipo === "grupo"
          ? `${e.grupo.nombre} — ${variantesDe(e.grupo).length} versiones${e.activo ? "" : " · ahora no sale"}`
          : e.activo ? "" : "Ahora no entra en el sorteo")
      btn.connect("clicked", () => {
        if (modoEdicion) {
          ir(e.tipo === "grupo" ? { v: "grupo", id: e.grupo.id } : { v: "fondo", path: e.path })
        } else {
          applyEntidad(e)
        }
      })

      btnByKey.set(claveDe(e), btn)
      if (portada) viewportByPath.set(portada, viewport)
      flow.append(btn)
    }
    syncHighlight()

    // OJO: se pasa la lista COMPLETA de fondos, no solo las portadas. Esta
    // llamada poda la caché de miniaturas de todo lo que no esté en la lista, así
    // que pasar solo las portadas borraría las de las variantes que hay dentro de
    // los grupos y las regeneraría en cada apertura del editor.
    const todas = listWallpapers()
    loadThumbnails(todas, (path, tex) => {
      if (mine !== generation) return // rejilla ya obsoleta
      const viewport = viewportByPath.get(path)
      const anterior = viewport?.get_first_child()
      if (!viewport || !anterior) return
      const pic = new Gtk.Picture({ cssClasses: ["rice-thumb-img"], hexpand: true })
      pic.set_paintable(tex)
      pic.content_fit = Gtk.ContentFit.COVER
      pic.set_size_request(THUMB_W, THUMB_H)
      viewport.remove(anterior)
      viewport.append(pic)
    })
  }

  // ── Navegación entre vistas ─────────────────────────────────────────────────
  // Las subvistas se construyen al entrar y se destruyen al salir: son estado de
  // navegación, no algo que deba sobrevivir. Reconstruir al volver también es lo
  // que hace que la rejilla refleje lo que acabas de editar.
  let actual: Gtk.Widget | null = null

  const ir = (destino: Vista) => {
    vista = destino
    if (actual) { pila.remove(actual); actual = null }

    if (destino.v === "rejilla") {
      reconstruirRejilla()
      pila.set_visible_child_name("rejilla")
      return
    }

    const volver = () => ir({ v: "rejilla" })
    const w =
      destino.v === "franjas" ? EditorFranjas(volver)
      : destino.v === "grupo" ? EditorGrupo(destino.id, volver)
      : EditorFondo(destino.path, volver,
          gid => ir({ v: "grupo", id: gid }),
          () => ir({ v: "franjas" }))

    actual = w
    pila.add_named(w, "sub")
    pila.set_visible_child_name("sub")
  }

  // ── Ciclo de vida ───────────────────────────────────────────────────────────
  let loaded = false
  let soltarReloj: (() => void) | null = null
  const suscripciones: (() => void)[] = []

  root.connect("map", () => {
    // El reloj de franjas solo vive mientras la sección está a la vista: es el
    // mismo ref-contado que Ajustes > Pantalla, y por el mismo motivo (un tick
    // perpetuo para refrescar una etiqueta que nadie mira).
    if (!soltarReloj) soltarReloj = adquirirRelojFranjas()
    if (loaded) {
      if (vista.v === "rejilla") reconstruirRejilla()
      return
    }
    loaded = true
    suscripciones.push(currentWallpaper.subscribe(syncHighlight))
    suscripciones.push(currentGroup.subscribe(syncHighlight))
    // Al cruzar una franja cambia qué está atenuado y qué chip se enseña. Solo se
    // rehace la rejilla si es la vista visible: reconstruir por debajo de un
    // editor abierto se llevaría por delante lo que el usuario está tocando.
    suscripciones.push(ahoraFranjas.subscribe(() => {
      if (vista.v === "rejilla") reconstruirRejilla()
    }))
    ir({ v: "rejilla" })
  })

  root.connect("unmap", () => {
    if (soltarReloj) { soltarReloj(); soltarReloj = null }
  })

  // La carpeta de fondos se vigila para no tener que reiniciar AGS al meter o
  // quitar wallpapers. Copiar un fondo grande dispara muchos eventos (created,
  // changed…, uno por bloque escrito), así que se rebota: se reconstruye tras
  // 800 ms sin novedades. La caché es por fichero, así que rehacer la rejilla
  // solo genera las miniaturas nuevas; las demás se releen del disco (~30 ms).
  let debounce = 0
  const dir = Gio.File.new_for_path(WALLPAPER_DIR)
  const dirMonitor = dir.monitor_directory(Gio.FileMonitorFlags.NONE, null)
  dirMonitor.connect("changed", () => {
    if (!loaded || vista.v !== "rejilla") return
    if (debounce) GLib.source_remove(debounce)
    debounce = GLib.timeout_add(GLib.PRIORITY_DEFAULT_IDLE, 800, () => {
      debounce = 0
      reconstruirRejilla()
      return GLib.SOURCE_REMOVE
    })
  })
  // Sin esta referencia el monitor sería recolectado por el GC y dejaría de avisar.
  ;(root as any)._wallpaperDirMonitor = dirMonitor

  return root
}
