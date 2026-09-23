/** Ventanas emergentes de X11 (menús, desplegables, tooltips) que Hyprland
 *  entrega como clientes normales.
 *
 * Un cliente X11 **override-redirect** —lo que Chromium/GTK/Qt usan para dibujar
 * un menú o un tooltip cuando corren sobre XWayland— no lo gestiona el
 * compositor, pero **sí sale en `hyprctl clients` y sí emite `openwindow`**, así
 * que Astal lo mete en su lista igual que a una ventana de verdad. Con la clase
 * del programa padre, no una propia: Steam abre sus desplegables desde
 * `steamwebhelper` con `WM_CLASS = (steamwebhelper, steam)`, o sea que llegan
 * como `class: "steam"` y la barra pintaba **un segundo icono de Steam** cada vez
 * que el ratón pasaba por encima de algo que abre un menú. Es el mismo fallo que
 * hace años se atribuyó a Firefox (sus menús de X11 hacían exactamente esto), y
 * que entonces se tapó deduplicando iconos por su glifo — remedio que se retiró
 * al pasar a un icono por ventana, y con él volvió el síntoma.
 *
 * Medido en esta máquina (Hyprland 0.56) creando a mano una ventana
 * override-redirect con `WM_CLASS = (steamwebhelper, steam)`: aparece en
 * `hyprctl clients` con `mapped: true`, `hidden: false`, `visible: true`,
 * `acceptsInput: true` y tamaño real, así que **ningún filtro de "ventana viva"
 * la distingue**. Lo que la delata es la terna:
 *
 *   - `xwayland`: los emergentes nativos de Wayland son `xdg_popup` y no llegan
 *     a ser clientes, así que esto solo puede pasar en X11.
 *   - `floating`: una ventana no gestionada nunca entra en el mosaico.
 *   - sin título **ni título inicial**: un menú no pone `WM_NAME`. Se exigen los
 *     dos para no tragarse una ventana real que todavía no ha puesto el suyo:
 *     esa acaba teniendo `title`, y los dos consumidores reaccionan a que llegue
 *     (`notify::title` en el registro de juegos, la lista de clientes en la barra).
 *
 * Vive en `servicios/` porque lo comparten la barra de escritorios y la
 * detección de juegos: un menú tampoco es un juego, y colarse ahí duplicaba la
 * pastilla y podía activar el auto-DND por una ventana que no existe.
 */

/** Forma estructural de AstalHyprland.Client. Los nombres ingleses (y sus
 *  variantes con guion bajo, que GJS también expone) son la API externa. */
export interface ClienteVentanaLike {
  title?: string | null
  initialTitle?: string | null
  initial_title?: string | null
  floating?: boolean | null
  xwayland?: boolean | null
}

export function esVentanaEmergenteX11(cliente: ClienteVentanaLike | null | undefined): boolean {
  if (!cliente?.xwayland || !cliente.floating) return false
  const titulo = cliente.title ?? ""
  const tituloInicial = cliente.initialTitle ?? cliente.initial_title ?? ""
  return titulo.trim() === "" && tituloInicial.trim() === ""
}

/** Clientes que representan una ventana del usuario y merecen aparecer. */
export function filtrarVentanasDeUsuario<T extends ClienteVentanaLike>(
  clientes: Iterable<T> | null | undefined,
): T[] {
  return [...(clientes ?? [])].filter((cliente) => !esVentanaEmergenteX11(cliente))
}
