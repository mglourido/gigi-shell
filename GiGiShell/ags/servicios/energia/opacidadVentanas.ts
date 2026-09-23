// servicios/energia/opacidadVentanas.ts
//
// Quitar la transparencia de las VENTANAS DE HYPRLAND mientras dura el modo ahorro.
// Es el gemelo de `opacidadAhorro.ts`: aquel deja opacas las láminas del shell (GTK),
// este deja opacas las ventanas del compositor.
//
// QUÉ SE AHORRA
// -------------
// `decoration:inactive_opacity` está en 0.92 (ver `hypr/gigios/ventanas.lua`), así que
// toda ventana sin foco es semitransparente. Una superficie con alfa < 1 obliga a
// Hyprland a componer lo que hay DEBAJO —el resto del mosaico y el fondo de pantalla— en
// cada fotograma que se redibuje, y la excluye de los atajos de región opaca. Con las dos
// opacidades a 1.0 la ventana de delante tapa de verdad. Como el de los paneles, es de los
// pocos ajustes del ahorro que ahorran mientras el usuario MIRA algo.
//
// LAS DOS MITADES, Y POR QUÉ SON DOS
// ----------------------------------
// 1. EN VIVO: `hyprctl eval "GiGiShell.opacidad_ahorro(<bool>)"`. Bajo config Lua no existe
//    `hyprctl keyword` (ver `servicios/pantalla/service.ts`), y de ahí el eval.
//    Se llama a la función del config y NO se manda un `hl.config` con los valores desde
//    aquí a propósito: la opacidad a la que hay que VOLVER al salir del ahorro (0.92) vive
//    en la tabla `aspecto` de `ventanas.lua`, y copiarla en TypeScript es la misma
//    desincronización silenciosa que ese fichero ya documenta para el toggle de gaps.
//    La forma `GiGiShell and GiGiShell.opacidad_ahorro and …` es defensiva porque `hyprctl eval`
//    envuelve lo que le pasas en un `return …;`: si el módulo no cargó, un `nil` se
//    invocaría y el error saldría por stdout (con código de salida 0, que es justo lo que
//    hace que estos fallos pasen inadvertidos).
//
// 2. EN DISCO: `~/.config/gigios/opacidad-ventanas.json` = `{ "forzada": bool }`. Hace
//    falta porque un `hyprctl reload` RE-EJECUTA `ventanas.lua`, que reaplicaría el 0.92
//    sin que AGS se entere — no hay señal de recarga; es exactamente el motivo por el que
//    `display.json` lo lee también el compositor. Y cubre el otro sentido: si la sesión
//    arranca con el ahorro ya puesto, el config nace opaco sin esperar a que AGS suba.
//    El valor va COMBINADO (ahorro activo Y ajuste encendido), como `powerSaveFreeze` en
//    runtime-state.json: el lado Lua no reevalúa nada.
//
// El fichero se escribe SÍNCRONO y ANTES del eval, por lo mismo que `saveDisplayConfigNow`:
// con un debounce de por medio, un `hyprctl reload` disparado justo después de entrar en
// ahorro releería el fichero viejo y desharía el cambio.
//
// NO HAY APUNTE DE RECUPERACIÓN, y aquí no hace falta (al revés que en `brilloAhorro.ts` o
// `inactividadAhorro.ts`): esto no aparta ningún valor del usuario. El estado al que se
// vuelve está escrito en el config del compositor, así que un AGS que muera con el ahorro
// puesto deja, como mucho, las ventanas opacas hasta el siguiente `hyprctl reload` —
// visible, inocuo y sin residuo en disco que pueda contaminar los ajustes reales.
import GLib from "gi://GLib"
import { execAsync } from "ags/process"
import { opacidadVentanasForzada } from "./powerState"

const RUTA = `${GLib.get_user_config_dir()}/gigios/opacidad-ventanas.json`

let arrancado = false
/** Último valor publicado, para no repetir escritura ni `hyprctl` en un cambio que no cambia. */
let ultimo: boolean | null = null

/** Lo que el config del compositor ya está viendo, o `null` si no hay fichero legible. */
function leerDisco(): boolean | null {
  try {
    const [ok, contenido] = GLib.file_get_contents(RUTA)
    if (!ok) return null
    const datos = JSON.parse(new TextDecoder().decode(contenido))
    return typeof datos?.forzada === "boolean" ? datos.forzada : null
  } catch (_) {
    return null
  }
}

function escribir(forzada: boolean): void {
  try {
    const dir = GLib.path_get_dirname(RUTA)
    if (!GLib.file_test(dir, GLib.FileTest.EXISTS)) GLib.mkdir_with_parents(dir, 0o755)
    GLib.file_set_contents(RUTA, JSON.stringify({ forzada }))
  } catch (e) {
    console.error("[opacidad-ventanas] no se pudo guardar:", e)
  }
}

function aplicar(forzada: boolean): void {
  if (forzada === ultimo) return
  ultimo = forzada
  escribir(forzada)
  execAsync([
    "hyprctl", "eval",
    `GiGiShell and GiGiShell.opacidad_ahorro and GiGiShell.opacidad_ahorro(${forzada})`,
  ]).catch(e => console.error("[opacidad-ventanas] hyprctl eval falló:", e))
}

/**
 * Arranca la opacidad de ventanas del ahorro. Idempotente.
 *
 * Va a t=0 con `initOpacidadAhorro()` y no con los `init*` apartados a los 4 s, por lo
 * mismo: SE VE. Y le sale gratis, porque la primera pasada solo lanza el `hyprctl` cuando
 * el estado deseado NO coincide con el que ya hay en disco — o sea, con el que el config
 * aplicó al cargarse. En el arranque normal eso es no lanzar nada.
 */
export function initOpacidadVentanas(): void {
  if (arrancado) return
  arrancado = true

  ultimo = leerDisco()
  opacidadVentanasForzada.subscribe(() => aplicar(opacidadVentanasForzada.get()))
  aplicar(opacidadVentanasForzada.get())
}
