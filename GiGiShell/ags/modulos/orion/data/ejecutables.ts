// E/S de la búsqueda de ficheros de Orion (la lógica pura está en
// `ejecutables.modelo.ts`): el índice de ficheros en disco, y las tres formas de
// abrir algo desde el panel derecho — normal, como root y "mostrar ubicación".
//
// El índice NO se recorre en cada tecla: lo rellena un `find` asíncrono (uno por
// carpeta, en paralelo) cuando la búsqueda pide una extensión y el índice tiene
// más de `VIGENCIA_MS`. Mientras tanto el handler puntúa contra lo que haya; al
// terminar se avisa a los oyentes (`state.ts` repite la consulta en curso), así
// que la primera búsqueda de la sesión enseña las apps y un instante después
// suben los ficheros encima.

import GLib from "gi://GLib"
import { execAsync } from "ags/process"
import { orionRutasEjecutables, orionComandosArchivo } from "../../ajustes/preferences"
import { launchApp } from "./launch"
import { esperarOrionOculto } from "./uninstall"
import {
  comandoEjecutable, comandoComoRoot, citar, expandirCarpeta,
  parsearFind, programaDeExec, limpiarExec, extensionDe, esExtensionEjecutable,
  type FicheroEjecutable,
} from "./ejecutables.modelo"

const CASA = GLib.get_home_dir()

/**
 * Carpetas fijas: `~` solo en su primer nivel (recorrerla entera sería escanear
 * el disco) y las de documentos y descargas, en los dos idiomas porque XDG las
 * crea en el de la instalación y hay equipos con las dos.
 */
const CARPETAS_FIJAS: { ruta: string; profundidad: number }[] = [
  { ruta: "~", profundidad: 1 },
  { ruta: "~/Documents", profundidad: 4 },
  { ruta: "~/Documentos", profundidad: 4 },
  { ruta: "~/Downloads", profundidad: 4 },
  { ruta: "~/Descargas", profundidad: 4 },
]
export const CARPETAS_FIJAS_TEXTO = CARPETAS_FIJAS.map(c => c.ruta)

const PROFUNDIDAD_USUARIO = 4
const VIGENCIA_MS = 30_000
/** Techo de líneas por carpeta: una carpeta con miles de `.png` no puede colgar Orion. */
const MAX_POR_CARPETA = 4000

// Directorios que nunca contienen "un fichero que quiero abrir" y sí miles de
// `.py`/`.sh`/`.png`: entornos virtuales, dependencias, cachés. Los ocultos se
// podan todos (`.*`), salvo la propia carpeta de partida (`-mindepth 1`), para
// que el usuario pueda añadir `~/.local/bin` a propósito.
const PODAR = ["node_modules", "__pycache__", "site-packages", "venv"]

// Carpeta, profundidad y extensión van como argumentos posicionales: nada de lo
// que haya escrito el usuario se interpola en la línea de shell (la extensión
// además ya viene validada como alfanumérica por `separarConsulta`). `; true`
// porque un subdirectorio sin permiso hace salir a `find` con 1 y `execAsync`
// tiraría también lo que sí encontró.
const SCRIPT_FIND = [
  `timeout 5 find "$1" -mindepth 1 -maxdepth "$2"`,
  `\\( -name '.*' ${PODAR.map(n => `-o -name ${n}`).join(" ")} \\) -prune -o`,
  `-type f -iname "*.$3"`,
  `-printf '%T@\\t%p\\n' 2>/dev/null | head -n ${MAX_POR_CARPETA}; true`,
].join(" ")

/**
 * Un índice por extensión: buscar `.pdf` no tiene por qué recorrer el disco
 * buscando `.jar`, y cada `find` filtra por una sola extensión en origen.
 * Mientras se teclea ("x.p", "x.pd", "x.pdf") cada paso escanea su extensión;
 * son unos milisegundos por carpeta y caducan a los 30 s.
 */
interface IndiceExtension {
  ficheros: FicheroEjecutable[]
  actualizadoEn: number
  escaneando: Promise<void> | null
}
const indices = new Map<string, IndiceExtension>()
const oyentes = new Set<(ext: string) => void>()

/** Se llama con la extensión cuyo índice acaba de cambiar (al terminar un escaneo). */
export function alActualizarEjecutables(fn: (ext: string) => void): () => void {
  oyentes.add(fn)
  return () => oyentes.delete(fn)
}

function carpetasAEscanear(): { ruta: string; profundidad: number }[] {
  const todas = [
    ...CARPETAS_FIJAS,
    ...orionRutasEjecutables.get().map(ruta => ({ ruta, profundidad: PROFUNDIDAD_USUARIO })),
  ]
  const vistas = new Set<string>()
  const out: { ruta: string; profundidad: number }[] = []
  for (const c of todas) {
    const abs = expandirCarpeta(c.ruta, CASA)
    if (vistas.has(abs) || !GLib.file_test(abs, GLib.FileTest.IS_DIR)) continue
    vistas.add(abs)
    out.push({ ruta: abs, profundidad: c.profundidad })
  }
  return out
}

function escanear(ext: string, idx: IndiceExtension): void {
  idx.escaneando = Promise.all(carpetasAEscanear().map(c =>
    execAsync(["sh", "-c", SCRIPT_FIND, "sh", c.ruta, String(c.profundidad), ext])
      .then(salida => parsearFind(salida, ext))
      .catch(() => [] as FicheroEjecutable[]),
  )).then(listas => {
    // Una carpeta del usuario puede estar dentro de otra (p. ej. ~/Descargas/juegos).
    const porRuta = new Map<string, FicheroEjecutable>()
    for (const lista of listas) for (const f of lista) porRuta.set(f.ruta, f)
    idx.ficheros = [...porRuta.values()]
    idx.actualizadoEn = Date.now()
  }).finally(() => {
    idx.escaneando = null
    oyentes.forEach(fn => { try { fn(ext) } catch (_) {} })
  })
}

/**
 * Ficheros con extensión `ext` que hay en el índice ahora mismo (síncrono: lo
 * llama el motor de búsqueda en cada tecla). Si está caducado o no existe,
 * lanza un escaneo en segundo plano.
 */
export function ejecutablesIndexados(ext: string): FicheroEjecutable[] {
  let idx = indices.get(ext)
  if (!idx) {
    idx = { ficheros: [], actualizadoEn: 0, escaneando: null }
    indices.set(ext, idx)
  }
  if (!idx.escaneando && Date.now() - idx.actualizadoEn > VIGENCIA_MS) escanear(ext, idx)
  return idx.ficheros
}

// Cambiar las carpetas en Ajustes hace caducar todos los índices: la próxima
// búsqueda con extensión ya escanea la lista nueva.
orionRutasEjecutables.subscribe(() => { for (const idx of indices.values()) idx.actualizadoEn = 0 })

function esEjecutable(ruta: string): boolean {
  return GLib.file_test(ruta, GLib.FileTest.IS_EXECUTABLE)
}

/** Línea de shell para abrir un ejecutable del índice. */
export function comandoDe(ruta: string): string {
  return comandoEjecutable(ruta, esEjecutable(ruta), orionComandosArchivo.get())
}

/**
 * El fichero se EJECUTA (es uno de los cuatro ejecutables, o el usuario le ha
 * puesto un comando a su extensión) en vez de abrirse con su app: es lo que
 * decide si la ficha ofrece "Ejecutar como root".
 */
export function seEjecuta(ruta: string): boolean {
  const ext = extensionDe(ruta)
  return esExtensionEjecutable(ext) || orionComandosArchivo.get().some(r => r.ext === ext)
}

/**
 * Abre un fichero del índice: un ejecutable con su intérprete y cualquier otro
 * con su app predeterminada (`xdg-open`). Anclado al escritorio actual.
 */
export function lanzarEjecutable(ruta: string): void {
  const cmd = comandoDe(ruta)
  if (cmd) launchApp(cmd)
}

/**
 * Ejecuta `linea` como root tras el diálogo de contraseña de polkit.
 *
 * Igual que desinstalar, hay que esperar a que Orion DESAPAREZCA antes de
 * lanzar: es una layer OVERLAY y el diálogo, una ventana normal, saldría debajo
 * (ver `esperarOrionOculto`). Quien llama ya ha hecho `hidePanel()`.
 */
export async function lanzarComoRoot(linea: string): Promise<void> {
  const cmd = linea.trim()
  if (!cmd) return
  await esperarOrionOculto()
  launchApp(comandoComoRoot(cmd, {
    DISPLAY: GLib.getenv("DISPLAY"),
    WAYLAND_DISPLAY: GLib.getenv("WAYLAND_DISPLAY"),
    XDG_RUNTIME_DIR: GLib.getenv("XDG_RUNTIME_DIR"),
    XAUTHORITY: GLib.getenv("XAUTHORITY"),
  }))
}

/** Línea para ejecutar como root una app de `.desktop` (su `Exec` sin `%u`…). */
export function execDeApp(execRaw: string): string {
  return limpiarExec(execRaw)
}

/**
 * Fichero que hay que señalar en "Mostrar ubicación" para una app: su binario
 * real si el `Exec` lo dice, y si es un envoltorio (Flatpak, Steam, `env`…) o
 * el binario no está en el `PATH`, el propio `.desktop`.
 */
export function ubicacionDeApp(execRaw: string, desktopFile: string): string | null {
  const prog = programaDeExec(execRaw)
  if (prog) {
    const ruta = prog.startsWith("/") ? prog : GLib.find_program_in_path(prog)
    if (ruta && GLib.file_test(ruta, GLib.FileTest.EXISTS)) return ruta
  }
  return desktopFile && GLib.file_test(desktopFile, GLib.FileTest.EXISTS) ? desktopFile : null
}

/**
 * Abre el gestor de archivos en la carpeta de `ruta`, con el fichero
 * seleccionado. Dolphin es el gestor del sistema y sabe seleccionar
 * (`--select`); sin él se abre la carpeta con lo que diga `xdg-open`.
 */
export function mostrarUbicacion(ruta: string | null): void {
  if (!ruta) {
    execAsync([
      "notify-send", "-a", "Orion", "-u", "low",
      "No se encontró la ubicación", "Esta app no indica dónde está instalada.",
    ]).catch(() => {})
    return
  }
  if (GLib.find_program_in_path("dolphin")) {
    launchApp(`dolphin --select ${citar(ruta)}`)
  } else {
    execAsync(["xdg-open", GLib.path_get_dirname(ruta)]).catch(() => {})
  }
}
