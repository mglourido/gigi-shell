# CLAUDE.md — Pantalla y brillo

Parte de la guía de `ags/` (mapa de áreas en [`ags/CLAUDE.md`](../../CLAUDE.md)). Aquí: cola de pantallas, reglas horarias, luz nocturna y los dos backends de brillo.

- `servicios/pantalla/` — cola de pantallas compartida por QuickSettings y Ajustes > Pantalla. `modes.ts` es la lógica pura (testeada con node); `service.ts` tiene el poller, `applyPatch` (aplica en vivo con `hyprctl eval 'hl.monitor{…}'` — bajo config Lua `hyprctl keyword` ya no existe) y la persistencia. **Persiste en UN solo fichero, `~/.config/gigishell/display.json`, que lee también el config del compositor** (`hypr/gigishell/pantalla.lua`: recorre `monitors` y emite un `hl.monitor{output="desc:…"}` por entrada, después del comodín de `gigishell/monitores.lua`). Hace falta porque sin nadie que aplique las prefs al cargar, un **`hyprctl reload`** releía el comodín — `preferred`/escala 1 — y tiraba la pantalla de 240 Hz a 60 y de escala 1.25 a 1, sin que AGS pudiera enterarse (no hay señal de recarga; el poller solo observa). **Antes esto se resolvía volcando además un `monitor-settings.lua` generado**, o sea el mismo dato escrito dos veces, un fichero machine-specific dentro del árbol de git y la `description` del EDID interpolada en un chunk Lua (una comilla suelta rompía la config entera). Consecuencia de que el JSON ya no sea solo nuestro: `saveMonitorPref` llama a **`saveDisplayConfigNow()`**, escritura síncrona, y no al debounce de 2 s que usa el resto — con la espera de por medio, un `hyprctl reload` justo después de tocar la resolución releería el fichero viejo y desharía el cambio. Detalle en `docs/hyprland-modulos.md` § «Hyprland structure» (`pantalla.lua`).
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
    a 80"). Es el mismo patrón que el bug de Bluetooth de `modulos/ajustes-rapidos/CLAUDE.md`: **estado que debe sobrevivir al proceso
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
    compositor. Es el mismo cuidado que documenta el `<For>` de `Escritorios.tsx` (`modulos/barra/CLAUDE.md`).
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
  fuera de este módulo**: las teclas `XF86MonBrightness*` de `hypr/gigishell/keybinds.lua` ya no lo llaman, van
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
