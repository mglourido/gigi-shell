// servicios/camara/vistaPrevia.ts
//
// "Probar cámara": abrir una ventana con lo que ve el sensor.
//
// ── POR QUÉ UNA VENTANA Y NO UN WIDGET DENTRO DEL PANEL ─────────────────────
// Empotrar vídeo en GTK4 desde AGS exige un `gtk4paintablesink` de GStreamer y
// mantener un pipeline vivo dentro del proceso que pinta la barra: si el
// pipeline se atasca (una cámara que se desenchufa a mitad de stream lo hace),
// se lleva por delante el hilo principal del SHELL ENTERO — barra, paneles y
// notificaciones. No compensa para un botón que se usa diez segundos.
//
// Se lanza `mpv` como ventana aparte, con su regla de Hyprland (flotante,
// centrada, tamaño fijo) en `hypr/gigios/reglas.lua`. Si el proceso muere, se
// muere él solo.
import { execAsync } from "ags/process"
import type { Camara } from "./dispositivos.ts"

/** Clase de ventana propia, para que la `windowrule` de Hyprland la reconozca
 *  sin casar con cualquier otro mpv que el usuario tenga abierto viendo una
 *  película. Debe coincidir con la regla de `hypr/gigios/reglas.lua`.
 *
 *  Se fija por partida DOBLE y no es redundante: `--x11-name` solo tiene efecto
 *  bajo XWayland, y en una sesión Wayland nativa —la nuestra— mpv se anuncia con
 *  el `app_id` de `--wayland-app-id`, que por defecto es `mpv` a secas. Con solo
 *  el primero, la regla no casaría nunca aquí y la ventana saldría en mosaico
 *  sin ningún error a la vista. Verificado con `hyprctl clients`. */
export const CLASE_VISTA_PREVIA = "gigios-camara-preview"

/** Abre la vista previa. No espera a que se cierre.
 *
 *  `--profile=low-latency` y `--untimed` importan: sin ellos mpv almacena en
 *  búfer como si fuera un vídeo y la imagen sale con casi un segundo de
 *  retraso, que en una vista previa para encuadrarse es inservible. */
export function abrirVistaPrevia(camara: Camara) {
  void execAsync([
    "mpv",
    `--x11-name=${CLASE_VISTA_PREVIA}`,
    `--wayland-app-id=${CLASE_VISTA_PREVIA}`,
    "--title=Cámara — vista previa",
    "--profile=low-latency",
    "--untimed",
    "--no-osc",
    "--no-input-default-bindings",
    // Sin audio: el nodo de vídeo no lo tiene y mpv se pondría a buscar uno.
    "--no-audio",
    `av://v4l2:${camara.nodo}`,
  ]).catch((e) => console.error("[camara] vista previa:", e))
}

/** Cierra cualquier vista previa abierta. La UI la llama al cerrar el panel:
 *  dejarse una ventana con la cámara encendida por detrás es, además de
 *  molesto, exactamente lo que el indicador de privacidad va a señalar. */
export function cerrarVistaPrevia() {
  // Casa por el nombre a secas, no por `--x11-name=…`: aparece en las dos
  // opciones de la línea de órdenes y así sigue valiendo si alguna deja de
  // pasarse. No puede matar otro mpv del usuario: la cadena es nuestra.
  void execAsync(["pkill", "-f", CLASE_VISTA_PREVIA]).catch(() => {})
}
