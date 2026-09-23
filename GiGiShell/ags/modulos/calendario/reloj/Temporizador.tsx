import GLib from "gi://GLib"
import { Gtk } from "ags/gtk4"
import { onCleanup } from "ags"
import {
  cancelarTemporizador,
  continuarTemporizador,
  fijarDuracionTemporizador,
  iniciarTemporizador,
  pausarTemporizador,
  temporizador,
} from "./estadoReloj.ts"
import { crearCampoDuracion } from "../calendario/campos.tsx"
import { formatearRestante, msHastaSiguienteTick, restanteTemporizador } from "./tiempos.ts"
import type { Visible } from "./visible.ts"

/**
 * Temporizador.
 *
 * **El vencimiento y el repintado son cosas distintas.** Quien avisa es el temporizador de
 * `estadoReloj.ts`, armado contra un instante absoluto y vivo aunque el panel esté cerrado; lo de
 * aquí solo redibuja la cuenta atrás, y únicamente mientras la sección se ve. Cerrar el panel a
 * mitad de una cuenta de veinte minutos no la para: para el dibujo.
 *
 * El tick se realinea con `msHastaSiguienteTick` en vez de repetir cada 1000 ms desde un origen
 * arbitrario. Con un intervalo fijo, la cifra cambia a destiempo respecto al segundo real y se ve
 * saltar dos unidades cada minuto.
 *
 * **La cifra grande es un CAMPO EDITABLE mientras el temporizador está parado**, y una etiqueta en
 * cuanto arranca. Antes solo era etiqueta, y la única forma de elegir el tiempo era una rejilla de
 * seis presets (1, 5, 10, 15, 30 y 60 min): cualquier duración fuera de esa lista —1:30, 7 min,
 * 2 h— sencillamente no se podía pedir. La rejilla se retiró al llegar el campo; teclear la
 * duración cubre también los seis atajos, y dos entradas para el mismo dato solo añaden sitios
 * donde mirar.
 *
 * No son dos widgets alternándose por capricho: un `Gtk.SpinButton` visible en marcha invitaría a
 * teclear sobre una cuenta atrás que `fijarDuracion` deliberadamente no altera (ver `tiempos.ts`),
 * o sea a escribir en un sitio que no hace nada.
 */
export function Temporizador({ visible }: { visible: Visible }): Gtk.Widget {
  const display = new Gtk.Label({ label: "00:00" })
  display.set_css_classes(["reloj-temporizador-display"])

  // El campo escribe en el estado global, y el estado global vuelve por `sincronizar`. El bucle lo
  // corta la comparación de allí (solo se reescribe si el valor difiere), no un flag aparte: así el
  // campo no se pisa a sí mismo mientras se teclea, y un cambio venido de fuera sí lo mueve.
  const campoDuracion = crearCampoDuracion(
    temporizador.get().duracionMs,
    (ms) => fijarDuracionTemporizador(ms),
    { mostrarBotones: false },
  )
  campoDuracion.widget.set_css_classes(["cal-campo-duracion", "reloj-temporizador-campo"])
  campoDuracion.widget.set_halign(Gtk.Align.CENTER)

  const botonPrincipal = new Gtk.Button()
  botonPrincipal.set_css_classes(["cal-btn", "primario"])
  const etiquetaPrincipal = new Gtk.Label({ label: "Iniciar" })
  botonPrincipal.set_child(etiquetaPrincipal)

  const botonCancelar = new Gtk.Button()
  botonCancelar.set_css_classes(["cal-btn"])
  botonCancelar.set_child(new Gtk.Label({ label: "Cancelar" }))

  let tick: number | null = null

  const pintar = () =>
    display.set_label(formatearRestante(restanteTemporizador(temporizador.get(), Date.now())))

  function pararTick() {
    if (tick !== null) {
      GLib.source_remove(tick)
      tick = null
    }
  }

  function programarTick() {
    pararTick()
    const restante = restanteTemporizador(temporizador.get(), Date.now())
    tick = GLib.timeout_add(GLib.PRIORITY_DEFAULT, msHastaSiguienteTick(restante), () => {
      tick = null
      pintar()
      if (temporizador.get().estado === "corriendo" && visible.get()) programarTick()
      return GLib.SOURCE_REMOVE
    })
  }

  function sincronizar() {
    const t = temporizador.get()
    const parado = t.estado === "parado"

    if (parado && campoDuracion.obtener() !== t.duracionMs) campoDuracion.establecer(t.duracionMs)
    campoDuracion.widget.set_visible(parado)
    display.set_visible(!parado)

    etiquetaPrincipal.set_label(
      t.estado === "corriendo" ? "Pausar" : t.estado === "pausado" ? "Continuar" : "Iniciar",
    )
    botonCancelar.set_sensitive(t.estado !== "parado")
    botonPrincipal.set_sensitive(t.estado !== "parado" || t.duracionMs > 0)

    pintar()
    if (t.estado === "corriendo" && visible.get()) programarTick()
    else pararTick()
  }

  botonPrincipal.connect("clicked", () => {
    const estado = temporizador.get().estado
    if (estado === "corriendo") pausarTemporizador()
    else if (estado === "pausado") continuarTemporizador()
    else iniciarTemporizador()
  })
  botonCancelar.connect("clicked", () => cancelarTemporizador())

  const bajas = [temporizador.subscribe(sincronizar), visible.subscribe(sincronizar)]
  onCleanup(() => {
    pararTick()
    for (const baja of bajas) if (typeof baja === "function") baja()
  })
  sincronizar()

  return (
    <box cssClasses={["reloj-tarjeta", "reloj-herramienta"]} orientation={Gtk.Orientation.VERTICAL} spacing={7} hexpand>
      <box spacing={6}>
        <label cssClasses={["reloj-tarjeta-icono"]} label="󰔛" />
        <label cssClasses={["reloj-tarjeta-titulo"]} label="Temporizador" halign={Gtk.Align.START} />
      </box>
      {display}
      {campoDuracion.widget}
      <box spacing={6} homogeneous>
        {botonPrincipal}
        {botonCancelar}
      </box>
    </box>
  ) as unknown as Gtk.Widget
}
