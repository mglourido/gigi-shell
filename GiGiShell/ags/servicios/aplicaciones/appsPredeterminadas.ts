// servicios/aplicaciones/appsPredeterminadas.ts — qué app abre cada cosa:
// enlaces web, correo, carpetas, PDF, imágenes… y cuál es el terminal.
//
// ── Los tipos de archivo van por GIO a ~/.config/mimeapps.list ────────────────
// `Gio.AppInfo.set_as_default_for_type()` escribe en `$XDG_CONFIG_HOME/
// mimeapps.list`, que es justo el fichero LOCAL del usuario que ya pisa, entrada
// a entrada, la base de `/etc/xdg/mimeapps.list` que instala el repo (ver
// "Bases de escritorio" en bin/link.sh). No se escribe el fichero a mano ni se
// llama a `xdg-mime default`: GIO mantiene a la vez `[Default Applications]` y
// `[Added Associations]`, que es lo que miran xdg-open (en Hyprland corre en
// modo `generic` y pregunta a `xdg-mime query default`), las apps GTK y KDE,
// Electron y los navegadores. Medido con XDG_CONFIG_HOME apuntando a un
// directorio vacío: una llamada deja las dos secciones y `xdg-mime query
// default` devuelve la app nueva en el acto.
//
// Una categoría son varios tipos MIME (Imágenes = png, jpeg, webp…), pero la app
// elegida solo se fija en los que declara saber abrir: poner Gwenview como
// predeterminada de `image/x-xcf` sin que lo anuncie dejaría ese formato con
// una app que falla al abrirlo, sin error visible hasta que alguien lo prueba.
// El primer tipo de cada lista es el REPRESENTANTE: de él salen las candidatas
// y la app que se enseña como actual.
//
// ── El terminal no es un tipo MIME ───────────────────────────────────────────
// No hay entrada de mimeapps.list para «el terminal», así que se reparte entre
// quien lo consume:
//   - `~/.config/gigishell/apps-predeterminadas.json` → lo lee
//     `hypr/scripts/abrir-terminal.sh`, que es lo que lanza SUPER+Q.
//   - `kdeglobals [General] TerminalApplication/TerminalService` del usuario
//     (con kwriteconfig6) → «Abrir terminal aquí» de Dolphin y demás apps KDE.
//     La base de /etc/xdg trae kitty; esto la pisa solo en ~/.config.
//   - `~/.config/xdg-terminals.list` → la especificación de xdg-terminal-exec,
//     que GLib usa antes que su lista fija para las apps `Terminal=true`.

import Gio from "gi://Gio"
import GLib from "gi://GLib"
import { execAsync } from "ags/process"
import { cargarJson, rutaConfig, saveJsonAsync } from "../almacenamiento/json"
import { sanearComando } from "./appsInicioModelo"

const ETIQUETA = "apps-predeterminadas"
const RUTA = rutaConfig("apps-predeterminadas.json")
const VERSION = 1
const TERMINAL_POR_DEFECTO = "kitty.desktop"

let terminalElegida: string | null = null

export type IdCategoria =
  | "navegador" | "correo" | "archivos" | "pdf"
  | "imagenes" | "video" | "musica" | "texto" | "comprimidos"

export interface CategoriaMime {
  id: IdCategoria
  icono: string
  /** El primero es el representante (candidatas y app actual). */
  mimes: string[]
}

export const CATEGORIAS: CategoriaMime[] = [
  {
    id: "navegador", icono: "󰖟",
    mimes: [
      "x-scheme-handler/https", "x-scheme-handler/http", "text/html",
      "application/xhtml+xml", "x-scheme-handler/about", "x-scheme-handler/unknown",
    ],
  },
  { id: "correo", icono: "󰇮", mimes: ["x-scheme-handler/mailto"] },
  { id: "archivos", icono: "󰉋", mimes: ["inode/directory"] },
  { id: "pdf", icono: "󰈦", mimes: ["application/pdf", "application/x-bzpdf", "application/x-gzpdf"] },
  {
    id: "imagenes", icono: "󰋩",
    mimes: [
      "image/png", "image/jpeg", "image/webp", "image/gif", "image/bmp", "image/svg+xml",
      "image/tiff", "image/avif", "image/heif", "image/jxl", "image/x-ico", "image/vnd.microsoft.icon",
    ],
  },
  {
    id: "video", icono: "󰕧",
    mimes: [
      "video/mp4", "video/x-matroska", "video/webm", "video/mpeg", "video/ogg",
      "video/quicktime", "video/vnd.avi", "video/x-msvideo", "video/x-ms-wmv", "video/mp2t",
    ],
  },
  {
    id: "musica", icono: "󰝚",
    mimes: [
      "audio/mpeg", "audio/flac", "audio/x-flac", "audio/ogg", "audio/x-vorbis+ogg",
      "audio/x-opus+ogg", "audio/mp4", "audio/aac", "audio/x-wav", "audio/vnd.wave", "audio/webm",
    ],
  },
  { id: "texto", icono: "󰈙", mimes: ["text/plain"] },
  {
    id: "comprimidos", icono: "󰗄",
    mimes: [
      "application/zip", "application/x-7z-compressed", "application/vnd.rar", "application/x-tar",
      "application/gzip", "application/x-compressed-tar", "application/x-xz-compressed-tar",
      "application/x-bzip2-compressed-tar", "application/x-zstd-compressed-tar", "application/zstd",
    ],
  },
]

export interface AppCandidata {
  id: string
  nombre: string
  /** `Gio.Icon.to_string()`, igual que en Apps al inicio (ver `catalogoApps.ts`). */
  icono: string
}

function aCandidata(app: Gio.AppInfo): AppCandidata {
  return {
    id: app.get_id() ?? "",
    nombre: app.get_display_name() || app.get_name() || app.get_id() || "",
    icono: app.get_icon()?.to_string() ?? "",
  }
}

/**
 * Apps que declaran abrir `mime`. Una oculta (`NoDisplay=true`) entra solo si es
 * el AYUDANTE de una app visible instalada —mismo nombre— que no anuncia el tipo
 * por sí misma, y si ninguna candidata visible se llama ya así. Es el caso de
 * Okular: registra el PDF en `okularApplication_pdf.desktop`, oculto, y su
 * `.desktop` visible no anuncia el PDF, así que filtrando todas las ocultas
 * Okular no saldría para PDF. Aceptarlas todas colaba ayudantes sin app detrás
 * («kitty URL Launcher», medido, salía como gestor de carpetas).
 */
function candidatasPara(mime: string): AppCandidata[] {
  const apps = Gio.AppInfo.get_all_for_type(mime) as Gio.AppInfo[]
  const visibles = apps.filter((a) => a.should_show())
  const nombresVisibles = new Set(visibles.map((a) => aCandidata(a).nombre))
  const nombresInstaladas = new Set(
    (Gio.AppInfo.get_all() as Gio.AppInfo[]).filter((a) => a.should_show()).map((a) => aCandidata(a).nombre),
  )
  const ocultas = apps.filter((a) => {
    if (a.should_show()) return false
    const nombre = aCandidata(a).nombre
    return nombresInstaladas.has(nombre) && !nombresVisibles.has(nombre)
  })
  const vistos = new Set<string>()
  return [...visibles, ...ocultas]
    .map(aCandidata)
    .filter((c) => c.id && !vistos.has(c.id) && vistos.add(c.id))
    .sort((a, b) => a.nombre.localeCompare(b.nombre))
}

export function candidatasCategoria(categoria: CategoriaMime): AppCandidata[] {
  return candidatasPara(categoria.mimes[0])
}

export function actualCategoria(categoria: CategoriaMime): AppCandidata | null {
  const app = Gio.AppInfo.get_default_for_type(categoria.mimes[0], false)
  return app ? aCandidata(app) : null
}

/** Fija `idApp` para todos los tipos de la categoría que la app sabe abrir. */
export function fijarCategoria(categoria: CategoriaMime, idApp: string): boolean {
  const [representante, ...resto] = categoria.mimes
  const app = (Gio.AppInfo.get_all_for_type(representante) as Gio.AppInfo[])
    .find((a) => a.get_id() === idApp)
  if (!app) return false
  try {
    app.set_as_default_for_type(representante)
    for (const mime of resto) {
      const sabe = (Gio.AppInfo.get_all_for_type(mime) as Gio.AppInfo[]).some((a) => a.get_id() === idApp)
      if (sabe) app.set_as_default_for_type(mime)
    }
    return true
  } catch (e) {
    console.error(`[${ETIQUETA}] no se pudo fijar ${idApp} para ${categoria.id}:`, e)
    return false
  }
}

// ── Terminal ─────────────────────────────────────────────────────────────────

function categoriasDe(app: Gio.AppInfo): string {
  // `get_categories` es de GioUnix.DesktopAppInfo; todo lo que devuelve
  // `get_all()` en Linux lo es, pero el tipo declarado es el genérico.
  return (app as unknown as { get_categories?: () => string | null }).get_categories?.() ?? ""
}

function terminalesInstaladas(): Gio.AppInfo[] {
  return (Gio.AppInfo.get_all() as Gio.AppInfo[])
    .filter((a) => a.should_show() && categoriasDe(a).split(";").includes("TerminalEmulator"))
}

export function candidatasTerminal(): AppCandidata[] {
  return terminalesInstaladas().map(aCandidata).sort((a, b) => a.nombre.localeCompare(b.nombre))
}

/** La guardada si sigue instalada; si no, kitty (lo que ya lanzaba SUPER+Q); si no, la primera. */
export function actualTerminal(): AppCandidata | null {
  const instaladas = terminalesInstaladas()
  // La memoria va primero porque el JSON se escribe asíncrono: releerlo justo
  // después de `fijarTerminal` devolvería todavía la elección anterior.
  terminalElegida ??= cargarJson<{ terminal?: { id?: string } }>(RUTA, {}, ETIQUETA).terminal?.id ?? null
  const guardada = terminalElegida
  const app = instaladas.find((a) => a.get_id() === guardada)
    ?? instaladas.find((a) => a.get_id() === TERMINAL_POR_DEFECTO)
    ?? instaladas[0]
  return app ? aCandidata(app) : null
}

/** Antepone `id` a ~/.config/xdg-terminals.list conservando el resto del orden. */
function anteponerEnListaTerminales(id: string) {
  const ruta = `${GLib.get_user_config_dir()}/xdg-terminals.list`
  let lineas: string[] = []
  try {
    if (GLib.file_test(ruta, GLib.FileTest.EXISTS)) {
      const [, contenido] = GLib.file_get_contents(ruta)
      lineas = new TextDecoder().decode(contenido).split("\n").map((l) => l.trim()).filter(Boolean)
    }
    GLib.file_set_contents(ruta, [id, ...lineas.filter((l) => l !== id)].join("\n") + "\n")
  } catch (e) {
    console.error(`[${ETIQUETA}] no se pudo escribir ${ruta}:`, e)
  }
}

export function fijarTerminal(idApp: string): boolean {
  const app = terminalesInstaladas().find((a) => a.get_id() === idApp)
  const comando = app ? sanearComando(app.get_commandline() ?? "") : ""
  if (!app || !comando) return false

  terminalElegida = idApp
  saveJsonAsync(RUTA, { version: VERSION, terminal: { id: idApp, comando } }, ETIQUETA)
  anteponerEnListaTerminales(idApp)
  if (GLib.find_program_in_path("kwriteconfig6")) {
    const base = ["kwriteconfig6", "--file", "kdeglobals", "--group", "General", "--key"]
    execAsync([...base, "TerminalApplication", comando])
      .then(() => execAsync([...base, "TerminalService", idApp]))
      .catch((e) => console.error(`[${ETIQUETA}] kwriteconfig6 falló:`, e))
  }
  return true
}
