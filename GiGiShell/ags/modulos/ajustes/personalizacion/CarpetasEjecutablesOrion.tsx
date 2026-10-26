// Carpetas extra donde Orion busca archivos por extensión (.pdf, .AppImage,
// .jar…). Misma forma que `AppsNotificacionesOrion.tsx` (filas con borrar + campo
// para añadir). Sin botón de examinar a propósito: esta ventana es una
// layer-shell OVERLAY y un diálogo de ficheros saldría por debajo, invisible
// (ver `sonido/CampoRutaAudio.ts`). Las carpetas fijas no salen en la lista: no
// se pueden quitar, y el texto de ayuda las nombra.
import { For, createState } from "ags"
import { Gtk } from "ags/gtk4"
import GLib from "gi://GLib"
import TextoInformativo from "../componentes/TextoInformativo"
import TituloSubseccion from "../componentes/TituloSubseccion"
import { ListaAjustes, EntradaTextoAjustes, BotonAjustes } from "../componentes"
import {
  orionRutasEjecutables, addOrionRutaEjecutables, removeOrionRutaEjecutables, orionEnabled,
} from "../preferences"
import { expandirCarpeta } from "../../orion/data/ejecutables.modelo"
import textos from "../../../textos/ajustes/personalizacion.json" with { type: "json" }

const t = textos.orion.ejecutables

function FilaCarpeta({ ruta }: { ruta: string }) {
  return (
    <box spacing={5} valign={Gtk.Align.CENTER} cssClasses={["sp-rule-row"]}>
      <label cssClasses={["sp-clase-nombre"]} label={ruta} halign={Gtk.Align.START} ellipsize={2} tooltipText={ruta} />
      <box hexpand />
      <button
        cssClasses={["sp-rule-del"]}
        onClicked={() => removeOrionRutaEjecutables(ruta)}
        valign={Gtk.Align.CENTER}
        tooltipText={t.quitar}
      >
        <label label="󰅖" />
      </button>
    </box>
  )
}

export default function CarpetasEjecutablesOrion() {
  let entrada: Gtk.Entry
  const [aviso, setAviso] = createState("")

  const anadirEscrita = () => {
    const valor = entrada?.get_text().trim()
    if (!valor) return
    if (!addOrionRutaEjecutables(valor)) {
      setAviso(t.invalida)
      return
    }
    const existe = GLib.file_test(expandirCarpeta(valor, GLib.get_home_dir()), GLib.FileTest.IS_DIR)
    setAviso(existe ? "" : t.noExiste)
    entrada.set_text("")
  }

  return (
    <box orientation={Gtk.Orientation.VERTICAL} spacing={6} cssClasses={["sp-clases"]} visible={orionEnabled}>
      <TituloSubseccion label={t.titulo} halign={Gtk.Align.START} />
      <TextoInformativo label={t.ayuda} halign={Gtk.Align.START} wrap maxWidthChars={62} xalign={0} />

      <ListaAjustes
        cantidad={orionRutasEjecutables((lista: string[]) => lista.length)}
        alto={orionRutasEjecutables((lista: string[]) => Math.max(40, Math.min(180, lista.length * 36)))}
        vacia={t.vacia}
        cssClasses={["orion-notis-lista"]}
      >
        <For each={orionRutasEjecutables}>
          {(ruta: string) => <FilaCarpeta ruta={ruta} />}
        </For>
      </ListaAjustes>

      <box spacing={6} valign={Gtk.Align.CENTER}>
        <EntradaTextoAjustes
          expandir
          xalign={0}
          placeholderText={t.placeholder}
          $={(self: Gtk.Entry) => { entrada = self }}
          onActivate={anadirEscrita}
        />
        <BotonAjustes onClicked={anadirEscrita}>
          <label label={t.anadir} />
        </BotonAjustes>
      </box>
      <TextoInformativo label={aviso} visible={aviso((a) => a.length > 0)} halign={Gtk.Align.START} wrap maxWidthChars={62} xalign={0} />
    </box>
  )
}
