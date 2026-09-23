// Lista editable de CLASES DE VENTANA, compartida por las dos preferencias de Ajustes
// que dejan al usuario apuntar apps a mano: el No molestar automático
// (`personalizacion/AjusteNoMolestarAutomatico.tsx`) y la pausa de la luz nocturna
// (`juegos/SeccionJuegos.tsx`). La comparación que luego hacen con estas cadenas es
// también común: `servicios/ventanas/coincidenciaClases.ts`.
//
// El botón "ventana actual" no es un adorno: sin él, añadir una app obliga a salir a una
// terminal a mirar `hyprctl clients` para averiguar su clase, que es justo el paso que
// deja la función sin usar.
import { For } from "ags"
import { Gtk } from "ags/gtk4"
import AstalHyprland from "gi://AstalHyprland"
import { PANTALLA_COMPLETA_REAL } from "../../../servicios/juegos/deteccion"
import TextoInformativo from "./TextoInformativo"
import TituloSubseccion from "./TituloSubseccion"

export interface TextosListaClases {
  titulo: string
  ayuda: string
  vacia: string
  placeholder: string
  anadir: string
  quitar: string
  ventana: string
  anadirVentana: string
}

type PropiedadesListaClasesVentana = {
  clases: any                              // accessor de string[]
  alAnadir: (clase: string) => void
  alQuitar: (clase: string) => void
  textos: TextosListaClases
  visible?: any
  /** Al pulsar "ventana actual", tomar la que esté a pantalla completa antes que la
   *  enfocada. Lo quiere el No molestar automático, cuya condición ES la pantalla
   *  completa; para una lista que solo mira "está abierta", la enfocada es la correcta. */
  preferirPantallaCompleta?: boolean
}

/** Fila de una clase configurada: el texto + botón de borrar. */
function FilaClase({ clase, alQuitar, quitar }: { clase: string; alQuitar: (c: string) => void; quitar: string }) {
  return (
    <box spacing={5} valign={Gtk.Align.CENTER} cssClasses={["sp-rule-row"]}>
      <label cssClasses={["sp-clase-nombre"]} label={clase} halign={Gtk.Align.START} ellipsize={3} />
      <box hexpand />
      <button
        cssClasses={["sp-rule-del"]}
        onClicked={() => alQuitar(clase)}
        valign={Gtk.Align.CENTER}
        tooltipText={quitar}
      >
        <label label="󰅖" />
      </button>
    </box>
  )
}

export default function ListaClasesVentana({
  clases,
  alAnadir,
  alQuitar,
  textos,
  visible = true,
  preferirPantallaCompleta = false,
}: PropiedadesListaClasesVentana) {
  let entrada: Gtk.Entry

  const anadirEscrito = () => {
    if (!entrada) return
    const valor = entrada.get_text().trim()
    if (!valor) return
    alAnadir(valor)
    entrada.set_text("")
  }

  // Añade la clase de la ventana que interesa, sin salir a buscarla con hyprctl.
  const anadirActual = () => {
    const hypr = AstalHyprland.get_default()
    const clientes = hypr.get_clients?.() ?? []
    // `fullscreen` es un MODO (0 nada, 1 maximizado, 2 pantalla completa), no un bool:
    // con `!== 0` se cogería cualquier ventana maximizada por delante de la enfocada.
    const aPantallaCompleta = preferirPantallaCompleta
      ? clientes.find((c: any) => (c.fullscreen ?? 0) >= PANTALLA_COMPLETA_REAL)
      : null
    const objetivo = aPantallaCompleta ?? hypr.focusedClient
    const clase = (objetivo?.class ?? "").trim()
    if (clase) alAnadir(clase)
  }

  return (
    <box orientation={Gtk.Orientation.VERTICAL} spacing={6} cssClasses={["sp-clases"]} visible={visible}>
      <TituloSubseccion label={textos.titulo} halign={Gtk.Align.START} />
      <TextoInformativo label={textos.ayuda} halign={Gtk.Align.START} wrap maxWidthChars={62} xalign={0} />

      <box orientation={Gtk.Orientation.VERTICAL} spacing={2}>
        <For each={clases}>
          {(clase: string) => <FilaClase clase={clase} alQuitar={alQuitar} quitar={textos.quitar} />}
        </For>
      </box>

      <TextoInformativo
        label={textos.vacia}
        halign={Gtk.Align.START}
        visible={clases((lista: string[]) => lista.length === 0)}
      />

      <box spacing={6} valign={Gtk.Align.CENTER}>
        <entry
          cssClasses={["sp-num-input", "sp-clase-entrada"]}
          hexpand
          xalign={0}
          placeholderText={textos.placeholder}
          $={(self: Gtk.Entry) => { entrada = self }}
          onActivate={anadirEscrito}
        />
        <button cssClasses={["sp-add-rule"]} onClicked={anadirEscrito} valign={Gtk.Align.CENTER}>
          <label label={textos.anadir} />
        </button>
        <button
          cssClasses={["sp-add-rule"]}
          onClicked={anadirActual}
          valign={Gtk.Align.CENTER}
          tooltipText={textos.anadirVentana}
        >
          <label label={`󰊓 ${textos.ventana}`} />
        </button>
      </box>
    </box>
  )
}
