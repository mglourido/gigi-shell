import GLib from "gi://GLib"

// Todo lo que sabe de temas de puntero. Vivía dentro de service.ts, pero con la
// migración a hyprcursor dejó de ser "un detalle del slider de tamaño": ahora
// hay un ajuste propio (temaCursor) que necesita además ENUMERAR los temas.
//
// Dos formatos conviven, y no es transitorio:
//
//   - hyprcursor: `manifest.hl` + `hyprcursors/*.hlc` (SVG comprimido). Lo usa
//     el cursor que dibuja el COMPOSITOR, y es el que escala sin pixelarse.
//   - XCursor: `cursors/` (PNG por tamaño). Lo siguen usando XWayland y los
//     toolkits (GTK/Qt dibujan su propio puntero), así que NO puede retirarse:
//     hyprcursor no tiene nada que decirle a una app de XWayland.
//
// Por eso un tema "completo" aquí es un directorio con AMBOS, y por eso los dos
// hl.env() van con el mismo nombre. Es la forma que ya tienen los temas que
// traen soporte hyprcursor de fábrica (Bibata-Modern-Ice: cursors/ +
// hyprcursors/ + manifest.hl en el mismo directorio); bin/generar-hyprcursor.sh
// reproduce esa forma para cualquier tema XCursor.

export const RUTAS_ICONOS = [
  `${GLib.get_user_data_dir()}/icons`,
  `${GLib.get_home_dir()}/.icons`,
  ...GLib.get_system_data_dirs().map((ruta) => `${ruta}/icons`),
]

// El nombre viaja a `hyprctl setcursor` y a un literal Lua de hl.env(), así que
// se valida en origen en vez de escaparlo en cada punto de uso.
export const NOMBRE_TEMA_VALIDO = /^[A-Za-z0-9._+-]+$/

export function esTemaHyprcursor(tema: string): boolean {
  return RUTAS_ICONOS.some((ruta) => GLib.file_test(`${ruta}/${tema}/manifest.hl`, GLib.FileTest.EXISTS))
}

function leerHerenciasTema(nombre: string): string[] {
  for (const ruta of RUTAS_ICONOS) {
    try {
      const [ok, bytes] = GLib.file_get_contents(`${ruta}/${nombre}/index.theme`)
      if (!ok) continue
      const herencias = new TextDecoder().decode(bytes).match(/^Inherits\s*=\s*(.+)$/m)?.[1]
      if (herencias) return herencias.split(/[;,]/).map((tema) => tema.trim().replace(/^"|"$/g, "")).filter(Boolean)
    } catch (_) { /* probar la siguiente ruta */ }
  }
  return []
}

// libhyprcursor casa temas por NOMBRE DE DIRECTORIO con manifest.hl y NO lee
// index.theme ni sigue `Inherits`. Un nombre como `default` —que aquí es solo un
// index.theme escrito por nwg-look que hereda de Bibata— no le dice nada, así
// que seguimos la herencia nosotros.
//
// Y lo que hace cuando no encuentra el nombre NO es fallar: coge el PRIMER tema
// con manifest.hl que se cruce, sin mirar el nombre pedido. Medido con
// hyprcursor_manager_create_with_logger contra la .so instalada:
//
//   getFullPathForThemeName: failed, trying without name of Adwaita
//   Found theme Adwaita at ~/.local/share/icons/Bibata-Modern-Ice
//
// (`valid=false` solo si NO hay ningún tema hyprcursor en el sistema.) O sea que
// un tema sin fijar no significa "sin hyprcursor": significa hyprcursor con un
// tema elegido por el orden de lectura del directorio — ni alfabético ni el
// primero instalado (comprobado con un segundo tema: la elección no cambió).
// Esa es la razón de ser de `temaCursor`: no encender hyprcursor, sino fijar
// CUÁL, para que instalar otro tema no cambie el puntero por su cuenta.
export function resolverTemaHyprcursor(nombre: string, visitados = new Set<string>()): string | null {
  const tema = nombre.trim()
  if (!NOMBRE_TEMA_VALIDO.test(tema) || visitados.has(tema)) return null
  visitados.add(tema)

  if (esTemaHyprcursor(tema)) return tema
  for (const heredado of leerHerenciasTema(tema)) {
    const resuelto = resolverTemaHyprcursor(heredado, visitados)
    if (resuelto) return resuelto
  }
  return null
}

export interface TemaCursor {
  nombre: string
  /** Tiene `cursors/`, o sea que sirve también para XWayland y los toolkits. */
  xcursor: boolean
}

// Solo temas con manifest.hl: un tema sin él no es elegible aquí, porque
// elegirlo dejaría al compositor sin hyprcursor y sin aviso. Se ordenan por
// nombre y se deduplican por precedencia de RUTAS_ICONOS (~/.local/share/icons
// gana a /usr/share/icons, igual que en la búsqueda real).
export function temasHyprcursorDisponibles(): TemaCursor[] {
  const vistos = new Map<string, TemaCursor>()
  for (const ruta of RUTAS_ICONOS) {
    let dir: GLib.Dir
    try { dir = GLib.Dir.open(ruta, 0) } catch (_) { continue }
    let nombre: string | null
    while ((nombre = dir.read_name()) !== null) {
      if (vistos.has(nombre) || !NOMBRE_TEMA_VALIDO.test(nombre)) continue
      if (!GLib.file_test(`${ruta}/${nombre}/manifest.hl`, GLib.FileTest.EXISTS)) continue
      vistos.set(nombre, {
        nombre,
        xcursor: GLib.file_test(`${ruta}/${nombre}/cursors`, GLib.FileTest.IS_DIR),
      })
    }
    dir.close()
  }
  return [...vistos.values()].sort((a, b) => a.nombre.localeCompare(b.nombre))
}
