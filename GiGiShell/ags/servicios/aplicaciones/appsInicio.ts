// servicios/aplicaciones/appsInicio.ts — la lista de apps que se abren al
// iniciar la sesión.
//
// El dato vive en ~/.config/gigios/apps-inicio.json y lo consume un script de
// shell, `inicializador/apps-inicio.sh`, al que llama el autostart de Hyprland
// (una sola línea, a t=7). Aquí solo está la mitad de escritura: el estado
// reactivo que pinta Ajustes > Apps al inicio y su persistencia.
//
// **AGS no lanza estas apps, y no es un detalle de reparto.** Si las abriera el
// shell, dejarían de arrancar exactamente en la sesión en que el shell falla —
// que es justo cuando más falta hace tener delante el navegador o el terminal.
// El shell escribe la lista; el arranque de la sesión la ejecuta. Lo único que
// sí lanza desde aquí es el botón «probar», que es una acción del usuario con
// el shell delante y por definición no puede depender de otra cosa.
//
// Formato (`version` para poder migrar sin adivinar):
//   { "version": 1, "apps": [ { id, nombre, comando, icono,
//                               activo, escritorio, silencioso } ] }
//
// La validación de cada campo y el porqué de cada regla están en
// `appsInicioModelo.ts`, que es puro y tiene prueba.
//
// La escritura es síncrona a la acción del usuario (añadir, quitar, un
// interruptor) y no lleva debounce: son eventos sueltos, no un campo de texto
// que se teclea letra a letra. El número de escritorio se fija con botones de
// paso, y ahí el coste de una escritura de 300 bytes no justifica el
// temporizador.

import GLib from "gi://GLib"
import { createState } from "ags"
import { execAsync } from "ags/process"
import { cargarJson, rutaConfig, saveJsonAsync } from "../almacenamiento/json"
import {
  ESCRITORIO_ACTIVO,
  idLibreAppInicio,
  normalizarListaAppsInicio,
  sanearComando,
  sanearEscritorio,
  type AppInicio,
} from "./appsInicioModelo"

export { ESCRITORIO_ACTIVO, ESCRITORIO_MAX, sanearComando } from "./appsInicioModelo"
export type { AppInicio } from "./appsInicioModelo"

const ETIQUETA = "apps-inicio"
const RUTA = rutaConfig("apps-inicio.json")
const VERSION = 1

// Ruta canónica del symlink (~/.config/inicializador), no la del repo: es donde
// lo tiene Hyprland y donde lo busca todo lo demás. Mismo criterio que
// `modulos/orion/data/launch.ts` con `lanzar-anclado.py`.
const LANZADOR = `${GLib.get_user_config_dir()}/inicializador/apps-inicio.sh`

const [appsInicio, _setAppsInicio] = createState<AppInicio[]>(
  normalizarListaAppsInicio(cargarJson<{ apps?: unknown }>(RUTA, {}, ETIQUETA).apps),
)
export { appsInicio }

function guardar(lista: AppInicio[]) {
  _setAppsInicio(lista)
  saveJsonAsync(RUTA, { version: VERSION, apps: lista }, ETIQUETA)
}

function mapear(id: string, cambio: (app: AppInicio) => AppInicio) {
  const lista = appsInicio.get()
  if (!lista.some((app) => app.id === id)) return
  guardar(lista.map((app) => (app.id === id ? cambio(app) : app)))
}

/** Añade una entrada. Devuelve su id, o `null` si el comando queda vacío al sanearlo. */
export function anadirAppInicio(
  { nombre, comando, icono = "" }: { nombre: string; comando: string; icono?: string },
): string | null {
  const limpio = sanearComando(comando)
  if (!limpio) return null

  const lista = appsInicio.get()
  const titulo = nombre.trim() || limpio
  const id = idLibreAppInicio(titulo, lista.map((app) => app.id))
  guardar([...lista, {
    id,
    nombre: titulo,
    comando: limpio,
    icono,
    activo: true,
    escritorio: ESCRITORIO_ACTIVO,
    silencioso: false,
  }])
  return id
}

export function quitarAppInicio(id: string) {
  const lista = appsInicio.get()
  const restantes = lista.filter((app) => app.id !== id)
  if (restantes.length === lista.length) return
  guardar(restantes)
}

export function alternarAppInicio(id: string) {
  mapear(id, (app) => ({ ...app, activo: !app.activo }))
}

/**
 * Fija el escritorio de destino.
 *
 * Volver a "el activo" apaga el silencio de paso: sin escritorio fijado la
 * regla `silent` no se emite, y dejar el interruptor encendido enseñaría un
 * ajuste que no se está aplicando.
 */
export function fijarEscritorioAppInicio(id: string, escritorio: number) {
  mapear(id, (app) => {
    const destino = sanearEscritorio(escritorio)
    return {
      ...app,
      escritorio: destino,
      silencioso: destino === ESCRITORIO_ACTIVO ? false : app.silencioso,
    }
  })
}

export function alternarSilencioAppInicio(id: string) {
  mapear(id, (app) => (
    app.escritorio === ESCRITORIO_ACTIVO ? app : { ...app, silencioso: !app.silencioso }
  ))
}

/**
 * Abre AHORA una entrada, con sus reglas, sin esperar al próximo inicio de
 * sesión.
 *
 * Pasa por el MISMO script que el arranque (`--probar <id>`, que además ignora
 * el interruptor de activa y la marca de "ya lanzado en esta sesión") en vez de
 * hacer aquí su propio `sh -c`. Un botón de probar que ejecute por otro camino
 * no prueba nada: diría que funciona cuando el que falla es el camino real.
 */
export function probarAppInicio(id: string): void {
  execAsync([LANZADOR, "--probar", id]).catch(() => {})
}
