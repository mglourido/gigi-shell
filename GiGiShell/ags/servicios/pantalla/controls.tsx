// Select integrado compartido por QuickSettings y Ajustes. La lista vive en un
// Gtk.Overlay del propio control: flota sin alterar el layout y, a diferencia de
// Gtk.DropDown/Gtk.Popover, no crea otra superficie que robe el foco del panel.
import { Gtk } from "ags/gtk4"
import { createComputed, createState, For, onCleanup } from "ags"
import Graphene from "gi://Graphene"
import GLib from "gi://GLib"
import textos from "../../textos/ajustes/general.json" with { type: "json" }

let closeActiveSelect: (() => void) | null = null

// Suelo del desplegable: por debajo de esto no cabe ni una opción y más vale que se
// salga un poco del host a que quede una franja ilegible.
const ALTO_MINIMO_LISTA = 96

export function DisplaySelect({ current, options, onSelect, compact = true, buscador, anchoCaracteres }: {
  current: any, options: any, onSelect: (value: string) => void, compact?: boolean, buscador?: string,
  anchoCaracteres?: number,
}) {
  const [open, setOpen] = createState(false)
  const [consulta, establecerConsulta] = createState("")
  const filtradas = createComputed(() => {
    const texto = consulta().trim().toLocaleLowerCase()
    const lista = options() as { value: string; label: string; active?: boolean }[]
    return texto ? lista.filter((opcion) => opcion.label.toLocaleLowerCase().includes(texto)) : lista
  })

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
  const maxCaracteres = anchoCaracteres ?? (compact ? 24 : 46)
  const ALTO_MAXIMO = compact ? 272 : 320

  let list: Gtk.Widget
  let desplazable: Gtk.ScrolledWindow
  let host: Gtk.Overlay | null = null
  let outsideClick: Gtk.GestureClick | null = null
  let cierrePendiente = 0
  const ajustesObservados: [Gtk.Adjustment, number][] = []

  const belongsTo = (widget: Gtk.Widget | null, ancestor: Gtk.Widget) => {
    let current = widget
    while (current) {
      if (current === ancestor) return true
      current = current.get_parent()
    }
    return false
  }

  const close = () => {
    if (cierrePendiente) GLib.source_remove(cierrePendiente)
    cierrePendiente = 0
    for (const [ajuste, senal] of ajustesObservados) ajuste.disconnect(senal)
    ajustesObservados.length = 0
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
      onClicked={(self: Gtk.Button) => {
        if (open.get()) return close()
        closeActiveSelect?.()
        host = findHost(self)
        if (!host) return
        establecerConsulta("")
        const [, point] = self.compute_point(host, new Graphene.Point({ x: 0, y: 0 }))
        const anchoBoton = self.get_width()
        const altoBoton = self.get_height()
        const yBoton = Math.round(point.y)

        // El host puede medir toda una sección larga. Acotar al área visible de
        // cada viewport evita desplegar fuera del panel o de una lista interior.
        let limiteSuperior = 0
        let limiteInferior = host.get_height()
        let ancestro = self.get_parent()
        while (ancestro) {
          if (ancestro instanceof Gtk.Viewport) {
            const [valido, origen] = ancestro.compute_point(host, new Graphene.Point({ x: 0, y: 0 }))
            if (valido) {
              limiteSuperior = Math.max(limiteSuperior, origen.y)
              limiteInferior = Math.min(limiteInferior, origen.y + ancestro.get_height())
            }
          }
          if (ancestro instanceof Gtk.ScrolledWindow) {
            const ajuste = ancestro.get_vadjustment()
            ajustesObservados.push([ajuste, ajuste.connect("value-changed", close)])
          }
          ancestro = ancestro.get_parent()
        }
        const huecoAbajo = Math.max(0, limiteInferior - (yBoton + altoBoton + 3))
        const huecoArriba = Math.max(0, yBoton - limiteSuperior - 3)
        const haciaArriba = huecoArriba > huecoAbajo && huecoAbajo < ALTO_MAXIMO
        const tope = Math.max(ALTO_MINIMO_LISTA, Math.min(ALTO_MAXIMO, haciaArriba ? huecoArriba : huecoAbajo))

        desplazable.set_max_content_height(Math.max(48, tope - (buscador ? 42 : 0)))
        list.set_halign(Gtk.Align.START)
        list.set_valign(Gtk.Align.START)
        // Los márgenes cuentan dentro de `measure`: medir ya desplazado resta
        // el margen al ancho útil y provoca avisos y tamaños incorrectos de GTK.
        list.set_margin_start(0)
        list.set_margin_top(0)
        list.set_size_request(anchoBoton, -1)
        list.set_vexpand(false)
        // `measure` sobre el widget aún sin padre: hace falta el alto REAL (que con
        // pocas opciones es menor que el tope) para que, desplegando hacia arriba, la
        // lista termine pegada al botón y no flotando por encima. Si devolviera 0 —no
        // debería, pero es una medida sin realizar— se cae al tope, que es el peor caso
        // pintable y nunca deja la lista fuera del host.
        const [, natural] = list.measure(Gtk.Orientation.VERTICAL, anchoBoton)
        const alto = natural > 0 ? Math.min(natural, tope) : tope
        list.set_margin_start(Math.round(point.x))
        list.set_margin_top(haciaArriba ? Math.max(limiteSuperior, yBoton - 3 - alto) : yBoton + altoBoton + 3)
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
            if (cierrePendiente) return
            cierrePendiente = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
              cierrePendiente = 0
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
          xalign={0}
          hexpand
          halign={Gtk.Align.START}
          ellipsize={3}
          maxWidthChars={maxCaracteres}
          widthChars={anchoCaracteres ?? -1}
          tooltipText={current}
          cssClasses={["qs-display-select-value"]}
        />
        <label label={open((value) => value ? "󰅃" : "󰅀")} cssClasses={["qs-display-select-chevron"]} />
      </box>
    </button>
  ) as unknown as Gtk.Widget

  list = (
    <box orientation={Gtk.Orientation.VERTICAL} spacing={buscador ? 4 : 0}
      cssClasses={clase("qs-display-select-list")}>
    {buscador ? <entry cssClasses={["account-entry", "sp-selector-buscador"]}
      placeholderText={buscador} text={consulta} hexpand
      onChanged={(entrada: Gtk.Entry) => establecerConsulta(entrada.get_text())} /> : <box />}
    <Gtk.ScrolledWindow
      $={(self: Gtk.ScrolledWindow) => { desplazable = self; self.set_overflow(Gtk.Overflow.HIDDEN) }}
      hscrollbarPolicy={Gtk.PolicyType.NEVER}
      vscrollbarPolicy={Gtk.PolicyType.AUTOMATIC}
      propagateNaturalHeight
      maxContentHeight={ALTO_MAXIMO - (buscador ? 42 : 0)}
      vexpand={false}
      cssClasses={clase("qs-display-select-scroll")}
    >
      <box orientation={Gtk.Orientation.VERTICAL} spacing={1} cssClasses={clase("qs-display-select-options")}
        $={(self: Gtk.Box) => self.set_overflow(Gtk.Overflow.HIDDEN)}>
        <label label={textos.listas.sinResultados} wrap xalign={0}
          cssClasses={["sp-field-hint", "sp-selector-vacio"]}
          visible={filtradas((opciones) => opciones.length === 0)} />
        <For each={filtradas}>
          {(opt: any) => (
            <button
              cssClasses={opt.active
                ? [...clase("qs-display-select-opt"), "active"]
                : clase("qs-display-select-opt")}
              tooltipText={opt.label}
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
    </box>
  ) as unknown as Gtk.Widget

  // Las secciones se desmontan desparentando widgets; `destroy` no corre ahí.
  // Quitar el overlay y su controlador evita retener la sección cerrada.
  onCleanup(close)

  return <box cssClasses={clase("qs-display-select-wrap")}>{trigger}</box>
}
