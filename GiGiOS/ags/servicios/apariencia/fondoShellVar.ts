// servicios/apariencia/fondoShellVar.ts
//
// "Color de fondo global" (Ajustes > Personalización) elige el fondo de las
// superficies principales del shell —barra, paneles, Quick Settings, popups— y
// hasta ahora era SOLO una clase (`fondo-shell-<tema>`) en cada ventana. Los
// tooltips ("titles") y los menús emergentes (bandeja, juegos, logo Arch) NO
// viven dentro de esas ventanas: son superficies GTK aparte, así que la clase no
// les llega y se quedaban con su color fijo mientras el resto del shell cambiaba.
//
// Este módulo publica el color del tema elegido como la variable CSS `--bg-shell`
// en `:root`. Las variables CSS SE HEREDAN hacia todas las superficies del display
// —es exactamente lo que hace `servicios/fondos/acento.ts` con `--acento*`—, así
// que `background: var(--bg-shell, $bg-bar)` en `out.css` sigue la selección sin
// que nadie tenga que enumerar qué tooltip o qué popover la lleva.
//
// El tema "negro" es la AUSENCIA de la variable: la hoja queda vacía y cada
// `var(--bg-shell, …)` cae en su reserva ($bg-bar), que es el negro de siempre.
//
// En segundo plano no consume nada: un CssProvider y una suscripción a un
// `createState` (que además no notifica si el valor no cambia).

import Gdk from "gi://Gdk"
import { Gtk } from "ags/gtk4"
import { fondoShell } from "../../modulos/ajustes/preferences"

// Los hex son los de `estilos/_colores.scss` ($bg-shell-grafito / $bg-shell-gris).
// "negro" no está: es la hoja vacía (cae en $bg-bar). Un tema desconocido —
// preferences.json editado a mano— también cae ahí, que es la degradación segura.
const COLOR_POR_TEMA: Record<string, string> = {
  grafito: "rgb(24, 24, 32)",
  gris: "rgb(32, 32, 32)",
}

let provider: Gtk.CssProvider | null = null
let arrancado = false

function pintar() {
  if (provider === null) return
  const color = COLOR_POR_TEMA[fondoShell.get()]
  provider.load_from_string(color ? `:root { --bg-shell: ${color}; }` : "")
}

/**
 * Arranca la publicación de `--bg-shell`. Idempotente.
 *
 * Va a t=0 en `app.ts` (no con los `init*` de fondo del setTimeout): el fondo del
 * shell SE VE desde el primer fotograma, así que apartarlo cuatro segundos serían
 * cuatro segundos con los tooltips y menús de otro color que luego cambian solos.
 * Es un CssProvider y una suscripción, así que no compite con nada.
 */
export function initFondoShellVar() {
  if (arrancado) return
  arrancado = true

  const display = Gdk.Display.get_default()
  if (display === null) return

  provider = new Gtk.CssProvider()
  provider.connect("parsing-error", (_p, _s, error) => {
    console.error("[fondoShell] CSS inválido:", error.message)
  })
  Gtk.StyleContext.add_provider_for_display(display, provider, Gtk.STYLE_PROVIDER_PRIORITY_USER)

  fondoShell.subscribe(pintar)
  pintar()
}
