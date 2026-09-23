// modulos/notificaciones/settings/AppsTab.tsx
import { Gtk } from "ags/gtk4"
import { createState, For, With } from "ags"
import { rulesFile, allRules, upsertUserRule, removeUserRule } from "../rules/rulesStore.ts"
import { historyEntries } from "../history/historyStore.ts"
import { getAppIcon, resolveAppColor, appSettings, updateAppSettings } from "../store.ts"
import { hexToRgb } from "../rules/color.ts"
import ColorPicker from "./ColorPicker.tsx"
import EmptyState from "../../../componentes/EmptyState.tsx"
import textos from "../../../textos/ajustes/notificaciones.json" with { type: "json" }
import { formatearTexto } from "../../../textos/formatear.ts"
import {
  crearReglaAplicacion,
  idReglaAplicacion,
  type TipoReglaAplicacion,
} from "./reglasAplicacion.ts"

export default function AppsTab() {
  const computeApps = (): string[] => {
    const set = new Set<string>()
    for (const e of historyEntries.get()) set.add(e.app)
    for (const r of allRules()) if (r.match.app?.op === "equals") set.add(r.match.app.value)
    return [...set].sort((a, b) => a.localeCompare(b))
  }
  const [apps, setApps] = createState<string[]>(computeApps())
  const refresh = () => setApps(computeApps())
  historyEntries.subscribe(refresh)
  rulesFile.subscribe(refresh)

  function estaActiva(tipo: TipoReglaAplicacion, app: string): boolean {
    return allRules().some((regla) =>
      regla.id === idReglaAplicacion(tipo, app)
      && regla.enabled
      && (tipo === "bloqueo" ? !!regla.effects.suppress : !!regla.effects.muteAudio))
  }

  function alternarRegla(tipo: TipoReglaAplicacion, app: string): void {
    if (estaActiva(tipo, app)) removeUserRule(idReglaAplicacion(tipo, app))
    else upsertUserRule(crearReglaAplicacion(tipo, app))
    refresh()
  }
  function ruleCount(app: string): number {
    return allRules().filter(r => r.match.app?.op === "equals" && r.match.app.value === app).length
  }

  function ruleCountText(app: string): string {
    const count = ruleCount(app)
    return formatearTexto(count === 1 ? textos.apps.reglaDirecta : textos.apps.reglasDirectas, { cantidad: count })
  }

  const empty = apps((a) => (a?.length ?? 0) === 0)
  const [colorApp, setColorApp] = createState<string | null>(null)

  return (
    <box orientation={Gtk.Orientation.VERTICAL} spacing={6} hexpand vexpand>
      <label cssClasses={["st-tab-hint"]} label={textos.apps.cabecera} halign={Gtk.Align.START} />

      <With value={empty}>
        {(isEmpty: boolean) => isEmpty
          ? <EmptyState
              icon="󰂚"
              title={textos.apps.vacio}
              wrapClass="ns-empty-state"
              iconClass="ns-empty-icon"
              titleClass="ns-empty-label"
              vexpand
            />
          : <Gtk.ScrolledWindow hscrollbarPolicy={Gtk.PolicyType.NEVER} vscrollbarPolicy={Gtk.PolicyType.AUTOMATIC} hexpand vexpand>
              <box orientation={Gtk.Orientation.VERTICAL} spacing={4} hexpand>
                <For each={apps}>
                  {(app: string) => (
                    <box orientation={Gtk.Orientation.VERTICAL} spacing={0} hexpand>
                      <box cssClasses={["ns-app-row"]} spacing={8} valign={Gtk.Align.CENTER} hexpand>
                        <box cssClasses={["ns-app-icon-wrap"]} css={appSettings((s) => `background: rgba(${hexToRgb(resolveAppColor(app, s))}, 0.15);`)}>
                          <label cssClasses={["ns-app-icon"]} label={getAppIcon(app)} css={appSettings((s) => `color: ${resolveAppColor(app, s)};`)} />
                        </box>
                        <box orientation={Gtk.Orientation.VERTICAL} spacing={2} hexpand halign={Gtk.Align.START}>
                          <label cssClasses={["ns-app-name"]} label={app} halign={Gtk.Align.START} ellipsize={3} />
                          <label cssClasses={["re-row-summary"]} label={rulesFile(() => ruleCountText(app))} halign={Gtk.Align.START} />
                        </box>
                        <button
                          cssClasses={colorApp((c) => c === app ? ["ns-color-btn", "open"] : ["ns-color-btn"])}
                          css={appSettings((s) => `background: ${resolveAppColor(app, s)};`)}
                          tooltipText={textos.apps.color}
                          onClicked={() => setColorApp(colorApp.get() === app ? null : app)}
                        >
                          <label cssClasses={["ns-color-check"]} label={appSettings((s) => s[app]?.color ? "󰉼" : "")} />
                        </button>
                        <button
                          cssClasses={rulesFile(() => estaActiva("silencio", app) ? ["ns-mute-btn", "muted"] : ["ns-mute-btn"])}
                          tooltipText={rulesFile(() => estaActiva("silencio", app)
                            ? textos.apps.quitarSonidoInactivo
                            : textos.apps.sonidoInactivo)}
                          onClicked={() => alternarRegla("silencio", app)}
                        >
                          <label cssClasses={["ns-mute-icon"]} label={rulesFile(() => estaActiva("silencio", app) ? "󰝟" : "󰕾")} />
                        </button>
                        <button
                          cssClasses={rulesFile(() => estaActiva("bloqueo", app) ? ["ns-mute-btn", "muted"] : ["ns-mute-btn"])}
                          tooltipText={rulesFile(() => estaActiva("bloqueo", app)
                            ? textos.apps.quitarBloqueo
                            : textos.apps.crearBloqueo)}
                          onClicked={() => alternarRegla("bloqueo", app)}
                        >
                          <label cssClasses={["ns-mute-icon"]} label={rulesFile(() => estaActiva("bloqueo", app) ? "󰂛" : "󰂚")} />
                        </button>
                      </box>
                      <box cssClasses={["ns-color-editor"]} visible={colorApp((c) => c === app)}>
                        <With value={colorApp}>
                          {(c: string | null) => c === app
                            ? <ColorPicker
                                value={appSettings.get()[app]?.color}
                                onChange={(hex) => updateAppSettings(app, { color: hex })}
                              />
                            : <box />}
                        </With>
                      </box>
                    </box>
                  )}
                </For>
              </box>
            </Gtk.ScrolledWindow>
        }
      </With>
    </box>
  )
}
