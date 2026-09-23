// Orquestación de la sincronización con Google Calendar. Une el cliente HTTP, el mapeo puro y la
// fusión pura con el estado del panel.
//
// **No hay sondeo.** Se sincroniza al conectar la cuenta, al abrir el panel, al pulsar actualizar y
// después de una mutación propia. Un calendario no cambia solo cada treinta segundos, y los
// webhooks quedan fuera de alcance porque exigen un receptor HTTPS público, que unos dotfiles no
// tienen. La consecuencia aceptada es que un evento creado en el móvil aparece aquí la próxima vez
// que abras el panel, no al instante.
//
// **El disparador de "al abrir el panel" vive AQUÍ, no en el widget del chip.** Estaba en
// `EstadoGoogle`, que se construye una vez por monitor: con tres pantallas, abrir el panel lanzaba
// tres `sincronizar()` y tres lecturas del fichero de credenciales. El `enCurso` salvaba la red,
// no el resto. Un disparador global es global, y este módulo se evalúa una sola vez.

import GLib from "gi://GLib"
import { createState } from "ags"
import { calendarVisible } from "../../../estado/shell"
import { cargarJsonCrudo, rutaConfig, saveJsonAsync } from "../../../servicios/almacenamiento/json.ts"
import { hoyISO, sumarDias } from "../dominio/fechas.ts"
import type { EventoCalendario } from "../dominio/tipos.ts"
import { eventos, reemplazarEventos } from "../estado.ts"
import { hayCuentaConfigurada } from "./autenticacion.ts"
import {
  actualizarEventoRemoto,
  crearEventoRemoto,
  eliminarEventoRemoto,
  listarCalendarios,
  listarEventos,
} from "./cliente.ts"
import { fusionar, mutacionesPendientes, trasSubir } from "./fusion.ts"
import { calendarioDesdeGoogle, desdeGoogle, haciaGoogle } from "./mapeo.ts"
import type { CalendarioGoogle } from "./mapeo.ts"

export type EstadoSincronizacion =
  | { fase: "sin-configurar" }
  | { fase: "sincronizando" }
  | { fase: "actualizado"; cuando: number }
  | { fase: "sin-conexion" }
  | { fase: "error"; mensaje: string }

export const [estadoSync, establecerEstadoSync] = createState<EstadoSincronizacion>(
  hayCuentaConfigurada() ? { fase: "actualizado", cuando: 0 } : { fase: "sin-configurar" },
)
export const [calendariosRemotos, establecerCalendariosRemotos] = createState<CalendarioGoogle[]>([])

/**
 * Tokens incrementales, en su propio fichero.
 *
 * Aparte de los eventos porque son estado de la conversación con Google, no datos del usuario:
 * borrar este fichero solo cuesta una sincronización completa, mientras que mezclarlo con
 * `calendario.json` haría que un token corrupto arrastrase a los eventos. Y aparte de las
 * credenciales porque este no es un secreto y no necesita 0600.
 */
const RUTA_SYNC = rutaConfig("google-calendar-sync.json")

function leerSyncTokens(): Record<string, string> {
  const crudo = cargarJsonCrudo(RUTA_SYNC, "google-calendar sync")
  if (crudo === null || typeof crudo !== "object") return {}
  const salida: Record<string, string> = {}
  for (const [k, v] of Object.entries(crudo as Record<string, unknown>)) {
    if (typeof v === "string") salida[k] = v
  }
  return salida
}

function guardarSyncTokens(tokens: Record<string, string>) {
  saveJsonAsync(RUTA_SYNC, tokens, "google-calendar sync")
}

/**
 * Exclusión mutua: una sincronización a la vez.
 *
 * Sin esto, abrir el panel mientras otra pasada sigue en vuelo lanzaría dos fusiones sobre la misma
 * lista y la segunda escribiría encima de la primera con datos de antes.
 */
let enCurso = false

/**
 * Mínimo entre dos sincronizaciones AUTOMÁTICAS.
 *
 * Abrir el panel sincroniza, y el panel se abre y se cierra constantemente — mirar la hora en la
 * pestaña Reloj cuenta como abrirlo. Sin suelo, diez aperturas en un minuto eran diez pasadas
 * completas: el listado de calendarios más una petición de eventos por cada uno, todas por `curl`.
 * Un calendario no cambia diez veces por minuto.
 *
 * **Solo acota lo automático.** El botón de refrescar del chip pasa `manual: true` y se salta el
 * suelo: si el usuario pulsa "actualizar" es precisamente porque sabe algo que nosotros no.
 *
 * **Una pasada que FALLA no gasta el minuto entero.** El suelo existe para no repetir un trabajo
 * que ya está hecho; si no se hizo, castigar el reintento deja el calendario desactualizado justo
 * cuando vuelve la conexión — y sin nada en pantalla que explique por qué reabrir el panel no lo
 * arregla. Tras un error se rebaja a `MIN_INTERVALO_FALLO_MS`, que sigue evitando el machaque de
 * abrir y cerrar sin red.
 */
const MIN_INTERVALO_AUTO_MS = 60_000
const MIN_INTERVALO_FALLO_MS = 10_000

/** Instante a partir del cual se permite otra sincronización automática. */
let proximaAuto = 0

function posponerAuto(ms: number) {
  proximaAuto = Date.now() + ms
}

/** Ventana de la primera sincronización: no tiene sentido bajarse el calendario de 2011. */
const DIAS_ATRAS = 90

export async function sincronizar(
  opciones: { forzarCompleta?: boolean; manual?: boolean; periodico?: boolean } = {},
): Promise<void> {
  if (enCurso) return
  // `periodico` se salta el suelo por la misma razón que `manual`, y no es una excepción que lo
  // deje sin efecto: el suelo existe para que ABRIR y cerrar el panel en bucle no sea un sondeo, y
  // aquí el limitador ES el propio temporizador, que dispara una vez por minuto y nada más. Sin
  // esto un tic caído a 59,9 s del anterior se lo tragaría el suelo y el refresco real serían dos
  // minutos, la mitad de las veces y sin ninguna señal de por qué.
  const saltarSuelo =
    opciones.manual === true || opciones.forzarCompleta === true || opciones.periodico === true
  if (!saltarSuelo && Date.now() < proximaAuto) return
  if (!hayCuentaConfigurada()) {
    establecerEstadoSync({ fase: "sin-configurar" })
    return
  }

  enCurso = true
  posponerAuto(MIN_INTERVALO_AUTO_MS)
  establecerEstadoSync({ fase: "sincronizando" })
  try {
    // El orden importa: primero se SUBE lo pendiente y luego se baja. Al revés, la bajada marcaría
    // como conflicto lo que estaba a punto de subirse sin problema.
    await subirPendientes()

    const listado = await listarCalendarios()
    if (!listado.ok) {
      posponerAuto(MIN_INTERVALO_FALLO_MS)
      establecerEstadoSync(listado.estado === 0 ? { fase: "sin-conexion" } : { fase: "error", mensaje: `HTTP ${listado.estado}` })
      return
    }

    const calendarios: CalendarioGoogle[] = []
    for (const crudo of listado.datos?.items ?? []) {
      const cal = calendarioDesdeGoogle(crudo)
      if (cal) calendarios.push(cal)
    }
    establecerCalendariosRemotos(calendarios)

    const tokens = leerSyncTokens()
    let huboError = false

    // **Descargar y fusionar están separados a propósito.** Antes cada calendario terminaba con su
    // propio `reemplazarEventos`, o sea una publicación de estado por calendario: con cuatro
    // calendarios eran cuatro invalidaciones del índice del mes y cuatro reconstrucciones de la
    // cuadrícula y de la agenda, en cada monitor, en mitad de la sincronización. Ahora la parte
    // lenta (la red) se hace de una en una y la fusión de todas va en UNA sola pasada síncrona.
    //
    // El orden no es solo eficiencia: la fusión final parte de `eventos.get()` leído AL FINAL, así
    // que un evento que el usuario cree o edite mientras la sincronización está en vuelo sobrevive.
    // Con una escritura por calendario, ese cambio caía con la siguiente.
    const descargas: Array<{ calendario: CalendarioGoogle; datos: DescargaCalendario }> = []
    for (const calendario of calendarios) {
      const datos = await descargarCalendario(calendario, tokens, opciones.forzarCompleta === true)
      if (datos === null) huboError = true
      else descargas.push({ calendario, datos })
    }

    if (descargas.length > 0) {
      let lista = eventos.get()
      let conflictos = 0
      for (const { calendario, datos } of descargas) {
        const fusion = fusionar(lista, {
          remotos: datos.remotos,
          eliminados: datos.eliminados,
          calendarioId: calendario.id,
          completa: datos.completa,
        })
        lista = fusion.eventos
        conflictos += fusion.conflictos
      }
      reemplazarEventos(lista)
      if (conflictos > 0) {
        console.info(`[google-calendar] ${conflictos} conflicto(s) sin resolver`)
      }
    }

    guardarSyncTokens(tokens)
    if (huboError) posponerAuto(MIN_INTERVALO_FALLO_MS)
    establecerEstadoSync(
      huboError ? { fase: "error", mensaje: "sincronización parcial" } : { fase: "actualizado", cuando: Date.now() },
    )
  } catch (e) {
    posponerAuto(MIN_INTERVALO_FALLO_MS)
    console.warn("[google-calendar] sincronización fallida:", e)
    establecerEstadoSync({ fase: "error", mensaje: String(e) })
  } finally {
    enCurso = false
  }
}

/** Lo que una pasada de red trae de un calendario. La fusión ocurre después, toda junta. */
interface DescargaCalendario {
  remotos: EventoCalendario[]
  eliminados: string[]
  /** `true` = pasada completa (sin `syncToken`): la fusión puede aplicar borrados por ausencia. */
  completa: boolean
}

/** Descarga un calendario. `null` = falló; el llamante lo cuenta como sincronización parcial. */
async function descargarCalendario(
  calendario: CalendarioGoogle,
  tokens: Record<string, string>,
  forzarCompleta: boolean,
): Promise<DescargaCalendario | null> {
  let syncToken = forzarCompleta ? undefined : tokens[calendario.id]
  let pageToken: string | undefined
  const remotos: EventoCalendario[] = []
  const eliminados: string[] = []
  const timeMin = `${sumarDias(hoyISO(), -DIAS_ATRAS)}T00:00:00Z`

  // Índice remotoId → id local, para no cambiarle el id a lo que ya conocíamos.
  const idsConocidos = new Map<string, string>()
  for (const ev of eventos.get()) {
    if (ev.remotoId && ev.calendarioId === calendario.id) idsConocidos.set(ev.remotoId, ev.id)
  }

  let vueltas = 0
  do {
    const pagina = await listarEventos(calendario.id, { syncToken, pageToken, timeMin })

    if (pagina.syncTokenCaducado) {
      // 410: Google ha tirado el token incremental. Se reconstruye con una pasada completa; no se
      // borra nada antes de tenerla, que es lo que evita quedarse con el calendario a medias.
      delete tokens[calendario.id]
      return descargarCalendario(calendario, tokens, true)
    }
    if (!pagina.ok) return null

    for (const crudo of pagina.datos?.items ?? []) {
      const r = desdeGoogle(crudo as any, calendario.id, calendario.permiso, (rid) => idsConocidos.get(rid))
      if (r.tipo === "evento") remotos.push(r.evento)
      else if (r.tipo === "eliminado") eliminados.push(r.remotoId)
    }

    pageToken = pagina.datos?.nextPageToken
    if (pagina.datos?.nextSyncToken) tokens[calendario.id] = pagina.datos.nextSyncToken
    // Tope de seguridad: una paginación que no termina nunca (token que no avanza) colgaría la
    // sincronización para siempre y con ella el panel.
    vueltas++
  } while (pageToken && vueltas < 40)

  return { remotos, eliminados, completa: syncToken === undefined }
}

/**
 * Cola offline: sube lo pendiente.
 *
 * Un fallo en una mutación **no aborta las demás ni descarta la pendiente**: se queda en cola para
 * el siguiente intento. Es lo que hace que crear un evento sin conexión funcione — se guarda local,
 * se marca, y sube cuando haya red.
 */
async function subirPendientes(): Promise<void> {
  // Las confirmaciones se ACUMULAN y se aplican de una vez, por lo mismo que la fusión de la
  // bajada: cada `reemplazarEventos` es una publicación de estado, y con diez mutaciones en cola
  // eran diez reconstrucciones de la cuadrícula y de la agenda por monitor mientras subía. Y como
  // `trasSubir` es puro, plegarlas al final sobre `eventos.get()` respeta lo que el usuario haya
  // tocado durante la subida.
  const confirmadas: Array<{ id: string; remoto: Parameters<typeof trasSubir>[2] }> = []

  for (const mutacion of mutacionesPendientes(eventos.get())) {
    const { evento, tipo } = mutacion
    if (evento.permiso !== "escritura") continue

    try {
      if (tipo === "eliminar") {
        if (!evento.remotoId) {
          confirmadas.push({ id: evento.id, remoto: null })
          continue
        }
        const r = await eliminarEventoRemoto(evento.calendarioId, evento.remotoId)
        // Un 404 es éxito para un borrado: ya no está, que es justo lo que se pedía.
        if (r.ok || r.estado === 404) confirmadas.push({ id: evento.id, remoto: null })
        continue
      }

      const cuerpo = haciaGoogle(evento)
      const r = evento.remotoId
        ? await actualizarEventoRemoto(evento.calendarioId, evento.remotoId, cuerpo)
        : await crearEventoRemoto(evento.calendarioId, cuerpo)
      if (!r.ok || !r.datos) continue

      const datos = r.datos as Record<string, unknown>
      confirmadas.push({
        id: evento.id,
        remoto: {
          remotoId: typeof datos.id === "string" ? datos.id : evento.remotoId,
          etag: typeof datos.etag === "string" ? datos.etag : undefined,
          actualizadoEn: typeof datos.updated === "string" ? datos.updated : undefined,
        },
      })
    } catch (e) {
      console.warn(`[google-calendar] no se pudo subir ${evento.id}:`, e)
    }
  }

  if (confirmadas.length === 0) return
  let lista = eventos.get()
  for (const { id, remoto } of confirmadas) lista = trasSubir(lista, id, remoto)
  reemplazarEventos(lista)
}

/** Texto del chip de la cabecera. */
export function textoEstado(estado: EstadoSincronizacion): string {
  switch (estado.fase) {
    case "sin-configurar": return "Google sin conectar"
    case "sincronizando": return "Sincronizando…"
    case "sin-conexion": return "Sin conexión"
    case "error": return `Error: ${estado.mensaje}`
    case "actualizado": return estado.cuando === 0 ? "Google conectado" : "Actualizado"
  }
}

/**
 * Refresco periódico MIENTRAS EL PANEL ESTÁ ABIERTO.
 *
 * **No hay forma de que Google avise, y conviene saber por qué antes de intentar quitarlo.** La API
 * de Calendar solo ofrece *push* por `watch`, que consiste en que Google haga una petición a un
 * receptor **HTTPS público con certificado válido**; no existe long-poll, ni streaming, ni un
 * socket al que suscribirse desde un cliente. Unos dotfiles no tienen dónde recibir eso, así que
 * un temporizador es la única opción posible, no una elección de comodidad.
 *
 * **Solo corre con el panel visible.** Con el panel cerrado el sondeo sería un `curl` por minuto
 * durante toda la sesión para actualizar algo que nadie está mirando, y abrir el panel ya
 * sincroniza de por sí. Es el mismo criterio que el reloj de la cuadrícula y el tic del
 * cronómetro: nada que se vea depende de un temporizador que siga vivo cuando no se ve.
 */
const INTERVALO_PANEL_ABIERTO_S = 60
let tickRefresco = 0

function pararRefrescoPeriodico() {
  if (tickRefresco !== 0) {
    GLib.source_remove(tickRefresco)
    tickRefresco = 0
  }
}

function arrancarRefrescoPeriodico() {
  if (tickRefresco !== 0) return
  tickRefresco = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, INTERVALO_PANEL_ABIERTO_S, () => {
    if (!calendarVisible.get() || !hayCuentaConfigurada()) {
      tickRefresco = 0
      return GLib.SOURCE_REMOVE
    }
    void sincronizar({ periodico: true })
    return GLib.SOURCE_CONTINUE
  })
}

/**
 * Abrir el panel pone el calendario al día. **Una sola suscripción para todo el shell.**
 *
 * Vivía dentro de `EstadoGoogle`, que se construye una vez por monitor; aquí se registra una vez
 * porque el módulo se evalúa una vez. Cerrar el panel no cancela la pasada en curso, que termina
 * sola; lo que sí para es el refresco periódico.
 */
calendarVisible.subscribe(() => {
  if (calendarVisible.get() && hayCuentaConfigurada()) {
    void sincronizar()
    arrancarRefrescoPeriodico()
  } else {
    pararRefrescoPeriodico()
  }
})

/**
 * Una mutación propia (crear, editar, borrar) SUBE EN EL ACTO, sin esperar a la próxima apertura.
 *
 * Antes no lo hacía: `eliminarEvento` marcaba `pendiente: "eliminar"`, ocultaba el evento y la cola
 * la vaciaba `subirPendientes()` en la siguiente pasada, o sea al reabrir el panel. Nada se perdía
 * —la cola va en `calendario.json` y sobrevive a un reinicio— pero el resultado de la petición
 * llegaba cuando ya no estabas mirando, así que un borrado que fallara no tenía forma de contarlo:
 * el chip te enseñaba el error de una acción hecha diez minutos antes.
 *
 * **El disparador es la LISTA de eventos, no una llamada desde `estado.ts`.** `sincronizacion.ts`
 * ya importa de `estado.ts`; llamar desde allí hacia aquí cerraría un ciclo de imports entre los
 * dos módulos. Observando la lista, la dependencia sigue yendo en un solo sentido.
 *
 * **Y por eso hace falta la firma.** Este módulo también escribe la lista (`reemplazarEventos` al
 * final de cada pasada), así que reaccionar a cualquier cambio sería reentrar: una subida que
 * FALLA deja la mutación pendiente, la escritura de la fusión notifica, y volveríamos a
 * sincronizar contra el mismo error en bucle cerrado. Comparando la firma de la cola solo se
 * dispara cuando la cola CAMBIA de verdad, o sea cuando el usuario ha hecho algo nuevo; un fallo se
 * reintenta en la siguiente apertura o en el tic del minuto, que ya es donde toca.
 */
const REBOTE_MUTACION_MS = 800
let firmaColaUltimoIntento = ""
let reboteMutacion = 0

function firmaCola(): string {
  return mutacionesPendientes(eventos.get())
    .map((m) => `${m.tipo}:${m.evento.id}`)
    .sort()
    .join("|")
}

eventos.subscribe(() => {
  if (!hayCuentaConfigurada()) return
  const firma = firmaCola()
  // Cola vacía: se olvida el último intento para que volver a tocar ese mismo evento dispare.
  if (firma === "") {
    firmaColaUltimoIntento = ""
    return
  }
  if (firma === firmaColaUltimoIntento) return
  firmaColaUltimoIntento = firma

  // Rebote corto: editar un evento toca la lista varias veces seguidas y guardar dos cambios
  // seguidos son dos notificaciones. Se sube una vez, con todo dentro.
  if (reboteMutacion !== 0) GLib.source_remove(reboteMutacion)
  reboteMutacion = GLib.timeout_add(GLib.PRIORITY_DEFAULT, REBOTE_MUTACION_MS, () => {
    reboteMutacion = 0
    void sincronizar({ manual: true })
    return GLib.SOURCE_REMOVE
  })
})
