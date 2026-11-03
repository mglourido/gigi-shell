// modulos/notificaciones/rules/condiciones/index.ts
// El REGISTRO de condiciones. El orden de esta lista es el de los botones del editor.
import type { DefinicionCondicion } from "./tipos.ts"
import bateria from "./bateria.ts"
import reemplazada from "./reemplazada.ts"
import actualizacion from "./actualizacion.ts"

export const CONDICIONES: DefinicionCondicion[] = [bateria, reemplazada, actualizacion]

const PORID = new Map(CONDICIONES.map((c) => [c.id, c]))

export function condicion(id: string): DefinicionCondicion | undefined {
  return PORID.get(id)
}

/** Las que se ofrecen en el editor (las que tienen etiqueta). */
export function condicionesEditables(): DefinicionCondicion[] {
  return CONDICIONES.filter((c) => c.etiqueta)
}
