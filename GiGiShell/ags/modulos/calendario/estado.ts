// Estado reactivo del panel de calendario. Es la única pieza que une el dominio puro con la UI:
// los widgets no leen ni escriben disco, y `dominio/` no sabe que existe AGS.

import { createComputed, createState } from "ags"
import { ticReloj } from "../../servicios/sistema/reloj.ts"
import type { BorradorEvento, EventoCalendario } from "./dominio/tipos.ts"
import { CALENDARIO_LOCAL, COLOR_POR_DEFECTO } from "./dominio/tipos.ts"
import { agendaDelDia, indicePorFecha } from "./dominio/agenda.ts"
import type { EventoEnDia } from "./dominio/agenda.ts"
import {
  construirCuadriculaMes,
  desdeFechaISO,
  desplazarMes,
  hoyISO,
  horaActual,
  minutosAHora,
  horaAMinutos,
} from "./dominio/fechas.ts"
import { cargarCalendario, crearGuardadoCalendario, generarId } from "./persistencia/repositorio.ts"
import { archivoVacio } from "./persistencia/esquema.ts"
import type { ArchivoCalendario } from "./persistencia/esquema.ts"

export type SeccionPanel = "calendario" | "reloj"

/**
 * Estado del editor. `null` = cerrado.
 *
 * El borrador es una copia, no el evento vivo: cancelar tiene que dejar el original intacto, y
 * mientras se teclea el título no debe repintarse la agenda que hay detrás.
 */
export interface EdicionEvento {
  modo: "crear" | "editar"
  /** Solo en modo editar. */
  id?: string
  borrador: BorradorEvento
}

const inicial: ArchivoCalendario = (() => {
  try {
    return cargarCalendario()
  } catch (e) {
    // Fallar aquí dejaría el panel sin construir. Ni el peor JSON puede costar el calendario entero.
    console.error("[calendario] carga inicial fallida, se arranca vacío:", e)
    return archivoVacio()
  }
})()

const hoy = hoyISO()
const partesHoy = desdeFechaISO(hoy)!

/**
 * El día de hoy, reactivo. **Sin ningún temporizador nuevo.**
 *
 * `hoyISO()` es una función pura: quien la llamaba se quedaba con el día que hubiera cuando se
 * construyó el widget. Con el panel abierto a medianoche, la celda «hoy» de la cuadrícula y el
 * «Hoy · N eventos» de la agenda seguían señalando ayer, y no había nada que los volviera a
 * recalcular salvo que el usuario tocara otra cosa.
 *
 * La fuente es `ticReloj`, el tic global al minuto que ya mueve el reloj de la barra y que
 * comparten los tres monitores: no se añade ni un `timeout` más, y la suscripción es una sola para
 * todo el shell, no una por monitor.
 *
 * **Tiene que ser `createState` y no `createComputed`.** El derivado de gnim no compara nada: al
 * invalidarse avisa a todos sus suscriptores tanto si el valor cambió como si no
 * (`invalidate()` en `jsx/state.ts`), así que un `createComputed` sobre `ticReloj` habría
 * reconstruido la cuadrícula y la agenda **cada minuto** en los tres monitores — justo el sondeo
 * que este módulo no tiene. `createState` sí filtra con `Object.is` en el `set`, de modo que de
 * los 1.440 tics del día exactamente uno provoca repintado.
 */
const [hoyReactivo, establecerHoyReactivo] = createState(hoy)
ticReloj.subscribe(() => establecerHoyReactivo(hoyISO()))
export { hoyReactivo }

export const [eventos, establecerEventos] = createState<EventoCalendario[]>(inicial.eventos)
export const [configuracion, establecerConfiguracion] = createState(inicial.configuracion)
export const [seccionActiva, establecerSeccionActiva] = createState<SeccionPanel>("calendario")
export const [mesVisible, establecerMesVisible] = createState({ anio: partesHoy.anio, mes: partesHoy.mes })
export const [fechaSeleccionada, establecerFechaSeleccionada] = createState(hoy)
export const [edicion, establecerEdicion] = createState<EdicionEvento | null>(null)
/** Evento pendiente de confirmar borrado. `null` = no hay confirmación en curso. */
export const [borradoPendiente, establecerBorradoPendiente] = createState<string | null>(null)

const guardar = crearGuardadoCalendario(() => ({
  version: 1,
  eventos: eventos.get(),
  configuracion: configuracion.get(),
}))

eventos.subscribe(guardar)
configuracion.subscribe(guardar)

// ── Derivados ────────────────────────────────────────────────────────────────

/** Celdas del mes visible. Se recalcula solo al cambiar de mes, no con cada evento. */
export const cuadricula = createComputed(() => {
  const { anio, mes } = mesVisible()
  return construirCuadriculaMes(anio, mes)
})

/** `fecha → eventos` acotado al mes visible, para los puntos de la rejilla. */
export const indiceMes = createComputed(() => {
  const celdas = cuadricula()
  const lista = eventos()
  if (celdas.length === 0) return new Map<string, EventoCalendario[]>()
  return indicePorFecha(lista, celdas[0].fecha, celdas[celdas.length - 1].fecha)
})

/** Agenda del día seleccionado, ya ordenada. */
export const agendaSeleccionada = createComputed<EventoEnDia[]>(() =>
  agendaDelDia(eventos(), fechaSeleccionada()),
)

// ── Navegación ───────────────────────────────────────────────────────────────

export function irAMesRelativo(delta: number) {
  const { anio, mes } = mesVisible.get()
  establecerMesVisible(desplazarMes(anio, mes, delta))
}

/** «Hoy»: recoloca el mes visible Y la selección. Recalcula la fecha, no usa la del arranque. */
export function irAHoy() {
  const fecha = hoyISO()
  const partes = desdeFechaISO(fecha)!
  establecerMesVisible({ anio: partes.anio, mes: partes.mes })
  establecerFechaSeleccionada(fecha)
}

/**
 * Seleccionar un día. **No abre el formulario** — el store antiguo lo hacía, y entonces no había
 * forma de mirar la agenda de un día sin que saltara el editor encima.
 */
export function seleccionarFecha(fecha: string) {
  establecerFechaSeleccionada(fecha)
  const partes = desdeFechaISO(fecha)
  if (!partes) return
  const visible = mesVisible.get()
  // Pinchar en un día de relleno lleva al mes al que pertenece: si no, el día seleccionado quedaría
  // fuera de la rejilla y el usuario no vería qué acaba de marcar.
  if (partes.anio !== visible.anio || partes.mes !== visible.mes) {
    establecerMesVisible({ anio: partes.anio, mes: partes.mes })
  }
}

// ── Edición ──────────────────────────────────────────────────────────────────

/**
 * Borrador para un evento nuevo. La hora por defecto es la siguiente hora en punto, y la duración
 * una hora: es lo que casi siempre se quiere, y evita que el formulario abra con un error de
 * validación ya puesto.
 */
export function borradorNuevo(fecha: string): BorradorEvento {
  const proximaHora = Math.min(23 * 60, (Math.floor(horaAMinutos(horaActual()) / 60) + 1) * 60)
  return {
    titulo: "",
    inicio: { fecha, hora: minutosAHora(proximaHora) },
    fin: { fecha, hora: minutosAHora(Math.min(proximaHora + 60, 23 * 60 + 59)) },
    todoElDia: false,
    color: COLOR_POR_DEFECTO,
    calendarioId: CALENDARIO_LOCAL,
  }
}

export function abrirCreacion(fecha = fechaSeleccionada.get()) {
  establecerBorradoPendiente(null)
  establecerEdicion({ modo: "crear", borrador: borradorNuevo(fecha) })
}

export function abrirEdicion(evento: EventoCalendario) {
  establecerBorradoPendiente(null)
  establecerEdicion({
    modo: "editar",
    id: evento.id,
    borrador: {
      titulo: evento.titulo,
      descripcion: evento.descripcion,
      ubicacion: evento.ubicacion,
      // Copia profunda de los momentos: sin ella, editar la hora mutaría el evento de la lista y la
      // agenda de detrás se repintaría a cada tecla, incluso si luego cancelas.
      inicio: { ...evento.inicio },
      fin: { ...evento.fin },
      todoElDia: evento.todoElDia,
      color: evento.color,
      calendarioId: evento.calendarioId,
      origen: evento.origen,
      permiso: evento.permiso,
    },
  })
}

export function cerrarEdicion() {
  establecerEdicion(null)
}

// ── CRUD ─────────────────────────────────────────────────────────────────────

export function crearEvento(borrador: BorradorEvento): EventoCalendario {
  const evento: EventoCalendario = {
    ...borrador,
    id: generarId(),
    origen: borrador.origen ?? "local",
    permiso: borrador.permiso ?? "escritura",
    titulo: borrador.titulo.trim(),
  }
  establecerEventos([...eventos.get(), evento])
  return evento
}

export function actualizarEvento(id: string, borrador: BorradorEvento) {
  establecerEventos(
    eventos.get().map((e) =>
      e.id === id
        ? {
            ...e,
            ...borrador,
            titulo: borrador.titulo.trim(),
            // Una edición local sobre un evento remoto queda pendiente de subir. Si nunca se conecta
            // Google, el campo simplemente no lo lee nadie.
            sincronizacion:
              e.origen === "google"
                ? { ...e.sincronizacion, pendiente: e.sincronizacion?.pendiente ?? "editar" }
                : e.sincronizacion,
          }
        : e,
    ),
  )
}

export function eliminarEvento(id: string) {
  const evento = eventos.get().find((e) => e.id === id)
  if (evento?.origen === "google" && evento.remotoId) {
    // No se borra de la lista todavía: hay que recordar que falta borrarlo también allí. Lo hará la
    // cola de `google/sincronizacion.ts`; hasta entonces se marca y se oculta.
    establecerEventos(
      eventos.get().map((e) =>
        e.id === id ? { ...e, sincronizacion: { ...e.sincronizacion, pendiente: "eliminar" } } : e,
      ),
    )
  } else {
    establecerEventos(eventos.get().filter((e) => e.id !== id))
  }
  establecerBorradoPendiente(null)
}

/** Reemplaza la lista completa. Lo usa la sincronización con Google. */
export function reemplazarEventos(lista: EventoCalendario[]) {
  establecerEventos(lista)
}
