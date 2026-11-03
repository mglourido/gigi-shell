// «Reemplazada por otra»: la retirada la hace la ingesta al llegar una con la misma clave de
// duplicado, así que aquí no hay nada que vigilar. Existe para que el nombre sea conocido y se
// pueda marcar desde el editor; en el resumen no se enseña porque no cambia nada.
import textos from "../../../../textos/ajustes/notificaciones.json" with { type: "json" }
import { definirCondicion } from "./tipos.ts"

export default definirCondicion({
  id: "superseded",
  etiqueta: textos.editor.condiciones.reemplazadaSinEfecto,
  resumen: null,
  vigilar: () => () => {},
})
