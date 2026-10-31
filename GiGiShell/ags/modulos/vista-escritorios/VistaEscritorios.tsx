import Gdk from "gi://Gdk"
import { Astal, Gtk } from "ags/gtk4"
import app from "ags/gtk4/app"
import { execAsync } from "ags/process"
import System from "system"
import { type AreaUtilSalida, obtenerAreaUtilSalida } from "../barra/escritorios/areaUtilSalida"
import { cargarFondoMiniatura } from "../barra/escritorios/fondoMiniatura"
import { capturarSalidaConGrim } from "../barra/escritorios/respaldoGrim"
import { wsPreviewSuspended } from "../../servicios/energia/powerState"
import { obtenerHyprland, suscribirDatosEscritorios } from "../../servicios/escritorios/controlador"
import { esEscritorioEspecial } from "../../servicios/escritorios/especiales"
import { enfocarEscritorio } from "../../servicios/escritorios/operaciones"
import { blurSuave } from "../../utilidades/blurSuave"
import { filtrarVentanasDeUsuario } from "../../servicios/ventanas/emergentesX11"
import { obtenerIconosClientesEscritorio } from "../barra/escritorios/iconos"
import type { ClienteEscritorio, IconoClienteEscritorio } from "../barra/escritorios/modelo"
import { ordenarClientesEscritorio } from "../barra/escritorios/orden"
import { iniciarCapturaEscritorios } from "./capturaEscritorios"
import {
  maximoIconos, repartirFilas, SEPARACION_ICONOS, TAMANO_ICONO, tamanoMiniatura, tamanoVistaGrande, valorFilaSiguiente,
} from "./disposicion"
import { cerrarVistaEscritorios, vistaEscritoriosFijada, vistaEscritoriosVisible } from "./estado"

const SEPARACION = 32
const MARGEN = 32
/** Medido con 3 escritorios activos: 1/2/3/4 búferes dan 24/26/28/28 fps y 34/48/62/75 MB. */
const BUFERES_MINIATURAS = 3
const BUFERES_GRANDE = 2
const INTERVALO_MINIATURAS_MS = 33
const INTERVALO_GRANDE_MS = 16
const INTERVALO_GRANDE_RESPALDO_MS = 33
const FPS_MINIATURAS = 30
const FPS_GRANDE = 60
const REFRESCO_PARA_60_FPS = 59

let colaVistaEnVivo: Promise<unknown> = Promise.resolve()

/** En cola y no en paralelo: dos `hyprctl` lanzados a la vez pueden llegar al revés, y un «fps 30»
 * tardío dejaría la vista grande a 30, o un «desactivar» tardío congelaría una miniatura recién
 * abierta. Un fallo aquí no rompe nada: la app oculta solo deja de pintar. */
const vistaEnVivo = (llamada: string) => {
  colaVistaEnVivo = colaVistaEnVivo
    .then(() => execAsync(["hyprctl", "eval", `GiGiShell.${llamada}`]))
    .catch(() => {})
}

interface Miniatura {
  raiz: Gtk.Widget
  imagen: Gtk.Picture
  fondo: Gtk.Picture
  etiqueta: Gtk.Label
  /** Fila de iconos del rótulo y la firma con la que se pintó (ver `actualizarIconos`). */
  iconos: Gtk.Box
  firmaIconos: string
}

/** Pastilla «1» + un icono por ventana. Sin medida propia que empuje: va en un overlay, que no
 * cuenta para el tamaño de la miniatura, y recorta lo que sobre aunque falle `maximoIconos`. */
function crearRotulo(id: number): { rotulo: Gtk.Box; iconos: Gtk.Box } {
  const rotulo = new Gtk.Box({
    spacing: SEPARACION_ICONOS,
    halign: Gtk.Align.START,
    valign: Gtk.Align.START,
    overflow: Gtk.Overflow.HIDDEN,
  })
  rotulo.add_css_class("ve-rotulo")
  const numero = new Gtk.Label({ label: String(id) })
  numero.add_css_class("ve-numero")
  const iconos = new Gtk.Box({ spacing: SEPARACION_ICONOS, valign: Gtk.Align.CENTER, overflow: Gtk.Overflow.HIDDEN })
  rotulo.append(numero)
  rotulo.append(iconos)
  return { rotulo, iconos }
}

/** Glifo, icono Gio o icono de tema, como `botonIcono` de la barra. */
function crearIconoVentana(icono: IconoClienteEscritorio): Gtk.Widget {
  if (icono.esGlifo) {
    const glifo = new Gtk.Label({ label: icono.icono, width_request: TAMANO_ICONO, halign: Gtk.Align.CENTER })
    glifo.add_css_class("ve-icono-glifo")
    return glifo
  }
  const imagen = icono.iconoGio
    ? new Gtk.Image({ gicon: icono.iconoGio, pixel_size: TAMANO_ICONO })
    : new Gtk.Image({ icon_name: icono.icono, pixel_size: TAMANO_ICONO })
  imagen.set_halign(Gtk.Align.CENTER)
  return imagen
}

/** Reclama la pulsación: sin eso también llega al clic de fondo, que al ver el sitio ya vacío
 * (se acaba de cerrar la vista grande) cerraría el menú entero. */
function alPulsar(widget: Gtk.Widget, alClic: (boton: number) => void) {
  const gesto = new Gtk.GestureClick({ button: 0 })
  gesto.connect("pressed", () => {
    gesto.set_state(Gtk.EventSequenceState.CLAIMED)
    alClic(gesto.get_current_button())
  })
  widget.add_controller(gesto)
}

function crearMiniatura(id: number, ancho: number, alto: number, alClic: (boton: number) => void): Miniatura {
  const raiz = new Gtk.Overlay({ width_request: ancho, height_request: alto, overflow: Gtk.Overflow.HIDDEN })
  raiz.add_css_class("ve-miniatura")
  const etiqueta = new Gtk.Label({ label: `Escritorio ${id}`, halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER })
  etiqueta.add_css_class("ve-etiqueta")
  raiz.set_child(etiqueta)
  const fondo = new Gtk.Picture({ can_shrink: true, content_fit: Gtk.ContentFit.COVER })
  const imagen = new Gtk.Picture({ can_shrink: true, content_fit: Gtk.ContentFit.FILL })
  raiz.add_overlay(fondo)
  raiz.add_overlay(imagen)
  const { rotulo, iconos } = crearRotulo(id)
  raiz.add_overlay(rotulo)
  alPulsar(raiz, alClic)
  return { raiz, imagen, fondo, etiqueta, iconos, firmaIconos: "" }
}

export default function VistaEscritorios(monitorGdk: Gdk.Monitor) {
  const nombreSalida = monitorGdk.get_connector() ?? ""
  const hyprland = obtenerHyprland()
  const { TOP, BOTTOM, LEFT, RIGHT } = Astal.WindowAnchor

  const ventana = new Astal.Window({
    application: app,
    name: `vista-escritorios-${nombreSalida.replace(/[^a-zA-Z0-9_-]/g, "-") || "monitor"}`,
    namespace: "vista-escritorios",
    visible: false,
    decorated: false,
    layer: Astal.Layer.OVERLAY,
    exclusivity: Astal.Exclusivity.IGNORE,
    anchor: TOP | BOTTOM | LEFT | RIGHT,
    keymode: Astal.Keymode.EXCLUSIVE,
    gdkmonitor: monitorGdk,
    css_classes: ["ve-ventana"],
  })

  const teclado = new Gtk.EventControllerKey()
  teclado.connect("key-pressed", (_c, tecla) => {
    if (tecla !== Gdk.KEY_Escape) return false
    cerrarVistaEscritorios()
    return true
  })
  ventana.add_controller(teclado)

  const raiz = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, hexpand: true, vexpand: true, spacing: SEPARACION })
  raiz.add_css_class("ve-fondo")
  const contenedorGrande = new Gtk.Box({ halign: Gtk.Align.CENTER, visible: false })
  const desplazable = new Gtk.ScrolledWindow({
    hscrollbar_policy: Gtk.PolicyType.NEVER,
    vexpand: true,
  })
  const cuadricula = new Gtk.Box({
    orientation: Gtk.Orientation.VERTICAL,
    spacing: SEPARACION,
    halign: Gtk.Align.CENTER,
    valign: Gtk.Align.CENTER,
  })
  desplazable.set_child(cuadricula)

  // La rueda salta una fila entera por paso y queda alineada a su inicio. En fase de captura el
  // ScrolledWindow no llega a verla. Un panel táctil manda deltas pequeños: se acumulan.
  let acumuladoRueda = 0
  const rueda = new Gtk.EventControllerScroll({ flags: Gtk.EventControllerScrollFlags.VERTICAL })
  rueda.set_propagation_phase(Gtk.PropagationPhase.CAPTURE)
  rueda.connect("scroll", (_c, _dx, dy) => {
    const ajuste = desplazable.get_vadjustment()
    const maximo = ajuste.get_upper() - ajuste.get_page_size()
    const primera = cuadricula.get_first_child()
    if (maximo <= 0 || !primera) return false
    acumuladoRueda += dy
    if (Math.abs(acumuladoRueda) < 1) return true
    const delta = acumuladoRueda > 0 ? 1 : -1
    acumuladoRueda -= delta
    ajuste.set_value(valorFilaSiguiente(ajuste.get_value(), primera.get_height() + SEPARACION, delta, maximo))
    return true
  })
  desplazable.add_controller(rueda)
  raiz.append(contenedorGrande)
  raiz.append(desplazable)
  ventana.set_child(raiz)

  // Un clic sin miniatura debajo cierra, como en el menú de energía, pero solo con el menú fijado:
  // en modo mantener no hace nada (Esc cierra siempre). La barra de desplazamiento cuenta como
  // «algo debajo»: arrastrarla no debe cerrar.
  const clicFondo = new Gtk.GestureClick({ button: 0 })
  clicFondo.connect("pressed", (_g, _n, x, y) => {
    if (!vistaEscritoriosFijada()) return
    let widget: Gtk.Widget | null = raiz.pick(x, y, 0)
    while (widget && widget !== raiz) {
      if (widget.has_css_class("ve-miniatura") || widget.has_css_class("ve-grande") || widget instanceof Gtk.Scrollbar) return
      widget = widget.get_parent()
    }
    cerrarVistaEscritorios()
  })
  raiz.add_controller(clicFondo)

  /** Todo lo que vive solo mientras el menú está abierto se libera aquí. */
  let liberar = () => {}
  // Invalida la apertura que aún espera a `hyprctl` si entretanto se cierra o se abre otra.
  let secuenciaApertura = 0

  const abrir = async (apertura: number) => {
    const enfocado = hyprland.get_focused_monitor()?.name ?? ""
    if (enfocado !== nombreSalida) return
    const area = await obtenerAreaUtilSalida(nombreSalida)
    if (apertura !== secuenciaApertura) return
    const fotoPrevia = construir(area)
    if (fotoPrevia) {
      await fotoPrevia
      if (apertura !== secuenciaApertura) return
    }
    ventana.set_visible(true)
  }

  /** Devuelve una promesa si hay que esperar a la foto con grim antes de mostrar la ventana. */
  const construir = (area: AreaUtilSalida | null): Promise<void> | null => {
    const geometria = monitorGdk.get_geometry()
    const escala = monitorGdk.get_scale()
    const recorte = area?.recorte ?? [0, 0, 0, 0]
    const proporcion = area ? area.ancho / area.alto : geometria.width / geometria.height
    const { ancho, alto } = tamanoMiniatura(geometria.width, geometria.height, proporcion, SEPARACION, MARGEN)
    const fisico = { ancho: Math.round(ancho * escala), alto: Math.round(alto * escala) }
    const imagenFija = wsPreviewSuspended.get()
    const miniaturas = new Map<number, Miniatura>()
    const nombres = new Map<number, string>()
    let texturaFondo: Gdk.Texture | null = null
    let fondoGrande: Gtk.Picture | null = null
    let idGrande: number | null = null
    let detenerGrande = () => {}
    let filasActuales: number[] = []
    let vigente = true
    let construyendo = true
    let sinAyudante = false
    let cancelarFondo = () => {}
    let dejarDatos = () => {}

    const fotografiarActivo = async () => {
      const miniatura = miniaturas.get(hyprland.get_focused_workspace()?.id ?? 0)
      if (!nombreSalida || !miniatura) return
      const textura = await capturarSalidaConGrim(nombreSalida, fisico.ancho, fisico.alto)
      if (vigente && textura) miniatura.imagen.set_paintable(textura)
    }

    const captura = iniciarCapturaEscritorios({
      ancho: fisico.ancho,
      alto: fisico.alto,
      intervaloMs: INTERVALO_MINIATURAS_MS,
      recorte,
      buferes: BUFERES_MINIATURAS,
      imagenFija,
      alFotograma: (clave, textura) => {
        const miniatura = miniaturas.get(clave)
        if (!miniatura) return
        miniatura.etiqueta.set_visible(false)
        miniatura.imagen.set_paintable(textura)
      },
      // Sin el binario esto llega aquí mismo, antes de que exista ninguna miniatura.
      alNoDisponible: () => {
        if (construyendo) sinAyudante = true
        else void fotografiarActivo()
      },
    })

    const soltarGrande = () => {
      detenerGrande()
      detenerGrande = () => {}
      if (idGrande !== null) miniaturas.get(idGrande)?.raiz.remove_css_class("ve-seleccionada")
      idGrande = null
      fondoGrande = null
      contenedorGrande.set_visible(false)
      const hijo = contenedorGrande.get_first_child()
      if (hijo) contenedorGrande.remove(hijo)
    }

    const cerrarGrande = () => {
      if (idGrande === null) return
      soltarGrande()
      vistaEnVivo(`vista_en_vivo_fps(${FPS_MINIATURAS})`)
    }

    const abrirGrande = (id: number) => {
      soltarGrande()
      idGrande = id
      // La miniatura se queda en su sitio y en vivo: solo se marca cuál está abierta.
      miniaturas.get(id)?.raiz.add_css_class("ve-seleccionada")
      const tam = tamanoVistaGrande(proporcion, ancho, alto, geometria.height, SEPARACION, MARGEN)
      const marco = new Gtk.Overlay({ width_request: tam.ancho, height_request: tam.alto, overflow: Gtk.Overflow.HIDDEN })
      marco.add_css_class("ve-grande")
      const fondo = new Gtk.Picture({ can_shrink: true, content_fit: Gtk.ContentFit.COVER })
      if (texturaFondo) fondo.set_paintable(texturaFondo)
      fondoGrande = fondo
      const imagen = new Gtk.Picture({ can_shrink: true, content_fit: Gtk.ContentFit.FILL })
      // Todo en overlays: una textura mayor que el marco (monitor escalado) lo ensancharía si
      // participara en la medida.
      marco.set_child(new Gtk.Box())
      marco.add_overlay(fondo)
      marco.add_overlay(imagen)
      alPulsar(marco, (boton) => {
        if (boton === Gdk.BUTTON_PRIMARY) irA(id)
        else if (boton === Gdk.BUTTON_SECONDARY) cerrarGrande()
      })
      contenedorGrande.append(marco)
      contenedorGrande.set_visible(true)

      const refresco = hyprland.get_focused_monitor()?.refresh_rate ?? 60
      const a60 = refresco >= REFRESCO_PARA_60_FPS
      vistaEnVivo(`vista_en_vivo_fps(${a60 ? FPS_GRANDE : FPS_MINIATURAS})`)
      // `detener()` puede dejar un último fotograma en camino.
      let grandeVigente = true
      const capturaGrande = iniciarCapturaEscritorios({
        ancho: Math.round(tam.ancho * escala),
        alto: Math.round(tam.alto * escala),
        intervaloMs: a60 ? INTERVALO_GRANDE_MS : INTERVALO_GRANDE_RESPALDO_MS,
        intervaloRespaldoMs: a60 ? INTERVALO_GRANDE_RESPALDO_MS : undefined,
        recorte,
        buferes: BUFERES_GRANDE,
        imagenFija,
        soloRefinado: true,
        alFotograma: (_clave, textura) => {
          if (grandeVigente) imagen.set_paintable(textura)
        },
        alNoDisponible: () => {},
      })
      capturaGrande.anadir(id, nombres.get(id) ?? String(id))
      detenerGrande = () => {
        grandeVigente = false
        capturaGrande.detener()
      }
    }

    const irA = (id: number) => {
      void enfocarEscritorio(id, nombres.get(id)).catch(() => {})
      cerrarVistaEscritorios()
    }

    const maxIconos = maximoIconos(ancho)

    /** Rehace los iconos de una miniatura solo si cambió su firma (direcciones, clases y orden de
     * sus ventanas): un título cambiante o un cambio de foco no tocan nada. La firma usa datos
     * baratos del cliente; el icono se resuelve solo cuando esa firma cambia. */
    const actualizarIconos = () => {
      const porEscritorio = new Map<number, ClienteEscritorio[]>()
      try {
        for (const cliente of filtrarVentanasDeUsuario(hyprland.get_clients() as ClienteEscritorio[])) {
          const id = cliente.workspace?.id ?? cliente.get_workspace?.()?.id
          if (typeof id !== "number" || !miniaturas.has(id) || !cliente.class) continue
          const lista = porEscritorio.get(id) ?? []
          lista.push(cliente)
          porEscritorio.set(id, lista)
        }
      } catch (e) {
        console.error("[vista-escritorios] no se pudieron leer las ventanas:", e)
        return
      }
      for (const [id, miniatura] of miniaturas) {
        const clientes = ordenarClientesEscritorio(porEscritorio.get(id))
        const firma = clientes
          .map((c) => `${c.address}|${c.class}|${c.initialClass ?? c.initial_class ?? ""}`)
          .join(",")
        if (firma === miniatura.firmaIconos) continue
        miniatura.firmaIconos = firma
        // Si falla la resolución, la miniatura se queda con su número.
        try {
          const iconos = obtenerIconosClientesEscritorio(clientes.slice(0, maxIconos))
          for (let hijo = miniatura.iconos.get_first_child(); hijo; hijo = miniatura.iconos.get_first_child()) {
            miniatura.iconos.remove(hijo)
          }
          for (const icono of iconos) miniatura.iconos.append(crearIconoVentana(icono))
        } catch (e) {
          console.error(`[vista-escritorios] iconos del escritorio ${id}:`, e)
        }
      }
    }

    const actualizar = () => {
      const propios = hyprland.get_workspaces()
        .filter((e) => e.get_monitor()?.name === nombreSalida && !esEscritorioEspecial(e.id))
        .sort((a, b) => a.id - b.id)
      const ids = propios.map((e) => e.id)
      if (ids.join() === filasActuales.join()) {
        actualizarIconos()
        return
      }
      for (const e of propios) nombres.set(e.id, e.name)
      for (const id of [...miniaturas.keys()]) {
        if (!ids.includes(id)) {
          captura.quitar(id)
          vistaEnVivo(`vista_en_vivo(${id}, false)`)
          miniaturas.delete(id)
          if (idGrande === id) cerrarGrande()
        }
      }
      for (const id of ids) {
        if (miniaturas.has(id)) continue
        const miniatura = crearMiniatura(id, ancho, alto, (boton) => {
          if (boton === Gdk.BUTTON_PRIMARY) irA(id)
          else if (boton === Gdk.BUTTON_SECONDARY) {
            if (idGrande === id) cerrarGrande()
            else abrirGrande(id)
          }
        })
        if (texturaFondo) miniatura.fondo.set_paintable(texturaFondo)
        miniaturas.set(id, miniatura)
        if (!imagenFija) vistaEnVivo(`vista_en_vivo(${id}, true)`)
        captura.anadir(id, nombres.get(id) ?? String(id))
      }
      for (let hijo = cuadricula.get_first_child(); hijo; hijo = cuadricula.get_first_child()) {
        for (let m = (hijo as Gtk.Box).get_first_child(); m; m = (hijo as Gtk.Box).get_first_child()) {
          (hijo as Gtk.Box).remove(m)
        }
        cuadricula.remove(hijo)
      }
      for (const fila of repartirFilas(ids)) {
        const caja = new Gtk.Box({ spacing: SEPARACION, halign: Gtk.Align.CENTER })
        for (const id of fila) caja.append(miniaturas.get(id)!.raiz)
        cuadricula.append(caja)
      }
      filasActuales = ids
      actualizarIconos()
    }

    // Antes de suscribir nada: si algo de lo que sigue falla, `abrir` aún puede soltar lo ya creado.
    liberar = () => {
      liberar = () => {}
      vigente = false
      dejarDatos()
      cancelarFondo()
      cerrarGrande()
      captura.detener()
      for (const id of miniaturas.keys()) vistaEnVivo(`vista_en_vivo(${id}, false)`)
      blurSuave("escritorios", false)
      miniaturas.clear()
      for (let hijo = cuadricula.get_first_child(); hijo; hijo = cuadricula.get_first_child()) cuadricula.remove(hijo)
      // Las recolecciones de la captura van por bytes: sin esta, lo último quedaría retenido con
      // el menú cerrado. Fuera de la señal, con los widgets ya soltados.
      setTimeout(() => System.gc(), 0)
    }

    if (nombreSalida) {
      cancelarFondo = cargarFondoMiniatura(nombreSalida, fisico.ancho, fisico.alto, (textura) => {
        texturaFondo = textura
        for (const m of miniaturas.values()) m.fondo.set_paintable(textura)
        fondoGrande?.set_paintable(textura)
      })
    }

    blurSuave("escritorios", true)
    vistaEnVivo(`vista_en_vivo_fps(${FPS_MINIATURAS})`)
    dejarDatos = suscribirDatosEscritorios(actualizar)
    construyendo = false
    // La foto se toma con la ventana aún oculta: si no, grim fotografiaría el propio menú.
    return sinAyudante ? fotografiarActivo() : null
  }

  // Deshace el blur que haya dejado un AGS caído con el menú abierto.
  blurSuave("escritorios", false)

  vistaEscritoriosVisible.subscribe(() => {
    const apertura = ++secuenciaApertura
    if (vistaEscritoriosVisible.get()) {
      void abrir(apertura).catch((e) => {
        console.error("[vista-escritorios] no se pudo abrir:", e)
        if (apertura !== secuenciaApertura) return
        ventana.set_visible(false)
        liberar()
        cerrarVistaEscritorios()
      })
    } else {
      ventana.set_visible(false)
      liberar()
    }
  })

  return ventana
}
