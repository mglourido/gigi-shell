import { createState } from "ags"
import GLib from "gi://GLib"
import { notifProcessingSuspended } from "../../../servicios/energia/powerState.ts"

export const [notifPanelVisible, setNotifPanelVisible] = createState(false)
export const [activeAppFilter, setActiveAppFilter] = createState<string>("all")
export const [selectionMode, setSelectionMode] = createState(false)
export const [selectedIds, setSelectedIds] = createState<Set<number>>(new Set())
export const [groupByApp, setGroupByApp] = createState(false)
export const [notifSettingsVisible, setNotifSettingsVisible] = createState(false)
export const [timeTick, setTimeTick] = createState(0)

export function openNotifPanel(): void {
  setNotifPanelVisible(true)
}

export function closeNotifPanel(): void {
  setNotifPanelVisible(false)
  setSelectionMode(false)
  setSelectedIds(new Set())
}

let temporizadorTiempo: number | null = null
const debeActualizarTiempo = () => notifPanelVisible.get() && !notifProcessingSuspended.get()

function sincronizarActualizacionTiempo(): void {
  if (debeActualizarTiempo()) {
    if (temporizadorTiempo !== null) return
    setTimeTick(timeTick.get() + 1)
    temporizadorTiempo = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 60000, () => {
      setTimeTick(timeTick.get() + 1)
      return GLib.SOURCE_CONTINUE
    })
  } else if (temporizadorTiempo !== null) {
    GLib.source_remove(temporizadorTiempo)
    temporizadorTiempo = null
  }
}

notifPanelVisible.subscribe(sincronizarActualizacionTiempo)
notifProcessingSuspended.subscribe(sincronizarActualizacionTiempo)
sincronizarActualizacionTiempo()
