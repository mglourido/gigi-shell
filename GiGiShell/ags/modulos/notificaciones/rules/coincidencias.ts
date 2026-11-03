// modulos/notificaciones/rules/coincidencias.ts
// El REGISTRO de campos de coincidencia: en qué notificación se aplica una regla. Puro.
//
// UN CAMPO NUEVO (p. ej. la urgencia) = su entrada aquí + el campo en `MatchSpec` y `NotifInput`
// (`types.ts`) + rellenarlo en `procesamiento/ingesta.ts` + sus textos. El matcher, el saneado,
// la validación, el resumen y el editor lo recorren desde esta lista.
//
// El orden es el del resumen y el del editor (los que tienen `editor`).
import textos from "../../../textos/ajustes/notificaciones.json" with { type: "json" }
import { formatearTexto } from "../../../textos/formatear.ts"
import type { MatchSpec, NotifInput, StringMatch } from "./types.ts"

export type CampoCoincidencia = keyof MatchSpec

const OPERADOR: Record<StringMatch["op"], string> = {
  contains: textos.resumen.operadores.contiene,
  equals: textos.resumen.operadores.igual,
  regex: textos.resumen.operadores.expresionRegular,
}

export interface DefinicionCoincidencia {
  campo: CampoCoincidencia
  /** Contra qué texto de la notificación se compara. Sin dato = "" (no casa con nada exigente). */
  sujeto: (input: NotifInput) => string
  /** Nombre del campo en los errores de validación. */
  etiquetaValidacion: string
  resumen: (spec: StringMatch) => string
  /** Título en el editor. Sin él, el campo no se edita a mano (el del aviso lo fija el catálogo). */
  editor?: { titulo: string }
}

/** Frase estándar «<campo> <operador> "<valor>"». */
const conOperador = (plantilla: string) => (spec: StringMatch) =>
  formatearTexto(plantilla, { operador: OPERADOR[spec.op], valor: spec.value })

export const COINCIDENCIAS: DefinicionCoincidencia[] = [
  {
    campo: "app",
    sujeto: (i) => i.appName,
    etiquetaValidacion: textos.validacion.campos.aplicacion,
    resumen: conOperador(textos.resumen.coincidencias.app),
    editor: { titulo: textos.editor.titulos.aplicacion },
  },
  {
    campo: "summary",
    sujeto: (i) => i.summary,
    etiquetaValidacion: textos.validacion.campos.titulo,
    resumen: conOperador(textos.resumen.coincidencias.titulo),
    editor: { titulo: textos.editor.titulos.titulo },
  },
  {
    campo: "body",
    sujeto: (i) => i.body,
    etiquetaValidacion: textos.validacion.campos.cuerpo,
    resumen: conOperador(textos.resumen.coincidencias.cuerpo),
    editor: { titulo: textos.editor.titulos.cuerpo },
  },
  {
    // La identidad del aviso del sistema. Sin operador en el resumen: el id ya identifica UNA
    // notificación, y «el aviso contiene…» no aporta nada.
    campo: "event",
    sujeto: (i) => i.event ?? "",
    etiquetaValidacion: textos.validacion.campos.evento,
    resumen: (spec) => formatearTexto(textos.resumen.coincidencias.evento, { valor: spec.value }),
  },
  {
    // «system» = viene de un script de hypr/scripts (hint x-gigishell-source). Es lo que casa la
    // builtin del skin dunst; sin este campo en el editor esa regla no se podría editar.
    campo: "source",
    sujeto: (i) => i.source ?? "",
    etiquetaValidacion: textos.validacion.campos.origen,
    resumen: (spec) => spec.op === "equals" && spec.value === "system"
      ? textos.resumen.coincidencias.origenSistema
      : conOperador(textos.resumen.coincidencias.origen)(spec),
    editor: { titulo: textos.editor.titulos.origen },
  },
]

export const CAMPOS_COINCIDENCIA: CampoCoincidencia[] = COINCIDENCIAS.map((c) => c.campo)
