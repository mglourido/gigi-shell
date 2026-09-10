# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An [AGS v2](https://github.com/Aylur/ags) (Astal) desktop shell for Hyprland/Wayland, written in TypeScript + JSX targeting GTK4. It renders a per-monitor bar plus a collection of panels and overlays. There is no `package.json`, `tsconfig.json`, or test suite — AGS itself owns bundling, transpilation, and the runtime. `@girs/` holds generated GObject type stubs for editor support only.

## Running

```sh
ags run ~/.config/ags/app.ts     # launch/reload the shell
```

When a Hyprland restart is needed, use `hyprctl reload full-reset`: it also re-runs the
autostart entries from `hypr/gigios/autostart.lua`. A plain `hyprctl reload` only reloads the
configuration and does not restart those autostart processes.

There is no build/lint/test step for the shell itself. To verify a UI change, run the shell and observe it. `estilos/out.css` is a compiled artifact from `estilos/style.scss` — do not edit it by hand. Its source map is **not** kept next to it (see Styling below).

Pure-logic modules (no GTK imports) are covered by Node's built-in test runner:

```sh
node --test $(rg --files modulos servicios textos -g '*.test.ts')
```

Run the full suite or a single file. Tests live alongside their implementation files (e.g. `engine.ts` / `engine.compile.test.ts`).

## Architecture

`app.ts` is the entry point. Inside `app.start({ css, main })`, every top-level window is instantiated **once per monitor** via `app.get_monitors().map(Component)` (`Barra` uses `.flatMap`). Adding a new top-level window means importing it in `app.ts` and adding a `.map(...)` line. `CalendarPanel` is wrapped in try/catch as the pattern for windows that may fail to construct.

**Los `init*` de fondo van en un `setTimeout(…, 4000)`, no sueltos en `main()`.** Ninguno se ve
(son vigilantes y un barrido de limpieza) y corriendo a pelo competían con la construcción de las
ventanas —una por monitor— justo mientras se pinta el escritorio; `initAutoDnd`/`initGamingState`
además consultan `isGameClient`, que puede acabar parseando los ~161 `.desktop` del sistema
(`Gio.AppInfo.get_all`) para decidir si una ventana es un juego. Apartarlos es seguro porque
**ninguno depende de eventos ocurridos mientras esperan**: `initTrayApps` e `initGamingState`
**siembran** de lo vivo (`tray.get_items()` / `hypr.get_clients()`) *antes* de suscribirse, así
que a los 4 s ven un superconjunto; `initAutoDnd` adopta el DND al empezar; e
`initNotifDaemonCheck` va suscrito a `NameOwnerChanged` y de hecho **gana** fiabilidad (a los
pocos ms el dueño del nombre aún se resuelve). Un `init*` nuevo va ahí **salvo que siembre de un
    evento en vez de del estado**. La excepción es **`inicializarMantenerDespierto()`, que sigue a t=0**: su único
trabajo es limpiar estado heredado peligroso (un `wakeup.json` con `active:true` vetando la
suspensión sin UI que lo enseñe), y es un borrado de fichero — retrasar justo eso no tiene
sentido. Parte del escalonado de arranque del sistema; el calendario completo está en
`hypr/gigios/autostart.lua`.

### State and reactivity

- Reactive state comes from `createState` in the `ags` module: `const [value, setValue] = createState(initial)`.
- Read current value with `.get()`, react with `.subscribe(cb)`.
- In JSX props, bind by passing a transform: `prop={state((v) => derived)}`.
- **`estado/shell.tsx` is the global state hub.** It exports panel-visibility states and the composite `anyPanelVisible`, plus orchestration helpers like `closeAllPanels`, `openQuickSettings`, `openPowerMenu`. Panels are **mutually exclusive**: opening one calls `closeAllPanels()` first.
- La `Barra` autoocultable permanece visible mientras `anyPanelVisible` sea verdadero. **Al añadir un panel, incorpora su estado de visibilidad a `panelStates` en `estado/shell.tsx`**: ese registro se propaga a `anyPanelVisible` y a sus suscriptores. Añade también su cierre a `closeAllPanels()`. **Orion queda fuera de `panelStates` a propósito**: no es un panel de la barra sino una ventana OVERLAY propia, y estar en el registro hacía que abrir el lanzador desplegara la barra — son cosas distintas.
- **Abrir CUALQUIERA de las dos ventanas de ajustes (la general y la de notificaciones) deja la pantalla limpia**, vía `cerrarPanelesParaAjustes()` en `estado/shell.tsx`. Las dos son layer-shell OVERLAY ancladas a los cuatro bordes: un panel que se quede abierto debajo no se ve, pero sigue **vivo** — reteniendo la barra por `anyPanelVisible`, con sus temporizadores y sondeos corriendo — y reaparece intacto al cerrar los ajustes. `closeAllPanels()` **no basta**: el calendario y Orion no están en ese registro (los cierra `cerrarPanelesNoBarra()`, y Orion por `hidePanel()`, no tocando su estado a mano, para no saltarse su animación de salida ni `finalizarCierrePanel`). Las dos ventanas de ajustes se excluyen además entre sí. El cierre al abrir la de notificaciones cuelga de una suscripción a `notifSettingsVisible` y no de sus llamantes, porque se abre desde dos sitios que no pasan por ninguna función del hub (el engranaje de la cabecera del panel y el botón «editar» de una tarjeta). Ese caso conserva a propósito el **panel de notificaciones** (`conservarNotificaciones: true`): el engranaje *alterna* la ventana, así que cerrar el panel desde el que se abre dejaría al usuario sin nada al volver a pulsarlo.
- `panelAutoClose(close, graceMs?)` in `state.tsx` returns `{ onEnter, onLeave }` handlers for a `Gtk.EventControllerMotion` child — centralizes the mouse-leave-then-close pattern all bar panels share.
- Los menús anclados usan `crearControlPopoverAnclado()` con el `ControlVisibilidadBarra` de su monitor; así retienen solo esa barra y liberan la retención de forma idempotente al cerrar o desmontarse.
- **Todo lo que flota colgando de la barra sale a `SEPARACION_BARRA` (3 px) de su borde, y eso lo garantiza `modulos/barra/componentes/anclaBarra.ts`, no un `set_offset` a ojo.** GtkPopover se ancla al borde inferior de su PADRE, y los iconos miden de 14 a 30 px centrados en 38: con un offset fijo cada menú salía a una altura distinta. `colgarDeBarra(popover)` estira el `pointing_to` hasta cubrir la barra entera y deja el offset como separación real; se llama con el popover ya emparentado y **justo antes de abrirlo** (en un `GtkMenuButton`, desde un `GestureClick` en CAPTURE: su `notify::active` llega después del popup). Las ventanas layer-shell que cuelgan de la barra usan `margenBajoBarra()`. **En la barra no se usa `tooltipText`**: el tooltip nativo se ancla al widget sin nada equivalente a `pointing_to` y ningún CSS lo nivela; `tituloBarra(widget, texto | accessor | () => texto)` (`componentes/tituloBarra.ts`) es un popover con el mismo aspecto (`%titulo-flotante` en `style.scss`). Medido con `grim` sobre iconos de 14, 18, 24, 30 y 38 px: todos arrancan en la misma fila. Los paneles (Quick Settings, calendario, notificaciones) quedan fuera a propósito: van pegados a la barra (`barTopMargin(37, -1)`), no flotan.

### Modules / hardware access

System services are GObject libraries imported as `gi://Astal*` (e.g. `AstalWp` audio, `AstalHyprland`, `AstalNetwork`, `AstalBluetooth`, `AstalMpris`, `AstalNotifd`, `AstalBattery`, `AstalTray`). Shelling out uses `ags/process`. Low-level GLib/Gio via `gi://GLib`, `gi://Gio`.

### JSX / GTK4 idioms

- Widgets and JSX runtime come from `ags/gtk4`; `app` from `ags/gtk4/app`.
- Event controllers are written as JSX children, not props: `<Gtk.EventControllerMotion onEnter={...} />`.
- Top-level panels are Layer Shell windows (e.g. Orion uses OVERLAY layer, anchored BOTTOM|LEFT|RIGHT, EXCLUSIVE keymode).

### Styling

Global stylesheet lives in `estilos/` (`style.scss`, large, ~90KB), not loose in `ags/` root —
keeps the three style-related files (source, shared palette, compiled output) together instead of
scattered next to `app.ts`. `estilos/_colores.scss` holds the shared color/font palette
(`$bg-bar`, `$blue`, `$violet`, `$red`, `$orange`, `$pink`, `$teal`, `$text`, `$font-icon`, …) as
the single source of truth; `style.scss` pulls it in with `@use 'colores' as *;` so every existing
unprefixed `$blue`/`$text`/… reference keeps working. **`app.ts` imports `./estilos/out.css`, not
the SCSS** — AGS does *not* compile SCSS at runtime, so editing `style.scss` has no visible effect
until you regenerate the artifact:

```sh
sass --no-charset --source-map-urls=absolute estilos/style.scss estilos/out.css   # from ags/
mv estilos/out.css.map ~/.cache/gigios/out.css.map
sed -i "s#sourceMappingURL=out.css.map#sourceMappingURL=file://$HOME/.cache/gigios/out.css.map#" estilos/out.css
```

**El mapa NO se queda junto al CSS, a propósito.** `sass` no tiene una opción para elegir dónde
escribe el `.map` por separado del `.css` — siempre lo escribe al lado con el mismo nombre base —
así que dejarlo así habría añadido un cuarto fichero suelto (y sin versionar, ya que ni siquiera se
commitea) justo en el directorio que se quería despejar. Se compila con
`--source-map-urls=absolute` para que las rutas a los `.scss` de origen que quedan grabadas
**dentro** del mapa sean absolutas — así el mapa sigue apuntando a las fuentes correctas aunque ya
no viva en el mismo directorio que ellas — y solo entonces se mueve a
`~/.cache/gigios/out.css.map` (mismo sitio que el resto de caché no versionada del proyecto, ver
`sysinfo.json` en `modulos/ajustes/sistema/`) reescribiendo el comentario final de `out.css` para
que apunte ahí. `--no-charset` sigue siendo obligatorio porque GTK CSS rechaza el `@charset` de
Sass. Dark catppuccin-inspired theme. Class-name prefixes scope features: `.nb-*`/`.np-*`/`.notif-*`/`.ns-*`
for notifications, etc. Los módulos autocontenidos pueden conservar su propio SCSS, como
`modulos/orion/orion.scss` — que a su vez consume `estilos/_colores.scss` (`@use
'../../estilos/colores' as c;`) para sus tokens `$j-accent`/`$j-text-primary`/`$j-bg-shell*` en vez
de repetir los mismos hex; solo `$j-accent-pink` es un tono propio sin equivalente en la paleta
global. UI uses JetBrainsMono Nerd Font glyphs throughout for icons.

Palette: `#08080c` bar bg; `#cba6f7` violet, `#89b4fa` blue, `#f38ba8` red, `#fab387` orange, `#f9e2af` yellow, `#a6e3a1` green, `#94e2d5` teal.

## Feature areas

- `modulos/barra/Barra.tsx` + `modulos/barra/*` — barra autoocultable y sus dominios. La raíz de `barra/` conserva solo el compositor principal; la implementación se agrupa en `escritorios/`, `bandeja/`, `juegos/`, `funciones/`, `indicadores/`, `multimedia/`, `controles/` y `componentes/`. Los indicadores se subdividen por `audio`, `conectividad`, `energia`, `notificaciones`, `sistema` y `tiempo`. No vuelvas a acumular widgets de dominio en la raíz. La visibilidad compartida vive en `estado/visibilidadBarra.ts`, la lógica de mantener despierto en `servicios/energia/` y el menú superior de energía en `modulos/menu-energia/` porque tienen responsabilidades o consumidores fuera de la barra.
  El autoocultado es una preferencia (`barAutoHideEnabled`, activada por defecto): al desactivarlo se interrumpen las rutas de ocultado, `showNow()` baja la barra y la ventana pasa de `Exclusivity.NORMAL` a `EXCLUSIVE` para que Hyprland reserve sus 38 px. Se aplica en caliente. **Esa zona exclusiva también desplaza las demás superficies ancladas arriba**: todas pasan por `barTopMargin(px)` (`modulos/ajustes/preferences.ts`), que reduce el margen a 0 cuando el autoocultado está desactivado; `NotificationPopup.tsx` hace lo mismo mediante `panelOffset()`. Las ventanas con exclusividad `IGNORE` no se desplazan.
  **Aviso de batería baja** (Ajustes > Barra > Comportamiento, `barraAvisoBateria`, apagado por defecto): con el autoocultado puesto, la barra **se asoma** cuando la batería cruza el umbral **sin estar cargando**, exactamente igual que si la revelaras con el puntero. `servicios/energia/avisoBateriaBarra.ts` publica la condición (`avisoBateriaBaja`) y `Barra.tsx` reacciona **solo a su flanco de subida** con un `showNow()`. Cuatro cosas que no son obvias:
  - **Es un flanco, no un modo, y ahí estuvo el error la primera vez.** Metido como condición sostenida en `checkVisibility()`, la barra se reimponía en cada evento (hover, panel, escritorio) y **el usuario no podía volver a esconderla con el ratón** hasta enchufar el cargador: eso es una barra clavada, no un aviso. Tras la revelación manda el autoocultado de siempre. Corolario: el `subscribe` de un accessor computado de gnim salta ante **cualquier** cambio de sus dependencias —y el nivel de batería se mueve punto a punto— aunque el booleano siga valiendo lo mismo, así que el flanco se lleva a mano con una variable. Al bajar el flanco (enchufar) no se hace nada. En el arranque no hay flanco que escuchar, así que la condición solo aparece como guarda del primer ocultado automático.
  - **NO sigue a `powerSaveActive`**, aunque el ajuste ofrezca vincularse al modo ahorro. Se toma prestado el NÚMERO (`powerSaveThreshold`) y nada más: `powerSaveActive` se enciende también con `forcePowerSave`, que es un interruptor a mano que funciona enchufado y en un sobremesa sin batería, y eso bajaría la barra sin que hubiera ninguna batería baja de la que avisar. La condición propia es siempre presente + descargando + `pct > 0 && pct <= umbral` (ese `> 0` descarta la lectura transitoria del proxy de upower, igual que en `recompute()`).
  - **No toca la exclusividad**: la ventana sigue en `NORMAL` y flota sobre las ventanas, al revés que apagar el autoocultado. Reservar 38 px al cruzar el umbral recolocaría todas las ventanas de la salida y volvería a recolocarlas al enchufar el cargador; un aviso no debe mover el escritorio.
  - **La pantalla completa real y la suspensión falsa cancelan la revelación** (no hay nadie mirando, y una barra asomando sobre una película es justo lo que `barTapada` viene a evitar): el aviso se pierde a propósito. Con la barra **ocultada a mano con el atajo** sí se revela, pero levantando `barOcultaPorTecla` en vez de ignorarla — mostrarla dejando la marca puesta la haría desaparecer de golpe en el primer `checkVisibility()` que pasara por cualquier otro motivo, un parpadeo sin causa aparente. Los tres datos crudos de batería (`bateriaPresente`, `bateriaCargando`, `bateriaNivel`) se exportan desde `powerState.ts` para no abrir un segundo `AstalBattery`; las filas de Ajustes se ocultan sin batería y se apagan sin autoocultado, que es cuando el ajuste no podría cumplirse.
- `modulos/barra/funciones/` — **el menú del logo Arch.** `estado.ts` declara el estado en RAM, `registro.ts` compone las entradas y `FilaFuncion.tsx`/`ChipEstadoFuncion.tsx` las presentan. Los campos opcionales son `estado` (texto del chip derecho) y `expandir` (referencia al componente desplegable).
  - Las filas conservan una caja estable para que un `<With>` remontado no cambie su posición. En la barra, el mismo contrato lo centraliza `componentes/RanuraCondicionalBarra.tsx`, sin hueco ni transición cuando la función está apagada.
  - **`OpcionesMantenerDespierto` va FUERA del `<button>` de la fila**, no dentro: dentro, cualquier clic en el campo de minutos o en el interruptor "Pantalla" llegaría también al botón y apagaría la función.
  - **Mantener despierto** usa `servicios/energia/mantenerDespierto.ts` y `tiempoMantenerDespierto.ts`, este último puro y probado. Mantiene el PC despierto N minutos, o sin límite si el campo va vacío. `hypr/scripts/idle-action.sh` decide finalmente sobre los `on-timeout` de hypridle; el servicio publica `~/.config/gigios/wakeup.json` `{active, until, screen, pid}`. **`until` es epoch absoluto** y **`pid` es el de AGS**. `inicializarMantenerDespierto()` limpia al arrancar cualquier veto heredado. Al apagarse **reinicia hypridle** para rearmar los timeouts. **Al CADUCAR el plazo manda un `notify-send`** (`energia.wake-up-fin`, catalogado en `rules/catalogoSistema.ts` para que sea configurable desde Ajustes > Notificaciones > Sistema); apagarlo a mano no notifica nada, porque ahí el usuario ya sabe lo que ha hecho. Detalle completo en el `CLAUDE.md` raíz.
- `servicios/juegos/` + `modulos/barra/juegos/IndicadorJuegos.tsx` — **detección transversal de juegos y su presentación en la barra.** `deteccion.ts` contiene la heurística pura y su prueba; `evidencia.ts` añade `.desktop` y `/proc`; `iconos.ts` resuelve nombre/icono; `registro.ts` comparte el estado dirigido por eventos. Los consumidores deben usar `esClienteJuego()`/el registro, no `esJuego()` sin evidencia.
  - **Todo esto se puede APAGAR**: `escanerJuegos` (Ajustes > Juegos > "Detectar juegos en marcha", activada por defecto). Con la preferencia en `false` el registro no conecta las señales por ventana (`notify::title/class/fullscreen`), no lanza el reintento tardío, no toca `/proc` ni el índice de `.desktop` y publica lista vacía + foco `null`; `esClienteRegistradoComoJuego` devuelve `false` siempre. Lo que **sí** sigue emitiendo es `revisionVentanas`, porque el auto-DND lo usa también para su lista de apps a pantalla completa, que no depende de los juegos — quitarlo apagaría media función ajena. Se aplica **en caliente en los dos sentidos** (`aplicarEscaner`): al encender se reconecta y reevalúa lo ya abierto, así que no hace falta reiniciar el shell. Consecuencias en cadena, todas queridas: se va la pastilla de la barra, el auto-DND solo actúa por su lista de apps, la onda de Spotify deja de silenciarse por juego en foco, y `runtime-state.json` queda con `gaming: false` permanente, y la pausa de la luz nocturna al jugar no se dispara nunca (su tarjeta se retira de Ajustes) (ver `servicios/energia/gamingState.ts`).
  - **Cuánto cuesta el escáner, medido en esta máquina, antes de suponer que apagarlo ahorra CPU**: es dirigido por eventos, sin temporizadores ni sondeo, y la evaluación de una ventana son **~5 µs** con la caché de `/proc` caliente y **~10 µs** en fallo de caché (20 000 iteraciones con `GLib.file_get_contents` sobre `/proc/<pid>/{stat,exe,cmdline}`). Ni con cientos de eventos de ventana por segundo llega al 0,1 % de un core. El interruptor está por **previsibilidad** —una pieza menos moviéndose y `gaming` clavado en `false` para el lado bash— no porque el consumo fuera un problema.
  - **`fullscreen` es un MODO, no un booleano** (Astal `Fullscreen`: 0 nada, **1 MAXIMIZADO**, 2 pantalla completa). El `fullscreen !== 0` original hacía que *cualquier ventana maximizada* no incluida en la lista negra pasara por juego — así es como Discord acababa en la pastilla, silenciaba las notificaciones (auto-DND) y ponía `{gaming:true}` en disco. Todo lo que mire `fullscreen` compara contra `FULLSCREEN_REAL` (2).
  - Orden de decisión de `isGame` (lo negativo primero): **menús de X11** (`esVentanaEmergenteX11` de `servicios/ventanas/`) → lanzadores (Steam/Lutris/Heroic… — la ventana es el lanzador, **no** el juego, aunque su `.desktop` diga `Categories=Game`) → apps que nunca son juego (Discord, navegadores, media, terminales) → **instaladores de wine/proton** → señales de clase (`steam_app_`, `gamescope`, `wine`/`proton`, `*.exe`) → ruta del proceso (`/proc/<pid>/exe`, `…/steamapps/common/…`) → **`Categories` del `.desktop`: con `Game` es juego; sin `Game` NO lo es** (este negativo fuerte es lo que ancla a Discord) → y solo si el escritorio no conoce la app, fullscreen real. Las listas casan **por nombre, no por subcadena**: con `includes()`, `"st"` (el terminal) casaba dentro de `"counter-strike"`. **El primer negativo va antes que las señales fuertes porque estas no salvan de él**: el desplegable de un juego trae *su misma clase* (`steam_app_…`), así que `senalClase` decía "juego" y la pastilla salía duplicada — medido con un A/B en esta máquina (juego X11 falso + un menú override-redirect con la misma `WM_CLASS`: dos mandos antes, uno después) — y además el auto-DND se disparaba por una ventana que no existe.
  - El filtro de **instaladores** va antes que las señales fuertes porque estas no lo salvan: caso real (el instalador de Voicemod, que ni siquiera es un juego), Steam le da a su ventana la clase `steam_proton` — la misma que a un juego — y su binario cuelga de `…/compatibilitytools.d/proton-…/wine-preloader`, así que la señal de clase *y* la de proceso dicen "juego". Solo el título (`Instalar`/`Install`/`Setup`/…) y el `.tmp` del instalador en el `cmdline` lo delatan. Limitación conocida: una app **no-juego ya instalada** que corra por Proton (el propio Voicemod) sí se detecta como juego — el compositor le da la misma clase que a un juego y no queda ninguna señal que los distinga.
  - **Preview de workspace**: cada instancia observa el `activeWorkspace` de su monitor y ejecuta `grim -o <salida>` hacia `/tmp/ags-ws-preview-<salida>-<id>.jpg`, para una miniatura de **280×158** reescalada al cargar. Publica primero a un temporal y solo lo renombra si el workspace sigue activo, evitando capturas etiquetadas con el ID anterior tras un cambio rápido. Con **JPEG q75** son ~330 KB frente a los 11 MB del antiguo PNG completo. No se usa `-s`: escalar con grim encarece la ruta frecuente unas seis veces.
  - **No filtres la captura por la visibilidad de la barra**: `grim` fotografía la pantalla actual y el único instante en que existe el contenido de un escritorio es mientras está activo. Saltarse esa captura no la aplaza, la pierde. El capturador sigue trabajando con la barra retraída, pero siempre queda limitado a su salida mediante `grim -o`.
  - **Cuándo se refresca `Escritorios.tsx`**: `servicios/escritorios/controlador.ts` comparte una sola colección de señales (`workspaces`, `clients`, `client-moved`, cliente enfocado, monitores y `active-workspace` de cada salida). Cada vista filtra después por el ID de su monitor. `client-moved` no sobra: `notify::clients` avisa de altas/bajas, no de traslados silenciosos.
  - **Un escritorio ESPECIAL se pinta como `0`, y su pastilla NO se abre por id.** La lista solo filtraba por monitor, así que con el scratchpad abierto salía una pastilla etiquetada **`-98`** — el id interno que Hyprland reparte (-98, -97… por orden de aparición: casar contra un -98 literal es el error fácil, de ahí `esEscritorioEspecial`, que mira el signo). Además el botón estaba **muerto**: `hl.dsp.focus({workspace=-98})` sobre un especial oculto no hace nada y responde **`ok`** igualmente (medido en vivo), así que no había ni error que ver. Los especiales se muestran y se ocultan con **`toggle_special`, que va por NOMBRE**, y por eso `EscritorioVisible` lleva ahora `nombre` y `enfocarEscritorio(id, nombre?)` bifurca. El nombre se valida contra `^[A-Za-z0-9._+-]+$` **en origen** (`nombreEspecialEscritorio`) porque acaba dentro de unas comillas simples en un `hyprctl dispatch`; sin nombre utilizable no se despacha nada, en vez de fingir con el focus por id. `alternarPantallaCompleta` pasa por la misma función: con el salto inicial mudo, el resto de su cadena caía sobre la ventana equivocada. **Reordenar, intercambiar y renumerar ignoran los especiales** (las tres entradas: arrastrar, CTRL+arrastrar y teclear un número), porque esas operaciones mueven ventanas entre escritorios numerados y un especial no es una posición del orden sino un cajón — arrastrarlo habría vaciado el scratchpad dentro de un escritorio normal. Lo puro vive en **`servicios/escritorios/especiales.ts`** (con test) y no bajo `barra/` por lo mismo que `servicios/ventanas/emergentesX11.ts`: lo consumen dos capas.
  - **Iconos**: `barra/escritorios/iconos.ts` consume directamente `servicios/aplicaciones/{glifos,iconos,entradasEscritorio}.ts` y `servicios/juegos/{evidencia,iconos}.ts`. Prioriza glifo configurado, recurso original, tema y fallback; no se deben reintroducir shims bajo `barra`.
  - **Un MENÚ de una app X11 llega como un cliente más, con la clase de su padre — y ahí nacía el icono duplicado de Steam.** Las ventanas **override-redirect** (menús, desplegables, tooltips) de un programa sobre XWayland no las gestiona el compositor, pero **sí salen en `hyprctl clients` y sí emiten `openwindow`**, así que Astal las mete en su lista. Steam las abre desde `steamwebhelper` con `WM_CLASS = (steamwebhelper, steam)` → llegan como `class: "steam"` y la barra pintaba **un segundo icono de Steam** mientras el menú estuviera abierto: de ahí que apareciera y desapareciera "según por dónde muevas el ratón". Es literalmente el viejo bug de Firefox (sus menús de X11 hacían lo mismo), que entonces se tapó deduplicando iconos por su glifo; ese apaño se retiró al pasar a **un icono por ventana** —cada uno es un botón que enfoca *esa* ventana, así que deduplicar volvería a ser incorrecto— y con él volvió el síntoma. **Ningún filtro de "ventana viva" sirve**: reproducido creando a mano una ventana override-redirect con esa `WM_CLASS`, Hyprland la da con `mapped: true`, `hidden: false`, `visible: true`, `acceptsInput: true` y tamaño real (A/B con `grim` sobre la barra: dos Steam antes, uno después). La delata la terna de **`servicios/ventanas/emergentesX11.ts`** (puro y con test): `xwayland` (los emergentes nativos de Wayland son `xdg_popup` y no llegan a ser clientes) **+** `floating` (una ventana no gestionada nunca entra en el mosaico) **+** sin `title` **ni** `initialTitle` (un menú no pone `WM_NAME`; se exigen los dos para no tragarse una ventana real que aún no ha puesto el suyo — cuando el título llega, los dos consumidores lo reevalúan). El filtro va en el bucle de `Escritorios.tsx`, **no** en `iconos.ts`, porque también decide `tieneClientes`, o sea si el escritorio se muestra. Vive en `servicios/` y no bajo `barra/` porque **la detección de juegos tiene el mismo agujero**: ver `servicios/juegos/`.
  - **`<For>` INDEXA POR IDENTIDAD DE OBJETO si no le das `id`, y eso reconstruía la barra entera con solo mover el ratón.** `actualizar()` corre ante cualquier señal del controlador —incluida `notify::focused-client`, que con `input:follow_mouse = 1` salta **cada vez que el puntero cruza de una ventana a otra**, no solo al alternar con el teclado— y devuelve siempre objetos nuevos. Sin clave, cada uno de esos eventos destruía y reconstruía **todos** los `BotonEscritorio` de todas las barras, con sus gestos, arrastres, controladores de teclado/foco y ranuras de icono. Medido con un A/B en esta máquina (3 escritorios, 10 cambios de foco): **30 construcciones antes, 0 después**. Con `barAutoHide` en `false` —el caso de este equipo— se pagaba siempre, porque `escritoriosRenderizados` solo se publica con la barra visible. (Al comprobarlo, **la clave en disco se llama `barAutoHide`, no `barAutoHideEnabled`** — ese segundo es el nombre del `createState` en `modulos/ajustes/estado/preferencias.ts`, y por defecto nace en `true`. Preguntar por el nombre equivocado devuelve `null`, que es **indistinguible de "clave ausente"** y lleva a concluir justo lo contrario de la verdad; ya pasó una vez.) Dos piezas, y hacen falta las dos:
    1. **Los dos `createState` llevan `equals: sonEscritoriosEquivalentes`** (`escritorios/modelo.ts`, puro y con test): igualdad por **contenido**, no por identidad de array, así que publicar una lista equivalente conserva el array anterior y no notifica a nadie. La firma incluye orden, id, nombre y —por cliente— dirección, icono y descripción; `enfocar` queda fuera a propósito (clausura nueva en cada pasada, pero solo depende del id y del nombre, que sí están — el nombre entró con los especiales, que se abren por nombre y no por id). El foco vive aparte, en `idEnfocado`/`direccionEnfocada`.
    2. **`id={(escritorio) => escritorio.id}` en el `<For>`**, para que abrir una ventana actualice el botón afectado en vez de rehacer los nueve (verificado: aparecer un escritorio nuevo construye **1** botón, no N).
    **Consecuencia para quien toque `BotonEscritorio`**: se construye UNA vez por escritorio y su prop `escritorio` ya no vuelve a llegar. De ahí solo puede leerse lo que no cambia en toda su vida (`id` —la clave— y `enfocar`); **los clientes entran por el accessor `clientes`**, no por `escritorio.clientes`. El `const clientes = idEnfocado(() => escritorio.clientes)` que había era justo el síntoma: un valor constante que solo re-emitía porque el componente se rehacía entero. Por lo mismo `indiceClienteActivo` depende de **las dos** fuentes (la lista puede reordenarse sin que cambie el foco).
  - **El mismo error estaba en `juegos/IndicadorJuegos.tsx`**, y ahí lo dispara el **título**: el registro republica la lista entera en cada `notify::title` de un juego, así que sin `id` un cambio de título de UNO reconstruía el botón de TODOS (medido). Va indexado por `direccion`, y como el botón ya no se rehace, nombre e icono llegan por accessor — incluida la **forma** del icono, que pasó de un ternario (`iconoGio ? … : nombreIcono ? … : glifo`) a tres ranuras alternadas con `visible`, el mismo patrón que `botonIcono`. Con el ternario, la forma quedaba atada al primer valor: un juego que arranca sin icono de tema y lo resuelve después se quedaba con el glifo genérico para siempre.
- `servicios/camara/` + `modulos/ajustes-rapidos` (tile y `QsCamaraMenu`), `modulos/ajustes/camara/` y
  `modulos/barra/indicadores/sistema/Camara.tsx` — **la cámara**. Toda la parte de sistema vive en el
  servicio y ninguna de las tres vistas enumera, parsea o persiste por su cuenta. Lo que hay que saber
  antes de tocar cualquiera de ellas está en la sección «Cámara» de
  [`../docs/hyprland-modulos.md`](../docs/hyprland-modulos.md); en corto:
  - **La UI se GENERA de lo que publique el firmware**, nunca sliders fijos. Los rangos cambian por
    modelo (`brightness` es 0..255 en unas cámaras y -64..64 en otras) y `v4l2-ctl --set-ctrl`
    **acota en silencio**: un slider 0..100 mandando el valor tal cual movería la imagen en el primer
    tramo y no haría nada en el resto, sin un solo error.
  - **`flags=inactive`** (un control encadenado a un automático encendido) acepta la escritura,
    devuelve 0 y no cambia nada. El mando se deshabilita, y **toda escritura se relee**: encender un
    automático cambia el `inactivo` de OTROS controles.
  - **Una webcam registra 2-3 `/dev/videoN`**; el de metadatos contesta a `--list-ctrls` con la lista
    vacía y sin error. El filtro es `ID_V4L_CAPABILITIES` de udev, no el nombre.
  - **El uso de la cámara NO se detecta desde aquí.** Las apps abren V4L2 directamente, sin pasar por
    PipeWire, así que no hay señal a la que suscribirse como con el micro; y barrer `/proc/*/fd` se
    midió en **28 ms con 435 procesos**. Lo detecta `hypr/scripts/camara-monitor.sh` con inotify
    (`IN_OPEN`/`IN_CLOSE` funcionan sobre nodos de dispositivo) y `uso.ts` solo lee su JSON.
  - **No existe «cámara por defecto» en Linux**: la preferida vale dentro de GiGiOS y la UI lo dice.
    La resolución la negocia la app al abrir el stream, así que los formatos son una ficha
    informativa, nunca un desplegable que se aplique.
  - **El killswitch («Cámara bloqueada») lo aplica un helper root**, no AGS: `servicios/camara/
    bloqueo.ts` solo llama a `/usr/local/bin/gigios-camara` por una regla sudoers acotada a sus dos
    verbos, y sin helper instalado el interruptor **no se pinta** en vez de fallar al pulsarlo. Lo
    que sostiene todo es el número de la regla udev que instala —`71-`, entre el `70-uaccess` que
    etiqueta y el `73-seat-late` que concede la ACL—: en `99-` no bloquearía nada y no daría ningún
    error. Bloquear impide ABRIR la cámara, no corta una captura en marcha, y las dos vistas lo
    dicen. Ojo al efecto lateral: bloqueada, `v4l2-ctl` falla por permisos y la lista de controles
    sale vacía — hay que distinguir eso de «no expone controles» y releer al desbloquear.
- `modulos/ajustes-rapidos/QuickSettings.tsx` — large control panel (Wi-Fi, Bluetooth, audio, display). Al importarse instala el **switch-on-connect de audio**: al conectar un dispositivo, pasa a ser la salida/entrada por defecto. **`speaker-added` NO significa "alguien ha enchufado algo"**, y creerlo costó dos bugs distintos; los dos dejaban el sonido en el **HDMI de la GPU**, que en esta máquina no tiene nada conectado (es una salida interna), y como el default así fijado **se persiste** (`default.configured.audio.sink` en `~/.local/state/wireplumber/default-nodes`), el estropicio sobrevivía al reinicio y pisaba lo que WirePlumber ya había restaurado bien:
  1. **Ráfaga de enumeración.** AstalWp emite `speaker-added`/`microphone-added` también por cada endpoint que **ya existía** al arrancar el shell (medido: HDMI y analógico, ~8 ms entre medias) → se lanzaba un `set-default` por cada sink, en `execAsync` concurrentes donde ganaba el último en *terminar*: moneda al aire en cada arranque de Hyprland. Remedio: **gate de asentamiento** (`AUDIO_SETTLE_MS` de silencio antes de conmutar nada), anclado **a que WirePlumber haya publicado algún endpoint**, no al arranque de AGS — en el boot los dos se levantan a la vez y el shell puede ganar la carrera, así que una gracia contada desde AGS expiraría justo antes de que llegue la ráfaga.
  2. **Recreación de nodos.** La señal se emite otra vez cada vez que un nodo se recrea, y el nodo HDMI/DP se destruye y se recrea al reconfigurar los monitores (**`hyprctl reload`**, DPMS, apagar la pantalla) — llega indistinguible de unos cascos recién puestos, y el id cambia (visto: 86 → 71 → 86). Remedio: **una salida de pantalla nunca es destino** (`isDisplayOutput`). El gate de (1) no cubre esto (la recreación llega mucho después de arrancar) ni al revés: hacen falta los dos.

  **El formulario de contraseña Wi-Fi va FIJO fuera del `<For>`, no dentro de la fila.** `QsWifiMenu` lo monta entre la cabecera y la `ScrolledWindow`, gobernado por `passwordTarget` (el SSID, o `null`) vía un `<With>` **metido en su propia `<box>`**. Esa caja es obligatoria: **un `<With>` cuyo valor cambia después de construirse añade su hijo con `append`, es decir, AL FINAL de su contenedor**, no en el hueco donde está escrito (solo el valor inicial sale en orden, porque se vuelca al construir el padre). Colgado a pelo de `qs-wifi-menu`, el formulario aparecía **debajo de la lista**. Envuelto, es el único hijo de su caja y el final es su sitio (medido en una ventana de prueba: cabecera y=0, formulario y=18, lista y=108). Metido dentro del `<For>`, cada refresco de APs lo rompía por dos vías, las dos sin error: (1) `For` hace `fragment.remove(child)` + `append(child)` de **todos** los hijos en cada re-evaluación del `each` para poder reordenar, así que el `Gtk.Entry` se reparentaba y perdía foco/cursor; (2) un `notify::access-points` —que NM emite **solo** al fluctuar la señal, cada pocos segundos, sin que nadie reescanee— cambia las referencias de los AP GObjects afectados y reconstruye esa fila entera, rehaciendo el `Entry`: al re-pedir el foco por código GTK **selecciona todo el texto** (`gtk-entry-select-on-focus`), y el reordenado de la lista lo desplazaba de sitio. Fijo y construido una sola vez (solo se rehace si cambia `passwordTarget`, nunca al teclear: `passwordStr` no entra en el `each`), el campo queda quieto. El `$` del `Entry` hace `grab_focus()` + `set_position(-1)` en un idle para deshacer esa selección total inicial. Y el `Gtk.EventControllerKey` que redirige teclas al buscador **se inhibe mientras `passwordTarget` no sea `null`** (si no, escribir la contraseña filtraba la lista y el foco saltaba al buscador). El `qsView.subscribe` **limpia `passwordTarget`/`passwordStr`/`passwordError` al salir de la vista**: `QsWifiMenu` no se desmonta (solo se oculta con `visible`), así que sin eso un intento de contraseña a medias seguía en pantalla al volver a entrar (y al cerrar el panel, que resetea `qsView` a `main`).

  **El recorte de entrada de QS va con `seguirAsignacion: true`** (`utilidades/inputRegion.ts`). Cuando el panel crece (el formulario, la ficha de info de una red, un desplegable), `notify::height` de la superficie llega **antes** de que GTK reasigne los hijos a la medida nueva: el tick+idle del helper medía el contenido con la altura vieja y ya no volvía a medir. Medido en una ventana de prueba: superficie a 288 px y región aplicada `330×198` tres veces seguidas. La franja nueva de abajo se quedaba **sin entrada**: el puntero, al pasar por ella, «salía» del panel y `handlePointerLeave` lo cerraba. La opción re-mide en el `after-paint` del reloj de frames (el layout ya está hecho) y solo reaplica si la silueta cambió; sin frames no corre (0 frames pintados en reposo, medido). Es **opt-in**: el lagarto se mueve cada frame y reaplicaría la región en cada uno, deshaciendo su holgura de recorte.

  **Auditoría del `<For>` sin `id` en este panel** (mismo fallo que en la barra; ver la sección de escritorios): las listas cuyos elementos son **GObjects** —`endpoints` (`AstalWp.Endpoint`), los tres bloques de Bluetooth (`AstalBluetooth.Device`) y los puntos de acceso wifi— son **correctas tal cual**: filtrar y ordenar conserva la referencia, y sus filas ya son reactivas vía `createBinding`. Las de **strings** (barras de señal) se indexan por valor. Las dos que sí fabrican objetos nuevos son las que salen de un sondeo: las **pastillas de pantalla** (`hyprctl monitors -j` cada 2 s) ya van con `id={m.name}` y leen `focused` del state; y la **mezcla de aplicaciones**, que estuvo sin clave **a propósito** mientras se alimentaba de un sondeo `pactl` cada 2 s —era la reconstrucción de la fila lo que re-sembraba `currentVol` desde el valor real del sistema, así que ponerle `id` habría dejado el slider sordo a los cambios hechos fuera del panel—, hoy **va con `id`** porque su fuente es AstalWp: cada fila escucha el `notify::volume` de SU stream. Con esa inversión se fueron también los dos apaños que sostenían aquello: la firma `streamsSignature` (publicar solo si algo cambió) y el congelado de 2,5 s tras tocar el slider (`spkLastInteraction`, para que la vuelta siguiente del sondeo no pisara el arrastre). **Es el patrón general de este panel**: una lista de GObjects con `id` y filas reactivas; el sondeo era lo que forzaba la excepción.

  El tipo se decide por el **nombre de nodo** (`node.name` del propio endpoint —`get_pw_property`—, con `wpctl inspect <id>` solo de red por si el proxy aún no lo tiene poblado; `…hdmi-stereo` vs `…analog-stereo`): `Endpoint.name` viene a **null** y el `icon` es el mismo (`audio-card-analog-pci`) en ambos, y la `description` sí se traduce, así que buscar "(HDMI)" ahí dependería del locale. El jack de auriculares **no** pasa por aquí: enchufarlo no crea un sink, cambia la *ruta* del mismo nodo analógico (por eso `bar/Volume.tsx` escucha `notify::route`). Un `set-default` por ráfaga (debounce) y por id de endpoint — no parseando `pactl` con awk.

  **⚠️ `default.audio.sink` NO es la clave que hay que escribir, y confundirla es indistinguible de un bug de hardware.** Elegir un dispositivo desde la lista escribía `pw-metadata -n default 0 default.audio.sink '{"name":…}'`. Esa clave dice cuál es el default **ahora** y su dueño es WirePlumber, que la **recalcula entera en cada rescan** (alta o baja de un nodo, cambio de perfil de tarjeta, el nodo HDMI recreándose por DPMS o `hyprctl reload`…). O sea: el cambio se oía al instante y se deshacía solo un rato después, sin un error por medio. Síntomas reportados, los tres del mismo origen: *"el audio cambia de repente del analógico al digital"*, *"al tocar el volumen del analógico vuelve a saltar"* (tocar el slider dispara el mismo `activate`, que escribía la clave mala y provocaba el rescan que lo revertía) y *"la entrada también cambia sola"*.
  La clave de **preferencia** es `default.configured.audio.sink|source`, y WirePlumber guarda ahí una **PILA** de todo lo que se ha configurado alguna vez (sufijos `.0`, `.1`… en `~/.local/state/wireplumber/default-nodes`; ver `/usr/share/wireplumber/scripts/default-nodes/state-default-nodes.lua`). En su selección, estar en la pila suma **+20001 − posición**, así que un dispositivo configurado una sola vez gana a cualquier otro por prioridad de sesión, para siempre. Como `activate` nunca escribía esa clave, los cascos USB **no llegaban a entrar en la pila** mientras el HDMI sí estaba —lo había metido el switch-on-connect de arriba, que siempre usó `wpctl`—, y por eso ganaba cada rescan. Hoy `activate` usa `wpctl set-default <id>` (`setDefaultEndpoint`), que escribe la clave correcta y además hace innecesario traducir el id a `node.name` con `pactl | awk` — el `id` de AstalWp **es** el id global de PipeWire. Al depurar esto, mirar `pw-metadata -n default` y el fichero de estado: la contradicción entre `default.audio.*` (correcto) y `default.configured.audio.*` (un dispositivo viejo, o incluso uno que ya no existe) es la firma exacta del fallo. Una pila heredada se limpia borrando la clave (`pw-metadata -n default -d 0 default.configured.audio.sink`, que vacía la pila entera) y volviendo a elegir el dispositivo.

  **Dos filas marcadas como activas a la vez.** El resaltado salía de `isDefault() || localDefaultId() === ep.id`: dos fuentes de verdad para el mismo hecho, y el optimista `localDefaultId` solo se **ponía** (al pulsar), nunca se quitaba — su corrector era `notify::default-speaker`, que esta versión de AstalWp **no emite**. Bastaba con que el cambio no cuajara (lo de la clave de metadata, justo arriba) para que el optimista se quedara clavado en el analógico mientras `isDefault` se iba al digital. Hoy hay **un solo `idActivo`**, sembrado y corregido desde `notify::is-default` de cada endpoint (esa señal sí llega) y adelantado al pulsar; contradecirse es imposible por construcción. Los handlers se **reenganchan** cuando cambia la lista: los endpoints se destruyen y se recrean, y se irían con ellos.

  **Qué endpoints se listan: `servicios/multimedia/endpointsAudio.ts` (puro, con test).** PipeWire publica un nodo por cada perfil activo de cada tarjeta, haya o no algo al otro lado del cable. Dos filtros, y la diferencia entre ellos importa:
  - **Muerto por hardware → se oculta siempre.** ALSA marca los puertos sin nada enchufado como `not available`, y eso llega como `route.available == AstalWp.Available.NO`. En esta máquina se lleva la entrada analógica de la placa (micro frontal, trasero y línea, todos no disponibles). `UNKNOWN` **no** cuenta: es el valor de todo lo que no tiene detección de jack (USB, S/PDIF, Bluetooth) y tratarlo como muerto vaciaría la lista. El switch-on-connect también lo mira: esa entrada muerta se recrea al cambiar el perfil de la tarjeta y llegaba como "micrófono recién conectado".
  - **Lo demás lo aparta el usuario: clic derecho sobre la tarjeta.** Es un flip-flop, y la vuelta está en un desplegable **"Ocultos (N)"** plegado y debajo de todo (con el mismo clic derecho o con el botón 󰈈). Las dos mitades son obligatorias: sin el cajón, apartar algo sería un viaje de ida y habría que editar el JSON a mano. Se persiste en `audioDispositivosOcultos` (`preferences.json`) con la clave `spk:<node.name>` / `mic:<node.name>` (`claveEndpoint`) — **el `id` no vale**: es el id global de PipeWire y cambia al recrearse el nodo (medido: 57 → 72 al conmutar el perfil de la tarjeta), o sea que ocultar algo duraría hasta el siguiente `hyprctl reload`.
  - **Por qué no se filtran las digitales por clase.** Hubo un interruptor global que escondía todo lo que casara con `esSalidaDigital`; se retiró al llegar el clic derecho. Acertaba en esta máquina de casualidad, pero es una regla **por clase** para un problema que es **por aparato**: una TV o una barra de sonido por HDMI sí valen, y una salida analógica que no uses no la tocaba. Y tampoco son detectables automáticamente — conviene saber por qué antes de reintentarlo: el S/PDIF **no tiene detección de jack** (siempre `UNKNOWN`) y el HDMI está literalmente `available` porque el monitor está conectado y su ELD anuncia que acepta audio; que el monitor no tenga altavoces no es algo que el equipo pueda saber. `esSalidaDigital` sigue viva **solo** porque el switch-on-connect la necesita (`isDisplayOutput`) para no adoptar nunca una pantalla.
  - **El endpoint activo nunca se oculta**, y por eso tampoco se deja MARCAR (`alternarOculto` rechaza; el tooltip lo dice). Marcarlo no se nota en el momento —`repartirEndpoints` lo mantiene visible— pero deja una trampa armada: apartas los cascos sin querer, los desenchufas, el default se va al HDMI y los cascos ya no salen en la lista justo cuando los vuelves a enchufar para elegirlos. La regla de `repartirEndpoints` se queda como red para marcas **heredadas** (guardadas antes de esta regla, o un dispositivo apartado que luego pasa a ser el default por su cuenta), y en ese caso **no se cuenta además como oculto**, o aparecería a la vez arriba y en el contador de abajo.

  **El micrófono tiene su PROPIA escala, y por eso dos vistas del mismo micro enseñaban números distintos.** `servicios/multimedia/volumenMicrofono.ts` (puro, con test) tiene `MIC_SAFE_MAX` y las dos conversiones: el 0-100 % de la UI se remapea a `0..MIC_SAFE_MAX` de la curva cruda de PipeWire. **Hoy `MIC_SAFE_MAX = 1.00`** (el 100 % de la barra es el 100 % real del hardware). Antes valía `0.40`, un "máximo seguro" contra la saturación de la curva cúbica "Capture" + "Front Mic Boost" del ALC897, pero en uso real quedaba demasiado bajo: el slider al tope dejaba el micro al 40 % y apenas se oía. Si hiciera falta volver a poner techo, se cambia SOLO esa constante. El fallo: la constante se exportaba desde `QuickSettings.tsx` y **la fórmula iba abierta en código en cada consumidor**, así que la pastilla "Micrófono" se quedó con un `Math.round(v * 100)` sobre el valor crudo y decía **40** mientras su propio submenú decía **100** (medido: `wpctl get-volume @DEFAULT_AUDIO_SOURCE@` → `0.40`, o sea justo el techo). Es silencioso por naturaleza —dos números plausibles, ningún error— y solo se ve con las dos vistas delante. **Regla: nada nuevo puede escribir `volume * 100` para un micrófono**; todo pasa por `porcentajeMic`/`crudoDesdePorcentajeMic`/`fraccionMostradaMic`, que es lo que mantiene de acuerdo a la pastilla, al submenú y al `MicOSD`.

  **El volumen por aplicación no se aplicaba a las apps lanzadas con el panel cerrado** (`servicios/multimedia/presetsApps.ts`). Los presets se guardaban bien en `audioPresets.json`, pero la única línea que los **aplicaba** vivía dentro del sondeo `pactl` de la "mezcla de aplicaciones", y ese sondeo tiene refcount contra `quickSettingsVisible ∧ qsView ∧ audioMode === "apps"`: solo corre con ese submenú **abierto**. O sea que bajabas Spotify al 57 %, cerrabas el panel, reabrías Spotify y sonaba al volumen que trajera la app; el ajuste no se había perdido —seguía en el JSON, y al abrir el submenú se aplicaba de golpe— simplemente no había nadie escuchando cuando aparecía el stream. Silencioso de manual: ningún error, y con el panel abierto (que es como se depura) funciona siempre. No era específico de Spotify. Hoy el almacén de presets y su aplicación viven en `presetsApps.ts`, con `initPresetsApps()` en el bloque de t=4 s de `app.ts`, y `QuickSettings.tsx` se queda con la UI:
  - **Por eventos y sin un solo subproceso**: `audio.streams` / `audio.recorders` de AstalWp *son* los sink-inputs y source-outputs de Pulse, con señales `stream-added` / `recorder-added` y `notify::volume` por stream, y su `volume` está en la MISMA escala que el `value_percent` de `pactl` (medido: preset 0,20 → `volume` 0,2000000031). Se escribe con `fijarVolumenEndpoint`, no con `stream.volume = v`: el setter de AstalWp recorta a 1.5 en silencio y los presets de app llegan al 200 %.
  - **Corrección tardía durante toda una ventana de gracia (1,5 s), no una sola vez.** Una app puede fijar su propio volumen **justo después** de crear el stream (Spotify restaura el suyo al conectar): aplicando solo al aparecer, el cliente gana la carrera y el preset vuelve a no verse — el mismo síntoma con otra causa. Y la corrección **no puede ser de un disparo**, que es el bug que costó una ronda: al llegar `stream-added` el `volume` del stream todavía es `0` y el valor real llega en una notificación posterior (medido: `added vol=0` → `notify::volume 1` → …), así que el único disparo se lo comía esa notificación de inicialización y el pisotón real, 400 ms más tarde, ya no tenía a nadie escuchando. Pasada la gracia **el manejador no se suelta: cambia de oficio**. Deja de corregir —bajar el volumen desde la propia app tiene que funcionar— y pasa a ANOTAR el valor vivo en el preset (ver el bloque siguiente). Medido, los tres casos: preset aplicado con el panel cerrado, pisotón a 100 % dentro de la gracia devuelto a 20 %, y cambio pasada la gracia respetado.
  - **Los ids atendidos son los de PipeWire y se limpian en `stream-removed`.** Con los índices de Pulse de la primera versión había que podarlos contra la lista viva en cada pasada: PulseAudio los **recicla**, y un índice reciclado que siguiera marcado como atendido no volvería a recibir su preset nunca.
  - **La primera versión vigilaba con `pactl subscribe`, y lo que la tumbó merece quedar escrito** porque se repite con cualquier subproceso callado. Gio no mata a los hijos al salir, y el SIGPIPE que normalmente los liquida no llegaba: ese proceso solo escribe **cuando ocurre un evento de audio**, así que cada reinicio de AGS dejaba un huérfano (medido: cuatro vivos con un solo AGS). `cava` no lo sufre porque escribe 60 líneas por segundo y se lleva su SIGPIPE en el primer frame — por eso nadie lo había visto. Hacía falta un envoltorio `bash` que vigilara el stdin, y dentro de él un **`exec 3<&0`**, porque POSIX manda redirigir a `/dev/null` el stdin de todo proceso en segundo plano de un shell sin control de trabajos: un `cat > /dev/null &` a secas ve EOF en el acto y mata al hijo nada más arrancar, sin un solo error y con el vigilante muerto. Todo eso desapareció al pasar a AstalWp — una señal de GObject no deja huérfanos. Y también hacía falta `LC_ALL=C`, porque los mensajes de `pactl subscribe` son traducibles.
  - **Una sola implementación del nombre (`nombreDeProps` + `propsDeStream`), y la clave (`clavePreset`) la pone el servicio, no cada consumidor** (el nombre VISIBLE es otra cosa: ver el bloque siguiente). La fila de Quick Settings y el vigilante tienen que llegar a la MISMA cadena; si divergen, la fila guarda el preset bajo una clave que el vigilante nunca busca y el ajuste deja de aplicarse sin un solo error. Ya pasó una vez —la fila de micro guardaba con `mic:` y el poller aplicaba con `app:mic:`— y estuvo a punto de repetirse al portar a AstalWp, con dos funciones calculando el nombre (una desde las props de `pactl`, otra desde `get_pw_property`).

  **El volumen del ALTAVOZ pegaba un salto al abrir el submenú, y de ahí se colaba al arranque siguiente** (`servicios/multimedia/presetsDispositivos.ts`, nuevo). Las claves `dev:spk:<aparato>` / `dev:mic:<aparato>` de `audioPresets.json` se **escribían** en un solo sitio —los dos manejadores del deslizador de la tarjeta de dispositivo en `QuickSettings.tsx`, el arrastre y la casilla del número— pero se **aplicaban** al construirse esas filas, una vez por sesión. O sea que cualquier volumen puesto por otra vía (las teclas de volumen de Hyprland, la rueda sobre la pastilla de la barra, `wpctl`, pavucontrol) actualizaba el sonido y **no** el preset, que se quedaba con lo que el deslizador dejó allí semanas atrás; la primera vez que se dibujaba la tarjeta, ese valor rancio se escribía encima del volumen vivo. Y el salto no se quedaba ahí: el `notify::volume` del altavoz por defecto alimenta `guardarEstadoSistema`, que lo copia a `system_state.json`, que es lo que `inicializador/init.sh` repone en el arranque siguiente. Síntoma exacto reportado: *"si lo dejo en 50 % cuando vuelvo puede estar en 80 %"* + *"parece solo afectar cuando abro esa sección"*. Silencioso de manual: ningún error, y **tres** almacenes del mismo número (WirePlumber en `~/.local/state/wireplumber/default-routes`, `system_state.json` y el preset) de los cuales solo uno se quedaba atrás.
  - **La regla que lo arregla: el preset SIGUE al volumen real.** El vigilante escucha `notify::volume` de cada endpoint y anota el valor vivo, venga de donde venga (medido: preset 0,40 → `wpctl set-volume 0.70` → el JSON queda en 0,6999 y `system_state.json` con el mismo número). Si no puede quedar rancio, aplicarlo no puede pisar nada. La misma regla la aplica ahora `presetsApps.ts` a los presets por aplicación (`recordarPreset`, compartida), que tenían el mismo agujero: bajar Spotify desde la propia app se respetaba esa sesión y se olvidaba, y en la siguiente volvía a imponerse el valor viejo del JSON.
  - **Solo se sincroniza lo que YA existe.** `recordarPreset` sale si la clave no está, y eso no es una optimización: anotar también las ausentes estrenaría un preset por cada aparato enumerado y por cada app que suene una vez, con el volumen que trajeran, **y a partir de ahí se lo impondríamos en cada arranque** — el mismo pisotón con otro origen. La clave la crea el deslizador de Quick Settings, o sea una decisión explícita; sin preset manda WirePlumber, que ya guarda el volumen por ruta él solo (medido aquí: `channelVolumes: 0.063997` = 0,40³ para los altavoces).
  - **Se aplica cuando el aparato APARECE, no cuando se mira la lista**, con `initPresetsDispositivos()` en el bloque de t=4 s de `app.ts` y las señales `speaker-added` / `microphone-added` de AstalWp. Arregla de paso un hueco que nadie había reportado: unos cascos USB enchufados a mitad de sesión no recuperaban su volumen hasta que abrías el submenú.
  - **La clave (`claveDispositivo`) la pone el servicio**, igual que `clavePreset` para las apps y por el mismo motivo. Ojo con su respaldo: `ep.name` viene a **null** en el perfil ALSA clásico (medido en esta máquina: los cuatro altavoces y los dos micros), así que sin caer a `ep.description` la clave colapsaría a `dev:spk:null` para todos.
  - **La ventana de eco de 400 ms** al restaurar es contra la propia escritura, que vuelve como `notify::volume`: anotarla sería inocuo salvo por el redondeo de la curva cúbica de PipeWire (0,20 → 0,2000000031), que dejaría el fichero reescribiéndose sin motivo.
  - **La lista de dispositivos va con `id` y su deslizador se DESCONECTA.** `repartirEndpoints` se recomputa cada vez que cambia el dispositivo activo o la lista de ocultos, y ese `<For>` no llevaba `id`: un clic en un dispositivo tiraba y rehacía las cuatro filas enteras. Cada fila enganchaba además un `notify::volume` al endpoint **sin soltarlo nunca**, así que la reconstrucción iba dejando manejadores vivos escribiendo en el ajuste de deslizadores ya desechados — fuga lenta y sin un solo error. Hoy el `id` es el de PipeWire (un nodo recreado trae uno nuevo, así que la fila sí se rehace cuando debe) y el manejador se suelta en `onCleanup`.

  **El sondeo de 2 s de la mezcla se retiró; lo que queda de `pactl` y por qué.** La lista se reconstruía entera cada 2 s con dos subprocesos `pactl` (~6 ms por vuelta) mientras el submenú estuviera abierto. Hoy las filas de apps que **suenan** salen de `audio.streams` / `audio.recorders` (lista reactiva) y cada fila escucha el `notify::volume` de su stream, así que un cambio hecho desde fuera —pavucontrol, `wpctl`, la propia app— se ve al instante en vez de hasta 2 s después. Lo que **no puede ser nativo** son las filas de apps **en silencio**: salen de la lista de CLIENTES de PulseAudio, y un cliente de Pulse es un concepto del servidor Pulse que WirePlumber no modela — AstalWp no lo expone por ningún lado. Ese `pactl -f json list clients` sigue ahí, pero **sin temporizador**: se pide al abrir el submenú y se refresca por eventos (`stream-added`/`stream-removed` de AstalWp, y `client-added` de Hyprland para la app recién lanzada que abre su cliente de Pulse sin crear ningún stream — un navegador, Spotify antes de darle a play). ⚠️ Esos enganches van a las **señales de AstalWp**, nunca a la lista ya compuesta: refrescar los clientes recompone las filas, así que escuchar la composición sería un bucle de refrescos perpetuo. La guarda de 300 ms de la fila es contra el **eco propio**: el tramo amplificado se escribe con `wpctl`, que tarda, y sin ella un valor en vuelo vuelve como notificación y da un tirón al deslizador que el usuario está arrastrando.

  **Los nombres y los iconos de la MEZCLA DE APLICACIONES (`servicios/multimedia/identidadApps.ts` —puro, con test— y `presentacionApps.ts`).** La fila se pintaba con `application.name` a pelo y con `iconName={application.icon_name || window.icon_name || name.toLowerCase()}`. Las dos mitades fallan sin un solo error:
  - **El nombre lo pone la APP, no PulseAudio**, y llega como venga: binario en minúscula (`spotify`), con sufijo de rol (`Brave input` — así se anuncia el cliente de captura de Brave, medido aquí) o con adornos de PipeWire (`WirePlumber [export]`). Hoy se resuelve contra el **índice de `.desktop`** (`Spotify`, `Brave Origin`, `Visual Studio Code`).
  - **El icono acababa SIEMPRE en `name.toLowerCase()`.** `application.icon_name` casi nunca viene en un sink-input, y como el nombre en minúsculas nunca es cadena vacía, la última rama del `||` —el genérico `audio-x-generic-symbolic`— era **inalcanzable**: `Gtk.Image` pedía un icono inexistente y dejaba el hueco. De ahí el "casi siempre" del síntoma: solo acertaba cuando el nombre de la app coincidía por casualidad con un icono del tema. Hoy el nombre de icono sale del `.desktop` (`spotify` → **`spotify-client`**, que es el que existe) y solo si no hay nada se usa el genérico.
  - **El binario NO es el id del `.desktop`** (`brave` vs `brave-origin`), así que la búsqueda exacta de `obtenerEntradaEscritorio` no basta: `obtenerEntradaEscritorioPorCandidatos` añade una pasada **por prefijo con separador y clave más corta** — sin lo de "más corta", `brave` casaría antes con una PWA (`brave-hjlhbeff…-default`) que con el navegador.
  - **Las apps "en silencio" salían de la lista de CLIENTES**, o sea de todo lo que abre el servidor de sonido, filtrada por una lista negra literal de nombres. Lo que nadie escribió en esa lista se colaba como app (`pw-mon`). Hoy hay dos filtros: infraestructura (`esClienteDeSistema`, por prefijo con frontera — un `includes("ags")` se llevaba por delante apps legítimas) y **tener `.desktop` instalado**. La deduplicación contra los streams activos va por **identidad** (`claveApp`), no por nombre visible: comparando cadenas, `Brave input` y `Brave` daban dos filas de la misma app.
  - **Un JUEGO no tiene `.desktop`, así que su fila salía con el icono genérico de audio.** `application.name` de un juego (el `.exe` de Windows, o lo que ponga el motor) no casa con ninguna entrada instalada, y `nombreIconoDesdeCandidatos` devolvía `null` → `audio-x-generic-symbolic`. La barra sí sabe pintarlo, pero por la **clase de la ventana** (`steam_app_<appid>` → `steam_icon_<appid>`), y desde un stream de audio no hay clase ninguna. Hay **cuatro intentos y los cuatro hacen falta**, medido con Rocket League: (1) el **PID** —`application.process.id`, añadido a `CLAVES_PW`, contra el `pid` que guarda el registro de `servicios/juegos/`— que es exacto pero **solo lo publican los clientes de `pipewire-pulse`** (Discord, wine): un cliente nativo de PipeWire como Spotify expone el nodo con `client.id` y **sin pid**, y AstalWp no deja seguir ese `client.id`; (2) los **antepasados** de ese pid por `/proc/<pid>/stat` (`extraerPadreProceso`), porque un juego de wine reparte el audio entre subprocesos que cuelgan del de la ventana; (3) los candidatos contra la **clase**; y (4) el **nombre contra el título de la ventana** (`nombreCasaConJuego`, puro y con test), que es el que salva el caso real —el stream se anuncia `Rocket League`, la ventana es `steam_app_252950` con título `Rocket League (64-bit, DX11, Cooked)`: **no hay un solo identificador en común**, solo el nombre dentro del título—. Resuelto el juego, el icono sale de `obtenerNombreIconoAplicacion` (nombre del tema activo) o de `obtenerIconoOriginalAplicacion`, y si no hay ninguno se pinta el **glifo** `GLIFO_JUEGO` (`.qs-stream-glifo`, violeta) en vez del icono de audio.
  - **El arte de un juego de Steam casi nunca está en `hicolor` ni en el tema activo** (`servicios/aplicaciones/iconos.ts`, `iconoSteamEnTemasInstalados`). Steam solo deja el `steam_icon_<appid>.png` en `hicolor` al crear un acceso directo (aquí hay tres de toda la biblioteca); quien los trae a miles es un **pack de iconos instalado** —`Gruvbox-Plus-Dark`— que **no es el tema activo** (`Tela-circle-grey`), así que ni `has_icon()` ni la búsqueda por hicolor lo ven. Por eso, y **solo para `steam_icon_*`**, se rebusca en los temas instalados. **No con `Gtk.IconTheme.set_theme_name()` en bucle**: cada cambio parsea el `index.theme` del tema y recorrer los instalados costaba **~2 s** en el hilo del bucle principal; se miran rutas directas con las dos disposiciones reales (`48/apps` de hicolor y `apps/48` de los packs de Gruvbox), que son ~1100 `stat` y **2 ms** medidos, cacheados por appid incluidos los negativos. Lo aprovecha también la barra, que resuelve el icono por `obtenerIconoOriginalAplicacion` antes que por nombre de tema. La caché de `presentacionApps` se invalida también con `clientesJuego`: una ventana puede registrarse después de que su stream ya haya sonado, y sin eso la fila se quedaría con el genérico hasta reiniciar el shell.
  - **La CLAVE del preset sigue siendo el nombre crudo** (`clavePreset` + `nombreStream`): la comparte el vigilante de `presetsApps.ts`, que no puede depender de GTK, y cambiarla invalidaría los `audioPresets.json` existentes. Lo que se enseña y lo que se guarda son cosas distintas **a propósito**.

  **Los nombres de la lista.** `endpointLabel` se quedaba **solo** con `device.profile.description` para que el `ellipsize` no recortara la parte única de una `description` larga; el remedio salió peor que la enfermedad. Las filas pasaron a llamarse "Estéreo analógico", "Estéreo digital (HDMI)" y "Mono" —sin una palabra sobre **qué aparato** es— y dos filas distintas (los cascos USB y la entrada de la placa) se leían **exactamente igual**, mientras Discord y pavucontrol enseñaban "SIMGOT EW300 DSP Estéreo analógico". Hoy son **dos líneas**: arriba el aparato (`node.nick`, que en el HDMI trae además el modelo del monitor leído del EDID —"XG27AQDMES", bastante más útil que "GA106 High Definition Audio Controller"—; si falta, se le quita a la `description` el sufijo del perfil, que es literalmente cómo la construye WirePlumber) y abajo el perfil, en `.qs-audio-sub`. La segunda línea se omite si repetiría la primera.

  **Bluetooth — el "apagado" del usuario lo borraba el propio BlueZ, y el tile mentía.** Tres bugs
  con la misma raíz: *nadie puede distinguir "lo encendió el usuario" de "lo encendió
  BlueZ" si no se le da tiempo al adaptador*.
  1. **`AutoEnable` (activado por defecto en `/etc/bluetooth/main.conf`) enciende el controlador él
     solo en cuanto lo encuentra — y lo hace DESPUÉS de registrar el adaptador.** Queda una ventana
     en la que el adaptador ya existe y sigue apagado, indistinguible de "el usuario lo dejó
     apagado". `resolverRestauracionBluetooth` (`bluetooth/estadoInicio.ts`) daba la restauración
     por terminada ahí mismo, solo porque el estado coincidía con el objetivo; el power-on de BlueZ
     llegaba justo después, nadie lo corregía, y `guardarEstadoSistema` lo **adoptaba como decisión
     del usuario** reescribiendo `bluetooth: true` en `system_state.json`. Resultado medido con un
     A/B: con la lógica vieja, arrancar con el BT apagado y guardado como apagado terminaba con
     `Powered: yes` **y el `false` del disco pisado a `true`** — o sea que el apagado no sobrevivía
     ni a ese arranque, y menos al siguiente. Hoy "coincide con el objetivo" **no basta** para
     cerrar: hace falta el parámetro `asentado`, que se arma con `BT_SETTLE_MS` (5 s) contados
     **desde que el adaptador aparece**, no desde que arranca AGS — es un dongle USB (RTL8761 aquí)
     y puede tardar en enumerarse, así que una gracia contada desde el shell expiraría antes de que
     BlueZ llegue a verlo (mismo razonamiento que el gate de audio de arriba). Mientras no está
     asentado no se actúa, pero la restauración **sigue viva** y corrige el encendido automático.
     **Una acción explícita del usuario cierra la restauración en el acto**
     (`finalizarRestauracionBluetooth()` desde `toggleBluetoothPower`): sin eso, encender el BT
     dentro de esos 5 s haría que la restauración se lo volviera a apagar en la cara. Un encendido
     externo *pasada* la ventana sí se adopta y se guarda, como siempre.
  2. **Pero la ventana era de UN SOLO USO, y un dongle USB no es un adaptador estable.** El punto 1
     arregla el arranque; el mismo encendido vuelve a mitad de sesión y ahí no lo corregía nadie.
     Al volver de una suspensión el kernel **reenumera el dongle** (`Bluetooth: hci0: RTL: loading
     rtl_bt/rtl8761bu_fw.bin` en el log de esta máquina, en el mismo segundo que el `PM: suspend
     exit`), BlueZ lo registra **como si acabara de aparecer** y su `AutoEnable` lo enciende otra
     vez — solo que con `restauracionBluetoothCompletada` ya en `true`, así que
     `registrarEstadoBluetoothConfirmado` lo adoptaba como decisión del usuario y
     `guardarEstadoSistemaAhora` reescribía `bluetooth: true`. En la sesión siguiente ya no quedaba
     nada que restaurar: **el apagado no sobrevivía a una suspensión**, que es lo que se veía como
     "casi siempre lo apago y vuelve encendido". Hoy **la ventana se REABRE** con
     `reabrirVentanaRestauracion` (puro, con test) en las dos rutas que hacen falta y que no se
     cubren entre sí: (a) cuando el adaptador pasa de **ausente a presente** — se sigue con
     `habiaAdaptadorBluetooth`, y por eso `adapter-removed` también está conectado a
     `sincronizarEstadoBluetooth`: es lo único que baja esa bandera si el adaptador desaparece **ya
     apagado**, porque entonces `is-powered` no cambia y no se emite; y (b) al recibir
     `PrepareForSleep(false)` de logind, porque si el kernel recupera el dongle con `reset_resume`
     el objeto de BlueZ **nunca desaparece** y no hay alta que observar, pero el controlador sí ha
     pasado por un reinicio; y (c) al entrar el adaptador en **`PowerState: off-blocked`**, o sea un
     bloqueo de rfkill, que tampoco da de baja el objeto. Con reenumeración se solapan y la segunda
     reapertura es idempotente.
     **(c) es además el único reproductor sin privilegios, y con él está medido el A/B**: con
     `bluetooth: false` en disco, el BT apagado y la restauración ya cerrada, `rfkill block
     bluetooth` + `rfkill unblock bluetooth` terminaba en `Powered: yes` **y el fichero reescrito a
     `true`**; con el arreglo, la traza de `dbus-monitor` sobre `/org/bluez/hci0` enseña la
     secuencia completa — `off-blocked` → `off-enabling` → `on` (**lo enciende BlueZ**) →
     `on-disabling` → `off` (**lo corrige AGS**) — y el disco se queda en `false`. Se engancha a
     `off-blocked` y **no** al encendido posterior porque es lo único que distingue ese encendido de
     uno pedido a mano con `bluetoothctl` o blueman, que **sí** se adoptan: pelearse con ellos sería
     peor que el bug. `on-disabling`/`off-enabling`, por los que pasa cualquier apagado o encendido
     normal, se ignoran a propósito. De paso, `objetivoBluetoothInicial` (congelado en el arranque) y
     `ultimoEstadoBluetoothConfirmado` (el que se guardaba) se **fundieron en `intencionBluetooth`**:
     eran dos nombres de la misma cosa y en cuanto la ventana se reabre a mitad de sesión discrepan
     — la ventana nueva habría restaurado el valor del arranque en vez del último que pidió el
     usuario.
  3. **El tile tenía dos fuentes de verdad para el mismo hecho.** El CSS salía de
     `createComputed(() => btSupported() && btPowered())` sobre un `createBinding(bt, "isPowered")`,
     y el texto de un `createState` que escribía `syncBtInfo`. Los dos cuelgan de
     `notify::is-powered`, pero son **handlers distintos** y GObject los invoca en orden de
     conexión: `syncBtInfo` se conecta al construir el componente y el del binding al renderizar,
     o sea después — el CSS iba un handler por detrás y los dos se contradecían (medido:
     `CSS=ACTIVE` con `TEXTO="Desactivado"`). Ahora `getBluetoothTileInfo` devuelve también
     **`active`**, y el icono, el texto y el CSS salen del **mismo objeto y del mismo setter**:
     contradecirse es imposible por construcción (hay test). De paso se fue `btDevices`, que era
     código muerto. Y se escucha **`notify::is-connected`**: conectar unos cascos **ya emparejados**
     no cambia la lista, así que `notify::devices` no salta y el tile se quedaba en "Desconectado"
     con los cascos puestos.
     **Queda una asimetría que no cierra sola: el tile es una FOTO y el interruptor del submenú es
     un `createBinding`.** Una foto que se pierda una emisión miente el resto de la sesión; un
     binding relee la propiedad y se recompone. Eso es exactamente el segundo síntoma reportado —el
     texto en "Desactivado" con el interruptor encendido, o sea las dos lecturas del *mismo*
     `bt.isPowered` contradiciéndose— y por eso `syncBtInfo` (y el `btSupported` del submenú) se
     **resiembran al abrir Quick Settings**, igual que ya hacía el tile de red. No sustituye a las
     señales, las cubre: **no se ha aislado qué emisión concreta se pierde** (el ciclo
     quitar/poner adaptador de AstalBluetooth acaba siempre en un `sync()` que debería notificar),
     así que se ataca la clase entera en vez de un caso. Si vuelve a aparecer el síntoma **con el
     panel ya abierto**, ahí sí hay que buscar la emisión.
- `servicios/pantalla/` — cola de pantallas compartida por QuickSettings y Ajustes > Pantalla. `modes.ts` es la lógica pura (testeada con node); `service.ts` tiene el poller, `applyPatch` (aplica en vivo con `hyprctl eval 'hl.monitor{…}'` — bajo config Lua `hyprctl keyword` ya no existe) y la persistencia. **Persiste en UN solo fichero, `~/.config/gigios/display.json`, que lee también el config del compositor** (`hypr/gigios/pantalla.lua`: recorre `monitors` y emite un `hl.monitor{output="desc:…"}` por entrada, después del comodín de `gigios/monitores.lua`). Hace falta porque sin nadie que aplique las prefs al cargar, un **`hyprctl reload`** releía el comodín — `preferred`/escala 1 — y tiraba la pantalla de 240 Hz a 60 y de escala 1.25 a 1, sin que AGS pudiera enterarse (no hay señal de recarga; el poller solo observa). **Antes esto se resolvía volcando además un `monitor-settings.lua` generado**, o sea el mismo dato escrito dos veces, un fichero machine-specific dentro del árbol de git y la `description` del EDID interpolada en un chunk Lua (una comilla suelta rompía la config entera). Consecuencia de que el JSON ya no sea solo nuestro: `saveMonitorPref` llama a **`saveDisplayConfigNow()`**, escritura síncrona, y no al debounce de 2 s que usa el resto — con la espera de por medio, un `hyprctl reload` justo después de tocar la resolución releería el fichero viejo y desharía el cambio. Detalle en el `CLAUDE.md` raíz.
  - **Reglas horarias (`schedule.ts`, puro y testeado) — dos canales independientes, no uno.** Las reglas
    de `global.nightRules` (Ajustes > Pantalla > "Programación horaria") son
    `{ start, end, temp, brightness }` y programan **luz nocturna Y brillo**, cada uno con `null` =
    "esta regla no toca ese canal" (`activeSetpoint` resuelve canal a canal). Ese `null` es la pieza clave:
    sin él, una regla de solo brillo tendría que traer `temp` y apagaría la luz nocturna, que es lo
    contrario de "por separado". Solapes: gana la que **empezó más tarde** (y a igualdad, la última
    de la lista), así una franja corta puede meterse dentro de otra larga y devolverle el mando al salir.
  - **`end` es OPCIONAL: hay dos formas de escribir una regla, y la de `end: null` no es un descuido.**
    Con `end` es una **franja** `[start, end)` (fin exclusivo, cruza medianoche): fuera de ella la regla no
    existe. Con `end: null` es un **"desde"**: `isRuleActive` la da por vigente siempre, y quién manda lo
    decide el desempate por antigüedad de `activeRuleFor` — o sea que rige desde su hora hasta que otra
    regla del mismo canal la releve (que es como se encadenan: `22:00 → 3500 K` + `07:00 → apagar`).
    Existe porque obligar a poner un final para decir "a las 22:00 ponla cálida" era la queja del usuario.
    **Ojo con la trampa histórica**: el modelo original eran SOLO puntos de cambio encadenados
    (`{time, temp}`) y eso produjo un fallo reportado — con una única regla "22:00 → encender", a las
    **19:00** la luz se encendía, porque la última regla que había pasado era la de las 22:00 *de ayer*.
    Sigue siendo lo que hace un "desde" solitario; la diferencia es que ahora es una **elección visible por
    regla** (el selector «hasta las» / «en adelante» de su fila), no el único modelo posible, y que la
    franja está ahí para acotar. Al añadir cosas aquí, no conviertas franjas en "desde" ni al revés a
    espaldas del usuario. `normalizeRules` **migra** el formato viejo a franjas (encadena cada `time` hasta
    el siguiente y tira los terminadores): `22:00 on + 07:00 off` ⇒ franja `22:00 → 07:00`. Una regla sin
    `end` legible **no se descarta**: se guarda como "desde"; lo que la tira es no tener `start`.
    `ruleKey(r)` (`start-end`, con `∞` si no hay final) es la identidad que usan las claves de
    `service.ts` — úsala en vez de interpolar `${r.start}-${r.end}` a mano, o una franja y un "desde"
    con el mismo inicio compartirían clave.
  - **El brillo se aplica AL ENTRAR en la franja y se RESTAURA al salir.** Las dos mitades son necesarias:
    (1) el tick de 60 s de `applyRules()` re-aplica la temperatura (estado que hyprsunset debe sostener)
    pero **no** el brillo — reescribirlo cada minuto dejaría sin efecto el slider y las teclas
    `XF86MonBrightness*` dentro de la franja; `lastBrightnessKey` (`franja|valor`) distingue "he entrado en
    otra franja" de "sigo en la misma", e incluye el valor para que editar la franja vigente se vea al
    momento. (2) al salir se devuelve `brightnessBeforeWindow` (el brillo de justo antes de entrar, guardado
    solo en la transición de entrada), porque el brillo es un ajuste **físico que no vuelve solo**: sin eso,
    una franja de 10 a 11 se seguiría notando a la 1 de la tarde. La luz nocturna no necesita restauración
    —basta con dejar de forzarla—, y por eso su "Apagar" no lleva apunte de ningún tipo (ver el punto
    siguiente).
    Al arrancar dentro de una franja sí se aplica su brillo, pero **esperando a que haya backend**: en un
    sobremesa el sondeo DDC tarda ~1 s, así que `applyScheduledBrightness()` no marca la franja como
    aplicada mientras `brightnessSupported` sea falso, y `initDisplayService` reintenta al confirmarse (si
    no, el primer intento se perdería en el vacío). En la UI las filas de brillo se ocultan con
    `brightnessSupported`, como el slider.
  - **(3) Las dos mitades se PERSISTEN (`brightnessWindow` en `display.json`), porque la transición cruza
    apagados.** `lastBrightnessKey`/`brightnessBeforeWindow` eran solo-RAM, y el brillo es lo único aquí que
    deja **residuo físico**: la franja lo graba en la firmware del monitor por DDC y ahí se queda. Una franja
    nocturna (el caso real: `00:00→07:00`, brillo 80) **se sale casi siempre con el PC apagado** —estás
    durmiendo—, así que la restauración del punto (2) no llegaba a ejecutarse **nunca**: el 80 se quedaba
    grabado en el monitor y, al arrancar, `detectDdc()` lo leía de vuelta y lo publicaba como si fuera la
    elección del usuario; `brightness.subscribe(saveDisplayConfig)` lo escribía en `display.json` y el brillo
    real quedaba **borrado**. Reproducido con un A/B: brillo 73 → la franja aplica 80 → apagar dentro →
    arrancar fuera = monitor a 80 y `"brightness":0.8` en disco, cada vez ("el brillo vuelve obligatoriamente
    a 80"). Es el mismo patrón que el bug de Bluetooth de arriba: **estado que debe sobrevivir al proceso
    viviendo en RAM, y un valor impuesto por el sistema adoptado como si lo hubiera elegido el usuario.**
    Con el apunte en disco la restauración pendiente **se cobra en el siguiente arranque**, y de paso se cae
    la limitación conocida (reiniciar AGS *dentro* de una franja ya no pierde el brillo previo ni re-aplica
    la franja encima de un ajuste manual: la `key` ya coincide). Ojo al tocar la rama de salida: va **detrás
    de `brightnessSupported`**, porque sin backend la restauración se perdería en el vacío *y* borraría el
    apunte, que es lo único que recuerda el brillo real.
  - **La luz nocturna NO comparte este fallo, y no es casualidad**: no deja residuo. Es un proceso
    (`hyprsunset`) que al apagar el PC simplemente deja de existir, así que "restaurar" es no arrancarlo —
    por eso su canal **no necesita apunte**, ni siquiera para "Apagar". La franja tampoco pisa
    `nightLightTemp` (son canales separados en `baseTemp()`). Si algún día se persiste algo suyo, el
    candidato sería `nightDismissed`, que hoy es por sesión a propósito.
  - **"Apagar" (`temp: 0`) no es redundante con "No cambiar" (`temp: null`), y la diferencia está entera
    en `baseTemp()`.** `null` no entra siquiera en la resolución del canal (`activeRuleFor` lo salta), así
    que manda el interruptor manual; `0` sí es una regla vigente —puede ganar un solape como cualquier
    otra— y devuelve `null` **sin caer al manual**, o sea que lo pisa mientras dure la franja. Ese fallback
    es el error fácil al tocar esto: con él, "Apagar" se comportaría exactamente como "No cambiar" y la
    opción no serviría de nada. Es lo que permite "de 9 a 18 apagada aunque la deje encendida a mano", que
    antes no se podía expresar. Sigue por debajo del override manual de QS (encenderla a mano dentro de una
    franja que apaga funciona, y caduca al cambiar de franja). Ojo con `normalizeRules`: el `0` del formato
    **viejo** era un terminador de la cadena de puntos de cambio, no un "apagar", y se sigue leyendo así
    (`tempLegacy`) — si no, cada terminador migrado se convertiría en una franja que apaga a la fuerza.
  - **Pausa por juego (`pausaLuzNocturnaJuegos`, Ajustes > Juegos > Pantalla; activada por defecto, como congelar tareas).**
    Con la preferencia activa, mientras `clientesJuego` (el registro de `servicios/juegos/`) no esté
    vacío, `baseTemp()` devuelve `null` **antes de mirar nada más**: la pausa no es otra fuente de
    temperatura sino un **veto** sobre las tres (franja, manual y el "Apagar" de una regla). Al cerrar el
    juego, la suscripción a `clientesJuego` reconcilia y vuelve lo que tocara — no hay nada que reencender.
    Tres decisiones que parecen detalle y no lo son: (1) se mira que el juego **exista**, no que tenga el
    **foco**, al revés que `lib/gaming-gate.sh` — con el foco, cada alt-tab al navegador teñiría la pantalla
    de naranja y lo quitaría al volver, y el usuario pidió "hasta que salga del juego", que es la vida de la
    ventana; (2) tocar la luz **a mano** durante la partida levanta la pausa hasta que el juego cierre
    (`pausaJuegoIgnorada`, por sesión, disparada desde `claimNightOverride`) — sin eso el interruptor de QS
    y el slider de temperatura no harían nada mientras juegas, exactamente el bug que `nightOverrideKey`
    arregló para las franjas; y (3) `initDisplayService` **se suscribe a `clientesJuego` pero NO llama a
    `iniciarRegistroJuegos()`**: corre al importar QuickSettings (t=0) y arrancar ahí el registro metería el
    parseo de los ~161 `.desktop` en el pintado inicial, que es justo lo que `app.ts` aparta a los 4 s. Con
    `escanerJuegos` apagado la lista está vacía para siempre y la pausa no se dispara nunca, así que su
    tarjeta se retira de Ajustes igual que la de congelar tareas. Se ve en la UI: `luzPausadaPorJuego` pinta
    un renglón en Ajustes > Pantallas, **fuera** del `visible` del horario (la pausa también retiene la luz
    encendida a mano, sin ninguna regla de por medio) — sin él la función sería invisible justo al actuar.
  - **La otra mitad de la pausa es una LISTA MANUAL de clases de ventana** (`pausaLuzNocturnaApps`,
    debajo del interruptor). Existe para lo que el detector no reconoce como juego —un emulador, un
    juego sin `.desktop`, un launcher propio— y **no depende de `escanerJuegos`**: compara clase contra
    clase, así que funciona con la detección apagada; por eso la tarjeta entera **no** se retira sin
    escáner (solo se avisa de que queda la lista), al contrario que la de congelar tareas. Su contrato es
    el mismo que el de los juegos —**mientras la ventana esté ABIERTA**, no en foco ni a pantalla
    completa—, lo que la convierte en un arma cargada: apuntar ahí el navegador deja la luz nocturna
    apagada el día entero, y el texto de ayuda lo dice con todas las letras. Tres piezas compartidas, no
    tres copias: la comparación es `servicios/ventanas/coincidenciaClases.ts` (pura y con test; también
    la usa ya `matchesFullscreenApp` del auto-DND, que le añade el requisito de pantalla completa), la UI
    es `modulos/ajustes/componentes/ListaClasesVentana.tsx` (el mismo widget del No molestar automático,
    con `preferirPantallaCompleta` para su botón "Ventana"), y el formato en `preferences.json` es el de
    `autoDndFullscreenApps` (subcadenas en minúsculas, `sanitizeApps`). **Una entrada vacía no casa con
    todo**: es el modo de fallo de `includes()` y está cubierto por el test — un espacio suelto en el JSON
    dejaría la luz retenida para siempre.
  - **El disparador de esa mitad NO puede ser `clientesJuego`** (una app de la lista no es un juego, así
    que no lo mueve): es `revisionVentanas`, que el registro emite en cada alta, baja, fullscreen y
    **cambio de foco** — y con `follow_mouse = 1` eso es cada vez que el puntero cruza de una ventana a
    otra. Por eso la suscripción compara contra un espejo (`ultimaAppQuePausa`) y solo reconcilia cuando
    el resultado cambia; con la lista vacía —el caso normal— ni siquiera le pide los clientes al
    compositor. Es el mismo cuidado que documenta el `<For>` de `Escritorios.tsx` unas líneas más arriba.
  - **La UI enseña qué franja rige ahora** (`sp-rule-active-chip` + tarjeta `.active` + la línea
    `Ahora (HH:MM) · luz nocturna: … · brillo: …`), movida por un reloj de 30 s ref-contado que solo vive
    mientras la sección está montada. No es adorno: "¿por qué se ha encendido?" no se respondía en ningún
    sitio, y fue justo así como se destapó lo de las 19:00.
  - **La fila de una franja NO puede reconstruirse al editarla — editarla mataba TODO AGS.** `patch`
    reemplaza el objeto de la regla (el estado es inmutable) y `<For>` indexa por **identidad de objeto**:
    objeto nuevo = clave nueva = tira la fila y construye otra. O sea que cada edición destruía **el editor
    que estabas usando**. Y como `commit` cuelga del `leave` del campo (así es como se edita de verdad:
    tecleas la hora y pasas al minuto), eso destruía el `Gtk.Entry` con el foco **desde dentro de su propio
    handler de foco**, con GTK a mitad del cambio: el método de entrada de Wayland se quedaba apuntando al
    widget ya liberado y el siguiente evento reventaba en `wl_proxy_get_version` → **SIGSEGV, se cae el
    shell entero**. Reproducido y arreglado montando la sección real con los binarios stubbeados. Es una
    **carrera** con el evento de text-input del compositor, así que no es determinista y por eso parecía
    caprichoso — el modo de fallo era "se cierra solo al tocar las franjas". Medido sobre el código viejo:
    salir del campo petaba 2 de cada 3 veces, y pulsar Enter 1 de cada 3 (menos, pero petaba: no hay ruta
    "segura", el fallo es destruir la fila al editarla). Hoy `<For>` lleva
    `id={ruleKey}`, una identidad **de sesión en un `Symbol`**: el spread de `patch` lo copia (la fila
    sobrevive a la edición) pero `JSON.stringify` lo ignora, así que no ensucia `display.json` ni obliga a
    tocar la lógica pura de `schedule.ts`. Consecuencia obligatoria: si la fila ya no se reconstruye, **no
    puede leer sus valores del `rule` capturado** — ese se queda en el pasado en la primera edición. Todo lo
    que se enseña cuelga de `cur` (`nightRules()[index()]`), `activeChannels` compara identidad contra el
    objeto **vivo**, y `NumberField` es reactivo: sin eso, poner 4000 K → "No cambiar" → "Encender a" deja la
    regla en 3500 con el campo enseñando 4000 (A/B). De paso se arregló que editar te tirara el foco del
    campo en cada cambio. **Los derivados de la fila van por `createMemo`, no por `cur((r) => …)`**, y no es
    optimización: `createComputed` no compara valores y `cur` produce un objeto nuevo en cada edición, así
    que tocar la hora reemitía `nightMode` con el mismo `"on"` → se reconstruían las opciones del
    desplegable (su `<For>` también va por identidad) → volvía a haber destrucción de widgets en cada
    tecleo, y con ella el segfault (medido: ~1 de cada 4 ediciones con Enter; 0/8 con memo).
- `modulos/notificaciones/` — notification daemon integration. `store.ts` is the public facade; `estado/` holds shared state and persistence; `NotificationPopup` (transient) and `NotificationPanel` (history) are separate windows. `settings/SettingsWindow.tsx` is the in-shell settings UI. Sub-packages: `panel/` (panel composition and notification items), `popup/` (popup presentation, stack, layout and burst control), `procesamiento/` (single ingestion path), `daemon/` (D-Bus ownership checks), `rules/` (pure rule engine — match, dedup, template, validate, tested by Node), `history/` (persistence logic, tested), `cleanup/` (rule-driven background cleanup engine, tested), `autoDnd/` (auto "No molestar": a single in-shell watcher — `watcher.ts`, started once via `initAutoDnd()` in `app.ts` — that flips `notifd.dontDisturb` while a game runs or a user-configured app is fullscreen; `detect.ts` is the pure predicate, tested — el watcher le **inyecta** `isGameClient` por el parámetro `isGameFn` de `shouldSilence`, para que el detector con evidencia no rompa la pureza del módulo; y "fullscreen" aquí significa el modo 2, no maximizado). La lista de clases que configura el usuario **ya no es propia de aquí**: la comparación es la compartida `servicios/ventanas/coincidenciaClases.ts` (`matchesFullscreenApp` solo le añade el requisito de pantalla completa) y la UI es `modulos/ajustes/componentes/ListaClasesVentana.tsx`, las dos a medias con la pausa de la luz nocturna al jugar. **Skin dunst para las notificaciones del sistema — lo aplica una REGLA, no el hint.** Los `notify-send` de `hypr/scripts/` llevan `-h string:x-gigios-source:system`; `procesamiento/ingesta.ts` lo lee (con `hints.lookup_value()` de esa clave suelta — **no** con `extractHints()`, que hace `recursiveUnpack()` de todo el `a{sv}` y con un `image-data` materializaría los píxeles en crudo por cada notificación) y lo mete **en `NotifInput.source`, antes de evaluar**, además de guardarlo en `StoredNotification.source`. El motor sabe casar por él (`match.source`, `MatchSpec`), y la builtin **`builtin.system-dunst`** (`defaults.ts`: `source equals "system"` → `style: "dunst"`, prioridad 10, **sin `stopOnMatch`** para no tapar a `builtin.low-battery` y compañía, que también casan con notificaciones de scripts) es la que pide el skin. El efecto es `style: "default" | "dunst"` (`PopupStyle`), plegado en `engine.ts` con el mismo `setOnce` que `color` y horneado en `meta.style`; en el editor es el segmento "Estilo del popup" (— / shell / dunst), donde `—` = "la regla no opina", que **no** es lo mismo que `shell`. `ElementoPopup` (`popup/ElementoPopup.tsx`) hace `meta.style === "dunst"` y punto: **no mira el hint como fallback, a propósito** — si lo hiciera, desactivar la builtin desde la UI no quitaría el skin y el interruptor sería mentira (hay test). Por eso `"default"` tampoco puede colapsarse a `undefined` en el fold: es lo que permite a una regla de usuario **sacar** del skin a algo del sistema (y `"dunst"`, metérselo a una app normal). El skin reproduce el `/etc/dunst/dunstrc` **por defecto**: esquinas rectas, marco 3 px, monoespaciada, fondo sólido por urgencia (`#285577` / `#900000`+marco `#ff0000` / `#222222`) y **sin nombre de app ni icono** (el `format` de dunst es `"<b>%s</b>\n%b"`). El `css` inline del popup normal (borde izquierdo, tinte del icono) **se anula** ahí: inline gana al stylesheet y rompería el marco. Solo afecta al **popup**.

**En la vista AGRUPADA, cualquier notificación reconstruía TODOS los grupos — y con ellos el plegado.** `agruparNotificaciones()` (`panel/ListaAgrupada.tsx`) fabrica objetos `{appName, notificaciones}` **nuevos** en cada emisión del almacén, así que con el `<For>` sin `id` (indexa por identidad de objeto) una notificación de Discord tiraba y rehacía también el grupo de Firefox con todas sus filas. Lo caro era lo de menos: `plegado` es un `createState` **local del grupo**, de modo que cualquier notificación reabría los grupos que hubieras plegado. Va indexado por `appName`, y `GrupoAplicacion` recibe sus notificaciones como **`Accessor`**, no como array fijo — junto con el contador, la insignia de no leídas (ranura fija con `visible`, antes un `noLeidas > 0 && …`) y la lista interna. Medido con el panel abierto: **3 notificaciones = 18 construcciones de grupo antes, 0 después**; y verificado que la insignia sube y la fila nueva aparece sin reconstruir nada.

**Lo que NO se ha tocado del mismo patrón, y no es un olvido**: en `ListaPlana` (y en el `<For>` interno de un grupo) el cambio de identidad **es el mecanismo de refresco** — `markRead()` sustituye el objeto de esa notificación en el almacén, y eso es justo lo que hace que su fila se vuelva a pintar como leída; ponerle `id` la congelaría. Las pestañas de ajustes (`RulesTab`, `HistoryTab`, `AppsTab`, `AppFilterBar`) reciben strings o objetos que solo cambian al editarlos. Los popups no usan `<For>`: la pila los añade y quita a mano.

**Acciones D-Bus en el popup (`notify-send -A`) — el clic derecho las ejecuta.** `ElementoPopup` no las pintaba: en `NotificationPopup.tsx` la palabra `action` solo aparecía en un `actions: []`. O sea que **todo `-A` era invisible e impulsable**, y llevaba años así — el botón "Lanzar aislado" de las alertas de ejecutable nuevo (`oom-monitor.sh`) nunca se pudo pulsar. Y no había escapatoria por el historial: lo que sale de `hypr/scripts/` casa con `builtin.system-dunst`, y `shouldIndex()` no indexa lo que ya gestiona una regla (ver el peaje, abajo) → la acción estaba muerta en los dos sitios a la vez. Hoy: el popup **se engancha al gesto que ya existía**, el `Gtk.GestureClick` de `button: 3`, que hacía `focusAppWindow()` — inútil para un script, cuyo "app" no es una ventana, así que ese gesto estaba libre justo donde hacía falta. Ahora, **si hay acción la invoca; si no, sigue enfocando la ventana** (no se pisan: son excluyentes en la práctica). Tres detalles que no son adorno: (1) se **invoca antes de `dismiss()`** — `dismiss` cierra la notificación en el daemon y luego `get_notification(id)` ya no la encuentra; (2) hay una **pista visible** (`▸ clic derecho · <label>`, clase `.notif-popup-action-hint`, con override en el skin dunst porque su fondo sólido se come el violeta del tema): un botón que funciona pero que nadie sabe que existe es el mismo bug otra vez, y por eso se aparta a sabiendas del `format` por defecto del dunstrc; (3) **el popup ES la acción** — `_removeImmediate` no cierra la notificación en el daemon, pero se lleva el widget, y sin historial no queda dónde pulsar, así que los 5,5 s fijos de `POPUP_TIMEOUT_MS` no daban ni para leer «¿reparo el pendrive?». `calcularDuracionPopup()` (`popup/logica.ts`) respeta el `-t` de quien la mandó **si trae acciones o si viene del sistema**, con techo común (`DURACION_MAXIMA_POPUP_MS`, 60 s: en el spec `-t 0` es "no expira nunca", y un popup clavado para siempre no es opción) y dos suelos: **20 s con acciones** (`DURACION_POPUP_CON_ACCION_MS`) y **10 s para las del sistema sin botón** (`DURACION_POPUP_SISTEMA_MS`, o sea `source === "system"`, el mismo hint `x-gigios-source:system` que activa el skin dunst). Este segundo suelo existe porque esas notificaciones son el **desenlace de una función del equipo** —«Volumen reparado», «No se pudo reparar», el resultado de un análisis— y con 5,5 s no daba tiempo ni a leerlas, aunque el script pidiera `-t 20000`: el `-t` se ignoraba entero sin acciones. El suelo **no puede colgar de la urgencia** (`usb-repair.sh` manda su «Reparando…» con `-u low`) ni del skin (`meta.style`), que es desactivable desde la UI y dejaría la duración atada a una decisión cosmética. Los demás orígenes —incluidas las alarmas del reloj, que usan `x-gigios-source:alarm` a propósito— conservan sus 5,5 s intactos. Requiere `expireTimeout` en `StoredNotification` (lo rellena `procesamiento/ingesta.ts` desde `n.expire_timeout`). **Los tres valores son ahora ajustables y cada aviso puede fijar el suyo.** Los suelos por familia (normal / sistema / con acciones) viven en `preferences.json` (`popupDuracionNormalMs`, `popupDuracionSistemaMs`, `popupDuracionAccionesMs`, acotados a [1 s, 60 s]) y se editan en Ajustes > Notificaciones > **General**; `calcularDuracionPopup()` los recibe **por parámetro** desde `popup/pila.ts` para seguir siendo puro y con test. Por encima de todo eso está el efecto de regla **`popupMs`** (`EffectSpec` → plegado con `setOnce` → horneado en `meta.popupMs` al ingerir, como `color` y `style`), que es lo que hace que «este aviso concreto, 3 s» sea posible: **gana a los suelos de familia y al `-t` del emisor**, y solo se le aplica el acotado a [1 s, 60 s]. Se edita en el campo "Duración del popup" de `RuleEditor`, o sea tanto en una regla de usuario como en **cada aviso del catálogo** desde la pestaña Sistema. Los avisos de pura confirmación del catálogo (`usb.conectado`, `wifi.reconectado`, `temperatura.*-normal`, `grabacion.guardada`, …) ya vienen con `popupMs: BREVE_MS` (3 s) de fábrica: no hay nada que leer entero en ellos y los 10 s del suelo del sistema solo tapaban pantalla. **Se lee al programar el descarte, no se resuscribe**: cambiar la duración en Ajustes afecta a los popups siguientes, no al que ya está contando en pantalla.

**Editar una notificación desde el propio panel (clic derecho > 󰏫).** El menú lateral de la tarjeta (`panel/item/AccionesLaterales.tsx`, el que revela el `GestureClick` de `button: 3`) lleva un botón que abre la ventana de ajustes **ya dentro del editor de esa notificación**, sin pasar por «Detectadas» ni buscarla en ninguna lista. El puente es `settings/edicionDirecta.ts`: un `createState<NotifRule | null>` que `SettingsTabs` consume por encima de la barra de pestañas — mientras hay edición pendiente **no se pinta ninguna pestaña**, y al cerrar se vuelve a la que estuviera activa (por eso el árbol de pestañas se construye con una FUNCIÓN y no con una constante: `<With>` destruye el hijo anterior y un árbol guardado en una variable ya no se puede volver a colgar). **Qué editor se abre depende de qué gestiona ya esa notificación, y el orden importa**: (1) si trae `x-gigios-event` del catálogo → su entrada de la pestaña Sistema (se guarda en `notif-sistema.json`); (2) si ya casa con una regla de usuario o predefinida → **esa** regla —`meta.matchedRules` viene ordenado de mayor a menor prioridad, así que la primera que no empiece por `sistema.` es la que manda—; (3) si nada la gestiona → una regla nueva prerrellenada con app + título + cuerpo, igual que el botón "Crear regla" de «Detectadas». Saltarse ese orden y abrir siempre "lo nuevo" haría que el usuario creara una segunda regla compitiendo con la que ya tenía, que es justo el lío que el botón evita. El estado se limpia al cerrar la ventana (`notifSettingsVisible.subscribe`), o los siguientes ajustes se abrirían dentro de un editor viejo.

**«Detectadas» tiene tope 100 y botón de vaciado.** `HISTORY_CAP` bajó de 500 a **100** (`history/historyLogic.ts`): FIFO por recencia — `trimByRecency` ordena por `lastSeen` y corta, así que al llegar la 101 se cae la más antigua. Con 500 la pestaña se llenaba de avisos de hace semanas entre los que había que ir a buscar el de esta mañana, y como una entrada **desaparece sola** en cuanto se le crea una regla, lo que sobrevive ahí es exactamente lo que aún no se ha decidido: una cola corta es lo útil. El botón «Borrar historial» (`clearHistory()` en `history/historyStore.ts`) vacía **solo** `notif-history.json` — ni reglas, ni las notificaciones del panel (`notifications.json`), ni la configuración de los avisos del sistema (`notif-sistema.json`), que además nunca están en esta lista porque el catálogo les genera una regla a todos y el historial solo indexa lo que **no** casa con ninguna. Borra en **dos pulsaciones** (la segunda es la confirmación, clase `.re-delete.confirm`) y no en un diálogo modal.

**Con DOS o más acciones el popup pinta botones; con una sigue bastando el clic derecho.** El
reparto lo decide `resolverAccionesPopup()` (`popup/logica.ts`, puro y con test) y devuelve
`{principal, botones, mostrarPista}`. Con una sola acción no cambia nada de lo anterior: pista de
texto y gesto. Con dos o tres (mismo tope que el panel) sale la fila `.notif-popup-actions` y **la
pista se apaga**, porque repetiría la etiqueta del primer botón; su papel lo hereda ese botón, que
lleva `.principal`, el prefijo `▸` y el tooltip «También con clic derecho». **La primera acción
visible sigue siendo la principal y la del clic derecho, y es la misma que el primer botón** — hay
un test que fija esa coincidencia: si discreparan, el popup ofrecería dos caminos idénticos con
efectos distintos. El caso de uso que lo motivó es el USB, que hoy manda `-A open` (abrir en
Dolphin) **antes** de `-A eject` precisamente porque la primera es la del gesto.

**La fila de acciones necesita una barrera de propagación, y no es opcional.** Los tres gestos de la
tarjeta (botón 1 abre el panel, 2 descarta, 3 acción principal) cuelgan de la caja y están en
BUBBLE, así que `GtkButton` reclama la secuencia y el clic izquierdo sobre un botón nunca llega al
«abrir panel». Lo que eso NO cubre: el clic sobre el *padding* de la fila, y el clic central o
derecho sobre un botón (el gesto interno de `GtkButton` es solo del botón primario y no reclama
nada) — en ambos casos el clic acabaría abriendo el panel o disparando la principal desde una zona
que visualmente es de las secundarias. De ahí un `Gtk.GestureClick({button: 0})` en la fila que hace
`set_state(CLAIMED)`. **En BUBBLE, no en CAPTURE**: en CAPTURE se adelantaría a los botones y los
dejaría muertos.

**El título del popup se cortaba SIEMPRE a mitad de ancho, y la culpa era de `maxWidthChars`.** Con
28 la elipsis caía ahí hubiera sitio o no, porque `maxWidthChars` tapa el ancho natural de la
etiqueta y GTK nunca le ofrecía más. Son **50** (los 336 px útiles del popup entre los ~6,6 px/car.
de MesloLGS, que es monoespaciada). Para que ese 50 no se lo coma la misma fila, **el nombre de app
cede primero**: acotado a 12 caracteres se convierte en el hueco más pequeño, y
`gtk_distribute_natural_allocation` reparte el déficit atendiendo primero al más pequeño, así que el
resto va íntegro al título. Se prefirió eso a que el título envuelva: la fila es de una línea por
diseño y envolver descuadraría el alto que mide la pila. **El panel tenía el mismo bug por otra
vía**: `notif-app-name` no llevaba `maxWidthChars`, pedía su ancho natural completo y se repartía el
déficit *a medias* con el título; acotado a 14 (con `tooltipText` para no perder el nombre), el
`notif-summary` se queda con todo lo que sobra sin necesitar tope.

**El pestañeo al apilar popups lo causaba HYPRLAND, no un re-render de GTK.** Síntoma: al llegar un aviso nuevo, los que ya estaban en pantalla parecían desaparecer y volver a dibujarse. La pila es imperativa a propósito (`popup/pila.ts`: mapas por id, `drenarCola()` solo hace `append` y no toca los widgets vivos), así que el sospechoso obvio —reconstruir la lista— estaba descartado desde el principio. La causa real es que los N popups son **una sola superficie layer-shell**, que crece al apilar (medido: 51 px → 110 px), y Hyprland **anima ese cambio de tamaño**: mientras dura, el buffer nuevo se escala dentro de una caja que todavía está creciendo, así que los avisos ya visibles se encogen y vuelven. Medido con `grim` sobre el rectángulo del popup de arriba mientras llega el siguiente: con la animación de capas activa la media del recorte se mueve ~150 ms; con `animation = layers, 0` es constante bit a bit. Se arregla con un `hl.layer_rule{ no_anim = true }` en `hypr/gigios/reglas.lua` — **no** tocando este código.

**Eso obligó a darle `namespace` a la ventana**, y es la parte reutilizable: una `<window>` de AGS sin `namespace` explícito se anuncia al compositor como **`gtk4-layer-shell`**, el genérico, y ahí no hay `layerrule` que valga (la casarían todas a la vez, incluida la barra). `name` **no** vale para esto: es el identificador de `app.get_window()`, no el del protocolo. `Orion`, `QuickSettings`, `NotificationPanel` y `OSD` ya lo ponían — sus reglas de blur dependen de ello —; `NotificationPopup` no, y por eso era inalcanzable. Se comprueba con `hyprctl layers`: si sale `ns=gtk4-layer-shell`, la ventana no tiene namespace propio y ninguna regla suya funcionará **en silencio**.

**Peaje conocido y aceptado**: al ser una regla, todo lo que sale de `hypr/scripts/` **queda fuera del historial** — `shouldIndex()` solo indexa lo que no casa con ninguna regla (la pestaña es "Detectadas"). Se eligió así para tener la regla visible y desactivable desde la UI. La alternativa, si algún día molesta, es refinar `shouldIndex` para que una regla **puramente cosmética** (solo `style`/`color`) no cuente como "gestionada". Lo que ese peaje costaba de verdad —que un aviso del sistema no tuviera dónde configurarse— lo resuelve hoy la pestaña **Sistema**, que no depende del historial en absoluto (ver justo abajo).

**El botón "editar" no abría NADA en ninguna pestaña, y la culpa era un `<>` dentro de otro `<>`.** `CamposReescritura` devolvía un Fragment cuyos hijos eran, uno por campo, otro Fragment (`CAMPOS.map(() => <>…</>)`). `Fragment.append` lanza `nesting Fragments are not yet supported`, así que **la construcción entera de `RuleEditor` reventaba** — y como el editor se monta desde un `<With>`, que **quita el hijo anterior antes** de llamar a `mkChild`, el resultado era la pestaña en blanco: sin editor, sin lista y sin error a la vista (lo traga el efecto). Afectaba a las cuatro rutas que abren el editor (Apps, Sistema, Detectadas, Reglas), que es lo que lo hacía parecer un fallo "general" de Ajustes y no de un componente concreto. Hoy cada campo va en su propia `<box>`. **Es el mismo trampa que documenta `SettingsPanel.tsx`** y se repite en cuanto un componente devuelve `<>` y alguien lo mete dentro de otro `<>` o lo devuelve desde el hijo de un `<With>`: `<With>` **también** devuelve un Fragment, y por eso el `<With>` interno de `HistoryTab` (el que distingue "historial vacío" de "otro daemon tiene las notificaciones") iba envuelto en una `<box>` — devuelto a pelo dejaba la pestaña vacía justo en el caso vacío, que es cuando se mira. Regla práctica: **un `<>` o un `<With>` solo puede colgar de un widget de verdad**, nunca de otro Fragment.

**El historial se ordenaba de rebote, solo al desbordar el tope.** `trimByRecency` devuelve el array **tal cual** mientras quepa en `HISTORY_CAP`, y `upsertEntry` insertaba al final, así que: por debajo de 500 entradas la pestaña "Detectadas" se leía **al revés** (orden de alta, lo más viejo arriba), y ya en el tope una notificación **repetida** se quedaba enterrada donde se vio la primera vez — justo la que acabas de recibir y vienes a buscar. Ahora `upsertEntry` inserta **al frente** (nueva o repetida) y `historyStore` ordena **al cargar** (`sortByRecency`), porque los ficheros ya guardados solo estaban ordenados por casualidad. Además la fila enseña **`×N` y la hora relativa** (`getRelativeTime(lastSeen)`): sin eso una repetición no daba ninguna señal de haberse registrado — la fila era idéntica a la de la primera vez y parecía que el historial no guardaba. Por lo mismo su `<For>` **sigue sin `id`**: la identidad del objeto es el mecanismo de refresco (`upsertEntry` sustituye la entrada), y con `id={dedupKey}` la fila se congelaría en los valores del primer avistamiento.

**`cleanHistory()` solo corría con la ventana propia.** Colgaba de `notifSettingsVisible` (el engranaje de la cabecera del panel de notificaciones), pero la misma pestaña se abre desde **Ajustes > Notificaciones**, que va por `settingsPanelVisible` y no dispara nada. Consecuencia: "Detectadas" enseñaba entradas que **ya casan con una regla**, empezando por la que acabas de crear desde ahí mismo, que se quedaba en la lista como si no hubiera pasado nada. `HistoryTab` llama ahora a `cleanHistory()` al montarse y al volver del editor; la suscripción de `historyStore` se queda para la ventana propia.

**CADA notificación del sistema es editable por separado: el hint `x-gigios-event` y el catálogo.** El `source` dice *qué clase* de notificación es, no *cuál*: los ~100 avisos de `hypr/scripts/` compartían hint y, en 44 de las llamadas, también `app_name` (`"notify-send"`, porque no pasaban `-a`). Vistos desde el motor, «USB desconectado», «Disco casi lleno» y «Escalada de privilegios» eran **la misma cosa**, y el único gancho para separarlos era el título — que cambia con el contenido (`"RAM muy baja: 812MB disponibles"`) y con cualquier retoque de redacción. Configurar uno solo exigía escribir a mano una regla con un `contains` frágil, y para varios ni eso servía porque comparten prefijo. La identidad la da ahora **`hypr/scripts/lib/notif.sh`** (`notificar <id> …`, que añade `-h string:x-gigios-event:<id>`); `ingesta.ts` lo lee con el mismo `lookup_value()` que el origen y lo mete en `NotifInput.event` **antes de evaluar**, además de guardarlo en `StoredNotification.event`. Piezas:
- **`rules/catalogoSistema.ts`** — la LISTA de avisos (id, nombre, categoría, fichero que lo emite, efectos por defecto). Existe porque el hint solo sirve para *casar*: sin lista, Ajustes no podría enseñar un aviso que aún no se ha disparado nunca, que es justo el que interesa dejar ajustado de antemano (nadie quiere esperar a que le falle un disco para decidir cómo avisa). **Al añadir un aviso a un script hay que darlo de alta aquí**; si no, funciona igual pero no sale en Ajustes. `catalogoSistema.test.ts` comprueba ids únicos, formato válido, categorías conocidas y que no falte ni sobre traducción — no que la lista esté completa, que eso no lo sabe TypeScript.
- **`rules/sistemaStore.ts`** — la configuración del usuario, en **`~/.config/gigios/notif-sistema.json`**, un fichero aparte de `notif-rules.json` y con formato mínimo: `{version, eventos: {"<id>": <EffectSpec>}}`. Aparte porque el `match` de estos avisos es siempre el mismo (`event equals <id>`) y ya lo fija el catálogo: meterlos en `notif-rules.json` habría repetido cien veces el mismo `match` y enterrado las cuatro reglas personales entre cien entradas generadas. **Una entrada REEMPLAZA los defaults del catálogo, no se fusiona con ellos** — es lo que hace el fichero legible a mano (lo que se lee es lo que se aplica); fusionar habría necesitado un centinela para "quítame este campo", porque `lifetime` es una cadena y omitirla no se distingue de anularla en un merge. El precio, aceptado: un aviso personalizado se queda anclado a los defaults del día en que se tocó, y "Restaurar" lo devuelve al catálogo actual.
- **`compileRules` tiene un índice `byEvent`** además del `byApp`. Son ~100 reglas y en `rest` cada notificación las habría probado todas una a una; con el índice, una notificación **sin** identidad ni siquiera las mira. Una regla con `event` **y** `app` se indexa por `event` (más selectivo) y su `test` sigue comprobando el `app`, así que no se pierde ninguna condición. Prioridad **150**: por encima de las builtin (10..50) y del 100 por defecto de una regla de usuario —apuntar a UN aviso es más específico que cualquier `contains`— pero sin techo, para que una regla de usuario con prioridad alta pueda imponerse a propósito.
- **UI**: `settings/SistemaTab.tsx` (fila por aviso, agrupadas por categoría, con buscador que mira nombre **e id**) y el propio `RuleEditor`, que reconoce `source: "system"` y esconde el nombre y todo el bloque "Cuándo aplica" — editar ese `match` apuntaría a otro aviso o a ninguno. **El interruptor "Activa/Inactiva" tampoco se pinta ahí**: en un aviso del sistema la regla existe siempre (la genera el catálogo), así que desactivarla no significaría "no me avises" sino "ignora tu propia configuración". Lo que silencia es el efecto `suppress`. Y `RulesTab` **filtra `source !== "system"`**: sin eso las cien entradas entierran lo que esa pestaña existe para enseñar.
- Las builtin que casan por TEXTO (`crash`, `coredump`, `reboot`, `batería`) siguen en `defaults.ts` porque también pescan notificaciones de **apps** que digan eso, pero los avisos del sistema que las motivaron ya no dependen de ellas: cada uno lleva su `clearOnBoot`/`flash` en el catálogo, atado a su id en vez de a una palabra que cualquiera puede escribir en un título.

`procesamiento/ingesta.ts` is the single ingestion point that runs rules on every incoming notification — lo llama **solo** el handler de `notifd.connect("notified")` en `NotificationPopup.tsx`, así que si AGS no es el servidor de notificaciones de la sesión, **nada** se almacena: ni historial ni lista activa. Es el fallo que hay que descartar *primero* cuando `notif-history.json` sale vacío, porque desde dentro del código parece que falta una pieza: el sospechoso es un `dunst`/`mako` instalado que **D-Bus autoactiva** y le roba `org.freedesktop.Notifications` a `AstalNotifd` antes de que el shell arranque (`busctl --user list | grep org.freedesktop.Notifications` debe dar el PID de `gjs`). Se arregla enmascarando el otro daemon, no tocando este código — ver `docs/SETUP.md` §2. **`daemon/comprobacion.ts` lo detecta solo** (`initNotifDaemonCheck()` en `app.ts`, tras `NotificationPopup`, que es quien construye el `AstalNotifd`): compara el dueño del nombre contra el nombre único de nuestra conexión, y si no somos nosotros publica `notifDaemonConflict` `{pid, comm}` → `daemon/BannerConflicto.tsx` reemplaza el "Historial vacío" (`HistoryTab`) y el "Sin notificaciones" (`NotificationPanel`) por el culpable + el comando de arreglo, más un `notify-send` crítico **que pinta el propio intruso** (es el único canal que el usuario mira: el `CRITICAL` que Astal ya emite —`cannot get proxy: dunst is already running`— sale por el stdout de `ags`, que bajo el autostart no llega ni a `hyprland.log` ni al journal). Va suscrito a `NameOwnerChanged`, así que el aviso **se apaga solo** cuando el rival suelta el nombre: `AstalNotifd` queda *en cola* por él y lo toma sin reiniciar AGS (comprobado). **Persistence stays on JSON deliberately** (SQLite was evaluated and rejected: both stores are capped — 200 active / `HISTORY_CAP` 500 — the UI needs them fully in memory anyway, parse+stringify measures ~0.3 ms, and GJS has no SQLite binding, so the only cheap route would be forking the `sqlite3` CLI per write, which costs *more* than the file write). Both stores debounce 1.5 s and then go through `estado/persistencia.ts` → `saveJsonAsync()`, which writes off the main loop with `replace_contents_bytes_async` (**not** `replace_contents_async` — that one doesn't retain the buffer, so GJS's GC can free it mid-write). The 200 cap is applied **in memory in `procesamiento/ingesta.ts`**, not just when serializing: capping only at save time bounded the file but let the in-memory array grow all session; evicted entries get `disposeConditions()`d like the dedup path does.
- `modulos/orion/` — **the "Jarvis" launcher** (the user calls it "jarvis"; the code dir is `orion`). Bottom-slide panel with tabs, search, and sections. Toggle: `SUPER+ALT+Space`. `state.ts` holds its `SectionId` union and reactive state; `components/sections/` holds each section; `search/` is the fuzzy-search engine; `ProfileManager.ts` persists sessions.
  **Todo lanzamiento de app pasa por `data/launch.ts` (`launchApp`), no por `sh -c` a pelo.** Los
  cuatro sitios que abren apps (Apps, Inicio, buscador y el panel derecho, que reciben el `launch`
  como closure) hacían cada uno su propio `execAsync(["sh","-c",exec])`, y por eso las apps abiertas
  desde Orion aparecían en el escritorio donde estuvieras al terminar de cargar y no en el que las
  lanzaste — al revés que rofi, que sí ancla desde hace tiempo. `launchApp` delega en
  `hypr/scripts/lanzar-anclado.py`, que lanza con `hyprctl dispatch exec [workspace N silent] …`
  —la ventana **nace** en su escritorio, no se mueve después— y además observa el socket de eventos
  de Hyprland con el motor compartido `hypr/scripts/anclaje.py` (el mismo de `rofi-launch.py`:
  identidad por la primera ventana nueva, 15 s de observación, rama `urgent` para single-instance).
  La regla cubre **solo la primera ventana** (medido), así que el observador sigue siendo la red de
  los splash y los multiventana. Detalle en el `CLAUDE.md` raíz.
  **El panel derecho (`components/shell/RightPanel.tsx`) puede DESINSTALAR la app**, además de
  abrirla, editar su config y fijarla. Lo que decide y ejecuta es
  `hypr/scripts/desinstalar-app.sh` (pacman/AUR, Flatpak, Steam o borrado de ficheros, con `pkexec`
  para el diálogo gráfico de contraseña); aquí solo hay E/S (`data/uninstall.ts`) y la lectura del
  desenlace (`data/uninstall.parse.ts`, **puro y con test**). Detalle del script en el `CLAUDE.md` raíz.
  - **Es de UN CLIC: no hay pantalla de confirmación.** Hubo una (método, paquete y lista completa de
    lo que `-Rs` se llevaría) y se quitó a petición del usuario; se acepta porque la confirmación
    real es el **diálogo de contraseña de polkit**, que no se puede saltar. Si vuelve a hacer falta,
    el verbo `detectar` del script sigue devolviendo todos esos datos — hoy nadie lo llama desde la UI.
  - **`desinstalar()` APARTA ORION ANTES DE LANZAR NADA, y no es cortesía.** El diálogo de polkit es
    una ventana normal y Orion es una layer-shell **`OVERLAY`**, capa que va por encima de todas las
    ventanas normales por definición del protocolo (y con keymode `ON_DEMAND`, peleando además por el
    teclado): con Orion en pantalla el diálogo salía **debajo** y había que cerrarlo a mano para
    escribir. Cerrarlo antes **no basta** — la salida son ~280 ms de animación más un par de frames
    hasta que la superficie se desmapea —, así que `esperarOrionOculto()` (`data/uninstall.ts`)
    **sondea el estado real de la ventana** (`app.get_windows()`, nombre `orion` + `visible`) en vez
    de dormir una constante copiada de `Orion.tsx`, que se desincronizaría en silencio en cuanto
    alguien la retocara. Techo de ~1 s: si la animación se atasca se sigue adelante, porque lo peor
    que pasa entonces es el comportamiento de antes.
  - **Se aparta con `suspenderPanel()`, NO con `hidePanel()`, y al terminar vuelve donde estaba.**
    Cerrar de verdad es una salida: `finalizarCierrePanel` vacía búsqueda, resultados y panel
    derecho, y la sección regresa a Inicio salvo que el usuario tenga `orionRecordarUltimaSeccion`.
    Correcto cuando cierras tú, **incorrecto cuando Orion se aparta por obligación** — ahí nadie
    pidió salir de ningún sitio. `suspenderPanel()` guarda una foto (sección, origen, consulta,
    resultados, ficha del panel derecho), cierra **sin** `recordarSeccionAlCerrar()` —apuntar la
    sección aquí ensuciaría el "volver a la última" de la próxima apertura de verdad— y
    `finalizarCierrePanel` **corta al principio mientras haya foto**, que es lo que salta la
    limpieza. Tres reglas que no se deducen del código:
    1. **Si el usuario reabre Orion por su cuenta mientras tanto, la foto se descarta sin tocar
       nada**: lo que él acaba de hacer manda sobre lo que había.
    2. **La ficha del panel derecho solo se suelta con `soltarApp`** (tras un `ok`): reponer una app
       recién desinstalada dejaría una ficha fantasma con un «Abrir» que no abre nada. Y si había una
       búsqueda escrita, **se repite la consulta** en vez de reponer los resultados congelados — con
       el catálogo ya invalidado devuelve la lista sin ella, el mismo fantasma que evita
       `data/catalogo.ts` en la rejilla. Tras `cancelado`/`error` se repone todo tal cual.
    3. **`externo` llama a `descartarSuspension()`, no se limita a no reanudar.** Una foto olvidada
       deja `finalizarCierrePanel` cortocircuitado **para siempre** y Orion no volvería a limpiar su
       estado en ningún cierre posterior. `descartarSuspension()` la tira y aplica la limpieza que se
       había saltado, porque a esas alturas sí es un cierre normal.
  - **El fail-safe es al revés que el resto del shell**: `interpretarSalida` trata como `error` todo
    lo que no sea una palabra conocida (`ok`/`externo`/`cancelado`). Dar por buena una salida que no
    se entiende borraría el favorito de una app que quizá sigue instalada. **`externo` (Steam) no
    puede colapsarse a `ok`**: ahí no se ha desinstalado nada todavía —lo decide el usuario en la
    ventana de Steam y no vamos a enterarnos—, así que ni se toca el favorito ni se repone Orion,
    que taparía justo ese diálogo.
  - **El script es el único que notifica el resultado** (`pkexec` tarda lo que tarde el usuario en
    teclear, y para entonces Orion lleva rato cerrado). La excepción es "falta el script": ahí
    notifica AGS, porque si no el usuario se queda mirando un escritorio donde no ha pasado nada.
  - **`AppContextItem` lleva `desktopFile`** porque `pacman -Qoq` sobre el `.desktop` identifica el
    paquete mucho mejor que sobre el binario: un `Exec` con `sh -c`/`env` resuelve al intérprete. Lo
    rellenan los cuatro sitios que abren el panel; los favoritos lo resuelven con
    `Gio.DesktopAppInfo.new(id)` porque guardan el id, no la ruta.
  - **`data/catalogo.ts` existe porque había hasta CUATRO cachés de `.desktop` que no caducaban**:
    `_appCache` en `AppsSection.tsx`, `_cache` en `search/handlers/apps.ts`, `_iconCache` en
    `favoritosFlow.tsx` y (esta sin cachear siquiera) el escaneo de `appResolver.findInGioApps`. Se
    poblaron pensando en un catálogo que solo cambia entre sesiones, cosa que dejó de ser cierta al
    poder desinstalar: sin invalidarlas, la app recién borrada seguía en la rejilla y en la búsqueda
    hasta reiniciar el shell y, al pulsarla, no se abría nada **sin dar ningún error**. Es solo el
    punto de encuentro (y no importa GTK a propósito): así `RightPanel` avisa sin depender de la
    sección ni del buscador, que es lo que habría creado un ciclo de imports entre los tres.
    **`data/appsInfo.ts` es la caché compartida de la lista CRUDA de `Gio.AppInfo.get_all()`** (con
    su propio invalidador registrado aquí): los cuatro sitios de arriba la consumen en vez de
    escanear cada uno por su cuenta, y cada uno sigue quedándose con su propia transformación
    derivada (tiles de `AppEntry`, filas puntuadas, mapa de iconos) porque esas sí son distintas
    entre consumidores. La sección **no fuerza su carga perezosa** al invalidar: repintar una
    sección que el usuario aún no ha abierto pagaría el parseo
    de los ~161 `.desktop` para nada. Un consumidor nuevo del catálogo debe registrarse aquí.
  - **Quien avisa de una INSTALACIÓN es el `Gio.AppInfoMonitor` de `appsInfo.ts`, y sin él el único
    disparador era desinstalar**: o sea, el único cambio de catálogo que Orion provoca él mismo.
    Una app instalada por fuera (pacman, Flatpak, un `.desktop` en
    `~/.local/share/applications/`) no aparecía en la rejilla ni en la búsqueda hasta reiniciar el
    shell, **sin dar ningún error**. Y el monitor tiene una trampa propia, medida con un gjs suelto
    en esta máquina: **`Gio.AppInfoMonitor.get()` creado ANTES del primer `Gio.AppInfo.get_all()`
    no emite nunca** — GLib no vigila los directorios de `.desktop` hasta que alguien los ha
    escaneado una vez. Instalar, modificar y borrar un `.desktop` dio **0 señales** con ese orden y
    **5** con el `get_all()` primero; no falla, se conecta bien y simplemente no llega nada. Por eso
    se arma dentro de `getAppInfos()`, justo después de poblar la caché, y por eso tras invalidar se
    vuelve a llamar a `getAppInfos()` (los consumidores son perezosos: la rejilla no relee si su
    sección nunca se abrió, y ese escaneo es lo que mantiene viva la vigilancia). Los otros dos
    detalles tampoco son adorno: la referencia al monitor vive en el módulo porque sin guardarla
    **se la lleva el GC** y la señal deja de llegar en silencio, y hay rebote de 600 ms porque la
    señal llega en ráfaga (dos avisos por escritura en la prueba).
  - **«Desinstalar» va la última y separada por `.rp-action-sep`, sin rojo en reposo**: es la única
    acción del panel sin vuelta atrás y quedaba a un píxel de «Fijar en inicio», que es trivial y
    reversible. El rojo entra al apuntarla — teñirla siempre convertiría el panel en una alarma
    permanente y, a fuerza de verla, dejaría de significar nada.
  - Tras un `ok` se quita el favorito si lo había: `appResolver` no lo salvaría (buscaría una
    variante del binario y ya no hay ninguna) y quedaría un tile que no abre nada.

  **El fondo del botón activo del índice (`components/shell/SectionIndex.tsx`) no se pintaba al
  abrir Orion, y la culpa es de que `compute_bounds()` NO FALLA sobre un widget sin asignar.** Ese
  fondo no es un `background` del botón —`.section-index-btn.active` lo tiene `transparent` a
  propósito— sino una caja aparte (`.section-index-indicator`) que se desliza por un `Gtk.Overlay`
  con `get-child-position`, o sea que su posición y su tamaño los pone este código a mano. La
  medición devolvía `[true, {origin: -8,-3, size: 16x6}]` **con el botón todavía sin asignar**
  (medido; su `get_width()` era 0 y el de la fila también): la caja CSS a secas, borde y relleno.
  Así que un `if (!valido || width <= 0) return null` da la geometría falsa por buena y el indicador
  se asignaba a **16x6 px en un origen negativo** — no desaparecía, se encogía a una astilla
  invisible, que es justo por qué parecía intermitente y no roto. **Lo único que dice si el widget
  está asignado es `get_width()/get_height()`**, y es la guarda que lleva `medir()` ahora.
  - **Pasaba sobre todo la PRIMERA vez de la sesión** porque a partir de la segunda apertura la
    asignación anterior sigue puesta (la ventana alterna `visible`, no se reconstruye) y la medida
    sale buena en el mismo `map`. Medido: primera apertura, un frame sin geometría y el indicador
    colocado en el tick siguiente; aperturas 2..N, colocado ya en el `map`.
  - De ahí las dos piezas que lo sostienen: `esperarGeometria()` **reintenta por frame**
    (`add_tick_callback`, techo de 90 frames visibles) en vez de rendirse en un único `idle_add`, y
    el `map` recoloca **sin animar**, que además cubre la sección cambiada mientras Orion estaba
    oculto — `preparePanelOpen()` corre ANTES de volver a mostrar la ventana, así que el `subscribe`
    de `activeSection` llegaba con el widget desmapeado y animaba sobre una medida no fiable,
    dejando el fondo bajo el botón anterior.

  **La sección Temas (`components/sections/RiceSection.tsx` + `sections/rice/`) gestiona franjas
  horarias y grupos de fondos.** Cuatro vistas en un `Gtk.Stack` (rejilla, franjas, grupo, fondo).
  Puntos que no se deducen del código:
  - **La rejilla lista ENTIDADES, no ficheros**: un grupo ocupa **una** tarjeta y sus imágenes no
    aparecen además sueltas, igual que en el sorteo — lo que ves es lo que puede tocarte.
  - **Lo que no sale a esta hora se ATENÚA, no se oculta.** Esconderlo dejaría media biblioteca
    invisible de noche sin nada que explicara la ausencia; atenuado se sigue pudiendo aplicar a mano,
    porque el filtro es para el **sorteo**, no una prohibición.
  - **El modo edición es un botón visible (lápiz), no un clic derecho**: un menú contextual salía
    gratis, pero un clic derecho solo vale como atajo si lo que hace se ve (es la lección del
    cronómetro del reloj de la barra: ahí el gesto se conserva, pero con la pastilla teñida, tooltip
    de estado y vuelta atrás con el mismo botón). Entrar en un modo de edición sin ninguna de esas
    tres cosas no cumple nada de eso.
  - **Ninguna de estas vistas usa `<For>`, y no es un olvido**: son listas que se reconstruyen
    enteras al editarlas y `<For>` indexa por identidad de objeto. **Editar una hora o un nombre NO
    reconstruye la lista**: los campos confirman al perder el foco, y reconstruir ahí destruiría el
    `Gtk.Entry` enfocado desde su propio manejador de foco — el SIGSEGV documentado en
    `servicios/pantalla/`. Solo reconstruyen los botones.
  - **`data/wallpaperSchedule.ts` (puro, con test) NO decide qué fondo se aplica**: eso es
    `hypr/scripts/lib/seleccion_fondos.py`, y tiene que seguir siendo el único dueño porque la
    elección también la dispara el arranque de la sesión, en bash y antes de que AGS exista. Aquí se
    reimplementa solo la aritmética cíclica **para pintar** (qué franja rige, qué variante está
    vigente, qué se atenúa) — el peor fallo posible por esa duplicación es una etiqueta equivocada,
    nunca un fondo equivocado. Si tocas la regla de vigencia, tócala en los dos sitios; los casos
    límite están probados en ambos ficheros a propósito.
  - **`wallpapers.json` se escribe SÍNCRONO**, no con el guardado diferido del resto del shell: en
    cuanto se edita, la UI dispara `wallpaper.sh` para enseñar el resultado y ese script relee el
    JSON **desde otro proceso**. Es la misma razón que `saveMonitorPref` → `saveDisplayConfigNow()`.
  - **`loadThumbnails` PODA la caché de todo lo que no esté en la lista que le pasas.** La rejilla le
    pasa la lista completa a propósito; pedir un subconjunto (un chip del editor) sin `podar: false`
    borraría las 41 miniaturas restantes en silencio.
  - El reparto de escritura de `wallpaper.json` sigue igual (bash es dueño de `current`/`currentGroup`,
    AGS de `randomOnStart`), y ahora se **observa con un `Gio.FileMonitor`**: el planificador cambia
    el fondo por su cuenta al cruzar una franja, y sin eso la rejilla seguiría resaltando el anterior.

  Un `execAsync` nuevo con `sh -c` para abrir una app es el modo de fallo aquí: no da error, solo
  deja de anclar. El interruptor es `anclarVentanasRofi` y lo lee el script, no este lado — dos
  lecturas del mismo ajuste podrían discrepar. Si el script falta, `launchApp` cae al `sh -c` de
  siempre: degradar a "se abre sin anclar" es preferible a "no se abre".
- `modulos/calendario/` + `PanelCalendario.tsx` — **panel lateral con dos secciones, `Calendario | Reloj`.** Sustituyó por completo al panel viejo (`CalendarPanel`/`MonthView`/`AgendaView`/`EventDialog`/`store.ts`, borrados), que concentraba dominio, persistencia y widgets en un único `store.ts`. Reparto actual: `dominio/` (tipos, fechas, agenda, validación — **puro y probado con node**), `persistencia/` (esquema versionado, migración y el único fichero que toca GLib), `calendario/` y `reloj/` (widgets), `google/` (OAuth, cliente, mapeo, fusión), y `estado.ts` como la ÚNICA pieza que une dominio con UI.
  - **Las fechas son cadenas `YYYY-MM-DD` y toda la aritmética va por `Date.UTC`.** `new Date("2026-07-21")` parsea como UTC y en Madrid devuelve el día 20 a las 22:00 —así comparaba mal la agenda el store viejo—, y `new Date(y,m,d)` + sumar días salta una hora en los cambios de horario de verano, lo que a las 00:00 es saltarse un día. La excepción son las **alarmas** (`reloj/planificadorAlarmas.ts`), que sí usan fechas locales a propósito: una alarma es hora de pared y «las 7:00» tienen que ser las 7:00 también la noche que dura 23 horas.
  - **`fin` es INCLUSIVO** (`inicio == fin` = un día). Google usa fin **exclusivo** para los eventos de día completo, y la conversión vive solo en `google/mapeo.ts`. Sin ella todos los eventos de varios días se pintan un día de más y, al subirlos, encogen uno en cada ida y vuelta (hay test de ida y vuelta).
  - **Ni la rejilla, ni la agenda, ni las listas de alarmas usan `<For>`: se reconstruyen enteras.** Son widgets sin estado, y `<For>` indexa por identidad de objeto — el patrón que ya provocó destrucción de widgets en pleno evento de foco y el SIGSEGV de las franjas horarias (ver la sección de `servicios/pantalla/`). Por lo mismo, **los dos formularios (evento y alarma) NO son reactivos**: se construyen con una copia local del borrador y solo escriben en el estado al guardar. Si cada tecla actualizara `edicion`, el overlay que los monta los destruiría con el foco dentro.
  - **Los overlays se sincronizan también AL CONSTRUIR**, no solo en `subscribe`: `subscribe` avisa de los cambios, así que un panel montado con una edición ya abierta se quedaba sin editor y sin ninguna señal de por qué.
  - **La cuadrícula del mes tiene SIEMPRE 42 celdas** (6×7) y **no se estira al alto del panel**. Lo primero evita que el panel cambie de alto al pasar de mes (un mes ocupa 4, 5 o 6 semanas); lo segundo, que en una pantalla de 1440 px cada celda pase de 50 a 240 px y el día seleccionado se convierta en una columna gigante.
  - **Un solo temporizador para la próxima alarma, troceado a 15 min.** No hay bucle que repase la lista: al cambiar cualquier alarma se recalcula el próximo vencimiento y se rearma. El troceo existe porque `GLib.timeout_add` **no corre mientras el equipo está suspendido**, así que una espera de ocho horas armada de una tacada sonaría ocho horas de *actividad* después; cada salto recalcula contra el reloj de pared. Al cargar, las **puntuales vencidas se desactivan en silencio** —no se emite la alarma atrasada— y las semanales se recalculan solas: la «próxima activación» es derivada y **nunca se persiste**, porque sería una segunda fuente de verdad que se contradice al cambiar la hora del sistema.
  - **Temporizador y cronómetro miden por marcas de tiempo, no contando ticks.** El tick es solo presentación y **cuelga de la visibilidad**: con el panel cerrado o en la pestaña Calendario no queda ni un temporizador de repintado vivo, y al volver la cifra es exacta por muchos frames que se hayan saltado. Son estado de **sesión**; solo las alarmas se guardan.
  - **Las reconstrucciones de la cuadrícula, la agenda y la lista de alarmas van COALESCIDAS** (`utilidades/coalescer.ts`: bandera + `GLib.idle_add`, sin temporizador nuevo). `gnim` no agrupa notificaciones —cada `set` llama a sus suscriptores de forma síncrona, uno a uno—, y estos widgets se suscriben a un estado *y* a un derivado suyo: `indiceMes` deriva de `cuadricula`, `agendaSeleccionada` de `fechaSeleccionada`. Pasar de mes reconstruía **dos** veces los 42 botones, y `seleccionarFecha()` sobre un día de relleno **tres** (toca dos estados seguidos), en cada uno de los tres monitores. Peor que el coste: la **primera** pasada lee el derivado todavía sin invalidar —`createComputed` limpia su caché en el mismo recorrido de suscriptores en el que avisa—, o sea que pintaba los puntos del mes anterior y los tiraba en el mismo turno. Al añadir una suscripción a uno de estos widgets, engánchala a `repintado.programar`, no a `reconstruir`.
  - **El color de un evento es una CLASE CSS (`cal-ev-<color>`), nunca un `css=` inline.** El `css=` de gnim construye un `Gtk.CssProvider`, lo parsea y lo cuelga del `get_style_context()` (deprecado en GTK4) de **ese** widget: la cuadrícula son hasta 4 puntos × 42 celdas = 168 providers por reconstrucción y por monitor, creados y tirados en cada clic. Los hex viven en `$colores-evento` (`estilos/_colores.scss`) y son **la mitad de un par** con `COLORES_EVENTO`/`claseColor()` de `dominio/tipos.ts`: añadir un color en TS sin añadirlo al SCSS no da error, solo deja el punto sin pintar (y hay que recompilar `out.css`).
  - **«Hoy» es reactivo (`hoyReactivo` en `estado.ts`) y no cuesta ni un temporizador.** `hoyISO()` es puro, así que la celda «hoy» y el «Hoy · N eventos» se quedaban con el día en que se construyó el panel: abierto a medianoche, seguían señalando ayer. La fuente es `ticReloj` (`servicios/sistema/reloj.ts`), el tic global al minuto que ya mueve el reloj de la barra, con **una** suscripción para todo el shell. **Tiene que ser `createState` y no `createComputed`**: el derivado de gnim avisa a sus suscriptores al invalidarse **compare o no** el valor (`invalidate()`), así que un computed sobre `ticReloj` habría reconstruido cuadrícula y agenda cada minuto en los tres monitores — justo el sondeo que este módulo no tiene. `createState` filtra con `Object.is` y de los 1.440 tics diarios solo uno repinta.
  - **El reloj grande tickea a 1 Hz; la fecha larga NO cuelga de ese tick.** Colgaba, y eran un `new Date`, un parseo con regex y una cadena nueva **por segundo y por monitor** para un valor que cambia una vez al día. Va por `hoyReactivo`. Por lo mismo `ListaAlarmas` recibe `visible`: el «En 3 h 12 min» solo se suscribía a `alarmas`, así que era el que se calculó al arrancar la sesión — el comentario decía «se recalcula al abrir la sección» y no había nada que lo hiciera.
  - **El tick del cronómetro se REALINEA en cada vuelta** (`msHastaSiguienteTickAscendente`, con test), como el del temporizador. Repetía con `SOURCE_CONTINUE` cada 100 ms y GLib mide ese intervalo desde que **termina** el callback anterior: el retraso se acumulaba y las décimas se veían saltar de dos en dos. La cifra nunca fue incorrecta (sale de `Date.now()`), solo se saltaba valores a la vista — que en un cronómetro es lo que se está mirando. Ojo: la función de la cuenta atrás **no vale** para una cuenta que sube.
  - **El clic derecho del reloj de la barra maneja el cronómetro, y comparte estado con la pestaña Reloj.** Estuvo retirado un tiempo por ser una función invisible —nada la insinuaba, y pulsar donde uno espera un menú contextual sustituía la hora por un contador sin explicación—, pero el atajo se quería, así que volvió con las tres cosas que le faltaban: es **el mismo** `cronometro` de `estadoReloj.ts` que el del panel (nada corre por su cuenta sin sitio donde verlo ni pararlo), el ciclo del clic tiene **vuelta atrás** (parado → corriendo → pausado → parado, o sea que el mismo botón devuelve la hora), y mientras cuenta la pastilla se **tiñe de violeta** (`.clock-crono`) con el tooltip diciendo en qué estado está. La barra enseña `MM:SS` con `formatearCronometroCorto` y tickea a 1 Hz: las décimas del panel obligarían a repintar a 10 Hz y por monitor una etiqueta que está siempre en pantalla, para un dígito ilegible a ese tamaño. El tick cuelga de la visibilidad de la barra y pararlo no desvía la medida, que sale de marcas de tiempo.
  - **Cada alarma puede llevar SU audio**: el campo «Sonido» del formulario guarda una ruta (`~/Música/despertar.ogg`) en el mismo `Alarma.sonido` que ya guardaba el nombre de tema, y se distinguen por la forma (`esRuta`: una ruta lleva barras, un nombre de tema no). Es un campo y no dos porque son alternativas excluyentes; con dos habría que inventar cuál gana si están los dos. Se manda por el hint **que le toca** (`sound-file` para una ruta, `sound-name` para un nombre): una ruta metida en `sound-name` no da error, canberra la busca dentro del tema instalado, no la encuentra y **no suena**. Vacío = `SONIDO_ALARMA`; el formulario guarda `undefined` y no `""` porque el `?? SONIDO_ALARMA` del planificador no filtra la cadena vacía.
  - **Las alertas del reloj son notificaciones normales**, con hint `sound-name` (o `sound-file`) y origen `x-gigios-source:alarm`. No hay popup ni reproductor propios: deciden el motor de reglas, el No molestar y `modulos/notificaciones/sonido/`. El origen es `alarm` y **no `system`** a propósito — `system` activaría la builtin del skin dunst, que es para los avisos de `hypr/scripts/`.
  - **El disparador de «sincronizar al abrir el panel» vive en `google/sincronizacion.ts`, a nivel de MÓDULO, no en el chip.** `EstadoGoogle` se construye una vez por monitor: con tres pantallas, abrir el panel lanzaba tres `sincronizar()` y tres lecturas del fichero de credenciales. El `enCurso` salvaba la red, no el resto. Y lleva **suelo entre pasadas automáticas** (`MIN_INTERVALO_AUTO_MS`, 60 s): el panel se abre y se cierra constantemente —mirar la hora en la pestaña Reloj cuenta como abrirlo— y sin él diez aperturas en un minuto eran diez pasadas completas de `curl`. El botón de refrescar pasa `manual: true` y se lo salta. **Una pasada que falla solo gasta `MIN_INTERVALO_FALLO_MS` (10 s)**: el suelo existe para no repetir trabajo ya hecho, y si no se hizo, castigar el reintento deja el calendario desactualizado justo cuando vuelve la red.
  - **Una sincronización escribe el estado UNA vez, no una por calendario.** La red (`descargarCalendario`) y la fusión están separadas: antes cada calendario terminaba con su `reemplazarEventos`, o sea cuatro invalidaciones del índice del mes y cuatro reconstrucciones de cuadrícula y agenda por monitor en mitad de la pasada; lo mismo hacía `subirPendientes` por cada mutación en cola. Ahora se acumula y se pliega al final sobre `eventos.get()` **leído en ese momento**, lo que además es más correcto: un evento creado o editado mientras la sincronización está en vuelo sobrevive, en vez de caer con la siguiente escritura.
  - **Google: la fusión es aditiva por calendario y un fallo suyo NUNCA cuesta datos locales** (`google/fusion.ts`, puro y probado). Lo local no se toca jamás; una respuesta vacía no puede vaciar la lista; una **mutación local pendiente gana** a la versión remota (es posterior a lo que Google tiene) y se marca `conflicto` solo si el etag remoto cambió; un **borrado remoto no se aplica sobre una edición local pendiente**. Solo `owner`/`writer` conceden escritura, y las **instancias recurrentes se degradan a lectura** porque esta versión no sabe escribir recurrencias. No hay sondeo: se sincroniza al conectar, al abrir el panel, al pulsar actualizar y tras una mutación. El 410 (`syncToken` invalidado) reconstruye con una pasada completa **antes** de borrar nada.
  - **El consentimiento OAuth NO vive en el shell**: lo hace una vez `scripts/google-calendar-auth.sh` (PKCE, estado anti-CSRF, loopback en puerto que pide al kernel), igual que Spotify. `access_type=offline` + `prompt=consent` no son opcionales: sin ellos una segunda autorización devuelve código pero **no** refresh token, y el script terminaría «bien» dejando credenciales inservibles. Con el proyecto OAuth en modo *Testing*, Google caduca los refresh tokens a los **7 días**.
- `modulos/notificaciones/sonido/` — **la reproducción de sonido de las notificaciones**, que hasta ahora no existía (el motor calculaba `muteAudio` y nadie lo consumía). `decision.ts` es puro y probado; `reproductor.ts` ejecuta. **No hay sonido por defecto**: si nadie pide `sound-name`/`sound-file`, silencio — sin esa guarda, activar el audio habría vuelto sonora *toda* notificación del sistema. Orden de las guardas: `suppress-sound` (lo pone quien emite, que sabe si ya sonó por otro canal) → No molestar → reglas. Una **crítica tampoco se salta el No molestar**: quien lo activa pide silencio, y la notificación se sigue viendo. El comando es un **array de argumentos, nunca `sh -c`**: un `sound-file` llega por D-Bus desde cualquier proceso de la sesión. Falla en silencio a propósito — una notificación de error sobre una notificación que no suena es un bucle de ruido. Requiere `canberra-gtk-play` (paquete `libcanberra`), declarado en `install.sh` y `bin/preflight.sh`.
  - **Los audios viven en el repo, en `~/GiGiOS/audio/` (ver `audio/README.md`), y ese directorio gana al tema del sistema.** Antes de mandar un `sound-name` a canberra, `reproductor.ts` prueba `audio/<nombre>.{oga,ogg,wav,mp3}` y, si está, lo reproduce como fichero. Sin eso, las alarmas dependían de tener instalado `sound-theme-freedesktop`: sin el paquete, `canberra-gtk-play -i alarm-clock-elapsed` **sale con éxito y no suena nada** — el peor modo de fallo para una alarma. La resolución no se cachea (la carpeta es del usuario y puede cambiar con la sesión abierta; un `file_test` no se nota al lado de arrancar un proceso de audio) y el nombre pasa por **`nombreTemaSeguro`** (puro, con test) antes de concatenarse al directorio: el hint llega por D-Bus desde cualquier proceso de la sesión, así que un `../..` sacaría al reproductor de la carpeta. Lo que no esté en `audio/` sigue delegando en el tema instalado, como siempre.
  - **`EffectSpec.soundFile` es el «ponle este audio» del usuario**, editable desde Ajustes > Notificaciones (campo «Sonido propio» del editor de reglas, que sale también en las predefinidas y en cada aviso del sistema, o sea que **cada notificación se puede configurar por separado**). Es la única entrada que **rompe la regla de «no hay sonido por defecto»**, y tiene que romperla: la mayoría de apps no manda ningún hint de sonido, así que sin eso «que los avisos de X suenen así» no habría podido sonar nunca. Gana al `sound-file`/`sound-name` del emisor y también a su `suppress-sound` (configuración explícita y posterior sobre *esa* notificación); **no** gana al No molestar ni a `muteAudio` — los dos son «quiero silencio», y «Sin audio» convive con el campo en la misma pantalla, donde ponerlos a la vez es contradictorio y manda el que calla.
  - Viaja en `EvalResult.soundFile` y **no en `NotifMeta`**: la meta se persiste con la notificación y el sonido se consume una sola vez, al ingerir.
  - El `~` se expande en `reproductor.ts` (`expandirRuta`), no en `decision.ts`, que es puro y no puede preguntar por el home. Sin expandir, la ruta fallaría **en silencio**, que es el peor modo de fallo para esta función.
  - `validate.ts` solo comprueba la **forma** (absoluta o desde `~`), nunca que el fichero exista: un audio en un disco desmontado sigue siendo configuración válida y bloquear el guardado dejaría la regla imposible de cerrar. Quien avisa de que la ruta no existe es el campo del editor, y solo avisa.
  - **El campo no tiene botón de examinar, y no es un olvido** (`sonido/CampoRutaAudio.ts`): las dos ventanas que lo montan —Ajustes de notificaciones y el formulario de alarmas— son layer-shell en la capa OVERLAY, y un diálogo de ficheros (`Gtk.FileDialog` o un `zenity`) es una ventana normal que el compositor dibuja **por debajo**: se abriría invisible e inalcanzable. Se teclea la ruta y se prueba con el botón «Probar», que reproduce sin pasar por ninguna guarda (ahí el usuario está pidiendo *ese* audio a propósito).
- `servicios/almacenamiento/json.ts` — **el único sitio con la escritura JSON atómica y asíncrona** (`replace_contents_bytes_async`, y por qué no `replace_contents_async`). Nació dentro de notificaciones; se movió aquí al necesitarlo el calendario, y `modulos/notificaciones/estado/persistencia.ts` quedó como fachada que reenvía conservando el prefijo `[notif]` de sus logs. Un tercer módulo que necesite escribir estado **debe usar este**, no copiar la función.
- `modulos/osd/` — `OSD.tsx` y `MicOSD.tsx`, los flotantes de volumen, brillo y micrófono.
  **El recorte de entrada debe quedar vacío síncronamente desde `realize` y durante el primer `map`.** La superficie
  OSD nace transitoriamente como `200×200` antes de que GTK asigne la tarjeta real (`232×40`);
  esperar al tick/idle de `clipWindowInputToContent()` deja durante ese primer frame la región
  rectangular predeterminada y reaparece el cuadrado de la sombra. Por eso este llamador usa
  `vaciarAlMapear: true`: después del layout el helper sustituye la región vacía por la suma de las
  siluetas redondeadas de las tarjetas visibles. Las tarjetas mantienen además
  `overflow={Gtk.Overflow.HIDDEN}` para que ningún hijo pinte fuera del mismo límite visual.
- `servicios/pantalla/brightness.ts` — **el brillo, con DOS backends: son dos hardwares distintos, no uno
  con dos rutas.** El estado (`brightness`), el OSD y las escrituras viven aquí; `state.tsx` solo los
  **reexporta** (es el hub, y así `OSD.tsx`/`app.ts` no cambian). `brightnessBackend()` decide una vez
  al arrancar:
  - **`backlight`** (portátil): la GPU maneja la retroiluminación del panel interno y el kernel la
    publica en `/sys/class/backlight` → `brightnessctl`. Barato, y **udev avisa** de los cambios los
    haga quien los haga. La ruta ya **no está hardcodeada** a `intel_backlight`: se enumera el
    directorio.
  - **`ddc`** (sobremesa): un monitor externo **no aparece en esa clase**. Su brillo vive en el
    firmware del monitor y se habla con él por **DDC/CI** — I2C sobre el propio cable de vídeo →
    `ddcutil setvcp 10`. Detección asíncrona al arrancar (`ddcutil detect --terse` → bus, luego
    `getvcp 10 --terse` para confirmar que el monitor **soporta** el VCP 10 y de paso leer su valor
    real, que pasa a ser el que enseña el slider). Requiere el módulo **`i2c-dev`** cargado (ver
    `system/modules-load.d/i2c-dev.conf`); el acceso a `/dev/i2c-*` ya lo da la regla udev del propio
    ddcutil (`TAG+="uaccess"`), **sin** tocar el grupo `i2c`.
  - **`none`**: ni una cosa ni la otra → los sliders (QuickSettings > Pantalla y Ajustes > Pantalla) se
    **ocultan** con `visible={brightnessSupported}` y el OSD no sale. Ojo: `brightnessSupported` es
    **estado reactivo, no una constante**, precisamente porque el sondeo DDC tarda ~1 s y termina
    *después* de construirse la UI.

  **El slider tiene DOS TRAMOS, porque el hardware tiene un SUELO.** `setvcp 10 0` es el mínimo
  que acepta la electrónica del panel, y en el OLED de esta máquina eso sigue siendo claramente
  luminoso: el slider llegaba a 0 y la pantalla no se oscurecía más. No era un recorte del código
  (`applyBrightness` ya dejaba llegar a 0), era el hardware. `atenuacion.ts` (**puro y probado**)
  parte el valor compuesto —lo que ve el usuario— en dos canales con `repartirBrillo()`: por encima
  de `DIM_FLOOR` (0.35) manda el hardware y el gamma queda intacto; por debajo, el hardware se
  queda en 0 y sigue oscureciendo el **gamma** hasta `GAMMA_MIN` (0.15). El reparto es **continuo**
  en el suelo (hay test), así que arrastrar el slider no da ningún salto. Medido en vivo: DDC
  80→65→49→34→18→3 con gamma 100, y al tocar el suelo gamma 88→64→39→15 con DDC clavado en 0.
  - **El gamma solo entra en el tramo bajo, no en todo el rango**: reducirlo recorta niveles
    útiles y puede dar banding. Arriba el hardware hace el trabajo sin ese peaje, así que el
    software solo entra donde el hardware ya no puede.
  - **`GAMMA_MIN` no es 0** a propósito: un gamma 0 deja la pantalla en negro absoluto,
    indistinguible de "se ha apagado el monitor" y sin nada visible con lo que volver a subirlo.
  - **Lo aplica `service.ts`, no este módulo.** `brightness.ts` solo publica `softwareDim` (0..1)
    y `service.ts` lo reconcilia: el gamma vive en la **CTM del KMS**, cuyo único dueño es
    `hyprsunset` — el mismo proceso que sostiene la luz nocturna. Dos escritores se pisarían, así
    que se reconcilian juntos en `applyNight()`, que ahora mantiene `hyprsunset` vivo si lo pide
    **cualquiera** de los dos canales (antes solo lo pedía la luz nocturna, así que atenuar con
    ella apagada no habría tenido dónde aplicarse) y arranca con `-t` y `-g` a la vez para no
    pintar un fogonazo. Cuando el proceso hace falta solo para el gamma se pide `TEMP_NEUTRA`
    (6000 K): sin eso, bajar el brillo encendería de paso la luz nocturna. `nightOn` sigue
    colgando **solo** de la temperatura. La suscripción lleva debounce de 120 ms — arrastrar por
    la zona baja emite un cambio por píxel y cada uno es un `hyprctl`.
  - **El tramo software SE RESTAURA DESDE DISCO al arrancar, y es obligatorio**: es el reverso
    exacto del residuo físico que documenta `applyScheduledBrightness`. Allí el hardware recuerda
    **de más** (graba el valor DDC en su firmware); aquí el software **no recuerda nada** —
    `hyprsunset` muere con la sesión—, así que al arrancar por debajo del suelo `detectDdc()` lee
    el mínimo del panel y publica el **suelo** (0.35): la atenuación se perdía y el slider saltaba
    hacia arriba en cada arranque. Medido: gamma 39 → reiniciar → gamma 100.
  - **La guarda de esa restauración pregunta si la franja es NUEVA, no si hay franja.** Una franja
    de brillo solo aplica **al entrar**; si al arrancar ya estábamos dentro de la misma (su clave
    coincide con `franjaAlArrancar`, congelada al cargar porque `lastBrightnessKey` muta al
    reconciliarse), no va a re-aplicar nada y lo que el usuario dejó a mano dentro de ella es el
    valor bueno. Ceder el mando sin esa distinción dejaba el brillo **sin restaurar nunca** con la
    franja 00:00-07:00 vigente — que es justo la franja en la que se usa el tramo oscuro.
  - **`componerBrillo()` es la inversa PARCIAL**: reconstruye el compuesto desde una lectura del
    hardware (`detectDdc`, watcher de udev), pero solo conoce su tramo — el gamma no se lee del
    panel. Por eso `adoptarLecturaHardware()` devuelve `null` ante un 0 con atenuación activa: ese
    0 lo pusimos nosotros, no es información nueva, y componerlo devolvería el slider al suelo en
    cada evento de udev.

  **Las escrituras DDC se coalescen, y no es opcional**: cuestan ~0,3 s (medido, con `--bus N
  --noverify`; sin esos flags, 0,66 s), o sea que un arrastre del slider genera muchísimas más
  peticiones de las que el bus I2C traga. Se mantiene **una escritura en vuelo como mucho** y al
  terminar se lanza el último valor pendiente: ~3 actualizaciones/s mientras arrastras y siempre el
  valor exacto al soltar. Todo `ddcutil` va bajo `timeout 10` — un bus mudo lo cuelga indefinidamente.

  **El modo de fallo original era silencioso y peor que "no hace nada":** `brightnessctl` sin
  dispositivos de clase `backlight` **no falla** — cae al primer dispositivo de clase `leds` y sale con
  0, así que cada arrastre del slider en el sobremesa encendía el **LED de scroll-lock del teclado**
  mientras el `.catch(() => {})` no veía error alguno y la UI seguía tan campante (el valor lo fijaba
  `setBrightness(v)` en local y el watcher de udev que lo habría desmentido consultaba una ruta
  inexistente). Por eso la llamada lleva `-c backlight` explícito y **nadie invoca `brightnessctl`
  fuera de este módulo**: las teclas `XF86MonBrightness*` de `hypr/gigios/keybinds.lua` ya no lo llaman, van
  por `ags request brightness-up|down` → `stepBrightness()`, que aplica al backend que toque y enseña
  el OSD. `inicializador/init.sh` **no restaura brillo en un sobremesa** (sale si `/sys/class/backlight`
  está vacío) y tampoco hace falta: el monitor guarda su brillo en su propia firmware.

  **⚠️ `showBrightnessOSD()` RELEE sysfs, y llamarlo justo después de `applyBrightness` deshacía el
  salto — era el bug de «las teclas van a veces sí y a veces no».** `applyBrightness` fija el estado
  y lanza `brightnessctl` con `execAsync`, o sea de forma **asíncrona**: en el mismo turno síncrono
  sysfs todavía tiene el valor VIEJO. La relectura del OSD lo adoptaba (`adoptarLecturaHardware` →
  `setBrightness`) y el shell volvía al valor anterior mientras el panel sí bajaba: de ahí el 100 %
  clavado en la UI y en el OSD con la pantalla ya más oscura. Peor, la pulsación siguiente partía de
  ese valor rancio si udev aún no había hecho eco, así que restaba el mismo salto y **la pantalla no
  se movía**. Ningún error por medio, y solo pasa en el camino `backlight`: por DDC no se relee nada,
  que es por qué el sobremesa nunca lo vio. Por eso `stepBrightness` llama a
  `showBrightnessOSD(false, false)` — la relectura es **solo** para quien pide el OSD sin haber
  escrito el brillo (`ags request brightness-osd`, el resumen del arranque). Del cambio real ya avisa
  el watcher de udev cuando ocurre de verdad. El slider de Quick Settings no pasaba por aquí (llama a
  `applyBrightness` a secas), que es por qué el panel funcionaba bien y solo fallaba el atajo.
- `modulos/ajustes/SettingsPanel.tsx` — ventana general de ajustes abierta desde el engranaje de Quick Settings (`settingsPanelVisible` en `estado/shell.tsx`). La navegación lateral es una lista continua de destinos concretos, sin encabezados de categoría ni buscador. `PersonalizationSection` y el antiguo `AppsSection` ya no existen: sus preferencias se reparten entre `modulos/ajustes/barra/SeccionBarraEscritorios.tsx`, `modulos/ajustes/personalizacion/SeccionFuncionesShell.tsx`, Energía, Juegos, Sistema y Notificaciones. La bandeja del sistema forma parte de Barra; la suspensión se edita desde Energía mediante `modulos/ajustes/pantalla/Inactividad.tsx`; `modulos/ajustes/juegos/SeccionJuegos.tsx` contiene las preferencias generales activadas al jugar (detección, tearing, congelar tareas de fondo y pausar la luz nocturna); `modulos/ajustes/pantalla/SeccionPantalla.tsx` reúne en Pantallas la disposición, el color y brillo, la automatización y los ajustes gráficos de fluidez. `modulos/ajustes/disco/SeccionAlmacenamiento.tsx` aporta los destinos «Almacenamiento» y «Liberar espacio»; `modulos/ajustes/seguridad/SeccionSeguridad.tsx` ofrece «Vigilancia del sistema» y «Antivirus»; esta última reúne el escáner automático de Descargas, el análisis manual y el lanzador aislado. No confundir esa sección con `modulos/menu-energia/`, que contiene la ventana independiente de apagado, reinicio y cierre de sesión. Qué botones se pintan en esa ventana lo decide `accionesEnergiaOcultas` (Ajustes > Energía > «Menú de energía»): se persiste la lista de acciones **ocultas**, no la de visibles, para que una acción nueva aparezca sola en los perfiles ya existentes, y `normalizarAccionesOcultas` (`modulos/menu-energia/acciones.ts`) impide dejar el menú vacío — sin ninguna acción no habría desde dónde volver a activarlas salvo editando `preferences.json`.
  - **El coste con Ajustes cerrado es 0, y eso lo sostiene un `<With>` sobre `vistaActiva`** (`= settingsPanelVisible() ? section() : null`), **no sobre `section` a secas**. Con el gate solo por sección, `panel` se evalúa en el cuerpo de `SettingsPanel()` —que `app.ts` invoca con `.map()` **por monitor** al arrancar— y `<With>` renderiza con `immediate: true`, así que **la sección por defecto (Cuenta) se construía al arrancar el shell y seguía montada toda la sesión sin haber abierto Ajustes nunca**; cerrar el panel solo cambiaba `visible` de la ventana y no desmontaba nada. Hoy abrir construye, cerrar desmonta y corren los `onCleanup` de la sección viva. La nav lateral queda **fuera** del `<With>` a propósito: es estática, barata, y reconstruirla perdería el scroll. `section` sobrevive entre aperturas; lo que se tira es el árbol de widgets.
  - **Tiene que ser UN solo `<With>`; dos anidados (visibilidad → sección) NO funcionan**, y es lo primero que se intenta. `<With>` devuelve un `Fragment` y `Fragment.append` lanza `nesting Fragments are not yet supported`. **El error se traga dentro del efecto**, así que no explota nada: el panel se queda **sin contenido** y, además, el fragment externo nunca llega a tener hijos → su scope **no se dispone jamás** y no corre ni un `onCleanup`, o sea que pierdes justo lo que venías a arreglar y en silencio. Medido (dos `JS ERROR: nesting Fragments` en el log y `CONSTRUIDA` sin `LIMPIADA` en cada ciclo). Por lo mismo el caso cerrado devuelve **`<box />` y no `null`**: `<With>` no añade nada al fragment ante `null`/`undefined`/`false`/`""`, y el ciclo de disposición cuelga de **iterar los hijos del fragment** — sin hijo no hay `dispose`.
  - **La limpieza de una sección va SIEMPRE por `onCleanup`, nunca por `connect("destroy")`** — mismo bug que documenta `ReproduccionSpotify.tsx`, y que tenían `modulos/ajustes/barra/SeccionBarraEscritorios.tsx` y `modulos/ajustes/dispositivos/SeccionDispositivos.tsx`: en GTK4 `destroy` sale de `dispose`, y al desmontar con `<With>` el widget solo se **desparenta** (los cierres de JS lo siguen referenciando), así que el manejador no llegaba a correr y cada visita a Barra/Escritorios/Ratón/Touchpad/Teclado/Impresoras dejaba un suscriptor vivo para siempre. `<With>` sí hace `scope.dispose()`, que es lo que ejecuta los `onCleanup`.
  - **Lo que gatea por VISIBILIDAD y no por montaje**: en `modulos/ajustes/pantalla/SeccionPantalla.tsx` el poller (`hyprctl` cada 2 s) **y el reloj de 30 s** se adquieren/liberan juntos contra `settingsPanelVisible`. El reloj colgaba del montaje, así que dejar Ajustes en Pantalla y cerrar el panel lo dejaba tickeando el resto de la sesión, recomputando el resumen y actualizando etiquetas de una ventana oculta. Con el gate de visibilidad del primer punto esto es cinturón y tirantes, pero mantiene el invariante **local a la sección** en vez de depender de la estructura del panel.
- `servicios/energia/powerState.ts` — deriva un estado de ahorro desde la batería real mediante `AstalBattery`. La configuración vive en `~/.config/power-save/config.json`. Expone `powerSaveActive` y estados optativos que pausan trabajo de fondo. **`spotifyBarSuspended`** lo consume `Barra.tsx` para **desmontar** `ReproduccionSpotify` con `<With>`: ocultarlo no bastaría porque conservaría el temporizador y el reloj de frames. **`mascotaSuspended`** persigue lo mismo en `Lagarto.tsx`, aunque por otra vía: se suma a su `visible`, que allí ya desmapea la ventana **y para el temporizador de la marcha**. Motivo: la mascota anima a ~11 fps y cada fotograma es un commit de una capa layer-shell que Hyprland recompone, y por diseño solo pasea **cuando el escritorio está en reposo** — justo los ratos en que el equipo no debería gastar en un adorno. En un sobremesa no se activa: `AstalBattery` usa el `DisplayDevice` de UPower y no confunde la pila de un periférico con la del equipo. **`backgroundJobsSuspended`** lo publica `gamingState.ts` en `runtime-state.json` para que `lib/gaming-gate.sh` congele sondeos prescindibles.
  - **Tres medidas actúan sobre el SISTEMA y no sobre el shell, así que no son banderas continuas sino TRANSICIONES**, cada una en su módulo con su `init*` en el `setTimeout` de 4 s: `servicios/energia/brilloAhorro.ts` (baja el brillo), `servicios/energia/tlpAuto.ts` (conmuta el perfil de TLP) y `servicios/pantalla/inactividadAhorro.ts` (tiempos de hypridle propios del ahorro). Las tres nacen **apagadas** salvo la mascota: se notan, y lo que se nota se pide.
  - **El brillo del ahorro tiene DOS modos y el segundo existe por un fallo del primero** (`servicios/energia/brilloAhorroCalculo.ts`, puro y probado con Node; `brilloAhorro.ts` solo lo aplica). Un objetivo **fijo** es un valor absoluto: entrar en ahorro con la pantalla ya más baja que él la **SUBIRÍA**, o sea que el ajuste que se pide para gastar menos gastaría más justo con la batería baja. Por eso el modo fijo **nunca sube**: cuando el brillo de partida ya está en el objetivo o por debajo, cae al modo **relativo**, que resta PUNTOS porcentuales al brillo que hubiera (30 % con 10 → 20 %; es resta de puntos, no un 10 % de 30, que daría 27). De ahí que Ajustes pinte el deslizador de la reducción **también en modo fijo**: ahí es el fallback, y esconderlo dejaría un valor que sí se aplica sin nada donde editarlo. Suelo común en 5 % (el mínimo del deslizador) y `null` = "no hay nada que bajar", que **no escribe nada** en vez de subir al mínimo. El objetivo se calcula siempre desde el **apunte** `brightnessBefore`, nunca desde el brillo vivo: partiendo de lo ya bajado, cada reconciliación restaría otra vez y la pantalla se apagaría sola a base de eventos.
  - **Las tres respetan el cambio manual hecho durante el ahorro, y ninguna necesita una bandera para saberlo**: se compara el valor vivo con el que dejamos puesto. En el brillo, `ultimoAplicado` con `TOLERANCIA` de 0,03 (cubre el ida y vuelta del redondeo hardware→udev→compuesto); en TLP sale gratis porque `tlp.ts` solo publica el modo cuando el helper root ha salido con éxito, así que `tlpMode` es el estado **real** y no una intención. Si el usuario tomó el mando, al salir **no se restaura nada**.
  - **⚠️ El brillo y los tiempos de inactividad dejan RESIDUO que sobrevive al proceso, y por eso su apunte va a DISCO.** El brillo por DDC se graba en la firmware del monitor: si AGS muere en ahorro, la pantalla se queda baja *y* `brightness.subscribe(saveDisplayConfig)` adopta ese valor impuesto como elección del usuario, borrando el real de `display.json` — el mismo fallo que documenta `applyScheduledBrightness` para las franjas horarias. El apunte es `brightnessBefore` en `power-save/config.json`, escrito **síncrono** (`persistAhora()`, no el rebote de 600 ms) porque justo después se cambia el brillo de verdad. Los tiempos de hypridle apartan los generales a `~/.config/gigios/inactividad-normal.json`, que es a la vez el apunte y la señal de "hay override puesto". En ambos casos la primera pasada del `init*` **es** la recuperación del huérfano. TLP no necesita apunte y no es un olvido: morir con el perfil de ahorro deja el sistema consumiendo **menos**, visible en el selector de Ajustes (que lo lee de `/etc`) y reversible con un clic.
  - **La otra mitad de lo de la mascota es `pintar()`, y es una optimización aparte del ahorro**: se llamaba en cada tick y hacía siempre `reclip()`, que mide con `compute_bounds()`, construye una `cairo.Region`, la manda al compositor **y pide un tick callback a la ventana** — o sea que mantenía vivo el reloj de frames de la superficie aunque el lagarto estuviera quieto. Y está quieto a menudo: el modelo se para a propósito (20–70 ticks, 1,8–6,3 s) y las poses colgado/tumbado no se mueven nada. Hoy `pintar()` memoiza el fotograma (sprite + margen, comparando el sprite por **identidad**: son ocho instancias fijas de una tabla, no un objeto nuevo por tick) y **el recorte va con holgura**: el tamaño de la pose lo rehace en el acto, pero la POSICIÓN admite `HOLGURA_RECORTE_PX` (4 px) de desfase antes de remedir, y la deuda se salda en cuanto el lagarto se queda quieto —que es cuando lo van a pulsar—. A velocidad de crucero (0,9 px/tick) el margen redondeado cambia casi cada fotograma, así que sin esa holgura el reclip volvía a ser constante durante todo el paseo: de ~11 mediciones por segundo a ~2,5. Cuidado al tocarlo: el margen sí forma parte de la geometría de la región, así que no basta con mirar la pose; y la rama de "quieto" es lo único que garantiza que el recorte final sea exacto.
  - **Y el resto del bucle de la mascota no hace nada por tick que se pueda hacer una vez**: el ancho de la salida se cachea (`notify::geometry`) en vez de llamar a `get_geometry()` en cada paso, los límites de la franja son dos números que solo se recalculan al cambiar de modo o de pantalla, el modelo de movimiento muta **una sola celda** (`avanzarPasoEnSitio`; `avanzarPaso` queda como envoltorio puro para los tests) y sortea parada y giro con **un único** `azar()`. Además el bucle **se para del todo** mientras la pose es fija (colgado/tumbado no se mueven: el timeout solo servía para salir por la guarda de `avanzar()`), las texturas se cargan **diferidas** al primer fotograma real —con la mascota apagada, que es el valor de fábrica, no se toca el disco ni se sube nada a la GPU al construir las ventanas— y la escucha del escritorio (`suscribirActividadMascota`, que corre ante CUALQUIER evento de ventana, foco incluido) **se da de baja** con la preferencia apagada o en modo ahorro. `debeMostrarMascotaEnMonitor` tampoco pide ya `get_clients()`: el predicado solo necesita el recuento cuando hay un cliente enfocado en ese escritorio, y entonces vale >= 1 por definición.
  - **`transparenciaSuspendida` es la única medida que ahorra mientras el usuario MIRA algo**, y lo que ahorra no es GTK sino **Hyprland**: pintar un fondo con alfa cuesta lo mismo que uno sólido, pero las cinco láminas grandes del shell llevan `blur = true` en `hypr/gigios/reglas.lua` (quick-settings, notification-panel, calendar-panel, orion, osd) y el compositor desenfoca por fotograma el escritorio que se ve por debajo mientras el panel esté abierto. Con la lámina opaca, GTK marca esa región del `wl_surface` como opaca y el compositor se salta el desenfoque **y** el pintado de lo de detrás. El `ignore_alpha = 0.1` de esas reglas no cubría el caso: descarta píxeles casi transparentes, y una lámina al 94 % está muy por encima. Se aplica como el acento adaptativo y por el mismo motivo: los fondos de lámina se escriben con `lamina()` (`estilos/_colores.scss`) y compilan a `var(--lamina-…, <color translúcido de siempre>)`, así que `servicios/energia/opacidadAhorro.ts` solo redefine esas variables en un `CssProvider` propio y apagarlo es **vaciar la hoja** — cada `var()` cae en su reserva sin que nadie enumere qué ventanas tienen lámina. La tabla de colores opacos vive en `opacidadCss.ts` (probado con Node) y es **la mitad de un par**: añadir una lámina es tocar también el `lamina()` del SCSS, o la variable no la lee nadie y el ajuste no hace nada sin dar ningún error. Su `init*` va a **t=0**, no al `setTimeout` de 4 s como los demás: se ve, y arrancar ya en ahorro daría cuatro segundos de paneles translúcidos que cambian solos a la vista.
  - **`opacidadVentanasForzada` es su gemelo para las VENTANAS de Hyprland**, y ahorra lo mismo por el mismo motivo: `decoration:inactive_opacity` está en 0.92, así que toda ventana sin foco es semitransparente y obliga al compositor a componer lo que hay **debajo** de ella en cada fotograma. `servicios/energia/opacidadVentanas.ts` lo aplica por **dos caminos, y los dos hacen falta**: `hyprctl eval "GiGiOS.opacidad_ahorro(<bool>)"` en cada transición (bajo config Lua no existe `hyprctl keyword`), y `~/.config/gigios/opacidad-ventanas.json` con el valor ya **combinado** (ahorro activo Y ajuste encendido, como `powerSaveFreeze`), que lee `hypr/gigios/ventanas.lua` al cargarse — sin eso, un **`hyprctl reload`** repondría el 0.92 sin que AGS se entere, porque no hay señal de recarga que observar (mismo motivo que `display.json`). **Se llama a la función del config y no se manda un `hl.config` desde aquí**: la opacidad a la que hay que VOLVER vive en la tabla `aspecto` de ese fichero, y copiarla en TypeScript es la misma desincronización que ese módulo ya documenta para el toggle de gaps. Su `init*` va a **t=0** con el de los paneles, y le sale gratis: la primera pasada solo lanza el `hyprctl` si lo que quiere no coincide ya con lo que hay en disco. **No hay apunte de recuperación y no hace falta** (al revés que en el brillo o la inactividad del ahorro): no se aparta ningún valor del usuario, así que un AGS muerto en ahorro deja como mucho las ventanas opacas hasta el siguiente reload. Detalle en `docs/hyprland-modulos.md`.
  - **Consecuencia del override de inactividad**: mientras está puesto, `hypridle.conf` **no** contiene los valores generales. Por eso la tarjeta de Ajustes (`modulos/ajustes/pantalla/Inactividad.tsx`) no lee ni escribe ese fichero directamente: pasa por `leerInactividadGeneral()`/`guardarInactividadGeneral()`, que desvían al apunte cuando toca. Sin eso, editar los tiempos generales durante el ahorro se habría perdido al restaurar. `bloqueoAlSuspender` sí va siempre al fichero: no es un tiempo y el ahorro no lo toca.
- `servicios/fondos/planificador.ts` — **el reloj que hace que las franjas horarias de fondos sirvan
  de algo**: duerme hasta el próximo límite y entonces pide `wallpaper.sh --auto`. No decide nada (ni
  qué fondo toca ni cuándo es el próximo límite: las dos cosas se las pregunta a
  `wallpaper-select.py`), y va con el resto de `init*` de fondo del `setTimeout` de 4 s porque lee el
  reloj de pared y no siembra de eventos.
  - **Un solo temporizador, armado exacto y sin sondeo**: entre dos cambios de franja no hay ni un
    despertar. El tiempo que se duerme es el del próximo límite **relevante**, que depende del estado
    — con un grupo puesto solo cuentan **sus** tramos (sus variantes no miran las franjas globales),
    y con un fondo suelto solo las franjas globales. Sin límites relevantes no se arma nada.
  - **Se rearma con el fichero de ESTADO, no solo con el de config**: aplicar un grupo cambia por
    completo qué límites importan, así que `wallpaper.json` se vigila igual que `wallpapers.json`.
  - **⚠️ La suspensión se cubre con `PrepareForSleep` de logind, no troceando el temporizador.**
    `GLib.timeout_add` cuenta sobre el reloj monotónico, que no avanza dormido: una espera de ocho
    horas sonaría ocho horas de *actividad* después (suspendes de día, despiertas de noche). La
    primera versión troceaba a 15 min — 96 despertares diarios para no hacer nada casi ninguno — y la
    señal lo resuelve mejor y sin coste. Si algún día se quita, hay que devolver el troceo.
  - Fail-open hacia "las franjas no cambian el fondo". Detalle completo en el `CLAUDE.md` raíz.
- `servicios/fondos/acento.ts` + `acentoCss.ts` + `acentoCache.ts` + `scripts/acento-fondo.py` —
  **el acento adaptativo**: los tres colores de acento del tema salen del fondo de escritorio. El
  reparto es: el script (Pillow) extrae la paleta, `acentoCss.ts` la valida y la convierte en una
  hoja de una línea que redefine `--acento*`, `acentoCache.ts` decide qué se recuerda y `acento.ts`
  es lo único que toca GTK. Apagarlo es **vaciar la hoja**, con lo que cada `var(--acento…, <color
  de siempre>)` de `out.css` cae en su reserva — mismo mecanismo que `opacidadAhorro.ts`.
  - **En segundo plano no consume NADA, y conviene saber por qué antes de tocarlo**: no hay
    temporizador ni sondeo, solo dos suscripciones (`currentWallpaper`, que se mueve por el
    `Gio.FileMonitor` de `wallpaper.json`, o sea inotify; y la preferencia). Un `Accessor` de
    `createState` **no notifica si el valor no cambia** (`Object.is`), así que reescribir
    `wallpaper.json` con el mismo fondo —el toggle de "aleatorio al iniciar", una franja que vuelve a
    sortear la misma imagen, el `_setCurrentWallpaper` optimista de `applyWallpaper` seguido de la
    escritura de `wallpaper.sh`— **no lanza nada**. Si algún día esto gasta CPU con el escritorio
    quieto, el fallo está en quien llame a `recalcular()`.
  - **La paleta de cada fondo se CACHEA en `~/.cache/gigios/acento-fondo.json`** (48 entradas, la más
    reciente delante). El extractor cuesta ~150 ms de media y hasta 480 ms con los PNG más grandes de
    la carpeta (medido sobre los 64 fondos reales), y ese coste se pagaba **entero en cada cambio de
    fondo y en cada inicio de sesión**, siempre por las mismas imágenes: con franjas horarias el
    fondo rota entre un puñado fijo. Con caché, acertar es un `stat` y se pinta **síncrono**, sin
    fork y sin un fotograma con el acento anterior.
  - **La clave es un sello, y lleva dentro el mtime del PROPIO script.** Editar `acento-fondo.py`
    invalida la caché entera por construcción; sin eso, tocar los umbrales y seguir viendo los
    colores viejos sería un fallo mudo perfecto. La imagen se sella con tamaño + mtime, igual que la
    caché de miniaturas de `modulos/orion/services/wallpaperThumbs.ts`.
  - **Se cachea también "este fondo no tiene acento"**, que es una respuesta legítima (un fondo en
    blanco y negro, un boceto a lápiz): si no, justo esos fondos serían los únicos que forkearían
    siempre. Lo demás que falla (Pillow ausente, imagen a medio copiar) **no** se cachea, porque es
    del entorno y dejaría el tema de fábrica clavado hasta vaciar la caché a mano. El extractor los
    distingue escribiendo `sin-acento` en **stderr** — `execAsync` entrega stderr pero **no** el
    código de salida, así que la marca no podía ir en el `rc`.
  - **Los colores de la caché se re-normalizan al leer**, no se dan por buenos por venir de "nuestro"
    fichero: acaban concatenados dentro de una hoja de estilo y `~/.cache` es texto que cualquiera
    puede editar. Es la misma frontera de confianza que `normalizarHexAcento` aplica a la salida del
    script (hay test).
  - **La saturación HSV no descarta grises, pero el croma absoluto tampoco basta solo** — y las dos
    mitades están medidas. `#010000` tiene `s = 1.0`, así que filtrar por `s` deja pasar colores cuyo
    tono es ruido de cuantización (era el bug del rojo inventado en `gojo.png`); y el croma es
    absoluto, así que un beige (`#c0b0a7`) o una tinta china sobre crema (`#f0ebd8`) lo pasan de
    sobra mientras la corrección los sube a `s = 0.42` **conservando el tono**, o sea inventando un
    naranja de una foto gris de un gato y un amarillo de un dibujo en blanco y negro. El filtro son
    los **dos** suelos a la vez (croma ≥ 24 y `s` ≥ 0.20, con un segundo intento más laxo para
    paletas apagadas). De regalo arregla el caso simétrico: en una foto con neones, un cielo lavado
    que ocupa media imagen le ganaba el acento principal por cobertura.
  - **El decodificado usa `im.draft()` antes del `convert`**: le pide al decodificador JPEG que
    descomprima ya reducido (escalas 1/2, 1/4, 1/8 del DCT), ~30 % menos por fondo, y en PNG no hace
    nada — así los resultados de esos no cambian ni un dígito. El `convert("RGB")` **va antes del
    `thumbnail`** a propósito: reducir en modo P resamplea índices con NEAREST y cambia los colores
    que se miden.
- `servicios/energia/botonEncendido.ts` — **qué hace el botón de encendido físico** (Ajustes > Energía). El shell **solo persiste la elección** (`botonApagado` en `preferences.json`); quien la ejecuta es `GiGiOS.boton_apagado()` (`hypr/gigios/boton-apagado.lua`) desde el bind de `XF86PowerOff` con `{locked = true}`, releyéndola en cada pulsación — así el botón responde con AGS caído y con la sesión bloqueada, y el setter no tiene que relanzar ni recargar nada. La única acción que vuelve al shell es `menu`, por el `request` **`toggle-power-menu`** (`alternarMenuEnergia()`), añadido con ella.
  - **`teclaCedidaAHyprland` pregunta a logind por D-Bus, no mira si existe el fichero de `/etc`.** `systemd-logind` maneja esa tecla a nivel de asiento (`HandlePowerKey`, `poweroff` de fábrica) sin pasar por el compositor: si no está en `ignore`, el bind se ejecuta igual pero el apagado de logind lo tapa y el ajuste parece roto **sin dar ningún error**. `busctl get-property … HandlePowerKey` (sin privilegios) es la única respuesta que no puede mentir — el fichero puede estar en otro sitio o el valor cambiado a mano. El estado es `boolean | null` a propósito: `null` = no se pudo comprobar, y **no** saca el aviso; saber que está mal no es lo mismo que no saberlo. El aviso tampoco sale con la acción `apagar`, donde el resultado es el mismo venga de quien venga. La cesión la instala `install.sh` (paso 9) desde `system/logind.conf.d/`; detalle completo en el `CLAUDE.md` raíz.
- `servicios/energia/tapaPortatil.ts` — **qué hace el portátil al cerrar la tapa** (Ajustes > Energía). Mismo reparto que el botón de encendido: el shell **solo persiste la elección** (`accionTapa` en `preferences.json`) y quien la ejecuta es `GiGiOS.tapa_cerrada()` (`hypr/gigios/tapa.lua`) desde el bind `switch:on:Lid Switch` con `{locked = true}`, releyéndola en cada cierre. Comparte con el botón la **tabla de acciones en Lua** para que "suspender" o "bloquear" no puedan divergir; poda las que no tienen sentido a ciegas (`menu`, `reiniciar`, `cerrarSesion`) y añade una propia, **`suspensionFalsa`**, por el `request` **`suspension-falsa-entrar`** (`entrarSuspensionFalsa()`), añadido con ella — **ENTRA, no alterna**: cerrar la tapa estando ya dentro tiene que dejarla puesta.
  - **`tapaCedidaAHyprland` mira si el INHIBIDOR está puesto, no un fichero de `/etc` — y ahí está la diferencia con el botón.** `HandleLidSwitch` de logind suspende de fábrica y tapa el bind sin dar ningún error, igual que `HandlePowerKey`, pero **la respuesta NO puede ser un `ignore` en `/etc`**: sería permanente, valdría también para el saludador y para una sesión caída, y cerrar el portátil en la pantalla de login lo dejaría encendido dentro de la mochila — un fallo sin síntoma hasta que quema. La cesión es un inhibidor `handle-lid-switch` (modo block, **sin privilegios**) que sostiene `hypr/scripts/tapa-inhibidor.sh` mientras Hyprland viva, así que lo que se comprueba es `systemd-inhibit --list` buscando el tipo **y el nombre `GiGiOS`**: que otro programa inhiba la tapa no querría decir que nuestro bind vaya a ejecutarse. `boolean | null` con el mismo criterio que el botón (`null` no avisa), y con `suspender` tampoco se avisa, porque el resultado es el mismo venga de quien venga.
  - **`hayTapa` OCULTA la tarjeta entera en un equipo sin tapa** (`/proc/acpi/button/lid` vacío), y es la excepción consciente al criterio de "la tarjeta se pinta siempre aunque falte el backend" que siguen el brillo o las firmas de ClamAV: allí el ajuste sigue significando algo; sin tapa que cerrar, la pregunta no existe.
  - **«No hacer nada si hay una pantalla externa» repone a mano lo que logind hacía gratis** (`HandleLidSwitchDocked=ignore`), y por eso nace **encendida**: al quitarle el interruptor a logind esa regla se perdía en silencio. La decide `tapa.lua` sobre `hl.get_monitors()` (nombre que no empiece por `eDP`/`LVDS`/`DSI` = externa), no el shell.
- `servicios/energia/gamemode.ts` — **interruptor manual de Feral GameMode** (paquete `gamemode`), el botón de mando de la cabecera de Quick Settings, al lado de la campana (gris apagado, violeta encendido; glifo `GAME_GLYPH`, el mismo que la pastilla de juegos). **No lo confundas con `gamingState.ts`**: aquel detecta que hay un juego y congela el mantenimiento *del shell*; este le pide al **sistema** que se ponga a rendir (gobernador de CPU a `performance`, prioridades/ioprio, tweaks de GPU). Son complementarios y no se hablan.
  - **El encendido es un proceso hijo, y tiene que serlo.** GameMode no tiene "modo global": el demonio está activo mientras haya un cliente **registrado** y libera en cuanto ese cliente muere. `gamemoded -r` sin PID es exactamente eso (se registra y se pausa), así que **el hijo ES el registro** — vive = activo, `SIGTERM` = apagado, sin estado que sincronizar. Registrar el pid de AGS por D-Bus se descartó: GameMode **renicia a quien registra**, y renicear el shell es un efecto colateral gratuito.
  - **Que el hijo muera es el camino seguro**: si AGS se cae, el registro se va con él y el sistema vuelve solo. Lo que sí hay que limpiar es lo contrario — un hijo **huérfano** de un AGS muerto dejaría el gobernador clavado en `performance` **sin UI donde apagarlo** (mismo razonamiento que `initWakeUp()`), y de ahí `initGamemode()`, que va a **t=0** en `app.ts` y no en el `setTimeout` de los `init*` de fondo, por lo mismo. El hijo lleva **argv0 propio** (`exec -a gigios-gamemode`, el truco del coproceso de `screencast-monitor.sh`) para que ese `pkill -f` sea inequívoco y no pueda llevarse por delante un `gamemoded` ajeno.
  - Estado **solo en RAM y por sesión**: sin proceso no hay registro, así que persistirlo solo podría mentir. El apagado lo confirma el callback de salida del hijo, no el clic — y una muerte **inesperada** (el demonio rechaza, se lo cargan por fuera) apaga el icono *y* notifica con el stderr, porque el usuario había pedido lo contrario. Sin el paquete instalado el botón **no se pinta** (`gamemodeAvailable`, `GLib.find_program_in_path`), igual que los sliders de brillo sin backend. `gamemode` está declarado en `install.sh` y en `bin/preflight.sh`.
- `servicios/energia/gamingState.ts` — publica en disco la señal de juego activo para los scripts. Reutiliza el registro de `servicios/juegos/`, compartido con `IndicadorJuegos` y auto-DND, y escribe `~/.config/gigios/runtime-state.json` `{ "gaming": bool, "gameFocused": bool, "lastGameFocus": <epoch s>, "gameScanner": bool, "powerSaveFreeze": bool, "pid": <pid de AGS> }` al cambiar. **`powerSaveFreeze` viaja aquí y no en un fichero propio** porque dos escritores se pisarían. Lo leen `hypr/scripts/oom-monitor.sh` y `hypr/scripts/lib/gaming-gate.sh`. **`gameScanner` es la preferencia `escanerJuegos`**: con ella en `false` el escáner está apagado y `gaming`/`gameFocused` valen `false` para siempre, así que el gate de bash no congela nunca por partida (`gamingFreeze` queda sin efecto; el motivo AHORRO es otro interruptor y sigue igual). Se escribe el motivo además del efecto para poder distinguir "ahora no hay ninguna partida" de "en este equipo no se juega"; ningún consumidor está obligado a mirarlo, `gaming: false` ya basta. Tiene **suscripción propia** porque apagar el escáner sin juegos abiertos no cambia `clientesJuego` y nadie más reescribiría el fichero. **`pid` es una guarda** contra estado huérfano; `gameFocused`/`lastGameFocus` distinguen juego abierto de juego atendido y mantienen cinco minutos de gracia tras perder foco.
- `modulos/barra/indicadores/sistema/Actualizaciones.tsx` — renderiza dos iconos independientes: núcleo (Tux naranja) y controladores de GPU (verde). Cada uno solo aparece cuando su categoría tiene pendientes; el resto figura como contexto dentro del popover. No sondea: `hypr/scripts/updates-monitor.sh` escribe `~/.config/gigios/updates.json` y un `Gio.FileMonitor` compartido alimenta ambos iconos. Cada popover retiene únicamente la barra de su monitor mediante `ControlVisibilidadBarra`. `Barra.tsx` lo condiciona con `updatesMonitorEnabled`.
- `modulos/barra/indicadores/audio/Microfono.tsx` + `servicios/multimedia/capturasMicrofono.ts`
  (lógica pura, con test) + `servicios/multimedia/origenCapturas.ts` (el `pactl`) — el icono de
  micro en uso. **`audio.recorders` NO es "quién usa el micrófono"**: son todos los nodos
  `Stream/Input/Audio`, y "entrada de audio" incluye capturar el *monitor* de un altavoz o la
  salida de otra app. Medido con Spotify reproduciendo había tres a la vez —`cava` (monitor del
  sink), `discord_capture` (la salida de Spotify) y `WEBRTC VoiceEngine` (el micro de verdad)— y
  los tres encendían el icono: **dar a play encendía el aviso de micrófono**, sin ningún error. El
  peor de los tres es `cava`, que lo lanza el PROPIO shell (`espectro.ts`, la onda de la barra) en
  cuanto Spotify suena — el bug parecía de Spotify y era nuestro.
  - **Se clasifica solo con DOS campos del propio stream**, ambos en la misma salida de
    `pactl -f json list source-outputs`: `stream.capture.sink == "true"` (graba la salida de un
    altavoz) y `source == 4294967295` (`PA_INVALID_INDEX`: no cuelga de ninguna fuente porque va
    nodo a nodo a la salida de otra app). `stream.capture.sink` la pone PipeWire tanto por su API
    nativa (cava) como por la de PulseAudio — comprobado con `parec -d <sink>.monitor`, que es
    como graba OBS—, así que **no hace falta cruzar con la lista de fuentes**: una primera versión
    leía `pactl list sources` para saber qué índice era un monitor, y ahí es donde se coló el bug
    de abajo. El emparejamiento con AstalWp es exacto: el `index` de un source-output **es** el
    `object.serial` del nodo, o sea `endpoint.serial`. Solo lo que esto no cace va a
    `microfonoAppsIgnoradas` (`preferences.json`), editable en Ajustes > Barra y escritorios
    (`modulos/ajustes/barra/CapturasMicrofono.tsx`), donde las capturas ya detectadas como sistema
    salen apartadas con su motivo y el interruptor insensible.
  - **Solo se pregunta por lo que no se sabe.** `sincronizarOrigenes(recorders)` no lanza nada si
    toda captura viva ya está clasificada o es de las que se ignoran siempre, y como la respuesta
    de `pactl` ES la lista de streams vivos, cada veredicto reemplaza el mapa entero y los seriales
    muertos se caen solos (ni caché que envejezca ni poda). Medido con el servicio en vivo: el caso
    del bug —dar a play en Spotify, o sea `cava` sola— pregunta por **cero** capturas y no gasta un
    subproceso; abrir el micro cuesta **uno**, y a partir de ahí nada.
  - **No se puede leer el nodo desde dentro del proceso, y por eso hay un `pactl`.** AstalWp expone
    `description`, `serial` y poco más: la propiedad `node` (el `WpNode`) está marcada
    `introspectable="0"` en el GIR. Abrir una conexión propia con `gi://Wp` (existe
    `Wp-0.5.typelib`) tampoco vale: **medido, `Wp.Core.connect_()` desde gjs mata el proceso**
    (rc=1, sin un solo mensaje) — dentro del shell eso es la barra entera cayéndose.
  - **`monitor_source` de una fuente real es la CADENA VACÍA, no `null`.** Ya no se usa (ver
    arriba), pero queda apuntado porque costó el peor fallo posible: comprobar solo el tipo daba
    por monitor a **todos** los micrófonos y el indicador se quedaba mudo con el micro abierto. Lo
    cazó la prueba en vivo, no el test, cuyo fixture llevaba `null` escrito de memoria. Las props
    de PipeWire llegan como **cadenas**, también los booleanos (`"true"`, no `true`).
  - **La clave manual es el `node.name` del stream** (lo que AstalWp publica como `description`;
    `name` es el `media.name`, descripción del momento y no identidad), **no la app**: Discord abre
    dos streams y apartar la app entera dejaría su micro sin aviso.
  - **`cava` se ignora además a pelo** (`CAPTURAS_IGNORADAS_SIEMPRE`) aunque la clasificación ya lo
    cace: conocer su veredicto de antemano es lo que hace que el caso del bug no consulte nada y no
    pueda parpadear. Por lo mismo, mientras hay un veredicto en camino lo aún sin clasificar
    **espera** (`"espera"`) en vez de contar.
  - `sincronizarOrigenes` va en el camino común de `sync` **porque es idempotente**: recibir un
    veredicto vuelve a llamarlo y esa segunda vez no pregunta nada, lo que además cierra la carrera
    de una captura que aparezca con la consulta anterior en vuelo. Que `origenCapturas` no publique
    un mapa nuevo si dice lo mismo (`mismosOrigenes`) es lo que impide que esa vuelta sea un bucle.
    El servicio es un **singleton de módulo** porque `Microfono` se instancia una vez por monitor.
  - Fail-open: sin `pactl`, con un JSON que no parsea o con la consulta fallando, no se clasifica
    nada y el indicador vuelve a avisar de todo. Avisar de más es tolerable; callar un micro
    abierto, no.
- `modulos/barra/componentes/cadenaEstado.tsx` — **la cadena de indicadores de estado**: lo que hay
  dentro de `.bar-status-pair` entre la bandeja y quick settings (actualizaciones de kernel y de GPU,
  captura de pantalla y notificaciones, en ese orden). Dos cosas a la vez:
  - **El realce se propaga HACIA LA DERECHA**: el cursor sobre un eslabón lo enciende a él y a todos
    los que quedan a su derecha, hasta quick settings, para que se lea como una banda que sale de
    quick settings y no como una isla suelta en medio de la barra. Quick settings **no** se realza
    (es otro botón con su acción), solo recibe la banda.
  - **Sin costuras**: el eslabón que se enciende por arrastre (todos menos el que está bajo el
    cursor) pierde sus esquinas redondeadas —clase `cadena-continua`—, así que la banda es un
    rectángulo liso y solo la cabecera conserva su curva. Lo único que hay que coser es el final:
    **UNA** `JuntaCadena` en `Barra.tsx`, 7 px con `margin-right: -7px`, que se solapa con las
    esquinas izquierdas de quick settings —que sí conserva las cuatro— y las rellena con dos
    `radial-gradient` de 7x7. **Una junta por eslabón NO vale**, y es lo que se intentó primero: su
    relleno cae DEBAJO de la pastilla siguiente y son dos capas del mismo blanco translúcido, que
    suman una hebra más clara siguiendo el arco (cuadrar la esquina no lo arregla: la empeora,
    porque entonces se solapan del todo).
  Tres puntos que no se deducen del código:
  - **El estado es POR BARRA** (`crearCadenaEstado()` en `Barra.tsx`, pasado como prop): a nivel de
    módulo encendería también la cadena del monitor donde no hay ningún puntero.
  - **Es el índice del eslabón bajo el cursor, no un conjunto de eslabones dentro.** Con un conjunto,
    un `leave` que no llegue deja el eslabón encendido para siempre; así lo corrige el `enter`
    siguiente. Y `SensorCadena` lleva `onCleanup` porque un eslabón que se oculta bajo el cursor
    (la captura al dejar de grabar) tampoco recibe `leave`.
  - **Dentro de la cadena el realce lo pone SOLO el estado, no `:hover`** (hay un override que anula
    el hover de `.nb-pill`/`.upd-pill` en `.bar-status-pair`). Ningún selector llega desde un botón
    al hijo del hermano anterior, o sea que `:hover` no puede pintar la junta: al desincronizarse
    dejaba una pastilla encendida con su junta apagada.
  - **Para PROBAR el hover no vale warpar el cursor** con `hyprctl dispatch "hl.dsp.cursor.move{…}"`:
    mueve el puntero pero **no entrega eventos de cruce** a la superficie, así que el widget no se
    entera y las capturas salen con estados viejos que parecen bugs. Hace falta input de verdad (un
    ratón virtual por `/dev/uinput`, que aquí es escribible por ACL).
- `modulos/barra/indicadores/sistema/CapturaPantalla.tsx` — icono rojo pulsante (glifo `󰑊`, clase CSS `recording`
  compartida con `Microfono`) **entre `Actualizaciones` y `BotonNotificaciones`** dentro de
  `.bar-status-pair`, visible solo mientras algo captura la pantalla. Va envuelto en su **propio
  `<box>`**: un `<With>` que se remonta en caliente (aquí lo hace el ajuste de Barra y escritorios) se
  inserta al **final** de su contenedor, no en su sitio — el icono acababa junto a Power. El box
  fija el hueco. Mismo remedio que ya lleva `Recursos` ahí al lado; si añades otro widget de barra
  conmutable, hazlo igual. Sin polling ni subprocesos:
  `hypr/scripts/screencast-monitor.sh` escribe `~/.config/gigios/screencast.json` y esto lo
  observa con un `Gio.FileMonitor` (patrón `Actualizaciones`). Tooltip: «Compartiendo pantalla ·
  Discord» / «Grabando pantalla · wf-recorder», una línea por tipo. **Sustituyó a `Recording.tsx`**,
  que hacía `pgrep -x wf-recorder` cada 2 s *por monitor* y no veía los screencasts por portal
  (Discord, OBS, navegador). Condicionado en `Barra.tsx` por `screencastIndicatorEnabled`, cuyo setter
  en `preferences.ts` es **maestro y en caliente**: lanza o mata el script.
- `modulos/ajustes/inicio/SeccionAppsInicio.tsx` + `servicios/aplicaciones/appsInicio.ts` —
  **Ajustes > Apps al inicio**: qué se abre solo al entrar al escritorio. El shell **escribe**
  `~/.config/gigios/apps-inicio.json` y no lanza nada; quien ejecuta la lista es
  `inicializador/apps-inicio.sh`, llamado desde `hypr/gigios/autostart.lua` a t=7. **El porqué está
  en la sección «Apps al inicio» de [`docs/hyprland-modulos.md`](../docs/hyprland-modulos.md).** Del
  lado del shell:
  - **Si AGS lanzara estas apps, dejarían de arrancar en la sesión en que el shell falla** — que es
    cuando más falta hace tener delante el navegador. Por eso el reparto es escribir/ejecutar. La
    única llamada que sale de aquí es el botón «probar», y va por `apps-inicio.sh --probar <id>`,
    o sea por el MISMO camino que el arranque: un botón de probar que ejecute por otro sitio diría
    que funciona cuando el que falla es el camino real.
  - **La lógica pura vive en `appsInicioModelo.ts` (con prueba)** y no en el servicio, que importa
    `gi://GLib` y no correría bajo `node --test`. Ahí está el saneado del comando —códigos de campo
    `%U`, aplanado a una sola línea— y la regla de que **sin escritorio fijado no se guarda el
    silencio**: `silent` solo existe como regla de exec al enviar la ventana a otro escritorio
    (medido: `[noinitialfocus]` no es una regla de exec), así que guardarlo encendido enseñaría un
    ajuste que no se aplica.
  - **Los tres `Gtk.Entry` viven FUERA de toda lista que se reconstruya**, misma precaución que
    `disco/RutasPersonalizadas.tsx`: reconstruir una lista que contiene el widget con el foco es lo
    que aquí acaba en SIGSEGV. Los resultados del buscador sí se rehacen a cada tecla, y por eso
    dentro no hay nada editable. Las filas guardadas van con `<For id>` y **leen por accessor
    derivado de `appsInicio`**, no del objeto que recibieron: con clave, una fila se construye una
    sola vez y su prop no vuelve a llegar (ver la auditoría del `<For>` más arriba).
  - El catálogo del buscador reutiliza `modulos/orion/data/appsInfo.ts` (la caché compartida de
    `Gio.AppInfo.get_all()`, que se invalida sola al instalar o desinstalar algo) en vez de abrir un
    quinto escaneo de los mismos `.desktop`.
- `modulos/ajustes/disco/SeccionAlmacenamiento.tsx` + `servicios/disco/` — **Ajustes > Almacenamiento**
  («Almacenamiento» = qué ocupa el disco + catálogo de apps por tamaño; «Liberar espacio» = limpiezas
  manuales y autolimpieza). El trabajo sucio lo hacen tres scripts bash
  (`hypr/scripts/analizar-almacenamiento.sh`, `limpiar-almacenamiento.sh`, `limpieza-arranque.sh`) y un
  helper root (`system/limpieza/`); **el porqué de cada decisión está en la sección «Almacenamiento y
  autolimpieza» de [`docs/hyprland-modulos.md`](../docs/hyprland-modulos.md) — léela antes de tocar
  nada de esto.** Lo que hay que saber del lado del shell:
  - **El directorio se llama `disco/`, no `almacenamiento/`, y el servicio `servicios/disco/`.** Ese
    nombre ya está cogido por `servicios/almacenamiento/`, que es la lectura y escritura de los JSON
    del shell — nada que ver con el espacio en disco. Dos cosas con el mismo nombre a dos niveles del
    árbol es una trampa para el siguiente que grepee.
  - **El análisis TAMBIÉN es el vigilante de «disco casi lleno» del resto de la sesión.** Cada
    medida recién tomada pasa por `revisarDiscos()` (`servicios/disco/alerta.ts`) desde
    `usarAnalisis.ts`, que emite el evento `disco.casi-lleno` — el **mismo** que `disk-monitor.sh`
    manda al iniciar sesión, con el mismo texto, los mismos umbrales y una espera de 6 h compartida
    en `~/.cache/gigios/disco-avisos`. Existe porque **el espacio libre no tiene fuente de eventos
    en Linux** (comprobado: ni kernel, ni udisks2, ni systemd, ni nada de CachyOS; GNOME y KDE
    sondean cada 60 s), así que en vez de añadir un sondeo propio se reaprovecha el `df` que esta
    sección ya pagaba: coste marginal cero. La decisión es pura y testeada
    (`servicios/disco/vigilancia.ts`); **la llamada va en `usarAnalisis.ts` y no dentro de
    `analizar()`, a propósito**: medir no debe notificar, o cualquier consumidor futuro dispararía
    avisos por el mero hecho de leer el disco. Va **antes** del `if (referencias > 0)`: con Ajustes
    ya cerrado la medida sigue siendo válida y llenar el disco es justo lo que hay que contar
    aunque no quede nadie mirando la sección. Los tres puntos que deben seguir coincidiendo con el
    script bash están en `docs/hyprland-modulos.md`.
  - **Se pinta llena en el primer frame**, con la caché de `~/.cache/gigios/almacenamiento.json`
    (síncrona, ~1 ms) mientras el análisis nuevo entra por detrás. Mismo patrón que
    `modulos/ajustes/sistema/informacion.ts`: el análisis tarda ~1,4 s y puede volver con la
    sección ya desmontada, así que el resultado tardío se descarta si no queda nadie mirándolo.
  - **El análisis es UNO para todas las vistas vivas** (`disco/usarAnalisis.ts`): estado a nivel de
    módulo con contador de referencias, no un `createState` por vista. `SettingsPanel` se instancia
    **una vez por monitor** y `settingsPanelVisible` es global, así que con el estado dentro de la
    vista dos pantallas lanzaban dos `analizar-almacenamiento.sh todo` simultáneos —dos recorridos
    completos del sistema de ficheros para medir lo mismo, compitiendo por el disco— y dos
    escrituras de la caché pisándose. Latente en un equipo de un solo monitor: no da error, solo
    hace que Ajustes tarde más en abrir el día que conectas la segunda pantalla. Al soltar la
    última referencia se descarta el análisis y se da de baja la suscripción, así que **cerrar
    Ajustes sigue sin dejar nada vivo**; el vaciado va aplazado un tick porque `onCleanup` corre
    con el `<With>` de la vista todavía suscrito.
  - **Cada categoría trae DOS cifras: `bytes` (lo que ocupa) y `liberable` (lo que se liberaría al
    limpiarla).** La estimación de «Liberar espacio» suma **`liberable`**; sumar `bytes` era el
    fallo original — prometía 28,2 GiB donde se liberaban 21,7. Nada aquí recalcula el reparto: lo
    calcula el analizador aplicando las mismas reglas que el borrado, y las tres cachés de
    `~/.cache` son **disjuntas** por construcción (`hypr/scripts/lib/limpieza-rutas.sh`), así que la
    suma es exacta para cualquier combinación de casillas y no hay que descontar solapes en el
    shell. `liberable: null` = «no se ha podido saber» (hoy solo Flatpak): la frase pasa a «se
    liberarían **al menos** X» en vez de tragárselo como un 0. Hay tests para los tres casos.
  - **Tocar `retenerJournal`/`diasPapelera`/`diasDescargas` INVALIDA el análisis.** Esos campos
    deciden *cuánto* libera cada acción, y la caché sigue siendo «reciente» durante su ventana de
    diez minutos, así que la cifra se quedaba congelada tras editarlos. `preferencias.ts` publica el
    contador `revisionLimpieza` y `usarAnalisis` se suscribe para reanalizar.
  - **El estado de las limpiezas vive en `usarLimpiezas.ts`, POR ENCIMA del `<With value={analisis}>`
    y a nivel de MÓDULO**, con el mismo contador de referencias que `usarAnalisis.ts`. Dos razones
    encadenadas: (1) estaba en cada fila, y al terminar una limpieza la fila llama a `refrescar()`
    — el análisis nuevo reemite ~0,6 s después, el `<With>` reconstruye todas las filas y el «Se han
    liberado 3,4 GB» aparecía y desaparecía solo; (2) subirlo a la vista dejaba una copia por
    monitor, así que pulsar «Vaciar papelera» en una pantalla dejaba a la otra con el botón normal y
    **pulsable** mientras la limpieza corría, y el guardia de reentrada no cruzaba de una instancia a
    la otra. Es un mapa único y no doce pares de `createState`, de los que como mucho hay uno o dos
    vivos a la vez. Al soltar la última referencia se tiran los MENSAJES pero **no `ocupadas`**: es el
    guardia de reentrada de limpiezas que siguen corriendo con Ajustes cerrado, y vaciarlo dejaría
    ese botón clavado en «Limpiando…» en la siguiente apertura. «Limpiar ahora» (`ejecutarAutolimpieza`)
    está ahí por lo mismo.
  - **Una limpieza que termina con Ajustes ya CERRADO no reanaliza: anota `caducarAnalisis()`.**
    Reanalizar sería medir para nadie, pero dejarlo estar hacía que la caché siguiera siendo
    «reciente» durante sus diez minutos, así que volver a abrir tras liberar 20 GB enseñaba las
    cifras de ANTES. La marca la consume el siguiente montaje.
  - **«Borrar lo que yo elija» (`rutasPersonalizadas`) acepta carpetas y ficheros**: de una carpeta
    se borra el contenido (la carpeta sobrevive) y un fichero se borra él mismo. Lo reparte
    `objetivos_de_ruta` en la lib de bash, compartido con el analizador para que lo medido sea
    exactamente lo borrado. Valida llamando al script, no con una copia de
    las reglas en TypeScript.** `limpiar-almacenamiento.sh --validar-ruta` usa el mismo
    `ruta_personalizada_valida` que después borra; dos criterios acabarían discrepando y aquí
    discrepar significa borrar algo que la pantalla había dado por rechazado. `RutasPersonalizadas.tsx`
    tampoco usa `<For>`: el `Gtk.Entry` vive FUERA de la lista que se reconstruye y las filas solo
    tienen etiqueta y botón, así que no hay nada enfocable dentro cuando la lista cambia — el
    SIGSEGV de las franjas horarias no se evita con cuidado, se evita por diseño.
  - **La lista hermana, `rutasProtegidas`, es lo que NINGUNA limpieza toca** (misma pantalla, mismo
    widget con otro verbo: `EditorDeRutas` y `--validar-protegida`). No es solo un "no borrar": si
    proteges algo **dentro** de una carpeta que sí se limpia, el filtro **desciende** y borra el
    resto, así que proteger un fichero de 4 KB no cancela la limpieza del gigabyte que lo rodea. Se
    aplica en bash (`filtrar_protegidos`), en el punto por el que pasa todo lo que borra el script;
    **lo que borran pacman/paru/npm/pip/flatpak no lo respeta** porque no aceptan exclusiones, y eso
    se dice en la UI. Protegerla **descuenta de la estimación**, así que su setter invalida el
    análisis igual que los días y la retención, y al proteger una ruta que estaba en la lista de
    borrar se la quita de allí: la contradicción la gana siempre la protección.
  - **«Limpiar descargas antiguas» BORRA; la papelera es opt-in (`descargasAPapelera`, apagado).**
    Usaba `gio trash` siempre y la cifra mentía: la papelera está en el mismo sistema de ficheros,
    así que mover 5 GB no libera un byte, pero la sección decía «5 GB liberados». Con el interruptor
    encendido la contabilidad se invierte y sigue siendo honesta: `liberado: 0` + un `mensaje` con
    lo movido, y `liberable: 0` en el analizador — lo liberará «Vaciar papelera», que tiene su
    propia fila. De ahí que `textoResultado` enseñe el `mensaje` de un `ok` cuando lo trae; sin esa
    rama decía «No había nada que liberar» tras mover 5 GB.
  - **`bytes: null` NO es `0`.** `null` = no se ha podido medir (`du` agotó su timeout, o sin
    permisos); `0` = medido y vacío. `formatearBytes` los distingue (`—` vs `0 B`) y `agrupar` manda
    los `null` al final de la lista. Unificarlos hace creer que ya está limpio lo que pueden ser
    decenas de GB. Hay test.
  - **`catalogo.ts` es la única lista**, y de él sale `ACCIONES_AUTOMATIZABLES` filtrando por
    `privilegio !== "pkexec"` **y `!manual`** en vez de escribirse a mano: eso es lo que impide que una acción con
    diálogo de contraseña acabe en el lote desatendido, donde el diálogo aparecería solo de madrugada.
    La invariante tiene prueba propia.
  - **`manual` es el segundo motivo para quedarse fuera del lote, y no tiene que ver con los
    permisos.** Hoy solo lo lleva **`cacheSombreadores`** («Limpiar caché de sombreadores»: Mesa,
    NVIDIA, AMDVLK, Qt, CUDA y el `steamapps/shadercache` de Steam, ~15 GB en este equipo), que corre
    entera bajo `$HOME` sin pedir nada pero cuyo coste no se paga en disco: se paga recompilando en
    la siguiente partida y, en el caso de Steam, **volviendo a descargar** lo que ya tenías. Por eso
    tiene botón y no casilla. Sin el campo, la única forma de dejarla fuera habría sido mentir en
    `privilegio`; la barrera de verdad sigue siendo la lista blanca de `limpieza-arranque.sh`. Una categoría que llegue del script y no esté catalogada se
    **ignora**, no se pinta con el id crudo — el bash puede ir por delante del shell.
  - **Las acciones de `pkexec` van envueltas en `withPrivilegedPrompt`** (`limpieza.ts`). Sin eso el
    diálogo queda detrás de la ventana de Ajustes, que es una capa OVERLAY, y el botón se queda
    pensando para siempre. Mismo caso que `servicios/dispositivos/printers.ts`.
  - **Ningún camino puede acabar sin algo que pintar**: `ejecutarLimpieza` convierte cualquier
    rechazo en un `ResultadoLimpieza` con estado `error`, porque quien llama es un `onClicked` y una
    promesa rechazada ahí deja el botón en «Limpiando…» el resto de la sesión.
  - **`{ACCIONES.map(...)}` suelto junto a otro hijo revienta la sección entera.** Un array como
    hijo *único* se aplana; dos hijos donde uno es un array llegan a `Fragment.append` sin aplanar y
    lanzan «Object … is not a subclass of GObject_Object, it's a Array», que tumba la construcción de
    toda la vista (medido: «Liberar espacio» salía en blanco). El `.map` va dentro de su propia caja.
  - **El catálogo de apps se recorta a 12 filas** con «Ver más»: son ~1600 paquetes dentro de un
    `ScrolledWindow` que no virtualiza nada. El `<For>` va con `id={app => app.nombre}` por lo mismo
    que la barra (ver la sección de escritorios): sin clave, cada tecla del buscador reconstruiría
    las doce filas enteras.
  - Las preferencias viven en `~/.config/gigios/almacenamiento.json` y **nacen todas apagadas**, al
    revés que `security.json`: allí los defaults deciden si algo se *vigila*, aquí si algo se *borra
    sin preguntar*. Los scripts las releen en cada pasada, así que solo el interruptor maestro
    necesita `pkill` + relanzar el vigilante.
- `modulos/ajustes/atajos/SeccionAtajos.tsx` — **Ajustes > Atajos de teclado**, el último destino de la nav. Es la MISMA lista que la sección "Atajos" de Orion, aquí para quien tenga Orion desactivado (sin este destino los atajos solo se podían consultar abriendo el launcher). **La fuente de datos no se duplica**: reutiliza el estado reactivo `keybinds` de `modulos/orion/data/keybinds.ts` —que parsea `hypr/gigios/keybinds.lua` y se re-parsea solo por `Gio.FileMonitor` cuando ese fichero cambia— y ese módulo ya se carga al arrancar el shell (`app.ts` importa Orion siempre y su buscador usa `getKeybinds`), así que **este destino no añade ni un monitor de fichero más ni depende del toggle de Orion**. Lo propio de aquí son dos cosas: el buscador (Orion filtra contra su `searchQuery` global, que en Ajustes no existe) y las clases `.kb-ajustes-*` de `estilos/style.scss`, aparte de las `.kb-*` de `modulos/orion/orion.scss` porque aquellas van en la paleta del launcher. Dos detalles que ya costaron una vuelta: la fila se aplana a una lista con **una clave estable por fila** (`g:<grupo>` / `k:<combinación>`, que el parser garantiza única) para que `<For>` no reconstruya las ~70 filas en cada pulsación del buscador —el fallo que documenta la barra más arriba—, y la descripción va con `ellipsize`, **nunca `wrap`**: envolviendo, una etiqueta pide de ancho mínimo su palabra más larga y dentro del `ScrolledWindow` se queda con una columna estrechísima, partiendo en dos casi todas las filas.
- `modulos/ajustes/preferences.ts` — preferencias globales del shell que persisten en `~/.config/gigios/preferences.json`, a diferencia del estado solo en RAM de `modulos/barra/funciones/estado.ts`. Incluye los toggles `startupVolumeMuted` y `startupMicMuted`: `inicializador/init.sh` los lee al arrancar, espera a que WirePlumber publique cada endpoint predeterminado y fuerza su mute según el valor. `startupBluetoothOff` es el equivalente para la radio y se comporta igual: activado, `apply_bluetooth` apaga el bluetooth; desactivado lo enciende. Ojo con el efecto secundario: en cuanto existe `preferences.json` esa preferencia manda sobre el `bluetooth` de `system_state.json`, que deja de reponerse y queda solo como respaldo de la primera sesión. También `microfonoAppsIgnoradas` (la escotilla manual del indicador de micrófono, que en el caso normal se queda vacía porque el origen de cada captura se detecta solo; ver su bullet) y `audioDispositivosOcultos`, la única que **no** se edita desde Ajustes sino con el clic derecho sobre una tarjeta del menú de audio de Quick Settings (ver ese bullet); su setter es un flip-flop, `alternarDispositivoAudioOculto`. Para añadir una preferencia: crea un `createState`, léela en `load()`, escríbela en `save()` y expón un setter que llame a `save()`.
  **`absorberSuperSinAtajo`** es de las que se aplican en caliente: su setter escribe la preferencia
  (`save()` es síncrono, así que el fichero ya está en disco) y dispara `hyprctl reload`. Lo demás lo
  hace el config: `hypr/gigios/nop-binds.lua` relee la clave y recalcula con un bucle los binds
  sordos que absorben SUPER + tecla sin atajo, para que no se escriba en la aplicación. Antes esto
  llamaba a un generador (`generar-nop-binds.sh`) que reescribía un fichero de 335 líneas y había
  que **regenerar** al añadir un atajo; con el config en Lua ya no hay nada que regenerar ni que
  pueda desincronizarse. Detalle completo en el `CLAUDE.md` raíz.
- `modulos/ajustes/seguridad/preferencias.ts` + `modulos/ajustes/seguridad/SeccionSeguridad.tsx` — dos destinos de sistema en `SettingsPanel.tsx`: «Vigilancia del sistema» y «Antivirus». Los eventos vigilados por `hypr/scripts/oom-monitor.sh` se persisten en `~/.config/gigios/security.json`; al añadir uno hay que declararlo en `SecurityKey`/`SECURITY_ITEMS` **y asignarlo a un grupo de `GRUPOS_VIGILANCIA`** si pertenece a Vigilancia. El monitor bash lee los toggles de eventos una sola vez al arrancar, por lo que se aplican en la próxima sesión. Las tres pausas del escáner de descargas y `dlMaxScanGB` se releen en cada barrido y se aplican en vivo; `dlPauseWhileGaming` es la única pausa activada por defecto. Antivirus reúne el escáner automático, el lanzador aislado y el análisis manual con ClamAV.
- `servicios/seguridad/clamav.ts` — la tarjeta **Base de firmas** de esa vista (la primera, porque sin firmas `clamscan` sale con código 2 y el barrido de descargas **no da nada por analizado**). El botón "Actualizar ahora" llama a `sudo -n /usr/local/bin/gigios-clamav-update update`, un helper root-owned que instala `install.sh`. **El interruptor "Actualizar las firmas al iniciar sesión" YA NO es `clamav-freshclam`, y NO QUEDA NINGÚN TEMPORIZADOR DE CLAMAV**: es un booleano nuestro (`clamavAutoUpdate` en `security.json`, ver `modulos/ajustes/seguridad/preferencias.ts`, activado por defecto) y quien actualiza es `hypr/scripts/actualizar-firmas.sh --auto` **una sola vez, al arrancar Hyprland** (`gigios/autostart.lua`), en silencio y solo si la base falta o pasa de un día. Durante la sesión no corre nada: los escáneres que se quedan sin motor **avisan con botón**, no actualizan solos. **Este módulo tampoco sondea**: `refreshClamavState()` se llama al montar la tarjeta y tras una orden del helper — no hay `setInterval` ni `Gio.FileMonitor`, y meter uno sería el primer temporizador de ClamAV del sistema. El servicio periódico heredado se sigue leyendo (`systemctl is-enabled`) por un motivo concreto: si quedó habilitado, `refreshClamavState` lo apaga **una vez y en silencio** (`auto-off`) para no dejar un actualizador periódico invisible; `clamavServicioPeriodico` es `boolean | null` y con `null` no se afirma nada, mismo criterio que `teclaCedidaAHyprland`. **leer** el estado nunca pasa por sudo (mtime de `/var/lib/clamav/daily.*` + `systemctl is-enabled`), porque preguntarle al sistema es lo único que no puede mentir. Sin el helper la tarjeta **se sigue pintando** (el botón y el interruptor ceden el sitio a la orden de instalación) — al revés que el selector TLP, porque aquí "falta el helper" es *te falta un paso*, no *esto no aplica a tu máquina*, y ocultarlo dejaba la función indescubrible. Solo desaparece sin ClamAV instalado. Detalle en `docs/hyprland-modulos.md`.
- `modulos/ajustes/sistema/informacion.ts` + `modulos/ajustes/sistema/SeccionSistema.tsx` — Ajustes > Sistema («Información del sistema»). La sección **se pinta llena en el primer frame**; el spinner de «Detectando componentes…» ya no se ve nunca en la práctica. Tres piezas encajadas:
  - **La recolección está partida en dos, y esa partición es todo el invento.** `leerSincrono()` no lanza **ni un proceso**: OS, kernel, CPU (modelo, núcleos/hilos, frecuencia máx, caché, gobernador), RAM/swap, DMI (placa, BIOS, modelo) y UEFI/BIOS salen de `/proc`, `/sys` y el entorno en **~1,5 ms** (medido), así que caben dentro del propio render. `sondear()` es lo único que obliga a forkear (lspci, glxinfo, vulkaninfo, hyprctl, lsblk, nvidia-smi, recuento de paquetes) y va **en paralelo**: 323 ms, dominado por `vulkaninfo` (~250 ms).
  - **El sondeo se cachea en `~/.cache/gigios/sysinfo.json`**, y esa caché de disco es la **única**: al abrir se construye con el sondeo **anterior** y el nuevo se aplica por detrás. Hubo además un memo en RAM de módulo (`sondeoMemo`) que ahorraba el sondeo al reabrir la sección; **se quitó a propósito** — retenía ~8 KB toda la sesión para ahorrar 323 ms que ocurren de fondo y que nadie ve, mientras que lo que hace el pintado instantáneo es la caché de disco, cuya relectura son 8 KB ya en la caché de páginas. Si lo reintroduces, el coste que pagas es memoria retenida, no latencia percibida. La caché guarda la **salida cruda** de cada comando, no los grupos ya montados, para que el parseo siga teniendo un solo dueño. Es un `Record<string,string>` plano con `__version` a propósito: añadir o quitar un sondeo no invalida nada que no deba (clave ausente = `""` = fila que no sale), y `CACHE_VERSION` está para cuando sí haga falta tirarla.
  - **Monitores reutiliza ese mismo `hyprctl monitors -j`**: `sistema/monitores.ts` extrae fabricante/modelo, conector, modo activo, milímetros físicos, escala y formato de color sin lanzar otra consulta ni leer el EDID por separado. La diagonal se calcula desde los milímetros que Hyprland ya obtuvo del EDID y la profundidad por canal se deriva solo de formatos DRM conocidos; si falta una clave o aparece un formato nuevo, se omite esa fila o la profundidad, pero se conserva el resto de la ficha. El número de serie no se muestra.
  - **`lshw -class memory` se quitó porque costaba 857 ms para devolver cadena vacía** — era el grueso de la espera al abrir la sección, gastado en nada. Sin root no puede leer el DMI, así que en esta máquina el `sed` de `clock:` no casaba jamás. La velocidad de RAM se saca ahora solo de **EDAC** (`/sys/devices/system/edac/mc/*/dimm*/dimm_speed`, lecturas de sysfs, ~1 ms); donde EDAC no exista la fila simplemente no aparece, que es mejor que un segundo de espera por lo mismo. **No lo reintroduzcas** sin comprobar antes que devuelve algo *sin* privilegios.
  - Detalles que ya mordieron una vez: los marcadores del DMI (`System Product Name`, `Default string`, `To Be Filled By O.E.M.`…) se filtran **por campo y antes de unir** — concatenar `sys_vendor` + `product_name` primero daba `"ASUS System Product Name"`, que ya no casa con ningún marcador y se colaba entera. `lsblk` va con **`-P` (`KEY="value"`) y `-b`**: con columnas sueltas un disco sin `MODEL` o sin `TRAN` corría los valores una posición (el tamaño se leía como modelo), y el tamaño ya formateado sale según el locale (`447,1G`), en otra unidad que el resto de la sección. `zram`/`loop`/`sr`/`dm-` se excluyen: zram es RAM y ya figura como intercambio.
- `modulos/barra/multimedia/spotify/ReproduccionSpotify.tsx` — carátula + título + **onda**. **Clic izquierdo = "que suene aquí"**, no un play/pausa a secas: el widget también refleja lo que reproduces en el **móvil** y en ese caso el clic trae la reproducción a este PC. Dos piezas:
  - **Saber dónde suena el audio**: MPRIS **no** lo dice. Lo dice **PipeWire**: el nodo `Stream/Output/Audio` de Spotify solo está `running` mientras el cliente *rinde* audio (medido en esta máquina: `running` sonando, `idle` en pausa, inexistente si nunca sonó). `audioIsLocal()` hace `pw-dump` y lo comprueba; ante cualquier fallo devuelve `true` (= "suena aquí"), degradando al play/pausa de siempre en vez de a una transferencia sorpresa. Solo se consulta si MPRIS dice `Playing` (en pausa el clic es siempre play). Lleva un **segundo sondeo a 350 ms** en el camino dudoso: el nodo tarda un instante en pasar a `running` tras darle a play, y sin eso un play + pause rápido se confundiría con "suena en el móvil" y transferiría.
  - **Traer el audio**: `transferToThisDevice()` (`SpotifyService.ts`) = `GET /me/player/devices` → busca este equipo (por hostname, si no el primer `type == "Computer"`) → `PUT /me/player {device_ids, play:true}`. **Exige Premium**: en cuentas free todo `/me/player/*` responde **403**, por eso devuelve `denied`/`unavailable`/`no-device` en vez de un booleano. Ante `denied` cae al **plan B por MPRIS**: `open_uri("spotify:track:<id>")` sobre el cliente local, que al reproducir la pista se adueña del audio — pero **la reabre desde el principio** (no hay forma de conservar la posición por ahí) y su eficacia depende del cliente. Si todo falla, `notify-send`.
  - Los scopes de playback (`user-read-playback-state`, `user-modify-playback-state`) se añadieron a `scripts/spotify-auth.sh`. **Un refresh_token conserva para siempre los scopes con los que se emitió**: si el token es anterior a este cambio, hay que reejecutar el script o la API responderá 403 aunque la cuenta sea Premium.
  **Spotify ocioso**: Spotify se registra en MPRIS en cuanto se abre, aunque no haya ninguna lista
  ni pista seleccionada — se queda en `Stopped` con los metadatos vacíos y dejaba una tarjeta muerta
  en el reproductor de Quick Settings, ocupando además un hueco del carrusel. `esSpotifyOcioso()`
  (`estadoPista.ts`) lo detecta y `publicar()` lo saca de `reproductoresMultimedia` y de
  `estadoSpotify`. La regla es **solo para Spotify**: otros clientes usan `Stopped` como pausa larga
  con la pista todavía cargada. El reproductor filtrado **sigue registrado y con su señal
  `notify` conectada** (`reproductoresVivos`): si se descartara, nadie avisaría de que ha vuelto a
  reproducir y no reaparecería nunca.

  **El espejo de `playerctld` se descarta ANTES de registrarlo** (`esEspejoPlayerctld` en
  `estadoPista.ts`, puro y con test; se aplica en `sincronizarReproductores`, al construir
  `actuales` y no en `publicar()`, para no crearle registro ni conectarle señales que serían un
  duplicado exacto de las del reproductor real). El demonio de playerctl publica **siempre** su
  propio nombre MPRIS —lo activa D-Bus, no lo lanza GiGiOS— y cuando hay algo sonando espeja al
  reproductor activo: medido con Spotify, `mpris.players` devolvía **dos** `Player` con el mismo
  `entry`, `identity`, `title` y `trackid`, indistinguibles salvo por el `bus_name`. AstalMpris no
  filtra ningún nombre (no hay un solo `playerctld` en las cadenas de `libastal-mpris.so`). **No
  partía la tarjeta, y por eso parecía que funcionaba bien**: el reproductor es un **carrusel** y
  `players[0]` es el auténtico, que entra primero — lo que salía era el paginador **«1/2»** con un
  solo reproductor real y la rueda del ratón llevando a un clon idéntico. `estadoSpotify` se
  salvaba de rebote, porque `find(esReproductorSpotify)` casa por `bus_name`. La comparación es del
  nombre **exacto**: un `startsWith` se llevaría por delante a cualquier reproductor que lo prefije.

  **El `CRITICAL` de `player.vala:840` al arrancar el shell es de esto y NO se puede callar desde
  aquí**: `GDBus.Error:…playerctld.NoActivePlayer: No player is being controlled by playerctld`. Lo
  emite Vala dentro de `libastal-mpris` al pedirle propiedades al espejo sin nada detrás, antes de
  que corra una sola línea de `mpris.ts`. Es cosmético (todo va en try/catch) y este filtro no lo
  evita — solo desaparecería impidiendo que `playerctld` exista en la sesión, y el repo no lo usa.

  **Anuncios**: `servicios/multimedia/mpris.ts` mantiene una sola fuente MPRIS para la barra y Quick Settings, y `estadoPista.ts` comparte el contador por `trackid`. `OndaSpotify.tsx` conserva únicamente el estado visual de cada monitor: usa `add_tick_callback`, se limita a 60 fps (24 en ahorro) y se detiene cuando su barra local está oculta o la reproducción queda en reposo.
  **La onda es AUDIO REAL, con el algoritmo de siempre como repliegue** (`servicios/multimedia/espectro.ts`). Las 13 barras eran puramente procedimentales: tres senoides por banda más un "bombo" simulado a **112 BPM fijos**, o sea que no seguían la música — un tema lento y uno rápido se veían igual. Hoy la FFT la hace **`cava`** (C + fftw) en modo `raw`/`ascii`, una línea de 13 valores por frame por stdout; aquí solo se parsea. **La FFT no puede hacerse en TypeScript**: serían ~2,6 M multiplicaciones por segundo dentro del bucle principal de GTK. Medido: cava en régimen permanente cuesta **0,50 % de un core** y 14 MB de RSS (el ~11 % que sale de un `ps %cpu` corto es el arranque, los planes de fftw; no es el coste real).
  - **`channels = mono` en el config NO es opcional**, y su ausencia no degrada: rompe. El default de cava es `stereo`, que **exige un número PAR de barras**, y `BANDAS` es 13 — cava se niega a arrancar (`must have even number of bars with stereo output` por stderr) y además escupe basura **por stdout**, que es justo el flujo de datos. Sin esa clave no sale ni una línea parseable (medido). El config se escribe en `$XDG_RUNTIME_DIR/ags/cava.conf` desde una constante del módulo en vez de versionarse, para que no pueda divergir de `BANDAS`/`FPS`, que son el contrato con el widget.
  - **Un solo proceso para todos los monitores**: `OndaSpotify` se instancia por monitor, así que `adquirirEspectro()` va por **refcount** y devuelve su liberación. Sin eso, dos pantallas = dos procesos capturando el mismo audio.
  - **Es el monitor del SINK, no Spotify aislado — y NO se puede arreglar apuntando cava a Spotify.** Es lo primero que se intenta y falla **en silencio**: con `source = <nodo de spotify>` cava arranca sin un solo error por stderr y emite **todo ceros** para siempre (medido con Spotify sonando *y* un tono de prueba a la vez; el mismo config con `source = auto` captaba ambos). El motivo es que la entrada pipewire de cava solo sabe capturar de una **fuente** (o del monitor de un sink), y el stream de una aplicación es un `Stream/Output/Audio` — un nodo de salida, no una fuente. Aislarla de verdad exigiría un null-sink dedicado más `pw-link` rehecho en cada arranque de Spotify (su id de nodo cambia por sesión), desproporcionado para una onda de 54 px. Peaje aceptado: si suena un vídeo a la vez, entra en la onda. Como la onda solo se pinta mientras Spotify reproduce, en la práctica es su audio.
  - **El repliegue al algoritmo procedimental es obligatorio, y hay tres caminos que lo usan**: sin `cava` instalado (es **opcional** en `install.sh`/`bin/preflight.sh`, nunca un `fail`), con el proceso muerto, y —el caso que de verdad ocurre— con **Spotify Connect reproduciendo en el MÓVIL**, donde el sink local está mudo y cava emite ceros. Un fallo aquí debe degradar a "la onda no sigue la música", nunca a **una onda congelada**, que se lee como "el reproductor está roto".
  - **El cambio de fuente se CRUZA, no se conmuta** (`CRUCE`, 0,28 s): traer la reproducción del móvil a este PC, o entrar en modo ahorro, daría si no un salto visible en la altura de las 13 barras. Y la caducidad de la señal tiene su propio reloj de 500 ms contra `GRACIA_SENAL_MS` (1,5 s): con el audio parado cava sigue emitiendo líneas de ceros, y ninguna puede apagar la señal por sí sola sin convertir cada silencio entre estrofas en un salto de fuente.
  - **En modo AHORRO no se captura**: se cede al algoritmo procedimental, que no cuesta ni un proceso. Es un escalón **antes** que `spotifyBarSuspended` (que desmonta la pastilla entera): aquí la pastilla se sigue viendo, solo deja de analizar. Se suscribe a `powerSaveActive`, así que entra y sale en caliente.
  - **Con un JUEGO EN FOCO tampoco se captura, y lo que esa guarda cubre de verdad es el juego EN VENTANA.** Con `barAutoHide` en `false` —el caso de este equipo— la barra no se esconde nunca al apartar el ratón, así que `barraVisible` es cierto casi siempre y no sirve de gate. La excepción es la **pantalla completa real**, que sí pone `barTapada` en `Barra.tsx` y baja la barra: ahí la condición de visibilidad ya cortaba sola, y para ese caso `clienteJuegoEnFoco` (de `servicios/juegos/registro.ts`) es redundante. Lo que añade es el juego sin fullscreen real —ventana o borderless— y los instantes en que la barra reaparece a mitad de partida (se abre un panel). Se mira el **foco** y no la mera existencia del juego: la distinción "juego abierto ≠ estás jugando" que documenta `lib/gaming-gate.sh`, con el juego en otro escritorio la barra se ve y la onda vuelve a tener sentido.
  - **Verificado en vivo que oculto NO consume**, que es la pregunta que uno se hace al leer todo esto. Muestreo de 20 puntos con Spotify reproduciendo todo el rato: con la barra oculta (juego a pantalla completa, `y = -38, alpha = 0`) **cava parado y AGS entre 0 % y 0,66 %** de un core; con la barra visible y sin juego en foco, cava vivo y AGS entre 8,7 % y 13,3 %. O sea que al ocultarse se sueltan **las dos** cosas: el proceso de captura y el reloj de frames. Las transiciones son inmediatas y en ambos sentidos (juego → parado, alt-tab a Discord → vivo, vuelta al juego → parado).
  - Al valor de cava **no se le aplica `banda.ganancia`**: esa curva existe para dar forma a un espectro *inventado*, no para corregir uno medido — cava ya normaliza con su `autosens`. Lo que sí se conserva es el suavizado `ATAQUE`/`CAIDA`, que es lo que mantiene el mismo carácter visual con las dos fuentes.

  **Tope de 60 fps en modo normal (`WAVE_FPS_MAX`)**: el umbral era literalmente `0`, o sea "no te saltes ningún frame", así que en un panel de **240 Hz** esto se dibujaba 240 veces por segundo. Medido aquí: la animación entera cuesta ~2,7 puntos de un core y el tope se lleva ~0,6 — **no** los ~2 que sugeriría dividir los frames entre cuatro, porque GTK sigue **invocando** el callback a 240 Hz aunque salga temprano; lo que se ahorra es el dibujo, no la llamada. A 1 fps solo se llegaba a ~1,5. Está puesto porque es gratis y no se nota, no porque arregle nada gordo (AGS entero ronda el 7 % de UN core ≈ 0,6 % del CPU total; el ruido entre medidas es de ~1 punto).
  **Limpieza con `onCleanup`, nunca con `connect("destroy")`**: desmontar una rama reactiva en GTK4 puede limitarse a desparentarla. `ReproduccionSpotify`, su onda y Quick Settings cancelan explícitamente sus ticks, temporizadores, suscripciones y callbacks asíncronos.
- `servicios/spotify/` — `SpotifyService.ts` talks to the Spotify Web API; `parse.ts` is the pure parsing logic (tested). Credentials (client id/secret/refresh token) live in plaintext at `~/.config/gigios/spotify-creds.json` (chmod 600, outside the repo), set up once via `scripts/spotify-auth.sh` (interactive OAuth flow, not run automatically). This deliberately replaced an earlier Secret Service / KWallet setup that prompted for a wallet password on every boot under Hyprland.
  - **El corazón "Me gusta" usa `/me/library`, NO `/me/tracks`.** La API vieja (`PUT|DELETE /me/tracks`, `GET /me/tracks/contains`) está **deprecada y responde 403 `Forbidden`** con un token válido y los scopes `user-library-read`/`user-library-modify` concedidos, sin mencionar la deprecación — y **`GET /me/tracks` (listar) sigue dando 200**, así que parece un problema de permisos selectivo. El reemplazo lleva las pistas como **URIs en `uris`** (`spotify:track:<id>`, con los `:` escapados): `GET /me/library/contains?uris=…`, `PUT|DELETE /me/library?uris=…` (máx. 40 por llamada).
  - **El corazón NO se condiciona a Premium.** Hubo un `isPremium()` que leía `product` de `/me`: falso negativo permanente, porque `product` solo aparece con el scope `user-read-private`, que `scripts/spotify-auth.sh` nunca ha pedido — el botón no se dibujaba jamás. La premisa además era falsa: "Me gusta" funciona también en cuentas free (lo que exige Premium es `/me/player/*`). Hoy `canLike` arranca con `isConfigured()` y solo se retira si `isLiked()` devuelve `denied`.
  - **Un `css=` inline no le gana al SCSS de esta tarjeta**: las reglas van anidadas bajo `.qs-media`, así que compilan a `.qs-media .qs-media-btn` (dos clases) y ganan por especificidad al proveedor inline de AGS, que usa una sola. El nudge del corazón lleva `!important` por eso; sin él no se aplica y el cambio pasa desapercibido.

## User-editable config

Runtime JSON lives **outside the repo** in `~/.config/gigios/` (`notifications.json`, `display.json`, `audioPresets.json`, `system_state.json`, `preferences.json`, `security.json`, `runtime-state.json`, `notif-*.json`, `calendario.json`, `reloj.json`, …)

Los tres `notif-*` no son intercambiables y conviene no confundirlos: **`notif-rules.json`** son las reglas que escribe el usuario para las apps (`userRules` + `builtinOverrides`); **`notif-sistema.json`** es la configuración por aviso del sistema (`{version, eventos: {id: efectos}}`, ver arriba); **`notif-history.json`** es el índice de "Detectadas". Solo el segundo está pensado para editarse a mano con comodidad.

El mapa versionado de glifos de aplicaciones vive en `config/app_icons.json`; se importa desde el propio módulo y no depende de la ubicación del checkout. No es estado runtime y `bin/link.sh` lo excluye de la migración a `~/.config/gigios/`. Orion guarda sus perfiles en `~/.local/share/orion/`.

`security.json` is written by `modulos/ajustes/seguridad/preferencias.ts` and read once at startup by `hypr/scripts/oom-monitor.sh` — see the "Seguridad" bullet above and `hypr/scripts/oom-monitor.sh` itself for the full list of scanned events and the sandboxed-launch flow.

`~/.config/gigios/spotify-creds.json` y `~/.config/gigios/google-calendar-creds.json` son **secretos** (client id/secret/refresh token en texto plano, chmod 600) en ese mismo directorio — fuera del repo, y no pueden commitearse ni copiarse dentro. El access token de Google es efímero y vive en `$XDG_RUNTIME_DIR/ags/google-calendar-token.json`, que es tmpfs y desaparece al cerrar sesión: un token de una hora no tiene por qué sobrevivir a un apagado, y así no hay que caducarlo a mano.

`calendario.json` (eventos + configuración) y `reloj.json` (alarmas) los escribe el panel de calendario. **Sustituyen a `~/.config/ags/calendar-events.json`, que caía dentro del repositorio** porque `~/.config/ags` es un symlink a `~/GiGiOS/ags`; `modulos/calendario/persistencia/repositorio.ts` lo migra una vez y borra el original.
