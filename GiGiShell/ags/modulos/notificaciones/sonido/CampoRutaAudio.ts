// Campo «ruta del audio» compartido: entrada de texto + botón de prueba + aviso de ruta
// inexistente. Lo usan el editor de reglas (Ajustes > Notificaciones) y el formulario de alarmas.
//
// **Se teclea la ruta; no hay botón de examinar, y no es un olvido.** Las dos ventanas que montan
// este campo son superficies layer-shell en la capa OVERLAY: un diálogo de ficheros —tanto el
// `Gtk.FileDialog` propio como un `zenity` externo— es una ventana normal, y el compositor la
// dibuja POR DEBAJO de esa capa. El selector se abriría invisible e inalcanzable, con la sesión
// aparentemente colgada hasta cerrarlo a ciegas.
//
// Se construye con widgets sueltos y no con JSX reactivo a propósito: el formulario de alarmas es
// GTK imperativo (no se reconstruye con el foco dentro, ver `FormularioAlarma.tsx`) y así el mismo
// campo sirve en los dos sitios.
import { Gtk } from "ags/gtk4"
import { existeAudio, reproducirArchivo } from "./reproductor.ts"

export interface CampoRutaAudio {
  widget: Gtk.Widget
  /** Ruta actual, ya recortada. Cadena vacía = sin sonido propio. */
  obtener(): string
}

export function crearCampoRutaAudio(opciones: {
  valor?: string
  marcador: string
  etiquetaProbar: string
  ayudaProbar: string
  avisoNoExiste: string
  alCambiar?: (ruta: string) => void
}): CampoRutaAudio {
  const entrada = new Gtk.Entry({ text: opciones.valor ?? "", hexpand: true })
  entrada.set_css_classes(["re-entry"])
  entrada.set_placeholder_text(opciones.marcador)

  const aviso = new Gtk.Label({ label: opciones.avisoNoExiste, wrap: true, halign: Gtk.Align.START })
  aviso.set_css_classes(["re-hint", "aviso"])

  const probar = new Gtk.Button({ tooltipText: opciones.ayudaProbar })
  probar.set_css_classes(["re-seg"])
  probar.set_child(new Gtk.Label({ label: opciones.etiquetaProbar }))

  const obtener = () => entrada.get_text().trim()

  function revisar() {
    const ruta = obtener()
    // Solo se avisa de lo que está escrito y no existe: el campo vacío es la opción normal
    // («que suene lo que pida la app»), no un error a medio escribir.
    aviso.set_visible(ruta !== "" && !existeAudio(ruta))
    probar.set_sensitive(ruta !== "")
  }
  revisar()

  entrada.connect("changed", () => {
    revisar()
    opciones.alCambiar?.(obtener())
  })
  probar.connect("clicked", () => {
    const ruta = obtener()
    if (ruta !== "") reproducirArchivo(ruta)
  })

  const fila = new Gtk.Box({ spacing: 6 })
  fila.append(entrada)
  fila.append(probar)

  const caja = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 4 })
  caja.append(fila)
  caja.append(aviso)

  return { widget: caja as unknown as Gtk.Widget, obtener }
}
