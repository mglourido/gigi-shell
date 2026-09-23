// modulos/notificaciones/settings/SettingsTabs.tsx
import { Gtk } from "ags/gtk4"
import { createState, With } from "ags"
import type { NotifRule } from "../rules/types.ts"
import AppsTab from "./AppsTab.tsx"
import HistoryTab from "./HistoryTab.tsx"
import RulesTab from "./RulesTab.tsx"
import SistemaTab from "./SistemaTab.tsx"
import GeneralTab from "./GeneralTab.tsx"
import RuleEditor from "./RuleEditor.tsx"
import { reglaEnEdicion, cerrarEdicionNotificacion } from "./edicionDirecta.ts"
import { TituloSeccion } from "../../ajustes/componentes"
import textos from "../../../textos/ajustes/notificaciones.json" with { type: "json" }

type TabId = "general" | "apps" | "sistema" | "history" | "rules"
// «Sistema» va antes que «Detectadas» y «Reglas» porque es la lista cerrada y conocida —los
// avisos que trae el propio equipo—, mientras que las otras dos dependen de lo que hayan
// mandado las apps.
const TABS: { id: TabId; label: string }[] = [
  { id: "general", label: textos.pestanas.general },
  { id: "apps", label: textos.pestanas.apps },
  { id: "sistema", label: textos.pestanas.sistema },
  { id: "history", label: textos.pestanas.sinReglas },
  { id: "rules", label: textos.pestanas.reglas },
]

/** `mostrarTitulo` existe porque estas pestañas se montan en DOS sitios con cabeceras distintas:
 *  en Ajustes > Notificaciones, donde el «✦ Notificaciones» es el título de la sección igual que
 *  en el resto de secciones; y en la ventana propia (`SettingsWindow`), que ya rotula
 *  «Ajustes de notificaciones» encima y ahí el título repetido sobra. */
export default function SettingsTabs({ mostrarTitulo = true }: { mostrarTitulo?: boolean } = {}) {
  const [tab, setTab] = createState<TabId>("general")
  // Editar desde el panel (clic derecho > 󰏫) entra POR AQUÍ y no por una pestaña: la
  // notificación puede acabar en el editor de un aviso del sistema, en el de una regla ya
  // existente o en uno nuevo, y obligarla a elegir pestaña antes de saberlo solo serviría para
  // dejar al usuario en una lista que no es la suya. Mientras hay edición pendiente la barra
  // de pestañas ni se pinta; al cerrar, los ajustes quedan como estaban.
  // Se construye con una FUNCIÓN, no con una constante: `<With>` destruye el hijo anterior al
  // cambiar de valor, así que un árbol guardado en una variable ya no se puede volver a
  // colgar al salir del editor. `tab` vive fuera, de modo que se vuelve a la misma pestaña.
  const contenido = () => (
    <box orientation={Gtk.Orientation.VERTICAL} spacing={10} hexpand vexpand>
      <box cssClasses={["st-tabbar"]} spacing={4} hexpand>
        {TABS.map(t => (
          <button
            cssClasses={tab((cur) => cur === t.id ? ["st-tab", "active"] : ["st-tab"])}
            hexpand
            onClicked={() => setTab(t.id)}
          >
            <label label={t.label} />
          </button>
        ))}
      </box>
      <With value={tab}>
        {(current: TabId) => {
          if (current === "general") return <GeneralTab />
          if (current === "apps") return <AppsTab />
          if (current === "sistema") return <SistemaTab />
          if (current === "history") return <HistoryTab />
          return <RulesTab />
        }}
      </With>
    </box>
  )

  return (
    <box orientation={Gtk.Orientation.VERTICAL} spacing={10} cssClasses={["sp-section"]} hexpand vexpand>
      {mostrarTitulo && <TituloSeccion titulo={textos.seccion.titulo} />}
      <With value={reglaEnEdicion}>
        {(regla: NotifRule | null) => regla
          ? <RuleEditor rule={regla} onClose={cerrarEdicionNotificacion} />
          : contenido() as unknown as any}
      </With>
    </box>
  )
}
