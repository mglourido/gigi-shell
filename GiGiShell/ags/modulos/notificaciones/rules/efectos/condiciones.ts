// Condiciones dinámicas: retiran la notificación sola. Las condiciones en sí están en
// `rules/condiciones/`; este efecto solo dice cuáles lleva la regla.
import textos from "../../../../textos/ajustes/notificaciones.json" with { type: "json" }
import { condicion } from "../condiciones/index.ts"
import { definirEfecto } from "./tipos.ts"

export default definirEfecto({
  clave: "conditions",
  valor: "lista-texto",
  combinar: "union",
  destino: "meta",
  sanear: (v) => ((v as string[]).length ? [...new Set(v as string[])] : undefined),
  porDefecto: [],
  resumen: (valor) => {
    if (!Array.isArray(valor) || valor.length === 0) return null
    const frases = valor.map((id) => {
      const c = condicion(id)
      return c ? c.resumen : id
    }).filter((f): f is string => !!f)
    return frases.length ? frases.join(textos.resumen.separadorEfectos) : null
  },
  editor: {
    tipo: "condiciones",
    avanzado: true,
    titulo: textos.editor.titulos.condiciones,
    ayuda: textos.editor.ayudas.condiciones,
  },
})
