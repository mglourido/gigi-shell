// Panel contextual de la derecha: acciones sobre la app seleccionada (abrir,
// editar config, fijar en Inicio, desinstalar). Sustituye la reserva
// `.orion-balance` derecha cuando está visible — ver el comentario de
// `panelInner` en `Orion.tsx` para el porqué de esa reserva simétrica.

import { Gtk } from "ags/gtk4"
import { execAsync } from "ags/process"
import GLib from "gi://GLib"
import {
  rightPanelApp, rightPanelVisible, hidePanel,
  suspenderPanel, reanudarPanel, descartarSuspension,
  type AppContextItem,
} from "../../state"
import { addFavorite, removeFavorite, isFavorite, favorites } from "../../data/favorites"
import { invalidarCatalogoApps } from "../../data/catalogo"
import { desinstalarApp } from "../../data/uninstall"
import { crearIconoApp } from "../shared/tarjetaApp"
import { vaciarCaja } from "../shared/gtkUtils"
import type {
  ElementoNavegacionBusqueda,
  NavegacionBusqueda,
} from "../shared/NavegacionBusqueda"

interface PropiedadesPanelDerecho {
  navegacion: NavegacionBusqueda
}

function guessConfigPath(execName: string, appId: string): string | null {
  const home = GLib.get_home_dir()
  for (const p of [
    `${home}/.config/${execName}`,
    `${home}/.config/${appId.replace(/\.desktop$/, "").split(".").pop() ?? ""}`,
    `${home}/.${execName}`,
  ]) {
    if (GLib.file_test(p, GLib.FileTest.EXISTS)) return p
  }
  return null
}

export default function RightPanel({ navegacion }: PropiedadesPanelDerecho) {
  const inner = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, cssClasses: ["rp-inner"] })
  let accionesActuales: ElementoNavegacionBusqueda[] = []

  function sincronizarAcciones(): void {
    navegacion.establecerAcciones(rightPanelVisible.get() ? accionesActuales : [])
  }

  function crearAccion(
    icono: string,
    etiqueta: string,
    alActivar: () => void,
    clasesExtra: string[] = [],
  ): { boton: Gtk.Button; navegable: ElementoNavegacionBusqueda } {
    const boton = new Gtk.Button({ cssClasses: ["rp-action", ...clasesExtra] })
    const fila = new Gtk.Box({ spacing: 9, cssClasses: ["rp-action-row"] })
    fila.append(new Gtk.Image({ iconName: icono, pixelSize: 14, cssClasses: ["rp-action-ico"] }))
    fila.append(new Gtk.Label({ label: etiqueta, halign: Gtk.Align.START, hexpand: true, cssClasses: ["rp-action-label"] }))
    boton.set_child(fila)
    const navegable: ElementoNavegacionBusqueda = {
      marcarSeleccionado: (seleccionado) => {
        if (seleccionado) boton.add_css_class("seleccionado")
        else boton.remove_css_class("seleccionado")
      },
      enfocar: () => boton.grab_focus(),
      activar: alActivar,
    }
    boton.connect("notify::has-focus", () => {
      if (boton.has_focus) navegacion.seleccionarAccion(navegable)
    })
    boton.connect("clicked", () => {
      navegacion.seleccionarAccion(navegable)
      alActivar()
    })
    return { boton, navegable }
  }

  /**
   * Desinstalar APARTA ORION PRIMERO, y no es solo por quitarse de en medio: el
   * diálogo de contraseña de polkit es una ventana normal y Orion es una
   * layer-shell `OVERLAY`, capa que va por encima de todas las ventanas
   * normales por definición del protocolo. Con Orion en pantalla el diálogo
   * sale **debajo** y hay que cerrar Orion a mano para poder escribir.
   *
   * Se aparta con `suspenderPanel()` y NO con `hidePanel()`: cerrar de verdad
   * vacía la búsqueda y devuelve la sección a Inicio (salvo con
   * `orionRecordarUltimaSeccion` activado), y aquí el usuario no ha pedido salir
   * de ningún sitio — se le está quitando la vista por un motivo técnico. Al
   * terminar se repone donde estaba.
   *
   * No hay pantalla de confirmación: la confirmación es el propio diálogo de
   * contraseña, que no se puede saltar. El resultado —incluido el motivo cuando
   * no se puede— lo cuenta la notificación del script, que sigue viva cuando
   * Orion ya no lo está.
   */
  function desinstalar(app: AppContextItem) {
    const suspendido = suspenderPanel()
    desinstalarApp({
      appId: app.appId,
      desktopFile: app.desktopFile ?? "",
      execRaw: app.execRaw,
      name: app.name,
    }).then((resultado) => {
      // `externo` (Steam) no es un éxito: el juego sigue instalado hasta que el
      // usuario confirme en la ventana de Steam, y de eso no nos vamos a
      // enterar. Así que ni se toca el favorito ni se repone Orion — que es una
      // layer OVERLAY y taparía justo el diálogo donde hay que decidir. La foto
      // se descarta explícitamente: olvidarla dejaría a Orion sin limpiar su
      // estado en todos los cierres siguientes.
      if (resultado === "externo") {
        if (suspendido) descartarSuspension()
        return
      }

      if (resultado === "ok") {
        // Un favorito que apunta a algo desinstalado es un tile que no abre
        // nada. `appResolver` no lo salvaría: buscaría una variante del binario
        // y aquí no hay ninguna, la app ya no está.
        if (isFavorite(app.appId)) removeFavorite(app.appId)
        invalidarCatalogoApps()
      }
      // La ficha del panel derecho solo se suelta si la app ha dejado de
      // existir; tras cancelar el diálogo de contraseña se repone tal cual, que
      // es lo que espera quien se ha arrepentido a medias.
      if (suspendido) reanudarPanel({ soltarApp: resultado === "ok" })
    })
  }

  function rebuild() {
    const app = rightPanelApp.get()
    vaciarCaja(inner)
    accionesActuales = []
    if (!app) {
      sincronizarAcciones()
      return
    }

    // ── Header ───────────────────────────────────────────────────────────────
    const header = new Gtk.Box({ cssClasses: ["rp-header"], spacing: 10 })
    const eyebrow = new Gtk.Label({ label: "APLICACIÓN", cssClasses: ["rp-eyebrow"], halign: Gtk.Align.START })
    inner.append(eyebrow)
    const headerIcon = crearIconoApp(app.gicon, app.iconName, 22)
    headerIcon.set_css_classes(["rp-app-icon"])
    const iconWrap = new Gtk.Box({ cssClasses: ["rp-app-icon-wrap"], halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER })
    iconWrap.append(headerIcon)
    header.append(iconWrap)
    header.append(new Gtk.Label({
      label: app.name, halign: Gtk.Align.START, hexpand: true,
      cssClasses: ["rp-app-name"], ellipsize: 3, maxWidthChars: 13,
    }))
    inner.append(header)
    inner.append(new Gtk.Box({ cssClasses: ["j-hdiv"] }))

    // ── Actions ───────────────────────────────────────────────────────────────
    const acts = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, cssClasses: ["rp-actions"] })
    const agregarAccion = (
      icono: string, etiqueta: string, alActivar: () => void, clases: string[] = [],
    ) => {
      const { boton, navegable } = crearAccion(icono, etiqueta, alActivar, clases)
      acts.append(boton)
      accionesActuales.push(navegable)
    }

    agregarAccion("media-playback-start-symbolic", "Abrir", () => {
      app.launch()
      hidePanel()
    })

    agregarAccion("document-edit-symbolic", "Editar config", () => {
      const p = guessConfigPath(app.execName, app.appId)
      execAsync(p
        ? ["xdg-open", p]
        : ["kitty", "--", "bash", "-c", `echo 'No config para ${app.execName}'; sleep 3`]
      ).catch(() => {})
      hidePanel()
    })

    const pinned = isFavorite(app.appId)
    agregarAccion(
      pinned ? "starred-symbolic" : "non-starred-symbolic",
      pinned ? "Desfijar" : "Fijar en inicio",
      () => {
        if (isFavorite(app.appId)) removeFavorite(app.appId)
        else addFavorite({ id: app.appId, name: app.name, exec: app.execName, iconName: app.iconName })
        rebuild()
      }
    )

    // Va la última y separada del resto: es la única acción de este panel que no
    // tiene vuelta atrás, y ponerla pegada a "Fijar en inicio" la dejaba a un
    // píxel de distancia de una acción trivial.
    acts.append(new Gtk.Box({ cssClasses: ["rp-action-sep"] }))
    agregarAccion("user-trash-symbolic", "Desinstalar", () => desinstalar(app), ["destructiva"])

    inner.append(acts)
    sincronizarAcciones()
  }

  // Al teclear en el buscador, cada tecla resuelta puede volver a proponer la
  // MISMA app como primer resultado (`setQuery` en `../../state.ts` llama a
  // `showAppContext` en cada resolución): sin esta guarda, `rebuild()`
  // vaciaba y reconstruía el panel entero (cabecera + 4 acciones) aunque no
  // hubiera nada que cambiara en pantalla. `favorites.subscribe` sigue yendo
  // directo a `rebuild()`, sin pasar por aquí: un fijado/desfijado tiene que
  // reflejarse aunque la app no haya cambiado.
  let ultimaAppId: string | null = null
  function sincronizarApp() {
    const app = rightPanelApp.get()
    if (app && app.appId === ultimaAppId) return
    ultimaAppId = app?.appId ?? null
    rebuild()
  }

  rightPanelApp.subscribe(sincronizarApp)
  rightPanelVisible.subscribe(sincronizarAcciones)
  favorites.subscribe(rebuild)
  sincronizarApp()

  return (
    <box
      cssClasses={["right-panel"]}
      orientation={Gtk.Orientation.VERTICAL}
      visible={rightPanelVisible(v => v)}
    >
      {inner as unknown as any}
    </box>
  )
}
