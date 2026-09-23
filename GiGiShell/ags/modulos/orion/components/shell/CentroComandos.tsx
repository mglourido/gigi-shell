import { Gtk } from "ags/gtk4"
import SectionIndex from "./SectionIndex"
import SearchBar from "./SearchBar"

// Superficie única para navegar y buscar sin duplicar fondos ni bordes.
export default function CentroComandos() {
  return (
    <box cssClasses={["centro-comandos-container"]}>
      <box
        cssClasses={["centro-comandos"]}
        orientation={Gtk.Orientation.VERTICAL}
        hexpand
      >
        <SectionIndex />
        <SearchBar />
      </box>
    </box>
  )
}
