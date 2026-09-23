// modulos/notificaciones/settings/SettingsWindow.tsx
import app from "ags/gtk4/app"
import { Astal, Gtk, Gdk } from "ags/gtk4"
import { With } from "ags"
import { notifSettingsVisible, setNotifSettingsVisible } from "../store"
import SettingsTabs from "./SettingsTabs.tsx"
import textos from "../../../textos/ajustes/notificaciones.json" with { type: "json" }
import { clasesFondoShell } from "../../ajustes/preferences"
import { medidasLamina, seguirTamanoLamina } from "../../../utilidades/tamanoLamina"

// Tamaño de DISEÑO de la lámina: un techo que `medidasLamina` recorta a la pantalla, no un
// mínimo. Estaba como `min-width`/`min-height` en `.nsw-panel`, o sea un SUELO que GTK no
// baja: en un monitor pequeño la ventana no cabía y se salía. Mismo caso que
// `modulos/ajustes/SettingsPanel.tsx` — ver `utilidades/tamanoLamina.ts`.
const DISENO = { ancho: 760, alto: 620 }

export default function SettingsWindow(gdkmonitor: Gdk.Monitor) {
  const { TOP, BOTTOM, LEFT, RIGHT } = Astal.WindowAnchor
  const medidas = medidasLamina(gdkmonitor, DISENO)

  const panel = (
    <box
      cssClasses={["nsw-panel"]}
      orientation={Gtk.Orientation.VERTICAL}
      spacing={0}
      halign={Gtk.Align.CENTER}
      valign={Gtk.Align.CENTER}
      widthRequest={medidas.ancho}
      heightRequest={medidas.alto}
      $={seguirTamanoLamina(gdkmonitor, DISENO)}
    >
      <box cssClasses={["ns-header"]} spacing={8} valign={Gtk.Align.CENTER}>
        <label cssClasses={["ns-title"]} label={textos.seccion.tituloVentana} hexpand halign={Gtk.Align.START} />
      </box>
      <box vexpand>
        <With value={notifSettingsVisible}>
          {/* Sin título de sección: la cabecera de arriba ya dice «Ajustes de notificaciones». */}
          {(v: boolean) => v ? <SettingsTabs mostrarTitulo={false} /> : <box />}
        </With>
      </box>
    </box>
  ) as unknown as Gtk.Widget

  return (
    <window
      name="notification-settings"
      visible={notifSettingsVisible}
      gdkmonitor={gdkmonitor}
      layer={Astal.Layer.OVERLAY}
      anchor={TOP | BOTTOM | LEFT | RIGHT}
      exclusivity={Astal.Exclusivity.IGNORE}
      keymode={Astal.Keymode.ON_DEMAND}
      application={app}
      cssClasses={clasesFondoShell("nsw-window")}
    >
      <Gtk.EventControllerKey
        onKeyPressed={(_self, keyval) => {
          if (keyval === Gdk.KEY_Escape) { setNotifSettingsVisible(false); return true }
          return false
        }}
      />
      <box cssClasses={["nsw-backdrop"]} hexpand vexpand>
        <Gtk.GestureClick
          onPressed={(self: Gtk.GestureClick, _n: number, x: number, y: number) => {
            const backdrop = self.get_widget() as Gtk.Widget
            const hit = backdrop.pick(x, y, 0)
            let w: Gtk.Widget | null = hit
            while (w && w !== backdrop) {
              if (w === panel) return
              w = w.get_parent()
            }
            setNotifSettingsVisible(false)
          }}
        />
        {panel as unknown as any}
      </box>
    </window>
  )
}
