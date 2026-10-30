// modulos/ajustes/personalizacion/AjusteNoMolestarAutomatico.tsx
// Bloque "Silencio automático" de Notificaciones > General: una política por condición (juego,
// apps marcadas, pantalla completa), cada una con su modo y su lista de apps permitidas.
// La lógica vive en modulos/notificaciones/autoDnd/; aquí sólo persiste preferencias.
import { Gtk } from "ags/gtk4"
import { EncabezadoAjuste, ListaClasesVentana } from "../componentes"
import textos from "../../../textos/ajustes/personalizacion.json" with { type: "json" }
import {
  CONDICIONES_SILENCIO, MODOS_SILENCIO, type CondicionSilencio,
} from "../../notificaciones/autoDnd/politica"
import {
  addAppSilencio, addAutoDndApp, autoDndFullscreenApps, removeAppSilencio, removeAutoDndApp,
  setModoSilencio, silencioAuto,
} from "../preferences"

const t = textos.noMolestar

function BloqueCondicion({ condicion }: { condicion: CondicionSilencio }) {
  const politica = silencioAuto((p) => p[condicion])
  return (
    <box orientation={Gtk.Orientation.VERTICAL} spacing={6}>
      <label cssClasses={["re-section"]} label={t.condiciones[condicion]} halign={Gtk.Align.START} />
      <box spacing={4}>
        {MODOS_SILENCIO.map((modo) => (
          <button
            cssClasses={politica((p) => p.modo === modo ? ["re-seg", "active"] : ["re-seg"])}
            onClicked={() => setModoSilencio(condicion, modo)}
          >
            <label label={t.modos[modo]} />
          </button>
        ))}
      </box>
      <ListaClasesVentana
        clases={politica((p) => p.apps)}
        alAnadir={(app: string) => addAppSilencio(condicion, app)}
        alQuitar={(app: string) => removeAppSilencio(condicion, app)}
        visible={politica((p) => p.modo === "apps")}
        textos={t.permitidas}
      />
    </box>
  )
}

export default function AutoDndSetting() {
  return (
    <box orientation={Gtk.Orientation.VERTICAL} spacing={10} cssClasses={["sp-field"]} hexpand>
      <EncabezadoAjuste
        titulo={t.titulo}
        informacion={t.descripcion}
        halign={Gtk.Align.START}
        propiedadesInformacion={{ wrap: true, lines: 2, maxWidthChars: 62, xalign: 0 }}
      />
      {CONDICIONES_SILENCIO.map((condicion) => <BloqueCondicion condicion={condicion} />)}
      <ListaClasesVentana
        clases={autoDndFullscreenApps}
        alAnadir={addAutoDndApp}
        alQuitar={removeAutoDndApp}
        preferirPantallaCompleta
        textos={t.lista}
      />
    </box>
  )
}
