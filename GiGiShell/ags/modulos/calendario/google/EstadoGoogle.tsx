import { Gtk } from "ags/gtk4"
import Gio from "gi://Gio"
import GLib from "gi://GLib"
import { onCleanup } from "ags"
import { abrirEnTerminal } from "../../../utilidades/abrirTerminal"
import { RUTA_CREDENCIALES, hayCuentaConfigurada } from "./autenticacion.ts"
import { establecerEstadoSync, estadoSync, sincronizar, textoEstado } from "./sincronizacion.ts"

/**
 * El consentimiento OAuth es interactivo (pide el client id, el secreto y abre el navegador), así
 * que no puede correr dentro del shell: se lanza en una terminal de verdad, igual que preparar la
 * hibernación desde Ajustes. La ruta va por `~/.config/ags`, que es el symlink al repositorio.
 */
const RUTA_AUTH = `${GLib.get_user_config_dir()}/ags/scripts/google-calendar-auth.sh`

/**
 * Antirrebote del doble clic, y NADA MÁS. Un `GtkButton` emite dos `clicked` en un doble clic, y
 * dos consentimientos a la vez son dos servidores de loopback y dos pestañas del navegador donde
 * el último en terminar pisa las credenciales del otro.
 *
 * **La guarda NO puede durar lo que dure la terminal, que es lo que hacía antes.**
 * `abrirEnTerminal` abre con `kitty --hold`, así que su promesa no se resuelve cuando el script
 * termina sino cuando el usuario CIERRA la ventana — y `--hold` existe precisamente para dejarla
 * abierta cuando algo falla, que es cuando el usuario la abandona en otro escritorio y no vuelve.
 * Atada a eso, un consentimiento fallido dejaba el botón mudo para el resto de la sesión: el
 * síntoma exacto de «después de fallar el login, el botón ya no vuelve a ir». Medido: la terminal
 * seguía viva y la guarda en `true` con el script terminado hacía rato.
 */
const REBOTE_MS = 2000
let ultimoLanzamiento = 0

function conectarCuenta() {
  const ahora = GLib.get_monotonic_time() / 1000
  if (ahora - ultimoLanzamiento < REBOTE_MS) return
  ultimoLanzamiento = ahora
  abrirEnTerminal(RUTA_AUTH, "google-calendar")
    .catch(() => {})
    .finally(() => {
      // Cerrar la terminal no significa que la cuenta quedara conectada (se pudo cancelar), así que
      // el estado se decide releyendo el fichero. Es solo la RED: de un consentimiento que sale
      // bien ya avisa el vigilante de abajo, sin esperar a que se cierre nada.
      if (hayCuentaConfigurada()) void sincronizar({ manual: true })
      else establecerEstadoSync({ fase: "sin-configurar" })
    })
}

/**
 * El chip se entera de que hay cuenta EN CUANTO el script escribe las credenciales, no cuando se
 * cierra la terminal. Sin esto, con `kitty --hold` un consentimiento que va bien dejaba el panel
 * diciendo «no conectado» hasta que al usuario le diera por cerrar una ventana que ya no dice nada
 * útil — el reverso del mismo fallo que documenta `conectarCuenta`.
 *
 * Vive a nivel de módulo, y no dentro del widget, por lo mismo que el disparo de `sincronizacion.ts`:
 * `EstadoGoogle` se construye una vez por monitor y aquí habría tres vigilantes del mismo fichero.
 */
const vigilanteCredenciales = Gio.File.new_for_path(RUTA_CREDENCIALES)
  .monitor_file(Gio.FileMonitorFlags.NONE, null)
vigilanteCredenciales.connect("changed", (_m, _f, _o, tipo) => {
  // CHANGES_DONE_HINT y no CHANGED: el script escribe con python y luego hace `chmod`, así que
  // reaccionar a cada evento intermedio leería un JSON a medio escribir.
  if (tipo !== Gio.FileMonitorEvent.CHANGES_DONE_HINT && tipo !== Gio.FileMonitorEvent.CREATED) return
  if (hayCuentaConfigurada()) void sincronizar({ manual: true })
})

/**
 * Chip de estado de Google en la cabecera del panel.
 *
 * **Sin cuenta configurada no desaparece, informa.** Un panel que no menciona Google por ningún
 * lado deja al usuario sin saber que la integración existe ni cómo activarla; el chip se queda, y
 * pulsarlo es lo que conecta la cuenta.
 *
 * **El disparo al abrir el panel ya no está aquí**, aunque siga ocurriendo: vive en
 * `sincronizacion.ts`, a nivel de módulo. Este widget se construye una vez por monitor, así que con
 * tres pantallas la suscripción lanzaba tres sincronizaciones y tres lecturas del fichero de
 * credenciales por apertura. Aquí solo queda pintar el estado y el botón, que hace una cosa u otra
 * según haya cuenta: sin ella LANZA el consentimiento en una terminal (antes solo lo nombraba en el
 * tooltip y el clic no hacía nada, que desde fuera es un botón roto); con ella refresca, pasando
 * `manual` para saltarse el mínimo entre pasadas automáticas.
 */
export function EstadoGoogle(): Gtk.Widget {
  const etiqueta = new Gtk.Label({ label: "" })
  etiqueta.set_css_classes(["cal-google-chip"])

  const boton = new Gtk.Button()
  boton.set_css_classes(["cal-icon-btn"])
  boton.set_child(etiqueta)
  boton.connect("clicked", () => {
    if (hayCuentaConfigurada()) void sincronizar({ manual: true })
    else conectarCuenta()
  })

  function pintar() {
    const estado = estadoSync.get()
    etiqueta.set_label(
      estado.fase === "sincronizando" ? "󰑓"
        : estado.fase === "sin-configurar" ? "󰃭"
        : estado.fase === "sin-conexion" ? "󰤭"
        : estado.fase === "error" ? "󰀪"
        : "󰄬",
    )
    boton.set_tooltip_text(
      estado.fase === "sin-configurar"
        ? "Google Calendar no está conectado.\nPulsa para conectar una cuenta"
        : `${textoEstado(estado)}\nPulsa para actualizar`,
    )
    boton.set_css_classes(
      estado.fase === "error" || estado.fase === "sin-conexion"
        ? ["cal-icon-btn", "aviso"]
        : ["cal-icon-btn"],
    )
  }

  const baja = estadoSync.subscribe(pintar)
  onCleanup(() => {
    if (typeof baja === "function") baja()
  })
  pintar()

  return boton as unknown as Gtk.Widget
}
