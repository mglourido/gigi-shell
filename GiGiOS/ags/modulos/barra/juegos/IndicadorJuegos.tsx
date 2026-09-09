import AstalHyprland from "gi://AstalHyprland"
import Gio from "gi://Gio"
import { For, onCleanup } from "ags"
import { Gtk } from "ags/gtk4"
import { execAsync } from "ags/process"

import { describirJuego, GLIFO_JUEGO } from "../../../servicios/juegos/iconos"
import { PANTALLA_COMPLETA_REAL } from "../../../servicios/juegos/deteccion"
import { clientesJuego, iniciarRegistroJuegos } from "../../../servicios/juegos/registro"
import { panelAutoClose } from "../../../estado/shell"
import { crearControlPopoverAnclado } from "../componentes/controlPopoverAnclado"
import type { ControlVisibilidadBarra } from "../../../estado/visibilidadBarra"

// Pastilla morada a la derecha de los workspaces: un mini-icono de mando fijo a la
// izquierda y, a su derecha, un icono POR JUEGO en ejecución — el icono real de la
// app (entrada .desktop / tema de iconos / steam_icon_<appid>), no un mando genérico.
// Clic izquierdo: ir al juego. Clic derecho: menú con sus acciones.
//
// El registro singleton de servicios/juegos concentra la detección para toda la sesión;
// esta vista solo deriva nombre, icono y acciones, sin polling propio.

interface EntradaJuego {
  direccion: string
  nombre: string
  iconoGio: Gio.Icon | null
  nombreIcono: string | null
}

function crearEntradaJuego(cliente: any): EntradaJuego {
  const apariencia = describirJuego(cliente)
  return {
    direccion: cliente.address ?? "",
    nombre: apariencia.nombre,
    iconoGio: apariencia.icono,
    nombreIcono: apariencia.nombreIcono,
  }
}

/** Entrada de repuesto para el instante entre que el registro deja de publicar un
 *  juego y el <For> retira su botón. */
const ENTRADA_AUSENTE: EntradaJuego = {
  direccion: "",
  nombre: "",
  iconoGio: null,
  nombreIcono: null,
}

/** El nombre del juego sin los sufijos entre paréntesis que arrastran los títulos
 *  de ventana (`Juego (Beta)` → `Juego`). */
function nombreParaAyuda(nombre: string): string {
  return nombre.replace(/(?:\s*\([^()]*\))+\s*$/, "").trim() || nombre
}

export default function IndicadorJuegos({ visibilidad }: { visibilidad: ControlVisibilidadBarra }) {
  const hyprland = AstalHyprland.get_default()
  iniciarRegistroJuegos()
  const juegos = clientesJuego((clientes) => clientes.map(crearEntradaJuego))

  // Ir al juego: enfocar su ventana (lo que te lleva a su workspace) y, si no está ya
  // en pantalla completa de verdad, ponerla (estado leído en vivo de la caché).
  const enfocarJuego = (direccion: string, activarPantallaCompleta: boolean) => {
    const direccionNormalizada = direccion.startsWith("0x") ? direccion : `0x${direccion}`
    execAsync(["hyprctl", "dispatch", `hl.dsp.focus({window='address:${direccionNormalizada}'})`])
      .then(() => {
        if (!activarPantallaCompleta) return
        const clienteActual = hyprland.get_clients().find(
          (cliente: any) => cliente.address === direccion,
        )
        // `fullscreen` es un modo, no un bool: 1 es MAXIMIZADO. Solo saltamos a
        // fullscreen de verdad si no lo está ya (con la guarda, toggle == poner).
        if (clienteActual && (clienteActual.fullscreen ?? 0) < PANTALLA_COMPLETA_REAL) {
          return execAsync(["hyprctl", "dispatch", "hl.dsp.window.fullscreen({mode='fullscreen', action='toggle'})"])
        }
      })
      .catch(() => {})
  }

  const cerrarJuego = (direccion: string) => {
    const direccionNormalizada = direccion.startsWith("0x") ? direccion : `0x${direccion}`
    execAsync(["hyprctl", "dispatch", `hl.dsp.window.close({window='address:${direccionNormalizada}'})`])
      .catch(() => {})
  }

  // Un botón por juego: icono real de la app y, con el clic derecho, sus acciones.
  // El <For> lo indexa por dirección, así que se construye una vez por ventana y
  // sobrevive a los cambios de título; nombre e icono llegan por accessor porque sí
  // cambian en vida (`describirJuego` cae al título cuando no hay entrada .desktop,
  // y la clase puede tardar en llegar — de ahí el reintento del registro).
  const BotonJuego = (direccion: string) => {
    let boton: Gtk.Widget | null = null
    let popoverActivo: Gtk.Popover | null = null
    const controlMenu = crearControlPopoverAnclado(visibilidad)
    const cierreAutomatico = panelAutoClose(() => {
      if (popoverActivo) popoverActivo.popdown()
    }, 250)
    const entrada = juegos((lista) =>
      lista.find((candidata) => candidata.direccion === direccion) ?? ENTRADA_AUSENTE,
    )

    const finalizarPopover = (popover: Gtk.Popover) => {
      if (popoverActivo === popover) {
        popoverActivo = null
        controlMenu.cerrar()
      }
      try { popover.unparent() } catch (_) {}
    }

    // Menú GTK nativo, como el menuModel de las apps en segundo plano. Así las
    // filas, estados de hover, tipografía y espaciado los pinta `.tray-popover`.
    const modeloMenu = new Gio.Menu()
    const grupoAcciones = new Gio.SimpleActionGroup()
    const agregarAccion = (nombre: string, etiqueta: string, ejecutar: () => void) => {
      modeloMenu.append(etiqueta, `game.${nombre}`)
      const accion = new Gio.SimpleAction({ name: nombre })
      accion.connect("activate", () => {
        ejecutar()
        if (popoverActivo) popoverActivo.popdown()
      })
      grupoAcciones.add_action(accion)
    }

    agregarAccion("focus", "󰊴  Ir al juego", () => enfocarJuego(direccion, false))
    agregarAccion("fullscreen", "󰊓  Pantalla completa", () => enfocarJuego(direccion, true))
    agregarAccion("close", "󰅖  Cerrar juego", () => cerrarJuego(direccion))

    const abrirMenu = () => {
      if (popoverActivo) { popoverActivo.popdown(); return }
      if (!boton) return
      const nuevoPopover = Gtk.PopoverMenu.new_from_model(modeloMenu)
      // Mismo patrón que los menús de las apps en segundo plano: sin autohide
      // nativo y con toda la superficie del popover dentro de la zona de hover.
      // Vigilar solo la tarjeta interior deja un hueco al salir del icono y el
      // temporizador la cierra antes de que el puntero pueda alcanzar las acciones.
      nuevoPopover.add_css_class("tray-popover")
      nuevoPopover.set_has_arrow(false)
      nuevoPopover.set_autohide(false)
      nuevoPopover.set_position(Gtk.PositionType.BOTTOM)
      // Igual que el menú de la bandeja: el icono va centrado en la barra, así
      // que sin este desplazamiento el menú nace pisándola (GtkPopover ignora el
      // `margin` CSS para posicionarse).
      nuevoPopover.set_offset(0, 8)
      // Un Gtk.Popover vive en una superficie GTK separada. Al crearlo y
      // parentarlo manualmente no siempre resuelve los grupos de acciones del
      // botón ancla, así que el grupo debe estar también en el propio popover.
      nuevoPopover.insert_action_group("game", grupoAcciones)
      nuevoPopover.set_parent(boton)

      const movimiento = new Gtk.EventControllerMotion()
      movimiento.connect("enter", () => cierreAutomatico.onEnter())
      movimiento.connect("leave", () => cierreAutomatico.onLeave())
      nuevoPopover.add_controller(movimiento)

      popoverActivo = nuevoPopover
      controlMenu.abrir()
      nuevoPopover.connect("closed", () => finalizarPopover(nuevoPopover))
      nuevoPopover.popup()
    }

    onCleanup(() => {
      cierreAutomatico.dispose()
      const popover = popoverActivo
      if (popover) {
        try { popover.popdown() } catch (_) {}
        finalizarPopover(popover)
      }
      controlMenu.cerrar()
      boton = null
    })

    return (
      <button
        $={(self: Gtk.Widget) => { boton = self }}
        cssClasses={["game-tray-icon"]}
        valign={Gtk.Align.CENTER}
        onClicked={() => enfocarJuego(direccion, true)}
        tooltipText={entrada((actual) => nombreParaAyuda(actual.nombre))}
      >
        {/* Botón secundario: Gtk.Button solo se queda el clic primario, así que este
            gesto sí llega (mismo motivo que el comentario de Actualizaciones). */}
        <Gtk.GestureClick button={3} onPressed={abrirMenu} />
        <Gtk.EventControllerMotion
          onEnter={cierreAutomatico.onEnter}
          onLeave={cierreAutomatico.onLeave}
        />
        {/* Las tres formas del icono conviven como ranuras y se alternan con
            `visible`. Elegirlas con un ternario ataba la forma al primer valor: con
            el botón ya indexado por dirección, un juego que empieza sin icono de
            tema y lo resuelve después se quedaba con el glifo genérico.
            Van dentro de un <box>: `Gtk.Button` admite UN solo hijo, así que
            colgadas del botón cada ranura sustituía a la anterior y solo quedaba
            la última (el glifo) — un juego con icono resoluble dejaba el botón
            literalmente vacío. */}
        <box valign={Gtk.Align.CENTER} halign={Gtk.Align.CENTER}>
          <image
            gicon={entrada((actual) => actual.iconoGio)}
            visible={entrada((actual) => !!actual.iconoGio)}
            pixelSize={18}
            cssClasses={["game-tray-img"]}
          />
          <image
            iconName={entrada((actual) => actual.iconoGio ? "" : (actual.nombreIcono ?? ""))}
            visible={entrada((actual) => !actual.iconoGio && !!actual.nombreIcono)}
            pixelSize={18}
            cssClasses={["game-tray-img"]}
          />
          <label
            cssClasses={["game-tray-glyph"]}
            label={GLIFO_JUEGO}
            visible={entrada((actual) => !actual.iconoGio && !actual.nombreIcono)}
          />
        </box>
      </button>
    )
  }

  return (
    <box
      cssClasses={["game-tray"]}
      visible={juegos((lista) => lista.length > 0)}
      valign={Gtk.Align.CENTER}
      spacing={4}
    >
      <box cssClasses={["game-tray-items"]} valign={Gtk.Align.CENTER} spacing={2}>
        {/* Indexado por dirección: sin `id`, un cambio de título de UN juego
            reconstruía el botón de TODOS (medido), porque el registro republica la
            lista entera y `<For>` compara por identidad de objeto. */}
        <For each={juegos} id={(entrada: EntradaJuego) => entrada.direccion}>
          {(entrada: EntradaJuego) => BotonJuego(entrada.direccion)}
        </For>
      </box>
    </box>
  )
}
