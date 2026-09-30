// Acciones sobre UNA ventana de Hyprland por su dirección, para la página
// "Abiertas" de Orion y su menú lateral. Todo va por `hyprctl dispatch` con la
// forma Lua (`hl.dsp.…`): con el config en Lua la sintaxis legacy no existe, y
// ninguna de las dos falla por código de salida en la sesión equivocada.
//
// Pantalla completa y maximizar ENFOCAN primero y actúan sobre la ventana activa:
// es la cadena que ya usan la barra (`BotonEscritorio`, `IndicadorJuegos`) y la
// única verificada. Y van con `action='toggle'` en TABLA, nunca con una cadena
// suelta: un dispatcher conmutable con argumento de cadena es un toggle silencioso
// que ignora lo que le pidas (ver CLAUDE.md, "El config es LUA").

import { execAsync } from "ags/process"
import AstalHyprland from "gi://AstalHyprland"

const hypr = AstalHyprland.get_default()

function normalizar(direccion: string): string {
  return direccion.startsWith("0x") ? direccion : `0x${direccion}`
}

function despachar(expr: string): Promise<string> {
  return execAsync(["hyprctl", "dispatch", expr])
}

/** Enfoca la ventana (y con ello salta a su escritorio). */
export function enfocarVentana(direccion: string): Promise<unknown> {
  return despachar(`hl.dsp.focus({window='address:${normalizar(direccion)}'})`).catch(() => {})
}

/** Mueve la ventana al escritorio activo del monitor con foco y la enfoca. */
export function traerVentanaAqui(direccion: string): Promise<unknown> {
  const destino = hypr.get_focused_workspace?.()?.id
  if (typeof destino !== "number") return enfocarVentana(direccion)
  const dir = normalizar(direccion)
  return despachar(`hl.dsp.window.move({workspace=${destino}, window='address:${dir}'})`)
    .then(() => despachar(`hl.dsp.focus({window='address:${dir}'})`))
    .catch(() => {})
}

/** Alterna la pantalla completa REAL (modo 2). */
export function alternarPantallaCompletaVentana(direccion: string): Promise<unknown> {
  return enfocarVentana(direccion)
    .then(() => despachar("hl.dsp.window.fullscreen({mode='fullscreen', action='toggle'})"))
    .catch(() => {})
}

/** Alterna el maximizado (modo 1: ocupa el escritorio pero respeta la barra). */
export function alternarMaximizarVentana(direccion: string): Promise<unknown> {
  return enfocarVentana(direccion)
    .then(() => despachar("hl.dsp.window.fullscreen({mode='maximized', action='toggle'})"))
    .catch(() => {})
}

/** Pide a la ventana que se cierre (como SUPER+C: la app puede preguntar antes). */
export function cerrarVentana(direccion: string): Promise<unknown> {
  return despachar(`hl.dsp.window.close({window='address:${normalizar(direccion)}'})`).catch(() => {})
}

/** Modo de pantalla completa actual de la ventana (0 nada, 1 maximizada, 2 completa). */
export function modoPantallaCompleta(direccion: string): number {
  const dir = direccion.replace(/^0x/, "")
  const c = hypr.get_clients().find((x: any) => String(x.address).replace(/^0x/, "") === dir)
  return Number(c?.fullscreen ?? 0)
}
