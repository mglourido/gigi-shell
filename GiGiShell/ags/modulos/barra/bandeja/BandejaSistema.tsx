import AstalTray from "gi://AstalTray"
import { createBinding, createComputed, For, With } from "ags"
import { Gtk } from "ags/gtk4"

import { hiddenTrayApps, trayOverflowAt } from "../../ajustes/trayApps"
import type { ControlVisibilidadBarra } from "../../../estado/visibilidadBarra"
import BotonElementoBandeja from "./BotonElementoBandeja"
import DesbordamientoBandeja from "./DesbordamientoBandeja"

/** Raíz reactiva del tray. Las ramas inline y overflow tienen scopes separados;
 * al cambiar el umbral, cada menú abierto libera su retención antes de desmontar. */
export default function BandejaSistema({ visibilidad }: { visibilidad: ControlVisibilidadBarra }) {
  const bandeja = AstalTray.get_default()
  const elementosCrudos = createBinding(bandeja, "items")
  const elementos = createComputed(() =>
    elementosCrudos().filter((elemento: AstalTray.TrayItem) =>
      !hiddenTrayApps().includes(elemento.id)
    ),
  )
  const usarDesbordamiento = createComputed(() => elementos().length >= trayOverflowAt())

  return (
    <box spacing={2}>
      <With value={usarDesbordamiento}>
        {(desbordamientoActivo) => desbordamientoActivo ? (
          <DesbordamientoBandeja elementos={elementos} visibilidad={visibilidad} />
        ) : (
          <box spacing={0}>
            <For each={elementos}>
              {(elemento) => (
                <BotonElementoBandeja elemento={elemento} visibilidad={visibilidad} />
              )}
            </For>
          </box>
        )}
      </With>
    </box>
  )
}
