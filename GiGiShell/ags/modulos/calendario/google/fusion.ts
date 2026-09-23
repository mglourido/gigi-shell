// Fusión de lo que devuelve Google con lo que hay en el equipo, y cola de mutaciones pendientes.
// Puro y probado: aquí no se hace ninguna petición.
//
// **La regla de oro es que un fallo de Google no puede costar datos locales.** De ahí que la fusión
// sea aditiva por calendario: se sustituye lo que pertenece al calendario sincronizado y **no se
// toca nada más**. Una respuesta vacía —porque la red falló a medias, porque el token expiró, porque
// el calendario se desconectó— no puede vaciar la lista.

import type { EventoCalendario } from "../dominio/tipos.ts"
import { esLocal } from "./mapeo.ts"

export interface EntradaFusion {
  /** Eventos que Google ha devuelto en esta pasada. */
  remotos: EventoCalendario[]
  /** Ids remotos anunciados como `cancelled`. */
  eliminados: string[]
  /** Calendario al que pertenece esta pasada. */
  calendarioId: string
  /**
   * `true` en una sincronización COMPLETA (sin `syncToken`): lo que no venga en `remotos` ya no
   * existe. En una incremental es `false` y lo ausente simplemente no ha cambiado.
   */
  completa: boolean
}

export interface ResultadoFusion {
  eventos: EventoCalendario[]
  anadidos: number
  actualizados: number
  eliminados: number
  conflictos: number
}

/**
 * Une una respuesta de Google con la lista local.
 *
 * Tres invariantes:
 *
 * 1. **Lo local no se toca jamás.** Ni se borra ni se reescribe: no viene de Google y Google no
 *    tiene nada que decir sobre ello.
 * 2. **Una mutación local pendiente gana a la versión remota, y se marca el conflicto.** Todavía no
 *    hemos podido subirla, así que la copia de Google es *anterior* a lo que el usuario escribió.
 *    Sobrescribir aquí sería tirar en silencio un cambio hecho a mano — el peor fallo posible de
 *    un sincronizador.
 * 3. **Un borrado remoto no se aplica sobre una edición local pendiente.** Si Google dice «esto ya
 *    no está» pero aquí hay un cambio sin subir, el evento se conserva marcado en conflicto y lo
 *    decide el usuario.
 */
export function fusionar(locales: EventoCalendario[], entrada: EntradaFusion): ResultadoFusion {
  const { remotos, eliminados, calendarioId, completa } = entrada

  const porRemoto = new Map<string, EventoCalendario>()
  for (const ev of locales) {
    if (ev.remotoId && ev.calendarioId === calendarioId) porRemoto.set(ev.remotoId, ev)
  }

  const eliminadosSet = new Set(eliminados)
  const remotosPorId = new Map(remotos.map((e) => [e.remotoId!, e]))

  let anadidos = 0
  let actualizados = 0
  let borrados = 0
  let conflictos = 0

  const salida: EventoCalendario[] = []

  for (const ev of locales) {
    // (1) Lo local pasa intacto.
    if (esLocal(ev) || ev.calendarioId !== calendarioId) {
      salida.push(ev)
      continue
    }

    const remotoId = ev.remotoId ?? ""
    const pendiente = ev.sincronizacion?.pendiente

    if (eliminadosSet.has(remotoId)) {
      if (pendiente && pendiente !== "eliminar") {
        // (3) Borrado remoto contra edición local: se conserva y se marca.
        conflictos++
        salida.push({ ...ev, sincronizacion: { ...ev.sincronizacion, conflicto: true } })
      } else {
        borrados++
      }
      continue
    }

    const remoto = remotosPorId.get(remotoId)
    if (remoto) {
      if (pendiente) {
        // (2) Mutación local sin subir: manda la local. Solo es CONFLICTO si el remoto también
        // cambió — si el etag es el mismo que conocíamos, nadie ha tocado nada allí y al subir
        // nuestra versión no se pisa a nadie.
        const remotoCambio = remoto.sincronizacion?.etag !== ev.sincronizacion?.etag
        if (remotoCambio) conflictos++
        salida.push(
          remotoCambio
            ? { ...ev, sincronizacion: { ...ev.sincronizacion, conflicto: true } }
            : ev,
        )
      } else {
        actualizados++
        // Se conserva el id local para no romper la selección de la UI.
        salida.push({ ...remoto, id: ev.id })
      }
      remotosPorId.delete(remotoId)
      continue
    }

    // No vino en esta respuesta.
    if (completa && !pendiente) {
      // En una pasada completa, lo ausente es que ya no existe. Con una mutación pendiente NO se
      // borra: seguramente sea nuestra propia creación, que allí todavía no existe.
      borrados++
      continue
    }
    salida.push(ev)
  }

  // Lo que queda en el mapa es nuevo.
  for (const nuevo of remotosPorId.values()) {
    anadidos++
    salida.push(nuevo)
  }

  return { eventos: salida, anadidos, actualizados, eliminados: borrados, conflictos }
}

export interface Mutacion {
  evento: EventoCalendario
  tipo: "crear" | "editar" | "eliminar"
}

/** Cola de lo que falta por subir, en el orden de la lista. */
export function mutacionesPendientes(eventos: EventoCalendario[]): Mutacion[] {
  const cola: Mutacion[] = []
  for (const evento of eventos) {
    const tipo = evento.sincronizacion?.pendiente
    // Un conflicto no se sube: lo tiene que resolver el usuario, y reintentar en bucle contra un
    // remoto que cambió es cómo se pierde el trabajo de alguien.
    if (!tipo || evento.sincronizacion?.conflicto) continue
    cola.push({ evento, tipo })
  }
  return cola
}

/** Marca una mutación como subida: se limpia el pendiente y se anota la versión remota nueva. */
export function trasSubir(
  eventos: EventoCalendario[],
  id: string,
  remoto: { remotoId?: string; etag?: string; actualizadoEn?: string } | null,
): EventoCalendario[] {
  const salida: EventoCalendario[] = []
  for (const ev of eventos) {
    if (ev.id !== id) {
      salida.push(ev)
      continue
    }
    // `null` = era un borrado y ya se fue de Google: ahora sí se puede quitar de aquí.
    if (remoto === null) continue
    salida.push({
      ...ev,
      remotoId: remoto.remotoId ?? ev.remotoId,
      sincronizacion: { etag: remoto.etag, actualizadoEn: remoto.actualizadoEn },
    })
  }
  return salida
}

/** Descarta el cambio local y se queda con lo que diga Google la próxima vez. */
export function resolverConflictoConRemoto(eventos: EventoCalendario[], id: string): EventoCalendario[] {
  return eventos.map((ev) =>
    ev.id === id
      ? { ...ev, sincronizacion: { ...ev.sincronizacion, pendiente: undefined, conflicto: undefined } }
      : ev,
  )
}

/** Conserva el cambio local y vuelve a ponerlo en cola para subirlo. */
export function resolverConflictoConLocal(eventos: EventoCalendario[], id: string): EventoCalendario[] {
  return eventos.map((ev) =>
    ev.id === id
      ? {
          ...ev,
          sincronizacion: {
            ...ev.sincronizacion,
            conflicto: undefined,
            pendiente: ev.sincronizacion?.pendiente ?? "editar",
          },
        }
      : ev,
  )
}
