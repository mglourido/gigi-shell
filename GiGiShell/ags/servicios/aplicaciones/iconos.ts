import Gdk from "gi://Gdk"
import Gio from "gi://Gio"
import GLib from "gi://GLib"
import { Gtk } from "ags/gtk4"
import {
  obtenerEntradaEscritorio,
  obtenerEntradaEscritorioPorCandidatos,
  type ClienteAplicacionLike,
} from "./entradasEscritorio"
import {
  nombreBaseAplicacion,
  normalizarIdentificadorAplicacion,
} from "./identificadores"

let tema: Gtk.IconTheme | null = null

function obtenerTema(): Gtk.IconTheme | null {
  if (tema) return tema
  const pantalla = Gdk.Display.get_default()
  if (!pantalla) return null
  tema = Gtk.IconTheme.get_for_display(pantalla)
  return tema
}

function existeEnTema(nombre: string | null | undefined): boolean {
  if (!nombre) return false
  const actual = obtenerTema()
  return !!actual && actual.has_icon(nombre)
}

const cacheIconosOriginales = new Map<string, Gio.Icon | null>()

// Los directorios XDG no cambian durante la sesión, así que la lista se arma una
// sola vez: la recorren tres bucles anidados por cada icono que falla la caché.
let raicesCacheadas: string[] | null = null

function raicesHicolor(): string[] {
  if (raicesCacheadas) return raicesCacheadas
  const directorios = [GLib.get_user_data_dir(), ...GLib.get_system_data_dirs()]
  const raices = directorios.map((dir) => GLib.build_filenamev([dir, "icons", "hicolor"]))
  raices.push(
    GLib.build_filenamev([GLib.get_user_data_dir(), "flatpak", "exports", "share", "icons", "hicolor"]),
    "/var/lib/flatpak/exports/share/icons/hicolor",
  )
  raicesCacheadas = [...new Set(raices)]
  return raicesCacheadas
}

const DIRECTORIOS_ICONO_ORIGINAL = [
  "scalable/apps", "512x512/apps", "256x256/apps", "192x192/apps", "128x128/apps",
  "96x96/apps", "64x64/apps", "48x48/apps", "32x32/apps", "24x24/apps",
  "22x22/apps", "16x16/apps",
]

function iconoOriginalNombrado(nombre: string): Gio.Icon | null {
  const seguro = GLib.path_get_basename(nombre).replace(/\.(?:svg|png|xpm)$/i, "")
  if (!seguro) return null
  if (cacheIconosOriginales.has(seguro)) return cacheIconosOriginales.get(seguro) ?? null

  for (const raiz of raicesHicolor()) {
    for (const directorio of DIRECTORIOS_ICONO_ORIGINAL) {
      for (const extension of ["svg", "png", "xpm"]) {
        const ruta = GLib.build_filenamev([raiz, directorio, `${seguro}.${extension}`])
        if (!GLib.file_test(ruta, GLib.FileTest.EXISTS)) continue
        const icono = Gio.FileIcon.new(Gio.File.new_for_path(ruta))
        cacheIconosOriginales.set(seguro, icono)
        return icono
      }
    }
  }

  cacheIconosOriginales.set(seguro, null)
  return null
}

function clasesCliente(cliente: ClienteAplicacionLike | null | undefined): string[] {
  const exactas = [cliente?.class, cliente?.initialClass ?? cliente?.initial_class]
    .map(normalizarIdentificadorAplicacion)
    .filter(Boolean)
  // Prioridad visual histórica: clases exactas actual/inicial antes que sus bases.
  return [...new Set([...exactas, ...exactas.map(nombreBaseAplicacion)].filter(Boolean))]
}

// ── Iconos de juegos de Steam en temas que NO son el activo ───────────────────
//
// Steam solo deja un `steam_icon_<appid>.png` en `hicolor` cuando se crea un acceso
// directo de escritorio, así que la mayoría de los juegos **no tienen icono ahí** (medido:
// de la biblioteca de esta máquina solo hay tres). Quien sí los trae a miles es un pack de
// iconos instalado (`Gruvbox-Plus-Dark` aquí), y ese pack normalmente NO es el tema activo
// (`Tela-circle-grey`), así que ni `has_icon()` ni la búsqueda por `hicolor` lo encuentran
// y el juego se quedaba con el glifo genérico. Se busca **solo para `steam_icon_*`**: es
// el caso en el que un icono de otro tema es exactamente el arte que se quiere, y acota
// el rebusque a una familia de nombres en vez de aplicarlo a toda app.
//
// **No se hace con `Gtk.IconTheme.set_theme_name()` en bucle**: cada cambio de tema parsea
// su `index.theme` y recorrer los ~15 instalados costaba ~2 s (medido) en el hilo del
// bucle principal. Se miran rutas directas, que son unos cientos de `stat` (~ms), con las
// dos disposiciones que usan los temas reales (`48/apps` de hicolor y `apps/48` de los
// packs de Gruvbox).

const TAMANOS_TEMA = [
  "scalable", "512x512", "512", "256x256", "256", "192x192", "192", "128x128", "128",
  "96x96", "96", "64x64", "64", "48x48", "48", "32x32", "32", "24x24", "24", "22x22", "22",
  "16x16", "16",
]

let raicesTemasCacheadas: string[] | null = null

function raicesTemas(): string[] {
  if (raicesTemasCacheadas) return raicesTemasCacheadas
  const raices: string[] = []
  const contenedores = [
    GLib.build_filenamev([GLib.get_home_dir(), ".icons"]),
    ...[GLib.get_user_data_dir(), ...GLib.get_system_data_dirs()]
      .map((dir) => GLib.build_filenamev([dir, "icons"])),
  ]
  for (const contenedor of [...new Set(contenedores)]) {
    let directorio: GLib.Dir | null = null
    try { directorio = GLib.Dir.open(contenedor, 0) } catch (_) { continue }
    let nombre: string | null
    while ((nombre = directorio.read_name())) {
      // `hicolor` ya lo cubre `iconoOriginalNombrado`; repetirlo solo duplicaría stats.
      if (nombre === "hicolor") continue
      const ruta = GLib.build_filenamev([contenedor, nombre])
      if (GLib.file_test(ruta, GLib.FileTest.IS_DIR)) raices.push(ruta)
    }
  }
  // El tema activo primero: si el arte está en varios packs, gana el que el usuario ve.
  const activo = obtenerTema()?.get_theme_name() ?? ""
  raices.sort((a, b) =>
    Number(GLib.path_get_basename(b) === activo) - Number(GLib.path_get_basename(a) === activo))
  raicesTemasCacheadas = raices
  return raices
}

const cacheIconosSteam = new Map<string, Gio.Icon | null>()

/** El `steam_icon_<appid>` de cualquier tema instalado, no solo del activo ni de hicolor. */
function iconoSteamEnTemasInstalados(appid: string): Gio.Icon | null {
  const nombre = `steam_icon_${appid}`
  if (cacheIconosSteam.has(nombre)) return cacheIconosSteam.get(nombre) ?? null

  for (const raiz of raicesTemas()) {
    for (const tamano of TAMANOS_TEMA) {
      for (const relativa of [`${tamano}/apps`, `apps/${tamano}`]) {
        for (const extension of ["svg", "png"]) {
          const ruta = GLib.build_filenamev([raiz, relativa, `${nombre}.${extension}`])
          if (!GLib.file_test(ruta, GLib.FileTest.EXISTS)) continue
          const icono = Gio.FileIcon.new(Gio.File.new_for_path(ruta))
          cacheIconosSteam.set(nombre, icono)
          return icono
        }
      }
    }
  }

  cacheIconosSteam.set(nombre, null)
  return null
}

export function obtenerIconoOriginalAplicacion(
  cliente: ClienteAplicacionLike | null | undefined,
): Gio.Icon | null {
  const iconoEntrada = obtenerEntradaEscritorio(cliente)?.icono ?? null
  const archivo = (iconoEntrada as any)?.get_file?.() as Gio.File | undefined
  if (archivo) {
    const ruta = archivo.get_path()
    if (ruta && GLib.file_test(ruta, GLib.FileTest.EXISTS)) return iconoEntrada
  }

  const nombres = (iconoEntrada as any)?.get_names?.() as string[] | undefined
  for (const nombre of nombres ?? []) {
    const icono = iconoOriginalNombrado(nombre)
    if (icono) return icono
  }

  const clases = clasesCliente(cliente)
  const steam = clases.map((clase) => /steam_app_(\d+)/.exec(clase)).find(Boolean)
  const candidatos = [steam ? `steam_icon_${steam[1]}` : "", ...clases]
  for (const nombre of candidatos) {
    if (!nombre) continue
    const icono = iconoOriginalNombrado(nombre)
    if (icono) return icono
  }
  // Último recurso y solo para juegos de Steam: el arte suele estar en un pack de iconos
  // instalado que no es el tema activo (ver el bloque de arriba).
  return steam ? iconoSteamEnTemasInstalados(steam[1]) : null
}

export function esIconoUtilizable(icono: Gio.Icon | null): boolean {
  if (!icono) return false
  const nombres = (icono as any).get_names?.() as string[] | undefined
  if (nombres?.length) return nombres.some(existeEnTema)

  const archivo = (icono as any).get_file?.() as Gio.File | undefined
  if (archivo) {
    const ruta = archivo.get_path()
    return !!ruta && GLib.file_test(ruta, GLib.FileTest.EXISTS)
  }
  return true
}

export function obtenerNombreIconoAplicacion(
  cliente: ClienteAplicacionLike | null | undefined,
): string | null {
  const entrada = obtenerEntradaEscritorio(cliente)
  const nombres = (entrada?.icono as any)?.get_names?.() as string[] | undefined
  const desdeEntrada = nombres?.find(existeEnTema)
  if (desdeEntrada) return desdeEntrada

  const clases = clasesCliente(cliente)
  const steam = clases.map((clase) => /steam_app_(\d+)/.exec(clase)).find(Boolean)
  if (steam && existeEnTema(`steam_icon_${steam[1]}`)) return `steam_icon_${steam[1]}`

  for (const candidato of clases) if (existeEnTema(candidato)) return candidato
  return null
}

export function obtenerIconoGenericoAplicacion(
  cliente: ClienteAplicacionLike | null | undefined,
): string {
  const clases = [cliente?.class, cliente?.initialClass ?? cliente?.initial_class]
    .map(normalizarIdentificadorAplicacion)
  const esWine = clases.some((clase) =>
    /(?:^|[._-])(?:wine|proton)(?:$|[._-])/.test(clase) || clase.endsWith(".exe"),
  )
  if (esWine) {
    for (const candidato of ["wine", "org.winehq.Wine"]) {
      if (existeEnTema(candidato)) return candidato
    }
  }

  for (const candidato of ["application-default-icon", "application-x-executable"]) {
    if (existeEnTema(candidato)) return candidato
  }
  return "application-x-executable"
}

export { nombreBaseAplicacion }

/**
 * Nombre de icono del tema para una lista de candidatos ya resuelta (la mezcla de
 * aplicaciones de Quick Settings, que no tiene un cliente de Hyprland del que tirar).
 * Devuelve `null` en vez de inventarse un nombre: quien llama decide el genérico, que es
 * justo lo que antes no pasaba — se le daba a `Gtk.Image` el nombre de la app en
 * minúsculas y el hueco quedaba vacío sin un solo error.
 *
 * Un `.desktop` con `Icon=` de ruta absoluta (AppImage) no aporta nombre de tema: ahí se
 * cae a los candidatos y, si tampoco, al genérico de quien llama.
 */
export function nombreIconoDesdeCandidatos(candidatos: string[]): string | null {
  const entrada = obtenerEntradaEscritorioPorCandidatos(candidatos)
  const nombres = (entrada?.icono as any)?.get_names?.() as string[] | undefined
  const desdeEntrada = nombres?.find(existeEnTema)
  if (desdeEntrada) return desdeEntrada

  for (const candidato of candidatos) if (existeEnTema(candidato)) return candidato
  return null
}
