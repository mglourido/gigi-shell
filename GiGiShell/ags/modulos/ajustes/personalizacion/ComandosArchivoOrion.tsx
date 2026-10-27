// Cómo abre Orion cada extensión cuando no se quiere lo de fábrica (el
// intérprete de los ejecutables o la app predeterminada del sistema): p. ej.
// los `.c` con `gcc {archivo} -o {nombre}` en un terminal. Misma forma que
// `CarpetasEjecutablesOrion.tsx`.
//
// Las filas NO tienen controles que cambien la regla en sitio (ni casilla de
// terminal ni campo editable): cambiar la regla crea un objeto nuevo y el
// `<For>` rehace la fila, o sea destruiría el control desde su propio manejador
// — el patrón del SIGSEGV de las franjas horarias (ags/servicios/pantalla/CLAUDE.md).
// Para editar, el lápiz copia la regla al formulario de
// abajo y "Guardar" la sustituye (una extensión solo tiene una regla).
import { For, createState } from "ags"
import { Gtk } from "ags/gtk4"
import TextoInformativo from "../componentes/TextoInformativo"
import TituloSubseccion from "../componentes/TituloSubseccion"
import { ListaAjustes, EntradaTextoAjustes, BotonAjustes } from "../componentes"
import {
  orionComandosArchivo, setOrionComandoArchivo, removeOrionComandoArchivo, orionEnabled,
} from "../preferences"
import type { ComandoArchivo } from "../../orion/data/ejecutables.modelo"
import textos from "../../../textos/ajustes/personalizacion.json" with { type: "json" }

const t = textos.orion.comandos

export default function ComandosArchivoOrion() {
  let entradaExt: Gtk.Entry
  let entradaComando: Gtk.Entry
  let casillaTerminal: Gtk.CheckButton
  const [aviso, setAviso] = createState("")

  const guardar = () => {
    const ext = entradaExt?.get_text() ?? ""
    const comando = entradaComando?.get_text() ?? ""
    if (!setOrionComandoArchivo(ext, comando, casillaTerminal?.get_active() ?? false)) {
      setAviso(t.invalida)
      return
    }
    setAviso("")
    entradaExt.set_text("")
    entradaComando.set_text("")
    casillaTerminal.set_active(false)
  }

  const editar = (regla: ComandoArchivo) => {
    entradaExt.set_text(regla.ext)
    entradaComando.set_text(regla.comando)
    casillaTerminal.set_active(regla.terminal)
    setAviso("")
  }

  const Fila = ({ regla }: { regla: ComandoArchivo }) => (
    <box spacing={8} valign={Gtk.Align.CENTER} cssClasses={["sp-rule-row"]}>
      <label cssClasses={["sp-clase-nombre"]} label={`.${regla.ext}`} halign={Gtk.Align.START} />
      <label
        cssClasses={["sp-field-hint"]}
        label={regla.comando}
        halign={Gtk.Align.START}
        hexpand
        ellipsize={3}
        xalign={0}
        tooltipText={regla.comando}
      />
      <label cssClasses={["sp-field-hint"]} label={t.enTerminalCorto} visible={regla.terminal} />
      <button cssClasses={["sp-rule-del"]} onClicked={() => editar(regla)} valign={Gtk.Align.CENTER} tooltipText={t.editar}>
        <label label="󰏫" />
      </button>
      <button
        cssClasses={["sp-rule-del"]}
        onClicked={() => removeOrionComandoArchivo(regla.ext)}
        valign={Gtk.Align.CENTER}
        tooltipText={t.quitar}
      >
        <label label="󰅖" />
      </button>
    </box>
  )

  return (
    <box orientation={Gtk.Orientation.VERTICAL} spacing={6} cssClasses={["sp-clases"]} visible={orionEnabled}>
      <TituloSubseccion label={t.titulo} halign={Gtk.Align.START} />
      <TextoInformativo label={t.ayuda} halign={Gtk.Align.START} wrap maxWidthChars={62} xalign={0} />

      <ListaAjustes
        cantidad={orionComandosArchivo((lista: ComandoArchivo[]) => lista.length)}
        alto={orionComandosArchivo((lista: ComandoArchivo[]) => Math.max(40, Math.min(180, lista.length * 36)))}
        vacia={t.vacia}
        cssClasses={["orion-notis-lista"]}
      >
        <For each={orionComandosArchivo}>
          {(regla: ComandoArchivo) => <Fila regla={regla} />}
        </For>
      </ListaAjustes>

      <box spacing={6} valign={Gtk.Align.CENTER}>
        <EntradaTextoAjustes
          widthRequest={70}
          xalign={0}
          placeholderText={t.placeholderExt}
          $={(self: Gtk.Entry) => { entradaExt = self }}
          onActivate={() => entradaComando?.grab_focus()}
        />
        <EntradaTextoAjustes
          expandir
          xalign={0}
          placeholderText={t.placeholderComando}
          $={(self: Gtk.Entry) => { entradaComando = self }}
          onActivate={guardar}
        />
      </box>
      <box spacing={6} valign={Gtk.Align.CENTER}>
        <Gtk.CheckButton
          label={t.enTerminal}
          tooltipText={t.enTerminalAyuda}
          $={(self: Gtk.CheckButton) => { casillaTerminal = self }}
        />
        <box hexpand />
        <BotonAjustes onClicked={guardar}>
          <label label={t.guardar} />
        </BotonAjustes>
      </box>
      <TextoInformativo label={aviso} visible={aviso((a) => a.length > 0)} halign={Gtk.Align.START} wrap maxWidthChars={62} xalign={0} />
    </box>
  )
}
