// servicios/fondos/acentoPreferencias.ts
//
// El estado de los ajustes avanzados del acento y su fichero,
// `~/.config/gigishell/acento.json`. Las reglas (qué es válido, valores de fábrica)
// están en `acentoAjustes.ts`; aquí solo se guarda y se avisa.
//
// No vive en `preferences.json` a propósito: son ~15 números que se arrastran con
// un deslizador, y su par "de fábrica" es un JSON del repo con la misma forma
// (`ags/config/acento-parametros.json`). Restablecer es copiar uno sobre el otro.
//
// La ESCRITURA va con retardo (`RETARDO_GUARDADO_MS`): un deslizador emite un valor
// por píxel, y bajar cada uno al disco no aporta nada. El estado en memoria sí se
// actualiza en el acto, que es lo que pinta la UI. El recálculo del acento lleva su
// propio retardo en `acento.ts`, por el mismo motivo pero con otro coste (un
// `python3`).

import GLib from "gi://GLib"
import { createState } from "ags"
import { cargarJsonCrudo, saveJsonAsync } from "../almacenamiento/json"
import {
  ajustesFabrica, leerAjustes, normalizarManuales,
  normalizarParametros, serializarAjustes, type AjustesAcento,
} from "./acentoAjustes"
import { normalizarHexAcento } from "./acentoCss"

const RUTA = `${GLib.get_user_config_dir()}/gigishell/acento.json`
const RETARDO_GUARDADO_MS = 400

function cargar(): AjustesAcento {
  const datos = cargarJsonCrudo(RUTA, "acento")
  return datos === null ? ajustesFabrica() : leerAjustes(datos)
}

const [ajustesAcento, _setAjustesAcento] = createState<AjustesAcento>(cargar())
export { ajustesAcento }

let guardadoPendiente = 0

function guardarConRetardo() {
  if (guardadoPendiente !== 0) GLib.source_remove(guardadoPendiente)
  guardadoPendiente = GLib.timeout_add(GLib.PRIORITY_DEFAULT, RETARDO_GUARDADO_MS, () => {
    guardadoPendiente = 0
    saveJsonAsync(RUTA, serializarAjustes(ajustesAcento.get()), "acento")
    return GLib.SOURCE_REMOVE
  })
}

function fijar(siguiente: AjustesAcento) {
  const actual = ajustesAcento.get()
  if (JSON.stringify(actual) === JSON.stringify(siguiente)) return
  _setAjustesAcento(siguiente)
  guardarConRetardo()
}

export function setParametroAcento(clave: string, valor: number) {
  const actual = ajustesAcento.get()
  fijar({ ...actual, parametros: normalizarParametros({ ...actual.parametros, [clave]: valor }) })
}

/** `hex = null` devuelve ese acento a "el que salga del fondo". */
export function setAcentoManual(indice: number, hex: string | null) {
  const actual = ajustesAcento.get()
  const manuales = [...actual.manuales]
  manuales[indice] = hex === null ? null : normalizarHexAcento(hex)
  fijar({ ...actual, manuales: normalizarManuales(manuales) })
}

/** Copia los valores de fábrica sobre los del usuario (parámetros y colores). */
export function restablecerAjustesAcento() {
  fijar(ajustesFabrica())
}
