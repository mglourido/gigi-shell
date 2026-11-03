// modulos/notificaciones/rules/condiciones/tipos.ts
// Qué hay que declarar de una CONDICIÓN dinámica: algo que retira una notificación sola cuando
// deja de tener sentido («Batería baja» desaparece cuando la batería sube). Puro: el servicio
// del sistema que haga falta (la batería…) se INYECTA en `vigilar`, así el descriptor se puede
// importar desde Node y el test comprueba el registro entero.
//
// UNA CONDICIÓN = UN FICHERO aquí + una línea en `index.ts` + sus textos. Si necesita un
// servicio que aún no existe, se añade a `ServiciosCondicion` y a su implementación real en
// `rules/conditions.ts` (el único fichero con `gi://`).
import type { StoredNotification } from "../../estado/modelos.ts"

/** Lo mínimo de AstalBattery que usan las condiciones de batería. */
export interface BateriaVigilable {
  percentage: number
  connect(senal: string, cb: () => void): number
  disconnect(id: number): void
}

export interface ServiciosCondicion {
  bateria(): BateriaVigilable
}

export interface DefinicionCondicion {
  id: string
  /** Botón del editor. Sin etiqueta, la condición no se ofrece (pero sigue funcionando si una
   *  regla ya la lleva). */
  etiqueta?: string
  /** Frase del resumen de la lista de reglas. `null` = no se enseña. */
  resumen: string | null
  /** Empieza a vigilar; llama a `resolver()` cuando se cumpla. Devuelve cómo dejar de vigilar. */
  vigilar(notificacion: StoredNotification, resolver: () => void, servicios: ServiciosCondicion): () => void
}

export const definirCondicion = (d: DefinicionCondicion): DefinicionCondicion => d
