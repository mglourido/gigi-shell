// modulos/notificaciones/settings/HistoryTab.tsx
import { Gtk } from "ags/gtk4"
import { createState, For, With } from "ags"
import type { NotifRule } from "../rules/types.ts"
import { cleanHistory, clearHistory, historyEntries } from "../history/historyStore.ts"
import type { HistoryEntry } from "../history/historyLogic.ts"
import { getRelativeTime } from "../store.ts"
import { ruleFromHistoryEntry } from "./ruleFactory.ts"
import RuleEditor from "./RuleEditor.tsx"
import AppFilterBar from "./AppFilterBar.tsx"
import EmptyState from "../../../componentes/EmptyState.tsx"
import { notifDaemonConflict, type DaemonConflict } from "../daemon/comprobacion.ts"
import BannerConflicto from "../daemon/BannerConflicto.tsx"
import textos from "../../../textos/ajustes/notificaciones.json" with { type: "json" }
import { formatearTexto } from "../../../textos/formatear.ts"

export default function HistoryTab() {
  // Barrido al montar. `historyStore` solo lo dispara con `notifSettingsVisible` (la ventana
  // propia del engranaje); abierta desde Ajustes > Notificaciones esta pestaña enseñaba entradas
  // que ya casan con una regla — entre ellas la que acabas de crear desde aquí mismo, que se
  // quedaba en la lista como si no hubiera pasado nada.
  cleanHistory()

  const [editing, setEditing] = createState<NotifRule | null>(null)
  // Borrado en dos pulsaciones: la lista se rehace sola con lo que vaya llegando, pero un
  // clic accidental se lleva por delante la cola de "esto aún no lo he decidido", que es
  // justo lo que se viene a mirar aquí. Sin diálogo modal: el segundo clic ES la confirmación.
  const [confirmandoBorrado, setConfirmandoBorrado] = createState(false)
  const empty = historyEntries((e) => (e?.length ?? 0) === 0)
  const [filter, setFilter] = createState<string>("all")
  const apps = historyEntries((es) => Array.from(new Set((es ?? []).map(e => e.app))).sort((a, b) => a.localeCompare(b)))

  // Al cerrar el editor se vuelve a barrer: si se ha guardado una regla, su entrada ya no
  // pertenece a «Detectadas».
  const cerrarEditor = () => { setEditing(null); cleanHistory() }

  const pulsarBorrar = () => {
    if (!confirmandoBorrado.get()) { setConfirmandoBorrado(true); return }
    clearHistory()
    setConfirmandoBorrado(false)
  }

  return (
    <box orientation={Gtk.Orientation.VERTICAL} spacing={0} hexpand vexpand>
      <With value={editing}>
        {(e: NotifRule | null) => e
          ? <RuleEditor rule={e} onClose={cerrarEditor} />
          : <box orientation={Gtk.Orientation.VERTICAL} spacing={6} hexpand vexpand>
              <box spacing={8} valign={Gtk.Align.CENTER} hexpand>
                <label cssClasses={["st-tab-hint"]} label={textos.sinReglas.cabecera} halign={Gtk.Align.START} hexpand wrap={true} />
                <button
                  cssClasses={confirmandoBorrado((c) => c ? ["re-delete", "confirm"] : ["re-delete"])}
                  tooltipText={textos.sinReglas.borrarAyuda}
                  valign={Gtk.Align.CENTER}
                  visible={empty((isEmpty: boolean) => !isEmpty)}
                  onClicked={pulsarBorrar}
                >
                  <label label={confirmandoBorrado((c) => c ? textos.sinReglas.borrarConfirmar : textos.sinReglas.borrar)} />
                </button>
              </box>

              <With value={empty}>
                {(isEmpty: boolean) => isEmpty
                  // Vacío tiene dos causas MUY distintas: no ha pasado nada, o no somos el
                  // servidor de notificaciones y no llega nada que guardar. Distinguirlas aquí
                  // es el punto: es en esta pantalla donde se mira cuando "no guarda nada".
                  //
                  // El <With> interno va DENTRO de una <box>, no devuelto a pelo: <With>
                  // devuelve un Fragment y meter un Fragment en otro lanza «nesting Fragments
                  // are not yet supported» — con el error tragado por el efecto, así que la
                  // pestaña se quedaba entera en blanco justo en el caso vacío.
                  ? <box orientation={Gtk.Orientation.VERTICAL} hexpand vexpand>
                      <With value={notifDaemonConflict}>
                        {(c: DaemonConflict | null) => c
                          ? BannerConflicto({
                              conflict: c,
                              wrapClass: "ns-empty-state",
                              iconClass: "ns-empty-icon",
                              titleClass: "ns-empty-label",
                              subClass: "ns-empty-sub",
                              vexpand: true,
                            })
                          : <EmptyState
                              icon="󰂚"
                              title={textos.sinReglas.vacio}
                              wrapClass="ns-empty-state"
                              iconClass="ns-empty-icon"
                              titleClass="ns-empty-label"
                              vexpand
                            />
                        }
                      </With>
                    </box>
                  : <box orientation={Gtk.Orientation.VERTICAL} spacing={6} hexpand vexpand>
                      <AppFilterBar apps={apps} active={filter} onSelect={setFilter} />
                      <Gtk.ScrolledWindow hscrollbarPolicy={Gtk.PolicyType.NEVER} vscrollbarPolicy={Gtk.PolicyType.AUTOMATIC} hexpand vexpand>
                        <box orientation={Gtk.Orientation.VERTICAL} spacing={4} hexpand>
                          {/* Sin `id`: el <For> indexa por identidad de objeto, y aquí eso es el
                              mecanismo de refresco — `upsertEntry` sustituye el objeto de la
                              entrada al repetirse, y es lo que hace que el contador y la hora se
                              vuelvan a pintar. Con `id={dedupKey}` la fila se congelaría en los
                              valores del primer avistamiento. */}
                          <For each={historyEntries}>
                            {(entry: HistoryEntry) => (
                              <box cssClasses={["re-row"]} spacing={8} valign={Gtk.Align.CENTER} visible={filter((f) => f === "all" || f === entry.app)} hexpand>
                                <box orientation={Gtk.Orientation.VERTICAL} spacing={2} hexpand halign={Gtk.Align.START}>
                                  <box spacing={6}>
                                    <label cssClasses={["re-row-name"]} label={entry.app} halign={Gtk.Align.START} ellipsize={3} />
                                    {/* Cuántas veces y cuándo: sin esto una notificación repetida
                                        no daba NINGUNA señal de haberse registrado — la fila era
                                        idéntica a la de la primera vez y parecía que no guardaba. */}
                                    <label
                                      cssClasses={["re-badge"]}
                                      label={formatearTexto(textos.sinReglas.veces, { cantidad: String(entry.count) })}
                                      visible={entry.count > 1}
                                    />
                                    <label cssClasses={["re-row-time"]} label={getRelativeTime(entry.lastSeen)} halign={Gtk.Align.START} />
                                  </box>
                                  <label cssClasses={["re-row-summary"]} label={entry.summary || textos.sinReglas.sinTitulo} halign={Gtk.Align.START} ellipsize={3} />
                                  {entry.sampleBody && <label cssClasses={["re-row-body"]} label={entry.sampleBody} halign={Gtk.Align.START} ellipsize={3} />}
                                </box>
                                <button cssClasses={["st-add-btn"]} onClicked={() => setEditing(ruleFromHistoryEntry(`user.${Date.now()}`, entry))}>
                                  <label label={textos.sinReglas.crearRegla} />
                                </button>
                              </box>
                            )}
                          </For>
                        </box>
                      </Gtk.ScrolledWindow>
                    </box>
                }
              </With>
            </box>
        }
      </With>
    </box>
  )
}
