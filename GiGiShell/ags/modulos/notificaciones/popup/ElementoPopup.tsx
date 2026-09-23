import { Gtk } from "ags/gtk4"
import { execAsync } from "ags/process"
import GLib from "gi://GLib"
import {
  getAppIcon,
  openNotifPanel,
  resolveNotifColor,
  type StoredNotification,
} from "../store"
import { invocarAccionViva } from "../panel/item/acciones"
import { aMarcadoPango, limpiarMarcado } from "../marcado"
import { resolverAccionesPopup } from "./logica.ts"

const DURACION_ANIMACION_SALIDA_MS = 220

// El popup no puede crecer a lo ancho: la ventana pide 360 px pero nada se lo impone,
// así que una etiqueta larga (`-A reparar=Reparar el volumen ahora`) ensancharía la
// superficie entera y descolocaría la pila. Se recorta la etiqueta, no el popup.
const MAXIMO_CARACTERES_BOTON = 14

interface PropiedadesElementoPopup {
  notificacion: StoredNotification
  alDescartar: () => void
  registrarDescarte: (callback: () => void) => void
}

function enfocarVentanaAplicacion(nombreAplicacion: string): void {
  const nombreNormalizado = nombreAplicacion.toLowerCase().replace(/\s+/g, "")
  // Forma Lua de `focuswindow class:… || focuswindow title:…`. El fallback ya no
  // puede colgar del código de salida: un hl.dsp.focus sin match imprime
  // «warning: … window not found» en stdout pero sale con rc 0 (verificado en
  // instancia anidada), así que se compara el stdout con el "ok" del match.
  execAsync([
    "bash", "-c",
    `[ "$(hyprctl dispatch "hl.dsp.focus({window='class:(?i)${nombreNormalizado}'})" 2>/dev/null)" = "ok" ] || \
     hyprctl dispatch "hl.dsp.focus({window='title:(?i)${nombreNormalizado}'})" >/dev/null 2>&1 || true`,
  ]).catch(() => {})
}

export default function ElementoPopup({
  notificacion,
  alDescartar,
  registrarDescarte,
}: PropiedadesElementoPopup) {
  const color = resolveNotifColor(notificacion)
  const icono = getAppIcon(notificacion.appName)

  // El aspecto dunst lo decide siempre una regla mediante `meta.style`. No se usa el
  // hint de origen como fallback: hacerlo impediría desactivar la regla desde la UI.
  const esDunst = notificacion.meta.style === "dunst"
  const claseUrgencia = notificacion.urgency >= 2
    ? "u-critical"
    : notificacion.urgency <= 0 ? "u-low" : "u-normal"

  // "default" es la activación implícita y no un botón visible. El reparto entre el
  // gesto y los botones lo decide `resolverAccionesPopup` (puro y con test); aquí solo
  // se pinta. La principal sigue siendo la primera visible y la que dispara el clic
  // derecho: ese contrato no cambia aunque ahora también se pinten botones.
  const { principal: accionPrincipal, botones, mostrarPista } = resolverAccionesPopup(notificacion)
  const hayBotones = botones.length > 0

  function invocarYDescartar(idAccion: string): void {
    // Invocar SIEMPRE antes de descartar: `dismiss()` cierra la notificación en el
    // daemon y a partir de ahí `get_notification(id)` ya no la encuentra.
    invocarAccionViva(notificacion.id, idAccion)
    descartar()
  }

  const filaAcciones = (
    <box cssClasses={["notif-popup-actions"]} spacing={4} halign={Gtk.Align.START} visible={hayBotones}>
      {botones.map((accion, indice) => (
        <button
          cssClasses={indice === 0
            ? ["notif-popup-btn", "principal"]
            : ["notif-popup-btn"]}
          tooltipText={indice === 0 ? "También con clic derecho" : accion.label}
          onClicked={() => invocarYDescartar(accion.id)}
        >
          <label
            label={indice === 0 ? `▸ ${accion.label}` : accion.label}
            ellipsize={3}
            maxWidthChars={MAXIMO_CARACTERES_BOTON}
          />
        </button>
      ))}
    </box>
  ) as Gtk.Box

  const caja = (
    <box
      cssClasses={esDunst ? ["notif-popup-item", "dunst", claseUrgencia] : ["notif-popup-item"]}
      css={esDunst ? "" : `border-left: 3px solid ${color};`}
      orientation={Gtk.Orientation.VERTICAL}
      spacing={6}
    >
      <box spacing={5} valign={Gtk.Align.CENTER} visible={!esDunst || !!notificacion.summary}>
        <label
          cssClasses={["notif-popup-app-icon"]}
          label={icono}
          css={esDunst ? "" : `color: ${color};`}
          visible={!esDunst}
        />
        {/* El nombre de app cede el ancho ANTES que el título: ver el comentario de
            `notif-popup-summary`, justo debajo. 12 caracteres a 10 px son ~72 px. */}
        <label
          cssClasses={["notif-popup-app-name"]}
          label={notificacion.appName}
          halign={Gtk.Align.START}
          ellipsize={3}
          maxWidthChars={12}
          visible={!esDunst && !!notificacion.appName}
        />
        <label
          cssClasses={["notif-popup-dot"]}
          label="·"
          visible={!esDunst && !!notificacion.appName && !!notificacion.summary}
        />
        {/* 50 caracteres = los 336 px útiles del popup a 11 px de MesloLGS, que es
            monoespaciada (336 / 6,6 ≈ 50). Con 28 el título se cortaba SIEMPRE ahí,
            hubiera sitio o no, porque `maxWidthChars` tapa el ancho natural de la
            etiqueta y GTK nunca le ofrecía más. Que ahora pida los 50 no ensancha
            nada: la fila ya está limitada por el `min-width` de la tarjeta, y cuando
            no llega, `gtk_distribute_natural_allocation` reparte el déficit
            atendiendo primero al hueco MÁS PEQUEÑO — o sea al nombre de app, con sus
            12 caracteres tope— y le entrega al título todo lo que sobre. La elipsis
            vuelve a ocurrir solo cuando el texto de verdad no cabe. */}
        <label
          cssClasses={["notif-popup-summary"]}
          label={limpiarMarcado(notificacion.summary)}
          hexpand
          halign={Gtk.Align.START}
          ellipsize={3}
          maxWidthChars={50}
          visible={!!notificacion.summary}
        />
      </box>
      <label
        cssClasses={["notif-popup-body"]}
        label={aMarcadoPango(notificacion.body)}
        useMarkup={true}
        halign={Gtk.Align.START}
        xalign={0}
        wrap={true}
        ellipsize={3}
        lines={4}
        maxWidthChars={48}
        visible={!!notificacion.body}
      />
      {filaAcciones}
      <label
        cssClasses={["notif-popup-action-hint"]}
        label={accionPrincipal ? `▸ clic derecho · ${accionPrincipal.label}` : ""}
        halign={Gtk.Align.START}
        xalign={0}
        visible={mostrarPista}
      />
    </box>
  ) as Gtk.Box

  function descartar(): void {
    caja.add_css_class("leaving")
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, DURACION_ANIMACION_SALIDA_MS, () => {
      alDescartar()
      return GLib.SOURCE_REMOVE
    })
  }

  registrarDescarte(descartar)

  const clicAbrir = new Gtk.GestureClick({ button: 1 })
  clicAbrir.connect("pressed", () => {
    descartar()
    openNotifPanel()
  })
  caja.add_controller(clicAbrir)

  const clicDescartar = new Gtk.GestureClick({ button: 2 })
  clicDescartar.connect("pressed", () => descartar())
  caja.add_controller(clicDescartar)

  // Se invoca antes de descartar porque, una vez cerrada en el daemon, ya no puede
  // recuperarse por id. Sin acción se conserva el gesto de enfocar la aplicación.
  const clicDerecho = new Gtk.GestureClick({ button: 3 })
  clicDerecho.connect("pressed", () => {
    if (accionPrincipal) invocarYDescartar(accionPrincipal.id)
    else {
      enfocarVentanaAplicacion(notificacion.appName)
      descartar()
    }
  })
  caja.add_controller(clicDerecho)

  // ── Por qué un botón dentro de la caja no abre además el panel ───────────────
  // Los tres gestos de arriba cuelgan de la CAJA y están en fase BUBBLE (la de
  // `add_controller` por defecto), o sea que corren DESPUÉS del widget golpeado.
  // `GtkButton` reclama la secuencia en su propio `pressed`
  // (`gtk_gesture_set_state(CLAIMED)`), y reclamar corta la propagación: el clic
  // izquierdo sobre un botón de acción no llega nunca al gesto de "abrir panel".
  // Poner los gestos de la caja en CAPTURE sería justo lo contrario y dejaría los
  // botones muertos, así que la fase por defecto es la correcta y no se toca.
  //
  // Lo que ESO no cubre, y es el fallo silencioso que quedaba: (a) el clic sobre el
  // padding y el espaciado de la fila —que no es ningún botón, así que burbujea— y
  // (b) el clic central/derecho sobre un botón, porque el gesto interno de
  // `GtkButton` es solo del botón primario y no reclama nada. En los dos casos el
  // clic acabaría abriendo el panel o disparando la acción principal desde una zona
  // que visualmente pertenece a las secundarias. La fila hace de barrera: reclama
  // cualquier botón del ratón que llegue hasta ella y así corta la propagación hacia
  // la caja. Va también en BUBBLE a propósito: en CAPTURE se adelantaría a los
  // botones y se los comería.
  const barreraAcciones = new Gtk.GestureClick({ button: 0 })
  barreraAcciones.connect("pressed", () => {
    barreraAcciones.set_state(Gtk.EventSequenceState.CLAIMED)
  })
  filaAcciones.add_controller(barreraAcciones)

  return caja
}
