// modulos/ajustes/inicio/catalogoApps.ts — el catálogo de apps instaladas que
// alimenta el buscador de «Añadir app» de Ajustes > Apps al inicio.
//
// Se apoya en `modulos/orion/data/appsInfo.ts`, que es la caché compartida de
// `Gio.AppInfo.get_all()` y se invalida sola cuando se instala o desinstala
// algo (ver su cabecera). Volver a escanear los ~161 `.desktop` desde aquí
// habría sido el quinto escaneo independiente del mismo catálogo, que es
// justamente lo que aquel módulo vino a quitar.
//
// El icono se guarda como la cadena de `Gio.Icon.to_string()` y no como un
// nombre de tema: un `.desktop` puede traer tanto un nombre (`spotify-client`)
// como una ruta absoluta a un PNG, y `to_string()`/`new_for_string()` cubren
// los dos casos y hacen ida y vuelta. Quedarse con el nombre de tema dejaría
// sin icono justo a las apps instaladas a mano, que son las que más falta hace
// reconocer en una lista.

import Gio from "gi://Gio"
import { getAppInfos } from "../../orion/data/appsInfo"
import { sanearComando } from "../../../servicios/aplicaciones/appsInicio"
import { esIconoUtilizable } from "../../../servicios/aplicaciones/iconos"

export interface AppInstalada {
  /** Id del `.desktop`; solo se usa como clave del <For> del buscador. */
  id: string
  nombre: string
  comando: string
  icono: string
  /** Nombre + comando en minúsculas, para no rehacerlo en cada pulsación. */
  busqueda: string
}

/**
 * Catálogo ordenado por nombre. Sin apps sin comando utilizable: una entrada
 * que no se puede lanzar no puede añadirse al inicio, y ofrecerla sería una
 * fila que no hace nada al pulsarla.
 */
export function catalogoAppsInstaladas(): AppInstalada[] {
  const lista: AppInstalada[] = []
  for (const app of getAppInfos()) {
    const comando = sanearComando(app.get_commandline() ?? "")
    if (!comando) continue
    const nombre = app.get_name() ?? ""
    if (!nombre) continue
    lista.push({
      id: app.get_id() ?? nombre,
      nombre,
      comando,
      icono: app.get_icon()?.to_string() ?? "",
      busqueda: `${nombre} ${comando}`.toLowerCase(),
    })
  }
  lista.sort((a, b) => a.nombre.localeCompare(b.nombre))
  return lista
}

/**
 * Filtra por todos los términos de la consulta, no por la cadena entera: así
 * "code vis" encuentra "Visual Studio Code" igual que "vis code".
 */
export function filtrarAppsInstaladas(
  catalogo: readonly AppInstalada[],
  consulta: string,
  maximo: number,
): AppInstalada[] {
  const terminos = consulta.toLowerCase().split(/\s+/).filter(Boolean)
  if (terminos.length === 0) return catalogo.slice(0, maximo)
  const encontradas: AppInstalada[] = []
  for (const app of catalogo) {
    if (!terminos.every((termino) => app.busqueda.includes(termino))) continue
    encontradas.push(app)
    if (encontradas.length >= maximo) break
  }
  return encontradas
}

/**
 * `Gio.Icon` a partir de lo guardado, o `null` si la cadena ya no resuelve.
 *
 * El `esIconoUtilizable` no sobra: `Gio.Icon.new_for_string()` acepta felizmente una ruta
 * absoluta a un fichero que no existe, y de ahí sale un hueco vacío en la lista **más un
 * aviso de GTK por cada vez que se pinta** («Failed to load icon …: No existe el fichero»).
 * No es hipotético: `hp-uiscan.desktop` (HPLIP) trae `Icon=/usr/share/icons/Humanity/devices/
 * 48/printer.svg`, una ruta del tema de iconos de Ubuntu que en Arch no está instalado.
 * Devolviendo `null` el llamante pinta su glifo genérico y GTK no llega a abrir nada.
 */
export function iconoDesdeCadena(cadena: string): Gio.Icon | null {
  if (!cadena) return null
  try {
    const icono = Gio.Icon.new_for_string(cadena)
    return esIconoUtilizable(icono) ? icono : null
  } catch (_) {
    return null
  }
}
