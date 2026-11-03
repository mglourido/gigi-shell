// Color de acento. Prioridad: color de regla > color por app > color por defecto.
import textos from "../../../../textos/ajustes/notificaciones.json" with { type: "json" }
import { formatearTexto } from "../../../../textos/formatear.ts"
import { isValidHex } from "../color.ts"
import { definirEfecto } from "./tipos.ts"

export default definirEfecto({
  clave: "color",
  valor: "texto",
  destino: "meta",
  sanear: (v) => (isValidHex(v as string) ? v : undefined),
  validar: (valor) =>
    valor !== undefined && !isValidHex(valor as string)
      ? [formatearTexto(textos.validacion.color, { valor })]
      : [],
  resumen: (valor) => (valor ? formatearTexto(textos.resumen.efectos.color, { color: valor }) : null),
  editor: { tipo: "color", titulo: textos.editor.titulos.color },
})
