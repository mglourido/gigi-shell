// modulos/orion/data/wallpaperConfig.ts
//
// Estado y acciones de la sección "Temas" (RiceSection) de Orion: lista de
// fondos, grupos, franjas horarias, fondo actual y "aleatorio al iniciar".
//
// DOS FICHEROS, DOS DUEÑOS — y la separación no es histórica, es funcional:
//
//   ~/.config/gigios/wallpaper.json   { randomOnStart, current, currentGroup }
//     ESTADO de lo que hay puesto. `current`/`currentGroup` los escribe
//     `hypr/scripts/wallpaper.sh` cada vez que aplica; AGS solo escribe
//     `randomOnStart` (su toggle). Ambos hacen read-modify-write preservando lo
//     ajeno. Aquí se OBSERVA con un FileMonitor: el planificador puede cambiar el
//     fondo por su cuenta al cruzar una franja, y sin eso la rejilla seguiría
//     resaltando el anterior.
//
//   ~/.config/gigios/wallpapers.json  { version, franjas, grupos, fondos }
//     CONFIGURACIÓN de franjas y grupos. La escribe solo Orion, y la lee
//     `hypr/scripts/lib/seleccion_fondos.py`, que es quien decide qué fondo
//     toca. Ver `wallpaperSchedule.ts` para el modelo.
//
// ⚠️ LA CONFIG SE ESCRIBE SÍNCRONA, no con el guardado diferido que usa el resto
// del shell. El fichero dejó de ser solo nuestro: en cuanto se edita, la UI
// dispara `wallpaper.sh` para enseñar el resultado, y ese script relee el JSON
// desde otro proceso — con una escritura en vuelo leería la versión anterior y
// el cambio parecería no haber surtido efecto. Es exactamente la razón por la
// que `saveMonitorPref` llama a `saveDisplayConfigNow()` (ver
// `servicios/pantalla/`).

import GLib from "gi://GLib"
import Gio from "gi://Gio"
import { createState } from "ags"
import { execAsync } from "ags/process"
import {
  normalizar, entidades, sinRuta, nuevoId, aMinutos, minutosDe,
  CONFIG_VACIA, FRANJAS_POR_DEFECTO,
  type WallpapersConfig, type Grupo, type Entidad, type Franja,
} from "./wallpaperSchedule"

const HOME = GLib.get_home_dir()
export const WALLPAPER_DIR = `${HOME}/GiGiOS/Wallpapers`
const ESTADO_PATH  = `${GLib.get_user_config_dir()}/gigios/wallpaper.json`
const CONFIG_PATH  = `${GLib.get_user_config_dir()}/gigios/wallpapers.json`
const WALLPAPER_SH = `${GLib.get_user_config_dir()}/hypr/scripts/wallpaper.sh`

const EXTS = [".jpg", ".jpeg", ".png", ".webp"]

// ── Estado reactivo ───────────────────────────────────────────────────────────
const [randomOnStart,    _setRandomOnStart]    = createState(true)
const [currentWallpaper, _setCurrentWallpaper] = createState("")
const [currentGroup,     _setCurrentGroup]     = createState("")
const [wallpapersConfig, _setWallpapersConfig] = createState<WallpapersConfig>(CONFIG_VACIA)
export { randomOnStart, currentWallpaper, currentGroup, wallpapersConfig }

// ── Listado de wallpapers ─────────────────────────────────────────────────────
export function listWallpapers(): string[] {
  const out: string[] = []
  try {
    const dir  = Gio.File.new_for_path(WALLPAPER_DIR)
    const enumr = dir.enumerate_children("standard::name", Gio.FileQueryInfoFlags.NONE, null)
    let info: Gio.FileInfo | null
    while ((info = enumr.next_file(null)) !== null) {
      const name  = info.get_name()
      const lower = name.toLowerCase()
      if (EXTS.some(e => lower.endsWith(e))) out.push(`${WALLPAPER_DIR}/${name}`)
    }
  } catch (_) { /* carpeta ausente => lista vacía */ }
  out.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
  return out
}

// ── E/S ───────────────────────────────────────────────────────────────────────
function leerJson(path: string): any {
  try {
    const [ok, content] = GLib.file_get_contents(path)
    if (!ok) return {}
    return JSON.parse(new TextDecoder().decode(content))
  } catch (_) { return {} }
}

function escribirSincrono(path: string, datos: unknown) {
  try {
    const dir = GLib.path_get_dirname(path)
    if (!GLib.file_test(dir, GLib.FileTest.EXISTS)) GLib.mkdir_with_parents(dir, 0o755)
    GLib.file_set_contents(path, JSON.stringify(datos, null, 2))
  } catch (_) { /* un fallo de escritura no debe romper la UI */ }
}

function cargarEstado() {
  const cfg = leerJson(ESTADO_PATH)
  if (typeof cfg.randomOnStart === "boolean") _setRandomOnStart(cfg.randomOnStart)
  _setCurrentWallpaper(typeof cfg.current === "string" ? cfg.current : "")
  _setCurrentGroup(typeof cfg.currentGroup === "string" ? cfg.currentGroup : "")
}

function cargarConfig() {
  _setWallpapersConfig(normalizar(leerJson(CONFIG_PATH)))
}

// Escribe `randomOnStart` preservando lo que es de bash (`current`,
// `currentGroup`): el reparto de escritura es lo que evita que uno pise al otro.
function guardarRandomOnStart(on: boolean) {
  const cfg = leerJson(ESTADO_PATH)
  escribirSincrono(ESTADO_PATH, {
    ...cfg,
    randomOnStart: on,
    current:      typeof cfg.current === "string" ? cfg.current : "",
    currentGroup: typeof cfg.currentGroup === "string" ? cfg.currentGroup : "",
  })
}

/** Punto único de guardado de la config: normaliza, publica y escribe ya. */
export function guardarConfig(next: WallpapersConfig) {
  const limpia = normalizar(next)
  _setWallpapersConfig(limpia)
  escribirSincrono(CONFIG_PATH, limpia)
}

function editar(fn: (cfg: WallpapersConfig) => WallpapersConfig) {
  guardarConfig(fn(wallpapersConfig.get()))
}

// ── Reloj de las franjas (solo para PINTAR) ───────────────────────────────────
// Ref-contado y vivo solo mientras alguna vista lo pida: la sección "Temas" está
// cerrada casi todo el tiempo, y un tick perpetuo para refrescar una etiqueta que
// nadie mira es justo lo que se corrigió en Ajustes > Pantalla. Quien aplica los
// cambios de franja es el planificador (`servicios/fondos/planificador.ts`), no
// esto: aquí solo se refrescan chips y atenuados.
const [ahoraFranjas, _setAhoraFranjas] = createState(minutosDe(new Date()))
export { ahoraFranjas }

let relojUsuarios = 0
let relojId = 0

export function adquirirRelojFranjas(): () => void {
  relojUsuarios++
  if (relojId === 0) {
    _setAhoraFranjas(minutosDe(new Date()))
    relojId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT_IDLE, 30, () => {
      _setAhoraFranjas(minutosDe(new Date()))
      return GLib.SOURCE_CONTINUE
    })
  }
  let liberado = false
  return () => {
    if (liberado) return
    liberado = true
    relojUsuarios--
    if (relojUsuarios <= 0 && relojId !== 0) {
      GLib.source_remove(relojId)
      relojId = 0
      relojUsuarios = 0
    }
  }
}

/** Lo que se pinta en la rejilla ahora mismo: grupos + fondos sueltos. */
export function entidadesAhora(): Entidad[] {
  return entidades(wallpapersConfig.get(), listWallpapers(), ahoraFranjas.get())
}

// ── Acciones sobre el fondo ───────────────────────────────────────────────────

/**
 * Ejecuta `wallpaper.sh` y, AL TERMINAR, relee el estado.
 *
 * Es una guarda, no el camino normal: lo normal es que el FileMonitor de
 * `wallpaper.json` avise. Pero de ese aviso cuelgan el resaltado de la rejilla y
 * el acento adaptativo (`servicios/fondos/acento.ts`), y un evento perdido deja
 * el shell con los colores del fondo anterior sin ningún error. Releer aquí no
 * cuesta nada: si el monitor ya lo trajo, `createState` no notifica un valor
 * igual y el acento no vuelve a calcular.
 */
function ejecutarWallpaper(args: string[]) {
  execAsync([WALLPAPER_SH, ...args]).catch(() => {}).finally(cargarEstado)
}

export function setRandomOnStart(on: boolean) {
  _setRandomOnStart(on)
  guardarRandomOnStart(on)
}

/** Aplica un fondo suelto. Deja de haber grupo vigente (lo limpia el script). */
export function applyWallpaper(path: string) {
  _setCurrentWallpaper(path)          // resaltado inmediato
  _setCurrentGroup("")
  ejecutarWallpaper([path])
}

/**
 * Aplica el grupo: la variante la elige el script según la hora, así que aquí no
 * se adelanta ningún resaltado — el FileMonitor de `wallpaper.json` lo trae
 * cuando el fondo ya está puesto de verdad.
 */
export function applyGrupo(gid: string) {
  ejecutarWallpaper(["--grupo", gid])
}

export function applyEntidad(e: Entidad) {
  if (e.tipo === "grupo") applyGrupo(e.grupo.id)
  else applyWallpaper(e.path)
}

export function applyRandom() {
  ejecutarWallpaper(["--random"])
}

/**
 * Relee la franja actual y aplica lo que toque. Se llama tras editar franjas o
 * grupos, para que el efecto de lo que acabas de tocar se vea en el acto en vez
 * de en el próximo límite horario.
 */
export function reevaluar() {
  ejecutarWallpaper(["--auto"])
}

// ── Acciones sobre las franjas globales ───────────────────────────────────────
export function crearFranjasPorDefecto() {
  editar(cfg => ({ ...cfg, franjas: [...FRANJAS_POR_DEFECTO] }))
}

export function anadirFranja() {
  editar(cfg => {
    const id = nuevoId("f", cfg.franjas.map(f => f.id))
    return { ...cfg, franjas: [...cfg.franjas, { id, nombre: "Nueva franja", start: "12:00" }] }
  })
}

export function editarFranja(id: string, patch: Partial<Franja>) {
  editar(cfg => ({
    ...cfg,
    franjas: cfg.franjas.map(f => f.id === id ? { ...f, ...patch } : f),
  }))
}

/**
 * Borrar una franja arrastra las referencias que los fondos le hacían — lo hace
 * `normalizar()` al guardar. Sin esa limpieza un fondo quedaría apto solo "para
 * una franja que ya no existe", o sea fuera de la selección para siempre y sin
 * nada visible que lo explicara.
 */
export function borrarFranja(id: string) {
  editar(cfg => ({ ...cfg, franjas: cfg.franjas.filter(f => f.id !== id) }))
}

export function setFranjasDeFondo(path: string, ids: string[]) {
  editar(cfg => {
    const fondos = { ...cfg.fondos }
    // Marcar TODAS las franjas es lo mismo que no marcar ninguna (apto siempre),
    // y guardarlo como lista completa dejaría el fondo atado a los ids de hoy: al
    // añadir una franja nueva dejaría de ser apto en ella sin que nadie lo pida.
    if (ids.length === 0 || ids.length === cfg.franjas.length) delete fondos[path]
    else fondos[path] = { franjas: ids }
    return { ...cfg, fondos }
  })
}

// ── Acciones sobre los grupos ─────────────────────────────────────────────────

/**
 * Crea un grupo con un fondo dentro, en un único tramo que cubre las 24 h.
 *
 * Ese tramo inicial es lo que hace que un grupo recién creado se comporte
 * exactamente como el fondo suelto que era: sale a todas horas. Repartirlo en
 * tramos es el paso siguiente, y es del usuario.
 */
export function crearGrupo(path: string, nombre?: string): string {
  const cfg = wallpapersConfig.get()
  const id = nuevoId("g", cfg.grupos.map(g => g.id))
  const base = sinRuta(cfg, path)
  guardarConfig({
    ...base,
    grupos: [...base.grupos, {
      id,
      nombre: nombre || GLib.path_get_basename(path).replace(/\.[^.]+$/, ""),
      tramos: [{ start: "00:00", paths: [path] }],
    }],
  })
  return id
}

export function borrarGrupo(gid: string) {
  editar(cfg => ({ ...cfg, grupos: cfg.grupos.filter(g => g.id !== gid) }))
}

export function renombrarGrupo(gid: string, nombre: string) {
  editar(cfg => ({
    ...cfg,
    grupos: cfg.grupos.map(g => g.id === gid ? { ...g, nombre } : g),
  }))
}

function conGrupo(gid: string, fn: (g: Grupo) => Grupo) {
  editar(cfg => ({ ...cfg, grupos: cfg.grupos.map(g => g.id === gid ? fn(g) : g) }))
}

export function anadirTramo(gid: string, start: string) {
  conGrupo(gid, g => g.tramos.some(t => t.start === start)
    ? g
    : { ...g, tramos: [...g.tramos, { start, paths: [] }] })
}

export function borrarTramo(gid: string, start: string) {
  conGrupo(gid, g => ({ ...g, tramos: g.tramos.filter(t => t.start !== start) }))
}

export function moverTramo(gid: string, start: string, nuevoStart: string) {
  if (aMinutos(nuevoStart) === null) return
  conGrupo(gid, g => ({
    ...g,
    tramos: g.tramos.map(t => t.start === start ? { ...t, start: nuevoStart } : t),
  }))
}

/**
 * Pone (o quita) una imagen en un tramo del grupo.
 *
 * Una misma imagen puede estar en varios tramos —es válido y a veces es lo que
 * se quiere—, pero dentro de un tramo no se repite. Añadirla al grupo la saca
 * automáticamente de la lista de fondos sueltos: un grupo es UNA entidad, y sus
 * imágenes no pueden competir además por su cuenta.
 */
export function alternarEnTramo(gid: string, start: string, path: string) {
  editar(cfg => {
    const base = { ...cfg, grupos: cfg.grupos.map(g => g.id !== gid ? g : {
      ...g,
      tramos: g.tramos.map(t => t.start !== start ? t : {
        ...t,
        paths: t.paths.includes(path)
          ? t.paths.filter(p => p !== path)
          : [...t.paths, path],
      }),
    }) }
    // La aptitud por franjas globales es de los fondos SUELTOS; dentro de un
    // grupo manda la línea de tiempo del grupo, así que se descarta para no
    // dejar dos reglas contradictorias sobre la misma imagen.
    const fondos = { ...base.fondos }
    delete fondos[path]
    return { ...base, fondos }
  })
}

/** Saca una imagen del grupo: vuelve a ser un fondo suelto. */
export function sacarDeGrupo(path: string) {
  editar(cfg => sinRuta(cfg, path))
}

// ── Vigilancia de los ficheros ────────────────────────────────────────────────
// El estado lo escribe bash (al arrancar, al pulsar aleatorio, y sobre todo al
// cruzar una franja por su cuenta), así que la rejilla tiene que enterarse sin
// que nadie la toque. La config solo la escribimos aquí, pero se vigila igual por
// si se edita a mano.
function vigilar(path: string, alCambiar: () => void) {
  try {
    const monitor = Gio.File.new_for_path(path).monitor_file(Gio.FileMonitorFlags.NONE, null)
    let rebote = 0
    monitor.connect("changed", () => {
      if (rebote) GLib.source_remove(rebote)
      rebote = GLib.timeout_add(GLib.PRIORITY_DEFAULT_IDLE, 200, () => {
        rebote = 0
        alCambiar()
        return GLib.SOURCE_REMOVE
      })
    })
    // Sin retener la referencia, el GC se lleva el monitor y deja de avisar.
    monitores.push(monitor)
  } catch (_) { /* fichero aún inexistente: se leerá al crearse */ }
}
const monitores: Gio.FileMonitor[] = []

cargarEstado()
cargarConfig()
vigilar(ESTADO_PATH, cargarEstado)
vigilar(CONFIG_PATH, cargarConfig)
