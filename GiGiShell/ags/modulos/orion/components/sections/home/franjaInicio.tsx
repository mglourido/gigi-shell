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
import {
  reproductoresMultimedia, revisionMultimedia, obtenerEstadoReproductor, type EstadoReproductor,
} from "../../../../../servicios/multimedia/mpris"

// Dos pisos: arriba lo que está pasando AHORA (Sonando / Jugando ahora), que
// solo aparece si hay algo; abajo Tema + Reciente, que están siempre.
const ALTO_PISO_TEMA = 101
const ALTO_PISO_AHORA = 58
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
const recalcularAltura = () => setAlturaFranjaInicio(altoContenido() + RELLENO_FRANJA)
clientesJuego.subscribe(recalcularAltura)
reproductoresMultimedia.subscribe(recalcularAltura)

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
  try { gicon = Gio.DesktopAppInfo.new(id)?.get_icon() ?? null } catch (_) {}
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
    let info: Gio.DesktopAppInfo | null = null
    try { info = Gio.DesktopAppInfo.new(e.id) } catch (_) {}
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

function enfocarJuego(direccion: string) {
  const dir = direccion.startsWith("0x") ? direccion : `0x${direccion}`
  hidePanel()
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
  tarjeta.connect("clicked", () => { if (direccionActual) enfocarJuego(direccionActual) })
  return conReconstruccionPerezosa(tarjeta, reconstruir, [clientesJuego, clienteJuegoEnFoco])
}

// ── Tarjeta: Sonando ──────────────────────────────────────────────────────────
// Del servicio MPRIS compartido (el mismo de Quick Settings y la barra): cero
// sondeo propio y un solo registro de señales para todo el shell. Se enseña el
// reproductor que está SONANDO; si ninguno suena, el primero con pista (en pausa).

function reproductorPrincipal(): { r: any; e: EstadoReproductor } | null {
  const lista = reproductoresMultimedia.get()
  const con = lista
    .map(r => ({ r, e: obtenerEstadoReproductor(r) }))
    .filter((x): x is { r: any; e: EstadoReproductor } => !!x.e)
  return con.find(x => x.e.reproduciendo) ?? con[0] ?? null
}

function botonControl(icono: string, tooltip: string, activo: boolean, alPulsar: () => void, clases: string[] = []): Gtk.Button {
  const b = new Gtk.Button({ cssClasses: ["fs-control", ...clases], tooltipText: tooltip, valign: Gtk.Align.CENTER })
  b.set_child(new Gtk.Image({ iconName: icono, pixelSize: clases.includes("principal") ? 14 : 12 }))
  b.set_sensitive(activo)
  b.connect("clicked", alPulsar)
  return b
}

function TarjetaSonando(): Gtk.Widget {
  const caja = new Gtk.Box({ cssClasses: ["fx-tarjeta", "fs-tarjeta"], spacing: 8, hexpand: true })

  function reconstruir() {
    vaciarCaja(caja)
    const principal = reproductorPrincipal()
    if (!principal) return
    const { r, e } = principal

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
    cuerpo.append(texto)
    abrir.set_child(cuerpo)
    const puedeAbrir = !!r.can_raise
    abrir.set_tooltip_text(puedeAbrir ? `Abrir ${origen || "reproductor"}` : null)
    abrir.connect("clicked", () => {
      if (!puedeAbrir) return
      hidePanel()
      try { r.raise() } catch (_) {}
    })
    caja.append(abrir)

    const controles = new Gtk.Box({ spacing: 2, valign: Gtk.Align.CENTER })
    controles.append(botonControl("media-skip-backward-symbolic", "Anterior", !!r.can_go_previous, () => { try { r.previous() } catch (_) {} }))
    controles.append(botonControl(
      e.reproduciendo ? "media-playback-pause-symbolic" : "media-playback-start-symbolic",
      e.reproduciendo ? "Pausa" : "Reproducir", !!r.can_control,
      () => { try { r.play_pause() } catch (_) {} }, ["principal"],
    ))
    controles.append(botonControl("media-skip-forward-symbolic", "Siguiente", !!r.can_go_next, () => { try { r.next() } catch (_) {} }))
    caja.append(controles)
  }

  // `revisionMultimedia` sube en cada cambio de un reproductor (pista, estado,
  // carátula resuelta) salvo la posición, que es lo único que cambia por segundo.
  return conReconstruccionPerezosa(caja, reconstruir, [reproductoresMultimedia, revisionMultimedia])
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
 */
function conReconstruccionPerezosa<W extends Gtk.Widget>(
  widget: W, reconstruir: () => void, fuentes: Suscribible[],
): W {
  let cargado = false
  const siCargado = () => { if (cargado) reconstruir() }
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
      id: "reciente",
      titulo: "Reciente",
      widget: PaginaReciente(),
      accion: { icono: "edit-clear-all-symbolic", tooltip: "Borrar historial", alPulsar: borrarHistorial },
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
  alturaFranjaInicio.subscribe(sincronizarPisos)
  reproductoresMultimedia.subscribe(sincronizarPisos)
  clientesJuego.subscribe(sincronizarPisos)

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
