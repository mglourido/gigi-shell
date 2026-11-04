// Icono de la barra con los USB de almacenamiento conectados. Es el ÚLTIMO eslabón de la cadena de
// estado (ver `componentes/cadenaEstado.tsx`), siempre pegado a quick settings. Al pulsarlo sale un menú con el
// mismo aspecto que el de las apps en segundo plano (`popover.tray-popover`, un
// `Gtk.PopoverMenu` nativo): una fila por dispositivo, y al pasar el ratón por ella se abre AL LADO
// su submenú con el espacio libre (pulsarlo monta el volumen si no lo está), Abrir, Reparar (solo si el monitor lo dejó marcado como sucio) y
// Expulsar.
//
// El submenú lateral es el modo `Gtk.PopoverMenuFlags.NESTED` de GTK: cada submenú es un popover
// propio, hijo del principal, que se abre al hover. Sin la bandera, GTK los DESLIZA dentro de la
// misma caja (es lo que hacen los menús de la bandeja), que es justo lo que no se quería aquí.
//
// Sin sondeos: la lista llega por señales de UDisks2 (`servicios/usb/udisks.ts`). Lo único que se
// consulta a demanda es el espacio libre, y solo al abrir el menú o cuando cambia un montaje con él
// abierto: es un statvfs asíncrono por volumen montado.
import Gio from "gi://Gio"
import GLib from "gi://GLib"
import { createComputed, onCleanup } from "ags"
import { Gtk } from "ags/gtk4"

import { panelAutoClose } from "../../../../estado/shell"
import { notifPanelVisible } from "../../../notificaciones/store"
import { consultarEspacio, dispositivosUsb, volumenSucio } from "../../../../servicios/usb/udisks"
import { abrirVolumen, expulsarDisco, montarVolumen, repararVolumen } from "../../../../servicios/usb/acciones"
import { textoVolumen, tituloUsb, type DispositivoUsb, type EspacioVolumen } from "../../../../servicios/usb/modelo.ts"
import { colgarDeBarra } from "../../componentes/anclaBarra"
import { tituloBarra } from "../../componentes/tituloBarra"
import { crearControlPopoverAnclado } from "../../componentes/controlPopoverAnclado"
import { ESLABON, SensorCadena, type CadenaEstado } from "../../componentes/cadenaEstado"
import type { ControlVisibilidadBarra } from "../../../../estado/visibilidadBarra"

const GRUPO = "usb"

/** Acción con un parámetro de cadena: el dispositivo sobre el que actúa la fila pulsada. */
function accion(nombre: string, ejecutar: (argumento: string) => void) {
  const a = new Gio.SimpleAction({ name: nombre, parameter_type: new GLib.VariantType("s") })
  a.connect("activate", (_a, parametro) => {
    const argumento = parametro?.unpack() as string | undefined
    if (argumento) ejecutar(argumento)
  })
  return a
}

function fila(etiqueta: string, nombreAccion: string | null, argumento?: string) {
  const item = Gio.MenuItem.new(etiqueta, null)
  // Sin acción, GTK pinta la fila insensible: así se lee como dato y no como botón.
  if (nombreAccion && argumento) {
    item.set_action_and_target_value(`${GRUPO}.${nombreAccion}`, GLib.Variant.new_string(argumento))
  }
  return item
}

/** Una fila del menú: texto, acción (`null` = informativa) y argumento. */
type Fila = [etiqueta: string, accion: string | null, argumento?: string]
/** Un dispositivo: su nombre (fila del menú principal) y las secciones de su submenú. */
type PlanDispositivo = { nombre: string; secciones: Fila[][] }

function planificar(dispositivos: DispositivoUsb[], espacio: Map<string, EspacioVolumen>): PlanDispositivo[] {
  return dispositivos.map((d) => {
    const varios = d.volumenes.length > 1
    // Una sección por volumen (su dato y sus acciones) y Expulsar aparte, porque es del disco.
    const secciones: Fila[][] = d.volumenes.map((v) => {
      const sufijo = varios ? ` ${v.etiqueta || v.dispositivo.slice(5)}` : ""
      const filas: Fila[] = [
        // La fila del volumen es un dato, salvo sin montar: entonces pulsarla lo monta.
        [
          textoVolumen(v, v.montaje ? espacio.get(v.montaje) : null, varios),
          v.montaje ? null : "montar",
          v.dispositivo.slice(5),
        ],
        [`Abrir${sufijo}`, "abrir", v.dispositivo.slice(5)],
      ]
      if (volumenSucio(v.uuid)) filas.push([`Reparar${sufijo}`, "reparar", v.dispositivo])
      return filas
    })
    secciones.push([["Expulsar", "expulsar", d.disco]])
    return { nombre: d.nombre, secciones }
  })
}

/**
 * Rellena `menu` en sitio, pero SOLO si cambia algo. Vaciar el modelo cierra el submenú abierto,
 * y el espacio libre llega un instante después de abrir: sin esta comparación, esa respuesta (o un
 * cambio de propiedades que no altera ninguna fila) cerraría el submenú bajo el cursor.
 */
function crearRellenoMenu(menu: Gio.Menu) {
  let firma = ""
  /** Devuelve si ha rehecho el modelo (y con él, los submenús). */
  return (dispositivos: DispositivoUsb[], espacio: Map<string, EspacioVolumen>): boolean => {
    const plan = planificar(dispositivos, espacio)
    const siguiente = JSON.stringify(plan)
    if (siguiente === firma) return false
    firma = siguiente
    menu.remove_all()
    for (const d of plan) {
      const submenu = new Gio.Menu()
      for (const seccion of d.secciones) {
        const bloque = new Gio.Menu()
        for (const [etiqueta, nombreAccion, argumento] of seccion) bloque.append_item(fila(etiqueta, nombreAccion, argumento))
        submenu.append_section(null, bloque)
      }
      menu.append_submenu(d.nombre, submenu)
    }
    return true
  }
}

/** Los submenús (popovers descendientes) de `raiz`, que en modo `NESTED` GTK crea al rellenar. */
function submenus(raiz: Gtk.Widget, encontrados: Gtk.Popover[] = []): Gtk.Popover[] {
  for (let hijo = raiz.get_first_child(); hijo; hijo = hijo.get_next_sibling()) {
    if (hijo instanceof Gtk.Popover) encontrados.push(hijo)
    submenus(hijo, encontrados)
  }
  return encontrados
}

export default function Usb({ visibilidad, cadena }: { visibilidad: ControlVisibilidadBarra; cadena: CadenaEstado }) {
  const indice = ESLABON.usb
  const controlMenu = crearControlPopoverAnclado(visibilidad)
  const menu = new Gio.Menu()
  const rellenarMenu = crearRellenoMenu(menu)
  const grupo = new Gio.SimpleActionGroup()
  grupo.add_action(accion("montar", montarVolumen))
  grupo.add_action(accion("abrir", abrirVolumen))
  grupo.add_action(accion("expulsar", expulsarDisco))
  grupo.add_action(accion("reparar", repararVolumen))

  // Espacio libre por punto de montaje, solo mientras el menú está abierto: al cerrarlo se tira,
  // para que la siguiente apertura no enseñe cifras viejas.
  const espacio = new Map<string, EspacioVolumen>()
  const consultando = new Set<string>()
  let popover: Gtk.PopoverMenu | null = null
  let boton: Gtk.Widget | null = null

  const abierto = () => popover?.get_visible() === true

  // ── Autocierre por puntero, repartido entre VARIAS superficies ─────────────────────────────
  // El menú ya no es una sola caja: el botón, el popover principal y cada submenú lateral son
  // superficies distintas, y cruzar de una a otra entrega un `leave` en la que se deja. Con un solo
  // `panelAutoClose` eso cerraba el menú al entrar al submenú; bloquear el cierre «si hay submenú
  // visible» lo dejaba abierto para siempre, porque al submenú no lo vigilaba nadie. Así que se
  // lleva la cuenta de DÓNDE está el puntero y solo se cierra cuando no está en ninguna.
  const dentro = new Set<unknown>()
  const vigilados = new WeakSet<Gtk.Widget>()
  const autoCierre = panelAutoClose(() => {
    if (dentro.size === 0) popover?.popdown()
  }, 250)
  const entrar = (donde: unknown) => {
    dentro.add(donde)
    autoCierre.onEnter()
  }
  const salir = (donde: unknown) => {
    dentro.delete(donde)
    if (dentro.size === 0) autoCierre.onLeave()
  }
  const vigilar = (w: Gtk.Widget) => {
    if (vigilados.has(w)) return
    vigilados.add(w)
    const movimiento = new Gtk.EventControllerMotion()
    movimiento.connect("enter", () => entrar(w))
    movimiento.connect("motion", () => entrar(w))
    movimiento.connect("leave", () => salir(w))
    w.add_controller(movimiento)
  }
  // Un submenú que se cierra con el puntero dentro (al pasar a otra fila del principal) no recibe
  // `leave`: se le da de baja aquí para que no quede contando para siempre.
  const vigilarSubmenus = () => {
    if (!popover) return
    for (const sub of submenus(popover)) {
      if (vigilados.has(sub)) continue
      vigilar(sub)
      sub.connect("closed", () => salir(sub))
    }
  }

  const refrescar = () => {
    const lista = dispositivosUsb.get()
    if (rellenarMenu(lista, espacio)) vigilarSubmenus()
    if (!abierto()) return
    for (const d of lista) {
      for (const v of d.volumenes) {
        const montaje = v.montaje
        if (!montaje || espacio.has(montaje) || consultando.has(montaje)) continue
        consultando.add(montaje)
        void consultarEspacio(montaje).then((e) => {
          consultando.delete(montaje)
          if (!e || !abierto()) return
          espacio.set(montaje, e)
          if (rellenarMenu(dispositivosUsb.get(), espacio)) vigilarSubmenus()
        })
      }
    }
  }

  const crearPopover = (padre: Gtk.Widget) => {
    const p = Gtk.PopoverMenu.new_from_model_full(menu, Gtk.PopoverMenuFlags.NESTED)
    p.add_css_class("tray-popover")
    p.set_has_arrow(false)
    // Como la bandeja: sin autohide (el grab haría llegar un `leave` al botón y `panelAutoClose`
    // cerraría el menú recién abierto); el cierre lo lleva el movimiento del puntero.
    p.set_autohide(false)
    p.insert_action_group(GRUPO, grupo)
    vigilar(p)
    p.connect("closed", () => {
      dentro.clear()
      controlMenu.cerrar()
      espacio.clear()
    })
    p.set_parent(padre)
    return p
  }

  const alternar = () => {
    if (!boton) return
    if (abierto()) { popover?.popdown(); return }
    popover ??= crearPopover(boton)
    colgarDeBarra(popover)
    controlMenu.abrir()
    popover.popup()
    refrescar()
    // Por si el modelo ya estaba relleno de una apertura anterior y no se rehízo.
    vigilarSubmenus()
  }

  // Con el menú cerrado no hace falta rehacerlo a cada cambio: `alternar` lo rehace al abrir.
  const baja = dispositivosUsb.subscribe(() => {
    if (!abierto()) return
    if (dispositivosUsb.get().length === 0) popover?.popdown()
    else refrescar()
  })

  onCleanup(() => {
    baja()
    autoCierre.dispose()
    if (popover) {
      try { popover.popdown() } catch (_) {}
      try { popover.unparent() } catch (_) {}
      popover = null
    }
    controlMenu.cerrar()
    boton = null
  })

  const cuantos = dispositivosUsb((l) => l.length)

  // Con el panel de notificaciones abierto, su pastilla y la junta con quick settings quedan
  // encendidas a la fuerza (`forzado` de `JuntaCadena`). Este eslabón está ENTRE las dos, así que
  // tiene que encenderse también o la banda queda partida por un hueco oscuro.
  const clasesPastilla = createComputed(
    [cadena.clases(indice, ["bar-pill", "usb-pill"]), notifPanelVisible],
    (clases, panel) => (panel && !clases.includes("cadena-resaltada") ? [...clases, "cadena-resaltada"] : clases),
  )

  return (
    <button
      visible={cuantos((n) => n > 0)}
      cssClasses={["bar-pill-btn"]}
      $={(self: Gtk.Widget) => {
        boton = self
        tituloBarra(self, dispositivosUsb(tituloUsb))
      }}
      onClicked={alternar}
    >
      <Gtk.EventControllerMotion onEnter={() => entrar("boton")} onLeave={() => salir("boton")} />
      <SensorCadena cadena={cadena} indice={indice} />
      <box
        cssClasses={clasesPastilla}
        halign={Gtk.Align.CENTER}
        valign={Gtk.Align.CENTER}
        spacing={2}
      >
        <label cssClasses={["usb-icon"]} label="󰕓" hexpand halign={Gtk.Align.CENTER} />
        <label cssClasses={["usb-cuenta"]} visible={cuantos((n) => n > 1)} label={cuantos(String)} />
      </box>
    </button>
  )
}
