// Handler de ficheros, con dos modos:
//
//  - **Con extensión** ("minecraft.jar", "factura.pdf", ".png"): sus filas van
//    ANTES que las apps (`primero`), no intercaladas: quien teclea la extensión
//    está buscando un fichero. Lo de antes del punto se compara con el nombre
//    del fichero; sin nada antes del punto, salen todos, los más recientes
//    primero.
//  - **Sin extensión** ("minecraft"): busca también ficheros que se llamen
//    así, con cualquier extensión o sin ninguna (un binario). Solo los
//    PROGRAMAS cuyo nombre empieza por lo tecleado tienen prioridad y van
//    delante (`tienePrioridad`); el resto compite por parecido con las apps
//    (`filas`), así que sale antes o después que ellas según cuál se parezca
//    más.
//
// Los ejecutables sueltos (.AppImage, .jar, .sh, .py, binarios) se lanzan con
// su intérprete o directamente; el resto se abre con la app predeterminada.

import GLib from "gi://GLib"
import Gio from "gi://Gio"
import type { HandlerMatch, SearchHandler, SearchResult } from "../types"
import { fuzzy } from "./apps"
import { ejecutablesIndexados, comandoDe, lanzarEjecutable } from "../../data/ejecutables"
import {
  separarConsulta, carpetaCorta, extensionDe, tienePrioridad, type FicheroEjecutable,
} from "../../data/ejecutables.modelo"

/** Tope propio: deja sitio debajo para las apps parecidas. */
const MAX_FICHEROS = 16

// Sin extensión el corpus son TODOS los ficheros de las carpetas, miles: una
// subsecuencia suelta ("fx" casa con medio disco) llenaría la lista de ruido.
// Se exige que el nombre CONTENGA lo tecleado (1600 en `fuzzy`), y para saltar
// delante de las apps, que EMPIECE por ello (1800): si no, teclear "te" para
// el terminal pondría encima cualquier binario con "te" en medio.
const SIMILITUD_MINIMA = 1600
const SIMILITUD_PRIORIDAD = 1800
/** Topes sin extensión: aquí lo normal es buscar una app, no un fichero. */
const MAX_PRIORITARIOS = 6
const MAX_PARECIDOS = 10

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
  // Un binario no tiene tipo que adivinar por el nombre (saldría
  // `application/octet-stream`): se pinta como ejecutable.
  const binario = f.ejecutable && extensionDe(f.ruta) === null
  return {
    // Estable entre consultas: la sección reactiva reutiliza la fila por id.
    id: `exe:${f.ruta}`,
    title: nombre,
    subtitle: carpetaCorta(f.ruta, CASA),
    icon: binario ? null : iconoDe(nombre),
    iconName: binario ? "application-x-executable" : "text-x-generic",
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
    if (!consulta) return buscarSinExtension(query.trim())

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

/** Nombre sin la extensión (si la tiene) para compararlo con lo tecleado. */
function sinExtension(ruta: string): string {
  const nombre = nombreDe(ruta)
  return extensionDe(ruta) === null ? nombre : nombre.slice(0, nombre.lastIndexOf("."))
}

function buscarSinExtension(q: string): HandlerMatch {
  if (q.length < 2) return { score: 0 }

  const prioritarios: { f: FicheroEjecutable; s: number }[] = []
  const parecidos: { f: FicheroEjecutable; s: number }[] = []
  for (const f of ejecutablesIndexados(null)) {
    const s = fuzzy(sinExtension(f.ruta), q) ?? 0
    if (s < SIMILITUD_MINIMA) continue
    ;(s >= SIMILITUD_PRIORIDAD && tienePrioridad(f) ? prioritarios : parecidos).push({ f, s })
  }
  if (prioritarios.length === 0 && parecidos.length === 0) return { score: 0 }

  const orden = (a: { f: FicheroEjecutable; s: number }, b: { f: FicheroEjecutable; s: number }) =>
    b.s - a.s || b.f.mtime - a.f.mtime
  prioritarios.sort(orden)
  parecidos.sort(orden)

  return {
    // Por debajo de las apps (0.75): a igual parecido manda la app, y este
    // handler nunca encabeza la búsqueda por sí solo.
    score: 0.6,
    primero: prioritarios.length > 0,
    build: () => prioritarios.slice(0, MAX_PRIORITARIOS).map(({ f }) => crearResultado(f)),
    filas: parecidos.slice(0, MAX_PARECIDOS).map(({ f, s }) => ({
      similitud: s,
      crear: () => crearResultado(f),
    })),
  }
}
