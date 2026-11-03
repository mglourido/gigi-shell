// Retira un aviso de batería baja en cuanto el porcentaje SUBE respecto al de su llegada.
import textos from "../../../../textos/ajustes/notificaciones.json" with { type: "json" }
import { definirCondicion } from "./tipos.ts"

export default definirCondicion({
  id: "battery-resolved",
  etiqueta: textos.editor.condiciones.bateria,
  resumen: textos.resumen.condiciones.bateria,
  vigilar(_notificacion, resolver, servicios) {
    const bateria = servicios.bateria()
    const base = bateria.percentage
    const senal = bateria.connect("notify::percentage", () => {
      if (bateria.percentage > base) resolver()
    })
    return () => bateria.disconnect(senal)
  },
})
