// Reservada para «cuando se aplique la actualización»: hoy no hay forma fiable de saberlo, así que
// no vigila nada y no se ofrece en el editor. Registrada para que una regla que ya la nombre no
// falle y su resumen se lea bien.
import textos from "../../../../textos/ajustes/notificaciones.json" with { type: "json" }
import { definirCondicion } from "./tipos.ts"

export default definirCondicion({
  id: "update-applied",
  resumen: textos.resumen.condiciones.actualizacion,
  vigilar: () => () => {},
})
