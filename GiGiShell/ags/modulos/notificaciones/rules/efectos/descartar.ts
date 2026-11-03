// Descartar por completo: ni popup, ni panel, ni sonido. Lo consume la ingesta, no se guarda.
import textos from "../../../../textos/ajustes/notificaciones.json" with { type: "json" }
import { definirEfecto } from "./tipos.ts"

export default definirEfecto({
  clave: "suppress",
  valor: "booleano",
  destino: "resultado",
  porDefecto: false,
  resumen: (valor) => (valor ? textos.resumen.efectos.descartar : null),
  editor: { tipo: "interruptor", fila: "acciones", etiqueta: textos.editor.acciones.descartar },
})
