// servicios/energia/opacidadCss.ts
//
// La parte de "quitar la transparencia durante el ahorro" que no toca ni GTK ni el
// disco: qué variable de lámina recibe qué color opaco, y la hoja que las define.
// Vive aparte de `opacidadAhorro.ts` para que Node pueda probarla — igual que
// `fondos/acentoCss.ts` frente a `fondos/acento.ts`, y por el mismo motivo: la otra
// mitad es un CssProvider y una suscripción, y esas no tienen nada que decidir.

/** `:root` porque las variables CSS SE HEREDAN: definidas en la raíz las ven todas
 *  las ventanas del shell sin tener que enumerar ninguna. */
const SELECTOR = ":root"

/**
 * Cada lámina del shell y el color OPACO que la sustituye durante el ahorro.
 *
 * ⚠️ ESTA TABLA ES LA MITAD DE UN PAR. La otra mitad son los `lamina("--…", <color
 * translúcido>)` de `estilos/style.scss` y `modulos/orion/orion.scss`, que declaran
 * el mismo nombre de variable con el color de siempre como reserva. Aquí solo puede
 * estar el color **sin alfa**: es el mismo RGB de la lámina, no un color nuevo, así
 * que el panel se ve exactamente igual salvo por dejar de transparentar. Añadir una
 * lámina es tocar los dos sitios; si solo se toca este, la variable no la lee nadie
 * y el ajuste no hace nada (fallo silencioso, sin error de CSS).
 *
 * Los `$*-bg-opaco` de cada módulo NO entran: los controles de dentro de un panel ya
 * eran opacos a propósito (para tapar el blur), así que no hay transparencia que
 * quitarles.
 */
const LAMINAS: readonly (readonly [string, string])[] = [
  ["--lamina-qs", "rgb(8, 8, 12)"],              // Quick Settings
  ["--lamina-np", "rgb(8, 8, 12)"],              // Panel de notificaciones
  ["--lamina-cal", "rgb(8, 8, 12)"],             // Panel de calendario
  ["--lamina-osd", "rgb(8, 8, 12)"],             // OSD de volumen/brillo
  ["--lamina-orion", "rgb(8, 8, 12)"],           // Orion
  ["--lamina-popup", "rgb(16, 16, 24)"],         // Popups de aviso
  ["--lamina-grafito", "rgb(24, 24, 32)"],       // Los tres paneles, tema grafito
  ["--lamina-popup-grafito", "rgb(24, 24, 32)"], // Popups de aviso, tema grafito
  ["--lamina-gris", "rgb(32, 32, 32)"],          // Los tres paneles, tema gris
  ["--lamina-popup-gris", "rgb(32, 32, 32)"],    // Popups de aviso, tema gris
]

/**
 * La hoja que vuelve opacas las láminas, o la hoja VACÍA cuando el ajuste no está
 * vigente.
 *
 * Que "apagado" sea una cadena vacía y no la ausencia de hoja es lo que hace que
 * volver a la transparencia sea gratis y sin parpadeo: el provider siempre está
 * puesto y solo se le cambia el contenido, así que al vaciarlo cada
 * `var(--lamina-…, rgba(…))` de `out.css` cae en su reserva —el color translúcido
 * de siempre— sin que nadie tenga que saber cuál era ni recargar nada.
 */
export function hojaOpaca(activo: boolean): string {
  if (!activo) return ""
  const declaraciones = LAMINAS.map(([nombre, color]) => `${nombre}: ${color};`).join(" ")
  return `${SELECTOR} { ${declaraciones} }\n`
}
