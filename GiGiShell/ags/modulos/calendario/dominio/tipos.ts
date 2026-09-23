// Modelo de dominio del calendario. Sin dependencias de GTK: se puede probar con `node --test`.
//
// Dos decisiones que condicionan todo lo demás:
//
// 1. **Las fechas son cadenas `YYYY-MM-DD` en hora LOCAL, no objetos `Date`.** `new Date("2026-07-21")`
//    parsea como UTC y en Europa/Madrid devuelve el día 20 a las 22:00; el store antiguo lo hacía así
//    y por eso comparaba mal las fechas de la agenda. Todas las operaciones de calendario viven en
//    `fechas.ts` y trabajan sobre la cadena o sobre `Date.UTC`, nunca sobre el constructor local.
//
// 2. **`fin` es INCLUSIVO**: `{inicio: 2026-07-21, fin: 2026-07-23}` ocupa tres días, y un evento de
//    un solo día tiene `inicio.fecha === fin.fecha`. Google Calendar usa fin exclusivo para los
//    eventos de día completo; esa conversión pertenece al mapeo de `google/`, no al dominio, porque
//    aquí lo que se pregunta siempre es «¿qué días ocupa esto?».

export const COLORES_EVENTO = ["purple", "teal", "red", "amber", "blue", "pink"] as const
export type ColorEvento = (typeof COLORES_EVENTO)[number]

/**
 * Clase CSS que pinta un color de evento.
 *
 * **El hex ya no vive aquí, y eso no es un traslado cosmético.** Antes había un `COLOR_HEX` y cada
 * punto, franja y muestra se pintaba con `css={...}` inline; en gnim eso construye un
 * `Gtk.CssProvider` por widget, lo parsea y lo añade al contexto de estilo de ese widget. La
 * cuadrícula del mes son hasta cuatro puntos por celda × 42 celdas × 3 monitores, y se reconstruye
 * entera en cada cambio de mes, de día o de evento: cientos de providers creados y tirados por
 * clic. Con una clase estática, GTK resuelve el color con el resto de la hoja y no se crea nada.
 *
 * ⚠️ Es la mitad de un par: `$colores-evento` en `estilos/_colores.scss` genera las seis clases.
 * Añadir un color a `COLORES_EVENTO` sin añadirlo allí **no da error**, solo deja el punto sin
 * pintar — y hay que recompilar `out.css`, que es el que lee AGS.
 */
export function claseColor(color: ColorEvento): string {
  return `cal-ev-${color}`
}

export const COLOR_POR_DEFECTO: ColorEvento = "purple"

/** Origen del evento. Determina quién manda al sincronizar y si se puede editar. */
export type OrigenEvento = "local" | "google"

/** Permiso EFECTIVO sobre el evento, ya resuelto desde el `accessRole` del calendario remoto. */
export type PermisoEvento = "lectura" | "escritura"

/** Identificador del calendario local. Los remotos usan el id que da Google. */
export const CALENDARIO_LOCAL = "local"

/**
 * Un extremo del evento.
 *
 * - `todoElDia` → `hora` ausente.
 * - con hora → `hora` es `"HH:MM"` en la zona `zonaHoraria` (IANA; ausente = zona local del equipo).
 *
 * La zona se guarda pero el dominio NO la usa para colocar el evento en la rejilla: un evento creado
 * aquí se ve donde lo creaste. Convertir zonas es trabajo del mapeo de Google.
 */
export interface MomentoEvento {
  /** `YYYY-MM-DD`. */
  fecha: string
  /** `HH:MM` en 24 h. Ausente si el evento es de día completo. */
  hora?: string
  /** Zona IANA, p. ej. `Europe/Madrid`. Ausente = zona local. */
  zonaHoraria?: string
}

/** Metadatos de sincronización. Solo tienen sentido con `origen: "google"`. */
export interface SincronizacionEvento {
  /** Versión remota (`etag`), para no pisar un cambio ajeno. */
  etag?: string
  /** Última modificación remota, RFC 3339. */
  actualizadoEn?: string
  /** Mutación local aún no enviada. Su presencia es lo que alimenta la cola offline. */
  pendiente?: "crear" | "editar" | "eliminar"
  /**
   * El remoto cambió por debajo de una mutación local pendiente.
   *
   * No se resuelve solo en ninguna dirección: pisar el remoto perdería el cambio de otro
   * dispositivo, y pisar el local perdería lo que el usuario acaba de escribir. Se marca, se
   * conserva la versión local y la UI lo señala.
   */
  conflicto?: boolean
}

export interface EventoCalendario {
  /** Id interno estable. Nunca es el id remoto: un evento puede existir antes de subirse. */
  id: string
  titulo: string
  descripcion?: string
  ubicacion?: string
  inicio: MomentoEvento
  /** Inclusivo: el último día que ocupa el evento. */
  fin: MomentoEvento
  todoElDia: boolean
  color: ColorEvento
  origen: OrigenEvento
  /** `CALENDARIO_LOCAL` o el id del calendario de Google. */
  calendarioId: string
  /** Id del evento en el calendario remoto, cuando existe allí. */
  remotoId?: string
  permiso: PermisoEvento
  sincronizacion?: SincronizacionEvento
}

/** Lo que el formulario produce antes de tener id y metadatos: lo que el usuario realmente escribe. */
export type BorradorEvento = Omit<
  EventoCalendario,
  "id" | "origen" | "permiso" | "remotoId" | "sincronizacion"
> & {
  origen?: OrigenEvento
  permiso?: PermisoEvento
}

/** Preferencias visibles del panel. Se persisten junto a los eventos. */
export interface ConfiguracionCalendario {
  /** Calendarios de Google cuyos eventos se muestran. Vacío = ninguno todavía. */
  calendariosVisibles: string[]
}

export function configuracionPorDefecto(): ConfiguracionCalendario {
  return { calendariosVisibles: [] }
}

/** ¿Se puede editar o borrar este evento? Los de solo lectura se muestran, pero sin controles. */
export function esEditable(evento: EventoCalendario): boolean {
  return evento.permiso === "escritura"
}
