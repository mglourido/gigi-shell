// Utilidades GTK compartidas por las secciones de Orion, que reconstruyen su
// contenido a mano (sin `<For>`, ver la nota de identidad de objeto en el
// CLAUDE.md raíz sobre `servicios/pantalla/`) y repetían el mismo bucle de
// vaciado en cada `rebuild`.

import { Gtk } from "ags/gtk4"

/**
 * Quita todos los hijos de `caja`. Si se pasa `conservar`, ese hijo concreto
 * sobrevive (caso de una etiqueta "sin resultados" que se añade una vez y
 * solo se alterna con `visible`).
 */
export function vaciarCaja(caja: Gtk.Box, conservar?: Gtk.Widget): void {
  let hijo = caja.get_first_child()
  while (hijo) {
    const siguiente = hijo.get_next_sibling()
    if (hijo !== conservar) caja.remove(hijo)
    hijo = siguiente
  }
}

/** Equivalente a `vaciarCaja` para `Gtk.FlowBox`, que no comparte su API de hijos. */
export function vaciarFlowBox(flow: Gtk.FlowBox): void {
  let hijo: Gtk.FlowBoxChild | null
  while ((hijo = flow.get_child_at_index(0)) !== null) flow.remove(hijo)
}
