// modulos/notificaciones/rules/efectos/index.ts
// El REGISTRO de efectos. El orden de esta lista ES el orden del editor y del resumen.
// Para añadir un efecto: su fichero en esta carpeta + una línea aquí + sus textos. Guía en
// `README.md`; el test `efectos.test.ts` comprueba que esté completo.
import type { ClaveEfecto, DefinicionEfecto } from "./tipos.ts"
import ciclo from "./ciclo.ts"
import limpiarReinicio from "./limpiarReinicio.ts"
import caducidad from "./caducidad.ts"
import duracionPopup from "./duracionPopup.ts"
import descartar from "./descartar.ts"
import sinPopup from "./sinPopup.ts"
import sinAudio from "./sinAudio.ts"
import sinHistorial from "./sinHistorial.ts"
import sonido from "./sonido.ts"
import color from "./color.ts"
import estilo from "./estilo.ts"
import duplicados from "./duplicados.ts"
import reescritura from "./reescritura.ts"
import condiciones from "./condiciones.ts"

export const EFECTOS: DefinicionEfecto[] = [
  ciclo,
  limpiarReinicio,
  caducidad,
  duracionPopup,
  descartar,
  sinPopup,
  sinAudio,
  sinHistorial,
  sonido,
  color,
  estilo,
  duplicados,
  reescritura,
  condiciones,
]

const PORCLAVE = new Map(EFECTOS.map((e) => [e.clave, e]))

export function efecto(clave: string): DefinicionEfecto | undefined {
  return PORCLAVE.get(clave as ClaveEfecto)
}
