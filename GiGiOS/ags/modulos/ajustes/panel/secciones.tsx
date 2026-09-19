import { createComputed, type Accessor } from "ags"
import SettingsTabs from "../../notificaciones/settings/SettingsTabs"
import SeccionAtajos from "../atajos/SeccionAtajos"
import SeccionCamara from "../camara/SeccionCamara"
import SeccionCuenta from "../cuenta/SeccionCuenta"
import SeccionAlmacenamiento from "../disco/SeccionAlmacenamiento"
import SeccionAppsInicio from "../inicio/SeccionAppsInicio"
import SeccionDispositivos from "../dispositivos/SeccionDispositivos"
import SeccionEnergia from "../energia/SeccionEnergia"
import SeccionFechaIdioma from "../fecha-idioma/SeccionFechaIdioma"
import SeccionJuegos from "../juegos/SeccionJuegos"
import SeccionPantalla from "../pantalla/SeccionPantalla"
import SeccionComportamiento from "../personalizacion/SeccionComportamiento"
import SeccionDiseno from "../personalizacion/SeccionDiseno"
import SeccionFuncionesShell from "../personalizacion/SeccionFuncionesShell"
import SeccionSeguridad from "../seguridad/SeccionSeguridad"
import SeccionSistema from "../sistema/SeccionSistema"
import { camaras } from "../../../servicios/camara/dispositivos"
import { estadoCamara } from "../../../servicios/camara/persistencia"
import { haySeccionCamara } from "../camara/camaraDatos"
import textos from "../../../textos/ajustes/general.json" with { type: "json" }
// El rótulo de Cámara vive con el resto de sus textos y no en `general.json`:
// es una sección nueva y así todo su idioma cae en un solo fichero.
import textosCamara from "../../../textos/ajustes/camara.json" with { type: "json" }

export type IdSeccion =
  | "account" | "language" | "datetime" | "location"
  | "display" | "diseno" | "comportamiento"
  | "mouse" | "touchpad" | "keyboard" | "printers" | "camera"
  | "energy" | "games" | "orion" | "clipboard"
  | "startup"
  | "storage" | "cleanup"
  | "notifications" | "monitoring" | "scans" | "supervision" | "system"
  | "shortcuts"

export type IdGrupo =
  | "general" | "controles" | "dispositivos"
  | "almacenamiento" | "seguridad" | "sistema"

export interface SeccionNavegacion {
  id: IdSeccion
  label: string
  icon: string
  /** Destinos que solo existen en algunas máquinas. Ausente = siempre visible.
   *  Es un accessor y no un booleano porque el hardware entra y sale en
   *  caliente: enchufar una webcam con Ajustes abierto tiene que hacer aparecer
   *  su destino sin reabrir la ventana. */
  visible?: Accessor<boolean>
}

/** Cabecera de acordeón: agrupa hojas de `IdSeccion` ya existentes. No tiene
 *  contenido propio — `crearContenidoSeccion` nunca recibe un `IdGrupo`. */
export interface GrupoNavegacion {
  id: IdGrupo
  label: string
  icon: string
  hijos: IdSeccion[]
}

export type ItemNavegacion = SeccionNavegacion | GrupoNavegacion

export function esGrupo(item: ItemNavegacion): item is GrupoNavegacion {
  return "hijos" in item
}

/** Hay cámara enchufada, o ajustes guardados de alguna que lo estuvo.
 *
 *  Lo segundo importa: una webcam USB desenchufada cuyos controles siguen en
 *  `camara.json` tiene que poder OLVIDARSE desde la sección, y si el destino
 *  desapareciera con ella esos ajustes quedarían huérfanos —y se volverían a
 *  imponer al reenchufarla— sin ninguna forma de borrarlos que no fuera editar
 *  el JSON a mano. En un equipo que nunca ha visto una cámara (este sobremesa)
 *  no se cumple ninguna de las dos y el destino no se pinta. */
const hayCamaraConocida = createComputed([camaras, estadoCamara], haySeccionCamara)

/** Metadato de cada hoja, declarado una sola vez y reutilizado tanto suelta
 *  (planas, en `ITEMS_NAVEGACION`) como colgando de un `GrupoNavegacion`
 *  (`NavegacionAjustes` la busca aquí por id para pintar los hijos). */
export const SECCIONES_POR_ID: Record<IdSeccion, SeccionNavegacion> = {
  account: { id: "account", label: textos.secciones.cuenta, icon: "󰀄" },
  language: { id: "language", label: textos.secciones.idiomaRegion, icon: "󰗊" },
  datetime: { id: "datetime", label: textos.secciones.fechaHora, icon: "󰃭" },
  location: { id: "location", label: textos.secciones.ubicacion, icon: "󰍎" },
  display: { id: "display", label: textos.secciones.pantalla, icon: "󰍹" },
  diseno: { id: "diseno", label: textos.secciones.diseno, icon: "󰏘" },
  comportamiento: { id: "comportamiento", label: textos.secciones.comportamiento, icon: "󰍜" },
  mouse: { id: "mouse", label: textos.secciones.ratonPuntero, icon: "󰍽" },
  touchpad: { id: "touchpad", label: textos.secciones.touchpad, icon: "󰟸" },
  keyboard: { id: "keyboard", label: textos.secciones.teclado, icon: "󰌌" },
  printers: { id: "printers", label: textos.secciones.impresoras, icon: "󰐪" },
  camera: { id: "camera", label: textosCamara.seccion.titulo, icon: "󰄀", visible: hayCamaraConocida },
  energy: { id: "energy", label: textos.secciones.energia, icon: "󰁹" },
  games: { id: "games", label: textos.secciones.juegos, icon: "󰊴" },
  orion: { id: "orion", label: textos.secciones.orion, icon: "󰆍" },
  clipboard: { id: "clipboard", label: textos.secciones.portapapeles, icon: "󰅇" },
  startup: { id: "startup", label: textos.secciones.appsInicio, icon: "󰐊" },
  storage: { id: "storage", label: textos.secciones.almacenamiento, icon: "󰋊" },
  cleanup: { id: "cleanup", label: textos.secciones.liberarEspacio, icon: "󰃢" },
  notifications: { id: "notifications", label: textos.secciones.notificaciones, icon: "󰂚" },
  monitoring: { id: "monitoring", label: textos.secciones.vigilancia, icon: "󰒃" },
  scans: { id: "scans", label: textos.secciones.escaneos, icon: "󰇚" },
  supervision: { id: "supervision", label: textos.secciones.supervision, icon: "󰓅" },
  system: { id: "system", label: textos.secciones.sistema, icon: "󰌢" },
  shortcuts: { id: "shortcuts", label: textos.secciones.atajos, icon: "󰘳" },
}

export const ITEMS_NAVEGACION: ItemNavegacion[] = [
  SECCIONES_POR_ID.account,
  { id: "general", label: textos.grupos.general, icon: "󰗊", hijos: ["language", "datetime", "location"] },
  { id: "controles", label: textos.grupos.controles, icon: "󰍽", hijos: ["mouse", "keyboard", "touchpad"] },
  SECCIONES_POR_ID.diseno,
  SECCIONES_POR_ID.comportamiento,
  { id: "dispositivos", label: textos.grupos.dispositivos, icon: "󰍹", hijos: ["display", "printers", "camera"] },
  SECCIONES_POR_ID.energy,
  SECCIONES_POR_ID.games,
  SECCIONES_POR_ID.orion,
  SECCIONES_POR_ID.clipboard,
  SECCIONES_POR_ID.startup,
  { id: "almacenamiento", label: textos.grupos.almacenamiento, icon: "󰋊", hijos: ["storage", "cleanup"] },
  SECCIONES_POR_ID.notifications,
  { id: "seguridad", label: textos.grupos.seguridad, icon: "󰒃", hijos: ["monitoring", "scans"] },
  { id: "sistema", label: textos.grupos.sistema, icon: "󰌢", hijos: ["system", "supervision", "shortcuts"] },
]

const FABRICAS_SECCION: Record<IdSeccion, () => unknown> = {
  account: () => <SeccionCuenta />,
  language: () => <SeccionFechaIdioma vista="idioma" />,
  datetime: () => <SeccionFechaIdioma vista="fecha" />,
  location: () => <SeccionFechaIdioma vista="ubicacion" />,
  display: () => <SeccionPantalla />,
  diseno: () => <SeccionDiseno />,
  comportamiento: () => <SeccionComportamiento />,
  mouse: () => <SeccionDispositivos vista="raton" />,
  touchpad: () => <SeccionDispositivos vista="touchpad" />,
  keyboard: () => <SeccionDispositivos vista="teclado" />,
  printers: () => <SeccionDispositivos vista="impresoras" />,
  camera: () => <SeccionCamara />,
  energy: () => <SeccionEnergia />,
  games: () => <SeccionJuegos />,
  orion: () => <SeccionFuncionesShell vista="orion" />,
  clipboard: () => <SeccionFuncionesShell vista="portapapeles" />,
  startup: () => <SeccionAppsInicio />,
  storage: () => <SeccionAlmacenamiento vista="uso" />,
  cleanup: () => <SeccionAlmacenamiento vista="limpieza" />,
  notifications: () => <SettingsTabs />,
  monitoring: () => <SeccionSeguridad vista="vigilancia" />,
  scans: () => <SeccionSeguridad vista="escaneos" />,
  supervision: () => <SeccionSistema vista="supervision" />,
  system: () => <SeccionSistema vista="informacion" />,
  shortcuts: () => <SeccionAtajos />,
}

export function crearContenidoSeccion(id: IdSeccion): unknown {
  return FABRICAS_SECCION[id]()
}
