// Caché compartida de `Gio.AppInfo.get_all()` — la lista cruda de `.desktop`
// instalados. Antes había hasta CUATRO escaneos independientes del mismo
// catálogo (el buscador en `search/handlers/apps.ts`, la rejilla de
// `AppsSection.tsx`, los iconos de favoritos en `favoritosFlow.tsx` y el
// auto-sanado de `appResolver.ts` — este último sin cachear siquiera, así que
// repetía el escaneo completo en cada favorito que necesitaba resolverse),
// cada uno parseando los mismos ~161 ficheros por separado en la misma
// sesión. Se invalida junto con el resto del catálogo (ver `catalogo.ts`),
// que es lo que hace que una app recién instalada o desinstalada se refleje
// sin reiniciar el shell.
//
// Quien avisa de la instalación es el `Gio.AppInfoMonitor` de aquí abajo. Sin
// él, la única invalidación del catálogo salía de desinstalar desde el panel
// derecho de Orion (`RightPanel.tsx`), o sea del único cambio que Orion
// provoca él mismo: una app instalada por fuera (pacman, un AppImage, un
// Flatpak, `~/.local/share/applications/`) no aparecía ni en la rejilla ni en
// la búsqueda hasta reiniciar el shell, sin dar ningún error — desde fuera se
// veía como «Orion no encuentra la app que acabo de instalar».

import Gio from "gi://Gio"
import GLib from "gi://GLib"
import { registrarInvalidadorCatalogo, invalidarCatalogoApps } from "./catalogo"

let _cache: Gio.AppInfo[] | null = null

export function getAppInfos(): Gio.AppInfo[] {
  if (!_cache) {
    _cache = (Gio.AppInfo.get_all() as Gio.AppInfo[]).filter(a => a.should_show())
    armarVigilancia()
  }
  return _cache
}

registrarInvalidadorCatalogo(() => { _cache = null })

// ── Vigilancia del catálogo instalado ────────────────────────────────────────
// El monitor se arma DESPUÉS del primer `Gio.AppInfo.get_all()` y eso no es
// casualidad: GLib no vigila los directorios de `.desktop` hasta que alguien
// los ha escaneado una vez, así que un `Gio.AppInfoMonitor.get()` creado antes
// **no emite nunca** — medido en esta máquina con un gjs suelto: 0 señales
// instalando, modificando y borrando un `.desktop`; las mismas tres operaciones
// dan 5 señales si el `get_all()` va primero. Y no falla: se conecta bien, no
// da ningún error, simplemente no llega nada.
//
// La referencia vive en el módulo por el mismo motivo mudo: un
// `Gio.AppInfoMonitor.get()` sin guardar se lo lleva el GC y la señal deja de
// llegar sin avisar.
const REBOTE_MS = 600

let monitor: Gio.AppInfoMonitor | null = null
let rebote: number | null = null

function armarVigilancia(): void {
  if (monitor) return
  monitor = Gio.AppInfoMonitor.get()
  monitor.connect("changed", alCambiarElCatalogo)
}

function alCambiarElCatalogo(): void {
  // Una instalación toca varios ficheros, así que la señal llega en ráfaga (en
  // la prueba, dos por cada escritura): sin rebote se repintaría la rejilla una
  // vez por aviso. Se reinicia el temporizador en cada uno para invalidar una
  // sola vez, cuando la ráfaga ya ha parado.
  if (rebote !== null) GLib.source_remove(rebote)
  rebote = GLib.timeout_add(GLib.PRIORITY_DEFAULT_IDLE, REBOTE_MS, () => {
    rebote = null
    invalidarCatalogoApps()
    // Rehacer el escaneo aquí es deliberado, aunque los consumidores lo harían
    // solos: son perezosos (la rejilla no relee si su sección nunca se abrió) y
    // el escaneo es justo lo que mantiene viva la vigilancia de directorios de
    // GLib. Cuesta una pasada, y solo cuando el catálogo ha cambiado de verdad.
    getAppInfos()
    return GLib.SOURCE_REMOVE
  })
}
