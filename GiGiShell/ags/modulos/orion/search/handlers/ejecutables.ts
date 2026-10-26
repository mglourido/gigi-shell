// Handler de ficheros: se activa si la búsqueda termina en una extensión
// ("minecraft.jar", "factura.pdf", ".png"). Sus filas van ANTES que las apps
// (`primero`), no intercaladas: quien teclea la extensión está buscando un
// fichero. Lo de antes del punto se compara con el nombre del fichero; sin nada
// antes del punto, salen todos, los más recientes primero. Los ejecutables
// sueltos (.AppImage, .jar, .sh, .py) se lanzan con su intérprete; el resto se
// abre con la app predeterminada del sistema.

import GLib from "gi://GLib"
import Gio from "gi://Gio"
import type { HandlerMatch, SearchHandler, SearchResult } from "../types"
import { fuzzy } from "./apps"
import { ejecutablesIndexados, comandoDe, lanzarEjecutable } from "../../data/ejecutables"
import {
  separarConsulta, carpetaCorta, type FicheroEjecutable,
} from "../../data/ejecutables.modelo"

/** Tope propio: deja sitio debajo para las apps parecidas. */
const MAX_FICHEROS = 16

const CASA = GLib.get_home_dir()

/**
 * Icono del TIPO de fichero, el mismo que pinta Dolphin: se adivina el tipo
 * MIME por el nombre (sin leer el fichero, que podría estar en un disco lento)
 * y se pide su icono al sistema. Un `.AppImage` sale como `application/
 * vnd.appimage` y su icono genérico de ejecutable.
 */
function iconoDe(nombre: string): Gio.Icon | null {
  try {
    const [tipo] = Gio.content_type_guess(nombre, null)
    return tipo ? Gio.content_type_get_icon(tipo) : null
  } catch (_) {
    return null
  }
}

function nombreDe(ruta: string): string {
  return ruta.slice(ruta.lastIndexOf("/") + 1)
}

function crearResultado(f: FicheroEjecutable): SearchResult {
  const nombre = nombreDe(f.ruta)
  return {
    // Estable entre consultas: la sección reactiva reutiliza la fila por id.
    id: `exe:${f.ruta}`,
    title: nombre,
    subtitle: carpetaCorta(f.ruta, CASA),
    icon: iconoDe(nombre),
    iconName: "text-x-generic",
    meta: {
      // `exec` no vacío es lo que hace que la fila se trate como app (clic =
      // ficha, doble clic = abrir); el comando real se recalcula al lanzar por
      // si el bit de ejecución cambió entretanto.
      exec: comandoDe(f.ruta),
      execName: nombre,
      appId: `exe:${f.ruta}`,
      rutaEjecutable: f.ruta,
    },
    action: () => lanzarEjecutable(f.ruta),
  }
}

export const ejecutablesHandler: SearchHandler = {
  id: "ejecutables",
  defaultFor: [],
  inlineFor: [],

  match(query: string): HandlerMatch {
    const consulta = separarConsulta(query)
    if (!consulta) return { score: 0, build: () => [] }

    const base = consulta.base.toLowerCase()
    const candidatos = ejecutablesIndexados(consulta.ext)
    const puntuados = candidatos
      .map(f => {
        const sinExt = nombreDe(f.ruta).replace(/\.[^.]+$/, "")
        return { f, s: base ? fuzzy(sinExt, base) ?? 0 : 1 }
      })
      .filter(({ s }) => s > 0)
      .sort((a, b) => b.s - a.s || b.f.mtime - a.f.mtime)

    if (puntuados.length === 0) return { score: 0, build: () => [] }
    return {
      score: 0.95,
      primero: true,
      build: () => puntuados.slice(0, MAX_FICHEROS).map(({ f }) => crearResultado(f)),
    }
  },
}
