// Cuánto se ve EL POPUP (no lo que vive en el panel, que es `ttlMs`). Lo lee `popup/logica.ts`
// desde `meta.popupMs`: va horneado para que la pila no tenga que volver a evaluar reglas.
import textos from "../../../../textos/ajustes/notificaciones.json" with { type: "json" }
import { formatearTexto } from "../../../../textos/formatear.ts"
import { formatDuration } from "../duration.ts"
import { definirEfecto } from "./tipos.ts"

export default definirEfecto({
  clave: "popupMs",
  valor: "numero",
  destino: "meta",
  sanear: (v) => ((v as number) > 0 ? v : undefined),
  // El editor deja `undefined` si no entiende lo tecleado: un valor presente y no válido solo
  // puede venir del JSON editado a mano.
  validar: (valor) =>
    valor !== undefined && !(typeof valor === "number" && valor > 0)
      ? [textos.validacion.duracionPopup]
      : [],
  resumen: (valor) => typeof valor === "number" && valor
    ? formatearTexto(textos.resumen.efectos.popup, { duracion: formatDuration(valor) })
    : null,
  editor: {
    tipo: "duracion",
    titulo: textos.editor.titulos.duracionPopup,
    marcador: textos.editor.ayudas.duracionPopupEjemplo,
    ayuda: textos.editor.ayudas.duracionPopup,
  },
})
