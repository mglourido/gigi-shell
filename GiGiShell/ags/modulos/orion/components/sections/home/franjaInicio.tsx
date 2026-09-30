// Franja fija de Inicio, entre los favoritos y las métricas, en dos pisos:
//   arriba — lo que está pasando AHORA: Sonando y Jugando ahora, cada uno en su
//            tarjeta. Solo aparece si hay algo; si no, sus píxeles vuelven a las apps.
//   abajo  — el TEMA puesto (fondo suelto o colección) y un CARRUSEL de páginas
//            pequeñas, que hoy tiene una sola: lo último que hiciste en Orion.
//
// Vive fuera del viewport desplazable por lo mismo que `estadisticasSistema.tsx`
// (ver NavSections.tsx): se monta en Orion.tsx y su alto se descuenta del
// viewport de Inicio con `alturaFranjaInicio`, que cambia cuando aparece o se
// va el piso de arriba (Sonando / Jugando ahora).
//
// Todo es GTK imperativo y sin `<For>`, como la sección Temas: son tres filas y
// una tarjeta que se reconstruyen enteras. Ninguna tiene nada enfocable que
// pudiera destruirse con el foco dentro.
//
// COSTE EN REPOSO: CERO. Ni temporizadores ni sondeos. Se reconstruye cuando
// cambia el dato (fondo, grupo, config, historial) y al abrir Orion — que es lo
// que refresca los "hace 5 min" y la variante vigente de la colección. Y solo si
// la franja ya se ha mostrado alguna vez: `NavSections` monta Inicio en cada
// monitor al arrancar el shell, aunque Orion no se abra nunca.

import { Gtk } from "ags/gtk4"
import Gio from "gi://Gio"
import GioUnix from "gi://GioUnix?version=2.0"
import GLib from "gi://GLib"
import Pango from "gi://Pango"
import { createState } from "ags"
import GObject from "gi://GObject"
import {
  orionVisible, activeSection, setSection, hidePanel, showAppContext,
} from "../../../state"
import {
  currentWallpaper, currentGroup, wallpapersConfig, applyRandom,
} from "../../../data/wallpaperConfig"
import {
  variantesDe, franjaActual, minutosDe, aMinutos, vigente, type Grupo,
} from "../../../data/wallpaperSchedule"
import { historial, borrarHistorial, registrarAtajo, type EntradaHistorial } from "../../../data/historial"
import { tiempoRelativo } from "../../../data/historial.modelo"
import { launchApp } from "../../../data/launch"
import { miniatura, nombreDe } from "../rice/comunes"
import { crearIconoApp } from "../../shared/tarjetaApp"
import { activarDobleClic } from "../../shared/dobleClic"
import { vaciarCaja } from "../../shared/gtkUtils"
import { mostrarEnBusqueda } from "../../shell/SearchBar"
import { execAsync } from "ags/process"
import { clientesJuego, clienteJuegoEnFoco } from "../../../../../servicios/juegos/registro"
import { describirJuego, GLIFO_JUEGO } from "../../../../../servicios/juegos/iconos"
import { extraerInicioProceso } from "../../../../../servicios/aplicaciones/procesos"
import { msVivo, duracionSesion, normalizarDireccion } from "../../../data/jugando.modelo"
import { ticInicio } from "../../../data/ticInicio"
import {
  reproductoresMultimedia, revisionMultimedia, obtenerEstadoReproductor, type EstadoReproductor,
} from "../../../../../servicios/multimedia/mpris"
import { findMediaClient } from "../../../../../servicios/multimedia/mediaClient"
import { resolveMediaLengthSeconds, safeMediaPosition, formatMediaTime } from "../../../../../servicios/multimedia/mediaProgress"
import {
  ACENTO_MEDIA_PREDETERMINADO, semillaDeCaratula, tonosDeAcento,
} from "../../../../../servicios/multimedia/colorCaratula"
import AstalHyprland from "gi://AstalHyprland"
import AstalWp from "gi://AstalWp"
import { suscribirDatosEscritorios } from "../../../../../servicios/escritorios/controlador"
import { filtrarVentanasDeUsuario } from "../../../../../servicios/ventanas/emergentesX11"
import { obtenerEntradaEscritorio } from "../../../../../servicios/aplicaciones/entradasEscritorio"
import { obtenerIconosClientesEscritorio } from "../../../../barra/escritorios/iconos"
import type { IconoClienteEscritorio } from "../../../../barra/escritorios/modelo"
import { streamEsDeReproductor } from "../../../../../servicios/multimedia/streamDeReproductor"
import {
  propsDeStream, nombreDeProps, clavePreset, audioPresets, setAudioPresets, guardarAudioPresets,
} from "../../../../../servicios/multimedia/presetsApps"
import { fijarVolumenEndpoint } from "../../../../../servicios/multimedia/escrituraVolumen"
import { ajustarVolumen, VOLUMEN_MAX } from "../../../../../servicios/multimedia/volumenAmplificado"
import {
  notifications, openNotifPanel, getAppIcon, type StoredNotification,
} from "../../../../notificaciones/store"
import { closeAllPanels } from "../../../../../estado/shell"
import { orionNotisApps } from "../../../../ajustes/preferences"

const hypr = AstalHyprland.get_default()

// Dos pisos: arriba lo que está pasando AHORA (Sonando / Jugando ahora), que
// solo aparece si hay algo; abajo Tema + Reciente, que están siempre.
const ALTO_PISO_TEMA = 101
// 68 y no 58: con varios reproductores, "‹ 1/N ›" va encima de los controles.
const ALTO_PISO_AHORA = 68
const SEPARACION_PISOS = 7
// Relleno vertical de `.fi-contenedor` (7 + 4).
const RELLENO_FRANJA = 11

// Ancho útil de la columna de Orion (660 px) menos el relleno de `.fi-contenedor`.
// La franja NO puede proponer su ancho natural: las filas son homogéneas (cada
// mitad pide el natural de la más ancha), y un nombre de fondo largo o una fila
// del historial bastaban para ensanchar la layer entera de Orion — que no vuelve
// a encogerse sola. Y lo mismo en vertical: `NavSections` descuenta exactamente
// `alturaFranjaInicio` del viewport de Inicio, así que si la franja pidiera un
// píxel más, el panel entero crecería.
const ANCHO_FRANJA = 640

const hayJuegos = () => clientesJuego.get().length > 0
const hayReproductor = () => reproductoresMultimedia.get().length > 0
const hayPisoAhora = () => hayJuegos() || hayReproductor()
const altoContenido = () => ALTO_PISO_TEMA + (hayPisoAhora() ? ALTO_PISO_AHORA + SEPARACION_PISOS : 0)

/**
 * Alto total de la franja. Es ESTADO porque el piso de arriba va y viene, y
 * `NavSections` lo resta del viewport de Inicio: la franja crece a costa de las
 * apps favoritas y la layer de Orion mantiene su tamaño.
 */
const [alturaFranjaInicio, setAlturaFranjaInicio] = createState(altoContenido() + RELLENO_FRANJA)
export { alturaFranjaInicio }
// Con Orion cerrado no se recalcula: el alto solo sirve para maquetar el panel,
// y cada reproductor o juego que aparece movería el tamaño de una ventana que
// nadie ve (y, en cadena, el viewport de `NavSections`). Al abrir se recalcula
// antes del primer frame (esta suscripción es de módulo, anterior a la de la
// animación de entrada de `Orion.tsx`).
const recalcularAltura = () => {
  if (orionVisible.get()) setAlturaFranjaInicio(altoContenido() + RELLENO_FRANJA)
}
clientesJuego.subscribe(recalcularAltura)
reproductoresMultimedia.subscribe(recalcularAltura)
orionVisible.subscribe(recalcularAltura)

/**
 * Caja de tamaño FIJO (mínimo = natural = `ancho`×`alto`) alrededor de un hijo.
 *
 * Dos intentos fallidos antes de esta forma, los dos medidos:
 *   - Subclase de Gtk.Widget con `vfunc_dispose` en JS: las cartas y la portada
 *     se rehacen en cada reconstrucción, y al finalizarlas el GC tenía que
 *     ejecutar ese dispose en JS — GJS lo bloquea ("Attempting to run a JS
 *     callback during garbage collection") y el hijo quedaba sin desemparentar.
 *   - `Gtk.CustomLayout` con la medida en JS: GJS no sabe manejar los parámetros
 *     de salida de `GtkCustomMeasureFunc` y ABORTA el proceso (aserción de
 *     `CairoContext` en cwrapper.h, core dump con el marco dentro de
 *     `gtk_layout_manager_measure`). Tumbaba el shell entero al abrir Orion.
 * Una subclase de Gtk.Box SIN layout manager y sin dispose propio: la medida y la
 * asignación son vfuncs que solo corren durante el layout, y `GtkBox` desemparenta
 * sus hijos en su propio dispose, en C.
 */
const CajaFija = GObject.registerClass(
  class CajaFija extends Gtk.Box {
    ancho = 0
    alto: () => number = () => 0

    vfunc_measure(orientacion: Gtk.Orientation, _paraTamano: number): [number, number, number, number] {
      const t = orientacion === Gtk.Orientation.HORIZONTAL ? this.ancho : this.alto()
      return [t, t, -1, -1]
    }

    vfunc_size_allocate(ancho: number, alto: number, linea: number) {
      for (let c = this.get_first_child(); c; c = c.get_next_sibling()) c.allocate(ancho, alto, linea, null)
    }
  },
)

function cajaFija(hijo: Gtk.Widget, ancho: number, alto: number | (() => number), recortar = true): Gtk.Box {
  const caja = new CajaFija()
  // Sin esto GtkBox mide con su BoxLayout y las vfuncs de arriba no se llaman.
  caja.set_layout_manager(null)
  caja.ancho = ancho
  caja.alto = typeof alto === "function" ? alto : () => alto
  caja.set_overflow(recortar ? Gtk.Overflow.HIDDEN : Gtk.Overflow.VISIBLE)
  caja.append(hijo)
  return caja
}

// ── Geometría de la pila de miniaturas ────────────────────────────────────────
// La carta de delante abajo a la izquierda y las de detrás asomando hacia arriba
// a la derecha, cada una un poco más girada: se lee como un mazo sin tener que
// explicarlo. Un fondo suelto es una sola carta, centrada en el mismo hueco.
const CARTA_W = 100
const CARTA_H = 56
const PASO_X = 7
const PASO_Y = 6
const MAX_DETRAS = 2
const PILA_W = CARTA_W + PASO_X * MAX_DETRAS
const PILA_H = CARTA_H + PASO_Y * MAX_DETRAS

const FILAS_HISTORIAL = 3

// ── Utilidades ────────────────────────────────────────────────────────────────

/** "atardecer_neon-2" → "Atardecer neon 2". El nombre de fichero es lo único que hay. */
function nombreBonito(path: string): string {
  const base = nombreDe(path).replace(/[_\-.]+/g, " ").replace(/\s+/g, " ").trim()
  return base ? base.charAt(0).toUpperCase() + base.slice(1) : "Fondo"
}

function etiqueta(texto: string, clases: string[], opciones: Partial<Gtk.Label.ConstructorProps> = {}): Gtk.Label {
  // Recortable por defecto: una etiqueta sin elipsis tiene de mínimo su texto
  // entero y es justo lo que empujaba el ancho de la franja.
  const l = new Gtk.Label({
    label: texto, cssClasses: clases, xalign: 0, ellipsize: Pango.EllipsizeMode.END, ...opciones,
  })
  return l
}

// Para rótulos cortos y fijos: Pango mide sin el `letter-spacing` del CSS, así que
// con elipsis se recortaban ("TEMA ACTUA…") aun cabiendo de sobra.
const SIN_RECORTE = { ellipsize: Pango.EllipsizeMode.NONE }

/** Próximo inicio de tramo del grupo tras `ahora` (con vuelta al día siguiente). */
function proximoTramo(grupo: Grupo, ahora: number): string | null {
  const inicios = [...new Set(grupo.tramos.map(t => t.start))]
    .map(s => ({ s, m: aMinutos(s) }))
    .filter((x): x is { s: string; m: number } => x.m !== null)
    .sort((a, b) => a.m - b.m)
  if (inicios.length < 2) return null
  return (inicios.find(x => x.m > ahora) ?? inicios[0]).s
}

// ── Tema actual ───────────────────────────────────────────────────────────────

function carta(path: string, clases: string[]): Gtk.Widget {
  const marco = new Gtk.Box({ cssClasses: ["fi-carta", ...clases] })
  marco.set_overflow(Gtk.Overflow.HIDDEN)
  marco.append(miniatura(path, CARTA_W, CARTA_H, "fi-carta-img"))
  // `set_size_request` es solo un MÍNIMO: la Gtk.Picture pide de natural el
  // tamaño de su textura (336 px) y Gtk.Fixed asigna a cada hijo su natural,
  // así que sin tope la pila robaba ancho a la columna de texto.
  // Sin recorte: las cartas de detrás van giradas y con sombra.
  return cajaFija(marco, CARTA_W + 2, CARTA_H + 2, false)
}

/** La pila y dónde ha quedado la carta de delante (para colgarle el botón aleatorio). */
function construirPila(delante: string, detras: string[], total: number): { pila: Gtk.Fixed; x: number; y: number } {
  const pila = new Gtk.Fixed({ cssClasses: ["fi-pila"], valign: Gtk.Align.CENTER })
  pila.set_size_request(PILA_W, PILA_H)

  if (detras.length === 0) {
    const x = PASO_X * MAX_DETRAS / 2, y = PASO_Y * MAX_DETRAS / 2
    pila.put(carta(delante, ["sola"]), x, y)
    return { pila, x, y }
  }

  // Gtk.Fixed pinta en orden de inserción: primero la más lejana.
  const capas = detras.slice(0, MAX_DETRAS)
  for (let i = capas.length; i >= 1; i--) {
    pila.put(carta(capas[i - 1], [`detras-${i}`]), PASO_X * i, PASO_Y * (MAX_DETRAS - i))
  }
  pila.put(carta(delante, ["delante"]), 0, PASO_Y * MAX_DETRAS)

  const insignia = new Gtk.Box({ cssClasses: ["fi-insignia"], spacing: 3 })
  insignia.append(new Gtk.Label({ label: "󰉏", cssClasses: ["fi-insignia-glifo"] }))
  insignia.append(new Gtk.Label({ label: String(total) }))
  pila.put(insignia, 5, PASO_Y * MAX_DETRAS + CARTA_H - 20)
  return { pila, x: 0, y: PASO_Y * MAX_DETRAS }
}

function TemaActual(): Gtk.Widget {
  const raiz = new Gtk.Box({ cssClasses: ["fi-tema"], spacing: 10, hexpand: true })
  raiz.set_cursor_from_name("pointer")
  raiz.set_tooltip_text("Abrir Temas")

  // Clic en la tarjeta = ir a Temas. El botón aleatorio de dentro es un
  // GtkButton y reclama su clic, así que no llega aquí.
  const clic = new Gtk.GestureClick({ button: 1 })
  clic.connect("released", () => setSection("rice"))
  raiz.add_controller(clic)

  function reconstruir() {
    vaciarCaja(raiz)
    const cfg = wallpapersConfig.get()
    const actual = currentWallpaper.get()
    const grupo = cfg.grupos.find(g => g.id === currentGroup.get()) ?? null
    const ahora = minutosDe(new Date())

    if (!actual) {
      const vacio = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, valign: Gtk.Align.CENTER, hexpand: true })
      vacio.append(etiqueta("TEMA ACTUAL", ["fi-eyebrow"], SIN_RECORTE))
      vacio.append(etiqueta("Sin fondo aplicado", ["fi-nombre"]))
      vacio.append(etiqueta("Elige uno en Temas", ["fi-meta"]))
      raiz.append(vacio)
      return
    }

    const variantes = grupo ? variantesDe(grupo) : []
    const detras = variantes.filter(p => p !== actual)
    const { pila, x, y } = construirPila(actual, grupo ? detras : [], Math.max(variantes.length, 1))
    raiz.append(pila)

    const texto = new Gtk.Box({
      orientation: Gtk.Orientation.VERTICAL, valign: Gtk.Align.CENTER, hexpand: true, spacing: 1,
    })
    const cabecera = new Gtk.Box({ spacing: 6 })
    cabecera.append(etiqueta("TEMA ACTUAL", ["fi-eyebrow"], SIN_RECORTE))
    if (grupo) cabecera.append(etiqueta("COLECCIÓN", ["fi-chip"], SIN_RECORTE))
    texto.append(cabecera)

    const nombre = grupo?.nombre || nombreBonito(actual)
    texto.append(etiqueta(nombre, ["fi-nombre"], {
      tooltipText: nombre,
    }))

    if (grupo) {
      texto.append(etiqueta(
        `${variantes.length} ${variantes.length === 1 ? "fondo" : "fondos"} · ${nombreBonito(actual)}`,
        ["fi-meta"],
      ))
      const vig = vigente(grupo.tramos, ahora)
      const prox = proximoTramo(grupo, ahora)
      if (vig && prox) texto.append(etiqueta(`${vig.start} → ${prox}`, ["fi-sub"], { tooltipText: `Variante desde las ${vig.start}; cambia a las ${prox}` }))
    } else {
      texto.append(etiqueta("Fondo suelto", ["fi-meta"]))
      const franja = franjaActual(cfg, ahora)
      if (franja) texto.append(etiqueta(`Franja: ${franja.nombre}`, ["fi-sub"]))
    }
    raiz.append(texto)

    // Sobre la esquina de la carta de delante: fuera de la columna de texto, que
    // es la que necesita el ancho.
    const aleatorio = new Gtk.Button({ cssClasses: ["fi-aleatorio"], tooltipText: "Fondo aleatorio" })
    aleatorio.set_child(new Gtk.Image({ iconName: "media-playlist-shuffle-symbolic", pixelSize: 11 }))
    aleatorio.connect("clicked", () => applyRandom())
    pila.put(aleatorio, x + CARTA_W - 24, y + 4)
  }

  return conReconstruccionPerezosa(raiz, reconstruir, [
    currentWallpaper, currentGroup, wallpapersConfig,
  ])
}

// ── Página del carrusel: Reciente ─────────────────────────────────────────────

function iconoDeApp(id: string, icono: string): Gtk.Image {
  let gicon: Gio.Icon | null = null
  try { gicon = GioUnix.DesktopAppInfo.new(id)?.get_icon() ?? null } catch (_) {}
  return crearIconoApp(gicon, icono, 18)
}

function filaHistorial(e: EntradaHistorial, ahora: number): Gtk.Widget {
  const boton = new Gtk.Button({ cssClasses: ["fh-fila"], hexpand: true })
  const fila = new Gtk.Box({ spacing: 8 })

  const icono = new Gtk.Box({ cssClasses: ["fh-icono"], valign: Gtk.Align.CENTER })
  icono.append(e.tipo === "app"
    ? iconoDeApp(e.id, e.icono)
    : new Gtk.Image({ iconName: "input-keyboard-symbolic", pixelSize: 14 }))
  fila.append(icono)

  const titulo = e.tipo === "app" ? e.nombre : (e.descripcion || e.binding)
  fila.append(etiqueta(titulo, ["fh-titulo"], {
    hexpand: true, ellipsize: Pango.EllipsizeMode.END, tooltipText: titulo,
  }))

  if (e.tipo === "atajo") {
    fila.append(etiqueta(e.binding, ["fh-tecla"], { ellipsize: Pango.EllipsizeMode.END, maxWidthChars: 14 }))
  } else if (e.accion === "fijada") {
    fila.append(etiqueta("󰐃 fijada", ["fh-accion", "fijada"]))
  } else {
    fila.append(etiqueta("abierta", ["fh-accion"]))
  }
  fila.append(etiqueta(tiempoRelativo(e.ts, ahora), ["fh-tiempo"], { xalign: 1 }))
  boton.set_child(fila)

  if (e.tipo === "atajo") {
    boton.set_tooltip_text(`Ver ${e.binding} en Atajos`)
    boton.connect("clicked", () => {
      setSection("keybinds")
      mostrarEnBusqueda(e.binding)
      // Diferido: reordenar el historial reconstruye esta misma fila, y no se
      // destruye un botón desde su propio "clicked".
      GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        registrarAtajo(e.binding, e.descripcion)
        return GLib.SOURCE_REMOVE
      })
    })
    return boton
  }

  // Misma convención que el resto de Orion: un clic abre la ficha, doble clic lanza.
  const identidad = { id: e.id, nombre: e.nombre, icono: e.icono }
  const lanzar = () => launchApp(e.exec, identidad)
  const estaSuprimido = activarDobleClic(boton, () => { lanzar(); hidePanel() })
  boton.connect("clicked", () => {
    if (estaSuprimido()) return
    let info: GioUnix.DesktopAppInfo | null = null
    try { info = GioUnix.DesktopAppInfo.new(e.id) } catch (_) {}
    showAppContext({
      id: e.id, name: e.nombre, iconName: e.icono || "application-x-executable",
      gicon: info?.get_icon() ?? null,
      execRaw: e.exec,
      execName: e.exec.split(" ")[0].split("/").pop() ?? e.exec,
      appId: e.id,
      desktopFile: info?.get_filename() ?? "",
      launch: lanzar,
    })
  })
  return boton
}

function PaginaReciente(): Gtk.Widget {
  const caja = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, cssClasses: ["fh-lista"], spacing: 2 })

  function reconstruir() {
    vaciarCaja(caja)
    const lista = historial.get().slice(0, FILAS_HISTORIAL)
    if (lista.length === 0) {
      const vacio = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL, cssClasses: ["fh-vacio"],
        valign: Gtk.Align.CENTER, vexpand: true, spacing: 2,
      })
      vacio.append(new Gtk.Label({ label: "󰋚", cssClasses: ["fh-vacio-glifo"] }))
      vacio.append(new Gtk.Label({
        label: "Lo que abras, fijes o busques en atajos aparecerá aquí",
        cssClasses: ["fh-vacio-texto"], wrap: true, justify: Gtk.Justification.CENTER,
        maxWidthChars: 30,
      }))
      caja.append(vacio)
      return
    }
    const ahora = Date.now()
    for (const e of lista) caja.append(filaHistorial(e, ahora))
  }

  return conReconstruccionPerezosa(caja, reconstruir, [historial])
}

// ── Página del carrusel: Notificaciones ──────────────────────────────────────
// Lo que ha llegado en los últimos 5 minutos de las apps elegidas en Ajustes >
// Orion (`orionNotisApps`, por defecto WhatsApp y Discord),
// sacado del mismo almacén que el panel de notificaciones. Los avisos del propio
// sistema (`source: "system"`, los de `hypr/scripts/`) se quedan fuera: no son
// "lo que te han escrito". Sin nada reciente la página no existe (ni punto).
//
// Caducar a los 5 min no necesita sondeo: un solo temporizador armado hasta que
// vence la más antigua, y solo con Orion abierto. Cerrado no corre nada; al
// abrir se recalcula.

const VENTANA_NOTIS_MS = 5 * 60 * 1000

function notisRecientes(): StoredNotification[] {
  const desde = Date.now() - VENTANA_NOTIS_MS
  // Solo las apps elegidas en Ajustes > Orion (subcadena del nombre, minúsculas).
  const apps = orionNotisApps.get()
  return notifications.get()
    .filter(n => n.source !== "system" && n.timestamp >= desde
      && apps.some(a => String(n.appName ?? "").toLowerCase().includes(a)))
    .sort((a, b) => b.timestamp - a.timestamp)
}

const [hayNotisRecientes, setHayNotisRecientes] = createState(false)
let caducidadNotis: number | null = null

function recalcularNotisRecientes() {
  if (caducidadNotis !== null) { GLib.source_remove(caducidadNotis); caducidadNotis = null }
  // Cerrado no se filtra nada: cada notificación que llegara recorrería el
  // almacén para una página que nadie ve. Al abrir se recalcula (este mismo
  // manejador va suscrito a `orionVisible`, antes que el carrusel).
  if (!orionVisible.get()) return
  const lista = notisRecientes()
  setHayNotisRecientes(lista.length > 0)
  if (lista.length === 0) return
  const vence = lista[lista.length - 1].timestamp + VENTANA_NOTIS_MS - Date.now()
  caducidadNotis = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.max(250, vence + 50), () => {
    caducidadNotis = null
    recalcularNotisRecientes()
    return GLib.SOURCE_REMOVE
  })
}
notifications.subscribe(recalcularNotisRecientes)
orionNotisApps.subscribe(recalcularNotisRecientes)
orionVisible.subscribe(recalcularNotisRecientes)

function abrirPanelNotificaciones() {
  hidePanel()
  closeAllPanels()
  openNotifPanel()
}

function filaNotificacion(n: StoredNotification, ahora: number): Gtk.Widget {
  const boton = new Gtk.Button({ cssClasses: ["fh-fila"], hexpand: true })
  const fila = new Gtk.Box({ spacing: 8 })
  const icono = new Gtk.Box({ cssClasses: ["fh-icono"], valign: Gtk.Align.CENTER })
  icono.append(new Gtk.Label({ label: getAppIcon(n.appName), cssClasses: ["fn-glifo"] }))
  fila.append(icono)
  fila.append(etiqueta(n.appName, ["fn-app"], SIN_RECORTE))
  const texto = n.summary || n.body
  fila.append(etiqueta(texto, ["fh-titulo", ...(n.read ? [] : ["fn-nueva"])], {
    hexpand: true, tooltipText: n.body ? `${n.summary}\n${n.body}` : n.summary,
  }))
  fila.append(etiqueta(tiempoRelativo(n.timestamp, ahora), ["fh-tiempo"], { xalign: 1 }))
  boton.set_child(fila)
  boton.connect("clicked", abrirPanelNotificaciones)
  return boton
}

function PaginaNotificaciones(): Gtk.Widget {
  const caja = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, cssClasses: ["fh-lista"], spacing: 2 })
  function reconstruir() {
    vaciarCaja(caja)
    const ahora = Date.now()
    for (const n of notisRecientes().slice(0, FILAS_HISTORIAL)) caja.append(filaNotificacion(n, ahora))
  }
  return conReconstruccionPerezosa(caja, reconstruir, [notifications, hayNotisRecientes, orionNotisApps])
}

// ── Página del carrusel: Abiertas ────────────────────────────────────────────
// Las ventanas abiertas AHORA, una fila por (escritorio, app): tres Firefox en el
// escritorio 2 son UNA fila, y un Firefox en el 2 y otro en el 5 son dos. Si la
// fila tiene una sola ventana, la fila entera es el botón; si agrupa varias, los
// botones son los iconos de la app, uno por ventana y a la izquierda. Lo que se abre es
// el menú lateral de siempre, con acciones de ventana (ver `RightPanel.tsx`).
//
// TODO(vista previa): al pasar el ratón por una fila o por el botón de una
// ventana se debería enseñar una miniatura de ESA ventana. Hoy Hyprland no nos
// da una captura por ventana que sirva aquí (y `grim` solo captura salidas
// enteras), así que queda pendiente para cuando lo permita. El sitio para
// engancharlo es `filaVentanas`: el hover de `principal` y de cada botón de ventana.
//
// Coste: las señales de Hyprland solo se escuchan con Orion ABIERTO (el
// controlador compartido de la barra, `suscribirDatosEscritorios`), y la lista
// solo se reconstruye si cambia de verdad (firma por escritorio, clase y
// direcciones): con `follow_mouse`, cruzar el ratón entre ventanas avisa sin que
// haya nada nuevo que pintar.

interface GrupoVentanas {
  clave: string
  escritorioId: number
  escritorio: string
  nombre: string
  ventanas: { cliente: any; icono: IconoClienteEscritorio }[]
}

const [gruposVentanas, setGruposVentanas] = createState<GrupoVentanas[]>([])
const [hayVentanas, setHayVentanas] = createState(false)
let firmaVentanas = ""

function etiquetaEscritorioDe(ws: any): string {
  const id = Number(ws?.id ?? 0)
  if (id > 0) return String(id)
  return String(ws?.name ?? "").replace(/^special:/, "") || "especial"
}

function calcularGruposVentanas() {
  const clientes = filtrarVentanasDeUsuario(hypr.get_clients() as any[]).filter((c: any) => !!c.class)
  const iconos = obtenerIconosClientesEscritorio(clientes as any)
  const porDireccion = new Map(iconos.map(i => [i.direccion, i]))
  const grupos = new Map<string, GrupoVentanas>()
  for (const c of clientes) {
    const ws = c.workspace
    const icono = porDireccion.get(c.address)
    if (!icono) continue
    const clave = `${ws?.id ?? 0}|${String(c.class).toLowerCase()}`
    let g = grupos.get(clave)
    if (!g) {
      g = {
        clave, escritorioId: Number(ws?.id ?? 0), escritorio: etiquetaEscritorioDe(ws),
        nombre: obtenerEntradaEscritorio(c)?.nombre || String(c.class),
        ventanas: [],
      }
      grupos.set(clave, g)
    }
    g.ventanas.push({ cliente: c, icono })
  }
  // El escritorio en el que estás primero; luego por número (especiales al final).
  const aqui = Number(hypr.get_focused_workspace?.()?.id ?? 0)
  const orden = (id: number) => id === aqui ? -1 : id > 0 ? id : 1000 - id
  const lista = [...grupos.values()].sort((a, b) =>
    orden(a.escritorioId) - orden(b.escritorioId) || a.nombre.localeCompare(b.nombre))
  const firma = `${aqui}#` + lista.map(g => `${g.clave}:${g.ventanas.map(v => v.cliente.address).join(",")}`).join(";")
  setHayVentanas(lista.length > 0)
  if (firma === firmaVentanas) return
  firmaVentanas = firma
  setGruposVentanas(lista)
}

let bajaEscritorios: (() => void) | null = null
orionVisible.subscribe(() => {
  if (orionVisible.get()) {
    if (!bajaEscritorios) bajaEscritorios = suscribirDatosEscritorios(calcularGruposVentanas)
  } else if (bajaEscritorios) {
    bajaEscritorios()
    bajaEscritorios = null
  }
})

function iconoVentana(icono: IconoClienteEscritorio, tam: number): Gtk.Widget {
  if (icono.esGlifo) return new Gtk.Label({ label: icono.icono, cssClasses: ["fa-glifo"] })
  return crearIconoApp(icono.iconoGio, icono.icono, tam)
}

function abrirFichaVentana(g: GrupoVentanas, v: GrupoVentanas["ventanas"][number]) {
  showAppContext({
    id: `ventana:${v.cliente.address}`,
    name: g.nombre,
    iconName: v.icono.esGlifo ? "application-x-executable" : v.icono.icono,
    gicon: v.icono.iconoGio,
    execRaw: "", execName: String(v.cliente.class ?? ""), appId: `ventana:${v.cliente.address}`,
    launch: () => {},
    ventana: {
      direccion: String(v.cliente.address),
      // El título se lee al abrir la ficha, no al construir la fila: cambia sin
      // parar (pestañas, pistas) y no forma parte de la firma de la lista.
      titulo: String(v.cliente.title ?? ""),
      escritorio: g.escritorio,
    },
  })
}

function filaVentanas(g: GrupoVentanas): Gtk.Widget {
  const info = () => {
    const caja = new Gtk.Box({ spacing: 8, hexpand: true })
    caja.append(etiqueta(g.nombre, ["fh-titulo"], { hexpand: true }))
    caja.append(etiqueta(`workspace ${g.escritorio}`, ["fa-escritorio"], { ...SIN_RECORTE, xalign: 1 }))
    return caja
  }

  // UNA ventana: la fila entera es el botón (icono + nombre + escritorio).
  if (g.ventanas.length === 1) {
    const v = g.ventanas[0]
    const boton = new Gtk.Button({ cssClasses: ["fh-fila"], hexpand: true })
    const cuerpo = new Gtk.Box({ spacing: 8 })
    const icono = new Gtk.Box({ cssClasses: ["fh-icono"], valign: Gtk.Align.CENTER })
    icono.append(iconoVentana(v.icono, 18))
    cuerpo.append(icono)
    cuerpo.append(info())
    boton.set_child(cuerpo)
    boton.set_tooltip_text(String(v.cliente.title || g.nombre))
    boton.connect("clicked", () => abrirFichaVentana(g, v))
    return boton
  }

  // VARIAS: los botones son los iconos, uno por ventana y a la izquierda; el
  // nombre y el escritorio son solo rótulo. (Nada de botones dentro de un botón:
  // el clic llegaría a los dos, como pasó con las flechas de "Sonando".)
  const fila = new Gtk.Box({ cssClasses: ["fa-fila-varias"], spacing: 6, hexpand: true })
  const botones = new Gtk.Box({ cssClasses: ["fa-ventanas"], spacing: 2, valign: Gtk.Align.CENTER })
  for (const v of g.ventanas) {
    const b = new Gtk.Button({ cssClasses: ["fa-ventana"], valign: Gtk.Align.CENTER })
    b.set_child(iconoVentana(v.icono, 16))
    b.set_tooltip_text(String(v.cliente.title || g.nombre))
    b.connect("clicked", () => abrirFichaVentana(g, v))
    botones.append(b)
  }
  fila.append(botones)
  fila.append(info())
  return fila
}

function PaginaAbiertas(): Gtk.Widget {
  const lista = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, cssClasses: ["fh-lista"], spacing: 2 })
  // Desplazable, pero la rueda NO se la queda en los bordes: con la barra en modo
  // EXTERNAL el ScrolledWindow no atiende la rueda él mismo, y este controlador
  // solo la consume mientras la lista puede moverse en ese sentido. Arriba del
  // todo o abajo del todo la deja pasar al carrusel, que cambia de página: así la
  // rueda sigue sirviendo para navegar entre páginas también aquí.
  const desplazable = new Gtk.ScrolledWindow({ vexpand: true, hexpand: true })
  desplazable.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.EXTERNAL)
  desplazable.set_propagate_natural_height(false)
  desplazable.set_child(lista)
  const rueda = new Gtk.EventControllerScroll({ flags: Gtk.EventControllerScrollFlags.VERTICAL })
  rueda.connect("scroll", (_c, _dx, dy) => {
    const adj = desplazable.get_vadjustment()
    const max = adj.get_upper() - adj.get_page_size()
    if (dy === 0 || max <= 0) return false
    const valor = adj.get_value()
    if ((dy > 0 && valor >= max - 0.5) || (dy < 0 && valor <= 0.5)) return false
    adj.set_value(Math.max(0, Math.min(max, valor + dy * 26)))
    return true
  })
  desplazable.add_controller(rueda)

  function reconstruir() {
    vaciarCaja(lista)
    for (const g of gruposVentanas.get()) lista.append(filaVentanas(g))
  }
  conReconstruccionPerezosa(lista, reconstruir, [gruposVentanas])
  return desplazable
}

// ── Tarjeta: Jugando ahora ────────────────────────────────────────────────────
// Sale del registro de juegos del shell (el mismo de la pastilla de la barra), sin
// sondeo propio: el registro ya lo arranca `gamingState` a los 4 s, y aquí no se
// llama a `iniciarRegistroJuegos()` a propósito — forzarlo desde la franja metería
// el parseo de los `.desktop` en la construcción de Orion. Con "Detectar juegos"
// apagado la lista está siempre vacía y la tarjeta, oculta.

function leerTexto(ruta: string): string | null {
  try {
    const [ok, contenido] = GLib.file_get_contents(ruta)
    return ok ? new TextDecoder().decode(contenido) : null
  } catch (_) { return null }
}

/** Cuánto lleva abierto el juego: la edad de SU proceso, no desde que AGS lo vio. */
function tiempoDeJuego(pid: number | null | undefined): string | null {
  if (!pid || pid <= 0) return null
  const uptime = Number.parseFloat(leerTexto("/proc/uptime")?.split(" ")[0] ?? "")
  const ms = msVivo(extraerInicioProceso(leerTexto(`/proc/${pid}/stat`)), Number.isFinite(uptime) ? uptime : null)
  return ms === null ? null : duracionSesion(ms)
}

function enfocarVentana(direccion: string, ocultarOrion = true) {
  const dir = direccion.startsWith("0x") ? direccion : `0x${direccion}`
  if (ocultarOrion) hidePanel()
  execAsync(["hyprctl", "dispatch", `hl.dsp.focus({window='address:${dir}'})`]).catch(() => {})
}

function TarjetaJugando(): Gtk.Widget {
  const tarjeta = new Gtk.Button({ cssClasses: ["fx-tarjeta", "fj-tarjeta"], hexpand: true })

  function reconstruir() {
    tarjeta.set_child(null)
    const lista = clientesJuego.get()
    if (lista.length === 0) return
    const foco = clienteJuegoEnFoco.get()
    // Se enseña el que tiene el foco; si ninguno, el primero. El resto, contado.
    const cliente = lista.find(c => foco && normalizarDireccion(c.address) === foco) ?? lista[0]
    const enFoco = !!foco && normalizarDireccion(cliente.address) === foco
    const apariencia = describirJuego(cliente)
    tarjeta.set_tooltip_text(`Ir a ${apariencia.nombre}`)

    const fila = new Gtk.Box({ spacing: 10 })
    const icono = new Gtk.Box({ cssClasses: ["fj-icono"], valign: Gtk.Align.CENTER })
    if (apariencia.icono) {
      const img = Gtk.Image.new_from_gicon(apariencia.icono)
      img.pixel_size = 32
      icono.append(img)
    } else if (apariencia.nombreIcono) {
      icono.append(new Gtk.Image({ iconName: apariencia.nombreIcono, pixelSize: 32 }))
    } else {
      icono.append(new Gtk.Label({ label: GLIFO_JUEGO, cssClasses: ["fj-glifo"] }))
    }
    fila.append(icono)

    const texto = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, valign: Gtk.Align.CENTER, hexpand: true })
    const cabecera = new Gtk.Box({ spacing: 6 })
    cabecera.append(etiqueta("JUGANDO AHORA", ["fi-eyebrow"], SIN_RECORTE))
    if (enFoco) cabecera.append(etiqueta("EN FOCO", ["fi-chip"], { ...SIN_RECORTE, valign: Gtk.Align.CENTER }))
    texto.append(cabecera)
    texto.append(etiqueta(apariencia.nombre, ["fj-nombre"], { tooltipText: apariencia.nombre }))
    const partes: string[] = []
    const ws = cliente.workspace?.id
    if (typeof ws === "number" && ws > 0) partes.push(`Escritorio ${ws}`)
    const tiempo = tiempoDeJuego(cliente.pid)
    if (tiempo) partes.push(tiempo === "ahora" ? "recién abierto" : tiempo)
    if (partes.length) texto.append(etiqueta(partes.join(" · "), ["fj-meta"]))
    fila.append(texto)

    if (lista.length > 1) fila.append(etiqueta(`+${lista.length - 1}`, ["fj-mas"], { ...SIN_RECORTE, valign: Gtk.Align.CENTER, tooltipText: lista.slice(1).map(c => describirJuego(c).nombre).join("\n") }))
    fila.append(new Gtk.Image({ iconName: "go-next-symbolic", pixelSize: 12, cssClasses: ["fj-ir"] }))
    tarjeta.set_child(fila)
    direccionActual = String(cliente.address ?? "")
  }

  let direccionActual = ""
  tarjeta.connect("clicked", () => { if (direccionActual) enfocarVentana(direccionActual) })
  return conReconstruccionPerezosa(tarjeta, reconstruir, [clientesJuego, clienteJuegoEnFoco])
}

// ── Tarjeta: Sonando ──────────────────────────────────────────────────────────
// Del servicio MPRIS compartido (el mismo de Quick Settings y la barra): cero
// sondeo propio y un solo registro de señales para todo el shell.
//
// Con varios reproductores es un CARRUSEL como el de Quick Settings: ‹ 1/N › en
// la cabecera, rueda del ratón encima de la tarjeta y el mismo deslizamiento de
// salida/entrada. Al abrir Orion se entra por el que está SONANDO; si ninguno
// suena, por el primero con pista (en pausa). La selección se guarda por
// `bus_name`, no por índice: si un reproductor aparece o se va mientras miras
// otro, sigues viendo el mismo.

function reproductoresConPista(): { r: any; e: EstadoReproductor }[] {
  return reproductoresMultimedia.get()
    .map(r => ({ r, e: obtenerEstadoReproductor(r) }))
    .filter((x): x is { r: any; e: EstadoReproductor } => !!x.e)
}

function botonControl(icono: string, tooltip: string, activo: boolean, alPulsar: () => void, clases: string[] = []): Gtk.Button {
  const b = new Gtk.Button({ cssClasses: ["fs-control", ...clases], tooltipText: tooltip, valign: Gtk.Align.CENTER })
  b.set_child(new Gtk.Image({ iconName: icono, pixelSize: clases.includes("principal") ? 14 : 12 }))
  b.set_sensitive(activo)
  b.connect("clicked", alPulsar)
  return b
}

function TarjetaSonando(): Gtk.Widget {
  const tarjeta = new Gtk.Box({ cssClasses: ["fx-tarjeta", "fs-tarjeta"], hexpand: true })
  tarjeta.set_overflow(Gtk.Overflow.HIDDEN)
  // Lo que se desliza al cambiar de reproductor; el marco de la tarjeta se queda.
  const caja = new Gtk.Box({ cssClasses: ["fs-contenido"], spacing: 8, hexpand: true })
  tarjeta.append(caja)

  let seleccion: string | null = null
  let cambiando = false

  /** El reproductor elegido, o el principal si el elegido ya no está. */
  function actual() {
    const con = reproductoresConPista()
    const i = seleccion ? con.findIndex(x => x.r.bus_name === seleccion) : -1
    if (i >= 0) return { ...con[i], indice: i, total: con.length }
    const p = con.find(x => x.e.reproduciendo) ?? con[0]
    if (!p) return null
    seleccion = p.r.bus_name
    return { ...p, indice: con.indexOf(p), total: con.length }
  }

  function paso(delta: 1 | -1) {
    const con = reproductoresConPista()
    if (con.length < 2 || cambiando) return
    const destino = () => {
      const lista = reproductoresConPista()
      if (lista.length < 2) return
      const i = Math.max(0, lista.findIndex(x => x.r.bus_name === seleccion))
      seleccion = lista[(i + delta + lista.length) % lista.length].r.bus_name
      reconstruir()
    }
    // Mismo deslizamiento que Quick Settings: sale hacia un lado, el nuevo entra
    // desde el opuesto (colocado sin transición y soltado un frame después).
    cambiando = true
    const dir = delta > 0 ? "next" : "prev"
    caja.add_css_class(`switch-out-${dir}`)
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 110, () => {
      destino()
      caja.remove_css_class(`switch-out-${dir}`)
      caja.add_css_class(`switch-enter-${dir}`)
      GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {
        caja.remove_css_class(`switch-enter-${dir}`)
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 130, () => { cambiando = false; return GLib.SOURCE_REMOVE })
        return GLib.SOURCE_REMOVE
      })
      return GLib.SOURCE_REMOVE
    })
  }

  const rueda = new Gtk.EventControllerScroll({
    flags: Gtk.EventControllerScrollFlags.BOTH_AXES | Gtk.EventControllerScrollFlags.DISCRETE,
  })
  rueda.connect("scroll", (_c, dx, dy) => {
    const d = Math.abs(dx) > Math.abs(dy) ? dx : dy
    if (d === 0 || reproductoresConPista().length < 2) return false
    paso(d > 0 ? 1 : -1)
    return true
  })
  tarjeta.add_controller(rueda)

  // Cada apertura de Orion vuelve a entrar por el que suena (se registra antes
  // que la reconstrucción perezosa, así esta ya ve la selección limpia).
  orionVisible.subscribe(() => { if (orionVisible.get()) seleccion = null })

  // ── Barra de progreso ──
  // DOBLE barra, partida en la posición por un hueco: la izquierda (lo que ya ha
  // sonado) lleva el acento de la carátula con la MISMA regla que el seekbar de
  // Quick Settings (`tonosDeAcento(...).acento`), y la derecha (lo que queda) un
  // color fijo sacado del CSS (`.fs-progreso { color }`), que va con el fondo de
  // Orion y no cambia con la pista. Es un único DrawingArea que sobrevive a las
  // reconstrucciones: el sondeo de 1 s solo lo repinta, no rehace la tarjeta.
  const ALTO_BARRA = 3
  const HUECO = 3
  const progreso = new Gtk.DrawingArea({ cssClasses: ["fs-progreso"], hexpand: true, canTarget: false })
  progreso.set_content_height(ALTO_BARRA)
  // Tiempos a los lados: lo que lleva y lo que QUEDA (con signo menos, como en un
  // reproductor); la duración total va en el tooltip de la fila. Ancho fijo en
  // caracteres para que la barra no baile al pasar de 9:59 a 10:00.
  const lblLleva = new Gtk.Label({ cssClasses: ["fs-tiempo"], xalign: 0, widthChars: 5 })
  const lblQueda = new Gtk.Label({ cssClasses: ["fs-tiempo"], xalign: 1, widthChars: 6 })
  const filaProgreso = new Gtk.Box({ cssClasses: ["fs-fila-progreso"], spacing: 5 })
  filaProgreso.append(lblLleva)
  filaProgreso.append(progreso)
  filaProgreso.append(lblQueda)
  let prJugador: any = null
  let prDuracion: number | null = null
  let prSemilla = ACENTO_MEDIA_PREDETERMINADO

  function duracionDe(r: any): number | null {
    let cruda: unknown = null
    try { cruda = r.get_meta?.("mpris:length")?.deep_unpack?.() } catch (_) {}
    return resolveMediaLengthSeconds(r.length, cruda)
  }

  progreso.set_draw_func((_a, cr, ancho, alto) => {
    if (!prJugador || !prDuracion || mostrada === null) return
    const fraccion = mostrada
    const y = (alto - ALTO_BARRA) / 2
    const radio = ALTO_BARRA / 2
    const tramo = (x: number, w: number) => {
      if (w <= 0) return
      const rr = Math.min(radio, w / 2)
      cr.newPath()
      cr.arc(x + w - rr, y + rr, rr, -Math.PI / 2, 0)
      cr.arc(x + w - rr, y + ALTO_BARRA - rr, rr, 0, Math.PI / 2)
      cr.arc(x + rr, y + ALTO_BARRA - rr, rr, Math.PI / 2, Math.PI)
      cr.arc(x + rr, y + rr, rr, Math.PI, 1.5 * Math.PI)
      cr.closePath()
      cr.fill()
    }
    // El hueco solo existe entre dos tramos: en 0 % y en 100 % la barra es entera.
    const corte = ancho * fraccion
    const finIzq = fraccion >= 1 ? ancho : Math.max(0, corte - HUECO / 2)
    const iniDer = fraccion <= 0 ? 0 : Math.min(ancho, corte + HUECO / 2)

    const [r, g, b] = tonosDeAcento(prSemilla).acento
    cr.setSourceRGBA(r / 255, g / 255, b / 255, 1)
    tramo(0, finIzq)

    const c = progreso.get_color()
    cr.setSourceRGBA(c.red, c.green, c.blue, c.alpha)
    tramo(iniDer, ancho - iniDer)
  })

  // El corte entre los dos tramos no salta: se DESLIZA hasta la posición nueva
  // (ease-out). Cubre una búsqueda, el cambio de pista (vuelve hacia el
  // principio) y el de reproductor.
  //
  // **Va a 30 fps con un temporizador propio, NO con el reloj de frames.** Un
  // tick callback corre a la frecuencia del monitor: a 240 Hz, animar 450 ms en
  // cada segundo de reproducción eran ~108 redibujados por segundo mientras
  // sonaba algo, y el coste crecía con los Hz de la pantalla. Con el temporizador
  // la ventana solo se redibuja cuando se pide (30 veces por segundo como mucho,
  // tenga el monitor los Hz que tenga).
  //
  // Y el avance normal de cada segundo NO se anima: en una pista de 3 min la
  // barra avanza menos de un píxel por segundo, así que animarlo sería gastar
  // redibujados en algo invisible. Solo se anima un salto de más de ~2 px.
  const DURACION_ANIM_US = 450_000
  const FPS_ANIM = 30
  const SALTO_MIN_PX = 2
  let mostrada: number | null = null
  let animDesde = 0
  let animHasta = 0
  let animInicioUs = 0
  let tickAnim: number | null = null

  function pararAnimacion() {
    if (tickAnim !== null) { GLib.source_remove(tickAnim); tickAnim = null }
  }

  function irA(fraccion: number) {
    const ancho = progreso.get_width()
    const salto = mostrada === null ? Infinity : Math.abs(fraccion - mostrada) * ancho
    if (mostrada === null || !progreso.get_mapped() || salto < SALTO_MIN_PX) {
      // Primera vez, sin pintar, o un avance que no llega a verse animado.
      pararAnimacion()
      mostrada = fraccion
      progreso.queue_draw()
      return
    }
    animDesde = mostrada
    animHasta = fraccion
    animInicioUs = GLib.get_monotonic_time()
    if (tickAnim !== null) return
    tickAnim = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.round(1000 / FPS_ANIM), () => {
      const t = Math.min(1, (GLib.get_monotonic_time() - animInicioUs) / DURACION_ANIM_US)
      const suave = 1 - Math.pow(1 - t, 3)
      mostrada = animDesde + (animHasta - animDesde) * suave
      progreso.queue_draw()
      if (t < 1) return GLib.SOURCE_CONTINUE
      tickAnim = null
      return GLib.SOURCE_REMOVE
    })
  }

  function actualizarTiempo() {
    if (!prJugador || !prDuracion) return
    const pos = safeMediaPosition(prJugador.position, prDuracion)
    lblLleva.label = formatMediaTime(pos)
    lblQueda.label = `-${formatMediaTime(prDuracion - pos)}`
    irA(pos / prDuracion)
  }

  // Posición (MPRIS no notifica el avance): con el tic COMPARTIDO de Inicio
  // (`data/ticInicio.ts`), el mismo de las métricas. Solo late con Orion abierto
  // y en Inicio, así que cerrado no hay nada que quitar aquí.
  ticInicio.subscribe(actualizarTiempo)
  // Al reabrir Orion la barra aparece ya en su sitio: animar desde donde se quedó
  // al cerrar (quizá minutos atrás) sería un barrido sin significado.
  orionVisible.subscribe(() => { if (!orionVisible.get()) { pararAnimacion(); mostrada = null } })

  // ── Volumen de la app ──
  // El mismo volumen por app que la "mezcla de aplicaciones" de Quick Settings,
  // pero solo el de ESTE reproductor, debajo de sus controles. Los streams de la
  // app se buscan en AstalWp (`streamDeReproductor.ts`); si hay varios (un
  // navegador con dos pestañas sonando) el deslizador los mueve todos. Sin stream
  // (la app aún no ha abierto audio, o suena en otro equipo) la fila no aparece.
  // Es un widget PERSISTENTE, como la barra: los streams van y vienen sin rehacer
  // la tarjeta, y no se destruye un deslizador mientras se arrastra.
  let audioWp: AstalWp.Audio | null = null
  try { audioWp = AstalWp.get_default()?.audio ?? null } catch (_) {}
  const volumen = new Gtk.Scale({
    orientation: Gtk.Orientation.HORIZONTAL, cssClasses: ["fs-volumen"], hexpand: true,
    drawValue: false, valign: Gtk.Align.CENTER,
  })
  volumen.set_range(0, VOLUMEN_MAX)
  volumen.set_increments(0.05, 0.1)
  const iconoVolumen = new Gtk.Label({ cssClasses: ["fs-volumen-icono"] })
  const filaVolumen = new Gtk.Box({ cssClasses: ["fs-fila-volumen"], spacing: 4, visible: false })
  filaVolumen.append(iconoVolumen)
  filaVolumen.append(volumen)

  let streamsApp: any[] = []
  let manejadorVol: { s: any; id: number } | null = null
  let sincronizandoVol = false
  let ultimaEscrituraVol = 0

  function pintarVolumen(v: number) {
    iconoVolumen.label = v <= 0.001 ? "󰝟" : v < 0.5 ? "󰖀" : "󰕾"
    filaVolumen.set_tooltip_text(`Volumen de la app · ${Math.round(v * 100)} %`)
    if (Math.abs(volumen.get_value() - v) < 0.005) return
    sincronizandoVol = true
    volumen.set_value(v)
    sincronizandoVol = false
  }

  function soltarVolumen() {
    if (manejadorVol) { try { manejadorVol.s.disconnect(manejadorVol.id) } catch (_) {} manejadorVol = null }
  }

  function enlazarVolumen() {
    soltarVolumen()
    // Cerrado no se enlaza nada: ni se recorren los streams ni se escucha el
    // volumen de la app (que cambia cada vez que alguien lo toca, en cualquier
    // sitio). `reconstruir` vuelve a enlazar al abrir.
    if (!orionVisible.get()) { streamsApp = []; return }
    const r = prJugador
    streamsApp = r && audioWp
      ? (audioWp.get_streams() ?? []).filter((s: any) => streamEsDeReproductor(propsDeStream(s), {
        entry: r.entry, busName: r.bus_name, identity: r.identity,
      }))
      : []
    filaVolumen.visible = streamsApp.length > 0
    if (streamsApp.length === 0) return
    const principal = streamsApp[0]
    pintarVolumen(principal.volume)
    // Cambios hechos desde fuera (la propia app, Quick Settings, pavucontrol). La
    // guarda de 300 ms es contra nuestro propio eco, como en Quick Settings.
    manejadorVol = {
      s: principal,
      id: principal.connect("notify::volume", () => {
        if (Date.now() - ultimaEscrituraVol < 300) return
        pintarVolumen(principal.volume)
      }),
    }
  }

  volumen.connect("value-changed", () => {
    if (sincronizandoVol || streamsApp.length === 0) return
    const v = ajustarVolumen(volumen.get_value())
    ultimaEscrituraVol = Date.now()
    for (const s of streamsApp) fijarVolumenEndpoint(s, v)
    pintarVolumen(v)
    // Igual que el deslizador de Quick Settings: tocarlo es una decisión explícita
    // y deja preset, que es lo que hace que la app vuelva a sonar así mañana.
    const clave = clavePreset("speaker", nombreDeProps(propsDeStream(streamsApp[0])))
    const presets = { ...audioPresets.get(), [clave]: v }
    setAudioPresets(presets)
    guardarAudioPresets(presets)
  })

  // Altas y bajas de streams: solo mientras Orion está abierto. Las señales se
  // conectan al abrir y se sueltan al cerrar, junto con la del volumen.
  let senalesStreams: number[] = []
  orionVisible.subscribe(() => {
    if (!audioWp) return
    if (orionVisible.get()) {
      if (senalesStreams.length === 0) {
        senalesStreams = [
          audioWp.connect("stream-added", () => enlazarVolumen()),
          audioWp.connect("stream-removed", () => enlazarVolumen()),
        ]
      }
    } else {
      for (const id of senalesStreams) { try { audioWp.disconnect(id) } catch (_) {} }
      senalesStreams = []
      soltarVolumen()
      streamsApp = []
    }
  })

  function reconstruir() {
    vaciarCaja(caja)
    ;(filaProgreso.get_parent() as Gtk.Box | null)?.remove(filaProgreso)
    ;(filaVolumen.get_parent() as Gtk.Box | null)?.remove(filaVolumen)
    const sel = actual()
    prJugador = sel?.r ?? null
    prDuracion = sel ? duracionDe(sel.r) : null
    enlazarVolumen()
    if (!sel) return
    const { r, e, indice, total } = sel
    const rutaCaratula = e.caratula ? e.caratula.replace(/^file:\/\//, "") : ""
    prSemilla = rutaCaratula && !rutaCaratula.startsWith("http") && GLib.file_test(rutaCaratula, GLib.FileTest.EXISTS)
      ? semillaDeCaratula(rutaCaratula)
      : ACENTO_MEDIA_PREDETERMINADO

    // Carátula + textos son UN botón: llevan a la app (si el reproductor se deja).
    const abrir = new Gtk.Button({ cssClasses: ["fs-abrir"], hexpand: true })
    const cuerpo = new Gtk.Box({ spacing: 10 })
    const portada = new Gtk.Box({ cssClasses: ["fs-portada"], valign: Gtk.Align.CENTER })
    portada.set_overflow(Gtk.Overflow.HIDDEN)
    portada.set_size_request(44, 44)
    if (e.caratula && GLib.file_test(e.caratula.replace(/^file:\/\//, ""), GLib.FileTest.EXISTS)) {
      const pic = Gtk.Picture.new_for_filename(e.caratula.replace(/^file:\/\//, ""))
      pic.content_fit = Gtk.ContentFit.COVER
      pic.set_size_request(44, 44)
      portada.append(cajaFija(pic, 44, 44))
    } else {
      portada.append(new Gtk.Label({ label: "󰎆", cssClasses: ["fs-portada-glifo"], hexpand: true }))
    }
    cuerpo.append(portada)

    const texto = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, valign: Gtk.Align.CENTER, hexpand: true })
    const origen = String(r.identity || "")
    const cabecera = new Gtk.Box({ spacing: 6 })
    cabecera.append(etiqueta(e.reproduciendo ? "SONANDO" : "EN PAUSA", ["fi-eyebrow", ...(e.reproduciendo ? ["sonando"] : [])], SIN_RECORTE))
    if (origen) cabecera.append(etiqueta(origen, ["fs-origen"]))
    texto.append(cabecera)
    texto.append(etiqueta(e.titulo, ["fs-titulo"], { tooltipText: e.titulo }))
    if (e.artista) texto.append(etiqueta(e.artista, ["fs-artista"]))
    // Un directo (o un reproductor sin duración) no tiene progreso que enseñar.
    if (prDuracion) {
      filaProgreso.set_tooltip_text(`Duración ${formatMediaTime(prDuracion)}`)
      texto.append(filaProgreso)
      actualizarTiempo()
    }
    cuerpo.append(texto)
    abrir.set_child(cuerpo)
    // Como el clic derecho del reproductor de Quick Settings: lleva a la VENTANA
    // que reproduce (escritorio incluido). `raise()` de MPRIS queda de reserva
    // para un reproductor sin ventana localizable. Orion NO se oculta: se va a
    // la app sin perder el lanzador (a diferencia de "Jugando ahora").
    const cliente = () => findMediaClient(r, hypr.get_clients?.() ?? [])
    const puedeAbrir = !!cliente()?.address || !!r.can_raise
    abrir.set_tooltip_text(puedeAbrir ? `Ir a ${origen || "reproductor"}` : null)
    abrir.connect("clicked", () => {
      const c = cliente()
      if (c?.address) { enfocarVentana(String(c.address), false); return }
      if (!r.can_raise) return
      try { r.raise() } catch (_) {}
    })
    caja.append(abrir)

    // La navegación va FUERA de `abrir`: dentro de ese botón, pulsar una flecha
    // también lo activaba a él, que cierra Orion y levanta el reproductor.
    const derecha = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, valign: Gtk.Align.CENTER })
    if (total > 1) {
      const nav = new Gtk.Box({ cssClasses: ["fs-nav"], halign: Gtk.Align.CENTER })
      const flecha = (glifo: string, tooltip: string, delta: 1 | -1) => {
        const b = new Gtk.Button({ cssClasses: ["fs-cambiar"], tooltipText: tooltip })
        b.set_child(new Gtk.Label({ label: glifo }))
        b.connect("clicked", () => paso(delta))
        return b
      }
      nav.append(flecha("󰅁", "Reproductor anterior", -1))
      nav.append(etiqueta(`${indice + 1}/${total}`, ["fs-cuenta"], SIN_RECORTE))
      nav.append(flecha("󰅂", "Reproductor siguiente", 1))
      derecha.append(nav)
    }

    const controles = new Gtk.Box({ spacing: 2, valign: Gtk.Align.CENTER })
    controles.append(botonControl("media-skip-backward-symbolic", "Anterior", !!r.can_go_previous, () => { try { r.previous() } catch (_) {} }))
    controles.append(botonControl(
      e.reproduciendo ? "media-playback-pause-symbolic" : "media-playback-start-symbolic",
      e.reproduciendo ? "Pausa" : "Reproducir", !!r.can_control,
      () => { try { r.play_pause() } catch (_) {} }, ["principal"],
    ))
    controles.append(botonControl("media-skip-forward-symbolic", "Siguiente", !!r.can_go_next, () => { try { r.next() } catch (_) {} }))
    derecha.append(controles)
    derecha.append(filaVolumen)
    caja.append(derecha)
  }

  // `revisionMultimedia` sube en cada cambio de un reproductor (pista, estado,
  // carátula resuelta) salvo la posición, que es lo único que cambia por segundo.
  return conReconstruccionPerezosa(tarjeta, reconstruir, [reproductoresMultimedia, revisionMultimedia])
}

// ── Carrusel ──────────────────────────────────────────────────────────────────
// Cada página declara su título, una acción de cabecera opcional y, si solo tiene
// sentido a ratos, `hayContenido`. Las páginas sin contenido NO se enseñan (ni
// punto ni hueco): un carrusel que se detiene en una página vacía es ruido.
//
// El ORDEN es la prioridad: al abrir Orion se va a la primera página con
// contenido. Por eso "Jugando ahora" va delante — con un juego abierto es lo que
// manda; sin juegos desaparece y queda "Reciente" como única página, sin puntos.

interface PaginaCarrusel {
  id: string
  titulo: string
  widget: Gtk.Widget
  accion?: { icono: string; tooltip: string; alPulsar: () => void }
  hayContenido?: { get: () => boolean } & Suscribible
  /**
   * Si puede ser la página de ENTRADA (por defecto, sí). Distinto de tener
   * contenido: un reproductor en pausa se sigue enseñando, pero no merece
   * recibirte al abrir Orion — y ocultarlo al pausar lo haría desaparecer justo
   * mientras lo miras.
   */
  prioritaria?: { get: () => boolean } & Suscribible
}

function Carrusel(paginas: PaginaCarrusel[]): Gtk.Widget {
  const raiz = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, cssClasses: ["fc-carrusel"], hexpand: true })

  const cabecera = new Gtk.Box({ cssClasses: ["fc-cabecera"], spacing: 6 })
  const titulo = etiqueta("", ["fi-eyebrow"], { hexpand: true, ...SIN_RECORTE })
  const puntos = new Gtk.Box({ cssClasses: ["fc-puntos"], spacing: 4, valign: Gtk.Align.CENTER })
  const accion = new Gtk.Button({ cssClasses: ["fc-accion"], valign: Gtk.Align.CENTER })
  const iconoAccion = new Gtk.Image({ pixelSize: 11 })
  accion.set_child(iconoAccion)
  cabecera.append(titulo)
  cabecera.append(puntos)
  cabecera.append(accion)
  raiz.append(cabecera)

  const pila = new Gtk.Stack({ vexpand: true })
  pila.set_transition_type(Gtk.StackTransitionType.SLIDE_LEFT_RIGHT)
  pila.set_transition_duration(180)
  for (const p of paginas) pila.add_named(p.widget, p.id)
  raiz.append(pila)

  const botonesPunto = paginas.map((p) => {
    const b = new Gtk.Button({ cssClasses: ["fc-punto"], tooltipText: p.titulo })
    b.connect("clicked", () => ir(p.id))
    puntos.append(b)
    return b
  })

  const visibles = () => paginas.filter(p => p.hayContenido?.get() ?? true)
  let actual: string | null = null
  let manejadorAccion: number | null = null

  function pintar() {
    const vis = visibles()
    paginas.forEach((p, i) => { botonesPunto[i].visible = vis.includes(p) })
    puntos.visible = vis.length > 1
  }

  function ir(id: string) {
    const p = paginas.find(x => x.id === id)
    if (!p) return
    actual = id
    pila.set_visible_child_name(id)
    titulo.label = p.titulo.toUpperCase()
    paginas.forEach((x, i) => {
      if (x.id === id) botonesPunto[i].add_css_class("activo")
      else botonesPunto[i].remove_css_class("activo")
    })
    if (manejadorAccion !== null) accion.disconnect(manejadorAccion)
    manejadorAccion = null
    accion.visible = !!p.accion
    if (p.accion) {
      iconoAccion.icon_name = p.accion.icono
      accion.set_tooltip_text(p.accion.tooltip)
      manejadorAccion = accion.connect("clicked", p.accion.alPulsar)
    }
    pintar()
  }

  const prioritarias = () => visibles().filter(p => p.prioritaria?.get() ?? true)

  /** Vuelve a la página de entrada: la primera con contenido que pueda serlo. */
  function irAPrimera() {
    const destino = prioritarias()[0] ?? visibles()[0] ?? paginas[paginas.length - 1]
    ir(destino.id)
  }

  function paso(delta: number) {
    const vis = visibles()
    if (vis.length < 2) return
    const i = Math.max(0, vis.findIndex(p => p.id === actual))
    ir(vis[(i + delta + vis.length) % vis.length].id)
  }

  const rueda = new Gtk.EventControllerScroll({
    flags: Gtk.EventControllerScrollFlags.BOTH_AXES | Gtk.EventControllerScrollFlags.DISCRETE,
  })
  rueda.connect("scroll", (_c, dx, dy) => {
    const d = Math.abs(dx) > Math.abs(dy) ? dx : dy
    if (d === 0 || visibles().length < 2) return false
    paso(d > 0 ? 1 : -1)
    return true
  })
  raiz.add_controller(rueda)

  for (const p of paginas) {
    p.hayContenido?.subscribe(() => {
      // Una página que se queda vacía mientras la miras cede su sitio; la que
      // ACABA de tener contenido y pasa a ser la de entrada se adelanta (abres un
      // juego con Orion abierto).
      if (!visibles().some(x => x.id === actual) || (prioritarias()[0] === p && p.hayContenido?.get())) irAPrimera()
      else pintar()
    })
  }
  orionVisible.subscribe(() => { if (orionVisible.get()) irAPrimera() })

  irAPrimera()
  return raiz
}

// ── Reconstrucción perezosa ───────────────────────────────────────────────────

type Suscribible = { subscribe: (fn: () => void) => () => void }

/**
 * Reconstruye `widget` al mapearse por primera vez, y a partir de ahí ante cada
 * cambio de `fuentes` y en cada apertura de Orion. Antes del primer mapeo no
 * hace nada: la franja existe en todos los monitores desde el arranque.
 *
 * **Con Orion cerrado tampoco reconstruye**, aunque cambien las fuentes: cada
 * pista nueva, pausa o notificación rehacía las tarjetas en TODOS los monitores
 * (y "Sonando" decodificaba la carátula entera para sacar su color) sin que
 * nadie las viera. No hace falta apuntar que quedó pendiente: abrir Orion
 * reconstruye siempre, así que lo que cambió mientras tanto se pinta al abrir.
 */
function conReconstruccionPerezosa<W extends Gtk.Widget>(
  widget: W, reconstruir: () => void, fuentes: Suscribible[],
): W {
  let cargado = false
  const siCargado = () => { if (cargado && orionVisible.get()) reconstruir() }
  for (const f of fuentes) f.subscribe(siCargado)
  orionVisible.subscribe(() => { if (orionVisible.get()) siCargado() })
  widget.connect("map", () => {
    if (cargado) return
    cargado = true
    reconstruir()
  })
  return widget
}

// ── Montaje ───────────────────────────────────────────────────────────────────

export function FranjaInicio() {
  // Piso de arriba: lo que pasa ahora. Fila homogénea: con una sola tarjeta
  // visible, esa ocupa el ancho entero (las ocultas no cuentan).
  const pisoAhora = new Gtk.Box({ cssClasses: ["fi-piso-ahora"], spacing: 8, homogeneous: true })
  const sonando = TarjetaSonando()
  const jugando = TarjetaJugando()
  pisoAhora.append(sonando)
  pisoAhora.append(jugando)

  const pisoTema = new Gtk.Box({ cssClasses: ["fi-franja"], spacing: 8, homogeneous: true })
  pisoTema.append(TemaActual())
  pisoTema.append(Carrusel([
    {
      id: "notificaciones",
      titulo: "Notificaciones",
      widget: PaginaNotificaciones(),
      accion: { icono: "preferences-system-notifications-symbolic", tooltip: "Abrir notificaciones", alPulsar: abrirPanelNotificaciones },
      hayContenido: hayNotisRecientes,
    },
    {
      id: "reciente",
      titulo: "Reciente",
      widget: PaginaReciente(),
      accion: { icono: "edit-clear-all-symbolic", tooltip: "Borrar historial", alPulsar: borrarHistorial },
    },
    {
      id: "abiertas",
      titulo: "Abiertas",
      widget: PaginaAbiertas(),
      hayContenido: hayVentanas,
      // Siempre hay ventanas: si pudiera ser la de entrada, Orion se abriría aquí
      // en vez de en Reciente. Se llega con los puntos o la rueda.
      prioritaria: { get: () => false, subscribe: () => () => {} },
    },
  ]))

  // Cada piso en su caja de alto FIJO: si el contenido de uno pidiera un píxel
  // de más, la caja vertical se lo quitaría al otro y lo cortaría por abajo.
  const cajaAhora = cajaFija(pisoAhora, ANCHO_FRANJA, ALTO_PISO_AHORA)
  const pisos = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: SEPARACION_PISOS })
  pisos.append(cajaAhora)
  pisos.append(cajaFija(pisoTema, ANCHO_FRANJA, ALTO_PISO_TEMA))
  const limite = cajaFija(pisos, ANCHO_FRANJA, altoContenido)
  limite.hexpand = true

  const sincronizarPisos = () => {
    sonando.visible = hayReproductor()
    jugando.visible = hayJuegos()
    cajaAhora.visible = hayPisoAhora()
    limite.queue_resize()
  }
  sincronizarPisos()
  // Igual que el alto: con Orion cerrado no se toca la maqueta; al abrir se pone
  // al día (aunque el alto no haya cambiado, puede haber cambiado QUÉ tarjeta
  // del piso de arriba se ve).
  const siAbierto = () => { if (orionVisible.get()) sincronizarPisos() }
  alturaFranjaInicio.subscribe(siAbierto)
  reproductoresMultimedia.subscribe(siAbierto)
  clientesJuego.subscribe(siAbierto)
  orionVisible.subscribe(siAbierto)

  return (
    <box
      cssClasses={["fi-contenedor"]}
      hexpand
      heightRequest={alturaFranjaInicio}
      visible={activeSection(section => section === "inicio")}
    >
      {limite as unknown as any}
    </box>
  )
}
