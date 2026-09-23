import { createState, createComputed } from "ags"
import { Gtk } from "ags/gtk4"
import { AjusteInterruptor, BotonAjustes, TarjetaAjustes, TextoInformativo, TituloAjuste } from "../componentes"
import FilaInactividad from "./FilaInactividad"
import { guardarInactividadGeneral, leerInactividadGeneral } from "../../../servicios/pantalla/inactividadAhorro"
import {
  comprobarHibernacion,
  hibernacionActivable,
  hibernacionMotivo,
  leerHibernacion,
  planificar,
  prepararHibernacion,
  quitarHibernacion,
} from "../../../servicios/energia/hibernacion"
import textos from "../../../textos/ajustes/pantalla.json" with { type: "json" }

/**
 * Tiempos de inactividad GENERALES. No escribe en hypridle.conf directamente: pasa por
 * `guardarInactividadGeneral`, que desvía la escritura al apunte mientras el modo ahorro
 * tiene sus propios tiempos puestos — si no, la restauración del final del ahorro borraría
 * lo que se acabara de editar aquí. Por lo mismo lee con `leerInactividadGeneral`, que con
 * el override puesto devuelve los valores de siempre y no los del ahorro.
 * Ver `servicios/pantalla/inactividadAhorro.ts`.
 */
export default function Inactividad() {
  const configuracion = leerInactividadGeneral() || {
    dpms: { timeout: 600, enabled: true },
    lock: { timeout: 630, enabled: true },
    suspend: { timeout: 660, enabled: true },
    hibernate: { timeout: 3000, enabled: false },
    bloqueoAlSuspender: true,
  }
  // El tiempo de hibernación NO sale de hypridle.conf aunque allí haya un listener: el número
  // que ve el usuario es la inactividad TOTAL, y quién la cuenta (systemd durante la suspensión
  // o el listener) lo decide `planificar()`. Ver servicios/energia/hibernacion.ts.
  const hibernacion = leerHibernacion()
  const aMinutos = (segundos: number) => Math.max(1, Math.round(segundos / 60))
  const [minutosDpms, fijarMinutosDpms] = createState(aMinutos(configuracion.dpms.timeout))
  const [minutosBloqueo, fijarMinutosBloqueo] = createState(aMinutos(configuracion.lock.timeout))
  const [minutosSuspension, fijarMinutosSuspension] = createState(aMinutos(configuracion.suspend.timeout))
  const [dpmsActivo, fijarDpmsActivo] = createState(configuracion.dpms.enabled)
  const [bloqueoActivo, fijarBloqueoActivo] = createState(configuracion.lock.enabled)
  const [suspensionActiva, fijarSuspensionActiva] = createState(configuracion.suspend.enabled)
  const [bloquearAlSuspender, fijarBloquearAlSuspender] = createState(configuracion.bloqueoAlSuspender)
  const [minutosHibernar, fijarMinutosHibernar] = createState(aMinutos(hibernacion.totalSeconds))
  const [hibernarActivo, fijarHibernarActivo] = createState(hibernacion.enabled)
  // La disponibilidad se pregunta a logind al pintar la tarjeta y no se cachea entre sesiones:
  // pasa de "no" a "sí" con un reinicio (resume= entra por la línea de comandos del kernel), y
  // una respuesta guardada de antes del reinicio sería justo la equivocada.
  comprobarHibernacion()
  const guardar = () => guardarInactividadGeneral({
    dpms: { timeout: minutosDpms.get() * 60, enabled: dpmsActivo.get() },
    lock: { timeout: minutosBloqueo.get() * 60, enabled: bloqueoActivo.get() },
    suspend: { timeout: minutosSuspension.get() * 60, enabled: suspensionActiva.get() },
  }, bloquearAlSuspender.get(), {
    enabled: hibernarActivo.get(),
    totalSeconds: minutosHibernar.get() * 60,
  })

  // Explica, con los números puestos, cuál de los dos mecanismos va a cumplir el tiempo. Sin
  // esto el ajuste parece que no hace nada: hibernar a los 50 min con suspensión a los 20 se ve
  // desde fuera como "se suspendió a los 20", y que a los 50 el equipo despierte solo un
  // instante para apagarse del todo es justo lo que hay que anunciar.
  const explicacion = createComputed(
    [minutosHibernar, hibernarActivo, minutosSuspension, suspensionActiva, hibernacionActivable, hibernacionMotivo],
    (minHib, hibOn, minSus, susOn, disponible, motivo) => {
      if (!disponible) return motivo
      if (!hibOn) return textos.suspension.hibernarDetalle
      const plan = planificar(
        { enabled: true, totalSeconds: minHib * 60 },
        { timeout: minSus * 60, enabled: susOn },
      )
      return plan.modo === "retardo"
        ? textos.suspension.hibernarViaSuspension
            .replace("{suspension}", String(minSus))
            .replace("{retardo}", String(Math.round(plan.retardo / 60)))
        : textos.suspension.hibernarDirecta
    },
  )

  return (
    <TarjetaAjustes titulo={textos.suspension.titulo} icono="󰒲">
      <box cssClasses={["dev-row"]}>
        <TextoInformativo label={textos.suspension.descripcion} halign={Gtk.Align.START} wrap maxWidthChars={62} xalign={0} />
      </box>
      <FilaInactividad etiqueta={textos.suspension.apagarPantalla} minutos={minutosDpms} fijarMinutos={fijarMinutosDpms} activo={dpmsActivo} fijarActivo={fijarDpmsActivo} guardar={guardar} />
      <FilaInactividad etiqueta={textos.suspension.bloquear} minutos={minutosBloqueo} fijarMinutos={fijarMinutosBloqueo} activo={bloqueoActivo} fijarActivo={fijarBloqueoActivo} guardar={guardar} />
      <FilaInactividad etiqueta={textos.suspension.suspender} minutos={minutosSuspension} fijarMinutos={fijarMinutosSuspension} activo={suspensionActiva} fijarActivo={fijarSuspensionActiva} guardar={guardar} />
      <box hexpand visible={hibernacionActivable}>
        <FilaInactividad etiqueta={textos.suspension.hibernar} minutos={minutosHibernar} fijarMinutos={fijarMinutosHibernar} activo={hibernarActivo} fijarActivo={fijarHibernarActivo} guardar={guardar} />
      </box>
      <box cssClasses={["dev-row"]} spacing={8} valign={Gtk.Align.CENTER} visible={hibernacionActivable((v) => !v)}>
        <TituloAjuste label={textos.suspension.hibernar} hexpand halign={Gtk.Align.START} />
        <label cssClasses={["sp-step-val", "off"]} label={textos.suspension.hibernarNoDisponible} />
      </box>
      <box cssClasses={["dev-row"]}>
        <TextoInformativo label={explicacion} halign={Gtk.Align.START} wrap maxWidthChars={62} xalign={0} />
      </box>
      {/*
        Preparar/quitar el SISTEMA de hibernación (swapfile, resume=, VRAM de NVIDIA), no el
        tiempo de arriba. Cada fila es mutuamente excluyente con la otra vía hibernacionActivable,
        igual que "No disponible" arriba lo es con el selector de minutos.
      */}
      <box cssClasses={["dev-row"]} spacing={8} valign={Gtk.Align.CENTER} visible={hibernacionActivable((v) => !v)}>
        <TextoInformativo label={textos.suspension.hibernarPrepararInfo} hexpand halign={Gtk.Align.START} wrap maxWidthChars={48} xalign={0} />
        <BotonAjustes variante="principal" label={textos.suspension.hibernarPreparar} onClicked={prepararHibernacion} />
      </box>
      <box cssClasses={["dev-row"]} spacing={8} valign={Gtk.Align.CENTER} visible={hibernacionActivable}>
        <TextoInformativo label={textos.suspension.hibernarQuitarInfo} hexpand halign={Gtk.Align.START} wrap maxWidthChars={48} xalign={0} />
        <BotonAjustes variante="secundario" label={textos.suspension.hibernarQuitar} onClicked={quitarHibernacion} />
      </box>
      <AjusteInterruptor
        titulo={textos.suspension.bloquearAlSuspender.titulo}
        informacion={textos.suspension.bloquearAlSuspender.descripcion}
        activo={bloquearAlSuspender}
        alAlternar={() => { fijarBloquearAlSuspender(!bloquearAlSuspender.get()); guardar() }}
      />
    </TarjetaAjustes>
  )
}
