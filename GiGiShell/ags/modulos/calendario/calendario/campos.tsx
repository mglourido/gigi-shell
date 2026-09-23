import { Gtk } from "ags/gtk4"
import { aFechaISO, desdeFechaISO, diasEnMes, horaAMinutos, minutosAHora } from "../dominio/fechas.ts"

/**
 * Controles estructurados de fecha y hora.
 *
 * **No son cajas de texto libres.** Un `Gtk.Entry` donde el usuario teclea «31/02» obliga a validar
 * después y a explicar el error; un `Gtk.SpinButton` por campo no permite construir la fecha
 * imposible en primer lugar — el selector de día se recorta al mes elegido, así que pasar de marzo
 * a febrero con el día 31 puesto lo baja a 28 (o 29) solo.
 *
 * Ninguno de estos widgets se **reconstruye** al cambiar de valor: notifican hacia arriba y el
 * formulario guarda el dato en un borrador local. Reconstruir un campo desde su propio manejador de
 * cambio es exactamente lo que provocó el SIGSEGV de las franjas horarias (ver `ags/CLAUDE.md`).
 */

function spin(
  min: number,
  max: number,
  valor: number,
  ancho: number,
  mostrarBotones: boolean,
): Gtk.SpinButton {
  const s = Gtk.SpinButton.new_with_range(min, max, 1)
  s.set_value(valor)
  s.set_numeric(true)
  s.set_wrap(false)
  s.set_alignment(0.5)
  s.set_width_chars(ancho)
  s.set_css_classes(["cal-spin"])
  if (!mostrarBotones) {
    // GtkSpinButton conserva la validación numérica aunque se oculten sus botones. Recorremos sus
    // hijos en vez de hacerlos transparentes con CSS: un botón invisible seguiría capturando clics
    // y mantendría justo la función que se quiere retirar.
    let hijo = s.get_first_child()
    while (hijo) {
      const siguiente = hijo.get_next_sibling()
      if (hijo instanceof Gtk.Button) hijo.set_visible(false)
      hijo = siguiente
    }
    s.add_css_class("sin-botones")
    s.add_css_class(ancho === 4 ? "cuatro-digitos" : "dos-digitos")
  }
  return s
}

interface OpcionesCampoNumerico {
  mostrarBotones?: boolean
}

/** Dos dígitos siempre: sin esto la hora se lee «9:5» y no cuadra con el resto de la interfaz. */
function rellenarDosDigitos(s: Gtk.SpinButton) {
  s.connect("output", () => {
    s.set_text(String(s.get_value_as_int()).padStart(2, "0"))
    return true
  })
}

export interface CampoFecha {
  widget: Gtk.Widget
  obtener: () => string
  establecer: (iso: string) => void
}

export function crearCampoFecha(
  inicial: string,
  alCambiar: (iso: string) => void,
  { mostrarBotones = true }: OpcionesCampoNumerico = {},
): CampoFecha {
  const partes = desdeFechaISO(inicial) ?? { anio: 2026, mes: 1, dia: 1 }

  const dia = spin(1, 31, partes.dia, 2, mostrarBotones)
  const mes = spin(1, 12, partes.mes, 2, mostrarBotones)
  const anio = spin(1970, 2100, partes.anio, 4, mostrarBotones)

  let silenciado = false

  const leer = () => aFechaISO(anio.get_value_as_int(), mes.get_value_as_int(), Math.min(
    dia.get_value_as_int(),
    diasEnMes(anio.get_value_as_int(), mes.get_value_as_int()),
  ))

  function ajustarTopeDia() {
    // El tope del día depende del mes y del año (febrero bisiesto). Se reajusta el rango, no se
    // valida a posteriori: así el 31 de marzo pasa a 28 al elegir febrero, sin mensaje de error.
    const tope = diasEnMes(anio.get_value_as_int(), mes.get_value_as_int())
    const actual = dia.get_value_as_int()
    dia.set_range(1, tope)
    if (actual > tope) dia.set_value(tope)
  }

  const notificar = () => {
    if (silenciado) return
    ajustarTopeDia()
    alCambiar(leer())
  }

  for (const s of [dia, mes, anio]) s.connect("value-changed", notificar)
  ajustarTopeDia()

  const widget = (
    <box cssClasses={["cal-campo-fecha"]} spacing={mostrarBotones ? 3 : 1}>
      {dia}
      <label cssClasses={["cal-campo-sep"]} label="/" />
      {mes}
      <label cssClasses={["cal-campo-sep"]} label="/" />
      {anio}
    </box>
  ) as unknown as Gtk.Widget

  return {
    widget,
    obtener: leer,
    establecer: (iso: string) => {
      const p = desdeFechaISO(iso)
      if (!p) return
      silenciado = true
      anio.set_value(p.anio)
      mes.set_value(p.mes)
      ajustarTopeDia()
      dia.set_value(p.dia)
      silenciado = false
    },
  }
}

export interface CampoHora {
  widget: Gtk.Widget
  obtener: () => string
  establecer: (hora: string) => void
  setSensible: (v: boolean) => void
}

export function crearCampoHora(
  inicial: string,
  alCambiar: (hora: string) => void,
  { mostrarBotones = true }: OpcionesCampoNumerico = {},
): CampoHora {
  const minutosIniciales = Math.max(0, horaAMinutos(inicial))
  const horas = spin(0, 23, Math.floor(minutosIniciales / 60), 2, mostrarBotones)
  const minutos = spin(0, 59, minutosIniciales % 60, 2, mostrarBotones)
  rellenarDosDigitos(horas)
  rellenarDosDigitos(minutos)

  let silenciado = false
  const leer = () => minutosAHora(horas.get_value_as_int() * 60 + minutos.get_value_as_int())
  const notificar = () => {
    if (!silenciado) alCambiar(leer())
  }
  horas.connect("value-changed", notificar)
  minutos.connect("value-changed", notificar)

  const widget = (
    <box cssClasses={["cal-campo-hora"]} spacing={mostrarBotones ? 3 : 1}>
      {horas}
      <label cssClasses={["cal-campo-sep"]} label=":" />
      {minutos}
    </box>
  ) as unknown as Gtk.Widget

  return {
    widget,
    obtener: leer,
    establecer: (hora: string) => {
      const total = horaAMinutos(hora)
      if (total < 0) return
      silenciado = true
      horas.set_value(Math.floor(total / 60))
      minutos.set_value(total % 60)
      silenciado = false
    },
    setSensible: (v: boolean) => {
      horas.set_sensitive(v)
      minutos.set_sensitive(v)
      widget.set_opacity(v ? 1 : 0.4)
    },
  }
}

export interface CampoDuracion {
  widget: Gtk.Widget
  obtener: () => number
  establecer: (ms: number) => void
  setSensible: (v: boolean) => void
}

/**
 * Duración `HH:MM:SS` editable, en milisegundos.
 *
 * Es un campo de DURACIÓN, no de hora del día, y por eso no reutiliza `crearCampoHora`: aquel
 * cuenta minutos desde medianoche y no tiene segundos, que es justo la unidad que hace falta para
 * un temporizador de «1:30».
 *
 * Los segundos **no dan la vuelta** (`set_wrap(false)` en `spin`): pasar de 59 a 00 sin sumar un
 * minuto convertiría un intento de subir la cuenta en una bajada de casi un minuto, en silencio.
 * Subir de tramo es explícito, cambiando el campo de al lado.
 */
export function crearCampoDuracion(
  inicialMs: number,
  alCambiar: (ms: number) => void,
  { mostrarBotones = true }: OpcionesCampoNumerico = {},
): CampoDuracion {
  const totalSegundos = Math.min(23 * 3600 + 59 * 60 + 59, Math.max(0, Math.round(inicialMs / 1000)))

  const horas = spin(0, 23, Math.floor(totalSegundos / 3600), 2, mostrarBotones)
  const minutos = spin(0, 59, Math.floor((totalSegundos % 3600) / 60), 2, mostrarBotones)
  const segundos = spin(0, 59, totalSegundos % 60, 2, mostrarBotones)
  for (const s of [horas, minutos, segundos]) rellenarDosDigitos(s)

  let silenciado = false
  const leer = () =>
    (horas.get_value_as_int() * 3600 + minutos.get_value_as_int() * 60 + segundos.get_value_as_int()) *
    1000
  const notificar = () => {
    if (!silenciado) alCambiar(leer())
  }
  for (const s of [horas, minutos, segundos]) s.connect("value-changed", notificar)

  const widget = (
    <box cssClasses={["cal-campo-duracion"]} spacing={mostrarBotones ? 3 : 1}>
      {horas}
      <label cssClasses={["cal-campo-sep"]} label=":" />
      {minutos}
      <label cssClasses={["cal-campo-sep"]} label=":" />
      {segundos}
    </box>
  ) as unknown as Gtk.Widget

  return {
    widget,
    obtener: leer,
    establecer: (ms: number) => {
      const total = Math.min(23 * 3600 + 59 * 60 + 59, Math.max(0, Math.round(ms / 1000)))
      silenciado = true
      horas.set_value(Math.floor(total / 3600))
      minutos.set_value(Math.floor((total % 3600) / 60))
      segundos.set_value(total % 60)
      silenciado = false
    },
    setSensible: (v: boolean) => {
      for (const s of [horas, minutos, segundos]) s.set_sensitive(v)
      widget.set_opacity(v ? 1 : 0.4)
    },
  }
}
