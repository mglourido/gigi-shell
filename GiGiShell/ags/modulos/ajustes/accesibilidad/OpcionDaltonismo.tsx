import { AjusteInterruptor } from "../componentes"
import type { ModoDaltonismoActivo } from "./daltonismo"
import { alternarModoDaltonismo } from "./daltonismo"
import { modoDaltonismo, setModoDaltonismo } from "../preferences"

type PropiedadesOpcionDaltonismo = {
  modo: ModoDaltonismoActivo
  titulo: string
  descripcion: string
}

/** Una fila de corrección; el estado compartido garantiza la selección exclusiva. */
export default function OpcionDaltonismo({
  modo,
  titulo,
  descripcion,
}: PropiedadesOpcionDaltonismo) {
  const activo = modoDaltonismo((actual) => actual === modo)

  return (
    <AjusteInterruptor
      titulo={titulo}
      informacion={descripcion}
      activo={activo}
      alAlternar={() => setModoDaltonismo(alternarModoDaltonismo(modoDaltonismo.get(), modo))}
    />
  )
}
