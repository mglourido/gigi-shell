# CLAUDE.md — Indicadores de la barra

Parte de la guía de `ags/` (mapa de áreas en [`ags/CLAUDE.md`](../../../CLAUDE.md)). Aquí: actualizaciones, micrófono y capturas, cadena de estado y captura de pantalla.

- `modulos/barra/indicadores/sistema/Actualizaciones.tsx` — renderiza dos iconos independientes: núcleo (Tux naranja) y controladores de GPU (verde). Cada uno solo aparece cuando su categoría tiene pendientes; el resto figura como contexto dentro del popover. No sondea: `hypr/scripts/updates-monitor.sh` escribe `~/.config/gigishell/updates.json` y un `Gio.FileMonitor` compartido alimenta ambos iconos. Cada popover retiene únicamente la barra de su monitor mediante `ControlVisibilidadBarra`. `Barra.tsx` lo condiciona con `updatesMonitorEnabled`.
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
  `hypr/scripts/screencast-monitor.sh` escribe `~/.config/gigishell/screencast.json` y esto lo
  observa con un `Gio.FileMonitor` (patrón `Actualizaciones`). Tooltip: «Compartiendo pantalla ·
  Discord» / «Grabando pantalla · wf-recorder», una línea por tipo. **Sustituyó a `Recording.tsx`**,
  que hacía `pgrep -x wf-recorder` cada 2 s *por monitor* y no veía los screencasts por portal
  (Discord, OBS, navegador). Condicionado en `Barra.tsx` por `screencastIndicatorEnabled`, cuyo setter
  en `preferences.ts` es **maestro y en caliente**: lanza o mata el script.
