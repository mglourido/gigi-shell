// Protección del sistema: vigilancia continua y un único destino para escaneos y aislamiento.
import { Gtk } from "ags/gtk4"
import { execAsync } from "ags/process"
import GLib from "gi://GLib"
import {
  AjusteInterruptor, TarjetaAjustes, TextoInformativo,
  TituloAjuste, TituloSeccion, TituloSubseccion,
} from "../componentes"
import {
  SECURITY_ITEMS, securityEnabled, setSecurityEnabled, type SecurityKey,
  DL_PAUSE_ITEMS, dlPauseEnabled, setDlPauseEnabled,
  dlMaxScanGB, setDlMaxScanGB,
  clamavAutoUpdatePref, setClamavAutoUpdatePref,
} from "./preferencias"
import {
  clamavPresent, clamavHelperInstalled, clamavDbEpoch, clamavServicioPeriodico, clamavBusy,
  refreshClamavState, updateClamavDb,
} from "../../../servicios/seguridad/clamav"
import textos from "../../../textos/ajustes/seguridad.json" with { type: "json" }

type VistaProteccion = "vigilancia" | "escaneos"
type Elemento = { key: SecurityKey; label: string; hint: string }

const GRUPOS_VIGILANCIA: { titulo: string; icono: string; claves: SecurityKey[] }[] = [
  { titulo: textos.grupos.kernelMemoria, icono: "󰒋", claves: ["oomKiller", "kernelPanic", "hungTask", "kernelModules"] },
  { titulo: textos.grupos.hardwareAlmacenamiento, icono: "󰋊", claves: ["hwErrors", "cpuThrottling", "diskError", "diskHealth", "gpuError"] },
  { titulo: textos.grupos.serviciosAplicaciones, icono: "󰒓", claves: ["serviceFailure", "serviceHealth", "appCrash"] },
  { titulo: textos.grupos.accesoIntegridad, icono: "󰌾", claves: ["sudoAuth", "privEsc", "ssh", "fileIntegrity"] },
]

function ElementoProteccion({ item }: { item: Elemento }) {
  const activo = securityEnabled(item.key)
  return (
    <AjusteInterruptor
      titulo={item.label}
      informacion={item.hint}
      activo={activo}
      alAlternar={() => setSecurityEnabled(item.key, !activo.get())}
    />
  )
}

function buscarElemento(clave: SecurityKey): Elemento {
  return SECURITY_ITEMS.find((item) => item.key === clave)!
}

function Vigilancia() {
  return (
    <box orientation={Gtk.Orientation.VERTICAL} spacing={12}>
      {GRUPOS_VIGILANCIA.map((grupo) => (
        <TarjetaAjustes titulo={grupo.titulo} icono={grupo.icono}>
          {grupo.claves.map((clave) => <ElementoProteccion item={buscarElemento(clave)} />)}
        </TarjetaAjustes>
      ))}
    </box>
  )
}

function RecursosDescargas() {
  let entradaGb: Gtk.Entry
  const guardarGb = () => {
    const valor = parseFloat((entradaGb?.get_text() ?? "").trim().replace(",", "."))
    if (Number.isFinite(valor) && valor > 0) setDlMaxScanGB(valor)
    entradaGb.set_text(String(dlMaxScanGB.get()))
  }
  const escanearDescargas = () => {
    execAsync([`${GLib.get_user_config_dir()}/hypr/scripts/scan-downloads.sh`]).catch(() => {})
  }
  return (
    <box orientation={Gtk.Orientation.VERTICAL} visible={securityEnabled("downloadScan")}>
      {DL_PAUSE_ITEMS.map((item) => {
        const activo = dlPauseEnabled(item.key)
        return <AjusteInterruptor titulo={item.label} informacion={item.hint} activo={activo} alAlternar={() => setDlPauseEnabled(item.key, !activo.get())} />
      })}
      <box orientation={Gtk.Orientation.VERTICAL} spacing={5} cssClasses={["dev-row"]}>
        <TituloAjuste label={textos.recursosDescargas.limite.titulo} halign={Gtk.Align.START} />
        <TextoInformativo label={textos.recursosDescargas.limite.descripcion} halign={Gtk.Align.START} wrap maxWidthChars={62} xalign={0} />
        <box spacing={6} valign={Gtk.Align.CENTER}>
          <entry cssClasses={["sp-num-input"]} hexpand placeholderText={textos.recursosDescargas.limite.placeholder}
            $={(self: Gtk.Entry) => { entradaGb = self; self.set_text(String(dlMaxScanGB.get())) }} onActivate={guardarGb} />
          <button cssClasses={["sp-add-rule"]} onClicked={guardarGb}><label label={textos.recursosDescargas.limite.guardar} /></button>
        </box>
      </box>
      <box orientation={Gtk.Orientation.VERTICAL} spacing={6} cssClasses={["dev-row"]}>
        <button cssClasses={["sp-add-rule"]} onClicked={escanearDescargas} halign={Gtk.Align.START}>
          <label label={textos.recursosDescargas.escaneoForzado.boton} />
        </button>
        <TextoInformativo label={textos.recursosDescargas.escaneoForzado.descripcion} halign={Gtk.Align.START} wrap maxWidthChars={62} xalign={0} />
      </box>
    </box>
  )
}

function Descargas() {
  return (
    <TarjetaAjustes titulo={textos.tarjetas.descargas} icono="󰇚">
      <ElementoProteccion item={buscarElemento("downloadScan")} />
      <RecursosDescargas />
    </TarjetaAjustes>
  )
}

function AccionArchivo({ titulo, descripcion, placeholder, etiquetaBoton, script, visible }: {
  titulo: string
  descripcion: string
  placeholder: string
  etiquetaBoton: string
  script: string
  visible?: any
}) {
  let entrada: Gtk.Entry
  const ejecutar = () => {
    const ruta = entrada?.get_text().trim()
    if (!ruta) return
    execAsync([`${GLib.get_user_config_dir()}/hypr/scripts/${script}`, ruta]).catch(() => {})
    entrada.set_text("")
  }
  const propiedadesVisibilidad = visible === undefined ? {} : { visible }
  return (
    <box orientation={Gtk.Orientation.VERTICAL} spacing={6} cssClasses={["dev-row"]} {...propiedadesVisibilidad}>
      <TituloSubseccion label={titulo} halign={Gtk.Align.START} />
      <TextoInformativo label={descripcion} halign={Gtk.Align.START} wrap maxWidthChars={62} xalign={0} />
      <box spacing={6} valign={Gtk.Align.CENTER}>
        <entry cssClasses={["sp-num-input"]} hexpand placeholderText={placeholder}
          $={(self: Gtk.Entry) => { entrada = self }} onActivate={ejecutar} />
        <button cssClasses={["sp-add-rule"]} onClicked={ejecutar}><label label={etiquetaBoton} /></button>
      </box>
    </box>
  )
}

function Herramientas() {
  return (
    <TarjetaAjustes titulo={textos.tarjetas.herramientas} icono="󰒓">
      <ElementoProteccion item={buscarElemento("sandboxLaunch")} />
      <AccionArchivo
        titulo={textos.lanzamientoAislado.titulo}
        descripcion={textos.lanzamientoAislado.descripcion}
        placeholder={textos.lanzamientoAislado.placeholder}
        etiquetaBoton={textos.lanzamientoAislado.boton}
        script="run-untrusted.sh"
        visible={securityEnabled("sandboxLaunch")}
      />
      <AccionArchivo
        titulo={textos.analisisManual.titulo}
        descripcion={textos.analisisManual.descripcion}
        placeholder={textos.analisisManual.placeholder}
        etiquetaBoton={textos.analisisManual.boton}
        script="scan-file.sh"
      />
    </TarjetaAjustes>
  )
}

// Base de firmas. Sin ella `clamscan` sale con código 2 y NADA se da por analizado, así que esta
// tarjeta va la primera: es la precondición de todo lo demás de esta vista. Solo desaparece si no
// hay ClamAV; con el helper root ausente SÍ se pinta, enseñando la orden que falta — ver el
// comentario de `clamavHelperInstalled`.
function Firmas() {
  if (!clamavPresent) return <box visible={false} />
  refreshClamavState()
  const fecha = clamavDbEpoch((t) => t === null
    ? textos.firmas.sinBase
    : textos.firmas.ultima.replace("{fecha}", GLib.DateTime.new_from_unix_local(t).format("%d/%m/%Y %H:%M") ?? ""))
  return (
    <TarjetaAjustes titulo={textos.tarjetas.firmas} icono="󰒃">
      {/* Un BOOLEANO nuestro (`clamavAutoUpdate` en security.json), no el estado de un servicio:
          gobierna si `actualizar-firmas.sh --auto` descarga al ARRANCAR la sesión, que es lo único
          automático que queda — no hay temporizador ni servicio corriendo durante la sesión. La
          fila se oculta SOLO si falta el helper root, porque entonces nada de esto puede funcionar
          y un interruptor que no aplica nada es peor que su ausencia — ahí el texto de
          `sinAyudante` dice qué instalar. Ya no depende de poder consultar systemd: el estado es
          del usuario y siempre se conoce. */}
      <AjusteInterruptor
        titulo={textos.firmas.automatica.titulo}
        informacion={textos.firmas.automatica.descripcion}
        visible={clamavHelperInstalled}
        activo={clamavAutoUpdatePref}
        alAlternar={() => setClamavAutoUpdatePref(!clamavAutoUpdatePref.get())}
      />
      <box orientation={Gtk.Orientation.VERTICAL} spacing={6} cssClasses={["dev-row"]}>
        <TituloSubseccion label={textos.firmas.titulo} halign={Gtk.Align.START} />
        <TextoInformativo label={textos.firmas.descripcion} halign={Gtk.Align.START} wrap maxWidthChars={62} xalign={0} />
        <TextoInformativo label={fecha} halign={Gtk.Align.START} wrap maxWidthChars={62} xalign={0} />
        {/* El actualizador periódico heredado. Con el interruptor encendido, `refreshClamavState`
            ya lo apaga solo, así que esta línea solo aparece si el usuario lo tiene apagado y el
            servicio sigue vivo — o sea, cuando de verdad hay dos actualizadores. `null` (no se
            pudo consultar) no pinta nada: afirmar aquí sería inventarse el estado del sistema. */}
        <TextoInformativo
          label={textos.firmas.servicioPeriodico}
          visible={clamavServicioPeriodico((v) => v === true)}
          halign={Gtk.Align.START} wrap maxWidthChars={62} xalign={0} />
        <button cssClasses={["sp-add-rule"]} onClicked={updateClamavDb} halign={Gtk.Align.START}
          visible={clamavHelperInstalled} sensitive={clamavBusy((b) => !b)}>
          <label label={clamavBusy((b) => b ? textos.firmas.actualizando : textos.firmas.boton)} />
        </button>
        <TextoInformativo label={textos.firmas.sinAyudante} visible={!clamavHelperInstalled}
          halign={Gtk.Align.START} wrap maxWidthChars={62} xalign={0} selectable />
      </box>
    </TarjetaAjustes>
  )
}

function Escaneos() {
  return (
    <box orientation={Gtk.Orientation.VERTICAL} spacing={12}>
      <Firmas />
      <Descargas />
      <Herramientas />
    </box>
  )
}

export default function SeccionSeguridad({ vista }: { vista: VistaProteccion }) {
  return (
    <box orientation={Gtk.Orientation.VERTICAL} spacing={12} cssClasses={["sp-section", "dev-section"]} hexpand>
      <TituloSeccion titulo={textos.vistas[vista]} />
      <TextoInformativo label={textos.descripciones[vista]} halign={Gtk.Align.START} wrap maxWidthChars={62} xalign={0} />
      {vista === "vigilancia" ? <Vigilancia /> : <Escaneos />}
    </box>
  )
}
