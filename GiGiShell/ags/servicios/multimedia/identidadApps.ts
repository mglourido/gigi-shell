// Identidad de una app en la "mezcla de aplicaciones" de Quick Settings: qué nombre la
// designa y qué candidatos sirven para buscar su `.desktop` y su icono.
//
// **El fallo que lo motiva.** La fila se pintaba con `application.name` tal cual y con
// `iconName={application.icon_name || window.icon_name || name.toLowerCase()}`. Las dos
// mitades fallan, y ninguna da error:
//
// - **El nombre.** PulseAudio no promete un nombre presentable: lo pone la app. Salen
//   binarios en minúscula (`spotify`), nombres con sufijo de rol (`Brave input`, que es
//   como se anuncia el cliente de captura de Brave — medido en esta máquina) y adornos
//   de PipeWire (`WirePlumber [export]`). Y en la lista de "apps en silencio" se colaba
//   además cualquier cliente de infraestructura que la lista negra literal no nombrara
//   (`pw-mon` estaba fuera de ella): filas para procesos que el usuario no ha abierto.
// - **El icono.** `application.icon_name` casi nunca viene en un sink-input, así que la
//   cadena caía en `name.toLowerCase()` — un nombre de icono inventado. Como SIEMPRE es
//   una cadena no vacía, el fallback genérico de la última rama era **inalcanzable**:
//   `Gtk.Image` pedía un icono inexistente y pintaba el hueco (o el icono roto), nunca
//   `audio-x-generic-symbolic`. Por eso "casi siempre" salía mal.
//
// Aquí solo vive lo puro (limpieza, candidatos, filtro de infraestructura). La
// resolución contra el índice de `.desktop` y el tema de iconos está en
// `presentacionApps.ts`, que sí necesita GTK.

export type PropsAudio = Record<string, any> | null | undefined

/** Procesos de audio que no son aplicaciones del usuario. Se comparan por subcadena. */
export const CLIENTES_SISTEMA = [
  "pipewire", "wireplumber", "pw-mon", "pw-cli", "pw-cat", "pw-play", "pw-record",
  "pw-dump", "pw-top", "pactl", "pacmd", "pamon", "paplay", "parec", "pavucontrol",
  "xdg-desktop-portal", "hyprland", "gsd-", "gjs", "astal", "ags", "speech-dispatcher",
  "libcanberra", "canberra-gtk-play", "wpctl", "qpwgraph", "helvum", "easyeffects",
]

/**
 * Quita el adorno de rol que muchas apps añaden al nombre del cliente: `Brave input`,
 * `Chromium output`, `WirePlumber [export]`. Sin esto el nombre se ve mal Y la fila no
 * se deduplica contra el stream de la misma app, que sí viene sin sufijo.
 */
export function limpiarNombreApp(valor: string | null | undefined): string {
  return String(valor ?? "")
    .trim()
    .replace(/\s*\[[^\]]*\]\s*$/, "")
    .replace(/\s+(?:input|output|capture|playback|entrada|salida)$/i, "")
    .trim()
}

function normalizar(valor: string | null | undefined): string {
  return String(valor ?? "").trim().toLowerCase().replace(/\.desktop$/i, "")
}

/**
 * Identificadores ordenados para buscar la app, de más fiable a menos. El id de
 * escritorio primero (es literalmente la clave del `.desktop`), luego el binario —que
 * es lo único que no puede inventarse la app— y solo después los nombres visibles.
 */
export function candidatosApp(props: PropsAudio): string[] {
  const p = props || {}
  const crudos = [
    p["application.id"],
    p["application.process.binary"],
    limpiarNombreApp(p["application.name"]),
    p["application.name"],
    limpiarNombreApp(p["node.name"]),
    p["node.name"],
  ]
  const candidatos: string[] = []
  for (const crudo of crudos) {
    const limpio = normalizar(crudo)
    if (limpio && !candidatos.includes(limpio)) candidatos.push(limpio)
  }
  return candidatos
}

/** Clave estable de identidad, para deduplicar apps activas contra apps en silencio. */
export function claveApp(props: PropsAudio): string {
  return candidatosApp(props)[0] ?? ""
}

/**
 * Nombre presentable cuando NO hay `.desktop` que consultar. Un binario suelto
 * (`spotify`, `mpv`) se capitaliza; un nombre que ya trae mayúsculas o espacios se
 * respeta tal cual, que es lo que la app quería enseñar.
 */
export function nombreCrudoApp(props: PropsAudio): string {
  const p = props || {}
  const candidato = limpiarNombreApp(p["application.name"])
    || limpiarNombreApp(p["node.name"])
    || String(p["application.process.binary"] ?? "").trim()
  if (!candidato) return "App"
  if (/^[a-z0-9._-]+$/.test(candidato)) {
    const base = candidato.replace(/[._-]+/g, " ").trim()
    return base.charAt(0).toUpperCase() + base.slice(1)
  }
  return candidato
}

/**
 * ¿Es infraestructura de audio en vez de una app del usuario? Se casa por prefijo con
 * frontera (`wireplumber [export]`, `xdg-desktop-portal-hyprland`, `pipewire-pulse`) y
 * no por subcadena suelta: `ags` o `gjs` dentro de un `includes()` se tragarían apps
 * legítimas cuyo nombre los contenga.
 */
export function esClienteDeSistema(props: PropsAudio): boolean {
  const p = props || {}
  const señas = [p["application.process.binary"], p["application.name"], p["node.name"]]
    .map(normalizar)
    .filter(Boolean)
  if (!señas.length) return true
  return señas.some((seña) =>
    CLIENTES_SISTEMA.some((sistema) =>
      seña === sistema
      || (seña.startsWith(sistema)
        && (!/[a-z0-9]$/.test(sistema) || /[^a-z0-9]/.test(seña.charAt(sistema.length)))),
    ),
  )
}

/**
 * PID del proceso dueño del stream, si PipeWire lo publica. Es lo que casa un stream con
 * SU ventana de Hyprland sin comparar nombres — imprescindible para los juegos, cuyo
 * `application.name` no se parece a la clase de su ventana (`steam_app_2050650`).
 */
export function pidDeProps(props: PropsAudio): number | null {
  const crudo = (props || {})["application.process.id"]
  const pid = typeof crudo === "number" ? crudo : parseInt(String(crudo ?? ""), 10)
  return Number.isFinite(pid) && pid > 0 ? pid : null
}

/** Solo letras y dígitos en minúscula: `Rocket League` y `RocketLeague` son lo mismo. */
export function normalizarNombreJuego(valor: string | null | undefined): string {
  return String(valor ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "")
}

/** Longitud mínima del nombre para arriesgarse a casar por texto. */
const MINIMO_NOMBRE_JUEGO = 4

/**
 * ¿El nombre con el que se anuncia este stream designa a la ventana de juego que tiene
 * estas señas (su título, el nombre de su `.desktop`)? Es el último recurso cuando el PID
 * no casa, y hace falta: un juego de Steam se anuncia como **`Rocket League`** mientras su
 * ventana tiene la clase `steam_app_252950` y el título `Rocket League (64-bit, DX11,
 * Cooked)` — no hay un solo identificador compartido, solo el nombre dentro del título.
 *
 * Se compara por prefijo en los dos sentidos (el título añade decoración; el nombre del
 * stream puede venir recortado) y con un mínimo de caracteres, porque aquí un falso
 * positivo es ponerle a un stream cualquiera el icono de un juego que no es.
 */
export function nombreCasaConJuego(
  nombre: string | null | undefined,
  senas: Array<string | null | undefined>,
): boolean {
  const n = normalizarNombreJuego(nombre)
  if (n.length < MINIMO_NOMBRE_JUEGO) return false
  return senas.some((sena) => {
    const s = normalizarNombreJuego(sena)
    if (s.length < MINIMO_NOMBRE_JUEGO) return false
    return s.startsWith(n) || n.startsWith(s)
  })
}
