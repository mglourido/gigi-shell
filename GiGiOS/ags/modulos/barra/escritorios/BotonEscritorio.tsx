import Gdk from "gi://Gdk"
import Graphene from "gi://Graphene"
import type { Accessor } from "ags"
import { createComputed, For, onCleanup } from "ags"
import { Gtk } from "ags/gtk4"
import { execAsync } from "ags/process"

import { titulosAppsWorkspaceActivos, workspaceAppLimit } from "../../ajustes/preferences"
import type { EscritorioVisible, IconoClienteEscritorio } from "./modelo"
import { claseAplicacionCssSegura, etiquetaEscritorio } from "./modelo"
import { enfocarEscritorio } from "../../../servicios/escritorios/operaciones"
import type { GestorVistaPreviaEscritorios } from "./gestorVistaPrevia"
import { tituloBarra } from "../componentes/tituloBarra"

export interface InteraccionesBotonEscritorio {
  cambiarArrastre: (arrastrando: boolean) => void
  adquirirTeclado: () => void
  liberarTeclado: () => void
}

// El <For> de Escritorios está indexado por id, así que este componente se
// construye UNA vez por escritorio y vive mientras ese id siga en la barra. De
// `escritorio` solo puede leerse lo que no cambia en toda esa vida —`id` (la propia
// clave) y `enfocar`, que solo depende del id—; los clientes llegan por accessor.
interface PropiedadesBotonEscritorio {
  escritorio: EscritorioVisible
  clientes: Accessor<IconoClienteEscritorio[]>
  overlay: Gtk.Overlay
  idEnfocado: Accessor<number>
  direccionEnfocada: Accessor<string>
  vistaPrevia: GestorVistaPreviaEscritorios
  vistaPreviaActiva: () => boolean
  rutaVistaPrevia: (idEscritorio: number) => string
  interacciones: InteraccionesBotonEscritorio
  alIntercambiar: (primerId: number, segundoId: number) => void
  alDesplazar: (idOrigen: number, idDestino: number) => void
  alRenumerar: (idOrigen: number, idDestino: number) => void
  obtenerEscritorios: () => readonly EscritorioVisible[]
}

function obtenerModificadores(gesto: Gtk.Gesture): number {
  return gesto.get_last_event(null)?.get_modifier_state() ?? 0
}

export default function BotonEscritorio({
  escritorio,
  clientes,
  overlay,
  idEnfocado,
  direccionEnfocada,
  vistaPrevia,
  vistaPreviaActiva,
  rutaVistaPrevia,
  interacciones,
  alIntercambiar,
  alDesplazar,
  alRenumerar,
  obtenerEscritorios,
}: PropiedadesBotonEscritorio) {
  let controlAlPulsar = false
  let eliminarInteraccion = () => {}

  // Depende de las DOS fuentes: la dirección enfocada cambia sin que se mueva la
  // lista (alt-tab dentro del escritorio), pero la lista también cambia sin que se
  // mueva el foco (reordenar ventanas), y entonces el índice del cliente activo es
  // otro. Colgarlo solo de `direccionEnfocada` dejaba el resaltado en la ventana
  // equivocada hasta el siguiente cambio de foco.
  const indiceClienteActivo = createComputed(() => {
    const direccion = direccionEnfocada()
    return clientes().findIndex((cliente) => cliente.direccion === direccion)
  })

  const alternarPantallaCompleta = (direccion: string) => {
    const direccionNormalizada = direccion.startsWith("0x") ? direccion : `0x${direccion}`
    // Formas Lua de los dispatchers legacy (workspace / focuswindow / fullscreen 0),
    // verificadas en instancia anidada; `mode='fullscreen'` + toggle = `fullscreen 0`.
    // El primer salto va por `enfocarEscritorio` y no por un `focus` a pelo: en un
    // escritorio especial el focus por id no hace nada (y responde `ok`), así que
    // el resto de la cadena caía sobre la ventana equivocada.
    enfocarEscritorio(escritorio.id, escritorio.nombre)
      .then(() => execAsync(["hyprctl", "dispatch", `hl.dsp.focus({window='address:${direccionNormalizada}'})`]))
      .then(() => execAsync(["hyprctl", "dispatch", "hl.dsp.window.fullscreen({mode='fullscreen', action='toggle'})"]))
      .catch(() => {})
  }

  const botonIcono = (indice: number) => (
    <button
      cssClasses={clientes((iconos) => [
        "ws-icon-btn",
        iconos[indice]?.esGlifo ? "ws-glyph-btn" : "ws-image-btn",
      ])}
      widthRequest={clientes((iconos) => iconos[indice]?.esGlifo ? 16 : 24)}
      visible={clientes((iconos) => indice < iconos.length)}
      // Función y no accessor: el texto —lo único que hay que construir para el
      // icono— se arma al abrir el título y no en cada señal de Hyprland. Vacío deja
      // el título sin abrir (títulos desactivados o icono ya sin cliente).
      $={(self: Gtk.Widget) => tituloBarra(self, () =>
        titulosAppsWorkspaceActivos.get() ? clientes()[indice]?.descripcion() : null)}
    >
      <Gtk.GestureClick
        button={Gdk.BUTTON_SECONDARY}
        onPressed={() => {
          const cliente = clientes()[indice]
          if (cliente) alternarPantallaCompleta(cliente.direccion)
        }}
      />
      <box
        cssClasses={indiceClienteActivo((indiceActivo) => {
          const cliente = clientes()[indice]
          return [
            "ws-icon-wrap",
            cliente?.esGlifo ? "ws-glyph-wrap" : "ws-image-wrap",
            indiceActivo === indice ? "active-client" : "",
          ].filter(Boolean)
        })}
        halign={Gtk.Align.CENTER}
        valign={Gtk.Align.CENTER}
        hexpand={false}
        vexpand={false}
      >
        <label
          cssClasses={clientes((iconos) => [
            "ws-icons",
            "ws-glyph-icon",
            iconos[indice]?.esGlifo
              ? `ws-glyph-${claseAplicacionCssSegura(iconos[indice].claseAplicacion)}`
              : "",
          ].filter(Boolean))}
          label={clientes((iconos) => iconos[indice]?.esGlifo ? iconos[indice].icono : "")}
          visible={clientes((iconos) => !!iconos[indice]?.esGlifo)}
          halign={Gtk.Align.CENTER}
          valign={Gtk.Align.CENTER}
        />
        <Gtk.Image
          cssClasses={["ws-app-icon", "ws-image-icon"]}
          gicon={clientes((iconos) => iconos[indice]?.iconoGio ?? null)}
          pixelSize={19}
          visible={clientes((iconos) => !!(
            iconos[indice] && !iconos[indice].esGlifo && iconos[indice].iconoGio
          ))}
          halign={Gtk.Align.CENTER}
          valign={Gtk.Align.CENTER}
        />
        <Gtk.Image
          cssClasses={["ws-app-icon", "ws-image-icon"]}
          iconName={clientes((iconos) =>
            iconos[indice]?.esGlifo ? "" : (iconos[indice]?.icono ?? "")
          )}
          pixelSize={19}
          visible={clientes((iconos) => !!(
            iconos[indice] && !iconos[indice].esGlifo && !iconos[indice].iconoGio
          ))}
          halign={Gtk.Align.CENTER}
          valign={Gtk.Align.CENTER}
        />
      </box>
    </button>
  )

  onCleanup(() => eliminarInteraccion())

  return (
    <box
      focusable
      cssClasses={idEnfocado((id) => id === escritorio.id ? ["ws-btn", "focused"] : ["ws-btn"])}
      valign={Gtk.Align.CENTER}
      $={(self) => {
        let inicioPulsacion = 0
        let temporizadorPreparado: ReturnType<typeof setTimeout> | null = null
        let arrastrando = false
        let seArrastro = false
        let renumeradoPendiente = false
        let temporizadorRenumerado: ReturnType<typeof setTimeout> | null = null
        let fantasma: Gtk.Box | null = null
        let xBase = 0
        let xAgarre = 0
        let desplazamientoPendiente = 0
        let idFotograma: number | null = null

        const limpiarPreparado = () => {
          if (temporizadorPreparado !== null) clearTimeout(temporizadorPreparado)
          temporizadorPreparado = null
          self.remove_css_class("ws-hold-ready")
        }

        const iniciarFantasma = () => {
          const [traducido, punto] = self.compute_point(
            overlay,
            new Graphene.Point({ x: 0, y: 0 }),
          )
          xBase = traducido ? punto.x : self.get_allocation().x
          self.set_opacity(0)
          fantasma = new Gtk.Box({
            css_classes: idEnfocado() === escritorio.id
              ? ["ws-btn", "focused", "ws-dragging", "ws-ghost"]
              : ["ws-btn", "ws-dragging", "ws-ghost"],
            halign: Gtk.Align.START,
            valign: Gtk.Align.CENTER,
            margin_start: xBase,
            can_target: false,
          })
          fantasma.append(new Gtk.Label({ label: etiquetaEscritorio(escritorio.id), css_classes: ["ws-id"] }))
          overlay.add_overlay(fantasma)

          let mitadAncho = 0
          idFotograma = self.add_tick_callback(() => {
            if (!arrastrando) {
              idFotograma = null
              return false
            }
            if (!fantasma) return true
            if (mitadAncho === 0 && fantasma.get_allocated_width() > 0)
              mitadAncho = fantasma.get_allocated_width() / 2
            fantasma.set_margin_start(
              xBase + xAgarre + desplazamientoPendiente - mitadAncho,
            )
            return true
          })
        }

        const detenerArrastre = () => {
          if (idFotograma !== null) self.remove_tick_callback(idFotograma)
          idFotograma = null
          if (fantasma) {
            try { fantasma.unparent() } catch (_) {}
            fantasma = null
          }
          self.set_opacity(1)
          self.remove_css_class("ws-dragging")
          if (arrastrando) interacciones.cambiarArrastre(false)
          arrastrando = false
        }

        const cancelarRenumerado = () => {
          if (!renumeradoPendiente) return
          renumeradoPendiente = false
          self.remove_css_class("ws-renumber-pending")
          if (temporizadorRenumerado !== null) clearTimeout(temporizadorRenumerado)
          temporizadorRenumerado = null
          interacciones.liberarTeclado()
        }

        const iniciarRenumerado = () => {
          if (renumeradoPendiente) return
          renumeradoPendiente = true
          self.add_css_class("ws-renumber-pending")
          interacciones.adquirirTeclado()
          self.grab_focus()
          temporizadorRenumerado = setTimeout(cancelarRenumerado, 3000)
        }

        const finalizarArrastre = (gesto: Gtk.Gesture, desplazamientoX: number) => {
          limpiarPreparado()
          inicioPulsacion = 0
          if (!arrastrando) return
          const paso = self.get_allocated_width() + 2
          const posiciones = Math.round(desplazamientoX / paso)
          const escritorios = obtenerEscritorios()
          const indiceActual = escritorios.findIndex((actual) => actual.id === escritorio.id)
          const indiceDestino = Math.max(
            0,
            Math.min(escritorios.length - 1, indiceActual + posiciones),
          )
          if (indiceActual >= 0 && indiceDestino !== indiceActual) {
            const controlPulsado = !!(
              obtenerModificadores(gesto) & Gdk.ModifierType.CONTROL_MASK
            )
            if (controlPulsado) alIntercambiar(escritorio.id, escritorios[indiceDestino].id)
            else alDesplazar(escritorio.id, escritorios[indiceDestino].id)
          }
          detenerArrastre()
        }

        const gestoPulsacion = new Gtk.GestureClick({ button: Gdk.BUTTON_PRIMARY })
        gestoPulsacion.set_propagation_phase(Gtk.PropagationPhase.CAPTURE)
        gestoPulsacion.connect("pressed", (gesto) => {
          inicioPulsacion = Date.now()
          seArrastro = false
          controlAlPulsar = !!(obtenerModificadores(gesto) & Gdk.ModifierType.CONTROL_MASK)
          temporizadorPreparado = setTimeout(() => {
            temporizadorPreparado = null
            self.add_css_class("ws-hold-ready")
          }, 300)
        })
        gestoPulsacion.connect("released", () => {
          limpiarPreparado()
          inicioPulsacion = 0
          if (seArrastro) return
          if (controlAlPulsar) iniciarRenumerado()
          else escritorio.enfocar()
        })
        self.add_controller(gestoPulsacion)

        const gestoArrastre = new Gtk.GestureDrag()
        gestoArrastre.set_propagation_phase(Gtk.PropagationPhase.CAPTURE)
        gestoArrastre.connect("drag-begin", (_gesto, xInicial) => { xAgarre = xInicial })
        gestoArrastre.connect("drag-update", (_gesto, desplazamientoX) => {
          if (!arrastrando) {
            if (Date.now() - inicioPulsacion < 300) return
            arrastrando = true
            seArrastro = true
            limpiarPreparado()
            self.add_css_class("ws-dragging")
            interacciones.cambiarArrastre(true)
            iniciarFantasma()
          }
          desplazamientoPendiente = Math.round(desplazamientoX)
        })
        gestoArrastre.connect("drag-end", (gesto, desplazamientoX) =>
          finalizarArrastre(gesto, desplazamientoX)
        )
        gestoArrastre.connect("cancel", () => {
          limpiarPreparado()
          inicioPulsacion = 0
          detenerArrastre()
        })
        self.add_controller(gestoArrastre)

        const controladorTeclado = new Gtk.EventControllerKey()
        controladorTeclado.connect("key-pressed", (_controlador, tecla) => {
          if (!renumeradoPendiente) return false
          if (tecla === Gdk.KEY_Escape) {
            cancelarRenumerado()
            return true
          }
          if (tecla >= Gdk.KEY_1 && tecla <= Gdk.KEY_9) {
            cancelarRenumerado()
            alRenumerar(escritorio.id, tecla - Gdk.KEY_0)
            return true
          }
          return false
        })
        self.add_controller(controladorTeclado)

        const controladorFoco = new Gtk.EventControllerFocus()
        controladorFoco.connect("leave", cancelarRenumerado)
        self.add_controller(controladorFoco)

        eliminarInteraccion = () => {
          limpiarPreparado()
          cancelarRenumerado()
          detenerArrastre()
        }
      }}
    >
      <button cssClasses={["ws-num-btn"]}>
        <Gtk.EventControllerMotion
          onEnter={vistaPrevia.alEntrar}
          onLeave={vistaPrevia.alSalir}
        />
        <Gtk.GestureClick
          button={Gdk.BUTTON_SECONDARY}
          onPressed={(gesto) => {
            if (!vistaPreviaActiva()) return
            vistaPrevia.mostrar(
              gesto.get_widget(),
              escritorio.id,
              rutaVistaPrevia(escritorio.id),
            )
          }}
        />
        <label cssClasses={["ws-id"]} label={etiquetaEscritorio(escritorio.id)} />
      </button>
      <revealer
        revealChild={clientes((iconos: IconoClienteEscritorio[]) => iconos.length > 0)}
        transitionType={Gtk.RevealerTransitionType.SLIDE_RIGHT}
        transitionDuration={250}
      >
        <box cssClasses={["ws-apps"]} spacing={0}>
          <For each={() => Array.from({ length: workspaceAppLimit() }, (_, indice) => indice)}>
            {(indice) => (
              <box spacing={0}>
                <box
                  cssClasses={["ws-icon-separator"]}
                  visible={clientes((iconos) => indice > 0 && indice < iconos.length)}
                />
                {botonIcono(indice)}
              </box>
            )}
          </For>
        </box>
      </revealer>
    </box>
  )
}
