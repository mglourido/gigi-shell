// modulos/ajustes/camara/SeccionCamara.tsx — Ajustes > Cámara.
//
// La vista amplia y explicativa que complementa al panel rápido: qué cámaras
// hay, qué resoluciones dan, cuál prefiere GiGiShell y —lo que de verdad justifica
// la sección— los controles de imagen del aparato, generados de lo que publique
// su firmware y REPUESTOS en cada arranque.
//
// Todo lo de sistema vive en `servicios/camara/`; aquí no se enumera, ni se
// parsea, ni se persiste nada a mano.
//
// ── LA UI SE GENERA, NO SE ESCRIBE ──────────────────────────────────────────
// No hay ni un slider fijo. El juego de controles y sus rangos los decide el
// firmware (`brightness` va de 0..255 en unas cámaras y de -64..64 en otras), y
// `v4l2-ctl --set-ctrl` ACOTA EN SILENCIO: un slider 0..100 mandando el valor
// tal cual movería la imagen en el primer tramo y no haría nada en el resto,
// sin dar un solo error. Ver la cabecera de `servicios/camara/controlesDatos.ts`.
//
// ── TRES TRAMPAS QUE ESTA SECCIÓN TIENE QUE ESQUIVAR ────────────────────────
// 1. **`inactivo`**: un control encadenado a un automático encendido acepta la
//    escritura, devuelve 0 y NO cambia. El mando se deshabilita y se dice por
//    qué, en vez de dejar arrastrar algo que no hace nada.
// 2. **Releer tras escribir**: encender un automático cambia el `inactivo` de
//    OTROS controles, y el valor final puede no ser el pedido (acotado al paso).
//    Toda escritura termina en una relectura del aparato.
// 3. **Un proceso por escritura**: `v4l2-ctl` es un `execAsync` cada vez. El
//    arrastre de un slider se estrangula (ver `MS_ARRASTRE`) y solo se PERSISTE
//    al soltar; escribir el JSON 60 veces por segundo no aporta nada.
import { For, With, createComputed, createState, type Accessor } from "ags"
import { Gtk } from "ags/gtk4"
import GLib from "gi://GLib"
import Interruptor from "../../../componentes/Interruptor"
import {
  alternarBloqueo, bloqueoDisponible, bloqueoOcupado, camaraBloqueada,
} from "../../../servicios/camara/bloqueo"
import { DisplaySelect } from "../../../servicios/pantalla/controls"
import { conectarCambioDeslizador } from "../../../utilidades/deslizador"
import { crearCicloVida } from "../../../utilidades/cicloVida"
import {
  BotonAjustes, EncabezadoAjuste, TarjetaAjustes, TextoInformativo,
  TituloAjuste, TituloSeccion,
} from "../componentes"
import { camaras, camaraPorClave, type Camara } from "../../../servicios/camara/dispositivos"
import {
  etiquetaControl, fijarControl, leerControles, restablecerControles, type Control,
} from "../../../servicios/camara/controles"
import { leerFormatos, resolucionMaxima } from "../../../servicios/camara/formatos"
import {
  camaraPreferida, estadoCamara, fijarPreferida, olvidarCamara, recordarControl,
} from "../../../servicios/camara/persistencia"
import { abrirVistaPrevia, cerrarVistaPrevia } from "../../../servicios/camara/vistaPrevia"
import { camaraEnUso } from "../../../servicios/camara/uso"
import { ajustarAlPaso, camarasConocidas, resumenFormatos, type CamaraConocida } from "./camaraDatos"
import TarjetaGestos from "./TarjetaGestos"
import textos from "../../../textos/ajustes/camara.json" with { type: "json" }
import { formatearTexto } from "../../../textos/formatear"

/** Coalescencia del arrastre: como mucho una escritura cada tanto. Por debajo
 *  de ~100 ms se encadenan procesos `v4l2-ctl` más rápido de lo que terminan. */
const MS_ARRASTRE = 120
/** Silencio que se considera «ha soltado el deslizador». Solo entonces se
 *  persiste y se relee: hacerlo en cada píxel reescribiría `camara.json` a
 *  ritmo de vídeo y despertaría a cualquiera que lo esté monitorizando. */
const MS_POSAR = 400

// ── Ficha de formatos ───────────────────────────────────────────────────────

/**
 * La línea "MJPG hasta 1920x1080 · YUYV hasta 1280x720".
 *
 * **Es informativa a propósito y no hay ningún desplegable que la acompañe.**
 * La resolución y los fps los negocia la APP al abrir el stream
 * (`VIDIOC_S_FMT`); no existe ningún ajuste persistente que imponer desde
 * fuera, así que un selector aquí sería un mando que no hace nada. El porqué
 * completo está en la cabecera de `servicios/camara/formatosDatos.ts`.
 *
 * Se lee UNA vez por fila: la fila va con `<For id>` y no se reconstruye, y los
 * formatos que publica una cámara no cambian mientras esté enchufada.
 */
function FichaFormatos({ nodo }: { nodo: string }) {
  const [ficha, setFicha] = createState(textos.lista.cargandoFormatos)
  let vivo = true
  const ciclo = crearCicloVida()
  ciclo.registrar(() => { vivo = false })

  void leerFormatos(nodo).then((formatos) => {
    // La cámara puede haberse desenchufado —o la sección cerrado— mientras el
    // proceso corría. Escribir en un estado ya desmontado no da error, pero
    // deja viva una promesa que referencia el árbol de widgets entero.
    if (!vivo) return
    const resumen = resumenFormatos(formatos)
    const maxima = resolucionMaxima(formatos)
    setFicha(resumen || (maxima ? `hasta ${maxima}` : textos.lista.sinFormatos))
  })

  return <TextoInformativo label={ficha} maxWidthChars={56} />
}

// ── Una cámara de la lista ──────────────────────────────────────────────────

function FilaCamara({
  inicial, conocidas, seleccionada, seleccionar,
}: {
  inicial: CamaraConocida
  conocidas: Accessor<CamaraConocida[]>
  seleccionada: Accessor<string | null>
  seleccionar: (clave: string) => void
}) {
  const clave = inicial.clave
  // La fila se construye UNA vez (`<For id>`) y su objeto no vuelve a llegar,
  // así que todo lo mutable se deriva de la lista viva. El `?? inicial` cubre
  // el parpadeo entre que la cámara desaparece y `<For>` desmonta la fila.
  const info = conocidas((lista) => lista.find((c) => c.clave === clave) ?? inicial)
  const activa = seleccionada((s) => s === clave)

  // El nodo se DEDUPLICA a mano antes de dárselo al <With> de la ficha. `info`
  // vuelve a emitir con cada `recordarControl` —el estado persistido es una de
  // sus fuentes— y <With> re-renderiza en cada emisión: sin esto, soltar un
  // deslizador relanzaría un `v4l2-ctl --list-formats-ext` por cada cámara de
  // la lista. Ningún error, solo procesos de más en el camino del arrastre.
  const ciclo = crearCicloVida()
  const [nodoFicha, setNodoFicha] = createState<string | null>(inicial.nodo)
  ciclo.suscribir(info, (c) => { if (c.nodo !== nodoFicha.get()) setNodoFicha(c.nodo) })

  const etiquetaTipo = info((c) => !c.presente
    ? textos.lista.desconectada
    : c.usb ? textos.lista.usb : textos.lista.integrada)

  return (
    <box orientation={Gtk.Orientation.VERTICAL} spacing={8} cssClasses={activa((v) =>
      v ? ["dev-row", "cam-fila", "activa"] : ["dev-row", "cam-fila"])}>
      <box spacing={10} valign={Gtk.Align.CENTER}>
        <label cssClasses={info((c) => c.presente ? ["cam-punto", "on"] : ["cam-punto"])} label="●" />
        <box orientation={Gtk.Orientation.VERTICAL} spacing={2} hexpand>
          <TituloAjuste label={info((c) => c.nombre)} />
          <box spacing={8}>
            <label cssClasses={["cam-chip"]} label={etiquetaTipo} />
            {/* El nodo se enseña porque es lo que hay que teclear en OBS o en
                `v4l2-ctl`, y porque con dos cámaras iguales es lo único que las
                distingue a simple vista. Desconectada no tiene ninguno: el
                número lo reparte el kernel al enchufar. */}
            <label cssClasses={["cam-nodo"]} label={info((c) => c.nodo ?? "—")} />
            <label
              cssClasses={["cam-chip"]}
              visible={info((c) => c.guardados > 0)}
              label={info((c) => formatearTexto(textos.lista.guardados, { numero: c.guardados }))}
            />
          </box>
        </box>

        {/* Preferida: es un flip-flop. Volver a pulsarla la desmarca, o el
            usuario no tendría forma de dejar la elección en «la primera que
            haya» salvo editando `camara.json`. */}
        <BotonAjustes
          activo={info((c) => c.preferida)}
          tooltipText={info((c) => c.preferida ? textos.lista.quitarPreferida : textos.lista.hacerPreferida)}
          onClicked={() => fijarPreferida(info.get().preferida ? null : clave)}
        >
          <label label={info((c) => c.preferida ? "󰓎" : "󰓒")} />
        </BotonAjustes>

        <BotonAjustes
          visible={info((c) => c.presente)}
          tooltipText={textos.lista.probarDescripcion}
          onClicked={() => {
            const camara = camaraPorClave(clave)
            if (camara) abrirVistaPrevia(camara)
          }}
        >
          <label label="󰄀" />
        </BotonAjustes>

        <BotonAjustes
          visible={info((c) => c.guardados > 0)}
          tooltipText={textos.lista.olvidar}
          onClicked={() => olvidarCamara(clave)}
        >
          <label label="󰆴" />
        </BotonAjustes>

        <BotonAjustes
          sensitive={info((c) => c.presente)}
          activo={activa}
          tooltipText={textos.lista.seleccionar}
          onClicked={() => seleccionar(clave)}
        >
          <label label="󰒓" />
        </BotonAjustes>
      </box>

      {/* La ficha solo existe con la cámara delante: sin nodo no hay a quién
          preguntarle los formatos. */}
      <box visible={info((c) => c.presente)}>
        <With value={nodoFicha}>
          {(nodo: string | null) => (
            // SIEMPRE un <box>, nunca un Fragment ni un `null` a secas: un
            // Fragment colgando de <With> revienta la construcción del
            // componente entero y la sección sale EN BLANCO sin un solo error.
            <box>{nodo ? <FichaFormatos nodo={nodo} /> : <box />}</box>
          )}
        </With>
      </box>
    </box>
  )
}

// ── Un control de la cámara seleccionada ────────────────────────────────────

function FilaControl({
  inicial, controles, escribir,
}: {
  inicial: Control
  controles: Accessor<Control[]>
  escribir: (nombre: string, valor: number, persistir: boolean) => void
}) {
  const nombre = inicial.nombre
  // Mismo contrato que `FilaCamara`: la fila va con clave y lee de la lista
  // viva. Es lo que hace que encender un automático apague el mando del manual
  // que gobierna sin reconstruir nada.
  const ctl = controles((lista) => lista.find((c) => c.nombre === nombre) ?? inicial)
  const habilitado = ctl((c) => !c.inactivo)
  const pista = ctl((c) => c.inactivo ? textos.controles.inactivo : "")
  const etiqueta = etiquetaControl(nombre)

  if (inicial.tipo === "bool") {
    return (
      <box cssClasses={["dev-row"]} spacing={12} valign={Gtk.Align.CENTER}>
        <EncabezadoAjuste titulo={etiqueta} informacion={pista} />
        <Interruptor
          activo={ctl((c) => c.valor !== 0)}
          sensible={habilitado}
          alAlternar={() => escribir(nombre, ctl.get().valor !== 0 ? 0 : 1, true)}
        />
      </box>
    )
  }

  if (inicial.tipo === "menu") {
    const actual = ctl((c) => c.opciones.find((o) => o.valor === c.valor)?.etiqueta ?? String(c.valor))
    const opciones = ctl((c) => c.opciones.map((o) => ({
      value: String(o.valor), label: o.etiqueta, active: o.valor === c.valor,
    })))
    return (
      <box cssClasses={["dev-row"]} spacing={12} valign={Gtk.Align.CENTER}>
        <EncabezadoAjuste titulo={etiqueta} informacion={pista} />
        <box cssClasses={["dev-select"]} sensitive={habilitado}>
          <DisplaySelect current={actual} options={opciones} onSelect={(v) => escribir(nombre, Number(v), true)} />
        </box>
      </box>
    )
  }

  // `int` → deslizador con el rango REAL del control. Nada de 0..100.
  const ciclo = crearCicloVida()
  const [mostrado, setMostrado] = createState(inicial.valor)
  const ajuste = new Gtk.Adjustment({
    lower: inicial.min,
    upper: inicial.max,
    stepIncrement: inicial.paso > 0 ? inicial.paso : 1,
    pageIncrement: (inicial.paso > 0 ? inicial.paso : 1) * 5,
  })
  ajuste.value = inicial.valor

  const escala = new Gtk.Scale({
    orientation: Gtk.Orientation.HORIZONTAL, adjustment: ajuste, drawValue: false, hexpand: true,
  })
  escala.cssClasses = ["qs-slider", "dev-slider", "cam-slider"]
  escala.set_sensitive(!inicial.inactivo)

  let tocando = false
  let pendiente: number | null = null
  let idArrastre = 0
  let idPosar = 0

  const cancelar = (id: number) => { if (id) GLib.source_remove(id) }
  ciclo.registrar(() => { cancelar(idArrastre); cancelar(idPosar); idArrastre = 0; idPosar = 0 })

  /** Escribe lo último pedido y rearma la ventana de coalescencia. */
  const volcar = () => {
    if (pendiente === null) return
    const valor = pendiente
    pendiente = null
    escribir(nombre, valor, false)
  }

  conectarCambioDeslizador(escala, (bruto) => {
    const valor = ajustarAlPaso(bruto, ctl.get())
    tocando = true
    setMostrado(valor)
    pendiente = valor

    // Coalescencia: la primera escritura sale ya (el usuario tiene que ver
    // moverse la imagen), las siguientes esperan a que se cierre la ventana.
    if (!idArrastre) {
      volcar()
      idArrastre = GLib.timeout_add(GLib.PRIORITY_DEFAULT, MS_ARRASTRE, () => {
        idArrastre = 0
        volcar()
        return GLib.SOURCE_REMOVE
      })
    }

    // Y al soltar (= MS_POSAR sin movimiento) se persiste y se relee UNA vez.
    cancelar(idPosar)
    idPosar = GLib.timeout_add(GLib.PRIORITY_DEFAULT, MS_POSAR, () => {
      idPosar = 0
      tocando = false
      escribir(nombre, ajustarAlPaso(mostrado.get(), ctl.get()), true)
      return GLib.SOURCE_REMOVE
    })
  })

  // La relectura del aparato re-siembra el deslizador, PERO nunca mientras se
  // está arrastrando: el valor en vuelo volvería como notificación y daría un
  // tirón hacia atrás bajo el dedo del usuario (mismo fallo que documenta la
  // mezcla de aplicaciones de Quick Settings).
  ciclo.suscribir(ctl, (c) => {
    escala.set_sensitive(!c.inactivo)
    if (tocando) return
    if (ajuste.value !== c.valor) ajuste.value = c.valor
    setMostrado(c.valor)
  })

  return (
    <box orientation={Gtk.Orientation.VERTICAL} spacing={7} cssClasses={["dev-row"]}>
      <box spacing={8}>
        <EncabezadoAjuste titulo={etiqueta} informacion={pista} />
        <label cssClasses={["sp-field-value", "dev-value"]} label={mostrado((v) => String(v))} />
      </box>
      {escala}
    </box>
  )
}

// ── La sección ──────────────────────────────────────────────────────────────

export default function SeccionCamara() {
  const ciclo = crearCicloVida()
  // Al salir de la sección se cierra la vista previa. Es una VENTANA aparte
  // (mpv, ver `servicios/camara/vistaPrevia.ts`): sin esto se quedaría con la
  // cámara encendida por detrás, que es exactamente lo que el indicador de
  // privacidad va a señalar sin que quede nada visible que lo explique.
  ciclo.registrar(() => cerrarVistaPrevia())

  // Presentes + recordadas. Se listan las dos porque una webcam desenchufada
  // con ajustes guardados tiene que poder OLVIDARSE desde aquí; ver la cabecera
  // de `camaraDatos.ts`.
  const conocidas = createComputed([camaras, estadoCamara], camarasConocidas)
  const [claveElegida, setClaveElegida] = createState<string | null>(camaraPreferida()?.clave ?? null)

  /** La cámara cuyos controles se editan. Cae a la preferida (o a la primera
   *  presente) cuando la elegida se desenchufa: dejar la tarjeta de controles
   *  apuntando a un nodo que ya no existe la habría dejado vacía sin decir por
   *  qué. Nunca se elige una ausente, que no tiene nodo al que hablar. */
  const seleccionada = createComputed([conocidas, claveElegida], (lista, clave) =>
    lista.find((c) => c.clave === clave && c.presente)
    ?? lista.find((c) => c.presente)
    ?? null)

  const [controles, setControles] = createState<Control[]>([])
  const [cargando, setCargando] = createState(false)

  // `generacion` invalida respuestas viejas: `leerControles` lanza un proceso y
  // dos cámaras elegidas seguidas pueden resolver EN ORDEN INVERSO, dejando en
  // pantalla los controles de la que ya no está seleccionada. No da error
  // ninguno; simplemente miente sobre qué se está ajustando.
  let generacion = 0
  let nodoCargado: string | null = null

  const cargar = (nodo: string | null) => {
    nodoCargado = nodo
    const mia = ++generacion
    if (!nodo) { setControles([]); setCargando(false); return }
    setCargando(true)
    void leerControles(nodo).then((lista) => {
      if (mia !== generacion) return
      setControles(lista)
      setCargando(false)
    })
  }

  // Toda escritura termina releyendo: encender un automático cambia el
  // `inactivo` de otros controles, y `--set-ctrl` acota en silencio, así que
  // "sin error" no es "se aplicó lo que pediste".
  const escribir = (nombre: string, valor: number, persistir: boolean) => {
    const camara: Camara | null = camaraPorClave(seleccionada.get()?.clave)
    if (!camara) return
    void fijarControl(camara.nodo, nombre, valor).then(() => {
      if (persistir) recordarControl(camara, nombre, valor)
      cargar(camara.nodo)
    })
  }

  const restablecer = () => {
    const camara = camaraPorClave(seleccionada.get()?.clave)
    if (!camara) return
    const mia = ++generacion
    setCargando(true)
    void restablecerControles(camara.nodo).then((lista) => {
      // Las DOS cosas, y por eso este botón no llama solo a
      // `restablecerControles`: devolver el aparato a fábrica dejando el JSON
      // como estaba haría que el siguiente arranque volviera a imponer los
      // valores viejos, y el botón parecería no haber servido de nada.
      olvidarCamara(camara.clave)
      if (mia !== generacion) return
      setControles(lista)
      setCargando(false)
    })
  }

  // Solo se recarga cuando cambia el NODO. `seleccionada` se recomputa también
  // en cada `recordarControl` (el estado persistido es una de sus fuentes), y
  // sin esta guarda soltar un deslizador dispararía dos lecturas de `v4l2-ctl`
  // en lugar de una.
  ciclo.suscribir(seleccionada, (c) => {
    const nodo = c?.nodo ?? null
    if (nodo !== nodoCargado) cargar(nodo)
  })
  cargar(seleccionada.get()?.nodo ?? null)

  const hayControles = createComputed([controles, cargando], (lista, esperando) =>
    !esperando && lista.length > 0)
  const sinControles = createComputed([controles, cargando, seleccionada], (lista, esperando, cam) =>
    !esperando && cam !== null && lista.length === 0)

  return (
    // El overlay `display-select-host` es obligatorio: los controles de tipo
    // `menu` se pintan con `DisplaySelect`, que dibuja su lista como overlay del
    // primer ancestro con esa clase y, sin encontrarlo, NO se despliega — el
    // botón se pulsa y no pasa nada, sin un solo error.
    <overlay cssClasses={["display-select-host"]} vexpand>
      <box
        orientation={Gtk.Orientation.VERTICAL}
        spacing={14}
        cssClasses={["sp-section", "dev-section", "cam-section"]}
        hexpand
        valign={Gtk.Align.START}
      >
        <TituloSeccion titulo={textos.seccion.titulo} />

        <TarjetaAjustes titulo={textos.grupos.camaras} icono="󰄀">
          <box orientation={Gtk.Orientation.VERTICAL}>
            <box cssClasses={["dev-row"]} visible={conocidas((l) => l.length === 0)}>
              <TextoInformativo label={textos.lista.vacia} />
            </box>
            <For each={conocidas} id={(c: CamaraConocida) => c.clave}>
              {(c: CamaraConocida) => (
                <FilaCamara
                  inicial={c}
                  conocidas={conocidas}
                  seleccionada={seleccionada((s) => s?.clave ?? null)}
                  seleccionar={setClaveElegida}
                />
              )}
            </For>
          </box>

          {/* ⚠️ Esta línea NO es decorativa. La preferencia vale dentro de
              GiGiShell y punto: en Linux no existe ninguna «cámara predeterminada»
              del sistema —al contrario que en el audio, donde WirePlumber sí
              tiene `default.configured.audio.source`— y Firefox, Chrome, Zoom u
              OBS eligen cada uno con su propio selector. Dejar creer que esto
              cambia la cámara de una videollamada sería el peor fallo posible de
              esta sección: silencioso, y descubierto en mitad de la llamada. */}
          <box cssClasses={["dev-row", "cam-aviso"]}>
            <TextoInformativo label={textos.lista.avisoPreferida} maxWidthChars={64} />
          </box>
        </TarjetaAjustes>

        {/* ── Gestos ──────────────────────────────────────────────────────────────────
            Va DELANTE del killswitch y de los controles de imagen a propósito: es lo
            único de esta sección que compite por la cámara con el resto del sistema, y
            leerlo antes que el interruptor de bloqueo deja claro que los dos hablan del
            mismo recurso. Su implementación está en `TarjetaGestos.tsx`; el trabajo de
            verdad, en `hypr/scripts/gestos/`. */}
        <TarjetaGestos />

        {/* ── Killswitch ──────────────────────────────────────────────────────────────
            El bloqueo NO lo aplica AGS: los nodos `/dev/video*` son de `root:video` y sus
            permisos los decide udev. Lo hace el helper root-owned `/usr/local/bin/gigios-camara`
            vía una regla sudoers acotada a sus dos verbos (mismo esquema que TLP y ClamAV). El
            detalle que no se ve y que sostiene todo esto es el NÚMERO de la regla udev que
            instala —`71-`, entre el `70-uaccess` que etiqueta y el `73-seat-late` que concede la
            ACL—: en `99-` no bloquearía nada y no daría ningún error. Está explicado en la
            cabecera del helper y en la sección de cámara de `docs/hyprland-modulos.md`.

            La tarjeta entera cuelga de `bloqueoDisponible`: sin helper instalado (paso `sistema`
            del instalador no ejecutado) no se pinta, en vez de ofrecer un interruptor que
            fallaría al pulsarlo. */}
        <TarjetaAjustes
          titulo={textos.bloqueo.grupo}
          icono="󰄚"
          visible={bloqueoDisponible}
        >
          <box cssClasses={["dev-row"]}>
            <EncabezadoAjuste
              titulo={textos.bloqueo.titulo}
              informacion={textos.bloqueo.descripcion}
            />
            {/* Insensible mientras hay una orden en vuelo: `udevadm settle` tarda un instante y
                dos pulsaciones seguidas dejarían el interruptor y el sistema en desacuerdo. */}
            <Interruptor
              activo={camaraBloqueada}
              alAlternar={alternarBloqueo}
              sensible={bloqueoOcupado((ocupado) => !ocupado)}
            />
          </box>
          {/* Lo que el interruptor NO hace, dicho donde se decide y no en un README. */}
          <box cssClasses={["dev-row", "cam-aviso"]}>
            <TextoInformativo label={textos.bloqueo.limitacion} maxWidthChars={64} />
          </box>
          <box cssClasses={["dev-row", "cam-aviso"]} visible={camaraEnUso}>
            <TextoInformativo label={textos.bloqueo.enUso} maxWidthChars={64} />
          </box>
        </TarjetaAjustes>

        <TarjetaAjustes
          titulo={seleccionada((c) => c
            ? formatearTexto(textos.controles.para, { nombre: c.nombre })
            : textos.grupos.controles)}
          icono="󰃟"
          visible={conocidas((l) => l.length > 0)}
        >
          {/* Sin ninguna cámara enchufada no hay controles que ofrecer: solo
              recuerdos que se repondrán al conectarla. Se dice con una frase en
              vez de dejar la tarjeta vacía. */}
          <box cssClasses={["dev-row"]} visible={seleccionada((c) => c === null)}>
            <TextoInformativo label={textos.controles.ausente} maxWidthChars={64} />
          </box>

          <box cssClasses={["dev-row"]} visible={cargando}>
            <TextoInformativo label={textos.controles.cargando} />
          </box>

          {/* Una cámara puede no publicar NINGÚN control: hay firmwares que no
              exponen ni el brillo. Se dice, en vez de dejar el hueco vacío. */}
          <box cssClasses={["dev-row"]} visible={sinControles}>
            <TextoInformativo label={textos.controles.sinControles} maxWidthChars={64} />
          </box>

          <box orientation={Gtk.Orientation.VERTICAL}>
            {/* La clave lleva la CÁMARA además del nombre del control: con solo
                el nombre, cambiar de cámara conservaría la fila `brightness` de
                la anterior —y con ella su tipo y su rango, que no tienen por qué
                coincidir— en vez de reconstruirla. */}
            <For each={controles} id={(c: Control) => `${seleccionada.get()?.clave ?? ""}:${c.nombre}`}>
              {(c: Control) => <FilaControl inicial={c} controles={controles} escribir={escribir} />}
            </For>
          </box>

          <box cssClasses={["dev-row"]} spacing={10} valign={Gtk.Align.CENTER} visible={hayControles}>
            <EncabezadoAjuste
              titulo={textos.controles.restablecer}
              informacion={textos.controles.restablecerDescripcion}
            />
            <BotonAjustes onClicked={restablecer}>
              <label label={textos.controles.restablecer} />
            </BotonAjustes>
          </box>

          {/* Por qué existe todo esto: los controles V4L2 viven en el driver, no
              en la cámara, y se pierden al desenchufar o reiniciar. */}
          <box cssClasses={["dev-row", "cam-aviso"]}>
            <TextoInformativo label={textos.controles.persistencia} maxWidthChars={64} />
          </box>
        </TarjetaAjustes>
      </box>
    </overlay>
  )
}
