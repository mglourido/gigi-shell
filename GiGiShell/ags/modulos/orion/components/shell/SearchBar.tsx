// Campo de búsqueda de Orion. `focusSearchAndType` es el punto de entrada de
// "empezar a escribir enfoca la búsqueda" (ver el handler de teclado en
// `Orion.tsx`), de ahí que la referencia al `Gtk.Entry` se guarde a nivel de
// módulo en vez de pasarse como prop.

import { Gtk } from "ags/gtk4"
import { setQuery, orionVisible } from "../../state"

let _entry: Gtk.Entry | null = null

// La búsqueda corre síncrona en el bucle de GTK (escaneo de apps + reconstruir
// la lista reactiva), así que se debouncea: al teclear rápido solo se resuelve
// una vez que el texto se asienta, en vez de por pulsación.
const DEBOUNCE_MS = 80

export function focusSearchAndType(char: string) {
  if (!_entry) return
  _entry.text = _entry.text + char
  _entry.set_position(-1)
  _entry.grab_focus()
}

export default function SearchBar() {
  const entry = new Gtk.Entry()
  entry.set_css_classes(["search-input"])
  entry.placeholder_text = "Buscador inteligente"
  entry.hexpand = true
  _entry = entry

  let debounce: number | null = null
  function cancelarDebounce() {
    if (debounce !== null) { clearTimeout(debounce); debounce = null }
  }

  entry.connect("changed", () => {
    const texto = entry.text
    cancelarDebounce()
    // Vaciar es la salida rápida de la búsqueda (limpia resultados y vuelve a la
    // sección de origen); no interesa retrasarla ni un frame.
    if (!texto.trim()) { setQuery(texto); return }
    debounce = setTimeout(() => { debounce = null; setQuery(texto) }, DEBOUNCE_MS)
  })

  orionVisible.subscribe(() => {
    // Ninguna resolución pendiente debe dispararse a caballo entre sesiones.
    cancelarDebounce()
    // La búsqueda se conserva durante la salida para que el contenido no cambie
    // mientras Orion baja. Se limpia al comenzar la siguiente apertura.
    if (!orionVisible.get()) return
    entry.text = ""
    entry.grab_focus()
  })

  return (
    <box cssClasses={["search-zone"]}>
      <box cssClasses={["search-bar"]} hexpand>
        <image iconName="system-search-symbolic" pixelSize={13} cssClasses={["search-icon"]} />
        {entry}
      </box>
    </box>
  )
}
