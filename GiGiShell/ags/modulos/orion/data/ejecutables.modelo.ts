// Lógica pura de la búsqueda de ficheros de Orion: teclear una extensión busca
// ficheros con ella. Los "ejecutables sueltos" —programas que no se instalan
// (no dejan `.desktop`): un `.AppImage` descargado, un `.jar`, un `.sh` o un
// `.py`— se lanzan con su intérprete; el resto se abre con la app predeterminada. Sin GLib ni
// GTK a propósito, para poder probarla con `node --test`; la E/S (escanear el
// disco, lanzar) está en `ejecutables.ts`.

/**
 * Extensiones que se EJECUTAN (con su intérprete) en vez de abrirse con la app
 * predeterminada. Cualquier otra extensión también se busca, pero se abre con
 * `xdg-open`, como un doble clic en el gestor de archivos.
 */
export const EXTENSIONES = ["appimage", "jar", "sh", "py"] as const
export type ExtensionEjecutable = typeof EXTENSIONES[number]

/** La extensión es de las que se ejecutan (y por tanto admite "como root"). */
export function esExtensionEjecutable(ext: string | null): ext is ExtensionEjecutable {
  return ext !== null && (EXTENSIONES as readonly string[]).includes(ext)
}

// Una extensión es alfanumérica, corta y lleva al menos una letra: así "v1.2"
// o "3.14" no se toman por una búsqueda de ficheros `.2` o `.14`.
const RE_EXTENSION = /^(?=.*[a-z])[a-z0-9]{1,8}$/

export interface ConsultaEjecutable {
  /** Lo escrito antes de la extensión ("" si solo se tecleó ".pdf"). */
  base: string
  /** En minúsculas y sin punto. */
  ext: string
}

/**
 * Detecta si la búsqueda pide ficheros: termina en `.algo` con forma de
 * extensión ("juego.jar", ".pdf", "factura.PDF"). "firefox", "v1.2" o "x."
 * no. Sin extensión Orion se comporta como siempre.
 */
export function separarConsulta(consulta: string): ConsultaEjecutable | null {
  const q = consulta.trim()
  const punto = q.lastIndexOf(".")
  if (punto < 0) return null
  const ext = q.slice(punto + 1).toLowerCase()
  if (!RE_EXTENSION.test(ext)) return null
  return { base: q.slice(0, punto).trim(), ext }
}

/** Extensión de una ruta en minúsculas, o `null` si el nombre no tiene. */
export function extensionDe(ruta: string): string | null {
  const nombre = ruta.slice(ruta.lastIndexOf("/") + 1)
  const punto = nombre.lastIndexOf(".")
  if (punto <= 0 || punto === nombre.length - 1) return null
  return nombre.slice(punto + 1).toLowerCase()
}

/** Comillas simples de shell: todo literal, una `'` se cierra, se escapa y se reabre. */
export function citar(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

function directorioDe(ruta: string): string {
  const i = ruta.lastIndexOf("/")
  return i <= 0 ? "/" : ruta.slice(0, i)
}

/**
 * Línea de shell que abre el fichero.
 *
 * Los ejecutables corren DESDE SU CARPETA: un script o un `.jar` suelen buscar
 * sus ficheros por ruta relativa, y lanzados desde `$HOME` fallan sin decir por
 * qué.
 *
 * - `.py` → `python3`, `.jar` → `java -jar`: no dependen del bit de ejecución.
 * - `.sh` → directo si es ejecutable (respeta su shebang); si no, `bash`.
 * - `.AppImage` → necesita el bit sí o sí, así que se le pone si falta: es el
 *   paso que cualquiera haría a mano tras descargarlo.
 * - Cualquier otro (un `.pdf`, un `.png`…) → `xdg-open`, o sea la app que el
 *   sistema tenga asociada a su tipo, la misma que en Dolphin.
 *
 * Por encima de todo eso, si el usuario definió una regla para la extensión
 * (`reglas`), se usa la suya.
 */
export function comandoEjecutable(
  ruta: string,
  esEjecutable: boolean,
  reglas: readonly ComandoArchivo[] = [],
): string {
  const ext = extensionDe(ruta)
  const regla = ext ? reglas.find(r => r.ext === ext) : undefined
  if (regla) return comandoPersonalizado(regla, ruta)
  const r = citar(ruta)
  const cd = `cd ${citar(directorioDe(ruta))} && `
  switch (ext) {
    case "py": return `${cd}exec python3 ${r}`
    case "jar": return `${cd}exec java -jar ${r}`
    case "sh": return esEjecutable ? `${cd}exec ${r}` : `${cd}exec bash ${r}`
    case "appimage": return esEjecutable ? `${cd}exec ${r}` : `chmod +x ${r} && ${cd}exec ${r}`
    default: return `exec xdg-open ${r}`
  }
}

/**
 * Regla del usuario para abrir una extensión con SU comando (Ajustes > Orion >
 * Cómo abrir cada extensión): `{ ext: "c", comando: "gcc {archivo} -o {nombre}",
 * terminal: true }`. Gana a todo lo demás, incluidos los intérpretes de los
 * cuatro ejecutables y la app predeterminada del sistema.
 */
export interface ComandoArchivo {
  /** En minúsculas y sin punto. */
  ext: string
  comando: string
  /** Abrirlo en un terminal que se queda abierto, para ver la salida. */
  terminal: boolean
}

/** `" .C "` → `"c"`; `null` si no tiene forma de extensión. */
export function normalizarExtension(entrada: string): string | null {
  const ext = entrada.trim().replace(/^\.+/, "").toLowerCase()
  return RE_EXTENSION.test(ext) ? ext : null
}

/**
 * Limpia la lista guardada: descarta entradas mal formadas y, si una extensión
 * se repite, se queda la ÚLTIMA (la que se añadió después es la que el usuario
 * quiere ahora).
 */
export function sanitizarComandos(lista: unknown[]): ComandoArchivo[] {
  const porExt = new Map<string, ComandoArchivo>()
  for (const e of lista) {
    if (!e || typeof e !== "object") continue
    const { ext, comando, terminal } = e as Record<string, unknown>
    const extNorm = typeof ext === "string" ? normalizarExtension(ext) : null
    const cmd = typeof comando === "string" ? comando.trim() : ""
    if (!extNorm || !cmd) continue
    porExt.delete(extNorm)
    porExt.set(extNorm, { ext: extNorm, comando: cmd, terminal: terminal === true })
  }
  return [...porExt.values()]
}

/**
 * Línea de shell de una regla del usuario. Sustituye, ya entrecomillados:
 * `{archivo}` (ruta completa), `{nombre}` (nombre sin extensión, para cosas
 * como `-o {nombre}`) y `{carpeta}`. Si la plantilla no menciona `{archivo}`,
 * la ruta se añade al final: "gcc" a secas significa "gcc <archivo>". Corre
 * desde la carpeta del fichero, como los ejecutables.
 *
 * Con `terminal`, se abre en `terminal` (un comando que acepta el programa a
 * continuación, p. ej. `kitty --hold`) para que se vea la salida y no se
 * cierre al acabar: sin eso un `gcc` que falla no deja rastro en ningún sitio.
 */
export function comandoPersonalizado(regla: ComandoArchivo, ruta: string, terminal = "kitty --hold"): string {
  const dir = directorioDe(ruta)
  const fichero = ruta.slice(ruta.lastIndexOf("/") + 1)
  const punto = fichero.lastIndexOf(".")
  const nombre = punto > 0 ? fichero.slice(0, punto) : fichero
  let cmd = regla.comando
  if (!cmd.includes("{archivo}")) cmd += " {archivo}"
  cmd = cmd
    .split("{archivo}").join(citar(ruta))
    .split("{nombre}").join(citar(nombre))
    .split("{carpeta}").join(citar(dir))
  const linea = `cd ${citar(dir)} && ${cmd}`
  return regla.terminal ? `${terminal} sh -c ${citar(linea)}` : linea
}

/**
 * Envuelve una línea de shell para que corra como root tras el diálogo gráfico
 * de polkit. `pkexec` arranca con el entorno VACÍO, así que una app gráfica no
 * encontraría la sesión: se le pasan explícitamente las variables de pantalla
 * que haya (solo las que existan, una vacía rompería más de lo que arregla).
 */
export function comandoComoRoot(linea: string, entorno: Record<string, string | null | undefined>): string {
  const vars = Object.entries(entorno)
    .filter(([, v]) => typeof v === "string" && v.length > 0)
    .map(([k, v]) => citar(`${k}=${v}`))
  return ["pkexec", "env", ...vars, "sh", "-c", citar(linea)].join(" ")
}

/** Quita los códigos de campo (`%u`, `%F`…) de un `Exec` de `.desktop`. */
export function limpiarExec(exec: string): string {
  return exec.replace(/%[fFuUdDnNickvmb]/g, "").trim()
}

// Primeras palabras de un `Exec` que son un ENVOLTORIO y no el programa: su
// binario no dice dónde está la app (sería `/usr/bin/flatpak`), así que para
// "mostrar ubicación" se usa el `.desktop`.
const ENVOLTORIOS = new Set([
  "env", "sh", "bash", "flatpak", "steam", "gtk-launch", "xdg-open", "kioclient", "kioclient5", "kioclient6",
])

/**
 * Programa real de un `Exec`, o `null` si es un envoltorio. Admite comillas
 * dobles alrededor de la primera palabra (`"/opt/My App/app" %U`).
 */
export function programaDeExec(exec: string): string | null {
  const e = limpiarExec(exec)
  const m = e.match(/^"([^"]+)"|^(\S+)/)
  const prog = m ? (m[1] ?? m[2]) : ""
  if (!prog) return null
  const nombre = prog.slice(prog.lastIndexOf("/") + 1)
  return ENVOLTORIOS.has(nombre) ? null : prog
}

/** Ruta con `$HOME` como `~`; lo que está fuera de casa queda absoluto. */
export function rutaDesdeCasa(ruta: string, casa: string): string {
  if (ruta === casa) return "~"
  if (ruta.startsWith(casa + "/")) return "~" + ruta.slice(casa.length)
  return ruta
}

/**
 * Carpeta de un ejecutable lista para pintar debajo de su nombre, con techo de
 * `max` caracteres para que la fila no ensanche Orion (la layer no vuelve a
 * encogerse sola, ver la franja de Inicio en el CLAUDE.md de ags). Se conservan
 * el principio —dice en qué zona está: `~/Descargas`— y el final —la carpeta
 * que lo contiene—, y lo de en medio se cambia por `…`.
 */
export function carpetaCorta(ruta: string, casa: string, max = 44): string {
  const dir = rutaDesdeCasa(directorioDe(ruta), casa)
  if (dir.length <= max) return dir
  const partes = dir.split("/")
  const cabeza = partes.slice(0, 2).join("/")
  let cola = ""
  for (let i = partes.length - 1; i >= 2; i--) {
    const candidata = cola ? `${partes[i]}/${cola}` : partes[i]
    if (cabeza.length + 3 + candidata.length > max) break
    cola = candidata
  }
  if (cola) return `${cabeza}/…/${cola}`
  return `…${dir.slice(-(max - 1))}`
}

/**
 * Normaliza una carpeta escrita en Ajustes: sin espacios alrededor ni barra
 * final, y con `$HOME` como `~` para que la lista se lea igual en cualquier
 * equipo. Devuelve `null` si no es una ruta (relativa o vacía).
 */
export function normalizarCarpeta(entrada: string, casa: string): string | null {
  let r = entrada.trim()
  if (!r) return null
  if (r.length > 1) r = r.replace(/\/+$/, "")
  if (r !== "~" && !r.startsWith("~/") && !r.startsWith("/")) return null
  return rutaDesdeCasa(r, casa)
}

/** Inversa de la anterior: `~/x` → `/home/u/x`. */
export function expandirCarpeta(r: string, casa: string): string {
  if (r === "~") return casa
  if (r.startsWith("~/")) return casa + r.slice(1)
  return r
}

export interface FicheroEjecutable {
  ruta: string
  /** Segundos desde epoch (mtime), para ordenar lo reciente primero. */
  mtime: number
}

/**
 * Parsea la salida de `find -printf '%T@\t%p\n'`. Las líneas que no tienen esa
 * forma o cuya extensión no es `ext` se descartan.
 */
export function parsearFind(salida: string, ext: string): FicheroEjecutable[] {
  const out: FicheroEjecutable[] = []
  for (const linea of salida.split("\n")) {
    const tab = linea.indexOf("\t")
    if (tab <= 0) continue
    const mtime = Number(linea.slice(0, tab))
    const ruta = linea.slice(tab + 1)
    if (!Number.isFinite(mtime) || !ruta.startsWith("/") || extensionDe(ruta) !== ext) continue
    out.push({ ruta, mtime })
  }
  return out
}
