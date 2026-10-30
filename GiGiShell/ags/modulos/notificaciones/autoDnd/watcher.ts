// notifications/autoDnd/watcher.ts
//
// Silencio automático. Publica qué condiciones hay activas (juego, app marcada, pantalla
// completa) y deja a `notificacionPermitida` decidir con la política de cada una.
//
// NO toca `notifd.dontDisturb`. Un interruptor global no puede expresar «solo sistema» ni «estas
// apps», y compartirlo con el botón de la barra obligaba a adivinar quién lo había encendido.
// El No molestar manual sigue siendo independiente y tapa todo.
//
// Solo afecta a popups y sonido: `ingest()` guarda la notificación igual, así que panel,
// historial y reglas no cambian.
//
// Un único watcher para todo el shell (no por monitor). Se arranca una vez desde
// app.ts vía initAutoDnd(); llamarlo más de una vez es no-op.

import AstalHyprland from "gi://AstalHyprland"
import { condicionesActivas } from "./detect.ts"
import { permitidaEnCondiciones, type CondicionSilencio } from "./politica.ts"
import { expirarPopupsNoPermitidos } from "../popup/pila.ts"
import { autoDndFullscreenApps, silencioAuto } from "../../ajustes/preferences.ts"
import {
  esClienteRegistradoComoJuego,
  iniciarRegistroJuegos,
  revisionVentanas,
} from "../../../servicios/juegos/registro"

let started = false
let activas: Set<CondicionSilencio> = new Set()

export function notificacionPermitida(notificacion: { appName: string; source?: string }): boolean {
  return permitidaEnCondiciones(notificacion, activas, silencioAuto.get())
}

function evaluate(): void {
  const hypr = AstalHyprland.get_default()
  iniciarRegistroJuegos()
  // Sólo cuenta lo que hay en el workspace que estás mirando: un juego en
  // fullscreen en otro workspace no debe silenciar hasta que te muevas a él.
  activas = condicionesActivas(
    hypr.get_clients?.() ?? [],
    autoDndFullscreenApps.get(),
    hypr.focusedWorkspace?.id ?? null,
    esClienteRegistradoComoJuego,
  )
  // El filtro solo frena los popups NUEVOS; los que ya estaban en pantalla
  // seguirían tapando el juego hasta agotar su tiempo.
  expirarPopupsNoPermitidos(notificacionPermitida)
}

export function initAutoDnd(): void {
  if (started) return
  started = true

  // El registro singleton ya concentra los eventos Hyprland y los reintentos tardíos.
  revisionVentanas.subscribe(evaluate)
  autoDndFullscreenApps.subscribe(evaluate)
  silencioAuto.subscribe(evaluate)
  evaluate()
}
