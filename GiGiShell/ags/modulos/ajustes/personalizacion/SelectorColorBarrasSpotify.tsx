import { FilaAjuste } from "../componentes"
import Segmentado from "../energia/Segmentado"
import { colorBarrasSpotify, setColorBarrasSpotify } from "../estado/preferencias"
import textos from "../../../textos/ajustes/personalizacion.json" with { type: "json" }

const OPCIONES = [
  { value: "rgb", label: textos.apariencia.barrasSpotify.opciones.rgb },
  { value: "blanco", label: textos.apariencia.barrasSpotify.opciones.blanco },
]

export default function SelectorColorBarrasSpotify() {
  return (
    <FilaAjuste
      titulo={textos.apariencia.barrasSpotify.titulo}
      informacion={textos.apariencia.barrasSpotify.descripcion}
    >
      <Segmentado
        options={OPCIONES}
        current={colorBarrasSpotify}
        onSelect={(color) => {
          if (color === "rgb" || color === "blanco") setColorBarrasSpotify(color)
        }}
      />
    </FilaAjuste>
  )
}
