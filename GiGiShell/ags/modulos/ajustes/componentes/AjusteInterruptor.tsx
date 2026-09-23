import Interruptor from "../../../componentes/Interruptor"
import FilaAjuste from "./FilaAjuste"

type PropiedadesAjusteInterruptor = {
  titulo: any
  informacion?: any
  activo: any
  alAlternar: () => void
  visible?: any
  sensible?: any
}

/** Fila reutilizable para una preferencia booleana dentro de una tarjeta. */
export default function AjusteInterruptor({
  titulo,
  informacion,
  activo,
  alAlternar,
  visible,
  sensible,
}: PropiedadesAjusteInterruptor) {
  return (
    <FilaAjuste titulo={titulo} informacion={informacion} visible={visible}>
      <Interruptor activo={activo} alAlternar={alAlternar} sensible={sensible ?? true} />
    </FilaAjuste>
  )
}
