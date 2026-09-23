// Ajustes > Atajos de teclado. Es la MISMA lista que la sección "Atajos" de Orion
// (`modulos/orion/components/sections/KeybindsSection.tsx`), aquí para quien tenga Orion
// desactivado: sin este destino los atajos solo se podían consultar abriendo el launcher.
//
// La fuente de datos NO se duplica: se reutiliza el estado reactivo `keybinds` de
// `modulos/orion/data/keybinds.ts`, que parsea `hypr/gigios/keybinds.lua` y se re-parsea
// solo cuando ese fichero cambia en disco. Ese módulo ya se carga al arrancar el shell
// (`app.ts` importa Orion siempre, y su buscador usa `getKeybinds`), así que este destino
// no añade ni un `Gio.FileMonitor` más ni depende de que Orion esté activado.
//
// Lo que sí es propio de aquí es el buscador: Orion filtra contra su `searchQuery` global,
// que en Ajustes no existe. El `<entry>` vive FUERA de la lista y nunca se reconstruye
// (misma precaución que `RutasPersonalizadas.tsx`: reconstruir el contenedor del widget con
// el foco mientras se escribe es el camino corto al SIGSEGV de GTK4).
import { Gtk } from "ags/gtk4"
import Pango from "gi://Pango"
import { For, createComputed, createState } from "ags"
import { TarjetaAjustes, TextoInformativo, TituloSeccion } from "../componentes"
import { keybinds, type KeybindGroup } from "../../orion/data/keybinds"
import textos from "../../../textos/ajustes/atajos.json" with { type: "json" }
import { formatearTexto } from "../../../textos/formatear"

/** Una fila de la lista: o el título de un grupo, o un atajo. Se aplana para que
 *  `<For>` pueda llevar UNA clave estable por fila (ver el `id` más abajo). */
type Fila =
  | { id: string; tipo: "grupo"; texto: string }
  | { id: string; tipo: "atajo"; binding: string; descripcion: string }

function filtrar(grupos: KeybindGroup[], consulta: string): Fila[] {
  const q = consulta.trim().toLowerCase()
  const filas: Fila[] = []
  for (const grupo of grupos) {
    const binds = q
      ? grupo.binds.filter(kb =>
          kb.description.toLowerCase().includes(q) || kb.binding.toLowerCase().includes(q))
      : grupo.binds
    if (binds.length === 0) continue
    filas.push({ id: `g:${grupo.name}`, tipo: "grupo", texto: grupo.name })
    // La combinación es única en toda la configuración (el parser descarta
    // repetidas), así que sirve de clave sin prefijar por grupo.
    for (const kb of binds) {
      filas.push({ id: `k:${kb.binding}`, tipo: "atajo", binding: kb.binding, descripcion: kb.description })
    }
  }
  return filas
}

export default function SeccionAtajos() {
  const [consulta, setConsulta] = createState("")

  const filas = createComputed([keybinds, consulta], filtrar)
  const totales = createComputed([keybinds], (grupos: KeybindGroup[]) =>
    formatearTexto(textos.lista.totales, {
      atajos: grupos.reduce((suma, g) => suma + g.binds.length, 0),
      grupos: grupos.length,
    }))
  // Dos vacíos distintos: sin atajos en absoluto (el .lua no se pudo leer) o sin
  // coincidencias para lo tecleado. Decir "sin resultados" en el primer caso mandaría
  // a buscar otra cosa en una lista que nunca va a tener nada.
  const aviso = createComputed([keybinds, filas], (grupos: KeybindGroup[], visibles: Fila[]) => {
    if (grupos.length === 0) return textos.lista.sinDatos
    return visibles.length === 0 ? textos.lista.vacia : ""
  })

  return (
    <box orientation={Gtk.Orientation.VERTICAL} spacing={14} cssClasses={["sp-section", "dev-section"]} hexpand>
      <TituloSeccion titulo={textos.seccion.titulo} />
      <TarjetaAjustes titulo={textos.grupos.lista} icono="󰘳">
        <box orientation={Gtk.Orientation.VERTICAL} spacing={8} cssClasses={["dev-row"]}>
          <TextoInformativo label={textos.lista.descripcion} wrap xalign={0} maxWidthChars={62} />
          <label cssClasses={["kb-totales"]} halign={Gtk.Align.START} label={totales} />
          <entry
            cssClasses={["account-entry", "kb-buscador"]}
            placeholderText={textos.lista.buscar}
            hexpand
            onChanged={(self: Gtk.Entry) => setConsulta(self.text)}
          />
        </box>

        <box orientation={Gtk.Orientation.VERTICAL} cssClasses={["kb-lista"]}>
          {/* `id` por fila: sin él `<For>` indexa por identidad de objeto y cada pulsación
              en el buscador reconstruiría las ~70 filas enteras — el fallo que documenta la
              barra en el CLAUDE.md de ags y que ya evita el buscador de Almacenamiento. */}
          <For each={filas} id={(fila: Fila) => fila.id}>
            {(fila: Fila) => fila.tipo === "grupo"
              ? <label cssClasses={["kb-ajustes-grupo"]} label={fila.texto} halign={Gtk.Align.START} />
              : (
                <box cssClasses={["kb-ajustes-fila"]} spacing={12} valign={Gtk.Align.CENTER}>
                  <label
                    cssClasses={["kb-ajustes-tecla"]}
                    label={fila.binding}
                    halign={Gtk.Align.START}
                    xalign={0}
                  />
                  {/* Una línea con puntos suspensivos, NO `wrap`: envolviendo, la descripción
                      partía en dos casi todas las filas y la lista se iba al doble de alto (una
                      etiqueta que envuelve pide de ancho mínimo su palabra más larga, así que
                      dentro del ScrolledWindow se le queda la columna estrecha). Es también lo
                      que hace Orion en su sección de atajos. */}
                  <label
                    cssClasses={["kb-ajustes-desc"]}
                    label={fila.descripcion}
                    halign={Gtk.Align.START}
                    hexpand
                    xalign={0}
                    ellipsize={Pango.EllipsizeMode.END}
                    tooltipText={fila.descripcion}
                  />
                </box>
              )}
          </For>
          <label
            cssClasses={["kb-ajustes-vacia"]}
            label={aviso}
            visible={aviso((texto: string) => texto !== "")}
            halign={Gtk.Align.CENTER}
            wrap
          />
        </box>
      </TarjetaAjustes>
    </box>
  )
}
