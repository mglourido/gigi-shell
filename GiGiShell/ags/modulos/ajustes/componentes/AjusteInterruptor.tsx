import Interruptor from "../../../componentes/Interruptor"
import FilaAjuste from "./FilaAjuste"

type PropiedadesAjusteInterruptor = {
  titulo: any
  informacion?: any
  activo: any
  alAlternar: () => void
  maxCaracteresInformacion?: number
  expandirInformacion?: boolean
  visible?: any
  sensible?: any
}

/** Fila reutilizable para una preferencia booleana dentro de una tarjeta. */
export default function AjusteInterruptor({
  titulo,
  informacion,
  activo,
  alAlternar,
  maxCaracteresInformacion,
  expandirInformacion,
  visible,
  sensible,
}: PropiedadesAjusteInterruptor) {
  return (
    <FilaAjuste titulo={titulo} informacion={informacion} visible={visible}
      maxCaracteresInformacion={maxCaracteresInformacion}
      expandirInformacion={expandirInformacion}>
      <Interruptor activo={activo} alAlternar={alAlternar} sensible={sensible ?? true} />
    </FilaAjuste>
  )
}
