import GLib from "gi://GLib"
import { execAsync } from "ags/process"
import { BotonAjustes, FilaAjuste } from "../componentes"
import textos from "../../../textos/ajustes/personalizacion.json" with { type: "json" }

const RUTA_LIMPIEZA = `${GLib.get_user_config_dir()}/hypr/scripts/limpiar-portapapeles.sh`

/** Acción manual que comparte el mismo script que la limpieza al iniciar. */
export default function LimpiezaPortapapeles() {
  const limpiar = () => {
    execAsync([RUTA_LIMPIEZA, "limpiar"])
      .catch((error) => console.error("[portapapeles] No se pudo limpiar:", error))
  }

  return (
    <FilaAjuste
      titulo={textos.portapapeles.limpiezaManual.titulo}
      informacion={textos.portapapeles.limpiezaManual.descripcion}
    >
      <BotonAjustes
        label={textos.portapapeles.limpiezaManual.boton}
        onClicked={limpiar}
      />
    </FilaAjuste>
  )
}
