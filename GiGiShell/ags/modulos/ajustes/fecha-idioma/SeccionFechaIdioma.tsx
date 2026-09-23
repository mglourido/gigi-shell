// modulos/ajustes/fecha-idioma/SeccionFechaIdioma.tsx
// Sección "Región, fecha y hora" del panel de ajustes.
// La distribución de teclado vive únicamente en Entrada y periféricos.
import { Gtk } from "ags/gtk4"
import Interruptor from "../../../componentes/Interruptor"
import { BotonAjustes, EntradaTextoAjustes, FilaAjuste, TarjetaAjustes, TextoInformativo, TituloAjuste, TituloSeccion } from "../componentes"
import { createComputed, createState, For, onCleanup, With } from "ags"
import { DisplaySelect } from "../../../servicios/pantalla/controls"
import { timeFormat, setTimeFormat, type TimeFormat } from "../preferences"
import {
  snapshot, prefs, busy, refresh,
  listLocales, listTimezones, applyLocale, applyTimezone, setNtp, setManualTime,
  setLocationBlocked, setLocationSource, setAutoTimezone,
  refreshAutoLocation, searchCity, setManualLocation, type CityResult,
} from "./fechaHora"
import textos from "../../../textos/ajustes/fecha-idioma.json" with { type: "json" }
import { formatearTexto } from "../../../textos/formatear"

// Nombre legible de un locale: "es_ES.UTF-8" → "Español (ES)".
const nombresIdioma = textos.idioma.nombres
const LANG_NAMES: Record<string, string> = {
  es: nombresIdioma.espanol, en: nombresIdioma.ingles, fr: nombresIdioma.frances,
  de: nombresIdioma.aleman, pt: nombresIdioma.portugues, it: nombresIdioma.italiano,
  ca: nombresIdioma.catalan, gl: nombresIdioma.gallego, eu: nombresIdioma.euskera,
  nl: nombresIdioma.neerlandes, ru: nombresIdioma.ruso, pl: nombresIdioma.polaco,
  ja: nombresIdioma.japones, zh: nombresIdioma.chino, ko: nombresIdioma.coreano,
  ar: nombresIdioma.arabe, sv: nombresIdioma.sueco, no: nombresIdioma.noruego,
  nb: nombresIdioma.noruegoBokmal, nn: nombresIdioma.noruegoNynorsk,
  da: nombresIdioma.danes, fi: nombresIdioma.fines, cs: nombresIdioma.checo,
  sk: nombresIdioma.eslovaco, hu: nombresIdioma.hungaro, ro: nombresIdioma.rumano,
  bg: nombresIdioma.bulgaro, el: nombresIdioma.griego, tr: nombresIdioma.turco,
  uk: nombresIdioma.ucraniano, he: nombresIdioma.hebreo, hi: nombresIdioma.hindi,
  th: nombresIdioma.tailandes, vi: nombresIdioma.vietnamita, id: nombresIdioma.indonesio,
  ms: nombresIdioma.malayo, fa: nombresIdioma.persa, cy: nombresIdioma.gales,
  ga: nombresIdioma.irlandes, is: nombresIdioma.islandes, hr: nombresIdioma.croata,
  sr: nombresIdioma.serbio, sl: nombresIdioma.esloveno, et: nombresIdioma.estonio,
  lv: nombresIdioma.leton, lt: nombresIdioma.lituano, mk: nombresIdioma.macedonio,
  sq: nombresIdioma.albanes, af: nombresIdioma.afrikaans, sw: nombresIdioma.suajili,
  bn: nombresIdioma.bengali, ta: nombresIdioma.tamil, te: nombresIdioma.telugu,
  ml: nombresIdioma.malayalam, kn: nombresIdioma["canarés"], mr: nombresIdioma.marati,
  gu: nombresIdioma.guyarati, pa: nombresIdioma.panyabi, ur: nombresIdioma.urdu,
  ka: nombresIdioma.georgiano, hy: nombresIdioma.armenio, az: nombresIdioma.azeri,
  kk: nombresIdioma.kazajo, uz: nombresIdioma.uzbeko, mn: nombresIdioma.mongol,
  km: nombresIdioma.jemer, lo: nombresIdioma.lao, my: nombresIdioma.birmano,
  si: nombresIdioma.cingales, ne: nombresIdioma.nepali, am: nombresIdioma.amarico,
  be: nombresIdioma.bielorruso,
}
function localeLabel(locale: string): string {
  const [lang, rest] = locale.split("_")
  const country = (rest ?? "").split(".")[0]
  const name = LANG_NAMES[lang] ?? lang
  return country ? formatearTexto(textos.idioma.formatoNombrePais, { nombre: name, pais: country }) : name
}

// Control segmentado (2+ opciones exclusivas) para elecciones binarias.
function Segmented({ options, current, onSelect }: {
  options: { value: string, label: string }[], current: any, onSelect: (v: string) => void,
}) {
  return (
    <box cssClasses={["dl-seg"]} valign={Gtk.Align.CENTER}>
      {options.map(o => (
        <button
          cssClasses={current((c: string) => c === o.value ? ["dl-seg-btn", "active"] : ["dl-seg-btn"])}
          onClicked={() => onSelect(o.value)}
        ><label label={o.label} /></button>
      ))}
    </box>
  )
}

type VistaFechaIdioma = "idioma" | "fecha" | "ubicacion"

export default function SeccionFechaIdioma({ vista }: { vista: VistaFechaIdioma }) {
  const [locales, setLocales] = createState<string[]>([])
  const [timezones, setTimezones] = createState<string[]>([])
  const [cityQuery, setCityQuery] = createState("")
  const [results, setResults] = createState<CityResult[]>([])
  const [manualTime, setManualTimeInput] = createState("")
  let activa = true
  let idBusqueda = 0
  onCleanup(() => {
    activa = false
    idBusqueda++
  })

  const opcionesIdiomas = createComputed(() => {
    const idiomaActual = snapshot().locale
    return locales().map((idioma) => ({
      value: idioma,
      label: localeLabel(idioma),
      active: idioma === idiomaActual,
    }))
  })
  const opcionesZonasHorarias = createComputed(() => {
    const zonaActual = snapshot().timezone
    return timezones().map((zona) => ({
      value: zona,
      label: zona,
      active: zona === zonaActual,
    }))
  })

  // Carga inicial: estado del sistema + listas de los selectores.
  refresh()
  if (vista === "idioma") {
    listLocales().then((lista) => { if (activa) setLocales(lista) }).catch(() => {})
  }
  if (vista === "fecha") {
    listTimezones().then((lista) => { if (activa) setTimezones(lista) }).catch(() => {})
  }

  const doSearch = () => {
    const q = cityQuery.get()
    const busquedaActual = ++idBusqueda
    if (!q.trim()) return setResults([])
    searchCity(q)
      .then((resultados) => {
        if (activa && busquedaActual === idBusqueda) setResults(resultados)
      })
      .catch(() => {
        if (activa && busquedaActual === idBusqueda) setResults([])
      })
  }

  // `vexpand` en el overlay + `valign START` en su hijo: la LISTA del select se dibuja
  // como overlay de ESTE widget, así que su alto útil es el del overlay menos lo que baja
  // el desplegable. En una sección corta (Idioma es un título y una tarjeta) el overlay
  // medía lo que medía el contenido y al desplegable le quedaban ~40 px: cabía una opción
  // y media de las 68 del idioma. Ahora el overlay se estira con el ScrolledWindow del
  // panel y el contenido se queda arriba, así que la lista tiene alto por debajo.
  return (
    <overlay cssClasses={["display-select-host"]} vexpand>
      <box orientation={Gtk.Orientation.VERTICAL} spacing={14} cssClasses={["sp-section", "dev-section"]} hexpand valign={Gtk.Align.START}>
        <TituloSeccion titulo={textos.vistas[vista]} />

        {/* ── Idioma ─────────────────────────────────────────────────── */}
        {vista === "idioma" && <TarjetaAjustes titulo={textos.tarjetas.idioma} icono="󰗊">
          <box cssClasses={["dev-row"]} orientation={Gtk.Orientation.VERTICAL} spacing={2}>
            <TituloAjuste label={textos.idioma.sistema.titulo} />
            {/* Sin `widthRequest` y sin `.sp-field`: los dos fijaban 560 px, o sea
                un ancho mayor que el hueco de contenido del panel en cuanto se le
                sumaba el relleno de la fila — de ahí el desplazamiento horizontal.
                Con `hexpand` el select ocupa lo que haya y encoge donde no lo hay. */}
            <box hexpand>
              <DisplaySelect
                compact={false}
                current={createComputed(() => localeLabel(snapshot().locale))}
                options={opcionesIdiomas}
                onSelect={(idioma) => applyLocale(idioma)}
              />
            </box>
            <TextoInformativo
              label={textos.idioma.sistema.descripcion}
              wrap
              xalign={0}
              maxWidthChars={72}
            />
          </box>
        </TarjetaAjustes>}

        {/* ── Fecha y hora ────────────────────────────────────────────── */}
        {vista === "fecha" && <TarjetaAjustes titulo={textos.tarjetas.fecha} icono="󰥔">
          <FilaAjuste titulo={textos.fechaHora.formatoHora.titulo} informacion={textos.fechaHora.formatoHora.descripcion}>
            <Segmented
              options={[{ value: "24h", label: textos.fechaHora.formatoHora.opciones.veinticuatroHoras }, { value: "12h", label: textos.fechaHora.formatoHora.opciones.doceHoras }]}
              current={timeFormat}
              onSelect={(v) => setTimeFormat(v as TimeFormat)}
            />
          </FilaAjuste>
          <FilaAjuste titulo={textos.fechaHora.ntp.titulo} informacion={textos.fechaHora.ntp.descripcion}>
            <Interruptor activo={snapshot(s => s.ntp)} alAlternar={() => setNtp(!snapshot.get().ntp)} />
          </FilaAjuste>
          <FilaAjuste titulo={textos.fechaHora.zonaAutomatica.titulo} informacion={textos.fechaHora.zonaAutomatica.descripcion}>
            <Interruptor activo={prefs(p => p.autoTimezone)} alAlternar={() => setAutoTimezone(!prefs.get().autoTimezone)} />
          </FilaAjuste>
          <With value={prefs(p => p.autoTimezone)}>
            {(auto: boolean) => auto ? <box /> : (
              <box cssClasses={["dev-row"]} orientation={Gtk.Orientation.VERTICAL} spacing={2}>
                <TituloAjuste label={textos.fechaHora.zonaManual.titulo} />
                <box hexpand>
                  <DisplaySelect
                    compact={false}
                    current={createComputed(() => snapshot().timezone || "—")}
                    options={opcionesZonasHorarias}
                    onSelect={(zona) => applyTimezone(zona)}
                  />
                </box>
                <TextoInformativo
                  label={textos.fechaHora.zonaManual.descripcion}
                  wrap
                  xalign={0}
                  maxWidthChars={72}
                />
              </box>
            )}
          </With>
          <With value={snapshot(s => s.ntp)}>
            {(ntp: boolean) => ntp ? <box /> : (
              <FilaAjuste titulo={textos.fechaHora.horaManual.titulo} informacion={textos.fechaHora.horaManual.descripcion}>
                <box spacing={8} valign={Gtk.Align.CENTER}>
                  <EntradaTextoAjustes placeholderText={textos.fechaHora.horaManual.placeholder}
                    onChanged={(e: Gtk.Entry) => setManualTimeInput(e.get_text())}
                    onActivate={() => setManualTime(manualTime.get())} />
                  <BotonAjustes label={textos.fechaHora.horaManual.aplicar} onClicked={() => setManualTime(manualTime.get())} />
                </box>
              </FilaAjuste>
            )}
          </With>
        </TarjetaAjustes>}

        {/* ── Ubicación ───────────────────────────────────────────────── */}
        {vista === "ubicacion" && <TarjetaAjustes titulo={textos.tarjetas.ubicacion} icono="󰍎">
          <FilaAjuste
            titulo={textos.ubicacion.permiso.titulo}
            informacion={snapshot(s => s.geoclueAvailable
              ? textos.ubicacion.permiso.descripcionConGeoClue
              : textos.ubicacion.permiso.descripcionSinGeoClue)}
          >
            <Interruptor activo={snapshot(s => !s.geoclueBlocked)} alAlternar={() => setLocationBlocked(!snapshot.get().geoclueBlocked)} />
          </FilaAjuste>

          {/* Con el permiso quitado, lo de debajo del interruptor se SIGUE VIENDO y
              se queda INSENSIBLE. Hubo una versión que lo ocultaba entero: dejaba la
              sección con un interruptor y un renglón, sin forma de mirar —ni de
              preparar— la ciudad guardada o el origen antes de volver a dar permiso.
              Y hubo otra anterior que lo dejaba plenamente usable, que era el bug
              contrario: la UI ofrecía buscar una ciudad con el bloqueo puesto. Lo
              insensible dice las dos cosas a la vez: está aquí, y ahora no aplica. */}
          <box cssClasses={["dev-row"]} visible={snapshot(s => s.geoclueBlocked)}>
            <label cssClasses={["account-notice"]} label={textos.ubicacion.bloqueada}
              halign={Gtk.Align.START} wrap xalign={0} maxWidthChars={52} />
          </box>

          <box orientation={Gtk.Orientation.VERTICAL} spacing={14}
            sensitive={snapshot(s => !s.geoclueBlocked)}>
            <FilaAjuste titulo={textos.ubicacion.origen.titulo} informacion={textos.ubicacion.origen.descripcion}>
              <Segmented
                options={[{ value: "auto", label: textos.ubicacion.origen.opciones.automatica }, { value: "manual", label: textos.ubicacion.origen.opciones.manual }]}
                current={prefs(p => p.source)}
                onSelect={(v) => setLocationSource(v as any)}
              />
            </FilaAjuste>

            <box cssClasses={["dev-row"]} orientation={Gtk.Orientation.VERTICAL} spacing={8}>
              <box spacing={10} valign={Gtk.Align.CENTER}>
                <box orientation={Gtk.Orientation.VERTICAL} spacing={2} hexpand>
                  <TituloAjuste label={textos.ubicacion.actual.titulo} halign={Gtk.Align.START} />
                  <TextoInformativo label={textos.ubicacion.actual.descripcion} />
                  <label cssClasses={["account-notice"]} label={prefs(p => p.location.name || textos.ubicacion.actual.sinDeterminar)} halign={Gtk.Align.START} wrap xalign={0} maxWidthChars={48} />
                </box>
                <With value={prefs(p => p.source)}>
                  {(src: string) => src === "auto"
                    ? <BotonAjustes label={busy(b => b ? textos.ubicacion.actual.actualizando : textos.ubicacion.actual.actualizar)} onClicked={() => refreshAutoLocation()} />
                    : <box />}
                </With>
              </box>

              <With value={prefs(p => p.source)}>
                {(src: string) => src !== "manual" ? <box /> : (
                  <box orientation={Gtk.Orientation.VERTICAL} spacing={8}>
                    <box spacing={8}>
                      <EntradaTextoAjustes placeholderText={textos.ubicacion.busqueda.placeholder} hexpand
                        onChanged={(e: Gtk.Entry) => setCityQuery(e.get_text())}
                        onActivate={doSearch} />
                      <BotonAjustes label={textos.ubicacion.busqueda.boton} onClicked={doSearch} />
                    </box>
                    <box orientation={Gtk.Orientation.VERTICAL} spacing={2}>
                      <For each={results}>
                        {(r: CityResult) => (
                          <button cssClasses={["dl-city-result"]} onClicked={() => { setManualLocation(r); setResults([]) }}>
                            <label label={r.name} halign={Gtk.Align.START} hexpand xalign={0} />
                          </button>
                        )}
                      </For>
                    </box>
                  </box>
                )}
              </With>
            </box>
          </box>
        </TarjetaAjustes>}
      </box>
    </overlay>
  )
}
