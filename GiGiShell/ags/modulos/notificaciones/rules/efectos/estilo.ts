// Aspecto del popup. «—» (sin valor) NO es «GiGiShell»: lo primero deja opinar a otras reglas,
// lo segundo saca del skin dunst incluso a un aviso del sistema.
import textos from "../../../../textos/ajustes/notificaciones.json" with { type: "json" }
import { formatearTexto } from "../../../../textos/formatear.ts"
import { POPUP_STYLES, type PopupStyle } from "../types.ts"
import { definirEfecto } from "./tipos.ts"

export default definirEfecto({
  clave: "style",
  valor: "texto",
  destino: "meta",
  sanear: (v) => (POPUP_STYLES.includes(v as PopupStyle) ? v : undefined),
  validar: (valor) =>
    valor !== undefined && !POPUP_STYLES.includes(valor as PopupStyle)
      ? [formatearTexto(textos.validacion.estilo, {
          valor,
          opciones: POPUP_STYLES.join(textos.validacion.separadorOpciones),
        })]
      : [],
  resumen: (valor) =>
    valor === "dunst" ? textos.resumen.efectos.dunst
      : valor === "default" ? textos.resumen.efectos.gigishell
        : null,
  editor: {
    tipo: "opciones",
    titulo: textos.editor.titulos.estilo,
    ayuda: textos.editor.ayudas.estilo,
    opciones: [
      { valor: undefined, etiqueta: textos.editor.estilos.ninguno },
      { valor: "default", etiqueta: textos.editor.estilos.gigishell },
      { valor: "dunst", etiqueta: textos.editor.estilos.dunst },
    ],
  },
})
