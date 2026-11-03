// Borrar del panel al reiniciar el sistema. Independiente del ciclo: combinable con cualquiera.
import textos from "../../../../textos/ajustes/notificaciones.json" with { type: "json" }
import { definirEfecto } from "./tipos.ts"

export default definirEfecto({
  clave: "clearOnBoot",
  valor: "booleano",
  destino: "motor",
  resumen: (valor) => (valor ? textos.resumen.efectos.limpiarReinicio : null),
  editor: { tipo: "interruptor", fila: "ciclo", etiqueta: textos.editor.acciones.limpiarReinicio },
})
