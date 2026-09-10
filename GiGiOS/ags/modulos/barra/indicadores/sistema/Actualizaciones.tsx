// Iconos de la barra (a la izquierda del botón de notificaciones) que avisan de
// actualizaciones IMPORTANTES: uno para el kernel y otro, separado, para los drivers
// de la GPU. Cada uno aparece solo si su categoría tiene algo pendiente. Las
// actualizaciones normales de paquetes/dependencias NO hacen aparecer ningún icono
// (son ruido); se listan como contexto al abrir el popover.
//
// No hay polling aquí: hypr/scripts/updates-monitor.sh escribe
// ~/.config/gigios/updates.json y esto lo observa con un Gio.FileMonitor, igual que
// el bar-toggle de state.tsx.
import { onCleanup } from "ags"
import { Gtk } from "ags/gtk4"
import { panelAutoClose } from "../../../../estado/shell"
import { datosActualizaciones } from "../../../../servicios/sistema/actualizaciones"
import { abrirEnTerminal } from "../../../../utilidades/abrirTerminal"
import { colgarDeBarra } from "../../componentes/anclaBarra"
import { tituloBarra } from "../../componentes/tituloBarra"
import { crearControlPopoverAnclado } from "../../componentes/controlPopoverAnclado"
import { ESLABON, SensorCadena, type CadenaEstado } from "../../componentes/cadenaEstado"
import type { ControlVisibilidadBarra } from "../../../../estado/visibilidadBarra"

// Abre la actualización en una terminal (kitty = $terminal del sistema, con fallback).
// Ver `utilidades/abrirTerminal.ts`: es donde vive el picker, porque este ya no es el
// único sitio que necesita pedir sudo interactivamente (ver también Ajustes > Pantalla
// > Suspensión, preparar/quitar la hibernación).
function lanzarActualizacion(cmd: string) {
  if (!cmd) return
  abrirEnTerminal(cmd, "updates").catch(() => {})
}

type TipoActualizacion = "kernel" | "gpu"

const METADATOS_TIPO: Record<TipoActualizacion, { icon: string; title: string; noun: string }> = {
  kernel: { icon: "", title: "Actualización de kernel", noun: "kernel" },
  gpu: { icon: "󰢮", title: "Actualización de drivers de GPU", noun: "drivers de GPU" },
}

const INDICE_ESLABON: Record<TipoActualizacion, number> = {
  kernel: ESLABON.actualizacionesKernel,
  gpu: ESLABON.actualizacionesGpu,
}

export default function Actualizaciones({
  visibilidad,
  cadena,
}: {
  visibilidad: ControlVisibilidadBarra
  cadena: CadenaEstado
}) {
  const data = datosActualizaciones

  // Construye uno de los dos iconos. Cada uno tiene su propio popover, anclado a sí
  // mismo, y se muestra solo si su categoría tiene paquetes pendientes.
  const crearIcono = (kind: TipoActualizacion) => {
    const meta = METADATOS_TIPO[kind]
    const list = data((d) => d[kind])
    const indice = INDICE_ESLABON[kind]

    let activePopover: Gtk.Popover | null = null
    let btnRef: Gtk.Widget | null = null
    const controlMenu = crearControlPopoverAnclado(visibilidad)
    const autoClose = panelAutoClose(() => { if (activePopover) activePopover.popdown() }, 250)

    const finalizarPopover = (popover: Gtk.Popover) => {
      if (activePopover === popover) {
        activePopover = null
        controlMenu.cerrar()
      }
      try { popover.unparent() } catch (_) {}
    }

    const buildCard = () => {
      const d = data.get()
      const card = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 4 })
      card.add_css_class("upd-popover")

      const cardMotion = new Gtk.EventControllerMotion()
      cardMotion.connect("enter", () => autoClose.onEnter())
      cardMotion.connect("leave", () => autoClose.onLeave())
      card.add_controller(cardMotion)

      const header = new Gtk.Label({ label: meta.title, xalign: 0 })
      header.add_css_class("upd-popover-header")
      card.append(header)

      for (const p of d[kind]) {
        const ver = p.from && p.to ? `${p.from} → ${p.to}` : (p.to || "")
        const row = new Gtk.Label({ label: `${meta.icon}  ${p.name}${ver ? "  " + ver : ""}`, xalign: 0, wrap: true, maxWidthChars: 42 })
        row.add_css_class("upd-row")
        row.add_css_class(kind)
        card.append(row)
      }

      // Resto de paquetes/dependencias: contexto, no motivo de aviso. Se actualizan
      // igualmente con el botón de abajo (el comando actualiza el sistema entero).
      if (d.system > 0) {
        const sysTitle = new Gtk.Label({ label: `󰆼  Otros: ${d.system} ${d.system === 1 ? "paquete" : "paquetes"}`, xalign: 0 })
        sysTitle.add_css_class("upd-row")
        sysTitle.add_css_class("system")
        card.append(sysTitle)

        if (d.systemSample.length > 0) {
          const more = d.system > d.systemSample.length ? ", …" : ""
          const names = new Gtk.Label({ label: d.systemSample.join(", ") + more, xalign: 0, wrap: true, maxWidthChars: 42 })
          names.add_css_class("upd-sample")
          card.append(names)
        }
      }

      const btn = new Gtk.Button({ label: "Actualizar", halign: Gtk.Align.START })
      btn.add_css_class("upd-update-btn")
      btn.connect("clicked", () => {
        lanzarActualizacion(data.get().updateCmd)
        if (activePopover) activePopover.popdown()
      })
      card.append(btn)

      return card
    }

    const openPopover = () => {
      if (activePopover) { activePopover.popdown(); return }
      if (!btnRef) return
      const pop = new Gtk.Popover()
      pop.add_css_class("upd-popover-container")
      pop.set_has_arrow(true)
      // Sin autohide, igual que Recursos.tsx y la vista previa de escritorios: con el
      // autohide por defecto GTK toma un grab al hacer popup, el botón recibe al
      // instante un `leave` y `panelAutoClose` cierra el popover recién abierto. El
      // cierre lo gobierna el motion controller (botón + tarjeta) y el propio botón.
      pop.set_autohide(false)
      pop.set_child(buildCard())
      pop.set_parent(btnRef)
      colgarDeBarra(pop)
      activePopover = pop
      controlMenu.abrir()
      pop.connect("closed", () => finalizarPopover(pop))
      pop.popup()
    }

    onCleanup(() => {
      autoClose.dispose()
      const popover = activePopover
      if (popover) {
        try { popover.popdown() } catch (_) {}
        finalizarPopover(popover)
      }
      controlMenu.cerrar()
      btnRef = null
    })

    const titulo = data((d) => {
      const names = d[kind].map((p) => p.name).join(", ")
      if (!names) return `Sin actualizaciones de ${meta.noun}`
      const tail = d.system > 0 ? ` — y ${d.system} paquete${d.system === 1 ? "" : "s"} más` : ""
      return `${meta.title}: ${names}${tail}`
    })

    return (
      <button
        // El popover se ancla al propio botón. Usamos onClicked (no un GestureClick
        // de botón primario): Gtk.Button reclama esa secuencia de clic para sí, así
        // que un gesture primario encima no llegaría a dispararse.
        $={(self: Gtk.Widget) => {
          btnRef = self
          tituloBarra(self, titulo)
        }}
        visible={list((l) => l.length > 0)}
        cssClasses={["bar-pill-btn"]}
        onClicked={openPopover}
      >
        <Gtk.EventControllerMotion onEnter={autoClose.onEnter} onLeave={autoClose.onLeave} />
        <SensorCadena cadena={cadena} indice={indice} />
        {/* Solo el icono: el número sobraba. El detalle (qué paquetes, de qué
            versión a cuál) está en el tooltip y en el popover. */}
        <box
          cssClasses={cadena.clases(indice, ["bar-pill", "upd-pill", kind])}
          halign={Gtk.Align.CENTER}
          valign={Gtk.Align.CENTER}
        >
          <label cssClasses={["upd-icon"]} label={meta.icon} />
        </box>
      </button>
    )
  }

  return (
    <box spacing={0}>
      {crearIcono("kernel")}
      {crearIcono("gpu")}
    </box>
  )
}
