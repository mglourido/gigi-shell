// modulos/ajustes/disco/SeccionAlmacenamiento.tsx — Ajustes > Almacenamiento.
//
// Dos destinos de la navegación, un solo componente (mismo patrón que `SeccionSistema` y
// `SeccionSeguridad`): «Almacenamiento» enseña qué ocupa el disco y «Liberar espacio» decide qué
// se borra y cuándo.
//
// ── Se pinta LLENO en el primer frame ────────────────────────────────────────
// El análisis obliga a recorrer el sistema de ficheros y tarda segundos. Se construye con el
// análisis anterior leído de `~/.cache/gigios/almacenamiento.json` (síncrono, ~1 ms) y el nuevo
// entra por detrás cuando llega, igual que Ajustes > Sistema. Sin caché previa —primera vez en un
// equipo— sí se ve el spinner, que es cuando de verdad no hay nada que enseñar.
//
// ── El directorio se llama `disco/` y el servicio `servicios/disco/` ─────────
// NO `almacenamiento/`: ese nombre ya está cogido por `servicios/almacenamiento/`, que es la
// lectura y escritura de los JSON del shell — nada que ver con el espacio en disco. Dos cosas con
// el mismo nombre a dos niveles distintos del árbol es una trampa para el siguiente que grepee.
import { Gtk } from "ags/gtk4"
import Pango from "gi://Pango"
import { For, With, createComputed, createState, onCleanup, type Accessor } from "ags"
import {
  AjusteInterruptor, BotonAjustes, FilaAjuste, TarjetaAjustes,
  TextoInformativo, TituloSeccion,
} from "../componentes"
import {
  ACCIONES, ACCIONES_AUTOMATIZABLES, agrupar, accion as buscarAccion,
  estimarLiberable, type Estimacion, type FilaCategoria, type IdAccion,
} from "../../../servicios/disco/catalogo"
import type { Analisis, App, Disco } from "../../../servicios/disco/analisis"
import type { ResultadoLimpieza } from "../../../servicios/disco/limpieza"
import { formatearBytes, formatearFecha, fraccionUso, severidadUso } from "../../../servicios/disco/formato"
import {
  accionAutomatica, autoLimpieza, descargasAPapelera, diasDescargas, diasPapelera,
  intervaloHoras, notificarLimpieza, retenerJournal,
  setAccionAutomatica, setAutoLimpieza, setDescargasAPapelera, setDiasDescargas, setDiasPapelera,
  setIntervaloHoras, setNotificarLimpieza, setRetenerJournal, setUmbralUso, umbralUso,
} from "../../../servicios/disco/preferencias"
import { usarAnalisis } from "./usarAnalisis"
import { autolimpiezaEnCurso, ejecutarAutolimpieza, usarLimpiezas, type Limpiezas } from "./usarLimpiezas"
import RutasPersonalizadas, { RutasProtegidas } from "./RutasPersonalizadas"
import CampoNumerico from "../pantalla/CampoNumerico"
import textos from "../../../textos/ajustes/almacenamiento.json" with { type: "json" }
import { formatearTexto } from "../../../textos/formatear"

type VistaAlmacenamiento = "uso" | "limpieza"

/** Cuántas aplicaciones se enseñan antes de "Ver más". */
const APPS_VISIBLES = 12

// ── Análisis compartido ──────────────────────────────────────────────────────
//
// Vive en `usarAnalisis.ts`, a nivel de módulo y con contador de referencias, porque `SettingsPanel`
// se instancia una vez por MONITOR: con el estado aquí dentro, dos pantallas lanzaban dos análisis
// completos del sistema de ficheros para medir lo mismo. Cerrar Ajustes sigue sin dejar nada vivo
// —al soltar la última referencia se descarta el resultado y se da de baja la suscripción—, y el
// coste de reconstruir está cubierto por la caché de disco. El porqué completo, allí.

// ── Piezas ───────────────────────────────────────────────────────────────────

function BarraDisco({ disco }: { disco: Disco }) {
  const severidad = severidadUso(disco.porcentaje)
  return (
    <box orientation={Gtk.Orientation.VERTICAL} spacing={5} cssClasses={["dev-row", "alm-disco"]}>
      <box spacing={10}>
        <label cssClasses={["alm-disco-punto"]} label={disco.punto} halign={Gtk.Align.START} />
        <label cssClasses={["alm-disco-fs"]} label={disco.fs} halign={Gtk.Align.START} hexpand />
        <label
          cssClasses={["alm-disco-uso", severidad]}
          label={formatearTexto(textos.seccion.usadoPorcentaje, { porcentaje: disco.porcentaje })}
          halign={Gtk.Align.END}
        />
      </box>
      <Gtk.ProgressBar
        cssClasses={["alm-barra", severidad]}
        fraction={fraccionUso(disco.usado, disco.total)}
        hexpand
      />
      <label
        cssClasses={["alm-disco-libre"]}
        label={formatearTexto(textos.seccion.libreDe, {
          libre: formatearBytes(disco.libre),
          total: formatearBytes(disco.total),
        })}
        halign={Gtk.Align.START}
      />
    </box>
  )
}

/**
 * Fila de una categoría, con su botón de limpieza si la tiene.
 *
 * El resultado se pinta EN LA PROPIA FILA y no en un aviso global: con doce botones, un mensaje
 * arriba del todo no dice cuál de ellos acaba de terminar. Y el botón se deshabilita mientras
 * corre porque varias limpiezas tardan segundos sin dar señal de vida.
 *
 * El estado (ocupado / resultado) NO vive aquí sino en `usarLimpiezas`, por encima del `<With>`
 * que reconstruye estas filas cuando entra un análisis nuevo. Ver la cabecera de ese módulo.
 */
function FilaCategoriaVista({ fila, limpiezas }: { fila: FilaCategoria; limpiezas: Limpiezas }) {
  const id = fila.categoria.accion
  const meta = id ? buscarAccion(id) : undefined
  const ocupado = limpiezas.ocupadas((set: ReadonlySet<IdAccion>) => id ? set.has(id) : false)
  const resultado = limpiezas.resultados((mapa: ReadonlyMap<IdAccion, ResultadoLimpieza>) =>
    id ? mapa.get(id) ?? null : null)

  return (
    <box orientation={Gtk.Orientation.VERTICAL} cssClasses={["dev-row", "alm-fila"]} spacing={4}>
      <box spacing={12} valign={Gtk.Align.CENTER}>
        <label cssClasses={["alm-icono"]} label={fila.categoria.icono} valign={Gtk.Align.START} />
        <box orientation={Gtk.Orientation.VERTICAL} spacing={2} hexpand>
          <label cssClasses={["sp-field-label"]} label={fila.categoria.nombre} halign={Gtk.Align.START} />
          <TextoInformativo label={fila.categoria.descripcion} wrap xalign={0} maxWidthChars={56} />
        </box>
        {/* Dos cifras, y la de abajo es la que importa al decidir: lo que OCUPA y lo que se
            LIBERARÍA. Solo se enseña la segunda cuando difiere de la primera, que es cuando dice
            algo — en «Miniaturas» las dos son iguales y repetirlas sería ruido. Sin esto, ver
            «Registros · 100 MiB» con un botón al lado hace pensar que pulsarlo devuelve 100 MiB,
            cuando la retención configurada deja el journal justo como está. */}
        <box orientation={Gtk.Orientation.VERTICAL} spacing={1} valign={Gtk.Align.START}>
          <label cssClasses={["alm-tamano"]} label={formatearBytes(fila.bytes)} halign={Gtk.Align.END} />
          {meta ? (
            <label
              cssClasses={["alm-liberable", fila.liberable ? "algo" : "nada"]}
              halign={Gtk.Align.END}
              visible={fila.liberable !== fila.bytes}
              label={textoLiberable(fila.liberable)}
            />
          ) : <box />}
        </box>
        {meta && id ? (
          <BotonAjustes
            onClicked={() => limpiezas.ejecutar(id)}
            sensitive={ocupado((esta: boolean) => !esta)}
            tooltipText={meta.descripcion}
          >
            <label label={ocupado((esta: boolean) => esta ? textos.estados.limpiando : meta.etiqueta)} />
          </BotonAjustes>
        ) : (
          <box widthRequest={4} />
        )}
      </box>
      <With value={resultado}>
        {(r: ResultadoLimpieza | null) =>
          r ? <TextoInformativo cssClasses={["alm-resultado", r.estado]} label={textoResultado(r)} wrap xalign={0} maxWidthChars={60} />
            : <box />}
      </With>
    </box>
  )
}

/**
 * La frase de la estimación. Tres casos y no uno, porque los tres significan cosas distintas:
 * una cifra exacta, un suelo (hay marcada alguna limpieza que no se puede medir de antemano —hoy
 * solo Flatpak—) y "nada que liberar". Redondear los tres a «se liberarían unos 0 B» es lo que
 * hace que la gente deje de creerse el panel.
 */
function textoEstimacion(estimacion: Estimacion): string {
  if (estimacion.bytes <= 0) {
    return estimacion.completa
      ? textos.auto.estimacionNada
      : formatearTexto(textos.auto.estimacionParcial, { tamano: formatearBytes(0) })
  }
  const plantilla = estimacion.completa ? textos.auto.estimacion : textos.auto.estimacionParcial
  return formatearTexto(plantilla, { tamano: formatearBytes(estimacion.bytes) })
}

/** «Libera 3,4 GB» / «No libera nada ahora mismo» / «No se puede calcular…». */
function textoLiberable(liberable: number | null): string {
  if (liberable === null) return textos.seccion.liberariaDesconocido
  if (liberable <= 0) return textos.seccion.liberariaNada
  return formatearTexto(textos.seccion.liberaria, { tamano: formatearBytes(liberable) })
}

function textoResultado(r: ResultadoLimpieza): string {
  switch (r.estado) {
    case "ok":
      // Un `ok` CON mensaje lo enseña tal cual. Lo usa hoy «mandar las descargas a la papelera»,
      // que termina bien pero con `liberado: 0` —mover no libera disco—: sin esta rama la fila
      // habría dicho «No había nada que liberar» justo después de mover 5 GB, que es lo contrario
      // de lo que ha pasado.
      if (r.mensaje) return r.mensaje
      return r.liberado > 0
        ? formatearTexto(textos.estados.liberado, { tamano: formatearBytes(r.liberado) })
        : textos.estados.nada
    case "cancelado":    return textos.estados.cancelado
    case "omitida":      return formatearTexto(textos.estados.omitida, { mensaje: r.mensaje })
    case "sin-permisos": return textos.estados.sinPermisos
    default:             return formatearTexto(textos.estados.error, { mensaje: r.mensaje })
  }
}

// ── Catálogo de aplicaciones ─────────────────────────────────────────────────

type FiltroApps = "todas" | "explicitas" | "dependencias" | "aur"

const FILTROS: { id: FiltroApps; etiqueta: string }[] = [
  { id: "todas",        etiqueta: textos.apps.filtros.todas },
  { id: "explicitas",   etiqueta: textos.apps.filtros.explicitas },
  { id: "dependencias", etiqueta: textos.apps.filtros.dependencias },
  { id: "aur",          etiqueta: textos.apps.filtros.aur },
]

function aplicaFiltro(app: App, filtro: FiltroApps): boolean {
  if (filtro === "explicitas") return app.explicito
  if (filtro === "dependencias") return !app.explicito
  if (filtro === "aur") return app.origen === "aur"
  return true
}

function CatalogoApps({ apps }: { apps: Accessor<App[]> }) {
  const [busqueda, setBusqueda] = createState("")
  const [filtro, setFiltro] = createState<FiltroApps>("todas")
  const [expandido, setExpandido] = createState(false)

  // El script ya devuelve la lista ordenada por tamaño, así que aquí solo se filtra: reordenar
  // ~1600 elementos en cada pulsación del buscador es trabajo que ya está hecho.
  const filtradas = createComputed([apps, busqueda, filtro], (lista, texto, f) =>
    lista.filter(app => aplicaFiltro(app, f) && (!texto || app.nombre.toLowerCase().includes(texto))))
  // El recorte a `APPS_VISIBLES` es lo que hace utilizable esta tarjeta: con ~1600 paquetes,
  // pintarlos todos construye 1600 filas de tres widgets cada una dentro de un ScrolledWindow que
  // no virtualiza nada. Se enseñan doce y el resto entra bajo demanda.
  const visibles = createComputed([filtradas, expandido], (lista, abierto) =>
    abierto ? lista : lista.slice(0, APPS_VISIBLES))

  return (
    <TarjetaAjustes titulo={textos.grupos.apps} icono="󰏖">
      <box orientation={Gtk.Orientation.VERTICAL} spacing={8} cssClasses={["dev-row"]}>
        <TextoInformativo label={textos.apps.descripcion} wrap xalign={0} maxWidthChars={62} />
        <label
          cssClasses={["alm-totales"]}
          halign={Gtk.Align.START}
          wrap wrapMode={Pango.WrapMode.WORD_CHAR} xalign={0}
          label={filtradas((lista: App[]) => formatearTexto(textos.apps.totales, {
            numero: lista.length,
            tamano: formatearBytes(lista.reduce((suma, app) => suma + app.bytes, 0)),
          }))}
        />
        <entry
          cssClasses={["account-entry", "alm-buscador"]}
          placeholderText={textos.apps.buscar}
          hexpand
          onChanged={(self: Gtk.Entry) => setBusqueda(self.text.trim().toLowerCase())}
        />
        <box spacing={6}>
          {FILTROS.map(f => (
            <BotonAjustes
              activo={filtro((actual: FiltroApps) => actual === f.id)}
              onClicked={() => { setFiltro(f.id); setExpandido(false) }}
            >
              <label label={f.etiqueta} />
            </BotonAjustes>
          ))}
        </box>
      </box>

      <box orientation={Gtk.Orientation.VERTICAL}>
        {/* `id` por NOMBRE de paquete: sin él, `<For>` indexa por identidad de objeto y cada
            pulsación en el buscador reconstruiría las doce filas enteras — el mismo fallo que
            documenta la barra en el CLAUDE.md de ags. El nombre es único por definición. */}
        <For each={visibles} id={(app: App) => app.nombre}>
          {(app: App) => (
            <box spacing={10} cssClasses={["dev-row", "alm-app"]} valign={Gtk.Align.CENTER}>
              <box orientation={Gtk.Orientation.VERTICAL} spacing={2} hexpand>
                <box spacing={6}>
                  <label cssClasses={["sp-field-label"]} label={app.nombre} halign={Gtk.Align.START}
                    ellipsize={Pango.EllipsizeMode.END} maxWidthChars={40} />
                  <label
                    cssClasses={["alm-etiqueta", app.origen]}
                    label={app.origen === "aur" ? textos.apps.origenAur : textos.apps.origenRepo}
                  />
                  <label
                    cssClasses={["alm-etiqueta", app.explicito ? "explicita" : "dependencia"]}
                    label={app.explicito ? textos.apps.explicita : textos.apps.dependencia}
                  />
                </box>
                <TextoInformativo label={app.descripcion} wrap xalign={0} maxWidthChars={58} />
              </box>
              <label cssClasses={["alm-tamano"]} label={formatearBytes(app.bytes)} valign={Gtk.Align.START} />
            </box>
          )}
        </For>
      </box>

      <box cssClasses={["dev-row"]} visible={filtradas((lista: App[]) => lista.length === 0)}>
        <TextoInformativo label={textos.apps.sinResultados} />
      </box>
      <box
        cssClasses={["dev-row"]}
        visible={filtradas((lista: App[]) => lista.length > APPS_VISIBLES)}
      >
        <BotonAjustes onClicked={() => setExpandido(!expandido.get())} halign={Gtk.Align.START}>
          <label label={expandido((abierto: boolean) => abierto ? textos.apps.verMenos : textos.apps.verMas)} />
        </BotonAjustes>
      </box>
    </TarjetaAjustes>
  )
}

// ── Vistas ───────────────────────────────────────────────────────────────────

function VistaUso() {
  const [analisis, analizando, refrescar] = usarAnalisis()
  const limpiezas = usarLimpiezas()

  return (
    <box orientation={Gtk.Orientation.VERTICAL} spacing={14} cssClasses={["sp-section", "dev-section", "alm-section"]} hexpand>
      <TituloSeccion titulo={textos.vistas.uso} />

      <box spacing={10} valign={Gtk.Align.CENTER}>
        <label
          cssClasses={["sp-field-hint"]}
          hexpand
          halign={Gtk.Align.START}
          wrap wrapMode={Pango.WrapMode.WORD_CHAR} xalign={0}
          label={analisis((a: Analisis) => a.epoch
            ? formatearTexto(textos.seccion.ultimoAnalisis, { fecha: formatearFecha(a.epoch) })
            : textos.seccion.sinAnalisis)}
        />
        <Gtk.Spinner spinning={analizando} visible={analizando} />
        <BotonAjustes onClicked={refrescar} sensitive={analizando((esta: boolean) => !esta)}>
          <label label={textos.seccion.reanalizar} />
        </BotonAjustes>
      </box>

      <With value={analisis}>
        {(a: Analisis) => {
          if (!a.epoch) {
            return (
              <box cssClasses={["alm-cargando"]} spacing={10} halign={Gtk.Align.CENTER} valign={Gtk.Align.CENTER}>
                <Gtk.Spinner spinning={true} />
                <label label={textos.seccion.analizando} />
              </box>
            )
          }
          const grupos = agrupar(a.categorias)
          return (
            <box orientation={Gtk.Orientation.VERTICAL} spacing={12}>
              <TarjetaAjustes titulo={textos.grupos.discos} icono="󰋊">
                {a.discos.map(disco => <BarraDisco disco={disco} />)}
              </TarjetaAjustes>
              <TarjetaAjustes titulo={textos.grupos.sistema} icono="󰒓">
                {grupos.sistema.map(fila => <FilaCategoriaVista fila={fila} limpiezas={limpiezas} />)}
              </TarjetaAjustes>
              <TarjetaAjustes titulo={textos.grupos.personal} icono="󰋜">
                {grupos.personal.map(fila => <FilaCategoriaVista fila={fila} limpiezas={limpiezas} />)}
              </TarjetaAjustes>
              <CatalogoApps apps={analisis((x: Analisis) => x.apps)} />
            </box>
          )
        }}
      </With>
    </box>
  )
}

function AccionManual({ id, limpiezas }: { id: IdAccion; limpiezas: Limpiezas }) {
  const meta = buscarAccion(id)!
  const ocupado = limpiezas.ocupadas((set: ReadonlySet<IdAccion>) => set.has(id))
  const resultado = limpiezas.resultados((mapa: ReadonlyMap<IdAccion, ResultadoLimpieza>) => mapa.get(id) ?? null)

  return (
    <box orientation={Gtk.Orientation.VERTICAL} spacing={4} cssClasses={["dev-row"]}>
      <box spacing={12} valign={Gtk.Align.CENTER}>
        <box orientation={Gtk.Orientation.VERTICAL} spacing={2} hexpand>
          <label cssClasses={["sp-field-label"]} label={meta.etiqueta} halign={Gtk.Align.START} />
          <TextoInformativo label={meta.descripcion} wrap xalign={0} maxWidthChars={58} />
        </box>
        <BotonAjustes
          variante={meta.peligrosa ? "secundario" : "principal"}
          onClicked={() => limpiezas.ejecutar(id)}
          sensitive={ocupado((esta: boolean) => !esta)}
        >
          <label label={ocupado((esta: boolean) => esta ? textos.estados.limpiando : meta.etiqueta)} />
        </BotonAjustes>
      </box>
      <With value={resultado}>
        {(r: ResultadoLimpieza | null) =>
          r ? <TextoInformativo cssClasses={["alm-resultado", r.estado]} label={textoResultado(r)} wrap xalign={0} maxWidthChars={60} />
            : <box />}
      </With>
    </box>
  )
}

function VistaLimpieza() {
  const [analisis] = usarAnalisis()
  const [marcadas, setMarcadas] = createState(ACCIONES_AUTOMATIZABLES.filter(id => accionAutomatica(id).get()))
  const limpiezas = usarLimpiezas()

  const alternar = (id: IdAccion) => {
    const nuevo = !accionAutomatica(id).get()
    setAccionAutomatica(id, nuevo)
    // La estimación se recalcula desde la lista de marcadas, no suscribiéndose a los doce
    // accessors: un solo state que se reemite una vez por clic en vez de doce recomputaciones.
    setMarcadas(ACCIONES_AUTOMATIZABLES.filter(otro => accionAutomatica(otro).get()))
  }

  return (
    <box orientation={Gtk.Orientation.VERTICAL} spacing={14} cssClasses={["sp-section", "dev-section", "alm-section"]} hexpand>
      <TituloSeccion titulo={textos.vistas.limpieza} />

      <TarjetaAjustes titulo={textos.auto.titulo} icono="󰃢">
        <AjusteInterruptor
          titulo={textos.auto.activar.titulo}
          informacion={textos.auto.activar.descripcion}
          activo={autoLimpieza}
          alAlternar={() => setAutoLimpieza(!autoLimpieza.get())}
        />
        <FilaAjuste titulo={textos.auto.intervalo.titulo} informacion={textos.auto.intervalo.descripcion}>
          <CampoNumerico valor={intervaloHoras} minimo={1} maximo={720} caracteres={3} relleno={1} alConfirmar={setIntervaloHoras} />
        </FilaAjuste>
        <FilaAjuste titulo={textos.auto.umbral.titulo} informacion={textos.auto.umbral.descripcion}>
          <CampoNumerico valor={umbralUso} minimo={0} maximo={100} caracteres={3} relleno={1} alConfirmar={setUmbralUso} />
        </FilaAjuste>
        <FilaAjuste titulo={textos.auto.retencion.titulo} informacion={textos.auto.retencion.descripcion}>
          <entry
            cssClasses={["sp-num-input"]}
            widthChars={6}
            xalign={0.5}
            $={(self: Gtk.Entry) => {
              self.set_text(retenerJournal.get())
              onCleanup(retenerJournal.subscribe(() => {
                if (!self.has_focus) self.set_text(retenerJournal.get())
              }))
            }}
            onActivate={(self: Gtk.Entry) => {
              setRetenerJournal(self.get_text())
              // Se reescribe SIEMPRE desde el estado, no desde lo tecleado: `setRetenerJournal`
              // rechaza los formatos inválidos en silencio, y sin esto el campo se quedaría
              // enseñando un valor que no se ha guardado.
              self.set_text(retenerJournal.get())
            }}
          />
        </FilaAjuste>
        <FilaAjuste titulo={textos.auto.diasPapelera.titulo} informacion={textos.auto.diasPapelera.descripcion}>
          <CampoNumerico valor={diasPapelera} minimo={0} maximo={3650} caracteres={4} relleno={1} alConfirmar={setDiasPapelera} />
        </FilaAjuste>
        <FilaAjuste titulo={textos.auto.diasDescargas.titulo} informacion={textos.auto.diasDescargas.descripcion}>
          <CampoNumerico valor={diasDescargas} minimo={0} maximo={3650} caracteres={4} relleno={1} alConfirmar={setDiasDescargas} />
        </FilaAjuste>
        {/* Va pegado a los días de Descargas porque solo matiza a esa acción, no a las once
            restantes: es la única que toca ficheros que pusiste tú a mano. */}
        <AjusteInterruptor
          titulo={textos.auto.descargasAPapelera.titulo}
          informacion={textos.auto.descargasAPapelera.descripcion}
          activo={descargasAPapelera}
          alAlternar={() => setDescargasAPapelera(!descargasAPapelera.get())}
        />
        <AjusteInterruptor
          titulo={textos.auto.notificar.titulo}
          informacion={textos.auto.notificar.descripcion}
          activo={notificarLimpieza}
          alAlternar={() => setNotificarLimpieza(!notificarLimpieza.get())}
        />
      </TarjetaAjustes>

      <TarjetaAjustes titulo={textos.auto.queLimpiar} icono="󰄬">
        {/* El `.map` va DENTRO de una caja y no suelto junto a la fila de abajo. Un array como
            hijo directo se aplana; DOS hijos donde uno es un array llegan a `Fragment.append` sin
            aplanar y revientan con «Object … is not a subclass of GObject_Object, it's a Array»,
            que además tumba la construcción de la sección entera. Medido: con el array suelto,
            abrir «Liberar espacio» dejaba el panel vacío y el shell escupiendo esa traza. */}
        <box orientation={Gtk.Orientation.VERTICAL}>
          {ACCIONES_AUTOMATIZABLES.map(id => {
            const meta = buscarAccion(id)!
            return (
              <AjusteInterruptor
                titulo={meta.etiqueta}
                informacion={meta.descripcion}
                activo={accionAutomatica(id)}
                alAlternar={() => alternar(id)}
              />
            )
          })}
        </box>
        <box orientation={Gtk.Orientation.VERTICAL} spacing={8} cssClasses={["dev-row"]}>
          {/* Depende de las DOS fuentes. Con `marcadas` sola —leyendo el análisis con `.get()`—
              la cifra se quedaba congelada en la del análisis cacheado: el nuevo llega segundos
              después de abrir la sección y no reemitía nada, así que la estimación contradecía
              al desglose de la vista de al lado hasta que tocaras una casilla. */}
          <TextoInformativo
            label={createComputed([analisis, marcadas], (a: Analisis, activas: IdAccion[]) =>
              textoEstimacion(estimarLiberable(a.categorias, activas)))}
            wrap
            xalign={0}
            maxWidthChars={62}
          />
          <BotonAjustes
            variante="principal"
            onClicked={ejecutarAutolimpieza}
            sensitive={autolimpiezaEnCurso((esta: boolean) => !esta)}
            halign={Gtk.Align.START}
          >
            <label label={autolimpiezaEnCurso((esta: boolean) => esta ? textos.estados.limpiando : textos.auto.ejecutar)} />
          </BotonAjustes>
        </box>
      </TarjetaAjustes>

      <TarjetaAjustes titulo={textos.auto.rutas.titulo} icono="󰉋">
        <RutasPersonalizadas />
      </TarjetaAjustes>

      {/* Va DESPUÉS de la lista de borrar, y no al principio de la vista, porque solo se entiende
          cuando ya sabes qué se limpia: es la excepción a todo lo de arriba, no un ajuste más. */}
      <TarjetaAjustes titulo={textos.auto.protegidas.titulo} icono="󰦝">
        <RutasProtegidas />
      </TarjetaAjustes>

      {/* Manual: TODAS las acciones, también las que piden contraseña y por eso no salen arriba. */}
      <TarjetaAjustes titulo={textos.vistas.limpieza} icono="󰩹">
        {ACCIONES.map(meta => <AccionManual id={meta.id} limpiezas={limpiezas} />)}
      </TarjetaAjustes>
    </box>
  )
}

export default function SeccionAlmacenamiento({ vista }: { vista: VistaAlmacenamiento }) {
  return vista === "limpieza" ? <VistaLimpieza /> : <VistaUso />
}
