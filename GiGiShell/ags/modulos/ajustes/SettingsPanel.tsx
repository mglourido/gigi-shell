// modulos/ajustes/SettingsPanel.tsx
// Ventana general abierta desde el engranaje de ajustes rápidos. Mantiene el
// fondo a pantalla completa y el panel centrado, con navegación a la izquierda.
// El contenido va en un <With> sobre `vistaActiva` (sección, o null si el panel está
// cerrado): se construye al ABRIR y se desmonta al cerrar, así que con Ajustes cerrado no
// queda ni un timer ni una suscripción viva. La nav lateral es estática y vive con la
// ventana. Ojo: tiene que ser UN solo <With>, no dos anidados — ver la nota junto a él.
import app from "ags/gtk4/app"
import { Astal, Gtk, Gdk } from "ags/gtk4"
import { With, createState, createComputed } from "ags"
import { settingsPanelVisible, setSettingsPanelVisible, privilegedPromptActive } from "../../estado/shell"
import NavegacionAjustes from "./panel/NavegacionAjustes.tsx"
import { crearContenidoSeccion, type IdSeccion } from "./panel/secciones.tsx"
import { clasesFondoShell } from "./preferences"
import { medidasLamina, seguirGeometriaMonitor, seguirTamanoLamina } from "../../utilidades/tamanoLamina"

// Tamaño de diseño del panel. `medidasLamina` lo recorta a la pantalla y el alto se estira
// hasta donde permita la navegación. Bajo el ancho lateral mínimo, la nav pasa arriba para
// que el contenido conserve un área útil y sus destinos sigan accesibles con scroll.
const DISENO = { ancho: 860, alto: 700 }
// 252 px de nav + 20 de padding y 1 de borde; 420 px de sección + 40 de padding;
// más el borde del panel (≈735 px). Se deja una pequeña holgura para el reparto GTK.
const ANCHO_NAV_LATERAL = 740

/**
 * Apaga el `scroll-to-focus` del `GtkViewport` que `Gtk.ScrolledWindow` crea para su hijo.
 *
 * **Es el salto del scroll de Ajustes.** Con esa propiedad —activa de fábrica en GTK4— el
 * viewport desplaza el contenido para dejar A LA VISTA el widget que acaba de recibir el
 * foco, y en este panel todo lo pulsable (botones, interruptores, deslizadores, entradas)
 * toma el foco al hacer clic. Basta con pulsar un control que quede medio tapado por el
 * borde para que la vista pegue un tirón, y si el foco cae en algo de arriba —una entrada
 * que aparece al reconstruirse una tarjeta— el panel se va del todo al principio. Medido:
 * con el contenido en 600 px, enfocar el último hijo lo manda a 1049 y enfocar el primero
 * a 0; con `scroll_to_focus` en false se queda donde estaba.
 *
 * Se pierde el desplazamiento automático al tabular, que aquí no es la forma de navegar
 * (el panel es de ratón; el teclado solo se usa para escribir en las entradas ya visibles
 * y para el Escape que cierra la ventana).
 *
 * `notify::child` además del intento inmediato: el viewport no existe hasta que el hijo se
 * añade, y `$` puede correr antes.
 */
function desactivarDesplazarAlFoco(desplazable: Gtk.ScrolledWindow) {
  const aplicar = () => {
    const hijo = desplazable.get_child()
    if (hijo instanceof Gtk.Viewport) hijo.set_scroll_to_focus(false)
  }
  aplicar()
  desplazable.connect("notify::child", aplicar)
}

export default function SettingsPanel(gdkmonitor: Gdk.Monitor) {
  const { TOP, BOTTOM, LEFT, RIGHT } = Astal.WindowAnchor
  const [seccion, establecerSeccion] = createState<IdSeccion>("account")
  const medidas = medidasLamina(gdkmonitor, DISENO)
  const [navCompacta, establecerNavCompacta] = createState(medidas.ancho < ANCHO_NAV_LATERAL)
  // null = panel cerrado → no se construye ninguna sección. La sección elegida se
  // conserva en `seccion` entre aperturas; lo que se tira es el árbol de widgets.
  const vistaActiva = createComputed(() => settingsPanelVisible() ? seccion() : null)
  let contenidoDesplazable: Gtk.ScrolledWindow | undefined

  const actualizarNav = () => {
    const nuevasMedidas = medidasLamina(gdkmonitor, DISENO)
    establecerNavCompacta(nuevasMedidas.ancho < ANCHO_NAV_LATERAL)
  }

  const panel = (
    // La solicitud de tamaño se recalcula si cambia la geometría del monitor. El alto
    // empieza en el diseño y la nav puede ampliarlo; al estrecharse la pantalla, el cambio
    // de orientación evita que el ancho natural de la nav quite sitio a la sección.
    <box
      cssClasses={navCompacta((compacta) => compacta ? ["sp-panel", "compacto"] : ["sp-panel"])}
      orientation={navCompacta((compacta) => compacta ? Gtk.Orientation.VERTICAL : Gtk.Orientation.HORIZONTAL)}
      spacing={0}
      halign={Gtk.Align.CENTER} valign={Gtk.Align.CENTER}
      widthRequest={medidas.ancho} heightRequest={medidas.alto}
      $={(self: Gtk.Widget) => {
        seguirTamanoLamina(gdkmonitor, DISENO)(self)
        seguirGeometriaMonitor(gdkmonitor, actualizarNav)(self)
      }}>
      <NavegacionAjustes
        gdkmonitor={gdkmonitor}
        navCompacta={navCompacta}
        seccion={seccion}
        seleccionar={(destino) => {
          establecerSeccion(destino)
          contenidoDesplazable?.get_vadjustment().set_value(0)
        }}
      />

      {/* Contenido desplazable. **La sección no participa en el tamaño del panel**: ni su
          mínimo ni su natural suben, así que abre lo que abras el panel mide lo mismo.
          Las dos piezas:

          - políticas en EXTERNAL: con `hscrollbarPolicy` en NEVER (como estaba) GTK4 suma
            el MÍNIMO del hijo a lo que pide este ScrolledWindow, así que cualquier sección
            que pidiera de más ensanchaba el panel entero — y las que se pintan tarde
            (Sistema rellena sus tarjetas cuando termina el sondeo) lo ensanchaban DESPUÉS
            de haber salido ya con el tamaño bueno, que es el salto que se veía. EXTERNAL
            desplaza en vez de empujar, y no dibuja barra (el CSS ya las ocultaba).
          - `propagateNatural*` en false: lo mismo para el natural. Quien estira el panel es
            la nav (ver el comentario de `DISENO`). */}
      <Gtk.ScrolledWindow
        cssClasses={["sp-content"]}
        $={(self: Gtk.ScrolledWindow) => {
          contenidoDesplazable = self
          desactivarDesplazarAlFoco(self)
        }}
        hexpand
        vexpand
        propagateNaturalWidth={false}
        propagateNaturalHeight={false}
        hscrollbarPolicy={Gtk.PolicyType.EXTERNAL}
        vscrollbarPolicy={Gtk.PolicyType.EXTERNAL}
      >
        {/* `vexpand`: la sección se estira hasta el alto del ScrolledWindow en vez de
            quedarse en su alto natural. No cambia nada de lo que se ve (las secciones
            alinean su contenido arriba), pero es lo que le da alto al `Gtk.Overlay` de
            `display-select-host`, donde se dibuja la lista desplegable de `DisplaySelect`
            — en una sección corta el desplegable se quedaba en ~40 px. Ojo: NO toca el
            tamaño del panel, que sigue sin propagar ni mínimo ni natural (ver arriba). */}
        <box orientation={Gtk.Orientation.VERTICAL} hexpand vexpand>
          {/* UN SOLO <With>, sobre `vistaActiva` (= sección, o null con el panel cerrado).
              Gatea por VISIBILIDAD, no solo por sección: sin eso la sección por defecto
              (Cuenta) se construía al arrancar el shell —una vez por monitor— y seguía
              montada toda la sesión sin haber abierto Ajustes nunca, porque `panel` se
              evalúa en el cuerpo de la función que app.ts invoca con .map() al arrancar y
              <With> renderiza con `immediate: true`. Cerrar solo cambiaba `visible` de la
              ventana y no desmontaba nada.

              NO se puede hacer con dos <With> anidados (visibilidad → sección), que es lo
              primero que sale: <With> devuelve un Fragment y `Fragment.append` lanza
              "nesting Fragments are not yet supported". El error se traga en el efecto, así
              que el panel se queda SIN CONTENIDO y además el fragment externo nunca llega a
              tener hijos → su scope no se dispone jamás y no corre ni un onCleanup: pierdes
              justo lo que venías a arreglar, en silencio. Medido.

              Por lo mismo el caso cerrado devuelve un <box/> vacío y no `null`: <With> no
              añade nada al fragment ante null/undefined/false/"", y el ciclo de disposición
              cuelga de iterar los hijos del fragment. Sin hijo no hay dispose. */}
          <With value={vistaActiva}>
            {(s: IdSeccion | null) => {
              if (s === null) return <box />
              return crearContenidoSeccion(s) as any
            }}
          </With>
        </box>
      </Gtk.ScrolledWindow>
    </box>
  ) as unknown as Gtk.Widget

  return (
    <window
      name="settings-panel"
      visible={settingsPanelVisible}
      gdkmonitor={gdkmonitor}
      // Mientras polkit pide la contraseña, esta ventana se aparta: una capa
      // OVERLAY tapa SIEMPRE al diálogo (es un toplevel normal) y obligaba a
      // cerrar Ajustes para poder escribir. Ver withPrivilegedPrompt en state.tsx.
      layer={privilegedPromptActive(a => a ? Astal.Layer.BOTTOM : Astal.Layer.OVERLAY)}
      anchor={TOP | BOTTOM | LEFT | RIGHT}
      exclusivity={Astal.Exclusivity.IGNORE}
      // Y suelta el teclado: con ON_DEMAND la capa puede retener el foco y el
      // diálogo se quedaría sin recibir lo que teclees.
      keymode={privilegedPromptActive(a => a ? Astal.Keymode.NONE : Astal.Keymode.ON_DEMAND)}
      application={app}
      cssClasses={clasesFondoShell("sp-window")}
    >
      <Gtk.EventControllerKey
        onKeyPressed={(_self, keyval) => {
          if (keyval === Gdk.KEY_Escape) { setSettingsPanelVisible(false); return true }
          return false
        }}
      />
      <box cssClasses={["sp-backdrop"]} hexpand vexpand>
        <Gtk.GestureClick
          onPressed={(self: Gtk.GestureClick, _n: number, x: number, y: number) => {
            const backdrop = self.get_widget() as Gtk.Widget
            const hit = backdrop.pick(x, y, 0)
            let w: Gtk.Widget | null = hit
            while (w && w !== backdrop) {
              if (w === panel) return
              w = w.get_parent()
            }
            setSettingsPanelVisible(false)
          }}
        />
        {panel as unknown as any}
      </box>
    </window>
  )
}
