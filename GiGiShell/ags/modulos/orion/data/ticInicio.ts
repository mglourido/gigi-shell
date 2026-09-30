// Un ÚNICO tic de 1 s para todo lo que se refresca solo en Inicio de Orion (las
// métricas de CPU/RAM/GPU y la barra de progreso de "Sonando"). Antes cada uno
// llevaba su propio temporizador, desalineados entre sí —y el de la barra, uno
// por monitor—, así que el proceso despertaba varias veces por segundo para lo
// que cabe en una: con un solo tic, todo se actualiza en el mismo despertar.
//
// Solo corre con Orion ABIERTO y en la sección Inicio, que es donde se ve todo
// esto; cerrado o en otra sección no hay temporizador. 1 s basta: las métricas
// no ganan nada por ir más rápido y la barra de progreso anima el tramo entre
// dos tics, así que no se ve a saltos.

import GLib from "gi://GLib"
import { createState } from "ags"
import { orionVisible, activeSection } from "../state"

export const [ticInicio, setTicInicio] = createState(0)

let fuente: number | null = null

/** ¿Se está viendo Inicio? (Orion abierto y en esa sección.) */
export function inicioVisible(): boolean {
  return orionVisible.get() && activeSection.get() === "inicio"
}

function sincronizar() {
  if (inicioVisible()) {
    if (fuente !== null) return
    fuente = GLib.timeout_add(GLib.PRIORITY_DEFAULT_IDLE, 1000, () => {
      setTicInicio(ticInicio.get() + 1)
      return GLib.SOURCE_CONTINUE
    })
  } else if (fuente !== null) {
    GLib.source_remove(fuente)
    fuente = null
  }
}

orionVisible.subscribe(sincronizar)
activeSection.subscribe(sincronizar)
