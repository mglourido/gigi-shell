import Gio from "gi://Gio"
import { obtenerEntradaEscritorio } from "../aplicaciones/entradasEscritorio"
import {
  esIconoUtilizable,
  nombreBaseAplicacion,
  obtenerNombreIconoAplicacion,
} from "../aplicaciones/iconos"
import type { ClienteConProceso } from "./evidencia"

export interface AparienciaJuego {
  nombre: string
  icono: Gio.Icon | null
  nombreIcono: string | null
}

export const GLIFO_JUEGO = "󰊴"

function embellecer(clase: string): string {
  return nombreBaseAplicacion(clase)
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((palabra) => palabra.charAt(0).toUpperCase() + palabra.slice(1))
    .join(" ")
    .trim() || "Juego"
}

export function describirJuego(
  cliente: ClienteConProceso | null | undefined,
): AparienciaJuego {
  const clase = (cliente?.class ?? "").toLowerCase()
  const claseInicial = (cliente?.initialClass ?? cliente?.initial_class ?? "").toLowerCase()
  const titulo = (cliente?.title ?? "").trim()
  const entrada = obtenerEntradaEscritorio(cliente)

  const icono = entrada && esIconoUtilizable(entrada.icono) ? entrada.icono : null
  const nombreIcono = icono ? null : obtenerNombreIconoAplicacion(cliente)
  const esSteam = /steam_app_\d+/.test(clase) || /steam_app_\d+/.test(claseInicial)
  const nombre = entrada?.nombre
    || (titulo && titulo.length <= 40 ? titulo : "")
    || (esSteam ? "Juego de Steam" : embellecer(clase || claseInicial))

  return { nombre, icono, nombreIcono }
}
