// Fachada de persistencia de las notificaciones.
//
// La implementación (escritura atómica y asíncrona, y por qué es `replace_contents_bytes_async` y
// no `replace_contents_async`) vive en `servicios/almacenamiento/json.ts` desde que el calendario
// necesitó lo mismo. Aquí solo se conserva el prefijo `[notif]` de los logs y la firma que ya
// usaban `rulesStore.ts` e `historyStore.ts`.
import {
  cargarJson as cargarJsonBase,
  crearGuardadoJsonProgramado as crearGuardadoBase,
  saveJsonAsync as saveJsonAsyncBase,
} from "../../../servicios/almacenamiento/json.ts"

import { mismaForma } from "./saneado.ts"

/** Un JSON válido con otra forma (`null`, un array donde se esperaba objeto) cuenta como
 *  ilegible: los almacenes lo leen al importarse y un `null.userRules` tumbaba el arranque. */
export function cargarJson<T>(path: string, fallback: T, label: string): T {
  const leido = cargarJsonBase<unknown>(path, fallback, `notif ${label}`)
  if (mismaForma(leido, fallback)) return leido as T
  console.error(`[notif ${label}] forma inesperada en ${path}; se usa el valor por defecto`)
  return fallback
}

export function saveJsonAsync(
  path: string, data: unknown, label: string, alTerminar?: (ok: boolean) => void,
): void {
  saveJsonAsyncBase(path, data, `notif ${label}`, undefined, alTerminar)
}

export function crearGuardadoJsonProgramado(
  path: string,
  label: string,
  demoraMs: number,
  obtenerDatos: () => unknown,
): () => void {
  return crearGuardadoBase(path, `notif ${label}`, demoraMs, obtenerDatos)
}
