// modulos/ajustes/disco/RutasPersonalizadas.tsx — los dos editores de rutas de «Liberar espacio»:
// las que el usuario quiere BORRAR y las que quiere SALVAR.
//
// Son el mismo widget con distinto verbo (`EditorDeRutas`), y comparten fichero a propósito: el
// único sitio donde de verdad se diferencian es el validador al que llaman y el texto, así que
// separarlos habría duplicado el componente entero para cambiar dos parámetros — con la garantía de
// que al retocar uno el otro se quedara atrás. La lista de protegidas es la respuesta a «no borres
// esto» sin tener que renunciar a limpiar la carpeta que lo contiene: el filtro desciende dentro de
// lo protegido en vez de saltárselo entero (ver `filtrar_protegidos` en lib/limpieza-rutas.sh).
//
// Es la única parte de Ajustes > Liberar espacio donde el usuario escribe el OBJETIVO de un borrado
// en vez de marcar una casilla, así que tiene dos particularidades que no comparte con el resto de
// la sección.
//
// ── 1. Valida llamando al script, no con una copia de las reglas en TypeScript ──────────────
// `limpiar-almacenamiento.sh --validar-ruta` / `--validar-protegida` usan exactamente los mismos
// `ruta_personalizada_valida` / `ruta_protegida_valida` que después gobiernan el borrado. Reimplementar el filtro aquí «para avisar antes» habría creado
// dos criterios que acaban discrepando, y discrepar aquí significa borrar algo que esta pantalla
// había dado por rechazado. El precio es un proceso por pulsación de «Añadir», que es un gesto
// deliberado y poco frecuente.
//
// ── 2. NO usa `<For>`, y la lista se reconstruye entera ─────────────────────
// `<For>` indexa por identidad de objeto y aquí los elementos son strings, así que técnicamente
// serviría; el motivo es otro. El patrón que mata en este repositorio es **reconstruir una lista
// que contiene el widget con el foco** (ver `servicios/pantalla/` y su SIGSEGV al editar franjas
// horarias). Aquí eso se evita por diseño y no por cuidado: el `Gtk.Entry` donde se escribe vive
// FUERA de la lista y nunca se reconstruye, y las filas son solo una etiqueta y un botón — no hay
// nada editable dentro que pueda tener el foco cuando la lista cambia.
import { Gtk } from "ags/gtk4"
import { With, createState, onCleanup, type Accessor } from "ags"
import GLib from "gi://GLib"
import { execAsync } from "ags/process"
import { BotonAjustes, TextoInformativo } from "../componentes"
import {
  anadirRutaPersonalizada, quitarRutaPersonalizada, rutasPersonalizadas,
  anadirRutaProtegida, quitarRutaProtegida, rutasProtegidas,
} from "../../../servicios/disco/preferencias"
import textos from "../../../textos/ajustes/almacenamiento.json" with { type: "json" }
import { formatearTexto } from "../../../textos/formatear"

const LIMPIAR = `${GLib.get_user_config_dir()}/hypr/scripts/limpiar-almacenamiento.sh`

type TextosLista = {
  titulo: string
  descripcion: string
  placeholder: string
  anadir: string
  quitar: string
  vacia: string
  invalida: string
  aviso: string
}

type Editor = {
  t: TextosLista
  /** Modo de `limpiar-almacenamiento.sh` que valida y canonicaliza. */
  validador: "--validar-ruta" | "--validar-protegida"
  rutas: Accessor<string[]>
  anadir: (ruta: string) => boolean
  quitar: (ruta: string) => void
  /** Clase del aviso final: rojo donde se borra, neutro donde se salva. */
  claseAviso: string
}

/** Las carpetas y archivos que se borrarán. */
export default function RutasPersonalizadas() {
  return (
    <EditorDeRutas
      t={textos.auto.rutas}
      validador="--validar-ruta"
      rutas={rutasPersonalizadas}
      anadir={anadirRutaPersonalizada}
      quitar={quitarRutaPersonalizada}
      claseAviso="alm-aviso"
    />
  )
}

/** Las que ninguna limpieza puede tocar. */
export function RutasProtegidas() {
  return (
    <EditorDeRutas
      t={textos.auto.protegidas}
      validador="--validar-protegida"
      rutas={rutasProtegidas}
      anadir={anadirRutaProtegida}
      quitar={quitarRutaProtegida}
      claseAviso="alm-nota"
    />
  )
}

function EditorDeRutas({ t, validador, rutas, anadir: guardar, quitar, claseAviso }: Editor) {
  const [error, setError] = createState("")
  let campo: Gtk.Entry | null = null

  // La validación es asíncrona y el usuario puede cerrar Ajustes mientras corre. Misma guarda que
  // el resto de la sección.
  let vivo = true
  onCleanup(() => { vivo = false })

  const anadir = () => {
    const escrito = campo?.get_text().trim() ?? ""
    if (!escrito) return
    execAsync([LIMPIAR, validador, escrito])
      .then(canonica => {
        if (!vivo) return
        // Se guarda la ruta CANÓNICA, no lo tecleado: así la lista no puede tener dos entradas que
        // son la misma carpeta escritas distinto (`~/x/` y `~/x/../x`), y lo que se ve es lo que
        // se va a vaciar. En la lista de protegidas es todavía menos opcional: lo que decide si
        // algo se salva es una comparación textual, y una ruta sin canonicalizar no casaría nunca.
        guardar(canonica.trim())
        setError("")
        campo?.set_text("")
      })
      .catch(e => {
        if (!vivo) return
        // El motivo viaja por stderr, que `execAsync` entrega como el mensaje del rechazo.
        const motivo = String(e).replace(/^Error:\s*/, "").trim()
        setError(formatearTexto(t.invalida, { motivo }))
      })
  }

  return (
    <box orientation={Gtk.Orientation.VERTICAL} spacing={8} cssClasses={["dev-row"]}>
      <label cssClasses={["sp-field-label"]} label={t.titulo} halign={Gtk.Align.START} />
      <TextoInformativo label={t.descripcion} wrap xalign={0} maxWidthChars={62} />

      <box spacing={6}>
        <entry
          cssClasses={["account-entry"]}
          placeholderText={t.placeholder}
          hexpand
          $={(self: Gtk.Entry) => { campo = self }}
          onActivate={anadir}
        />
        <BotonAjustes onClicked={anadir}>
          <label label={t.anadir} />
        </BotonAjustes>
      </box>

      {/* Ranura fija con `visible`, no un `<With>` que aparezca y desaparezca: así la caja del
          error no empuja la lista de abajo cada vez que te equivocas al teclear. */}
      <TextoInformativo
        cssClasses={["alm-resultado", "error"]}
        label={error}
        visible={error((e: string) => e.length > 0)}
        wrap
        xalign={0}
        maxWidthChars={60}
      />

      <With value={rutas}>
        {(lista: string[]) => lista.length === 0 ? (
          <TextoInformativo label={t.vacia} xalign={0} />
        ) : (
          <box orientation={Gtk.Orientation.VERTICAL} spacing={4}>
            {lista.map(ruta => (
              <box spacing={10} cssClasses={["alm-ruta"]} valign={Gtk.Align.CENTER}>
                {/* Recorte por el PRINCIPIO (Pango START = 1), no por el final como el resto del
                    shell: en `/home/x/proyectos/build/salida` lo que identifica la carpeta es el
                    final, y el `/home/x/` que comparten todas es justo lo prescindible. Con END se
                    quedaban varias filas leyéndose igual. El tooltip trae la ruta entera. */}
                <label
                  cssClasses={["alm-ruta-texto"]}
                  label={ruta}
                  halign={Gtk.Align.START}
                  hexpand
                  ellipsize={1}
                  tooltipText={ruta}
                />
                <BotonAjustes onClicked={() => quitar(ruta)}>
                  <label label={t.quitar} />
                </BotonAjustes>
              </box>
            ))}
          </box>
        )}
      </With>

      <TextoInformativo
        cssClasses={[claseAviso]}
        label={t.aviso}
        wrap
        xalign={0}
        maxWidthChars={62}
      />
    </box>
  )
}
