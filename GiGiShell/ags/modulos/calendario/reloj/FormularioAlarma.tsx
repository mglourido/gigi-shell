import { Gtk } from "ags/gtk4"
import { hoyISO } from "../dominio/fechas.ts"
import { crearCampoFecha, crearCampoHora } from "../calendario/campos.tsx"
import { actualizarAlarma, anadirAlarma, generarIdAlarma } from "./estadoReloj.ts"
import { crearCampoRutaAudio } from "../../notificaciones/sonido/CampoRutaAudio.ts"
import type { Alarma, DiaSemana } from "./tipos.ts"

const NOMBRES_DIA = ["L", "M", "X", "J", "V", "S", "D"]

/**
 * Editor de alarmas.
 *
 * Igual que el de eventos, **no es reactivo respecto al estado global**: se construye con una copia
 * y solo escribe al guardar. Reconstruirse desde el manejador de un campo con el foco dentro es el
 * patrón que ya costó un SIGSEGV en este proyecto (ver `ags/CLAUDE.md`).
 *
 * El tipo de alarma se decide por los días marcados y no por un selector aparte: marcar días es
 * exactamente lo que significa «que se repita», y un selector «puntual/semanal» que hay que
 * mantener de acuerdo con los días es un estado que puede contradecirse.
 */
export function FormularioAlarma({
  alarma,
  alCerrar,
}: {
  alarma: Alarma | null
  alCerrar: () => void
}): Gtk.Widget {
  const editando = alarma !== null
  const diasIniciales = new Set<DiaSemana>(alarma?.tipo === "semanal" ? alarma.dias : [])
  const fechaInicial = alarma?.tipo === "puntual" ? alarma.fecha : hoyISO()

  let hora = alarma?.hora ?? "07:00"
  let fecha = fechaInicial

  const entradaEtiqueta = new Gtk.Entry({ text: alarma?.etiqueta ?? "" })
  entradaEtiqueta.set_css_classes(["cal-form-entry"])
  entradaEtiqueta.set_placeholder_text("Etiqueta (opcional)")
  entradaEtiqueta.set_hexpand(true)

  const campoHora = crearCampoHora(hora, (h) => {
    hora = h
  }, { mostrarBotones: false })
  const campoFecha = crearCampoFecha(fecha, (f) => {
    fecha = f
  }, { mostrarBotones: false })

  // Sonido propio. Vacío = el sonido de alarma del tema, que es lo que sonaba siempre hasta ahora.
  const campoSonido = crearCampoRutaAudio({
    valor: alarma?.sonido,
    marcador: "~/GiGiShell/audio/alarm-clock-elapsed.oga  ·  vacío = sonido por defecto",
    etiquetaProbar: "Probar",
    ayudaProbar: "Reproducir este audio ahora",
    avisoNoExiste: "Ese fichero no existe ahora mismo. Se guarda igual, pero no sonará hasta que esté.",
  })

  const filaFecha = (
    <box cssClasses={["cal-form-row", "reloj-alarma-fila-fecha"]} spacing={8}>
      <label cssClasses={["cal-form-label"]} label="Fecha" halign={Gtk.Align.START} valign={Gtk.Align.CENTER} />
      <box hexpand />
      {campoFecha.widget}
    </box>
  ) as unknown as Gtk.Widget

  const filaDias = new Gtk.Box({ spacing: 2, halign: Gtk.Align.END })
  filaDias.set_css_classes(["reloj-dias"])
  const botonesDia = new Map<DiaSemana, Gtk.ToggleButton>()

  function actualizarVisibilidadFecha() {
    // Con días marcados la alarma es semanal y la fecha deja de tener sentido: se oculta en vez de
    // dejarla puesta y que el usuario crea que la limita a ese día.
    filaFecha.set_visible(diasIniciales.size === 0)
  }

  for (let d = 0 as DiaSemana; d <= 6; d = (d + 1) as DiaSemana) {
    const dia = d
    const boton = new Gtk.ToggleButton({ active: diasIniciales.has(dia) })
    boton.set_css_classes(["reloj-dia"])
    boton.set_child(new Gtk.Label({ label: NOMBRES_DIA[dia] }))
    boton.connect("toggled", () => {
      if (boton.get_active()) diasIniciales.add(dia)
      else diasIniciales.delete(dia)
      actualizarVisibilidadFecha()
    })
    botonesDia.set(dia, boton)
    filaDias.append(boton)
  }
  actualizarVisibilidadFecha()

  function guardar() {
    const etiqueta = entradaEtiqueta.get_text().trim()
    const dias = [...diasIniciales].sort((a, b) => a - b)
    const sonido = campoSonido.obtener()
    // `undefined` y no `""`: el planificador decide el sonido por defecto con `?? SONIDO_ALARMA`,
    // y una cadena vacía pasaría esa guarda y dejaría la alarma muda.
    const base = { etiqueta, hora, activa: alarma?.activa ?? true, sonido: sonido === "" ? undefined : sonido }
    const nueva: Alarma =
      dias.length > 0
        ? { ...base, id: alarma?.id ?? generarIdAlarma(), tipo: "semanal", dias }
        : { ...base, id: alarma?.id ?? generarIdAlarma(), tipo: "puntual", fecha }

    if (editando) {
      // Se reemplaza el objeto entero y no un parche: cambiar de puntual a semanal cambia los
      // campos que existen, y un `{...vieja, ...parche}` dejaría un `fecha` huérfano dentro de una
      // alarma semanal, que al releerla del disco volvería a decidir mal el tipo.
      actualizarAlarma(alarma!.id, nueva)
    } else {
      anadirAlarma(nueva)
    }
    alCerrar()
  }

  const botonGuardar = new Gtk.Button()
  botonGuardar.set_css_classes(["cal-btn", "primario"])
  botonGuardar.set_child(new Gtk.Label({ label: editando ? "Guardar" : "Crear alarma" }))
  botonGuardar.connect("clicked", guardar)
  entradaEtiqueta.connect("activate", guardar)

  return (
    <box
      cssClasses={["cal-dialog-backdrop", "cal-dialog-alarma-backdrop"]}
      hexpand
      vexpand
      halign={Gtk.Align.FILL}
      valign={Gtk.Align.FILL}
    >
      <box
        cssClasses={["cal-dialog-card", "cal-dialog-alarma"]}
        orientation={Gtk.Orientation.VERTICAL}
        spacing={8}
        halign={Gtk.Align.CENTER}
        valign={Gtk.Align.CENTER}
      >
        <box cssClasses={["reloj-alarma-datos"]} spacing={7}>
          <box cssClasses={["reloj-alarma-campo-hora"]} valign={Gtk.Align.CENTER}>
            {campoHora.widget}
          </box>
          {entradaEtiqueta}
        </box>

        <box cssClasses={["cal-form-row", "reloj-alarma-repeticion"]} orientation={Gtk.Orientation.VERTICAL} spacing={4}>
          <box spacing={8}>
            <label cssClasses={["cal-form-label"]} label="Repetir" halign={Gtk.Align.START} valign={Gtk.Align.CENTER} />
            <box hexpand />
            {filaDias}
          </box>
          <label
            cssClasses={["reloj-ayuda"]}
            label="Sin días seleccionados, sonará una sola vez"
            halign={Gtk.Align.START}
          />
        </box>

        {filaFecha}

        <box cssClasses={["cal-form-row", "reloj-alarma-sonido"]} orientation={Gtk.Orientation.VERTICAL} spacing={4}>
          <label cssClasses={["cal-form-label"]} label="Sonido" halign={Gtk.Align.START} />
          {campoSonido.widget}
        </box>

        <box cssClasses={["cal-dialog-actions", "cal-dialog-alarma-actions"]} spacing={7} halign={Gtk.Align.END}>
          <button cssClasses={["cal-btn"]} onClicked={alCerrar}>
            <label label="Cancelar" />
          </button>
          {botonGuardar}
        </box>
      </box>
    </box>
  ) as unknown as Gtk.Widget
}
