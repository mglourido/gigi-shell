// Planificador de los recordatorios de eventos. Une `dominio/avisos.ts` (puro) con el sistema de
// notificaciones. Mismo diseño que el de alarmas (`reloj/estadoReloj.ts`):
//
// - **Sin temporizador propio: cuelga de `ticReloj`**, el tic global del minuto que ya corre para el
//   reloj de la barra, con el panel abierto o cerrado. Los avisos son de minuto exacto. Cada tic es
//   UNA comparación con el próximo aviso guardado; la lista solo se recorre al cambiar o al vencer.
// - **La suspensión la cubre el propio tic**: `servicios/sistema/reloj.ts` da uno al despertar, y
//   esa revisión abarca todo lo que pasó mientras dormía.
//
// **Qué se avisa y cuándo, sin persistir nada.** Se recuerda solo `ultimaRevision`: cada revisión
// avisa de lo que cae en `(ultimaRevision, ahora]` y avanza la marca, así que nada suena dos veces.
// Al arrancar AGS la marca es «ahora»: lo vencido con el shell apagado no se repite en tromba al
// iniciar sesión. Lo vencido durante una SUSPENSIÓN sí se avisa al volver, si el evento no ha
// terminado (`avisosQueVencen`): una reunión en curso aún merece el recordatorio.

import { execAsync } from "ags/process"
import { ticReloj } from "../../servicios/sistema/reloj.ts"
import { ORIGEN_RELOJ } from "../notificaciones/sonido/decision.ts"
import type { EventoCalendario } from "./dominio/tipos.ts"
import { avisosQueVencen, siguienteAviso, textoAviso } from "./dominio/avisos.ts"
import { eventos } from "./estado.ts"

const ETIQUETA = "calendario-avisos"
/** Sonido del recordatorio: más suave que el despertador, que es para alarmas. Está en `audio/`. */
const SONIDO_AVISO = "bell"

let ultimaRevision = Date.now()
/** Lista que había en la última revisión. Ver `alCambiarEventos`. */
let listaVista: EventoCalendario[] = eventos.get()
/** Próximo aviso posterior a `ultimaRevision`. `null` = ningún evento volverá a avisar. */
let proximoAviso: number | null = null
let iniciado = false

/**
 * Notificación normal, como las alarmas: decide el motor de reglas, el No molestar y el sonido.
 * Origen `alarm` (`ORIGEN_RELOJ`) a propósito: le da prioridad de popup y hace que la suspensión
 * falsa no lo deje mudo; `system` activaría el skin dunst de los avisos de `hypr/scripts/`.
 */
function emitir(evento: EventoCalendario, ahora: number) {
  try {
    execAsync([
      "notify-send",
      "-a", "Calendario",
      "-i", "x-office-calendar",
      "-h", `string:sound-name:${SONIDO_AVISO}`,
      "-h", `string:x-gigishell-source:${ORIGEN_RELOJ}`,
      evento.titulo.trim() === "" ? "(sin título)" : evento.titulo,
      textoAviso(evento, ahora),
    ]).catch((e) => console.warn(`[${ETIQUETA}] no se pudo notificar:`, e))
  } catch (e) {
    // `execAsync` lanza síncrono si falta el binario (ver `ags/CLAUDE.md`).
    console.warn(`[${ETIQUETA}] notify-send no disponible:`, e)
  }
}

function revisar(lista: EventoCalendario[]) {
  const ahora = Date.now()
  for (const ev of avisosQueVencen(lista, ultimaRevision, ahora)) emitir(ev, ahora)
  ultimaRevision = ahora
}

function recalcular() {
  proximoAviso = siguienteAviso(eventos.get(), ultimaRevision)
}

function alTic() {
  const ahora = Date.now()
  // Camino de cada minuto: nada vence. `proximoAviso` sigue valiendo aunque la marca avance, porque
  // es posterior a `ahora`.
  if (proximoAviso === null || proximoAviso > ahora) {
    ultimaRevision = ahora
    return
  }
  try {
    revisar(eventos.get())
  } catch (e) {
    console.warn(`[${ETIQUETA}] revisión fallida:`, e)
    ultimaRevision = ahora
  }
  recalcular()
}

/**
 * Al cambiar la lista se revisa primero con la lista ANTERIOR y luego se mueve la marca a «ahora».
 *
 * Revisar con la nueva avisaría al momento de un evento recién creado cuyo aviso ya pasó (crear a
 * las 17:55 una cita de las 18:00 con aviso de 10 min). Y mover la marca sin revisar podría tragarse
 * un aviso de la lista vieja que el tic aún no había visto.
 */
function alCambiarEventos() {
  try {
    revisar(listaVista)
  } catch (e) {
    console.warn(`[${ETIQUETA}] revisión fallida:`, e)
  }
  listaVista = eventos.get()
  recalcular()
}

/** Arranca el planificador. Idempotente. */
export function inicializarAvisosCalendario() {
  if (iniciado) return
  iniciado = true
  ultimaRevision = Date.now()
  listaVista = eventos.get()
  recalcular()
  eventos.subscribe(alCambiarEventos)
  ticReloj.subscribe(alTic)
}
