import type { StoredNotification } from "../store"

const DURACION_POPUP_MS = 5500
const DURACION_POPUP_SISTEMA_MS = 10000
const DURACION_POPUP_CON_ACCION_MS = 20000
const DURACION_MAXIMA_POPUP_MS = 60000
export { DURACION_MAXIMA_POPUP_MS }

export function obtenerAccionesVisibles(notificacion: StoredNotification): StoredNotification["actions"] {
  return (notificacion.actions ?? []).filter((accion) =>
    accion.id !== "default" && accion.label.trim() !== ""
  )
}

// Mismo tope que la tarjeta del panel (`panel/item/AccionesDbus.tsx`): más de tres
// botones no caben en los 336 px útiles del popup sin ensanchar la superficie.
export const MAXIMO_BOTONES_POPUP = 3

export interface AccionesPopup {
  /** Primera acción visible: la que dispara el clic derecho. `undefined` si no hay. */
  principal: StoredNotification["actions"][number] | undefined
  /** Acciones a pintar como botones. Vacío cuando hay una sola o ninguna. */
  botones: StoredNotification["actions"]
  /** Pista de texto «▸ clic derecho · …»: solo con exactamente una acción. */
  mostrarPista: boolean
}

// Reparto de la misma lista entre el gesto y los botones. Es lo único de la decisión
// que no depende de GTK, así que vive aquí y se puede probar.
//
// Con UNA sola acción el popup se queda como estaba —pista de texto y ningún botón—,
// que es lo más discreto y lo que menos se aparta del `format` de dunst. Los botones
// aparecen solo cuando hay secundarias, porque entonces el gesto no basta: el clic
// derecho solo puede invocar una. Y en cuanto hay botones la pista sobra —repetiría la
// etiqueta del primero—, así que se apaga y su papel lo hereda el "▸" del botón
// principal. La principal sigue siendo la PRIMERA visible en los dos caminos: ese
// contrato es el que hace que el gesto y el primer botón nunca discrepen.
export function resolverAccionesPopup(notificacion: StoredNotification): AccionesPopup {
  const visibles = obtenerAccionesVisibles(notificacion).slice(0, MAXIMO_BOTONES_POPUP)
  return {
    principal: visibles[0],
    botones: visibles.length > 1 ? visibles : [],
    mostrarPista: visibles.length === 1,
  }
}

/** Duraciones por defecto, en ms. Son el suelo de cada familia de popup, no un valor fijo:
 *  ver `calcularDuracionPopup`. Ajustes > Notificaciones > General las sobrescribe. */
export interface DuracionesPopup {
  /** Notificación corriente de una app, sin acciones. */
  normal: number
  /** Aviso del sistema (`x-gigishell-source:system`) sin acciones. */
  sistema: number
  /** Cualquier popup con botones de acción. */
  conAcciones: number
}

export const DURACIONES_POPUP_PREDETERMINADAS: DuracionesPopup = {
  normal: DURACION_POPUP_MS,
  sistema: DURACION_POPUP_SISTEMA_MS,
  conAcciones: DURACION_POPUP_CON_ACCION_MS,
}

/** Tope inferior de una duración explícita. Un `popupMs` de 0 —o el 200 de un JSON tocado a
 *  mano— haría parpadear el popup sin que diera tiempo a leerlo. */
export const DURACION_MINIMA_POPUP_MS = 1000

/** Acota cualquier duración pedida a [1 s, 60 s]. */
export function acotarDuracionPopup(ms: number): number {
  if (!Number.isFinite(ms)) return DURACION_POPUP_MS
  return Math.min(Math.max(ms, DURACION_MINIMA_POPUP_MS), DURACION_MAXIMA_POPUP_MS)
}

// Los popups con acciones necesitan tiempo para poder leerse y accionarse. Los del
// sistema (`x-gigishell-source:system`, o sea lo que emiten los scripts de `hypr/scripts/`)
// también, aunque no traigan botón: informan del resultado de una función del equipo
// —reparar un USB, un análisis, una alerta de disco— y 5,5 s no dan ni para leerlos.
// El tiempo solicitado por el emisor se respeta dentro de unos límites para que ni un
// valor muy corto vuelva inútil el aviso ni `-t 0` deje el popup fijado indefinidamente.
//
// `meta.popupMs` —la duración que fija una regla o un aviso del sistema en Ajustes— va POR
// DELANTE de todo eso: es una decisión explícita del usuario sobre ESTA notificación, así que
// tiene que poder bajar de los suelos de familia (los 3 s de un aviso del sistema que no
// interesa leer entero) y también ignorar el `expire_timeout` que pida el emisor. Lo único
// que se le aplica es el acotado a [1 s, 60 s].
//
// Las duraciones por defecto llegan por parámetro y no se leen aquí: este módulo es lógica
// pura y con tests, y `popup/pila.ts` es quien las saca de las preferencias.
export function calcularDuracionPopup(
  notificacion: StoredNotification,
  duraciones: DuracionesPopup = DURACIONES_POPUP_PREDETERMINADAS,
): number {
  const explicita = notificacion.meta?.popupMs
  if (typeof explicita === "number" && explicita > 0) return acotarDuracionPopup(explicita)

  const tieneAcciones = obtenerAccionesVisibles(notificacion).length > 0
  const esDelSistema = notificacion.source === "system"
  if (!tieneAcciones && !esDelSistema) return acotarDuracionPopup(duraciones.normal)

  const duracionMinima = acotarDuracionPopup(
    tieneAcciones ? duraciones.conAcciones : duraciones.sistema,
  )
  const duracionSolicitada = notificacion.expireTimeout ?? 0
  const duracionBase = duracionSolicitada > 0 ? duracionSolicitada : duracionMinima

  return Math.min(
    Math.max(duracionBase, duracionMinima),
    DURACION_MAXIMA_POPUP_MS,
  )
}

export function crearResumenRafaga(id: number, cantidad: number): StoredNotification {
  return {
    id,
    appName: "GiGiShell",
    appIcon: "",
    summary: "Muchas notificaciones nuevas",
    body: `Han llegado ${cantidad} notificaciones. Revísalas en el panel de notificaciones.`,
    timestamp: Date.now(),
    read: false,
    urgency: 1,
    actions: [],
    meta: {
      lifetime: "timed",
      clearOnBoot: false,
      noHistory: true,
      muteAudio: true,
      dontShow: false,
      dedupKey: "gigishell-popup-burst-summary",
      conditions: [],
      matchedRules: [],
    },
  }
}
