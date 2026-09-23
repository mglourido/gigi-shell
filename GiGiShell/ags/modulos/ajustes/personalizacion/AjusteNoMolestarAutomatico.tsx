// modulos/ajustes/personalizacion/AjusteNoMolestarAutomatico.tsx
// Bloque "No molestar automático" de Notificaciones > General.
// Un toggle maestro + una lista editable de clases de ventana que, al ponerse en
// pantalla completa, también activan el No molestar (además de los juegos).
// La lógica vive en modulos/notificaciones/autoDnd/; aquí sólo persiste preferencias.
// La lista es el componente compartido `ListaClasesVentana` (el mismo que usa la pausa
// de la luz nocturna al jugar), con `preferirPantallaCompleta` porque aquí la condición
// ES la pantalla completa: al pulsar "ventana actual" interesa esa antes que la enfocada.
import { Gtk } from "ags/gtk4"
import Interruptor from "../../../componentes/Interruptor"
import { EncabezadoAjuste, ListaClasesVentana } from "../componentes"
import textos from "../../../textos/ajustes/personalizacion.json" with { type: "json" }
import {
  autoDndEnabled, setAutoDndEnabled,
  autoDndFullscreenApps, addAutoDndApp, removeAutoDndApp,
} from "../preferences"

export default function AutoDndSetting() {
  return (
    <box orientation={Gtk.Orientation.VERTICAL} spacing={8} cssClasses={["sp-field"]} hexpand>
      {/* Toggle maestro */}
      <box spacing={8} valign={Gtk.Align.CENTER}>
        <EncabezadoAjuste
          titulo={textos.noMolestar.titulo}
          informacion={textos.noMolestar.descripcion}
          halign={Gtk.Align.START}
          propiedadesInformacion={{ wrap: true, lines: 2, maxWidthChars: 62, xalign: 0 }}
        />
        <Interruptor
          activo={autoDndEnabled}
          alAlternar={() => setAutoDndEnabled(!autoDndEnabled.get())}
        />
      </box>

      {/* Lista de apps que silencian en pantalla completa (sólo si está activo) */}
      <ListaClasesVentana
        clases={autoDndFullscreenApps}
        alAnadir={addAutoDndApp}
        alQuitar={removeAutoDndApp}
        preferirPantallaCompleta
        visible={autoDndEnabled((v: boolean) => v)}
        textos={{
          titulo: textos.noMolestar.lista.titulo,
          ayuda: textos.noMolestar.lista.ayuda,
          vacia: textos.noMolestar.lista.vacia,
          placeholder: textos.noMolestar.lista.placeholder,
          anadir: textos.noMolestar.lista.anadir,
          quitar: textos.noMolestar.lista.quitar,
          ventana: textos.noMolestar.lista.ventana,
          anadirVentana: textos.noMolestar.lista.anadirVentana,
        }}
      />
    </box>
  )
}
