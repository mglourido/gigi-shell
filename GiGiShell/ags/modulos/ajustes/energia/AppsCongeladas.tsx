// modulos/ajustes/energia/AppsCongeladas.tsx — el allowlist de apps que congela la
// suspensión falsa (Ajustes > Energía).
//
// ── Por qué esto tiene tarjeta propia y tanto texto de aviso ───────────────────────────
// Es lo ÚNICO de toda la suspensión falsa que puede perder datos del usuario. Una app
// congelada con la red viva cierra su ventana TCP y su descarga muere por timeout — o sea,
// exactamente el fallo que la suspensión falsa existe para evitar, reintroducido por la
// puerta de atrás. Por eso la lista nace vacía, no se llena por heurística y el aviso va
// arriba del todo y no escondido en un tooltip. Ver `docs/suspension-falsa.md`,
// «Congelar apps del usuario».
//
// ── Lo que se guarda es el NOMBRE, y los candidatos son solo una ayuda ─────────────────
// El scope de systemd lleva el pid en el nombre (`app-discord-17743.scope`), así que
// guardar la unidad sería guardar algo que caduca al cerrar la app. Se guarda `discord` y
// el scope se resuelve en el momento de congelar. Que una app no salga en «apps abiertas
// ahora» no impide ponerla: el campo de texto libre es el camino principal, la lista de
// candidatos existe solo para no tener que salir a una terminal a mirar cómo se llama —
// que es justo el paso que deja una función así sin usar (mismo razonamiento que el botón
// «ventana actual» de `componentes/ListaClasesVentana.tsx`).
//
// ── Los candidatos se piden UNA vez por visita, no en cada tecla ───────────────────────
// `refrescar()` corre al construir la tarjeta y desde su botón. La sección se construye al
// abrirla y se desmonta al cerrar Ajustes, así que ese "una vez" es una vez por visita.
// Sondear sería meter un subproceso en el camino de escribir, y la lista de scopes cambia
// poco: para lo que cambia, está el botón.
//
// ── El Gtk.Entry vive FUERA de cualquier lista que se reconstruya ──────────────────────
// Misma precaución que documentan `inicio/SeccionAppsInicio.tsx` y
// `disco/RutasPersonalizadas.tsx`: en este repositorio, reconstruir una lista que contiene
// el widget con el foco acaba en SIGSEGV, no en un warning.

import { For, createState } from "ags"
import { Gtk } from "ags/gtk4"
import { execAsync } from "ags/process"
import { BotonAjustes, TarjetaAjustes, TextoInformativo, TituloSubseccion } from "../componentes"
import { esAppProhibida, nombresDeScopes } from "./scopesApps"
import { sfAppsCongeladas, setSfAppsCongeladas } from "../../../servicios/energia/powerState.ts"
import textos from "../../../textos/ajustes/energia.json" with { type: "json" }
import { formatearTexto } from "../../../textos/formatear"

/** Fila de una app ya guardada: el nombre y el botón de quitar. */
function FilaApp({ nombre }: { nombre: string }) {
  return (
    <box spacing={5} valign={Gtk.Align.CENTER} cssClasses={["sp-rule-row"]}>
      <label cssClasses={["sp-clase-nombre"]} label={nombre} halign={Gtk.Align.START} ellipsize={3} />
      <box hexpand />
      <button
        cssClasses={["sp-rule-del"]}
        valign={Gtk.Align.CENTER}
        tooltipText={textos.suspensionFalsa.apps.quitar}
        onClicked={() => setSfAppsCongeladas(sfAppsCongeladas.get().filter((a) => a !== nombre))}
      >
        <label label="󰅖" />
      </button>
    </box>
  )
}

export default function AppsCongeladas() {
  const [candidatos, fijarCandidatos] = createState<string[]>([])
  // Mensaje de rechazo. Es un estado y no un `print`: si añadir un nombre no hace nada y
  // no dice por qué, el usuario repite el gesto convencido de que la UI está rota.
  const [rechazo, fijarRechazo] = createState("")
  let entrada: Gtk.Entry

  const refrescar = () => {
    execAsync([
      "systemctl", "--user", "list-units", "--type=scope",
      "--no-legend", "--plain", "--no-pager",
    ])
      .then((salida) => fijarCandidatos(nombresDeScopes(salida)))
      // Sin systemctl (o con la sesión sin scopes) la lista se queda vacía y el campo de
      // texto libre sigue funcionando: sugerir es un extra, no el camino.
      .catch(() => fijarCandidatos([]))
  }
  refrescar()

  const anadir = (bruto: string) => {
    const nombre = bruto.trim()
    if (!nombre) return
    if (esAppProhibida(nombre)) {
      fijarRechazo(formatearTexto(textos.suspensionFalsa.apps.prohibida, { nombre }))
      return
    }
    fijarRechazo("")
    const lista = sfAppsCongeladas.get()
    if (lista.includes(nombre)) return
    setSfAppsCongeladas([...lista, nombre])
  }

  const anadirEscrito = () => {
    if (!entrada) return
    anadir(entrada.get_text())
    // Se limpia siempre, también tras un rechazo: el mensaje ya explica lo ocurrido y
    // dejar el texto invita a pulsar otra vez esperando otro resultado.
    entrada.set_text("")
  }

  return (
    <TarjetaAjustes titulo={textos.grupos.suspensionFalsaApps} icono="󰉼">
      <box orientation={Gtk.Orientation.VERTICAL} spacing={6} cssClasses={["dev-row"]} hexpand>
        <TextoInformativo label={textos.suspensionFalsa.apps.descripcion} maxWidthChars={62} />
        <TextoInformativo
          label={textos.suspensionFalsa.apps.aviso}
          cssClasses={["sp-field-hint-warn"]}
          maxWidthChars={62}
        />
      </box>

      <box orientation={Gtk.Orientation.VERTICAL} spacing={6} cssClasses={["dev-row"]} hexpand>
        <TituloSubseccion label={textos.suspensionFalsa.apps.titulo} />
        <TextoInformativo label={textos.suspensionFalsa.apps.ayuda} maxWidthChars={62} />

        <box orientation={Gtk.Orientation.VERTICAL} spacing={2}>
          {/* Indexado por el propio nombre: la lista es de cadenas y el nombre es único
              (el setter deduplica), así que es la clave natural y quitar una entrada no
              reconstruye las demás. */}
          <For each={sfAppsCongeladas} id={(nombre: string) => nombre}>
            {(nombre: string) => <FilaApp nombre={nombre} />}
          </For>
        </box>

        <TextoInformativo
          label={textos.suspensionFalsa.apps.vacia}
          visible={sfAppsCongeladas((lista: string[]) => lista.length === 0)}
        />

        <box spacing={6} valign={Gtk.Align.CENTER}>
          <entry
            cssClasses={["sp-num-input", "sp-clase-entrada"]}
            hexpand
            xalign={0}
            placeholderText={textos.suspensionFalsa.apps.placeholder}
            $={(self: Gtk.Entry) => { entrada = self }}
            onActivate={anadirEscrito}
          />
          <button cssClasses={["sp-add-rule"]} onClicked={anadirEscrito} valign={Gtk.Align.CENTER}>
            <label label={textos.suspensionFalsa.apps.anadir} />
          </button>
        </box>

        <TextoInformativo
          label={rechazo}
          cssClasses={["sp-field-hint-warn"]}
          visible={rechazo((m: string) => m !== "")}
          maxWidthChars={62}
        />
      </box>

      <box orientation={Gtk.Orientation.VERTICAL} spacing={6} cssClasses={["dev-row"]} hexpand>
        <box spacing={8} valign={Gtk.Align.CENTER}>
          <TituloSubseccion label={textos.suspensionFalsa.apps.candidatos} hexpand />
          <BotonAjustes tooltipText={textos.suspensionFalsa.apps.actualizar} onClicked={refrescar}>
            <label label="󰑐" />
          </BotonAjustes>
        </box>
        <TextoInformativo label={textos.suspensionFalsa.apps.candidatosAyuda} maxWidthChars={62} />

        <box orientation={Gtk.Orientation.VERTICAL} spacing={2}>
          <For each={candidatos} id={(nombre: string) => nombre}>
            {(nombre: string) => (
              <box spacing={5} valign={Gtk.Align.CENTER} cssClasses={["sp-rule-row"]}>
                <label cssClasses={["sp-clase-nombre"]} label={nombre} halign={Gtk.Align.START} ellipsize={3} />
                <box hexpand />
                {/* El botón se apaga cuando la app ya está guardada Y cuando es una de las
                    que nunca deben congelarse: enseñarla igual (sale en la lista de
                    scopes) pero sin poder añadirla es más honesto que esconderla y dejar
                    que el usuario la escriba a mano en el campo de arriba. */}
                <BotonAjustes
                  tooltipText={sfAppsCongeladas((lista: string[]) =>
                    esAppProhibida(nombre)
                      ? formatearTexto(textos.suspensionFalsa.apps.prohibida, { nombre })
                      : lista.includes(nombre)
                        ? textos.suspensionFalsa.apps.yaEsta
                        : textos.suspensionFalsa.apps.anadir)}
                  sensitive={sfAppsCongeladas((lista: string[]) =>
                    !lista.includes(nombre) && !esAppProhibida(nombre))}
                  onClicked={() => anadir(nombre)}
                >
                  <label label="󰐕" />
                </BotonAjustes>
              </box>
            )}
          </For>
        </box>

        <TextoInformativo
          label={textos.suspensionFalsa.apps.sinCandidatos}
          visible={candidatos((lista: string[]) => lista.length === 0)}
        />
      </box>
    </TarjetaAjustes>
  )
}
