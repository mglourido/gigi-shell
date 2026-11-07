// Estado del reloj: alarmas persistentes, temporizador y cronómetro de sesión. Une la lógica pura
// de `planificadorAlarmas.ts` y `tiempos.ts` con GLib y con el sistema de notificaciones.

import GLib from "gi://GLib"
import { createState } from "ags"
import { execAsync } from "ags/process"
import {
  cargarJsonCrudo,
  crearGuardadoJsonProgramado,
  rutaConfig,
} from "../../../servicios/almacenamiento/json.ts"
import { esHoraValida } from "../dominio/fechas.ts"
import { ticReloj } from "../../../servicios/sistema/reloj.ts"
import {
  VERSION_RELOJ,
  cronometroInicial,
  temporizadorInicial,
} from "./tipos.ts"
import type { Alarma, ArchivoReloj, Cronometro, DiaSemana, Temporizador } from "./tipos.ts"
import {
  revisarAlarmas,
  sanearAlCargar,
  siguienteVencimiento,
  trasSonar,
} from "./planificadorAlarmas.ts"
import {
  cancelarTemporizador as cancelarPuro,
  continuarTemporizador as continuarPuro,
  fijarDuracion as fijarDuracionPuro,
  iniciarCronometro as iniciarCronoPuro,
  iniciarTemporizador as iniciarPuro,
  pausarCronometro as pausarCronoPuro,
  pausarTemporizador as pausarPuro,
  reiniciarCronometro as reiniciarCronoPuro,
  restanteTemporizador,
} from "./tiempos.ts"
import { SONIDO_ALARMA, SONIDO_TEMPORIZADOR, esRuta } from "../../notificaciones/sonido/decision.ts"

export const RUTA_RELOJ = rutaConfig("reloj.json")
const ETIQUETA = "reloj"

/**
 * Tope de espera de un solo salto del TEMPORIZADOR (la cuenta atrás): 15 minutos.
 *
 * Un `GLib.timeout_add` **no corre mientras el equipo está suspendido**: una cuenta atrás de una
 * hora armada de una tacada vencería una hora de *actividad* después. El tope trocea la espera y
 * recalcula contra el reloj de pared en cada salto. Las alarmas ya no lo usan: van con `ticReloj`.
 */
const MAX_ESPERA_MS = 15 * 60_000

// ── Carga ────────────────────────────────────────────────────────────────────

function leerAlarma(valor: unknown): Alarma | null {
  if (typeof valor !== "object" || valor === null) return null
  const b = valor as Record<string, unknown>
  const id = typeof b.id === "string" && b.id !== "" ? b.id : null
  const hora = typeof b.hora === "string" && esHoraValida(b.hora) ? b.hora : null
  if (id === null || hora === null) return null
  const base = {
    id,
    hora,
    etiqueta: typeof b.etiqueta === "string" ? b.etiqueta : "",
    activa: b.activa !== false,
    sonido: typeof b.sonido === "string" && b.sonido !== "" ? b.sonido : undefined,
  }
  if (b.tipo === "semanal") {
    const dias = Array.isArray(b.dias)
      ? ([...new Set(b.dias.filter((d): d is DiaSemana => typeof d === "number" && d >= 0 && d <= 6))].sort() as DiaSemana[])
      : []
    return { ...base, tipo: "semanal", dias }
  }
  const fecha = typeof b.fecha === "string" ? b.fecha : ""
  if (fecha === "") return null
  return { ...base, tipo: "puntual", fecha }
}

function cargarAlarmas(): Alarma[] {
  const crudo = cargarJsonCrudo(RUTA_RELOJ, ETIQUETA)
  if (crudo === null || typeof crudo !== "object") return []
  const lista = (crudo as Record<string, unknown>).alarmas
  if (!Array.isArray(lista)) return []
  const leidas: Alarma[] = []
  for (const item of lista) {
    const alarma = leerAlarma(item)
    if (alarma) leidas.push(alarma)
  }
  // Las puntuales vencidas con AGS apagado se desactivan aquí, en silencio y antes de que nadie
  // pueda armar un temporizador con ellas.
  const { alarmas, desactivadas } = sanearAlCargar(leidas, Date.now())
  if (desactivadas.length > 0) {
    console.info(`[${ETIQUETA}] ${desactivadas.length} alarma(s) puntual(es) vencida(s) desactivada(s)`)
  }
  return alarmas
}

export const [alarmas, establecerAlarmas] = createState<Alarma[]>(cargarAlarmas())
export const [temporizador, establecerTemporizador] = createState<Temporizador>(temporizadorInicial())
export const [cronometro, establecerCronometro] = createState<Cronometro>(cronometroInicial())

const guardarAlarmas = crearGuardadoJsonProgramado(
  RUTA_RELOJ,
  ETIQUETA,
  600,
  (): ArchivoReloj => ({ version: VERSION_RELOJ, alarmas: alarmas.get() }),
)
alarmas.subscribe(guardarAlarmas)

// ── Notificación ─────────────────────────────────────────────────────────────

/**
 * Emite la alerta como una notificación NORMAL.
 *
 * El reloj no tiene popup ni reproductor propios: manda un `notify-send` con el sonido y deja que
 * el motor de reglas, el No molestar y `sonido/decision.ts` decidan qué se ve y qué suena. El hint
 * de origen es `alarm` y no `system` a propósito — `system` activaría la builtin del skin dunst, que
 * es para los avisos de los scripts de `hypr/scripts/`, no para esto.
 *
 * El sonido sale como `sound-file` si es una ruta y como `sound-name` si es un nombre del tema: son
 * dos hints distintos del spec y mandar una ruta por `sound-name` no falla, simplemente **no suena**
 * (canberra busca ese nombre dentro del tema instalado y no lo encuentra).
 */
function emitirAlerta(titulo: string, cuerpo: string, sonido: string) {
  execAsync([
    "notify-send",
    "-a", "Reloj",
    "-u", "critical", // permanece hasta que se atienda; una alarma que se va sola no es una alarma
    "-h", esRuta(sonido) ? `string:sound-file:${sonido}` : `string:sound-name:${sonido}`,
    "-h", "string:x-gigishell-source:alarm",
    titulo,
    cuerpo,
  ]).catch((e) => console.warn(`[${ETIQUETA}] no se pudo notificar:`, e))
}

// ── Planificador de alarmas ──────────────────────────────────────────────────
//
// **Sin temporizador propio: cuelga de `ticReloj`**, el tic global alineado al :00 de cada minuto que
// ya mueve el reloj de la barra y que corre siempre, con el panel abierto o cerrado. Las alarmas son
// de minuto exacto, así que el tic las alcanza en el segundo en que vencen. Antes había un
// `timeout_add` propio troceado a 15 min (por la suspensión, que congela los temporizadores de
// GLib): cuatro despertares por hora mientras hubiera una alarma activa, encima del tic que ya
// existía. Ahora cada tic es UNA comparación con un número guardado; la lista solo se recorre al
// cambiar o cuando de verdad vence algo.
//
// La suspensión la resuelve el propio tic: `servicios/sistema/reloj.ts` da uno nada más despertar y
// se realinea al :00. Esa revisión abarca toda la suspensión, y lo que venció dentro cae fuera de la
// tolerancia: no suena, y las puntuales se desactivan (misma decisión que `sanearAlCargar`).

/** Hasta dónde está revisado. La próxima revisión mira `(ultimaRevisionAlarmas, ahora]`. */
let ultimaRevisionAlarmas = Date.now()
/** Próximo vencimiento posterior a la última revisión. `null` = ninguna alarma volverá a sonar. */
let proximaAlarma: number | null = null
let planificadorIniciado = false

function recalcularProximaAlarma() {
  proximaAlarma = siguienteVencimiento(alarmas.get(), ultimaRevisionAlarmas)?.cuando ?? null
}

function revisarAlarmasAhora() {
  const ahora = Date.now()
  const desde = ultimaRevisionAlarmas
  ultimaRevisionAlarmas = ahora
  // Camino de cada minuto: nada vence todavía. `proximaAlarma` sigue valiendo aunque la marca avance,
  // porque es posterior a `ahora`.
  if (proximaAlarma === null || proximaAlarma > ahora) return

  const { suenan, perdidas } = revisarAlarmas(alarmas.get(), desde, ahora)
  for (const alarma of suenan) {
    emitirAlerta(
      alarma.etiqueta.trim() === "" ? "Alarma" : alarma.etiqueta,
      alarma.hora,
      alarma.sonido ?? SONIDO_ALARMA,
    )
  }
  if (perdidas.length > 0) {
    console.info(`[${ETIQUETA}] ${perdidas.length} alarma(s) vencida(s) sin sonar (suspensión)`)
  }

  // Las puntuales que sonaron o se perdieron quedan desactivadas; las semanales siguen.
  const hechas = new Set([...suenan, ...perdidas].filter((a) => a.tipo === "puntual").map((a) => a.id))
  if (hechas.size > 0) {
    // Publicar la lista recalcula `proximaAlarma` por la suscripción de abajo.
    establecerAlarmas(alarmas.get().map((a) => (hechas.has(a.id) ? trasSonar(a) : a)))
  } else {
    recalcularProximaAlarma()
  }
}

alarmas.subscribe(recalcularProximaAlarma)

// ── CRUD de alarmas ──────────────────────────────────────────────────────────

export function generarIdAlarma(): string {
  return `al-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

export function anadirAlarma(alarma: Alarma) {
  establecerAlarmas([...alarmas.get(), alarma])
}

export function actualizarAlarma(id: string, parche: Partial<Alarma>) {
  establecerAlarmas(alarmas.get().map((a) => (a.id === id ? ({ ...a, ...parche } as Alarma) : a)))
}

export function eliminarAlarma(id: string) {
  establecerAlarmas(alarmas.get().filter((a) => a.id !== id))
}

export function alternarAlarma(id: string) {
  establecerAlarmas(alarmas.get().map((a) => (a.id === id ? { ...a, activa: !a.activa } : a)))
}

// ── Temporizador ─────────────────────────────────────────────────────────────

let temporizadorVencimiento: number | null = null

function cancelarVencimientoTemporizador() {
  if (temporizadorVencimiento !== null) {
    GLib.source_remove(temporizadorVencimiento)
    temporizadorVencimiento = null
  }
}

function armarTemporizador() {
  cancelarVencimientoTemporizador()
  const t = temporizador.get()
  if (t.estado !== "corriendo" || t.venceEn === null) return

  const espera = Math.max(200, Math.min(t.venceEn - Date.now(), MAX_ESPERA_MS))
  temporizadorVencimiento = GLib.timeout_add(GLib.PRIORITY_DEFAULT, espera, () => {
    temporizadorVencimiento = null
    const actual = temporizador.get()
    if (actual.estado === "corriendo" && actual.venceEn !== null && Date.now() >= actual.venceEn) {
      emitirAlerta("Temporizador terminado", "", SONIDO_TEMPORIZADOR)
      establecerTemporizador(cancelarPuro(actual))
    } else {
      // Todavía no: solo se había agotado el tramo de 15 min. Se vuelve a armar contra el reloj.
      armarTemporizador()
    }
    return GLib.SOURCE_REMOVE
  })
}

export function iniciarTemporizador() {
  establecerTemporizador(iniciarPuro(temporizador.get(), Date.now()))
  armarTemporizador()
}

export function pausarTemporizador() {
  establecerTemporizador(pausarPuro(temporizador.get(), Date.now()))
  cancelarVencimientoTemporizador()
}

export function continuarTemporizador() {
  establecerTemporizador(continuarPuro(temporizador.get(), Date.now()))
  armarTemporizador()
}

export function cancelarTemporizador() {
  establecerTemporizador(cancelarPuro(temporizador.get()))
  cancelarVencimientoTemporizador()
}

export function fijarDuracionTemporizador(ms: number) {
  establecerTemporizador(fijarDuracionPuro(temporizador.get(), ms))
}

export function restanteTemporizadorAhora(): number {
  return restanteTemporizador(temporizador.get(), Date.now())
}

// ── Cronómetro ───────────────────────────────────────────────────────────────

export function iniciarCronometro() {
  establecerCronometro(iniciarCronoPuro(cronometro.get(), Date.now()))
}

export function pausarCronometro() {
  establecerCronometro(pausarCronoPuro(cronometro.get(), Date.now()))
}

export function reiniciarCronometro() {
  establecerCronometro(reiniciarCronoPuro())
}

/** Arranca el planificador al cargar el shell. Idempotente. */
export function inicializarReloj() {
  if (planificadorIniciado) return
  planificadorIniciado = true
  ultimaRevisionAlarmas = Date.now()
  recalcularProximaAlarma()
  ticReloj.subscribe(revisarAlarmasAhora)
}
