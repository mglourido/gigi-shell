// Reescribir nombre de app, título o cuerpo con plantillas. Cada campo se resuelve por separado:
// una regla puede cambiar el título y otra el cuerpo.
import textos from "../../../../textos/ajustes/notificaciones.json" with { type: "json" }
import type { EffectSpec } from "../types.ts"
import { definirEfecto } from "./tipos.ts"

export default definirEfecto({
  clave: "rewrite",
  valor: "objeto",
  combinar: "por-campo",
  destino: "resultado",
  // Solo los tres campos conocidos, y solo si son texto: un número aquí llegaba al `text=` de un
  // `Gtk.Entry` del editor, que exige cadena.
  sanear: (v) => {
    const limpio: Record<string, string> = {}
    for (const campo of ["appName", "summary", "body"]) {
      const x = (v as Record<string, unknown>)[campo]
      if (typeof x === "string") limpio[campo] = x
    }
    return Object.keys(limpio).length ? limpio : undefined
  },
  resumen: (valor) => {
    const rw = valor as EffectSpec["rewrite"]
    if (!rw) return null
    const frases: string[] = []
    if (rw.appName === "") frases.push(textos.resumen.efectos.ocultarApp)
    else if (rw.appName !== undefined) frases.push(textos.resumen.efectos.renombrarApp)
    if (rw.summary !== undefined || rw.body !== undefined) frases.push(textos.resumen.efectos.reescribir)
    return frases
  },
  editor: { tipo: "reescritura", seccion: textos.editor.titulos.reescritura },
})
