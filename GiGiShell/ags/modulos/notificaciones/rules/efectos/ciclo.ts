// Ciclo de vida en el PANEL: hasta que se cumpla una condición, temporal o hasta 7 días.
// Lo usa el propio motor (`expiresAt`, `clearOnBoot`), por eso su destino es `motor`.
import textos from "../../../../textos/ajustes/notificaciones.json" with { type: "json" }
import { formatearTexto } from "../../../../textos/formatear.ts"
import { formatDuration } from "../duration.ts"
import { definirEfecto } from "./tipos.ts"

const RESUMEN: Record<string, string> = {
  flash: textos.resumen.ciclos.hastaCondicion,
  persistent: textos.resumen.ciclos.hastaSieteDias,
  "clear-on-boot": textos.resumen.ciclos.limpiarReinicio,
}

export default definirEfecto({
  clave: "lifetime",
  valor: "texto",
  destino: "motor",
  sanear: (v) => (["flash", "timed", "persistent", "clear-on-boot"].includes(v as string) ? v : undefined),
  // Una regla temporal sin duración no caducaría nunca: es un error, no un default.
  validar: (valor, efectos) =>
    valor === "timed" && !(typeof efectos.ttlMs === "number" && efectos.ttlMs > 0)
      ? [textos.validacion.duracion]
      : [],
  resumen: (valor, efectos) => {
    if (valor === "timed") {
      return efectos.ttlMs
        ? formatearTexto(textos.resumen.efectos.expira, { duracion: formatDuration(efectos.ttlMs) })
        : textos.resumen.efectos.expiraSinDuracion
    }
    return typeof valor === "string" ? (RESUMEN[valor] ?? valor) : null
  },
  editor: {
    tipo: "opciones",
    seccion: textos.editor.titulos.acciones,
    titulo: textos.editor.titulos.ciclo,
    ayuda: textos.editor.ayudas.ciclo,
    opciones: [
      { valor: undefined, etiqueta: textos.editor.ciclos.ninguno },
      { valor: "flash", etiqueta: textos.editor.ciclos.hastaCondicion },
      { valor: "timed", etiqueta: textos.editor.ciclos.temporal },
      { valor: "persistent", etiqueta: textos.editor.ciclos.hastaSieteDias },
    ],
  },
})
