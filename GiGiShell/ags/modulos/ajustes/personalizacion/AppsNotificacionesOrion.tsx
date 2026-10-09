// Qué apps salen en la página "Notificaciones" de Inicio de Orion. Misma forma que
// `componentes/ListaClasesVentana.tsx` (filas con borrar + campo para añadir), pero
// sin el botón de "ventana actual": aquí lo que se compara es el NOMBRE DE APP de
// la notificación, que no tiene por qué coincidir con la clase de ninguna ventana.
// Su equivalente útil son las sugerencias: las apps que ya han mandado algo y aún
// no están en la lista, para añadirlas con un clic sin adivinar cómo se anuncian.
import { For, createComputed } from "ags"
import { Gtk } from "ags/gtk4"
import TextoInformativo from "../componentes/TextoInformativo"
import TituloSubseccion from "../componentes/TituloSubseccion"
import { ListaAjustes, EntradaTextoAjustes, BotonAjustes } from "../componentes"
import { orionNotisApps, addOrionNotisApp, removeOrionNotisApp, orionEnabled } from "../preferences"
import { notifications } from "../../notificaciones/store"
import textos from "../../../textos/ajustes/personalizacion.json" with { type: "json" }

const t = textos.orion.notificaciones

function FilaApp({ app }: { app: string }) {
  return (
    <box spacing={5} valign={Gtk.Align.CENTER} cssClasses={["sp-rule-row"]}>
      <label cssClasses={["sp-clase-nombre"]} label={app} halign={Gtk.Align.START} ellipsize={3} />
      <box hexpand />
      <button
        cssClasses={["sp-rule-del"]}
        onClicked={() => removeOrionNotisApp(app)}
        valign={Gtk.Align.CENTER}
        tooltipText={t.quitar}
      >
        <label label="󰅖" />
      </button>
    </box>
  )
}

export default function AppsNotificacionesOrion() {
  let entrada: Gtk.Entry
  const anadirEscrito = () => {
    const valor = entrada?.get_text().trim()
    if (!valor) return
    addOrionNotisApp(valor)
    entrada.set_text("")
  }

  // Apps que han notificado y que la lista todavía no cubre. Los avisos del
  // sistema no cuentan: la página de Orion tampoco los enseña nunca.
  const sugerencias = createComputed(() => {
    const lista = orionNotisApps()
    const vistas = new Set<string>()
    for (const n of notifications()) {
      if (n.source === "system" || !n.appName) continue
      const nombre = n.appName.trim()
      const bajo = nombre.toLowerCase()
      if (lista.some((a) => bajo.includes(a))) continue
      vistas.add(nombre)
    }
    return [...vistas].sort((a, b) => a.localeCompare(b)).slice(0, 4)
  })

  return (
    <box orientation={Gtk.Orientation.VERTICAL} spacing={6} cssClasses={["sp-clases"]} visible={orionEnabled}>
      <TituloSubseccion label={t.titulo} halign={Gtk.Align.START} />
      <TextoInformativo label={t.ayuda} halign={Gtk.Align.START} wrap maxWidthChars={62} xalign={0} />

      <ListaAjustes cantidad={orionNotisApps((lista: string[]) => lista.length)} vacia={t.vacia}>
        <For each={orionNotisApps}>
          {(app: string) => <FilaApp app={app} />}
        </For>
      </ListaAjustes>

      <box spacing={6} valign={Gtk.Align.CENTER}>
        <EntradaTextoAjustes
          expandir
          xalign={0}
          placeholderText={t.placeholder}
          $={(self: Gtk.Entry) => { entrada = self }}
          onActivate={anadirEscrito}
        />
        <BotonAjustes onClicked={anadirEscrito}>
          <label label={t.anadir} />
        </BotonAjustes>
      </box>

      <box orientation={Gtk.Orientation.VERTICAL} spacing={4} visible={sugerencias((l) => l.length > 0)}>
        <TextoInformativo label={t.sugerencias} halign={Gtk.Align.START} />
        <box orientation={Gtk.Orientation.VERTICAL} spacing={4}>
          <For each={sugerencias}>
            {(app: string) => (
              <button cssClasses={["sp-add-rule"]} onClicked={() => addOrionNotisApp(app)} tooltipText={`${t.anadir} ${app}`}>
                <label label={`+ ${app}`} />
              </button>
            )}
          </For>
        </box>
      </box>
    </box>
  )
}
