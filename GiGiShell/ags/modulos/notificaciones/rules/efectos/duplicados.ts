// Qué cuenta como duplicada en el panel. Lo usa el motor para calcular `meta.dedupKey`.
import textos from "../../../../textos/ajustes/notificaciones.json" with { type: "json" }
import { definirEfecto } from "./tipos.ts"

export default definirEfecto({
  clave: "dedupKey",
  // Una de las tres claves fijas o una plantilla `{template: "…"}`: por eso el tipo se comprueba
  // aquí y no con `valor` (que admitiría cualquier texto).
  valor: "cualquiera",
  destino: "motor",
  sanear: (v) => {
    if (typeof v === "string") return ["app", "app+summary", "app+summary+body"].includes(v) ? v : undefined
    const plantilla = (v as { template?: unknown } | null)?.template
    return typeof plantilla === "string" && plantilla ? { template: plantilla } : undefined
  },
  editor: {
    tipo: "opciones",
    titulo: textos.editor.titulos.duplicadas,
    ayuda: textos.editor.ayudas.duplicados,
    opciones: [
      { valor: "app", etiqueta: textos.editor.duplicados.app },
      { valor: "app+summary", etiqueta: textos.editor.duplicados.appTitulo },
      { valor: "app+summary+body", etiqueta: textos.editor.duplicados.appTituloCuerpo },
    ],
    // Sin valor (o con una plantilla, que el editor no edita) se aplica el de por defecto.
    seleccion: (valor) => (typeof valor === "string" ? valor : "app+summary"),
  },
})
