// servicios/energia/opacidadAhorro.ts
//
// Quitar la transparencia de las láminas del shell mientras dura el modo ahorro.
//
// QUÉ SE AHORRA (no es lo que parece)
// -----------------------------------
// No es GTK: pintar un fondo sólido o uno con alfa le cuesta lo mismo. Es HYPRLAND.
// Las cinco láminas grandes del shell llevan `blur = true` en `hypr/gigios/reglas.lua`
// (quick-settings, notification-panel, calendar-panel, orion, osd), así que mientras
// una esté en pantalla el compositor desenfoca por fotograma el trozo de escritorio
// que se ve por debajo. Con la lámina opaca, GTK marca esa región del `wl_surface`
// como opaca y el compositor se salta tanto el desenfoque como el pintado de lo que
// hay detrás. `ignore_alpha = 0.1` de esas reglas NO cubría este caso: descarta los
// píxeles casi transparentes, y una lámina al 94 % está muy por encima del umbral.
//
// Es la única medida del modo ahorro que ahorra mientras el usuario MIRA algo; las
// demás recortan trabajo de reposo (sondeos, animaciones, mantenimiento).
//
// CÓMO SE APLICA SIN RECOMPILAR NADA
// ----------------------------------
// Desde que las láminas se escriben con `lamina()` (ver `estilos/_colores.scss`), el
// tema compila a `var(--lamina-…, <color translúcido de siempre>)`. Aquí solo hace
// falta definir esas variables: una hoja de una línea en un CssProvider propio, y GTK
// repinta el shell entero. Apagarlo es vaciar esa misma hoja: cada `var()` cae en su
// reserva y vuelve la transparencia de siempre. Nadie tiene que enumerar qué ventanas
// tienen lámina, que es justo lo que se pudriría al añadir la siguiente.
//
// ⚠️ NO SE USA `app.apply_css()`, por lo mismo que documenta `fondos/acento.ts`: crea
// un provider NUEVO en cada llamada y los apila, así que una sesión que entre y salga
// del ahorro varias veces iría acumulando providers muertos; y su modo `reset` retira
// TODOS los providers de la app, incluido el de `out.css`, o sea que dejaría el shell
// sin tema. Un provider nuestro recargado con `load_from_string()` no tiene ninguno de
// los dos problemas.
//
// PRIORIDAD: comparte `STYLE_PROVIDER_PRIORITY_USER` con el provider del acento. No
// compiten: aquel define `--acento*` y este `--lamina-*`, conjuntos disjuntos.

import Gdk from "gi://Gdk"
import { Gtk } from "ags/gtk4"
import { transparenciaSuspendida } from "./powerState"
import { hojaOpaca } from "./opacidadCss"

let arrancado = false
let provider: Gtk.CssProvider | null = null

function pintar(activo: boolean) {
  if (provider === null) return
  provider.load_from_string(hojaOpaca(activo))
}

/**
 * Arranca la opacidad de ahorro. Idempotente.
 *
 * Va a t=0 y NO con los `init*` apartados a los 4 s: no es un vigilante ni lanza nada
 * —es un CssProvider y una suscripción, coste nulo— y sí SE VE. Si el shell arranca
 * con el ahorro ya activo (batería baja, o "forzar modo ahorro" guardado), apartarlo
 * cuatro segundos significaría cuatro segundos de paneles transparentes que luego
 * cambian solos a la vista del usuario.
 */
export function initOpacidadAhorro() {
  if (arrancado) return
  arrancado = true

  const display = Gdk.Display.get_default()
  if (display === null) return   // sin display no hay shell al que quitarle el alfa

  provider = new Gtk.CssProvider()
  provider.connect("parsing-error", (_p, _s, error) => {
    console.error("[opacidad-ahorro] CSS inválido:", error.message)
  })
  Gtk.StyleContext.add_provider_for_display(display, provider, Gtk.STYLE_PROVIDER_PRIORITY_USER)

  transparenciaSuspendida.subscribe(() => pintar(transparenciaSuspendida.get()))
  pintar(transparenciaSuspendida.get())
}
