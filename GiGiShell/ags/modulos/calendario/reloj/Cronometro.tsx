import GLib from "gi://GLib"
import { Gtk } from "ags/gtk4"
import { onCleanup } from "ags"
import { cronometro, iniciarCronometro, pausarCronometro, reiniciarCronometro } from "./estadoReloj.ts"
import { formatearCronometro, msHastaSiguienteTickAscendente, transcurrido } from "./tiempos.ts"
import type { Visible } from "./visible.ts"

/**
 * Cronómetro.
 *
 * **El tick es solo presentación.** La medida sale de `transcurrido()` contra `Date.now()`, así que
 * el widget puede dejar de pintarse durante horas —sección oculta, panel cerrado, equipo
 * suspendido— y al volver enseña la cifra exacta. Por eso el tick se puede parar sin consecuencias,
 * y de hecho se para en cuanto la sección Reloj deja de verse: es el requisito de «ningún tick
 * visual con el panel oculto».
 *
 * Refresca a 10 Hz porque enseña décimas. Sin ellas bastaría 1 Hz, pero un cronómetro sin décimas
 * es un reloj.
 *
 * **El tick se realinea en cada vuelta**, como el del temporizador. Antes repetía con
 * `SOURCE_CONTINUE` cada 100 ms, y GLib mide ese intervalo desde que TERMINA el callback anterior:
 * el retraso de cada vuelta se acumulaba sobre la siguiente y las décimas se veían saltar de dos en
 * dos. Como la medida sale de `Date.now()`, la cifra nunca era incorrecta — solo se saltaba valores
 * a la vista, que en un cronómetro es justo lo que se está mirando.
 */
export function Cronometro({ visible }: { visible: Visible }): Gtk.Widget {
  const etiqueta = new Gtk.Label({ label: formatearCronometro(0) })
  etiqueta.set_css_classes(["reloj-crono-display"])

  const botonPrincipal = new Gtk.Button()
  botonPrincipal.set_css_classes(["cal-btn", "primario"])
  const etiquetaPrincipal = new Gtk.Label({ label: "Iniciar" })
  botonPrincipal.set_child(etiquetaPrincipal)

  const botonReiniciar = new Gtk.Button()
  botonReiniciar.set_css_classes(["cal-btn"])
  botonReiniciar.set_child(new Gtk.Label({ label: "Reiniciar" }))

  let tick: number | null = null

  const pintar = () =>
    etiqueta.set_label(formatearCronometro(transcurrido(cronometro.get(), Date.now())))

  function pararTick() {
    if (tick !== null) {
      GLib.source_remove(tick)
      tick = null
    }
  }

  function programarTick() {
    pararTick()
    const espera = msHastaSiguienteTickAscendente(transcurrido(cronometro.get(), Date.now()))
    tick = GLib.timeout_add(GLib.PRIORITY_DEFAULT, espera, () => {
      tick = null
      pintar()
      if (cronometro.get().estado === "corriendo" && visible.get()) programarTick()
      return GLib.SOURCE_REMOVE
    })
  }

  function sincronizar() {
    const estado = cronometro.get().estado
    etiquetaPrincipal.set_label(
      estado === "corriendo" ? "Pausar" : estado === "pausado" ? "Continuar" : "Iniciar",
    )
    if (estado === "corriendo" && visible.get()) {
      if (tick === null) programarTick()
    } else {
      pararTick()
    }
    // Se pinta siempre, también al ocultarse: así la etiqueta queda congelada en el valor real de
    // este instante y no en el del último tick que llegó a ejecutarse.
    pintar()
  }

  botonPrincipal.connect("clicked", () => {
    if (cronometro.get().estado === "corriendo") pausarCronometro()
    else iniciarCronometro()
  })
  botonReiniciar.connect("clicked", () => reiniciarCronometro())

  const bajas = [cronometro.subscribe(sincronizar), visible.subscribe(sincronizar)]
  onCleanup(() => {
    pararTick()
    for (const baja of bajas) if (typeof baja === "function") baja()
  })
  sincronizar()

  return (
    <box cssClasses={["reloj-tarjeta", "reloj-herramienta"]} orientation={Gtk.Orientation.VERTICAL} spacing={7} hexpand>
      <box spacing={6}>
        <label cssClasses={["reloj-tarjeta-icono"]} label="󰔟" />
        <label cssClasses={["reloj-tarjeta-titulo"]} label="Cronómetro" halign={Gtk.Align.START} />
      </box>
      {etiqueta}
      <box spacing={6} homogeneous>
        {botonPrincipal}
        {botonReiniciar}
      </box>
    </box>
  ) as unknown as Gtk.Widget
}
