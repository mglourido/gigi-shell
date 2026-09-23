// Heurística pura. La evidencia de .desktop y /proc se recoge en evidencia.ts.

import { esVentanaEmergenteX11 } from "../ventanas/emergentesX11.ts"
import type { ClienteVentanaLike } from "../ventanas/emergentesX11.ts"

export interface ClienteJuegoLike extends ClienteVentanaLike {
  class?: string | null
  initialClass?: string | null
  initial_class?: string | null
  title?: string | null
  fullscreen?: number | null
}

export interface EvidenciaJuego {
  categories?: readonly string[] | null
  exe?: string | null
  cmdline?: string | null
}

export const PANTALLA_COMPLETA_REAL = 2

const CLASES_LANZADOR = [
  "steam", "steamwebhelper", "lutris", "heroic", "bottles", "playonlinux",
  "itch", "minigalaxy", "gamehub", "protontricks", "winetricks", "winecfg",
]

const CLASES_NO_JUEGO = [
  "firefox", "chrome", "chromium", "brave", "brave-browser", "zen", "librewolf",
  "vivaldi", "opera", "epiphany", "waterfox", "tor-browser",
  "discord", "vesktop", "webcord", "armcord", "telegram", "org.telegram.desktop",
  "slack", "teams", "whatsapp", "signal", "element", "thunderbird", "zoom", "skype",
  "protonmail", "proton-mail", "proton-mail-desktop", "me.proton.mail",
  "mpv", "vlc", "imv", "feh", "eog", "loupe", "gwenview", "mpvpaper", "spotify",
  "celluloid", "totem", "rhythmbox",
  "kitty", "foot", "alacritty", "wezterm", "konsole", "ghostty", "st",
  "gnome-terminal", "xterm", "urxvt", "terminator", "tilix",
  "code", "code-oss", "vscodium", "cursor", "zed", "emacs", "sublime_text",
  "libreoffice", "obsidian", "twine",
  "obs", "nautilus", "thunar", "pcmanfm", "gimp", "blender",
]

function claseBase(clase: string): string {
  if (!clase || clase.endsWith(".exe")) return clase
  const punto = clase.lastIndexOf(".")
  return punto >= 0 ? clase.slice(punto + 1) : clase
}

function estaEnLista(clase: string, lista: readonly string[]): boolean {
  if (!clase) return false
  const candidatos = [clase, claseBase(clase)]
  return lista.some((entrada) => candidatos.some((candidato) =>
    candidato === entrada
      || candidato.startsWith(`${entrada}-`)
      || candidato.endsWith(`-${entrada}`),
  ))
}

function tieneSegmento(clase: string, segmento: string): boolean {
  return new RegExp(`(?:^|[._-])${segmento}(?:$|[._-])`).test(clase)
}

function senalClase(clase: string): boolean {
  if (!clase) return false
  if (/steam_app_\d+/.test(clase) || tieneSegmento(clase, "gamescope")) return true
  if (clase.endsWith(".exe")) return true
  const proton = clase === "proton"
    || clase.startsWith("steam_proton")
    || clase.startsWith("proton-")
  return tieneSegmento(clase, "wine") || proton
}

const RUTAS_FUERTES_COMUNES = [
  "/steamapps/", "steamapps/common", "/steam/steamapps", "/compatibilitytools.d/",
  "/lutris/", "/heroic/", "/gamescope",
]

function contieneRuta(valor: string | null | undefined, rutas: readonly string[]): boolean {
  if (!valor) return false
  return rutas.some((senal) => valor.includes(senal))
}

const TITULO_INSTALADOR =
  /(^|\s)(instalar|instalaci[oó]n|install|installing|installer|setup|uninstall|desinstalar)(\s|$|[:\-–—])/i
const COMANDO_INSTALADOR = /installer|setup\.exe|unins\d*\.exe|\\temp\\/i

function pareceInstalador(c: ClienteJuegoLike, ev?: EvidenciaJuego | null): boolean {
  const titulo = c.title ?? ""
  if (titulo && TITULO_INSTALADOR.test(titulo)) return true
  const comando = ev?.cmdline ?? ""
  return !!comando && COMANDO_INSTALADOR.test(comando)
}

export function esJuego(
  cliente: ClienteJuegoLike | null | undefined,
  evidencia?: EvidenciaJuego | null,
): boolean {
  if (!cliente) return false

  // Lo primero: el MENÚ de una app X11 llega como cliente propio con la clase de
  // su padre, así que el desplegable de un juego pasaba por un segundo juego
  // —pastilla duplicada y auto-DND disparado por una ventana que no existe—. Las
  // señales fuertes de clase no salvan de esto: la clase es exactamente la misma.
  // Si el título llega tarde, `notify::title` en el registro lo reevalúa.
  if (esVentanaEmergenteX11(cliente)) return false

  const clase = (cliente.class ?? "").toLowerCase()
  const claseInicial = (cliente.initialClass ?? cliente.initial_class ?? "").toLowerCase()

  if (estaEnLista(clase, CLASES_LANZADOR) || estaEnLista(claseInicial, CLASES_LANZADOR)) return false
  if (estaEnLista(clase, CLASES_NO_JUEGO) || estaEnLista(claseInicial, CLASES_NO_JUEGO)) return false
  if (pareceInstalador(cliente, evidencia)) return false
  if (senalClase(clase) || senalClase(claseInicial)) return true

  // Un argumento suelto terminado en .exe o una ruta genérica ya no bastan: deben
  // pertenecer a un árbol inequívoco de Steam/Lutris/Heroic/juegos.
  if (contieneRuta(evidencia?.exe, [...RUTAS_FUERTES_COMUNES, "/games/"])) return true
  if (contieneRuta(evidencia?.cmdline, RUTAS_FUERTES_COMUNES)) return true

  const categorias = evidencia?.categories
  if (categorias && categorias.length > 0) {
    return categorias.some((categoria) => categoria.toLowerCase() === "game")
  }

  // Sin clase solo aceptamos evidencia externa fuerte; la pantalla completa por
  // sí sola no identifica una aplicación y produciría falsos positivos.
  if (!clase && !claseInicial) return false
  return (cliente.fullscreen ?? 0) >= PANTALLA_COMPLETA_REAL
}
