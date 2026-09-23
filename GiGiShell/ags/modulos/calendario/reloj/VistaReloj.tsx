import GLib from "gi://GLib"
import { Gtk } from "ags/gtk4"
import { createState, onCleanup } from "ags"
import { formatearFechaLarga } from "../dominio/fechas.ts"
import { hoyReactivo } from "../estado.ts"
import { Cronometro } from "./Cronometro.tsx"
import { FormularioAlarma } from "./FormularioAlarma.tsx"
import { ListaAlarmas } from "./ListaAlarmas.tsx"
import { Temporizador } from "./Temporizador.tsx"
import type { Alarma } from "./tipos.ts"
import type { Visible } from "./visible.ts"

/**
 * Sección Reloj: hora, alarmas, temporizador y cronómetro.
 *
 * **El reloj grande se alinea con el cambio real de segundo**, no con un intervalo de 1000 ms
 * arrancado en un momento cualquiera: con lo segundo, la cifra salta a destiempo y de vez en cuando
 * se salta un valor. Y como todos los ticks de esta sección, solo existe mientras se ve.
 *
 * **La fecha larga NO cuelga de ese tick.** Colgaba, y eso significaba un `new Date`, un parseo con
 * expresión regular y una cadena nueva **cada segundo y en cada monitor** para un valor que cambia
 * una vez al día. Va por `hoyReactivo`, que se mueve con el tic global al minuto y solo avisa
 * cuando la fecha cambia de verdad — así además la fecha se corrige sola a medianoche con el panel
 * abierto, que antes tampoco pasaba.
 */
export function VistaReloj({ visible }: { visible: Visible }): Gtk.Widget {
  const [editandoAlarma, establecerEditandoAlarma] = createState<{ alarma: Alarma | null } | null>(null)

  const horaGrande = new Gtk.Label({ label: "" })
  horaGrande.set_css_classes(["reloj-hora-grande"])

  const fechaHoy = new Gtk.Label({ label: "" })
  fechaHoy.set_css_classes(["reloj-fecha"])

  let tick: number | null = null

  function pintarHora() {
    const ahora = GLib.DateTime.new_now_local()
    horaGrande.set_label(ahora.format("%H:%M:%S") ?? "")
  }

  const pintarFecha = () => fechaHoy.set_label(formatearFechaLarga(hoyReactivo.get()))

  function pararTick() {
    if (tick !== null) {
      GLib.source_remove(tick)
      tick = null
    }
  }

  function programarTick() {
    pararTick()
    // Al próximo segundo de pared, no dentro de 1000 ms.
    const desfase = 1000 - (Date.now() % 1000)
    tick = GLib.timeout_add(GLib.PRIORITY_DEFAULT, desfase, () => {
      tick = null
      pintarHora()
      if (visible.get()) programarTick()
      return GLib.SOURCE_REMOVE
    })
  }

  function sincronizar() {
    pintarHora()
    if (visible.get()) programarTick()
    else pararTick()
  }

  const bajas = [visible.subscribe(sincronizar), hoyReactivo.subscribe(pintarFecha)]
  onCleanup(() => {
    pararTick()
    for (const baja of bajas) if (typeof baja === "function") baja()
  })
  pintarFecha()
  sincronizar()

  const listaAlarmas = ListaAlarmas({
    visible,
    alEditar: (alarma) => establecerEditandoAlarma({ alarma }),
  })

  const contenido = (
    <box orientation={Gtk.Orientation.VERTICAL} spacing={8} cssClasses={["reloj-vista"]}>
      <box spacing={10} cssClasses={["reloj-cabecera"]}>
        {horaGrande}
        <box hexpand />
        <box valign={Gtk.Align.CENTER}>{fechaHoy}</box>
      </box>

      <box homogeneous spacing={8} cssClasses={["reloj-herramientas"]}>
        {Temporizador({ visible })}
        {Cronometro({ visible })}
      </box>

      <box
        cssClasses={["reloj-tarjeta", "reloj-tarjeta-alarmas"]}
        orientation={Gtk.Orientation.VERTICAL}
        vexpand
      >
        <box cssClasses={["reloj-alarmas-cabecera"]} spacing={7}>
          <label cssClasses={["reloj-tarjeta-icono"]} label="󰀠" />
          <label cssClasses={["reloj-tarjeta-titulo"]} label="Alarmas" hexpand halign={Gtk.Align.START} />
          <button
            cssClasses={["cal-btn", "primario", "reloj-nueva-alarma"]}
            valign={Gtk.Align.CENTER}
            onClicked={() => establecerEditandoAlarma({ alarma: null })}
          >
            <box spacing={4} valign={Gtk.Align.CENTER}>
              <label cssClasses={["reloj-nueva-alarma-icono"]} label="＋" />
              <label label="Nueva" />
            </box>
          </button>
        </box>
        <Gtk.ScrolledWindow
          vexpand
          hscrollbarPolicy={Gtk.PolicyType.NEVER}
          cssClasses={["reloj-alarmas-scroll"]}
        >
          {listaAlarmas}
        </Gtk.ScrolledWindow>
      </box>
    </box>
  ) as unknown as Gtk.Widget

  // El formulario se monta y desmonta con un overlay propio en vez de vivir siempre oculto: así sus
  // widgets no existen mientras no se edita nada, igual que en el editor de eventos.
  const overlay = new Gtk.Overlay()
  overlay.set_child(contenido)

  let formularioVivo: Gtk.Widget | null = null
  function sincronizarFormulario() {
    const estado = editandoAlarma.get()
    if (formularioVivo) {
      overlay.remove_overlay(formularioVivo)
      formularioVivo = null
    }
    if (estado) {
      formularioVivo = FormularioAlarma({
        alarma: estado.alarma,
        alCerrar: () => establecerEditandoAlarma(null),
      })
      // El fondo oscurecido se estira A MANO: un hijo de `Gtk.Overlay` se mide por su tamaño
      // natural, así que sin esto el velo solo cubría la tarjeta y el resto del panel seguía
      // pareciendo pulsable.
      formularioVivo.set_hexpand(true)
      formularioVivo.set_vexpand(true)
      formularioVivo.set_halign(Gtk.Align.FILL)
      formularioVivo.set_valign(Gtk.Align.FILL)
      overlay.add_overlay(formularioVivo)
    }
  }
  // Igual que el editor de eventos: `subscribe` solo avisa de los cambios, así que el estado
  // inicial hay que aplicarlo a mano.
  const bajaFormulario = editandoAlarma.subscribe(sincronizarFormulario)
  sincronizarFormulario()
  onCleanup(() => {
    if (typeof bajaFormulario === "function") bajaFormulario()
  })

  return overlay as unknown as Gtk.Widget
}
