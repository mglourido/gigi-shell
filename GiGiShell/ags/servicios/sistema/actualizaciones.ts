import GLib from "gi://GLib"
import { crearFuenteArchivoJson } from "./fuenteArchivoJson"
import {
  ACTUALIZACIONES_VACIAS,
  interpretarActualizaciones,
} from "./actualizacionesDatos"

export const datosActualizaciones = crearFuenteArchivoJson({
  ruta: `${GLib.get_user_config_dir()}/gigishell/updates.json`,
  vacio: ACTUALIZACIONES_VACIAS,
  interpretar: interpretarActualizaciones,
  etiqueta: "actualizaciones",
})
