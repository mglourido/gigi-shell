import GLib from "gi://GLib"
import { crearFuenteArchivoJson } from "../sistema/fuenteArchivoJson"
import { CAPTURA_VACIA, interpretarCaptura } from "./capturaDatos"

export const datosCapturaPantalla = crearFuenteArchivoJson({
  ruta: `${GLib.get_user_config_dir()}/gigios/screencast.json`,
  vacio: CAPTURA_VACIA,
  interpretar: interpretarCaptura,
  etiqueta: "captura-pantalla",
})
