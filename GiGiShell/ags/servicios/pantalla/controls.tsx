// Select integrado compartido por QuickSettings y Ajustes. La lista vive en un
// Gtk.Overlay del propio control: flota sin alterar el layout y, a diferencia de
// Gtk.DropDown/Gtk.Popover, no crea otra superficie que robe el foco del panel.
import { Gtk } from "ags/gtk4"
import { createState, For } from "ags"
import Graphene from "gi://Graphene"
import GLib from "gi://GLib"

let closeActiveSelect: (() => void) | null = null

// Suelo del desplegable: por debajo de esto no cabe ni una opción y más vale que se
// salga un poco del host a que quede una franja ilegible.
const ALTO_MINIMO_LISTA = 96

export function DisplaySelect({ current, options, onSelect, compact = true }: {
  current: any, options: any, onSelect: (value: string) => void, compact?: boolean,
}) {
  const [open, setOpen] = createState(false)

  // `compact` es la talla de Quick Settings (26 px de alto, 11 px de texto). En
  // Ajustes el control convive con entradas y botones de 30 px dentro de filas de
  // 45, así que la talla normal es la que cuadra; ver `.qs-display-select` en el
  // SCSS. Todo lo que se dimensiona con la talla va por esta variable y por la
  // clase "compact" que se propaga también a la LISTA y a sus opciones: antes solo
  // la llevaban el envoltorio y el botón, así que un select grande desplegaba una
  // lista con la tipografía y el interlineado de la pequeña.
  const clase = (base: string) => compact ? [base, "compact"] : [base]
  // Tope del texto antes de la elipsis. No puede quitarse (una etiqueta sin tope
  // pide de natural todo su texto y ensancha la fila, que es de donde salía el
  // desplazamiento horizontal de Ajustes), pero 24 caracteres cortaban a media
  // anchura en un select de 560 px — el mismo fallo que ya documenta el título del
  // popup de notificaciones.
  const maxCaracteres = compact ? 24 : 46
  const ALTO_MAXIMO = compact ? 272 : 320

  let list: Gtk.Widget
  let host: Gtk.Overlay | null = null
  let outsideClick: Gtk.GestureClick | null = null

  const belongsTo = (widget: Gtk.Widget | null, ancestor: Gtk.Widget) => {
    let current = widget
    while (current) {
      if (current === ancestor) return true
      current = current.get_parent()
    }
    return false
  }

  const close = () => {
    setOpen(false)
    if (host && outsideClick) host.remove_controller(outsideClick)
    outsideClick = null
    if (host && list.get_parent() === host) host.remove_overlay(list)
    host = null
    if (closeActiveSelect === close) closeActiveSelect = null
  }

  const findHost = (widget: Gtk.Widget): Gtk.Overlay | null => {
    let parent = widget.get_parent()
    while (parent) {
      if (parent instanceof Gtk.Overlay && parent.has_css_class("display-select-host")) return parent
      parent = parent.get_parent()
    }
    return null
  }

  const trigger = (
    <button
      hexpand
      heightRequest={compact ? 26 : -1}
      cssClasses={open((value) => value
        ? [...clase("qs-display-select"), "open"]
        : clase("qs-display-select"))}
      $={(self: Gtk.Button) => self.connect("destroy", close)}
      onClicked={(self: Gtk.Button) => {
        if (open.get()) return close()
        closeActiveSelect?.()
        host = findHost(self)
        if (!host) return
        const [, point] = self.compute_point(host, new Graphene.Point({ x: 0, y: 0 }))
        const anchoBoton = self.get_width()
        const altoBoton = self.get_height()
        const yBoton = Math.round(point.y)

        // La lista se recorta al alto del HOST: como es un overlay con `valign START`,
        // lo que le queda son `alto del host − margin_top` píxeles. Desplegar siempre
        // hacia abajo dejaba el select del final de una sección con dos opciones
        // visibles. Se mide el hueco a cada lado, se despliega hacia donde haya más y
        // se acota `maxContentHeight` a ese hueco: así la lista SIEMPRE cabe entera
        // donde se pinta, y si no llega, hace scroll dentro en vez de quedar cortada.
        const huecoAbajo = Math.max(0, host.get_height() - (yBoton + altoBoton + 3))
        const huecoArriba = Math.max(0, yBoton - 3)
        const haciaArriba = huecoArriba > huecoAbajo && huecoAbajo < ALTO_MAXIMO
        const tope = Math.max(ALTO_MINIMO_LISTA, Math.min(ALTO_MAXIMO, haciaArriba ? huecoArriba : huecoAbajo))

        const desplegable = list as Gtk.ScrolledWindow
        desplegable.set_max_content_height(tope)
        list.set_halign(Gtk.Align.START)
        list.set_valign(Gtk.Align.START)
        list.set_margin_start(Math.round(point.x))
        list.set_size_request(anchoBoton, -1)
        list.set_vexpand(false)
        // `measure` sobre el widget aún sin padre: hace falta el alto REAL (que con
        // pocas opciones es menor que el tope) para que, desplegando hacia arriba, la
        // lista termine pegada al botón y no flotando por encima. Si devolviera 0 —no
        // debería, pero es una medida sin realizar— se cae al tope, que es el peor caso
        // pintable y nunca deja la lista fuera del host.
        const [, natural] = list.measure(Gtk.Orientation.VERTICAL, anchoBoton)
        const alto = natural > 0 ? Math.min(natural, tope) : tope
        list.set_margin_top(haciaArriba ? Math.max(0, yBoton - 3 - alto) : yBoton + altoBoton + 3)
        host.add_overlay(list)
        host.set_clip_overlay(list, false)
        host.set_measure_overlay(list, false)
        outsideClick = new Gtk.GestureClick()
        outsideClick.set_propagation_phase(Gtk.PropagationPhase.CAPTURE)
        outsideClick.connect("pressed", (gesture, _press, x, y) => {
          // Este controlador solo observa el clic. Al denegar su propia
          // secuencia, el widget pulsado puede procesar la misma pulsación.
          gesture.set_state(Gtk.EventSequenceState.DENIED)
          if (!host) return
          const picked = host.pick(x, y, Gtk.PickFlags.DEFAULT)
          if (!belongsTo(picked, self) && !belongsTo(picked, list)) {
            // No retires el controlador durante la fase de captura: hacerlo
            // cancela la secuencia antes de que alcance al botón pulsado.
            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
              close()
              return GLib.SOURCE_REMOVE
            })
          }
        })
        host.add_controller(outsideClick)
        closeActiveSelect = close
        setOpen(true)
      }}
    >
      <box spacing={6} hexpand valign={Gtk.Align.CENTER}>
        <label
          label={current}
          hexpand
          halign={Gtk.Align.START}
          ellipsize={3}
          maxWidthChars={maxCaracteres}
          cssClasses={["qs-display-select-value"]}
        />
        <label label={open((value) => value ? "󰅃" : "󰅀")} cssClasses={["qs-display-select-chevron"]} />
      </box>
    </button>
  ) as unknown as Gtk.Widget

  list = (
    <Gtk.ScrolledWindow
      visible={open}
      hscrollbarPolicy={Gtk.PolicyType.NEVER}
      vscrollbarPolicy={Gtk.PolicyType.AUTOMATIC}
      propagateNaturalHeight
      maxContentHeight={ALTO_MAXIMO}
      vexpand={false}
      cssClasses={clase("qs-display-select-list")}
      $={(self: Gtk.ScrolledWindow) => self.set_overflow(Gtk.Overflow.HIDDEN)}
    >
      <box orientation={Gtk.Orientation.VERTICAL} spacing={1} cssClasses={clase("qs-display-select-options")}
        $={(self: Gtk.Box) => self.set_overflow(Gtk.Overflow.HIDDEN)}>
        <For each={options}>
          {(opt: any) => (
            <button
              cssClasses={opt.active
                ? [...clase("qs-display-select-opt"), "active"]
                : clase("qs-display-select-opt")}
              onClicked={() => {
                onSelect(opt.value)
                close()
              }}
            >
              <label label={opt.label} halign={Gtk.Align.START} hexpand ellipsize={3} maxWidthChars={maxCaracteres} />
            </button>
          )}
        </For>
      </box>
    </Gtk.ScrolledWindow>
  ) as unknown as Gtk.Widget

  return <box cssClasses={clase("qs-display-select-wrap")}>{trigger}</box>
}
