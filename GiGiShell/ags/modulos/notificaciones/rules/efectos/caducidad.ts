// Duración del ciclo «temporal». Su frase va dentro de la del ciclo, así que no tiene resumen.
import textos from "../../../../textos/ajustes/notificaciones.json" with { type: "json" }
import { definirEfecto } from "./tipos.ts"

export default definirEfecto({
  clave: "ttlMs",
  valor: "numero",
  destino: "motor",
  sanear: (v) => ((v as number) > 0 ? v : undefined),
  editor: {
    tipo: "duracion",
    titulo: textos.editor.titulos.expira,
    marcador: textos.editor.ayudas.duracion,
    visibleSi: (efectos) => efectos.lifetime === "timed",
  },
})
