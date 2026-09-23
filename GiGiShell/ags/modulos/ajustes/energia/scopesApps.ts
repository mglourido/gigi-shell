// modulos/ajustes/energia/scopesApps.ts
//
// Lo PURO del allowlist de «apps que se congelan» de la suspensión falsa: leer la salida de
// `systemctl --user list-units --type=scope` y decidir qué nombres no se pueden meter en la
// lista. Sin un solo import, para que `node --test` pueda cubrirlo (ver
// `scopesApps.test.ts`); quien lanza el subproceso es `AppsCongeladas.tsx`.
//
// ── Por qué los candidatos salen de systemd y no de las ventanas de Hyprland ───────────
// Lo que se congela es un CGROUP (`systemctl --user freeze <unidad>`), no una ventana ni un
// pid: es la única primitiva que para el árbol entero de forma atómica y lo descongela
// limpio. Una app lanzada desde una terminal no tiene scope propio y no se puede congelar
// por este camino aunque su ventana esté ahí delante — ofrecer su clase de ventana habría
// dejado en la lista una entrada que nunca hace nada, sin un solo error.
//
// ── EL PID VA EN EL NOMBRE DE LA UNIDAD, Y POR ESO NO SE GUARDA LA UNIDAD ──────────────
// Los scopes se llaman `app-discord-17743.scope` / `app-org.chromium.Chromium-4948.scope`:
// el número es el pid del proceso que lo abrió y cambia en cada arranque de la app.
// Guardar la unidad entera sería guardar una lista que caduca al cerrar la app. Se guarda
// el NOMBRE (`discord`, `org.chromium.Chromium`) y el scope se resuelve en el momento de
// congelar. De ahí que enumerar sea solo SUGERIR: lo guardado no depende de que la app esté
// abierta ahora.
//
// ── El desescapado no es cosmético ────────────────────────────────────────────────────
// systemd escapa lo que no cabe en un nombre de unidad, y lo primero de la lista es el
// propio guion (`\x2d`) — justo el separador con el que aquí se recorta el pid. Sin
// desescapar, una app con guion en el nombre se guardaría con la secuencia cruda y no
// casaría nunca con su scope al ir a congelarla.

/** `app-<nombre>-<pid>.scope`. El nombre es PEREZOSO para que gane el `-<pid>` final: con
 *  `(.+)` codicioso, `app-org.chromium.Chromium-4948.scope` se partía bien de casualidad,
 *  pero un nombre con más de un guion ya no. */
const SCOPE_DE_APP = /^app-(.+?)-(\d+)\.scope$/

/** Deshace el escapado de systemd (`\x2d` → `-`, `\x5f` → `_`…). */
export function desescaparUnidad(nombre: string): string {
  return nombre.replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) =>
    String.fromCharCode(Number.parseInt(hex, 16)))
}

/** Nombre de app de un nombre de unidad, o null si esa unidad no es un scope de app. */
export function nombreDeScope(unidad: string): string | null {
  const casa = SCOPE_DE_APP.exec(unidad.trim())
  if (!casa) return null
  const nombre = desescaparUnidad(casa[1]).trim()
  return nombre || null
}

/**
 * Nombres de app con scope vivo a partir de la salida cruda de
 * `systemctl --user list-units --type=scope --no-legend --plain`.
 *
 * Se deduplica y se ordena: una misma app puede tener varios scopes a la vez (dos ventanas,
 * un navegador con dos perfiles) y lo que se guarda —y lo que se congelaría— es el nombre,
 * así que enseñarlo dos veces solo confundiría. Solo se mira la PRIMERA columna: el resto
 * de la línea es la descripción, que systemd traduce.
 */
export function nombresDeScopes(salida: string): string[] {
  const nombres = new Set<string>()
  for (const linea of salida.split("\n")) {
    const unidad = linea.trim().split(/\s+/)[0] ?? ""
    const nombre = nombreDeScope(unidad)
    if (nombre) nombres.add(nombre)
  }
  return [...nombres].sort((a, b) => a.localeCompare(b))
}

/**
 * Lo que NO se puede congelar nunca, porque congelarlo cuelga el escritorio entero y el
 * síntoma no se parece en nada a la causa: el propio shell, el compositor, el servidor de
 * sonido y la red. Un `xdg-desktop-portal` o un `dconf` congelados dejan clavada a la
 * primera app que pida un portal o lea un ajuste, y no hay ni un error en ningún log.
 *
 * La comparación es por nombre EXACTO (en minúsculas), nunca por subcadena: el mismo
 * tropiezo ya documentado en `servicios/juegos/deteccion.ts` (`includes("ags")` se llevaba
 * por delante apps legítimas). Es una red de seguridad contra un descuido, no una
 * verificación: nada impide escribir el nombre de otro proceso crítico, y por eso la ayuda
 * de la UI sigue diciendo qué no meter.
 */
export const APPS_PROHIBIDAS: readonly string[] = [
  "ags", "gjs", "hyprland", "hyprpaper", "hypridle", "hyprlock",
  "pipewire", "pipewire-pulse", "wireplumber",
  "networkmanager", "nm-applet", "dbus", "dbus-daemon", "dconf",
  "systemd", "xdg-desktop-portal", "xdg-desktop-portal-gtk", "xdg-desktop-portal-hyprland",
  "polkit-gnome-authentication-agent-1",
]

/** ¿Es un nombre que nunca debe entrar en el allowlist? */
export function esAppProhibida(nombre: string): boolean {
  const limpio = nombre.trim().toLowerCase()
  if (!limpio) return true
  // También se compara el último tramo de un id con puntos (`org.freedesktop.dbus` → `dbus`):
  // las apps de estilo Flatpak/D-Bus llegan con el id completo y la lista está escrita en
  // nombres cortos.
  const cola = limpio.split(".").pop() ?? limpio
  return APPS_PROHIBIDAS.includes(limpio) || APPS_PROHIBIDAS.includes(cola)
}

// ── El otro consumidor: el EFECTOR que congela de verdad ──────────────────────────────
// `servicios/energia/suspensionFalsa/congelarApps.ts` tiene que resolver nombre → scope
// EXACTAMENTE igual que la UI, porque la UI guarda el nombre y el efector busca el scope. Si
// las dos resoluciones divergen, la app que el usuario metió en la lista simplemente no se
// congela y no hay error en ninguna parte: el fallo es mudo por construcción. De ahí que la
// resolución viva aquí, junto al parseo que ya existía, y no duplicada allí.

/** Una unidad de scope viva y el nombre de app que le corresponde. */
export interface ScopeVivo {
  /** El nombre de unidad COMPLETO, con su pid: es lo que come `systemctl freeze/thaw`. */
  unidad: string
  /** El nombre de app, ya desescapado y sin pid: es lo que guarda el allowlist. */
  nombre: string
}

/** Los scopes de app vivos, de la salida cruda de `systemctl --user list-units`. A
 *  diferencia de `nombresDeScopes`, NO deduplica por nombre: una app con dos scopes (dos
 *  ventanas, dos perfiles del navegador) hay que congelarlos los dos, y quedarse con uno
 *  dejaría media app viva —con su red y sus timers— sin que se note. */
export function scopesVivos(salida: string): ScopeVivo[] {
  const vivos: ScopeVivo[] = []
  for (const linea of salida.split("\n")) {
    const unidad = linea.trim().split(/\s+/)[0] ?? ""
    const nombre = nombreDeScope(unidad)
    if (nombre) vivos.push({ unidad, nombre })
  }
  return vivos
}

/** ¿El nombre guardado en el allowlist designa a esta app? Exacto, o por el último tramo de
 *  un id con puntos (`org.chromium.Chromium` ↔ `chromium`), que es la única flexibilidad que
 *  se permite: un allowlist editado a mano puede llevar el nombre corto. Nunca por
 *  subcadena — con `includes()`, `st` (el terminal) casaría dentro de `counter-strike`. */
export function nombreCasaConScope(guardado: string, nombreScope: string): boolean {
  const a = guardado.trim().toLowerCase()
  const b = nombreScope.trim().toLowerCase()
  if (!a || !b) return false
  if (a === b) return true
  const colaA = a.split(".").pop() ?? a
  const colaB = b.split(".").pop() ?? b
  return colaA === colaB
}

/**
 * Las UNIDADES que hay que congelar: los scopes vivos cuyo nombre esté en el allowlist y no
 * sea de los prohibidos.
 *
 * El filtro de `esAppProhibida` se aplica AQUÍ y no solo en la UI a propósito. La lista vive
 * en un JSON que se puede editar a mano, puede venir de una instalación anterior a que la
 * lista negra existiera, y la comprobación de la UI es un aviso al escribir, no una garantía
 * sobre lo que hay guardado. Congelar el compositor o el servidor de sonido cuelga la sesión
 * entera, así que la red va donde se ejecuta la acción.
 */
export function scopesACongelar(salida: string, allowlist: readonly string[]): string[] {
  const unidades = new Set<string>()
  for (const { unidad, nombre } of scopesVivos(salida)) {
    if (esAppProhibida(nombre)) continue
    if (allowlist.some((guardado) => nombreCasaConScope(guardado, nombre))) unidades.add(unidad)
  }
  return [...unidades]
}
