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
  | "codigo" | "markdown" | "documentos" | "hojas" | "presentaciones"

export interface CategoriaMime {
  /** Un `IdCategoria` en las fijas; el propio MIME en las de «Todos los tipos». */
  id: string
  icono: string
  /** El primero es el representante (candidatas y app actual). */
  mimes: string[]
}

export const CATEGORIAS: (CategoriaMime & { id: IdCategoria })[] = [
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
  // Programación. VS Code (`com.microsoft.VSCode.desktop`) no declara NINGUNO de
  // estos tipos —solo `application/x-code-workspace`—, así que no sale como
  // candidata hasta añadirlo a «Abrir con» desde el buscador de la fila; a
  // partir de ahí ya «sabe» abrirlos y se puede elegir por defecto.
  {
    id: "codigo", icono: "󰅩",
    mimes: [
      "text/x-python", "application/json", "text/javascript", "application/javascript",
      "application/typescript", "text/x-typescript-jsx", "text/x-shellscript", "application/x-shellscript",
      "text/x-csrc", "text/x-chdr", "text/x-c++src", "text/x-c++hdr", "text/rust", "text/x-rust",
      "text/x-go", "text/x-java", "text/x-lua", "text/css", "application/toml", "application/yaml",
      "application/x-yaml", "text/x-makefile", "text/x-cmake", "application/xml", "text/xml",
      "application/sql", "text/x-sql", "application/x-php", "application/x-ruby", "text/x-csharp",
      "text/x-configuration", "text/x-nix", "application/x-fishscript", "application/x-perl",
    ],
  },
  { id: "markdown", icono: "󰍔", mimes: ["text/markdown", "text/x-markdown"] },
  {
    id: "documentos", icono: "󰈬",
    mimes: [
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.oasis.opendocument.text", "application/msword", "application/rtf",
    ],
  },
  {
    id: "hojas", icono: "󰈛",
    mimes: [
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.oasis.opendocument.spreadsheet", "application/vnd.ms-excel", "text/csv",
    ],
  },
  {
    id: "presentaciones", icono: "󰈧",
    mimes: [
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "application/vnd.oasis.opendocument.presentation", "application/vnd.ms-powerpoint",
    ],
  },
]

// ── Todos los tipos de archivo ───────────────────────────────────────────────
// Para lo que no cubre ninguna categoría (.toml, .lua, un formato raro…). El
// índice sale de los `globs2` de shared-mime-info —la misma base de datos que
// usa GIO para adivinar el tipo por la extensión—, porque GIO no expone las
// extensiones de un tipo. Se construye la primera vez que alguien busca y se
// queda en memoria: son ~1600 líneas y no cambian salvo al instalar paquetes.

export interface TipoArchivo {
  mime: string
  descripcion: string
  /** Sin el `*.`: `["md", "markdown"]`. */
  extensiones: string[]
  /** Descripción + extensiones + MIME en minúsculas, para filtrar sin rehacerlo. */
  busqueda: string
}

let indiceTipos: TipoArchivo[] | null = null

function construirIndiceTipos(): TipoArchivo[] {
  const globs = new Map<string, Set<string>>()
  const rutas = [
    `${GLib.get_user_data_dir()}/mime/globs2`,
    ...GLib.get_system_data_dirs().map((d) => `${d}/mime/globs2`),
  ]
  for (const ruta of rutas) {
    try {
      if (!GLib.file_test(ruta, GLib.FileTest.EXISTS)) continue
      const [, contenido] = GLib.file_get_contents(ruta)
      for (const linea of new TextDecoder().decode(contenido).split("\n")) {
        if (!linea || linea.startsWith("#")) continue
        // peso:mime:patrón[:flags]
        const [, mime, patron] = linea.split(":")
        if (!mime || !patron?.startsWith("*.")) continue
        const ext = patron.slice(2).toLowerCase()
        if (!/^[a-z0-9+_.-]+$/.test(ext)) continue
        if (!globs.has(mime)) globs.set(mime, new Set())
        globs.get(mime)!.add(ext)
      }
    } catch (e) {
      console.error(`[${ETIQUETA}] no se pudo leer ${ruta}:`, e)
    }
  }
  const tipos: TipoArchivo[] = []
  for (const [mime, exts] of globs) {
    const descripcion = Gio.content_type_get_description(mime) || mime
    const extensiones = [...exts].sort((a, b) => a.length - b.length)
    tipos.push({
      mime, descripcion, extensiones,
      busqueda: `${descripcion} ${extensiones.join(" ")} ${mime}`.toLowerCase(),
    })
  }
  return tipos
}

/**
 * Tipos que casan con la consulta. Primero los que tienen esa extensión exacta
 * (escribir «md» tiene que dar Markdown arriba, no «Markdown de MDX»), luego
 * los que empiezan por ella y al final los que la contienen en la descripción
 * o el MIME. Acepta «md», «.md» y «*.md».
 */
export function buscarTiposArchivo(consulta: string, maximo: number): TipoArchivo[] {
  const q = consulta.trim().toLowerCase().replace(/^\*?\./, "")
  if (!q) return []
  indiceTipos ??= construirIndiceTipos()
  const rango = (t: TipoArchivo) =>
    t.extensiones.includes(q) ? 0
      : t.extensiones.some((e) => e.startsWith(q)) ? 1
        : t.busqueda.includes(q) ? 2 : -1
  return indiceTipos
    .map((t) => ({ t, r: rango(t) }))
    .filter((x) => x.r >= 0)
    .sort((a, b) => a.r - b.r || a.t.descripcion.localeCompare(b.t.descripcion))
    .slice(0, maximo)
    .map((x) => x.t)
}

/** Categoría de un solo tipo, para reutilizar las mismas operaciones. */
export function categoriaDeTipo(mime: string): CategoriaMime {
  return { id: mime, icono: "󰈔", mimes: [mime] }
}

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
    refrescarCacheKde()
    return true
  } catch (e) {
    console.error(`[${ETIQUETA}] no se pudo fijar ${idApp} para ${categoria.id}:`, e)
    return false
  }
}

// ── La lista de «Abrir con» ──────────────────────────────────────────────────
// Las candidatas de una categoría SON la lista que enseñan Dolphin («Abrir
// con») y los diálogos GTK: sale de las mismas tres secciones de mimeapps.list
// (Default + Added − Removed) más los `.desktop` que declaran el tipo. Se edita
// con `add_supports_type`/`remove_supports_type`, que GIO traduce a `[Added
// Associations]` y `[Removed Associations]` — medido en un HOME aislado:
// quitar LibreOffice Draw del PDF lo apunta en Removed, y volver a añadirlo lo
// saca de ahí sin dejar rastro. Las dos operaciones abarcan todos los tipos de
// la categoría, igual que elegir la predeterminada.

/** KService guarda las asociaciones en su caché (ksycoca). Rehacerla es un
 *  seguro barato para que Dolphin vea el cambio sin reiniciarse; se agrupa
 *  para que quitar tres apps seguidas no lance tres reconstrucciones. */
let temporizadorSycoca: number | null = null
function refrescarCacheKde() {
  if (!GLib.find_program_in_path("kbuildsycoca6")) return
  if (temporizadorSycoca !== null) GLib.source_remove(temporizadorSycoca)
  temporizadorSycoca = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
    temporizadorSycoca = null
    execAsync(["kbuildsycoca6"]).catch((e) => console.error(`[${ETIQUETA}] kbuildsycoca6 falló:`, e))
    return GLib.SOURCE_REMOVE
  })
}

/** Quita la app de «Abrir con» en los tipos de la categoría donde aparezca. */
export function quitarDeCategoria(categoria: CategoriaMime, idApp: string): boolean {
  if (actualCategoria(categoria)?.id === idApp) return false
  try {
    for (const mime of categoria.mimes) {
      const app = (Gio.AppInfo.get_all_for_type(mime) as Gio.AppInfo[]).find((a) => a.get_id() === idApp)
      app?.remove_supports_type(mime)
    }
    refrescarCacheKde()
    return true
  } catch (e) {
    console.error(`[${ETIQUETA}] no se pudo quitar ${idApp} de ${categoria.id}:`, e)
    return false
  }
}

/** Añade cualquier app instalada a «Abrir con» para todos los tipos de la categoría. */
export function anadirACategoria(categoria: CategoriaMime, idApp: string): boolean {
  const app = (Gio.AppInfo.get_all() as Gio.AppInfo[]).find((a) => a.get_id() === idApp)
  if (!app) return false
  try {
    for (const mime of categoria.mimes) app.add_supports_type(mime)
    refrescarCacheKde()
    return true
  } catch (e) {
    console.error(`[${ETIQUETA}] no se pudo añadir ${idApp} a ${categoria.id}:`, e)
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
