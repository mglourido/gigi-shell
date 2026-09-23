// servicios/energia/suspensionFalsa/audio.ts
//
// Silenciar la salida de audio mientras dure la suspensión falsa. Nace APAGADO en los
// ajustes (`sfMuteAudio`) y el motivo es concreto: puede que la música sea justo lo que se
// quiere dejar sonando mientras el equipo se queda solo.
//
// ⚠️ NO CONFUNDIR CON `sfMuteNotis` / `sfMuteReloj`. Aquellos son del subsistema de
// notificaciones (`decidirSonido()`) y deciden si un aviso concreto suena; esto es el mute
// del sink por defecto, o sea el sistema entero. Son cuatro ajustes que se solapan y esta es
// la única capa que puede dejar muda una alarma sin que `decidirSonido` se entere — de ahí
// que este nazca en `false` y aquellos no.
//
// ── SOLO SE DESILENCIA LO QUE SILENCIAMOS NOSOTROS ────────────────────────────────────
// Si el usuario ya lo tenía en mute, al salir NO se desilencia. Es la regla del contrato y
// aquí es de las que más se notan: devolver el sonido a alguien que lo había quitado a
// propósito es un susto, no una restauración.
//
// ── SE GUARDA EL ENDPOINT, NO «EL ALTAVOZ POR DEFECTO» ────────────────────────────────
// El mute es propiedad del NODO, y el nodo por defecto puede no ser el mismo al salir: los
// nodos de PipeWire se destruyen y se recrean —el del HDMI lo hace en cada DPMS y en cada
// `hyprctl reload`, medido en el CLAUDE.md de este directorio: id 86 → 71 → 86— y además
// unos cascos conectados mientras dormíamos cambian el default de aparato. Volver a pedir
// `defaultSpeaker` al salir desilenciaría al NUEVO y dejaría mudo al que silenciamos, que es
// un fallo mudo en los dos sentidos de la palabra. Se guarda la referencia al endpoint que
// tocamos y se desilencia ese, si sigue vivo y sigue en mute.
//
// El residuo es real pero benigno: WirePlumber persiste el mute por nodo, así que un AGS que
// muera aquí deja el sistema mudo hasta que el usuario lo vea (el icono de la barra sale
// tachado, `.qs`/`OSD` incluidos) y le dé un clic. Es visible y reversible, que es lo que
// distingue esto del brillo — aquel se pierde en silencio y por eso lleva apunte en disco.
import AstalWp from "gi://AstalWp"
import type { EfectorSuspensionFalsa } from "./efectores"
import { sfSilenciarAudio } from "../powerState"

/** El endpoint que silenciamos NOSOTROS, o `null` si no silenciamos nada. */
let silenciado: AstalWp.Endpoint | null = null

function altavozPorDefecto(): AstalWp.Endpoint | null {
  try {
    return AstalWp.get_default()?.audio?.defaultSpeaker ?? null
  } catch {
    return null
  }
}

export const efectorAudio: EfectorSuspensionFalsa = {
  nombre: "audio",

  aplicar() {
    if (!sfSilenciarAudio.get()) return
    const altavoz = altavozPorDefecto()
    // Sin salida, o ya en mute → no se apunta nada y restaurar será un no-op.
    if (!altavoz) return
    try {
      if (altavoz.mute) return
      altavoz.mute = true
      silenciado = altavoz
    } catch (error) {
      silenciado = null
      console.error("[suspension-falsa] no se pudo silenciar el audio:", error)
    }
  },

  restaurar() {
    const objetivo = silenciado
    silenciado = null
    if (!objetivo) return

    try {
      // El nodo pudo destruirse mientras dormíamos (recreación por DPMS, aparato
      // desenchufado). Leer una propiedad de un GObject muerto tira, y con el try/catch eso
      // se queda en "no había nada que desilenciar" en vez de tumbar la salida entera.
      if (!objetivo.mute) return   // el usuario ya lo desilenció: manda lo suyo
      objetivo.mute = false
    } catch (error) {
      console.error("[suspension-falsa] no se pudo desilenciar el audio:", error)
    }
  },
}
