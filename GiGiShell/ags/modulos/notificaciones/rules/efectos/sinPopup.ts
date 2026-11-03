// Guardar en el panel sin popup. «No la enseñes» no es «no me avises»: el sonido sigue.
import textos from "../../../../textos/ajustes/notificaciones.json" with { type: "json" }
import { definirEfecto } from "./tipos.ts"

export default definirEfecto({
  clave: "dontShow",
  valor: "booleano",
  destino: "meta",
  porDefecto: false,
  resumen: (valor) => (valor ? textos.resumen.efectos.sinPopup : null),
  editor: { tipo: "interruptor", fila: "acciones", etiqueta: textos.editor.acciones.sinPopup },
})
