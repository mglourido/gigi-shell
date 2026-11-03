// Silenciar. Gana a un sonido propio en la misma regla (ver `sonido/decision.ts`).
import textos from "../../../../textos/ajustes/notificaciones.json" with { type: "json" }
import { definirEfecto } from "./tipos.ts"

export default definirEfecto({
  clave: "muteAudio",
  valor: "booleano",
  destino: "meta",
  porDefecto: false,
  resumen: (valor) => (valor ? textos.resumen.efectos.sinAudio : null),
  editor: { tipo: "interruptor", fila: "acciones", etiqueta: textos.editor.acciones.sinAudio },
})
