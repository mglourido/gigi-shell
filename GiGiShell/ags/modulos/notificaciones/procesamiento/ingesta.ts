// Punto único de entrada para las notificaciones recibidas.
// Single entry point for incoming notifications: classify via rules → apply on-receive cleanup
// (suppress, dedup) → store → schedule dynamic conditions. Lo llaman solo el handler de "notified"
// (`NotificationPopup.tsx`, en vivo) y `drenado.ts` (lo que guardó el respaldo con AGS caído).
import AstalNotifd from "gi://AstalNotifd"
import type { NotifEntrante } from "./entrante.ts"
import { notifications, setNotifications, removeNotification, scheduleStoreSave, appSettings, NOTIF_CAP, type StoredNotification } from "../store.ts"
import { ruleIndex } from "../rules/rulesStore.ts"
import { evaluate } from "../rules/engine.ts"
import { applyTemplate } from "../rules/template.ts"
import { buildNotifFields } from "../rules/notifFields.ts"
import { getCondition } from "../rules/conditions.ts"
import { idCanonico } from "../rules/catalogoSistema.ts"
import type { NotifInput } from "../rules/types.ts"
import { recordNotification } from "../history/historyStore.ts"
import { reproducirSonidoNotificacion } from "../sonido/reproductor.ts"
import { notificacionPermitida } from "../autoDnd/watcher.ts"
import { esPopupDuplicado } from "../popup/pila.ts"
// El estado de la suspensión falsa entra por la puerta más estrecha posible: una función del
// EFECTOR (`servicios/energia/suspensionFalsa/dnd.ts`), no el orquestador. Importar
// `suspensionFalsa.ts` desde aquí arrastraría `estado/shell` —que monta los paneles, y algunos
// de ellos acaban volviendo a este módulo— y el ciclo de imports resultante no falla al
// compilar: deja un `undefined` en el sitio menos esperado, en tiempo de ejecución.
import { silencioDeSuspensionFalsa } from "../../../servicios/energia/suspensionFalsa/dnd.ts"
import { sfSilenciarNotificaciones, sfSilenciarReloj } from "../../../servicios/energia/powerState.ts"

/** No molestar, leído del daemon en el momento. No se cachea: el auto-DND lo cambia solo. */
function noMolestarActivo(): boolean {
  try {
    return AstalNotifd.get_default().dontDisturb === true
  } catch (_) { return false }
}

/** Ejecuta un paso SECUNDARIO de la ingesta. La notificación ya está guardada cuando corren
 *  (historial, condiciones, sonido): si uno falla se registra y se sigue, en vez de perder el
 *  popup y dejar a medias los pasos de detrás. */
function pasoSecundario(nombre: string, paso: () => void): void {
  try { paso() } catch (e) { console.error(`[notif ingesta] ${nombre} falló:`, e) }
}

const conditionDisposers = new Map<number, (() => void)[]>()

export function disposeConditions(id: number): void {
  const arr = conditionDisposers.get(id)
  if (arr) { for (const d of arr) { try { d() } catch {} } conditionDisposers.delete(id) }
}

// Las notificaciones también desaparecen desde el panel y desde cleanupEngine. Observar el
// estado aquí cubre esas rutas sin hacer que almacen.ts dependa de este módulo de ingesta.
notifications.subscribe(() => {
  const idsActivos = new Set(notifications.get().map(({ id }) => id))
  for (const id of conditionDisposers.keys()) {
    if (!idsActivos.has(id)) disposeConditions(id)
  }
})

function scheduleConditions(stored: StoredNotification): void {
  // Un ID del daemon puede llegar de nuevo para actualizar la misma notificación. Sustituir
  // sus vigilantes evita acumular señales cuando la actualización cambia las condiciones.
  disposeConditions(stored.id)
  if (stored.meta.conditions.length === 0) return
  const disposers: (() => void)[] = []
  for (const name of stored.meta.conditions) {
    const provider = getCondition(name)
    if (!provider) continue
    try {
      disposers.push(provider.watch(stored, () => { removeNotification(stored.id); disposeConditions(stored.id) }))
    } catch (e) {
      console.error(`[notif] condición «${name}» no pudo vigilarse:`, e)
    }
  }
  if (disposers.length) conditionDisposers.set(stored.id, disposers)
}

/**
 * Ingiere una notificación, en vivo (`desdeAstal`) o diferida (`pendientes.ts`, lo que guardó el
 * respaldo con AGS caído): es el mismo camino para las dos. Devuelve la notificación almacenada
 * para que el popup la enseñe, o null si se suprimió, no debe verse o es diferida (esas van solo
 * al panel, sin popup ni sonido).
 */
export function ingest(n: NotifEntrante): StoredNotification | null {
  // Bridge: honor existing per-app mute (appSettings) until Phase 3 migrates it to rules.
  if (appSettings.get()[n.appName]?.muted) return null

  // Origen e identidad se leen ANTES de evaluar: las reglas casan por ambos (`match.source`,
  // `match.event`). Del primero depende la builtin que da el skin dunst a lo que sale de
  // hypr/scripts; del segundo, la configuración individual de cada aviso del sistema.
  const source = n.hint("x-gigishell-source")
  // Un emisor que aún mande un id antiguo (`antes` en `config/avisos-sistema.json`) se traduce
  // al vigente AQUÍ, antes de evaluar: así casa con su regla, se agrupa y se anula como el nuevo.
  const eventoCrudo = n.hint("x-gigishell-event")
  const event = eventoCrudo ? idCanonico(eventoCrudo) : undefined

  const input: NotifInput = {
    appName: n.appName || "Sistema",
    summary: n.summary,
    body: n.body,
    urgency: n.urgency,
    source,
    event,
  }
  const { meta, suppress, rewrite, soundFile: sonidoRegla } = evaluate(input, ruleIndex.get(), n.timestamp)
  if (suppress) return null

  // Text rewriting: placeholders resolve against the ORIGINAL notification fields + its hints.
  // appName === "" omits the app name; matching/dedup already used the original above.
  let appName = input.appName
  let summary = input.summary
  let body = input.body
  // Una plantilla rota no puede costar la notificación: se queda con el texto original.
  if (rewrite) pasoSecundario("reescritura", () => {
    const fields = buildNotifFields(
      { app_name: n.appName, summary: n.summary, body: n.body, urgency: n.urgency },
      n.timestamp, n.hintsTexto(),
    )
    if (rewrite.appName !== undefined) appName = applyTemplate(rewrite.appName, fields)
    if (rewrite.summary !== undefined) summary = applyTemplate(rewrite.summary, fields)
    if (rewrite.body !== undefined) body = applyTemplate(rewrite.body, fields)
  })

  const stored: StoredNotification = {
    id: n.id,
    appName: appName,
    appIcon: n.appIcon,
    summary: summary,
    body: body,
    timestamp: n.timestamp,
    read: false,
    urgency: input.urgency,
    actions: n.actions,
    // Lo pide NotificationPopup para dar más vida al popup cuando trae acciones: el
    // botón solo existe mientras el popup está en pantalla (las notificaciones de
    // hypr/scripts no llegan al historial), así que con los 5,5 s fijos de siempre no
    // daba tiempo ni a leerlo. En el spec 0 = "no expira nunca"; el popup lo acota.
    expireTimeout: n.expireTimeout,
    image: n.image,
    source,
    event,
    meta,
  }

  const current = notifications.get()
  // Dedup in the active list: drop any existing notif with the same dedupKey (supersede).
  const deduped = current.filter(x => {
    if (x.meta.dedupKey === stored.meta.dedupKey && x.id !== stored.id) { disposeConditions(x.id); return false }
    return true
  })
  const idx = deduped.findIndex(x => x.id === stored.id)
  const next = idx >= 0
    ? [...deduped.slice(0, idx), stored, ...deduped.slice(idx + 1)]
    : [...deduped, stored]

  // El tope se aplica aquí, en memoria, y no solo al serializar: guardar `slice(-NOTIF_CAP)`
  // acotaba el fichero pero dejaba crecer el array (y todo map/filter sobre él) durante la sesión.
  const overflow = next.length - NOTIF_CAP
  const capped = overflow > 0 ? next.slice(overflow) : next
  if (overflow > 0) for (const x of next.slice(0, overflow)) disposeConditions(x.id)

  setNotifications(capped)
  scheduleStoreSave()
  pasoSecundario("historial", () => recordNotification(stored))
  pasoSecundario("condiciones", () => scheduleConditions(stored))

  // Diferida: llegó con AGS caído y ya pasó su momento. Al panel y al historial sí (arriba), pero
  // ni popup ni sonido — decisión del usuario, ver `procesamiento/drenado.ts`.
  if (n.diferida) return null

  // Audio. Va DESPUÉS de almacenar y de las reglas: `meta.muteAudio` es su entrada, y una
  // notificación suprimida (`suppress`) o deduplicada ya salió por arriba sin llegar aquí. Suena
  // aunque `dontShow` la oculte del popup — «no la enseñes» no es «no me avises».
  // Una idéntica que ya está en pantalla no da aviso nuevo, tampoco por el altavoz.
  pasoSecundario("sonido", () => { if (!esPopupDuplicado(stored)) reproducirSonidoNotificacion({
    soundName: n.hint("sound-name"),
    soundFile: n.hint("sound-file"),
    suppressSound: n.hintBool("suppress-sound"),
    // Sonido puesto a mano en una regla o en un aviso del sistema. Es lo único capaz de hacer
    // sonar una notificación que no pedía sonido, y de cambiar el que pedía.
    sonidoRegla,
    noMolestar: noMolestarActivo() || !notificacionPermitida(stored),
    // Suspensión falsa: el DND que pone al entrar dejaría MUDAS las alarmas —No molestar calla
    // el sonido y una crítica no se lo salta—, así que se marca como motivo propio y el sonido
    // pasa a gobernarlo los dos ajustes. Con el DND manual del usuario esto viene a false y no
    // cambia nada. Ver `sonido/decision.ts` y la cabecera de `suspensionFalsa/dnd.ts`.
    dndSuspensionFalsa: silencioDeSuspensionFalsa(),
    sfSilenciarNotificaciones: sfSilenciarNotificaciones.get(),
    sfSilenciarReloj: sfSilenciarReloj.get(),
    // El hint de origen ya se leyó arriba para las reglas; aquí sirve para reconocer las
    // alertas del reloj sin inventarles un canal propio (`esAlertaReloj`).
    origen: source,
    muteAudio: meta.muteAudio,
    urgencia: input.urgency,
  }) })

  return stored.meta.dontShow ? null : stored
}
