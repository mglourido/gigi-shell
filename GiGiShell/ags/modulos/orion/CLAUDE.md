# CLAUDE.md — Orion (el lanzador «Jarvis»)

Parte de la guía de `ags/` (mapa de áreas en [`ags/CLAUDE.md`](../../CLAUDE.md)). Aquí: secciones, búsqueda, lanzamiento anclado, desinstalar y Temas.

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
  los splash y los multiventana. Detalle en `docs/hyprland-modulos.md` § «Anclar las ventanas al escritorio donde las lanzaste».
  **El panel derecho (`components/shell/RightPanel.tsx`) puede DESINSTALAR la app**, además de
  abrirla, editar su config y fijarla. Lo que decide y ejecuta es
  `hypr/scripts/desinstalar-app.sh` (pacman/AUR, Flatpak, Steam o borrado de ficheros, con `pkexec`
  para el diálogo gráfico de contraseña); aquí solo hay E/S (`data/uninstall.ts`) y la lectura del
  desenlace (`data/uninstall.parse.ts`, **puro y con test**). Detalle del script en `docs/hyprland-modulos.md` § «Desinstalar apps desde Orion (`desinstalar-app.sh`)».
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

  **La franja de Inicio (`components/sections/home/franjaInicio.tsx`) va en dos pisos**, fuera del
  viewport como las métricas: arriba **Sonando** y **Jugando ahora** (tarjetas separadas, el piso solo
  existe si hay reproductor o juego; con una sola tarjeta, esa ocupa el ancho entero) y abajo **Tema
  actual** + el carrusel (hoy solo **Reciente**). Lo que no se deduce del código:
  - **Todo tiene TAMAÑO FIJO, y no es estética.** Las filas son homogéneas (cada mitad pide el
    natural de la más ancha) y una `Gtk.Picture` pide de natural el tamaño de su textura aunque tenga
    `set_size_request`: sin las cajas fijas, un nombre de fondo largo ensanchaba y alargaba la layer
    entera de Orion, que **no vuelve a encogerse sola**, y un piso con una fila de más le quitaba
    píxeles al otro y lo cortaba por abajo. Las etiquetas de ahí se recortan con elipsis por defecto.
  - **El alto es estado (`alturaFranjaInicio`) y `NavSections` lo resta del viewport de Inicio**: al
    aparecer el piso de arriba crece la franja y encogen las apps favoritas, pero la layer mide lo
    mismo.
  - **La caja fija es una subclase de `Gtk.Box` sin layout manager y SIN `vfunc_dispose`.** Los dos
    intentos anteriores fallaron, y los dos están medidos: con `vfunc_dispose` en JS, el GC tenía que
    ejecutarlo al finalizar las cartas que se rehacen (GJS lo bloquea: "Attempting to run a JS
    callback during garbage collection"); con `Gtk.CustomLayout` y la medida en JS, **GJS aborta el
    proceso** al abrir Orion (aserción de `CairoContext` en `cwrapper.h`; el core dump tiene el marco
    dentro de `gtk_layout_manager_measure`). No uses `Gtk.CustomLayout` desde JS.
  - El **historial** (`data/historial.ts`, lógica pura con test en `historial.modelo.ts`, en
    `~/.local/share/orion/historial.json`) solo apunta lo que se HIZO: `launchApp` cuando recibe la
    identidad de la app, `addFavorite` y el clic en un atajo de los resultados — una búsqueda que no
    acaba en nada no deja rastro.
  - **Jugando ahora** sale del registro de `servicios/juegos/` sin llamar a
    `iniciarRegistroJuegos()` (ya lo arranca `gamingState` a los 4 s), y la duración es la edad del
    PROCESO (`/proc/<pid>/stat`), no desde que AGS vio la ventana: si no, reiniciar el shell pondría
    a cero una partida de dos horas. **Sonando** sale del servicio MPRIS compartido y se muestra
    también en pausa: ocultarlo al pausar lo haría desaparecer bajo el cursor.

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

  **Búsqueda de ficheros por extensión (`data/ejecutables.ts` + `ejecutables.modelo.ts`, puro y con
  test; handler `search/handlers/ejecutables.ts`).** Teclear una consulta que acabe en una extensión
  (`.pdf`, `.png`, `.jar`…: alfanumérica, ≤ 8 caracteres y con al menos una letra, para que `v1.2` no
  cuente) busca ficheros con ella en `~` (primer nivel), Documentos, Documents, Descargas, Downloads
  y las carpetas de `orionRutasEjecutables` (Ajustes > Orion > Carpetas de búsqueda de archivos, 4
  niveles). Lo de antes del punto se compara con el nombre del fichero y también con las apps, que
  salen **detrás**: el handler marca `primero` en su `HandlerMatch` y el motor pone esas filas delante
  en vez de intercalarlas. **El handler de apps puntúa con la consulta entera Y con la base y se queda
  con la mejor**: como cualquier `.algo` ya cuenta como extensión, `org.gnome` o `node.js` llegan
  partidos, y quedarse solo con la base empeoraría la búsqueda de apps normales. Lo que no se deduce
  del código:
  - **El índice es POR EXTENSIÓN y no se recorre en cada tecla**: un `find -iname "*.<ext>"`
    asíncrono por carpeta (podando ocultos, `node_modules`, `venv`, `site-packages`, `__pycache__`;
    techo de 4000 líneas y `timeout 5`; la extensión va como argumento posicional, nunca
    interpolada) lo rellena cuando caduca (30 s), y `state.ts` repite la consulta al terminar **solo
    si sigue escrita esa misma extensión** — al teclear `.p`, `.pd`, `.pdf` terminan escaneos de las
    anteriores. La primera búsqueda de cada extensión enseña primero solo las apps y un instante
    después suben los ficheros. El icono es el del tipo MIME (`Gio.content_type_guess` por nombre,
    sin leer el fichero).
  - **SIN extensión también se buscan ficheros** (≥ 2 caracteres), contra un índice más, sin filtro
    (`ejecutablesIndexados(null)`, clave `""`, patrón `*`). Es lo que permite encontrar **binarios**,
    que no tienen extensión que teclear. `find` imprime además los permisos (`%m`), así que saber si
    algo es ejecutable no cuesta un `stat` por fichero. El reparto:
    - **Con prioridad** (filas de `build` con `primero`, delante de todo): solo los programas
      (`tienePrioridad`: bit de ejecución y, o sin extensión, o una de las cuatro de `EXTENSIONES`;
      un `.png` con el bit, típico de un USB en FAT, no cuenta) cuyo nombre **EMPIEZA** por lo
      tecleado (≥ 1800 en `fuzzy`). Con «contiene» bastaría teclear `te` para el terminal y que
      encima saliera cualquier binario con `te` en medio.
    - **Sin prioridad** (`filas` de `HandlerMatch`): el resto de ficheros cuyo nombre **contiene**
      lo tecleado. Una subsecuencia suelta no vale aquí: el corpus son miles de ficheros y `fx`
      casaría con medio disco. Estas filas **compiten por parecido con las apps**: el motor junta las
      `filas` de todos los handlers, las ordena por `similitud` (escala de `fuzzy()`, 2000 =
      idéntico) y esa lista única ocupa UN turno de la intercalación (`mezclarPorSimilitud`). Las
      apps devuelven `filas` con `scoreApp / PESO_NOMBRE`, o sea en la misma escala: una app y un
      fichero que se llaman igual empatan y gana la app (sort estable, apps encabezan las fuentes:
      el handler de ficheros puntúa 0.6 sin extensión, por debajo de su 0.75); un fichero que se
      llama exactamente como lo tecleado sale antes que una app que solo empieza así.
    - Un binario sin extensión con el bit se ejecuta tal cual desde su carpeta (`case null` de
      `comandoEjecutable`), cuenta para `seEjecuta` (ofrece «como root»), se pinta con
      `application-x-executable` (por nombre saldría `octet-stream`) y su ficha dice `BINARIO`.
      Sin el bit, `xdg-open` como cualquier otro fichero.
    - Las carpetas son las mismas que con extensión: **no se busca en el `PATH`**. `/usr/bin` son
      miles de binarios que ya tienen su `.desktop` cuando son apps, y pondría `/usr/bin/firefox`
      delante de Firefox.
  - Los cuatro **ejecutables** (`EXTENSIONES`) se lanzan con su intérprete **desde su carpeta**
    (`python3`, `java -jar`; un `.sh` sin bit de ejecución va por `bash`; a un `.AppImage` sin bit se
    le pone con `chmod +x`); **cualquier otro fichero se abre con `xdg-open`**, o sea con la app
    predeterminada de su tipo. Todo por `launchApp`, así que también se ancla al escritorio.
  - **El usuario puede cambiar cómo se abre una extensión** (`orionComandosArchivo`, Ajustes >
    Orion > Cómo abrir cada extensión: `{ext, comando, terminal}`), y su regla **gana a todo**,
    intérpretes de fábrica incluidos. `comandoPersonalizado` sustituye `{archivo}`, `{nombre}` (sin
    extensión) y `{carpeta}` **ya entrecomillados** —así `gcc {archivo} -o {nombre} && ./{nombre}`
    funciona con espacios en la ruta—, añade `{archivo}` al final si la plantilla no lo nombra y
    corre desde la carpeta del fichero. Con `terminal` va dentro de `kitty --hold sh -c …`: sin
    ventana, la salida (o el error de compilación) de un `gcc` no llega a ningún sitio. Las filas de
    la lista **no tienen controles que editen en sitio**: cambiar la regla crea un objeto nuevo y el
    `<For>` destruiría el control desde su propio manejador; se edita con el lápiz, que copia la
    regla al formulario.
  - **«Mostrar ubicación» sale en la ficha de toda app y todo fichero; «Ejecutar como root», en las
    apps, en los cuatro ejecutables y en las extensiones con regla del usuario** (`seEjecuta`;
    abrir un PDF con su visor como root no es lo que nadie busca).
    Root es `pkexec env DISPLAY=… WAYLAND_DISPLAY=… XDG_RUNTIME_DIR=… XAUTHORITY=… sh -c …`
    (`pkexec` arranca con el entorno vacío y una app gráfica no encontraría la sesión) y espera con
    `esperarOrionOculto()` igual que desinstalar, por la misma capa OVERLAY. Ubicación abre
    `dolphin --select` sobre el binario real del `Exec`, o sobre el `.desktop` si el `Exec` es un
    envoltorio (`flatpak`, `steam`, `env`…) — señalar `/usr/bin/flatpak` no diría nada.
  - La ficha de un fichero (`rutaEjecutable` en `AppContextItem`) **no ofrece editar config,
    fijar ni desinstalar**: no hay `.desktop`, y los favoritos se resuelven por id de `.desktop`.
  - La carpeta bajo el nombre la acorta `carpetaCorta` (principio + `…` + final, con techo de
    caracteres) **y** lleva `maxWidthChars`: una ruta larga no puede ensanchar la layer, que no
    vuelve a encogerse sola.

  Un `execAsync` nuevo con `sh -c` para abrir una app es el modo de fallo aquí: no da error, solo
  deja de anclar. El interruptor es `anclarVentanasRofi` y lo lee el script, no este lado — dos
  lecturas del mismo ajuste podrían discrepar. Si el script falta, `launchApp` cae al `sh -c` de
  siempre: degradar a "se abre sin anclar" es preferible a "no se abre".
