import { Gtk } from "ags/gtk4"
import AutoDndSetting from "../../ajustes/AutoDndSetting"
import DuracionPopupsSetting from "../../ajustes/DuracionPopupsSetting"

/** Preferencias generales que afectan a la entrega de los avisos. */
export default function GeneralTab() {
  return (
    <box orientation={Gtk.Orientation.VERTICAL} spacing={10} hexpand>
      <DuracionPopupsSetting />
      <AutoDndSetting />
    </box>
  )
}
