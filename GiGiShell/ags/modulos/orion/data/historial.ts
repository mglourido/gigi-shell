// Historial de actividad de Orion: estado reactivo + persistencia. La lógica
// (deduplicado, tope, saneado, tiempo relativo) es pura y vive en
// `historial.modelo.ts`.
//
// Vive en ~/.local/share/orion/historial.json, junto a los favoritos: es dato
// personal del usuario (qué abre y cuándo), así que ni en el repo ni en la caché
// — un limpiador de caché no debe llevárselo, pero tampoco es configuración.
//
// Quién escribe aquí, y solo eso:
//   - `launchApp` (data/launch.ts), cuando quien lanza pasa la identidad de la app;
//   - `addFavorite` (data/favorites.ts), al fijar;
//   - la sección reactiva, al pulsar un atajo entre los resultados.
// Una búsqueda que no acaba en nada no pasa por ninguno de los tres.

import GLib from "gi://GLib"
import { createState } from "ags"
import { cargarJsonCrudo, saveJsonAsync } from "../../../servicios/almacenamiento/json"
import {
  registrar, olvidarApp as olvidarAppDe, normalizarHistorial,
  type EntradaHistorial, type AccionApp,
} from "./historial.modelo"

export type { EntradaHistorial, EntradaApp, EntradaAtajo } from "./historial.modelo"

const RUTA = `${GLib.get_home_dir()}/.local/share/orion/historial.json`

const [historial, _setHistorial] = createState<EntradaHistorial[]>(
  normalizarHistorial(cargarJsonCrudo(RUTA, "orion-historial")),
)
export { historial }

function publicar(lista: EntradaHistorial[]) {
  if (lista === historial.get()) return
  _setHistorial(lista)
  saveJsonAsync(RUTA, { version: 1, entradas: lista }, "orion-historial")
}

export interface IdentidadApp {
  id: string
  nombre: string
  icono?: string
}

export function registrarApp(accion: AccionApp, app: IdentidadApp, exec: string) {
  const id = app.id.trim()
  if (!id || !app.nombre) return
  publicar(registrar(historial.get(), {
    tipo: "app", accion, id, nombre: app.nombre, exec, icono: app.icono ?? "", ts: Date.now(),
  }))
}

export function registrarAtajo(binding: string, descripcion: string) {
  if (!binding) return
  publicar(registrar(historial.get(), { tipo: "atajo", binding, descripcion, ts: Date.now() }))
}

/** Tras desinstalar: una fila que abre algo que ya no existe es un botón muerto. */
export function olvidarApp(id: string) {
  publicar(olvidarAppDe(historial.get(), id))
}

export function borrarHistorial() {
  publicar([])
}
