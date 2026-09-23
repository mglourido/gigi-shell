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
import { alReanudar } from "../../../servicios/sistema/reanudacion.ts"
import {
  VERSION_RELOJ,
  cronometroInicial,
  temporizadorInicial,
} from "./tipos.ts"
import type { Alarma, ArchivoReloj, Cronometro, DiaSemana, Temporizador } from "./tipos.ts"
import {
  alarmasQueVencen,
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
 * Tope de espera de un solo salto del planificador: 15 minutos.
 *
 * El plan es «un único temporizador para el próximo vencimiento», y lo sigue siendo — pero un
 * `GLib.timeout_add` **no corre mientras el equipo está suspendido**. Una alarma a ocho horas vista
 * armada de una tacada sonaría ocho horas de *actividad* después, o sea tarde y por sorpresa. El
 * tope trocea la espera y **recalcula contra el reloj de pared** en cada salto, así que volver de
 * suspender corrige la desviación en menos de quince minutos. Sigue sin haber sondeo por segundo:
 * son cuatro despertares por hora, y solo si hay alguna alarma activa.
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
    "-h", "string:x-gigios-source:alarm",
    titulo,
    cuerpo,
  ]).catch((e) => console.warn(`[${ETIQUETA}] no se pudo notificar:`, e))
}

// ── Planificador de alarmas ──────────────────────────────────────────────────

let temporizadorAlarmas: number | null = null

function cancelarPlanificador() {
  if (temporizadorAlarmas !== null) {
    GLib.source_remove(temporizadorAlarmas)
    temporizadorAlarmas = null
  }
}

function dispararVencidas() {
  const ahora = Date.now()
  const vencidas = alarmasQueVencen(alarmas.get(), ahora)
  if (vencidas.length === 0) return

  for (const alarma of vencidas) {
    emitirAlerta(
      alarma.etiqueta.trim() === "" ? "Alarma" : alarma.etiqueta,
      alarma.hora,
      alarma.sonido ?? SONIDO_ALARMA,
    )
  }

  const ids = new Set(vencidas.map((a) => a.id))
  // Las puntuales quedan desactivadas y las semanales siguen: `trasSonar` lo resuelve por tipo.
  establecerAlarmas(alarmas.get().map((a) => (ids.has(a.id) ? trasSonar(a) : a)))
}

function replanificar() {
  cancelarPlanificador()
  const ahora = Date.now()
  const proxima = siguienteVencimiento(alarmas.get(), ahora)
  if (proxima === null) return

  const espera = Math.max(1000, Math.min(proxima.cuando - ahora, MAX_ESPERA_MS))
  temporizadorAlarmas = GLib.timeout_add(GLib.PRIORITY_DEFAULT, espera, () => {
    temporizadorAlarmas = null
    dispararVencidas()
    replanificar()
    return GLib.SOURCE_REMOVE
  })
}

// Cualquier cambio en la lista rearma el único temporizador. `dispararVencidas` también escribe la
// lista, así que esta suscripción cierra el ciclo: sonar → desactivar → replanificar.
alarmas.subscribe(replanificar)

/**
 * Al volver de una suspensión hay que replanificar **ya**, no en el siguiente salto.
 *
 * El tope de 15 minutos de arriba acota la deriva, pero no la elimina, y el hueco que deja se come
 * alarmas enteras: si suspendes con un salto de 15 min armado y despiertas a las 07:00 con una
 * alarma a las 07:05, ese salto reanuda con los minutos que le quedaban y puede vencer a las 07:12
 * — momento en el que `alarmasQueVencen` ya no la ve, porque su tolerancia es de 30 s. La alarma no
 * suena tarde: **no suena**, y sin nada en el log. Replanificar contra el reloj de pared en cuanto
 * volvemos cierra esa ventana.
 *
 * Se aprovecha para repetir el saneado de la carga: una puntual cuya hora cayó DENTRO de la
 * suspensión no debe sonar con retraso (misma decisión que `sanearAlCargar`, y por el mismo motivo),
 * pero hasta ahora se quedaba marcada como activa hasta el siguiente arranque de AGS — visible en la
 * lista, y mintiendo. Desactivarla publica la lista, y esa publicación ya replanifica por la
 * suscripción de arriba; por eso el `return`.
 */
alReanudar(() => {
  const { alarmas: saneadas, desactivadas } = sanearAlCargar(alarmas.get(), Date.now())
  if (desactivadas.length > 0) {
    console.info(`[${ETIQUETA}] ${desactivadas.length} alarma(s) puntual(es) vencida(s) durante la suspensión`)
    establecerAlarmas(saneadas)
    return
  }
  replanificar()
})

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
  replanificar()
}
