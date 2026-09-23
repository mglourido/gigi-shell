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

export function cargarJson<T>(path: string, fallback: T, label: string): T {
  return cargarJsonBase(path, fallback, `notif ${label}`)
}

export function saveJsonAsync(path: string, data: unknown, label: string): void {
  saveJsonAsyncBase(path, data, `notif ${label}`)
}

export function crearGuardadoJsonProgramado(
  path: string,
  label: string,
  demoraMs: number,
  obtenerDatos: () => unknown,
): () => void {
  return crearGuardadoBase(path, `notif ${label}`, demoraMs, obtenerDatos)
}
