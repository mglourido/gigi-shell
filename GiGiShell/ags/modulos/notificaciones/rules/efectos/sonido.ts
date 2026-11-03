// Sonido propio: hace sonar la notificación aunque el emisor no pida sonido. Lo consume la
// ingesta una vez (`EvalResult.soundFile`) y no se guarda con la notificación.
import textos from "../../../../textos/ajustes/notificaciones.json" with { type: "json" }
import { formatearTexto } from "../../../../textos/formatear.ts"
import { esRuta } from "../../sonido/decision.ts"
import { definirEfecto } from "./tipos.ts"

export default definirEfecto({
  clave: "soundFile",
  valor: "texto",
  destino: "resultado",
  sanear: (v) => ((v as string).trim() ? v : undefined),
  // Se comprueba la FORMA, no que exista: un audio en un disco desmontado sigue siendo válido.
  validar: (valor) =>
    typeof valor === "string" && !esRuta(valor.trim())
      ? [formatearTexto(textos.validacion.sonido, { valor })]
      : [],
  // Solo el nombre del fichero: la ruta completa desbordaría la fila.
  resumen: (valor) => typeof valor === "string" && valor
    ? formatearTexto(textos.resumen.efectos.sonido, { archivo: valor.split("/").filter(Boolean).pop() ?? valor })
    : null,
  editor: {
    tipo: "ruta-audio",
    titulo: textos.editor.titulos.sonido,
    ayuda: textos.editor.ayudas.sonido,
    marcador: textos.editor.ayudas.sonidoEjemplo,
    etiquetaProbar: textos.editor.acciones.probarSonido,
    ayudaProbar: textos.editor.acciones.probarSonidoAyuda,
    avisoNoExiste: textos.editor.ayudas.sonidoNoExiste,
  },
})
