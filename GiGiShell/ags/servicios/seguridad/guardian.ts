// servicios/seguridad/guardian.ts — cliente del daemon de protección de archivos
// (gigishell-guardian, `guardian/` en la raíz del repo).
//
// ── AGS no toca la política ──────────────────────────────────────────────────
// Qué ficheros están protegidos y quién puede qué vive en
// /var/lib/gigishell-guardian/politica.json, de root y modo 600, y NO en
// ~/.config/gigishell/ como el resto de datos del shell: ahí cualquier proceso
// del usuario podría añadirse a sí mismo como permitido. Todo pasa por el socket
// /run/gigishell-guardian.sock (JSON por líneas: órdenes con `op`, avisos con
// `ev`; el contrato es `guardian/src/protocolo.rs`). El daemon solo acepta a
// este proceso (uid del usuario, /usr/bin/gjs-console, …/ags.js) y a un cliente
// a la vez.
//
// ── Encender y apagar piden contraseña, a propósito ─────────────────────────
// `pkexec systemctl enable --now | disable --now`, sin regla NOPASSWD: apagar la
// protección sin contraseña sería la forma más fácil de saltársela. Van por
// `withPrivilegedPrompt` porque Ajustes es una capa OVERLAY y el diálogo de
// polkit, una ventana normal, saldría DEBAJO (ver estado/shell.tsx).
//
// ── Un único temporizador ────────────────────────────────────────────────────
// No hay sondeo. El estado del servicio se lee al arrancar, al abrir la sección
// de Ajustes y al perder la conexión. El único temporizador es el reintento de
// conexión (3 s), y solo existe mientras el servicio está activo y el socket sin
// conectar. Con el servicio apagado (el valor por defecto) este módulo no deja
// nada corriendo.

import Gio from "gi://Gio"
import GLib from "gi://GLib"
import { createState } from "ags"
import { execAsync } from "ags/process"
import { withPrivilegedPrompt } from "../../estado/shell"

export type EstadoServicio = "desconocido" | "no-instalado" | "sin-bpf" | "apagado" | "activo" | "caido"
export type ModoCategoria = "permitir" | "preguntar" | "silencio"
export type DecisionPregunta = "siempre" | "proceso" | "denegar"
export type ResultadoHistorial =
  | "permitido" | "automatico" | "categoria" | "denegado"
  | "silencioso" | "tiempo_agotado" | "sin_ags" | "retirado"

export interface Permiso {
  programa: string
  leer: boolean
  modificar: boolean
  borrar: boolean
  desde: number
}

export interface Fichero {
  id: number
  ruta: string
  estado: "activo" | "no-disponible"
  anadido: number
  categorias: Record<string, ModoCategoria>
  permisos: Permiso[]
}

export interface Pregunta {
  id: number
  ruta: string
  programa: string
  pid: number
  operacion: string
  script?: string
  interprete: boolean
  cambiado: boolean
  /** Milisegundos desde epoch en que el daemon la deniega solo. */
  caduca: number
}

export interface Denegado {
  /** Identidad local, solo para descartar la tarjeta. */
  clave: number
  ruta: string
  programa: string
  operacion: string
  interprete: boolean
}

export interface EntradaHistorial {
  fecha: number
  ruta: string
  programa: string
  pid: number
  script?: string
  operacion: string
  resultado: ResultadoHistorial
}

const SOCKET = "/run/gigishell-guardian.sock"
const BINARIO = "/usr/local/bin/gigishell-guardian"
const SERVICIO = "gigishell-guardian.service"
const RECONEXION_MS = 3000

export const [estadoServicio, setEstadoServicio] = createState<EstadoServicio>("desconocido")
export const [conectado, setConectado] = createState(false)
export const [ficheros, setFicheros] = createState<Fichero[]>([])
export const [categoriasPorDefecto, setCategoriasPorDefecto] = createState<Record<string, ModoCategoria>>({})
export const [programasCategoria, setProgramasCategoria] = createState<Record<string, string[]>>({})
export const [preguntas, setPreguntas] = createState<Pregunta[]>([])
export const [denegados, setDenegados] = createState<Denegado[]>([])
/** Accesos denegados mientras AGS no estaba conectado (0 = no hay resumen). */
export const [resumen, setResumen] = createState(0)
export const [denegadosSemana, setDenegadosSemana] = createState(0)
export const [ultimoError, setUltimoError] = createState<string | null>(null)

let conexion: Gio.SocketConnection | null = null
let entrada: Gio.DataInputStream | null = null
let cancelable: Gio.Cancellable | null = null
let conectando = false
let temporizador: ReturnType<typeof setTimeout> | null = null
let siguienteClave = 1
const historialesPedidos = new Map<string, (entradas: EntradaHistorial[]) => void>()

// Espejo de `proceso::es_interprete` (guardian/src/proceso.rs): a estos nunca se
// les ofrece «siempre». El daemon lo impone igualmente; aquí es para no pintar
// un botón que no va a hacer lo que dice.
const INTERPRETES = new Set([
  "python", "node", "nodejs", "bash", "sh", "dash", "zsh", "fish", "perl", "ruby", "lua",
  "luajit", "gjs", "gjs-console", "bun", "deno", "java", "php",
])

export function esInterprete(exe: string): boolean {
  const nombre = exe.split("/").pop() ?? ""
  return INTERPRETES.has(nombre.replace(/[0-9.]+$/, ""))
}

async function leerEstadoServicio(): Promise<EstadoServicio> {
  if (!GLib.file_test(BINARIO, GLib.FileTest.EXISTS)) return "no-instalado"
  try {
    const [, lsm] = GLib.file_get_contents("/sys/kernel/security/lsm")
    if (!new TextDecoder().decode(lsm).split(",").map((s) => s.trim()).includes("bpf")) return "sin-bpf"
  } catch {
    return "sin-bpf"
  }
  // `is-active` sale con código ≠0 en cualquier estado que no sea activo, y
  // execAsync lo trataría como error: se lee su salida y se ignora el código.
  const salida = (await execAsync(["bash", "-c", `systemctl is-active ${SERVICIO} 2>/dev/null; true`])).trim()
  if (salida === "active" || salida === "activating" || salida === "reloading") return "activo"
  if (salida === "failed") return "caido"
  return "apagado"
}

/**
 * Relee el estado del servicio y conecta o desconecta según corresponda.
 * `conectarYa = false` deja la conexión para el temporizador: es lo que se usa
 * tras perder una, porque si el daemon nos está rechazando, reconectar al
 * instante sería un bucle sin pausa.
 */
export async function refrescarEstado(conectarYa = true): Promise<void> {
  let estado: EstadoServicio
  try {
    estado = await leerEstadoServicio()
  } catch (e) {
    console.error("[guardian] leyendo el estado del servicio:", e)
    return
  }
  setEstadoServicio(estado)
  if (estado === "activo") {
    if (!conexion && !conectando && conectarYa) conectar()
    // Ya conectado (p.ej. al abrir la sección de Ajustes): se refrescan los
    // datos, que el contador de la semana avanza sin que llegue ningún `cambio`.
    else if (conexion && conectarYa) {
      enviar({ op: "estado" })
      enviar({ op: "lista" })
    }
  } else {
    cancelarReconexion()
    cerrar()
  }
}

function cancelarReconexion() {
  if (temporizador !== null) {
    clearTimeout(temporizador)
    temporizador = null
  }
}

function programarReconexion() {
  if (temporizador !== null || conexion || estadoServicio.get() !== "activo") return
  temporizador = setTimeout(() => {
    temporizador = null
    refrescarEstado()
  }, RECONEXION_MS)
}

function conectar() {
  conectando = true
  cancelable = new Gio.Cancellable()
  const cliente = new Gio.SocketClient()
  cliente.connect_async(Gio.UnixSocketAddress.new(SOCKET), cancelable, (_c, res) => {
    conectando = false
    try {
      conexion = cliente.connect_finish(res)
    } catch {
      // El daemon aún no ha creado el socket (recién encendido) o nos ha
      // rechazado: se reintenta mientras el servicio siga activo.
      programarReconexion()
      return
    }
    entrada = new Gio.DataInputStream({ base_stream: conexion.get_input_stream(), close_base_stream: false })
    setConectado(true)
    setUltimoError(null)
    leerLinea()
    enviar({ op: "estado" })
    enviar({ op: "lista" })
  })
}

function leerLinea() {
  const flujo = entrada
  if (!flujo) return
  flujo.read_line_async(GLib.PRIORITY_DEFAULT, cancelable, (_f, res) => {
    let linea: string | null
    try {
      ;[linea] = flujo.read_line_finish_utf8(res)
    } catch {
      perdida()
      return
    }
    if (linea === null) {
      perdida()
      return
    }
    try {
      procesar(JSON.parse(linea))
    } catch (e) {
      console.error("[guardian] aviso no válido:", e)
    }
    leerLinea()
  })
}

function cerrar() {
  cancelable?.cancel()
  cancelable = null
  try { conexion?.close(null) } catch { /* ya estaba cerrada */ }
  conexion = null
  entrada = null
  conectando = false
  historialesPedidos.clear()
  if (conectado.get()) setConectado(false)
  // Las preguntas abiertas mueren con la conexión: el daemon las deniega al
  // vernos marchar, y contestarlas ya no llegaría a ningún sitio.
  if (preguntas.get().length > 0) setPreguntas([])
}

/** Se cayó la conexión (el daemon se paró, se cayó o nos cortó). */
function perdida() {
  if (!conexion) return
  cerrar()
  refrescarEstado(false).then(programarReconexion)
}

function enviar(orden: Record<string, unknown>): boolean {
  if (!conexion) return false
  try {
    const bytes = new TextEncoder().encode(JSON.stringify(orden) + "\n")
    conexion.get_output_stream().write_all(bytes, null)
    return true
  } catch (e) {
    console.error("[guardian] escribiendo en el socket:", e)
    perdida()
    return false
  }
}

function procesar(aviso: any) {
  switch (aviso.ev) {
    case "estado":
      setDenegadosSemana(aviso.denegados_semana ?? 0)
      break
    case "lista":
      setFicheros(aviso.ficheros ?? [])
      setCategoriasPorDefecto(aviso.categorias_por_defecto ?? {})
      setProgramasCategoria(aviso.categorias ?? {})
      break
    case "historial": {
      const cb = historialesPedidos.get(aviso.ruta)
      historialesPedidos.delete(aviso.ruta)
      cb?.(aviso.entradas ?? [])
      break
    }
    case "pregunta": {
      const { ev: _ev, ...pregunta } = aviso
      if (!preguntas.get().some((p) => p.id === pregunta.id)) {
        setPreguntas([...preguntas.get(), pregunta as Pregunta])
      }
      break
    }
    case "cerrar":
      setPreguntas(preguntas.get().filter((p) => p.id !== aviso.id))
      break
    case "denegado":
      setDenegados([...denegados.get(), {
        clave: siguienteClave++,
        ruta: aviso.ruta,
        programa: aviso.programa,
        operacion: aviso.operacion,
        interprete: aviso.interprete,
      }])
      break
    case "cambio":
      enviar({ op: "lista" })
      enviar({ op: "estado" })
      break
    case "resumen":
      setResumen((aviso.denegados ?? []).length)
      break
    case "error":
      setUltimoError(aviso.motivo ?? "error desconocido")
      console.error(`[guardian] ${aviso.op}: ${aviso.motivo}`)
      break
  }
}

export function initGuardian() {
  refrescarEstado()
}

async function comoAdministrador(args: string[]) {
  setUltimoError(null)
  try {
    await withPrivilegedPrompt(() => execAsync(["pkexec", "systemctl", ...args, SERVICIO]))
  } catch (e) {
    // pkexec sale con 126 si el usuario cancela el diálogo: no es un error que enseñar.
    const texto = String(e)
    if (!/126|dismissed|cancel/i.test(texto)) setUltimoError(texto)
  }
  await refrescarEstado()
}

export const activar = () => comoAdministrador(["enable", "--now"])
export const desactivar = () => comoAdministrador(["disable", "--now"])
export const reiniciar = () => comoAdministrador(["restart"])

export function responder(id: number, decision: DecisionPregunta) {
  setPreguntas(preguntas.get().filter((p) => p.id !== id))
  enviar({ op: "responder", id, decision })
}

export const proteger = (ruta: string) => enviar({ op: "proteger", ruta })
export const desproteger = (ruta: string) => enviar({ op: "desproteger", ruta })

export function fijarPermiso(ruta: string, programa: string, leer: boolean, modificar: boolean, borrar: boolean) {
  return enviar({ op: "permiso", ruta, programa, leer, modificar, borrar })
}

export function conceder(ruta: string, programa: string, operacion: string) {
  return enviar({ op: "conceder", ruta, programa, operacion })
}

export function fijarCategoria(ruta: string | null, nombre: string, valor: ModoCategoria) {
  return enviar(ruta === null ? { op: "categoria", nombre, valor } : { op: "categoria", ruta, nombre, valor })
}

/** Pide las `limite` entradas más recientes del historial de `ruta`. */
export function pedirHistorial(ruta: string, limite: number, cb: (entradas: EntradaHistorial[]) => void) {
  historialesPedidos.set(ruta, cb)
  if (!enviar({ op: "historial", ruta, limite })) historialesPedidos.delete(ruta)
}

export function descartarDenegado(clave: number) {
  setDenegados(denegados.get().filter((d) => d.clave !== clave))
}

export function descartarResumen() {
  setResumen(0)
}
