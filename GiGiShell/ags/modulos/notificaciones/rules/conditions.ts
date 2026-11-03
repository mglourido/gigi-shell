// modulos/notificaciones/rules/conditions.ts
// Adaptador de las condiciones dinámicas al sistema real. Las condiciones se DEFINEN en
// `rules/condiciones/` (puras, con test); aquí solo se les dan los servicios de verdad —el único
// `gi://` de todo el motor— y se expone la API que usa la ingesta.
import AstalBattery from "gi://AstalBattery"
import type { StoredNotification } from "../store.ts"
import { condicion } from "./condiciones/index.ts"
import type { ServiciosCondicion } from "./condiciones/tipos.ts"

const servicios: ServiciosCondicion = {
  bateria: () => AstalBattery.get_default(),
}

export interface ConditionProvider {
  name: string
  watch(notif: StoredNotification, resolve: () => void): () => void // returns disposer
}

export function getCondition(name: string): ConditionProvider | undefined {
  const definicion = condicion(name)
  if (!definicion) return undefined
  return {
    name,
    watch: (notif, resolve) => definicion.vigilar(notif, resolve, servicios),
  }
}
