import { createState, type Accessor } from "ags"
import { Gtk, Gdk } from "ags/gtk4"
import { espacioDisponible, seguirGeometriaMonitor } from "../../../utilidades/tamanoLamina"
import {
  ITEMS_NAVEGACION, SECCIONES_POR_ID, esGrupo,
  type IdSeccion, type SeccionNavegacion,
} from "./secciones.tsx"
import textos from "../../../textos/ajustes/general.json" with { type: "json" }

// Lo que rodea a la lista dentro de `.sp-nav`: padding vertical (16+16), el título y el
// espaciado. Se descuenta del alto de pantalla para que el techo de la lista sea el alto
// que de verdad le queda.
const MARCO_NAV = 76

function FilaDestino({
  destino, seccion, seleccionar, indentado,
}: {
  destino: SeccionNavegacion
  seccion: Accessor<IdSeccion>
  seleccionar: (seccion: IdSeccion) => void
  indentado?: boolean
}) {
  const clasesFila = indentado ? ["sp-nav-item", "sp-nav-item-hijo"] : ["sp-nav-item"]
  return (
    <button
      cssClasses={seccion((actual) =>
        actual === destino.id ? [...clasesFila, "active"] : clasesFila)}
      // Destinos que solo existen en algunas máquinas (ver `visible` en
      // `secciones.tsx`). Se ocultan, NO se filtran de la lista: un
      // botón invisible en GTK4 no ocupa sitio ni se puede pulsar, y
      // así el accessor puede encenderlo en caliente —enchufar una
      // webcam con Ajustes abierto— sin reconstruir la nav entera.
      visible={destino.visible ?? true}
      onClicked={() => seleccionar(destino.id)}
      valign={Gtk.Align.CENTER}
      overflow={Gtk.Overflow.VISIBLE}
    >
      <box
        cssClasses={["sp-nav-content"]}
        spacing={10}
        valign={Gtk.Align.CENTER}
        heightRequest={24}
        overflow={Gtk.Overflow.VISIBLE}
      >
        <label
          cssClasses={["sp-nav-icon"]}
          label={destino.icon}
          valign={Gtk.Align.CENTER}
          heightRequest={22}
          overflow={Gtk.Overflow.VISIBLE}
        />
        <label
          cssClasses={["sp-nav-label"]}
          label={destino.label}
          hexpand
          halign={Gtk.Align.START}
          valign={Gtk.Align.CENTER}
          heightRequest={22}
          overflow={Gtk.Overflow.VISIBLE}
        />
      </box>
    </button>
  )
}

export default function NavegacionAjustes({
  seccion,
  seleccionar,
  gdkmonitor,
}: {
  seccion: Accessor<IdSeccion>
  seleccionar: (seccion: IdSeccion) => void
  gdkmonitor: Gdk.Monitor
}) {
  let lista: Gtk.ScrolledWindow | undefined
  // El alto del panel lo estira ESTA lista, no la sección abierta: la nav es lo único
  // constante entre secciones, así que el panel deja de cambiar de tamaño al navegar. El
  // techo es lo que quepa en la pantalla; a partir de ahí la lista se desplaza.
  const aplicarTecho = () => {
    lista?.set_max_content_height(Math.max(1, espacioDisponible(gdkmonitor).alto - MARCO_NAV))
  }

  // Snapshot al construir la nav (una vez por ventana/monitor, como `seccion`
  // misma): decide solo qué grupo arranca desplegado, el que contiene la
  // sección activa, para que reabrir Ajustes no la deje escondida detrás de
  // un acordeón cerrado. No se vuelve a leer después.
  const seccionInicial = seccion.get()

  return (
    // `hexpand={false}` EXPLÍCITO, y es obligatorio: en GTK4 el hexpand de un hijo sube
    // por sus ancestros salvo que uno lo fije a la fuerza, y las etiquetas de las entradas
    // lo llevan (es lo que alinea el texto a la izquierda del glifo). Sin esto la nav
    // «expandía» igual que el contenido y se repartía con él todo el ancho sobrante del
    // panel: los botones pasaban de sus ~225 px a más del doble. No se notaba mientras el
    // contenido pedía un mínimo mayor que el panel, porque entonces no sobraba nada que
    // repartir. La nav mide lo que miden sus etiquetas y ahí se queda.
    <box cssClasses={["sp-nav"]} orientation={Gtk.Orientation.VERTICAL} spacing={4} hexpand={false}>
      <label cssClasses={["sp-nav-title"]} label={textos.panel.titulo} halign={Gtk.Align.START} />
      {/* La lista vertical va en EXTERNAL, no en NEVER: con NEVER, GTK4 suma la altura
          MÍNIMA de las entradas a lo que pide el panel, así que la lista no
          se desplazaba nunca y encima imponía un alto de panel imposible en pantallas
          normales. Con EXTERNAL sube el NATURAL —acotado por `maxContentHeight`—, que es
          justo lo que se quiere: el panel se estira para enseñar la nav entera mientras
          quepa, y cuando no cabe la lista se desplaza. No dibuja barra. El ancho sí sigue
          en NEVER: la nav debe medir lo que miden sus etiquetas, y es estático. */}
      <Gtk.ScrolledWindow
        cssClasses={["sp-nav-scroll"]}
        $={(self: Gtk.ScrolledWindow) => {
          lista = self
          aplicarTecho()
          seguirGeometriaMonitor(gdkmonitor, aplicarTecho)(self)
        }}
        vexpand
        propagateNaturalHeight
        hscrollbarPolicy={Gtk.PolicyType.NEVER}
        vscrollbarPolicy={Gtk.PolicyType.EXTERNAL}
      >
        <box orientation={Gtk.Orientation.VERTICAL} spacing={2}>
          {ITEMS_NAVEGACION.map((item) => {
            if (!esGrupo(item)) {
              return <FilaDestino destino={item} seccion={seccion} seleccionar={seleccionar} />
            }

            const grupo = item
            const [abierto, setAbierto] = createState(grupo.hijos.includes(seccionInicial))

            return (
              <box orientation={Gtk.Orientation.VERTICAL} spacing={2}>
                <button
                  cssClasses={["sp-nav-item", "sp-nav-item-grupo"]}
                  onClicked={() => setAbierto(!abierto.get())}
                  valign={Gtk.Align.CENTER}
                  overflow={Gtk.Overflow.VISIBLE}
                >
                  <box
                    cssClasses={["sp-nav-content"]}
                    spacing={10}
                    valign={Gtk.Align.CENTER}
                    heightRequest={24}
                    overflow={Gtk.Overflow.VISIBLE}
                  >
                    <label cssClasses={["sp-nav-icon"]} label={grupo.icon} valign={Gtk.Align.CENTER} heightRequest={22} overflow={Gtk.Overflow.VISIBLE} />
                    <label cssClasses={["sp-nav-label"]} label={grupo.label} hexpand halign={Gtk.Align.START} valign={Gtk.Align.CENTER} heightRequest={22} overflow={Gtk.Overflow.VISIBLE} />
                    <label cssClasses={["sp-nav-chevron"]} label={abierto((a: boolean) => a ? "▾" : "▸")} valign={Gtk.Align.CENTER} />
                  </box>
                </button>
                <box orientation={Gtk.Orientation.VERTICAL} spacing={2} visible={abierto}>
                  {grupo.hijos.map((idHijo) => (
                    <FilaDestino
                      destino={SECCIONES_POR_ID[idHijo]}
                      seccion={seccion}
                      seleccionar={seleccionar}
                      indentado
                    />
                  ))}
                </box>
              </box>
            )
          })}
        </box>
      </Gtk.ScrolledWindow>
    </box>
  )
}
