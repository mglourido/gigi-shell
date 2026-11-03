// No registrar en «Detectadas». Sin frase en el resumen, como siempre.
import textos from "../../../../textos/ajustes/notificaciones.json" with { type: "json" }
import { definirEfecto } from "./tipos.ts"

export default definirEfecto({
  clave: "noHistory",
  valor: "booleano",
  destino: "meta",
  porDefecto: false,
  editor: { tipo: "interruptor", fila: "acciones", etiqueta: textos.editor.acciones.sinHistorial, ayudaFila: textos.editor.ayudas.efectos },
})
