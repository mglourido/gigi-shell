// modulos/notificaciones/settings/AppFilterBar.tsx
// Reusable app-filter chip row, mirroring the notification panel's AppFilterChips.
// "Todas" chip + a horizontal-scrolling list of app chips. Reuses the .np-filter-* styles.
import { Gtk } from "ags/gtk4"
import { For, type Accessor } from "ags"
import textos from "../../../textos/ajustes/notificaciones.json" with { type: "json" }

export default function AppFilterBar(props: {
  apps: Accessor<string[]>
  active: Accessor<string>
  onSelect: (app: string) => void
}) {
  // La barra no lleva scrollbar: la política EXTERNAL evita que GTK la dibuje y la reserve
  // (con una barra "invisible" por CSS seguía siendo pulsable). La rueda se maneja a mano
  // desde un controlador puesto en TODA la fila, no solo sobre el ScrolledWindow.
  let ventanaScroll: Gtk.ScrolledWindow | null = null

  function conectarRueda(fila: Gtk.Box): void {
    const controlador = new Gtk.EventControllerScroll({
      flags: Gtk.EventControllerScrollFlags.BOTH_AXES,
    })
    controlador.connect("scroll", (_controlador, dx, dy) => {
      if (!ventanaScroll) return false
      const ajuste = ventanaScroll.get_hadjustment()
      const delta = dx !== 0 ? dx : dy
      ajuste.set_value(ajuste.get_value() + delta * 40)
      return true
    })
    fila.add_controller(controlador)
  }

  return (
    <box cssClasses={["np-filter-row"]} spacing={2} $={conectarRueda}>
      <button
        cssClasses={props.active((f) => f === "all" ? ["np-filter-chip", "active"] : ["np-filter-chip"])}
        onClicked={() => props.onSelect("all")}
      >
        <label label={textos.sinReglas.todas} cssClasses={["np-filter-chip-label"]} />
      </button>

      <Gtk.ScrolledWindow
        cssClasses={["np-filter-scroll"]}
        hscrollbarPolicy={Gtk.PolicyType.EXTERNAL}
        vscrollbarPolicy={Gtk.PolicyType.NEVER}
        $={(ventana: Gtk.ScrolledWindow) => { ventanaScroll = ventana }}
        kineticScrolling={false}
        propagateNaturalHeight={true}
        hexpand
      >
        <box spacing={2}>
          <For each={props.apps}>
            {(appName: string) => (
              <button
                cssClasses={props.active((f) => f === appName ? ["np-filter-chip", "active"] : ["np-filter-chip"])}
                onClicked={() => props.onSelect(appName)}
              >
                <label label={appName} cssClasses={["np-filter-chip-label"]} />
              </button>
            )}
          </For>
        </box>
      </Gtk.ScrolledWindow>
    </box>
  )
}
