// modulos/notificaciones/settings/edicionDirecta.ts
// Puente entre el PANEL de notificaciones y los ajustes: el botón "Editar" del clic derecho
// sobre una tarjeta abre la ventana de ajustes ya metida en el editor de esa notificación,
// sin pasar por «Detectadas» ni buscarla en ninguna lista.
//
// Qué se abre depende de qué gestiona ya esa notificación, y el orden importa — abrir "lo
// nuevo" cuando ya existe algo que la controla llevaría al usuario a crear una segunda regla
// que compite con la primera, que es exactamente el lío que este botón viene a evitar:
//
//   1. Aviso del sistema con identidad (`x-gigios-event` del catálogo) → SU entrada del
//      catálogo, la misma que enseña la pestaña Sistema. Se guarda en `notif-sistema.json`.
//   2. Ya casa con una regla de usuario o predefinida → esa regla, para editarla de verdad.
//      `matchedRules` viene ordenado de mayor a menor prioridad, así que la primera que no
//      sea del catálogo es la que manda sobre esta notificación.
//   3. Nada la gestiona → una regla nueva prerrellenada con su app, su título y su cuerpo
//      (lo mismo que hace el botón "Crear regla" de «Detectadas»).
import { createState } from "ags"
import type { NotifRule } from "../rules/types.ts"
import type { StoredNotification } from "../estado/modelos.ts"
import { allRules } from "../rules/rulesStore.ts"
import { reglaDeEvento } from "../rules/sistemaStore.ts"
import { notifSettingsVisible, setNotifSettingsVisible } from "../estado/panel.ts"
import { ruleFromHistoryEntry } from "./ruleFactory.ts"

/** Regla que `SettingsTabs` debe abrir a pantalla completa. `null` = pestañas normales. */
const [reglaEnEdicion, setReglaEnEdicion] = createState<NotifRule | null>(null)
export { reglaEnEdicion }

export function reglaParaNotificacion(n: StoredNotification): NotifRule {
  if (n.event) {
    const delCatalogo = reglaDeEvento(n.event)
    if (delCatalogo) return delCatalogo
  }
  const idGestora = n.meta?.matchedRules?.find((id) => !id.startsWith("sistema."))
  if (idGestora) {
    const existente = allRules().find((r) => r.id === idGestora)
    if (existente) return existente
  }
  return ruleFromHistoryEntry(`user.${Date.now()}`, {
    app: n.appName,
    summary: n.summary,
    sampleBody: n.body,
  })
}

/** Abre los ajustes de notificaciones directamente en el editor de esta notificación. */
export function abrirEdicionNotificacion(n: StoredNotification): void {
  setReglaEnEdicion(reglaParaNotificacion(n))
  setNotifSettingsVisible(true)
}

export function cerrarEdicionNotificacion(): void {
  setReglaEnEdicion(null)
}

// Cerrar la ventana (Escape, clic fuera, el propio engranaje) tiene que soltar la edición
// pendiente: si no, la siguiente vez que se abran los ajustes se volverían a abrir dentro del
// editor de una notificación que ya no se estaba mirando.
notifSettingsVisible.subscribe(() => {
  if (!notifSettingsVisible.get()) setReglaEnEdicion(null)
})
