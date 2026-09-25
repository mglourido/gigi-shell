# Hyprland: estructura, GPU/pantalla/idioma y módulos individuales

Detalle completo de la estructura de `hypr/gigishell/*.lua` (perfil de GPU, dispositivos, pantalla, idioma) y
el porqué de cada script/módulo individual del sistema (Wake up, gaming-gate, USB, TLP, ClamAV, monitores de
recursos, etc). Referenciado desde `CLAUDE.md` — leer la sección correspondiente antes de tocar el script o
módulo que nombra su título. Para el mapa de directorios y orden de carga, ver `docs/hypr-estructura.md`.

## Hyprland structure

For the directory layout, the module load order, and which script fires from where, see
[`docs/hypr-estructura.md`](docs/hypr-estructura.md) — this section only covers the *why* behind
specific decisions, not a structural map.

**El razonamiento de abajo sigue vigente aunque la sintaxis haya cambiado**: `gigishell/*.lua` es un
port fiel de los `.conf`, así que donde se lea "`keybinds.conf`" o "un `source =`" hay que entender
su módulo equivalente. `hypr/hyprland.lua` is a thin entry point that loads the split modules
(`env`, `monitores`, `input`, `ventanas`, `animaciones`, `reglas`, `keybinds`, `autostart`,
`permisos`, …). Note:

- **GPU profile is machine-specific**: exactly one module under `hypr/gigishell/gpu/` is loaded
  (`laptop-hibrida.lua` / `sobremesa-nvidia.lua` / `integrada.lua` / …), y **ya no se descomenta a
  mano** — lo elige `~/.config/gigishell/gpu-perfil`, un fichero local de una línea fuera del repo que
  escribe el instalador (paso `gpu`) y que nunca se pisa si ya existe. `integrada.lua` es el «no
  hay nada que configurar» explícito de una Intel/AMD sola: sin él, la única forma de decirlo era
  dejar el fichero ausente, y eso disparaba el aviso de `gpu.lua` en cada inicio de sesión.
- `gigishell/dispositivos.lua` **lee `~/.config/gigishell/devices.json`** (Ajustes > Dispositivos, vía
  `ags/servicios/dispositivos/service.ts`) y se carga después de `gigishell/userprefs.lua` para pisar
  lo de ahí. Fichero ausente = no se aplica nada y manda `userprefs`. Los defaults del módulo son
  el espejo de `DEFAULT_DEVICE_SETTINGS` y solo entran por clave ausente o de tipo raro: AGS ya
  escribe el JSON normalizado. De ahí sale también el **tema del puntero** (ver la sección de
  hyprcursor, abajo).
- `gigishell/pantalla.lua` **lee `~/.config/gigishell/display.json`** (Ajustes > Pantalla, vía
  `ags/servicios/pantalla/service.ts`), recorre `monitors` y emite un `hl.monitor` por entrada
  **después de `gigishell/monitores.lua`**, cuya única regla es la comodín (preferido, escala 1).
  Resolución/Hz/escala/VRR/posición se aplicaban antes solo **en vivo** (`hyprctl keyword monitor`)
  y al arrancar AGS, guardándose únicamente en el JSON — que Hyprland no leía. Resultado: cualquier
  **`hyprctl reload`** releía los configs y devolvía la pantalla a modo preferido y escala 1
  (240 Hz → 60 Hz, 1.25 → 1), sin que AGS se enterara (no hay señal de recarga, y su poller solo
  observa). Las specs van por `desc:` (estable entre reconexiones, a diferencia de `DP-1`) y una
  spec concreta gana a la comodín. Efecto extra: el compositor ya arranca en el modo bueno, sin el
  parpadeo de la re-aplicación.
  **Por eso `saveMonitorPref` escribe SÍNCRONO** (`saveDisplayConfigNow`) y no por el debounce de
  2 s que usa el resto de `display.json`: el fichero dejó de ser solo de AGS, y un `hyprctl reload`
  disparado justo después de tocar la resolución releería el JSON viejo y desharía el cambio.
- **El idioma (LANG/LC_ALL) lo lee `gigishell/env.lua` de `~/.config/gigishell/datetime.json`** (clave
  `locale`, Ajustes > Región, fecha y hora). Antes AGS reescribía un bloque entre marcadores dentro
  del propio `env.lua`, que está **versionado**: estado de máquina ensuciando git, y un marcador
  tocado a mano dejaba el bloque huérfano con AGS añadiendo otro debajo. **Clave ausente = no se
  emite ningún `hl.env`** y manda el LANG de la sesión: poner uno de fábrica ahí cambiaría el idioma
  sin que nadie lo pida. Al portar una máquina que venía del esquema viejo hay que volver a elegir
  el idioma una vez en Ajustes (o escribir la clave a mano).
- Colour management (`render.cm_enabled`) is deliberately **off** because `hyprsunset` owns the
  KMS CTM for night light; enabling Hyprland's CM too washes out the image.

`hypr/gigishell/autostart.lua` launches the shell (`ags run ~/.config/ags/`), `hypridle`, `init.sh`,
`wallpaper.sh`, and a set of `hypr/scripts/*-monitor.sh` background daemons (battery, temp,
ram, disk, oom, wifi, usb, bt, screencast, updates). Todo ello cuelga de un
`hl.on("hyprland.start", …)`, que es el equivalente EXACTO de `exec-once`: se dispara una vez por
sesión y un `reload` **no** lo repite (medido). El código de nivel superior del config sí se
re-ejecuta en cada reload — esa es la semántica del viejo `exec =`, y es donde vive la llamada a
`GiGiShell.daltonismo()`. Use `hyprctl reload` for a normal config reload. To restart Hyprland
correctly —including re-running the autostart— use the newer `hyprctl reload full-reset`; a plain
reload does not restart those commands. Relaunch AGS separately when its code changes.

**El arranque está ESCALONADO, y `gigishell/autostart.lua` es el único sitio donde se lee el
calendario entero.** Todo esto salía a la vez y competía con la carga de Hyprland y del shell con la caché
fría. La regla: lo que se ve (wallpaper, AGS, `init.sh`) o lo que no puede perder eventos va a
t=0; lo que solo consulta el estado del PC se aparta — eventos a t=1..3,5 (bt, usb, wifi,
screencast, cámara, apps de inicio), sondeos a t=4..5,5 (ram, temp, batería, disco), y lo caro al
final (updates t=5, `boot-healthcheck` t=8, que antes esperaba 5 s por dentro). El calendario está
comprimido a propósito respecto al original (que llegaba a t=45): este equipo absorbe la carga, y
esperar medio minuto por el aviso de actualizaciones no compensaba. Van a segundos DISTINTOS a
propósito: darles a todos el mismo `sleep` solo movería la avalancha unos segundos más tarde.

**El retardo vive en el punto de llamada, no dentro de los scripts**, y eso es deliberado:
`screencast-monitor` y `updates-monitor` también los lanza AGS en caliente desde sus
interruptores de Ajustes (setter maestro = `pkill` + re-exec), así que un `sleep` interno haría
que encender el interruptor tardara y pareciera roto. La excepción es `oom-monitor.sh`, que se
escalona por dentro porque sus sub-monitores no corren el mismo riesgo (ver su sección).

**Editar un `*-monitor.sh` NO afecta al que ya está corriendo — hay que matarlo y relanzarlo.**
Son `exec-once`, así que viven desde el login; una recarga normal (`hyprctl reload`) **no** los
reinicia, mientras que `hyprctl reload full-reset` sí vuelve a ejecutar el autostart. Bash además
ya tiene el bucle parseado en memoria, de
modo que el proceso vivo sigue ejecutando el código **anterior** a tu edición: el fichero en disco
y lo que corre divergen sin ningún aviso. Se manifiesta como "mi cambio no hace nada" horas
después — así se coló una tanda de notificaciones de USB sin el hint `x-gigishell-source` cuando ya
estaba puesto en el script. Tras editar: `pkill -f ~/.config/hypr/scripts/<x>-monitor.sh` y
relanzarlo (`setsid nohup … &`), o cerrar sesión. Ojo al comprobarlo: `battery-monitor` y
`temp-monitor` **salen solos** si su toggle está a `false` en `preferences.json`, y `disk-monitor`
/ `wifi-monitor` no son daemons persistentes — que no aparezcan en `ps` no significa que fallen.

**`wifi-monitor` distingue tres desenlaces, y antes no.** Salía con un aviso **crítico** en cuanto
`nmcli` no le daba interfaz, sin mirar por qué, juntando dos casos opuestos: en un **sobremesa sin
wifi** (este equipo: solo `enp4s0`; ni `/sys/class/net/*/wireless`, ni entrada en `rfkill`, ni
tarjeta PCI) era un popup rojo en **cada login** anunciando que un hardware inexistente no existe
—ruido del que enseña a ignorar los críticos—; y en un **portátil** era una carrera que se
resolvía **mintiendo** (sale de un `exec-once` a la vez que NetworkManager: perder la carrera
avisaba de "no hay WiFi" habiéndola, y dejaba la sesión sin monitor). Hoy: hay interfaz → vigila;
**no hay hardware → sale en silencio** (se mira `/sys/class/net/<if>/wireless`, que lo publica el
**kernel** y no depende de NM, así que no reintroduce la carrera); hay antena pero NM no la
publica → reintenta 30 s y solo entonces avisa, que ahí sí es un problema real.

**Una vez con interfaz, es 100 % dirigido por eventos**: bloquea en `nmcli monitor` (D-Bus de
NetworkManager) y no sondea nada mientras está inactivo. La línea global `"Connectivity is now
'X'"` de `nmcli monitor` refleja la conectividad **primaria** de NetworkManager, no la de la wifi
en concreto — con cable y wifi a la vez ese evento puede venir del cable —, así que ante cualquier
cambio se reconsulta la conectividad **por interfaz** (`IP4-CONNECTIVITY` de `$IFACE`) y solo se
avisa de portal cautivo si el portal es el de la wifi. `LC_ALL=C` fuerza inglés en la lectura de
`nmcli monitor` porque sus palabras clave (`connected`/`disconnected`) son fijas en ese idioma
independientemente del locale del sistema — lo que ve el usuario por `notify-send` sigue en
español, definido aparte en las funciones `notify_*`. Si `nmcli monitor` muere (NetworkManager se
reinicia), el bucle exterior lo relanza en vez de dejar el daemon colgado para siempre.

### Wake up: la puerta `idle-action.sh` delante de hypridle

**Los `on-timeout` de `hypridle.conf` ya no llaman a la acción: llaman a
`hypr/scripts/idle-action.sh {dpms-off|lock|suspend}`**, que la ejecuta salvo que la función
**Wake up** del menú del logo Arch la esté vetando ("que el PC no se suspenda aunque no lo toque").
Hizo falta una puerta porque hypridle **no tiene API en caliente**: no se le puede desactivar un
listener suelto ni recargarle el config. Las dos alternativas se descartaron con motivo.
`systemd-inhibit --what=idle` (que hypridle sí respeta) apaga **todos** los listeners a la vez, y
entonces "que no se suspenda **pero la pantalla sí se apague**" —el modo por defecto— es
inexpresable. Y reutilizar el `# GIGISHELL-OFF` que ya sabe comentar listeners (Ajustes > Pantalla)
significaría **escribir en el config del usuario** para un estado temporal: si AGS muere a mitad,
sus tiempos quedan desactivados para siempre y la UI de Ajustes los enseña apagados, confundiendo
"lo apagué yo" con "lo apagó el Wake up".

**Alcance**: Wake up a secas veta **solo `suspend`** — la pantalla se apaga a los 10 min y bloquea
a los 11, como siempre. Con la subopción **Pantalla** veta además `dpms-off` **y `lock`**: el
bloqueo va atado a la pantalla porque hyprlock la taparía, que es justo lo que la opción evita.
`on-resume` **no** pasa por la puerta: encender la pantalla al volver no se veta nunca, y es lo
único que la despierta si vuelves con el ratón (`mouse_move_enables_dpms = false` en
`gigishell/ventanas.lua`; solo una tecla la enciende por su cuenta).

**Estado**: `~/.config/gigishell/wakeup.json`, `{active, until, screen, pid}`, escrito por AGS
(`ags/servicios/energia/mantenerDespierto.ts`) y leído por el script — misma dirección que
`runtime-state.json`, no al revés que los `*-monitor.sh`. `until` es **epoch absoluto**, no un
contador: así la puerta resuelve la caducidad sola contra el reloj de pared aunque nadie reescriba
el fichero, y la cuenta atrás no se desfasa tras una suspensión manual (los timeouts de GLib no
corren dormidos). `pid` es el de AGS y la puerta comprueba que sigue vivo.

**Todo error ejecuta la acción (fail-open), y esa asimetría es el diseño**: sin fichero, con JSON
corrupto, sin `jq`, con el pid muerto o con el plazo vencido, la acción sale. Un fallo aquí debe
degradar a "el Wake up no funciona" —visible y arreglable— y nunca a "el PC no se suspende jamás",
que es silencioso, permanente, se come la batería y **no tiene UI donde apagarse** si AGS ya no
está. Por eso hay dos guardas encadenadas y no una: el `pid` cubre "AGS murió y no volvió", pero
los pid **se reciclan** —tras un reinicio el del AGS anterior puede estar ocupado por otro proceso
vivo y la puerta lo daría por bueno—, así que además `initWakeUp()` **limpia el JSON al arrancar**
el shell. El Wake up es por sesión, como el resto del menú de funciones.

**Al caducar se reinicia hypridle** (`pkill hypridle; hypridle &`, el mismo gesto que ya hace
`ags/modulos/ajustes/pantalla/Inactividad.tsx` al guardar los tiempos). No es opcional: hypridle **no repite un `on-timeout`
ya disparado** en esa tanda de inactividad, así que un Wake up de 30 min que veta la suspensión en
el minuto 11 y caduca en el 30 dejaría el PC despierto **para siempre** — nadie volvería a
intentarlo hasta que tocaras el teclado. Reiniciarlo rearma los contadores desde cero: se suspende
~11 min después de caducar, y nunca estando tú delante. El peaje aceptado es ese margen extra.

**Si tocas los `on-timeout`, mira `kindOf()`** en `ags/servicios/pantalla/hypridle.ts`: Ajustes >
Pantalla reconoce los tres listeners **por su comando**, y ahora los tres nombran el mismo script
—los distingue el argumento—. Si dejara de reconocerlos, sus tiempos se volverían ineditables **en
silencio** (`parseHypridle` degrada a "no encontrado", no a un error). Sigue leyendo también el
formato directo (`hyprctl dispatch dpms off` / `hyprlock` / `systemctl suspend`) para un config
traído de otra máquina. Cubierto por `hypridle.test.ts`.

**Desactivar un tiempo se hace comentando la línea, NUNCA con `timeout = 0`.** Cada fila de Ajustes
> Pantalla lleva un interruptor que apaga *ese* listener (`FilaInactividad` en
> `ags/modulos/ajustes/pantalla/Inactividad.tsx` →
`writeHypridle(…, {enabled:false})` → `# timeout = N   # GIGISHELL-OFF`). El 0 no es una forma pobre de
decir "nunca": es lo contrario. Medido en hypridle 0.1.7 — con `timeout = 0` el listener **se
registra y se dispara al instante** (`Registered timeout rule for 0s`, y la acción ejecutada ya), o
sea que ponerlo en la fila "Suspender" apagaría el PC nada más guardar. Comentado, hypridle saca un
`Category has a missing timeout setting`, **ignora ese listener y sigue con los demás** (también
medido) — y el valor sobrevive dentro del comentario, así que al reencender vuelve el número del
usuario. De ahí el suelo de 1 min al leer el fichero: un listener ausente parsea a `{timeout: 0}`, y
ese 0 llegaría al `.conf` al encender la fila. **El estado del interruptor sale de `parseHypridle`,
no de un `true` fijo**: cuando la UI escribía `enabled: true` a pelo, mover cualquier stepper
reescribía los tres listeners como activos y resucitaba en silencio un GIGISHELL-OFF ya puesto.

**"Bloquear" (el listener) y "Bloquear al suspender" (`before_sleep_cmd`) son ajustes distintos, y
confundirlos costó un bug.** Con el listener de bloqueo apagado, al despertar de una suspensión
seguía apareciendo hyprlock: quien lo pone ahí es `before_sleep_cmd = loginctl lock-session` del
bloque `general`, que **no** cuenta inactividad — lo dispara logind ante *cualquier* suspensión
(el listener de suspender, el menú de energía, el botón físico, cerrar la tapa, un `systemctl
suspend` a mano). No tenía interruptor, así que no había forma de suspender sin bloquear. Ahora lo
gobierna el último interruptor de la tarjeta (`writeBloqueoAlSuspender` en
`ags/servicios/pantalla/hypridle.ts`), que comenta la línea con el mismo sentinel GIGISHELL-OFF para
conservar el comando escrito. Ojo al tocar ese regex: `after_sleep_cmd` comparte sufijo con
`before_sleep_cmd` y es lo único que vuelve a encender la pantalla al despertar.

### Bloquear la pantalla: un solo camino (`bloquear.sh`) y la cola de fondos

`hyprlock` **no se llama nunca directamente**. Los cinco sitios que bloquean la sesión —
`lock_cmd` de `hypridle.conf`, `lock_screen()` de `idle-action.sh`, la acción `bloquear` de
`gigishell/boton-apagado.lua`, el botón «Bloquear» del menú de energía de AGS
(`modulos/menu-energia/acciones.ts`) y la suspensión falsa — entran por
`hypr/scripts/bloquear.sh`, que avanza la cola de fondos y hace `exec hyprlock`.

**Por qué el sorteo no puede vivir en `hyprlock.conf`.** `hyprlock.conf` es hyprlang y hyprlang
**no tiene sustitución de comandos**. El `cmd[update:N]` que usan las etiquetas de la hora es una
característica del widget `label`, no del parser, y `background` no la admite: cuando hyprlock lee
su config, la ruta del fondo ya tiene que estar escrita. Por eso alguien tiene que decidirla antes,
y ese alguien es el script.

**El enlace del fondo no lleva extensión, y es a propósito.** `background { path = ... }` apunta a
`~/.cache/gigishell/hyprlock-fondo`, un symlink que `fondo-bloqueo.py` reapunta a un `.jpg`/`.jpeg`/`.png`/
`.webp` de `Wallpapers/`. Con los cuatro formatos mezclados, un enlace con extensión fija
mentiría la mitad de las veces. Funciona porque hyprlock 0.9.6 carga las imágenes por
**hyprgraphics**, que enlaza **libmagic** y decide el formato por los bytes del fichero, no por el
nombre — comprobable con `ldd /usr/lib/libhyprgraphics.so.4 | grep magic`. Ojo si algún día se
sustituye ese cargador: el fallo sería mudo (fondo negro, bloqueo por lo demás correcto).

Está en la **caché** y no en `~/.config/gigishell/` porque no es una preferencia de nadie;
borrarlo no rompe nada, el siguiente bloqueo lo repone. En la misma caché queda la cola
barajada: hyprlock cambia cada 30 s con fundido, no repite antes de agotar una vuelta y
continúa los pendientes tras desbloquear y volver a bloquear.

**La selección no puede impedir el bloqueo.** Carpeta vacía, sin Python, sin
permisos de escritura en la caché: da igual, se bloquea igual con el fondo anterior o sin fondo. Un
bloqueo de pantalla que no llega a ponerse porque no encontró una imagen bonita deja la sesión
abierta, que es infinitamente peor que un rectángulo negro.

La tarjeta meteorológica se añade mediante `hyprlock-tiempo.conf` solo si
`datetime.json` permite la ubicación y guarda coordenadas válidas. La consulta a
Open-Meteo ocurre después de aparecer el bloqueo y se repite cada diez minutos;
si no hay red, la tarjeta muestra que el dato no está disponible.

**La guarda de instancia única se mudó al script, y ahora es una sola.** hyprlock no la tiene
(0.9.6: ni siquiera una cadena "already running" en el binario), así que llamarlo con uno ya puesto
arranca un segundo proceso encima del bloqueo — y duplicarlo pasa solo: el listener bloquea a los
11 min y el `before_sleep_cmd` vuelve a bloquear al suspender. Antes el `pidof hyprlock` estaba
copiado en cada llamador; hoy vive una vez en `bloquear.sh`. La copia que queda en
`boton-apagado.lua` (`bloqueado()`) es redundante a propósito: allí también sirve para no abrir el
menú de energía por debajo del bloqueo.

**El `exec` final no es cosmético.** Si el script se quedara de padre, el proceso visible sería
bash y `pidof hyprlock` no vería nada: la guarda dejaría de proteger de la siguiente llamada.

**Dos trampas de los llamadores**, las dos silenciosas:

- **AGS no ejecuta con una shell.** `execAsync` parte la cadena con `GLib.shell_parse_argv`, que
  **no expande la `~`**. Por eso la acción del menú de energía va envuelta en `sh -c '...'`; sin él
  se intentaría ejecutar un fichero llamado literalmente `~/.config/hypr/scripts/bloquear.sh` y el
  botón no bloquearía nada. `hypridle.conf` sí pasa por shell, así que allí la `~` va pelada, igual
  que en el resto de sus comandos.
- **El nombre del script no contiene «hyprlock»**, y `ags/servicios/pantalla/hypridle.ts` clasifica
  los listeners con un patrón `/hyprlock/` entre sus reglas. No afecta: el listener de bloqueo va
  por `idle-action.sh lock`, que casa antes con la regla de la puerta (`GATE_ACTIONS`), y `lock_cmd`
  no lo lee esa función. Pero si algún día un listener llamara a `bloquear.sh` directamente, Ajustes
  > Pantalla dejaría de reconocer la fila **sin dar ningún error**: habría que añadir el patrón.

### Salir de suspensión: la pantalla en negro y el toggle disfrazado de `on`

**Síntoma medido** (25-08-2026): al volver de suspensión la pantalla se encendía y, entre 0,1 s y
16 s después, **se ponía negra otra vez**. Ni el ratón ni las teclas la recuperaban; solo volvía al
**cambiar de workspace**. A veces era solo un **parpadeo de ~200 ms**, y a veces no pasaba nada:
intermitente y por eso difícil de creer. No lo causaba la suspensión, ni un fallo de modeset, ni el
orden en que logind reactiva el asiento.

**La causa: `hl.dsp.dpms('on')` es un TOGGLE.** El argumento tiene que ser una TABLA; con un string,
`Internal::tableToggleAction()` (Hyprland `src/config/lua/bindings/LuaBindingsInternal.cpp:444`)
sale por su primera línea —`if (!lua_istable(L, idx)) return CA::TOGGLE_ACTION_TOGGLE`— y el
`'on'` **ni se lee**. `hyprctl` responde `ok`. Así que el `on-resume` y el `after_sleep_cmd`, cuyo
único trabajo era ENCENDER la pantalla, la apagaban siempre que ya estuviera encendida — y al
despertar suele estarlo, porque la enciende antes el propio restore de sesión de Hyprland.

**Por qué quedaba pegada en negro, y no solo un instante.** Dos pestillos se quedan mintiendo:

- `Actions::dpms(ENABLE)` deja `g_pCompositor->m_dpmsStateOn = true`, y `InputManager` solo
  enciende la pantalla al teclear `if (… && !g_pCompositor->m_dpmsStateOn)`. Con el pestillo en
  `true`, **el teclado deja de despertarla** (y el ratón nunca pudo: `mouse_move_enables_dpms =
  false`).
- `CMonitor::setDPMS()` empieza por `if (m_dpmsStatus == on) return;`, así que un `dpms on`
  posterior tampoco vuelve a hacer commit del output.

Con los dos flags diciendo "encendida", solo forzar un commit nuevo la recuperaba — de ahí que
funcionara **cambiar de workspace** y nada más. La intermitencia era el número de toggles que
llegaban a caer en cada despertar: par → encendida, impar → negra.

**El arreglo, y por qué la tabla NO va en `hypridle.conf`.** Meter `{ action = 'on' }` en un
listener rompería el parser de Ajustes (`listener\s*\{[^}]*\}` se corta en la primera `}`), que es
exactamente el motivo por el que alguien escribió el string en su día: **el workaround del parser
introdujo el bug**. Por eso el comando con llaves vive en `idle-action.sh`, y el `.conf` solo nombra
acciones del script:

- `after_sleep_cmd` y el `on-resume` del listener de dpms → `idle-action.sh dpms-on`.
- `dpms-on` es la única acción del script que **no** consulta al Wake up: encender la pantalla no se
  veta nunca (misma regla fail-open que el resto del script).
- De paso desapareció el `| grep -q "^ok" || hyprctl dispatch dpms on`: el repliegue no podía
  dispararse jamás, porque el toggle devolvía `ok` incluso haciendo lo contrario de lo pedido.

**Lo que hay que llevarse de aquí:** la regla de la migración a Lua era "mira el stdout (`ok`), no
el rc". **Este fallo la burla**: rc 0, stdout `ok`, y la acción invertida. Si un dispatcher
conmutable no hace lo que dice, comprueba antes que nada que le estés pasando una tabla.

### Hibernación (`system/hibernacion/` + `servicios/energia/hibernacion.ts`)

Ajustes > Pantalla > Suspensión enseña **un solo número** ("Hibernar tras N min"), y por debajo hay
**dos mecanismos distintos**. Antes de tocar nada, la razón:

> **Durante una suspensión (S3) el userspace está CONGELADO.** hypridle no cuenta, AGS no cuenta,
> ningún script cuenta. Un `listener { timeout = 3000 }` de hibernación conviviendo con una
> suspensión a los 20 min **no se dispara jamás**: el equipo se duerme a los 20 y ahí se queda,
> sin un solo error. Lo único que sigue contando con el equipo dormido es el **reloj de la placa**.

De ahí las dos rutas, que elige `planificar()` (`servicios/energia/planHibernacion.ts`, puro y con
tests) a partir del total pedido y de la suspensión **vigente**:

| caso | modo | quién cuenta |
|---|---|---|
| hay suspensión y el total es **mayor** que ella | `retardo` | systemd: `suspend-then-hibernate` arma una **alarma RTC** a `HibernateDelaySec`, el equipo despierta solo y se hiberna. El listener de hypridle queda apagado. |
| no hay suspensión, o el total es **menor o igual** | `listener` | el listener `hibernate` de `hypridle.conf`, hibernando directo sin pasar por el S3. |

**El retardo es la RESTA, no el total.** `HibernateDelaySec` cuenta *desde que se suspendió*, así
que con suspensión a los 20 y hibernación a los 50 el retardo son 30. Poner ahí el número del
usuario hibernaría 20 minutos tarde — y como el efecto solo se ve a la hora larga y sin nadie
delante, nadie lo notaría. Hay un test para eso.

Regalo del modo `retardo`: cubre también las suspensiones que **no** vienen de la inactividad
(tapa, botón de encendido, menú de energía), porque quien hiberna es systemd y no nosotros.

**Quién guarda qué** (tres sitios, y solo uno es la autoridad):

- `~/.config/gigishell/hibernacion.json` — **la autoridad**: `enabled`, `totalSeconds`, `modo`. Lo
  escribe AGS y lo lee `idle-action.sh` para decidir si suspende con alarma o sin ella.
- el listener `hibernate` de `hypridle.conf` — **espejo** del total; solo está *encendido* en modo
  listener. Su `enabled` NO significa "¿hiberna el equipo?".
- `/etc/systemd/sleep.conf.d/99-gigishell-hibernacion.conf` — `HibernateDelaySec`, escrito por
  `/usr/local/bin/gigishell-hibernacion` (root, vía sudoers acotado). Se reescribe **siempre**,
  incluso a 0 (que borra el drop-in): dejar uno viejo al apagar la hibernación haría que cualquier
  `suspend-then-hibernate` ajeno siguiera hibernando con el tiempo antiguo.

**El reparto se recalcula en CADA escritura de tiempos**, no una vez al guardar: depende del tiempo
de suspensión, y el **modo ahorro lo cambia sin que el usuario toque nada**. Por eso
`conHibernacion()` va acoplado dentro de `inactividadAhorro.ts` — entrar y salir del ahorro
replanifica, y todo cae en una sola escritura del fichero y un solo reinicio de hypridle.

**`kindOf()` mira `hibernate` ANTES que `suspend`.** `systemctl suspend-then-hibernate` casa con
los dos patrones; al revés, ese listener se leería como suspensión y su tiempo saldría en la fila
equivocada de Ajustes, sin ningún error.

#### Habilitarla: el paso `hibernacion` del instalador

Una máquina normal **no puede hibernar**, y lo descubre tarde. Tal como estaba esta:

```
swapon --show  → solo /dev/zram0   ← zram vive EN LA RAM. Volcar la RAM a la RAM no es nada.
/proc/cmdline  → sin resume=       ← sin eso el kernel arranca en frío y la sesión se pierde.
```

`bash install.sh --solo hibernacion` lo monta: swapfile persistente (en btrfs, **subvolumen
propio** — un swapfile dentro de `@` acabaría capturado por un snapshot de snapper y btrfs se
niega a activar un swapfile con más de una referencia, así que `swapon` empezaría a fallar el día
del primer snapshot, no hoy), entrada en `/etc/fstab` con `pri=-2` (por debajo de zram: el
swapfile está para hibernar, no para paginar), `resume=`/`resume_offset=` en GRUB, e initramfs
regenerado. Va **aparte** del paso `sistema` porque crea un fichero de varios GiB y reescribe la
línea de comandos del kernel: eso tiene que poder omitirse.

- **No hace falta el hook `resume` de mkinitcpio**: `HOOKS` lleva `systemd`, y ahí quien resume es
  `systemd-hibernate-resume-generator` leyendo `resume=`.
- **NVIDIA**: sin `NVreg_PreserveVideoMemoryAllocations=1` y los servicios
  `nvidia-{suspend,hibernate,resume}`, hibernar "funciona" y lo que falla es el **despertar**
  (pantalla negra o cuelgue), ya con la sesión restaurada y sin nada que apunte a la GPU.
  `NVreg_TemporaryFilePath=/var/tmp` no es cosmético: el defecto es `/tmp`, que es un **tmpfs**, y
  guardar la VRAM en RAM mientras se intenta escribir la RAM entera al swap es lo contrario de lo
  que hace falta.
- **`resume=` solo entra al REINICIAR.** Hasta entonces `gigishell-hibernacion estado` sigue diciendo
  `disponible=no` y la fila de Ajustes sale apagada con su motivo. No es un fallo del paso.
- En esta máquina el paso destapó además que `GRUB_CMDLINE_LINUX_DEFAULT` estaba **anidado dentro
  de sí mismo** (`="GRUB_CMDLINE_LINUX_DEFAULT='nowatchdog … loglevel=3' nvidia_drm.modeset=1"`),
  así que el kernel recibía ese trozo como **un** parámetro entrecomillado y `nowatchdog`, `splash`
  y `loglevel` llevaban sin aplicarse quién sabe cuánto. El setup lo desanida antes de añadir nada:
  meter `resume=` en un valor así lo habría dejado dentro de las comillas, y el equipo habría
  hibernado para arrancar en frío perdiendo la sesión, sin un solo mensaje.

**Nada de esto se asume: se pregunta.** `gigishell-hibernacion estado` consulta `CanHibernate` a
logind (que es quien mira swap **y** `resume=`), y si dice que no, la fila sale apagada **con el
motivo escrito**. `preflight.sh` avisa del caso contrario — el ajuste encendido en un equipo que
dejó de poder hibernar —, que es el que fallaría de madrugada sin testigos.

#### Desde la propia UI: preparar / quitar, sin pasar por la terminal a mano

Ajustes > Pantalla > Suspensión no solo enseña el tiempo: cuando `CanHibernate` dice que no,
la fila cambia por un botón **«Preparar hibernación…»**; cuando dice que sí, por
**«Quitar hibernación…»**. Los dos son mutuamente excluyentes con el selector de minutos, igual
que la fila «No disponible» que sustituyen.

Ninguno de los dos pasa por una regla `sudoers` NOPASSWD — a propósito. Crear o borrar un
fichero de varios GiB y reescribir la línea de comandos del kernel no es algo que un clic
silencioso deba poder hacer. En vez de eso, `abrirEnTerminal()` (`utilidades/abrirTerminal.ts`,
compartido con el botón de «Actualizaciones» de la barra que lanza `sudo pacman -Syu`) abre una
terminal de verdad y dentro `sudo` pide la contraseña como en cualquier uso manual:

- **Preparar** lanza `install.sh --solo hibernacion` (el mismo paso del instalador).
- **Quitar** lanza `system/hibernacion/gigishell-hibernacion-quitar.sh`, el simétrico del setup:
  `swapoff` primero (es lo único que se nota SIN reiniciar — `CanHibernate` mira el swap
  *activo*, no lo que diga fstab), borra el subvolumen `/swap` completo si solo contiene el
  swapfile (si hay algo más dentro, avisa y borra solo el fichero), quita `resume=`/
  `resume_offset=` de GRUB y regenera `grub.cfg`, desactiva únicamente los dos servicios de
  NVIDIA que son puramente de hibernación (`nvidia-hibernate`,
  `nvidia-suspend-then-hibernate`) — **no** `nvidia-suspend`/`nvidia-resume`, que conservan la
  VRAM en cualquier S3 y no tienen nada que ver con lo que se desinstala —, y regenera el
  initramfs. Dejar `/usr/local/bin/gigishell-hibernacion` y su sudoers instalados es intencional:
  sin swap ni `resume=` no hacen nada por sí solos, y quitarlos obligaría a reinstalarlos para
  poder volver a intentarlo.

Las dos vuelven a llamar a `comprobarHibernacion()` en cuanto la terminal se cierra, así que la
fila refleja el estado nuevo sin reabrir el panel de Ajustes.

### Diálogo de contraseña de root: hyprpolkitagent, y por qué sigue siendo feo

El agente de polkit —la ventanita que pide la contraseña al necesitar root— **ya es
hyprpolkitagent**, lanzado desde `gigishell/autostart.lua`; `polkit-kde-agent` está instalado como
arrastre de Plasma pero no corre ni publica servicio D-Bus. O sea que **no hay ninguna migración
pendiente desde KDE**: si alguien vuelve a plantearla, la respuesta es que ya está hecha.

**No se puede personalizar con la versión de los repos, y el README de GitHub dice lo contrario
porque documenta `main`.** Upstream reescribió el agente de Qt/QML a hyprtoolkit, pero esa
reescritura **no tiene tag** (el último sigue siendo v0.1.3), así que `extra/hyprpolkitagent` es el
Qt viejo: 4 ficheros, ninguno de configuración, y el QML **compilado AOT dentro del binario**
(se ve en los símbolos, `QmlCacheGeneratedCode::_qt_qml_hpa_qml_main_qml`). No hay fichero que
editar ni ruta que sobreescribir. Leer la doc de `main` ejecutando el tag viejo es el modo de
fallo de esta sección.

**La configuración ya está escrita y esperando**: `hypr/hyprtoolkit.conf` (paleta, espejo de
`ags/estilos/_colores.scss`) y `hyprpolkitagent/hyprpolkitagent.conf` (geometría). El primero **no
está inerte**: hyprtoolkit 0.5.4 de repos trae el mismo lector, así que esa paleta ya la aplica
`hyprland-guiutils`. El día que taguen el release, el diálogo de polkit se suma sin tocar nada.

**Se probó la vía AUR y se revirtió a propósito. No lo repitas sin leer esto.** Funcionó —el
diálogo salía con la paleta— pero el coste de mantenimiento era desproporcionado para una mejora
estética, y el mecanismo es concreto: el `hyprtoolkit-git` que hay que instalar tiene **el mismo
nombre y versión que el de chaotic-aur**, así que no cuenta como paquete foráneo (`pacman -Qm` no
lo lista) y **un `-Syu` normal lo reemplaza por el de chaotic en cuanto publiquen una revisión
nueva — y ese depende de `aquamarine-git`**, o sea que el backend de render de Hyprland salta a
rama de desarrollo por pura resolución de dependencias. En paralelo, `hyprpolkitagent-git` se
recompila en cada `-Syu` contra la hyprtoolkit del momento, y ese acoplamiento entre dos ramas sin
ABI estable es exactamente lo que falló al intentarlo (`setText`/`setPassword`/`eyeIcon`/
`setEnabled` no existen en 0.5.4). Cuando eso pase en un `-Syu` de rutina falla **callado**, y lo
que se queda roto es el agente de autenticación.

**Lo medido durante la prueba, para no redescubrirlo:**

- **El binario CAMBIA DE SITIO entre versiones.** En el 0.1.3 de repos es
  `/usr/lib/hyprpolkitagent/hyprpolkitagent` (directorio con el ejecutable dentro); en la
  reescritura, `/usr/lib/hyprpolkitagent` **es** el ejecutable. `gigishell/autostart.lua` apunta a la
  primera. Equivocarse no da ningún error: `hl.exec_cmd` falla en silencio y la sesión se queda sin
  agente, cosa que no se nota hasta que algo pide root a mitad de sesión.
- **`window_width` no hace nada** (A/B en 0.1.3.r11): la ventana sale a 460 px pidiendo 500 y
  pidiendo 700, porque el ancho lo fija el contenido. `window_height` sí manda, con un +8 constante.
- **El PKGBUILD de AUR de hyprtoolkit-git exige la cadena `-git` entera** (aquamarine, hyprgraphics,
  hyprwayland-scanner) por conservadurismo del mantenedor, no por necesidad: hyprtoolkit `main`
  compila y enlaza contra las versiones de repos y produce el **mismo soname**
  (`libhyprtoolkit.so.5`), que es lo que necesita `hyprland-guiutils`.
- La otra salida sería escribir el agente dentro de AGS (es un objeto D-Bus
  `org.freedesktop.PolicyKit1.AuthenticationAgent` más `polkit-agent-helper-1` para el PAM). Se
  descartó: son cientos de líneas para lo que 18 claves de config darán gratis al llegar el release.

### Botón de encendido: `gigishell/boton-apagado.lua` + `system/logind.conf.d/`

Ajustes > Energía decide qué hace la pulsación **corta** del botón físico (apagar, suspender,
hibernar, bloquear, apagar la pantalla, abrir el menú de energía, cerrar sesión, reiniciar o
nada). Lo ejecuta `GiGiShell.boton_apagado()` (`hypr/gigishell/boton-apagado.lua`) desde el bind de
`XF86PowerOff` con **`{ locked = true }`** en `gigishell/keybinds.lua` — `locked` (el viejo `bindl`)
porque el botón tiene que responder también con hyprlock puesto, que es justo cuando más se pulsa.
Era un script de bash (`boton-apagado.sh`); se inlineó al migrar a Lua, y con él desapareció la
doble indirección bind → bash → `hyprctl dispatch`.

**El shell NO ejecuta la acción, solo guarda la elección** (`botonApagado` en
`preferences.json`), y el config la relee **en cada pulsación** (`util.leer_json`, no la caché de
`util.prefs()`). Así el botón sigue funcionando
con AGS caído (con la acción de fábrica, `apagar`) y cambiar el ajuste no necesita relanzar nada
— se aparta de la advertencia general de los `*-monitor.sh` porque no hay proceso vivo. La única
acción que sí pasa por AGS es `menu`, vía `ags request toggle-power-menu`, y bajo hyprlock **no
se hace**: el menú quedaría dibujado por debajo del bloqueo y abierto al desbloquear.

**Sin ceder la tecla, el bind se ejecuta pero NO se nota — y ese es el modo de fallo.**
`systemd-logind` maneja esa misma tecla por su cuenta (`HandlePowerKey`, **`poweroff` de
fábrica**) a nivel de **asiento**, leyendo el evento de entrada sin pasar por el compositor. O
sea que las dos acciones ocurren a la vez y gana el apagado de logind: elijas lo que elijas, el
PC se apaga, y sin ningún error por ningún lado. De ahí `system/logind.conf.d/99-gigishell-powerkey.conf`
(`HandlePowerKey=ignore`), que como la regla udev de USB y el `i2c-dev` va a `/etc` y **no se
symlinkea**: lo copia `install.sh` (paso 9) y recarga con **`systemctl reload systemd-logind`**
— `reload`, no `restart`, que puede llevarse la sesión por delante. La pulsación **larga** se
deja como esté (`HandlePowerKeyLongPress`, `ignore` por defecto): es la salida de emergencia del
firmware y no debe depender de que el shell responda.

**La UI comprueba la propiedad REAL de logind, no la presencia del fichero**: `busctl --system
get-property … HandlePowerKey` (sin privilegios), en `ags/servicios/energia/botonEncendido.ts`.
El fichero puede estar en otro sitio, o el valor cambiado a mano, así que preguntar a logind es
la única respuesta que no miente. El aviso solo sale cuando la elección **de verdad no puede
cumplirse**: con `apagar` el resultado es el mismo venga de quien venga, y avisar ahí sería ruido.
Un `null` (no se pudo consultar) **no** avisa — no poder comprobarlo no es saber que está mal.

### Tapa del portátil: `gigishell/tapa.lua` + `tapa-inhibidor.sh` (y por qué aquí NO se toca `/etc`)

Ajustes > Energía decide qué hace **cerrar la tapa**: suspender (de fábrica), suspensión falsa,
hibernar, bloquear, apagar la pantalla, apagar el equipo o nada. La ejecuta `GiGiShell.tapa_cerrada()`
(`hypr/gigishell/tapa.lua`) desde el bind `switch:on:Lid Switch` de `gigishell/keybinds.lua`, con
**`{ locked = true }`**: la tapa se cierra sobre todo con la sesión ya bloqueada.

Reparto de trabajo idéntico al del botón de encendido: **el shell solo guarda la elección**
(`accionTapa` en `preferences.json`) y el config la **relee en cada cierre** (`util.leer_json`, no
la caché de `util.prefs()`), así que cambiar el ajuste no relanza ni recarga nada. Y no solo el
reparto: `tapa.lua` **toma prestada la tabla de acciones de `boton-apagado.lua`** en vez de copiarla,
para que "suspender" signifique exactamente lo mismo en los dos sitios — pasa por
`ags request suspend`, que es quien respeta el ajuste «sustituir la suspensión real por la falsa» —
y lo mismo "bloquear", que pasa por `bloquear.sh`. La toma por `__index` sobre una tabla vacía, no
por referencia directa: la extiende con una acción propia y escribir en la tabla del botón le
añadiría a *ese* menú una acción que su UI no ofrece.

Dos diferencias con el botón, y las dos son deliberadas:

- **El vocabulario está podado y ampliado.** Fuera `menu` (con la tapa cerrada sería un menú
  invisible esperando a que la abras), `reiniciar` y `cerrarSesion` (a ciegas, atados a un gesto
  que también se hace sin querer). Dentro `suspensionFalsa`, que el botón no ofrece: allí
  "suspender" ya entra en la falsa cuando el usuario la ha puesto a sustituir a la real; aquí se
  pide por su nombre y entra siempre. Va por el request **`suspension-falsa-entrar`** de
  `ags/app.ts`, que **ENTRA y no alterna**: cerrar la tapa estando ya dentro tiene que dejarla
  puesta, y `toggle-suspension-falsa` haría justo lo contrario — sacar de ella con la tapa cerrada
  y nadie delante de la pantalla.
- **Abrir la tapa enciende la pantalla SIEMPRE** (`switch:off:Lid Switch` → `GiGiShell.tapa_abierta()`),
  sin mirar la preferencia. Con la acción "Apagar la pantalla" no habría nadie más que la
  encendiera (`mouse_move_enables_dpms = false`, ver `gigishell/ventanas.lua`) y abrir la tapa a un
  panel negro se lee como que el portátil no ha despertado. En el resto de acciones es inofensivo.
  ⚠️ La forma es la **tabla** (`hl.dsp.dpms({ action = "on" })`): el string es un toggle disfrazado
  — ver «Salir de suspensión» más arriba.

**Y aquí está lo que separa esta sección de la del botón: la tapa NO se le quita a logind desde
`/etc`.** `systemd-logind` gestiona el interruptor a nivel de asiento igual que la tecla de
encendido (`HandleLidSwitch`, **`suspend` de fábrica**), así que sin desactivarlo suspende pase lo
que pase y el bind no se nota. Con el botón eso se arregló con `HandlePowerKey=ignore` en
`/etc/systemd/logind.conf.d/`, y ahí es correcto: si el bind no responde, lo que se pierde es un
botón. Con la tapa, `ignore` es **permanente** y vale también para el saludador, para los TTY y
para una sesión caída: **cerrar el portátil en la pantalla de login lo dejaría encendido dentro de
la mochila**, y eso no da ningún síntoma hasta que quema.

La salida es un **inhibidor** de logind (`--what=handle-lid-switch --mode=block`), que **no necesita
privilegios** y solo vale mientras alguien lo sostiene. Lo sostiene
`hypr/scripts/tapa-inhibidor.sh`, lanzado a t=0 desde `gigishell/autostart.lua`. Tres detalles suyos
que no son casuales:

- Envuelve un **`tail --pid=<PID de Hyprland> -f /dev/null`**: bloqueado en el kernel (ni un
  despertar ni un sondeo) y termina en el instante en que Hyprland muere. **No** un `sleep infinity`
  ni el PID de la propia shell: con `KillUserProcesses=no` —el valor de fábrica— un proceso suelto
  **sobrevive al cierre de sesión**, y un inhibidor huérfano dejaría la tapa muerta para el usuario
  siguiente sin que nadie pudiera verlo.
- **Guarda de instancia única**, porque `hyprctl reload full-reset` sí re-ejecuta el autostart y
  apilaría un inhibidor por recarga (no rompe nada, pero deja `systemd-inhibit --list` ilegible).
- Si `systemd-inhibit` no está, o no hay un Hyprland al que atarse, **no toma el inhibidor y sale
  con 0**. El fallo degrada a «logind conserva la tapa y suspende al cerrarla», que es exactamente
  lo que hay que hacer cuando el escritorio no está delante. Mismo fail-open que el resto del
  repo: el cuerpo de `tapa_cerrada()` va en `pcall` y **cualquier error suspende**.

**La UI comprueba que el inhibidor esté PUESTO, no que exista un fichero** (`systemd-inhibit
--list`, sin privilegios, en `ags/servicios/energia/tapaPortatil.ts`), y busca además el nombre
`GiGiShell`: que otro programa esté inhibiendo la tapa por su cuenta no querría decir que nuestro bind
vaya a ejecutarse. Mismas dos reglas que en el botón — `null` (no se pudo consultar) **no** avisa, y
con `suspender` tampoco, porque el resultado es el mismo venga de quien venga.

**«No hacer nada si hay una pantalla externa» repone a mano lo que logind hacía gratis.**
`HandleLidSwitchDocked` es `ignore` de fábrica: con un monitor conectado, logind no suspende al
cerrar la tapa, porque cerrarla ahí suele ser seguir trabajando en la otra pantalla, no irse. Al
quitarle el interruptor esa regla **se perdía en silencio**, así que `tapa.lua` la reimplementa
sobre `hl.get_monitors()` (que solo enumera los habilitados): cualquier salida cuyo nombre no
empiece por `eDP`/`LVDS`/`DSI` es externa. La diferencia con logind es que aquí **es conmutable**, y
nace encendida para no cambiar el comportamiento heredado.

La tarjeta **no se pinta en un equipo sin tapa** (`/proc/acpi/button/lid` vacío). Es la excepción
al criterio de «la tarjeta se pinta siempre aunque no haya soporte» que siguen el brillo o las
firmas de ClamAV: allí el ajuste sigue significando algo y lo que falta es el backend; sin tapa
que cerrar, la pregunta no existe.

El nombre del dispositivo va **literal** en el bind. Hyprland compara la cadena tal cual contra
`"switch:on:" .. nombre` (no hay comodín), y `Lid Switch` es como llama el kernel al interruptor
ACPI de la tapa en cualquier portátil. Para ver el de una máquina concreta: `hyprctl devices`,
sección *Switches*. En un equipo sin tapa el bind simplemente no se dispara nunca.

### Notificaciones de los scripts: los hints `x-gigishell-source` y `x-gigishell-event`

**Todo `notify-send` de `hypr/scripts/` sale por `notificar <id> …`, de
[`lib/notif.sh`](../hypr/scripts/lib/notif.sh)**, que pone los dos hints: `x-gigishell-source:system`
(qué clase de notificación es) y `x-gigishell-event:<id>` (**cuál** de ellas es). El fichero se sourcea
con el mismo patrón que `lib/gaming-gate.sh`, con un respaldo inline que emite igual sin el id: sin
la librería se pierde la identidad del aviso, nunca el aviso.

**El `event` existe porque el `source` no bastaba para configurarlas por separado.** Con solo el
origen, «USB desconectado», «Disco casi lleno» y «Escalada de privilegios» eran indistinguibles
para el motor de reglas: mismo hint, y en 44 de las llamadas mismo `app_name` («notify-send»,
porque no pasaban `-a`). El único gancho que quedaba era el **título**, que cambia con el contenido
(`"RAM muy baja: 812MB disponibles"`, `"CPU sobrecalentada: 91°C"`) y con cualquier retoque de
redacción — o sea que silenciar un aviso concreto exigía escribir a mano una regla con un
`contains` frágil, y en varios casos ni eso, porque dos avisos distintos comparten prefijo. El id
es estable, no depende del texto, y **dos ramas del mismo suceso lo comparten a propósito** (el
singular y el plural de «ejecutable nuevo en Descargas»: quien silencia uno quiere los dos
callados). El catálogo de ids vive en
`ags/modulos/notificaciones/rules/catalogoSistema.ts` y es lo que pinta Ajustes > Notificaciones >
**Sistema**, con una fila por aviso; lo que el usuario cambia va a
`~/.config/gigishell/notif-sistema.json`. **Al añadir un aviso nuevo, da de alta su id en el
catálogo**: sin eso el aviso funciona igual, pero no aparece en Ajustes — que es lo único que se
pierde, y todo lo que esto pretendía ganar.

`lib/notif-agrupar.sh` es la capa ortogonal: `notif.sh` da IDENTIDAD, `notif-agrupar.sh` decide
CUÁNDO y CUÁNTOS avisos salen. El resumen de una ráfaga se emite con el **mismo id** que el aviso
individual.

El hint de origen no es decorativo: es lo que hace que el popup
salga con el **skin dunst** — esquinas rectas, marco de 3 px, monoespaciada y fondo sólido por
urgencia (azul `#285577` normal, `#900000` con marco `#ff0000` crítica, `#222222` baja), y **sin
nombre de app ni icono**, porque el `format` por defecto de dunst es `"<b>%s</b>\n%b"`. Las apps
normales conservan el diseño del shell. **Un script nuevo que se olvide del hint saldrá con el
diseño normal**, sin error ni aviso — es el único modo de fallo aquí.

**`-u warning` NO EXISTE, y las 16 notificaciones que lo usaban no salían nunca.** libnotify solo
acepta `low`, `normal` y `critical`; ante cualquier otra cosa `notify-send` escribe *«Unknown
urgency warning specified»* por **stderr** y sale con **rc=1 sin enviar nada** (medido en 0.8.8).
Como todas estas llamadas salen de daemons de fondo cuyo stderr no lo lee nadie, el fallo era
**mudo y total**: "Ejecutable nuevo en Descargas", "No se pudo analizar", "Salud de disco",
"Cambio en /boot", "Servicio fallido", "CPU Throttling" y "SSH" llevaban desde siempre
sin aparecer — el escáner de descargas avisaba de un ejecutable nuevo y no se veía. Todas están ya
en `normal` (el escalón intermedio no existe: o es rutina o es crítico). Al añadir una notificación,
**pruébala ejecutándola**: no basta con leerla, porque la línea parece correcta.

El hint no pinta nada por sí mismo: lo lee el **motor de reglas** (`match.source`), y quien pide
el skin es una regla builtin visible y desactivable desde Ajustes, **`builtin.system-dunst`**
(`ags/modulos/notificaciones/rules/defaults.ts`). Una regla de usuario de más prioridad la pisa —
para sacar del skin a algo del sistema, o para metérselo a una app normal. **Consecuencia
aceptada**: al estar cubiertas por una regla, las notificaciones de los scripts **no aparecen en
el historial** ("Detectadas"). Hoy eso ya no deja ninguna sin configurar —para eso está la pestaña
Sistema, que las enumera todas aunque no se hayan disparado nunca—, que era el problema real que
esa consecuencia arrastraba. Ver `ags/CLAUDE.md`.

Se eligió el hint y no "casar por nombre de app" porque 44 de las 47 llamadas no pasan `-a`, así
que llegan como app `notify-send`: filtrar por ahí le habría puesto el skin también a cualquier
`notify-send` lanzado a mano desde una terminal. El hint es inequívoco y no cambia el nombre que
se ve. Ojo al leerlo en AGS: se saca con `hints.lookup_value()` de la clave suelta, **no** con el
`extractHints()` que ya existe — ese hace `recursiveUnpack()` de todo el `a{sv}`, y un
`image-data` trae los píxeles en crudo; hoy solo se libra de ese coste porque únicamente corre
cuando una regla reescribe texto.

### Agrupar ráfagas de notificaciones (`lib/notif-agrupar.sh`)

**Los eventos no vienen de uno en uno, y una tarjeta por evento no es "informar": es tapar.** Un
`pacman -Syu` toca decenas de rutas vigiladas; una GPU atragantada repite la misma línea NVRM
cuarenta veces; un hub con tres pendrives emite tres conexiones a la vez; un SSH expuesto recibe
cientos de `Failed password` por minuto; apagar el Bluetooth tumba a la vez los cascos, el ratón y
el mando. Como buena parte de esos avisos son **críticos con `-t 0`** (sin autocierre), la pila
resultante se despacha cerrándola en bloque sin leer nada — el mismo efecto práctico que apagar la
categoría entera, y por la misma razón que motivó la allowlist de `privEsc`: **una alerta que
satura enseña a ignorarla**.

La librería acumula por categoría y emite **una** notificación por categoría. Es ortogonal a
`lib/notif.sh`: aquella da IDENTIDAD (`x-gigishell-event`), esta decide CUÁNDO y CUÁNTOS avisos
salen. **El resumen lleva el mismo id que el aviso individual** — quien silencia «errores de GPU»
quiere callados los dos.

**Dos relojes, y los dos hacen falta.** `NOTIF_CALMA` (4 s por defecto) son los segundos sin
eventos nuevos que cierran el grupo: es lo que hace que un evento **aislado** —el caso que de
verdad importa— siga avisando casi al instante. `NOTIF_TOPE` (20 s) es el máximo que la ventana
permanece abierta aunque los eventos no paren: **sin él, una actualización de sistema que genera
eventos durante minutos no cerraría la ventana nunca** y el aviso llegaría cuando ya no sirve;
con él sale un resumen cada 20 s mientras dure la ráfaga.

**El recuento del título cuenta EVENTOS, no líneas únicas**, y la distinción no es cosmética:
cinco fallos de sudo producen cinco veces exactamente el mismo texto, y colapsarlos a uno
convertiría un intento de fuerza bruta en un despiste. Se deduplica para la **lista** (con su
multiplicidad, `· <texto> (×5)`) mientras el total sigue siendo el real. **Salvo cuando el texto
repetido ES el mismo suceso visto dos veces**: `inotifywait` emite `create` **y** `close_write` por
un único cambio de fichero, y contarlos como dos anunciaría «3 archivos críticos modificados»
habiendo cambiado dos. Esas categorías se marcan con `notif_grupo_unico`. La regla para elegir:
¿dos textos iguales son dos sucesos, o uno contado dos veces? Sucesos (sudo, SSH, GPU) → por
defecto; el mismo (rutas de fichero) → `unico`. `NOTIF_LISTA=8` entradas
antes del «… y N más»; `NOTIF_CAP=300` entradas únicas retenidas — pasado ese tope el evento
**sigue contando** en el total pero deja de listarse, porque la deduplicación es un barrido lineal
y una ráfaga patológica lo volvería cuadrático.

**Con un solo evento el texto es el de siempre, palabra por palabra** (`título` + `<prefijo><texto><sufijo>`).
Agrupar no debe cambiar el caso de un evento — si lo cambiara, sería un rediseño disfrazado de
optimización.

**La ventana se implementa con el timeout de `read`** (`notif_leer` → `read -t`), sobre la misma
tubería que el bucle ya estaba leyendo. Con nada encolado el `read` bloquea **sin** timeout: en
reposo el bucle sigue costando ~0 % de CPU y **no hay ningún temporizador de fondo ni proceso
extra**. `rc > 128` es el vencimiento; cualquier otro fallo es fin de la tubería → volcar y salir.

**No todos los usuarios necesitan la ventana.** Cuando el lote ya existe por otro motivo, se usan
solo `notif_encolar` + `notif_volcar` y el reloj sobra: `monitor_units` vuelca al final de cada
pasada de `systemctl --failed`, el escáner de descargas al terminar de leer la salida de un
`clamscan`, `disk-monitor.sh` al acabar el barrido de `df`. Ahí agrupar **no retrasa nada**.

Quien la usa hoy: `oom-monitor.sh` (kernel, sistema, ficheros, unidades, malware), `usb-monitor.sh`,
`bt-monitor.sh` y `disk-monitor.sh`. **Excepciones deliberadas**: el **kernel panic** no se agrupa
(el sistema se está yendo y 4 s pueden ser más de lo que le queda a la sesión, y además no llega
en ráfaga), y la **tormenta de crashes** tampoco (ya es un resumen, con su propio límite de 1/60 s).

**Límite conocido:** lo encolado y aún no volcado se pierde si el proceso muere — como mucho una
ventana de `NOTIF_CALMA`. No se instala un trap a propósito: en un apagado el bus de
notificaciones se está cayendo también, así que el volcado de despedida no llegaría a ninguna
parte. Al recargar un monitor a mano (`pkill -f <script>` + relanzar) se puede perder lo de los
últimos segundos.

### Congelar tareas de fondo al jugar — y en modo ahorro (`lib/gaming-gate.sh`)

**El "modo juego" tiene dos mitades, y antes solo existía una.** El auto-DND ya callaba las
notificaciones mientras juegas, pero nada quitaba la CARGA: los sondeos de mantenimiento seguían
despertando discos, forkeando y tocando la red en mitad de una partida. `hypr/scripts/lib/gaming-gate.sh`
es la otra mitad — se **sourcea** (no se ejecuta) y expone `gaming_active` / `gaming_gate_wait`.

**No detecta nada nuevo**: reutiliza el flag que ya escribía AGS en `runtime-state.json`
(`servicios/energia/gamingState.ts`, que a su vez reutiliza el `isGameClient` de la barra). Bash no
sabría detectar un juego mejor que el shell.

**Qué se congela** — solo sondeo de mantenimiento, caro y sin nada urgente que mirar:
`updates-monitor.sh` (red + BD temporal de pacman), `monitor_smart` (smartctl **despierta cada
disco físico**) y `monitor_units` (4 forks de `systemctl` + awk cada 120 s). `monitor_downloads`
conserva su propia pausa `dlPauseWhileGaming` — más específica y ya tiene UI —, que es **la más cara
de todas** (clamscan recarga ~200 MB de firmas por invocación) y por eso **viene ACTIVADA por
defecto**, al revés que sus dos hermanas (`dlPauseOnBattery`/`dlPauseInPowerSave` siguen en `false`:
sacrificar seguridad por autonomía lo decide el usuario). De ahí que los defaults sean **por clave**
en `ags/modulos/ajustes/seguridad/preferencias.ts` y no uno común. En bash **no puede leerse con `.dlPauseWhileGaming // true`**:
el operador `//` de jq trata un `false` literal como ausente, así que apagar la pausa desde la UI no
habría servido de nada — va con la forma `if has(…)`, el mismo tropiezo ya documentado en
`battery-monitor.sh`.

**Qué NO se congela, y no es un olvido.** Los tres **seguidores** de eventos (`monitor_kernel`,
`monitor_system`, `monitor_files`) leen con `-n 0` a propósito y **no recuperan el pasado**:
congelarlos convertiría un OOM, un `sudo` fallido o un cambio en `/etc/shadow` en una **ventana
ciega**, y encima no ahorraría nada — bloqueados en `journalctl -f`/`inotifywait` ya cuestan ~0 %
de CPU. `temp-monitor.sh` tampoco: jugar es exactamente cuando la CPU y la GPU se cuecen, así que
congelar el termómetro apagaría la alarma en el único momento que importa. `ram-monitor` y
`battery-monitor` son bucles de builtins puros (cero forks por tick) y vigilan cosas que importan
MÁS con un juego delante. `usb`/`bt`/`wifi`/`screencast` son event-driven y de cara al usuario.
`disk-monitor` es one-shot: para cuando juegas ya salió.

**El gate BLOQUEA, no SALTA**: el trabajo aplazado se hace al descongelar, no se pierde. Por eso
va justo **antes del cuerpo del sondeo y después de la espera** — así `updates-monitor` sigue
bloqueado en su `inotifywait` (que no cuesta nada) y solo se retiene el `run_check`.

**"Juego abierto" no es "estás jugando", y confundirlos congelaba el mantenimiento el día entero.**
`gaming` vive hasta que la ventana **cierra** —a propósito: irte a otro workspace 30 s no es dejar de
jugar—, así que con eso solo, dejar un juego aparcado en el ws9 mientras trabajas bloqueaba
updates/SMART/units **indefinidamente y en silencio**. Por eso `gamingState.ts` publica además
`gameFocused` y `lastGameFocus` (epoch **absoluto**, por lo mismo que el `until` de `wakeup.json`:
la gracia se resuelve contra el reloj de pared sin que nadie reescriba el fichero, y no se desfasa
tras una suspensión). El gate congela si el juego **tiene el foco**, o si lo perdió hace menos de
`GAMING_FOCUS_GRACE` (5 min). La gracia evita el fallo contrario, que sería peor: descongelar en
cada alt-tab haría que un vistazo de 10 s a Discord lanzara `smartctl` y `clamscan` con el juego
cargado y a punto de recuperar el foco. Se escribe solo en la **transición** (el juego coge o pierde
el foco), no en cada cambio de ventana. Un fichero de un AGS anterior, sin esas claves, conserva el
comportamiento de antes (congelar mientras el juego viva) y se auto-corrige al reescribirse.
Verificado en vivo con eventos reales: abrir → congela; cambiar de workspace → sigue congelado
dentro de la gracia y descongela fuera de ella; volver al juego → **vuelve a congelar**; cerrar → libera.

**Al descongelar espera `GAMING_GATE_RESUME_DELAY` (5 s) antes de trabajar.** Al cerrar un juego el
sistema todavía está devolviendo RAM y VRAM y bajando relojes, y arrancar ahí mismo un `smartctl` o
un `clamscan` es justo el tirón que se nota al volver al escritorio. No le importa a nada de lo que
hay detrás del gate (el sondeo más frecuente es de 120 s) y **solo se paga si hubo congelación**: el
camino sin juego sale antes, sin dormir ni forkear.

**En `monitor_units` el gate se salta la PRIMERA pasada, y esa condición no sobra.**
`systemctl --failed` es estado de **nivel**, no de flanco: una unidad que caiga durante la partida
sigue en la lista al reanudar y se avisa entonces. Pero si el gate atrapara la pasada de **siembra**,
todo lo que hubiera fallado durante esas horas se sembraría como "preexistente" y no se notificaría
**nunca**. La siembra son 4 forks una sola vez: congelarla no ahorra nada y cuesta avisos.

**Fail-open, igual que la puerta del Wake up.** Sin fichero, con JSON corrupto, sin `pid` o con el
pid muerto, el gate responde "no estoy jugando" y **el trabajo se hace**. Un fallo aquí debe
degradar a "la congelación no funciona" —visible, y lo peor es un tirón en el juego— y nunca a "los
escáneres no vuelven a correr jamás", que es silencioso, permanente y no tiene UI donde notarse.
De ahí que `gamingState.ts` escriba ahora **también el pid de AGS**: mientras el flag solo pausaba
las descargas (opcional y por defecto apagado) que se quedara pegado en `true` daba casi igual;
ahora congela tres monitores más. La otra mitad de la cadena es que `initGamingState()` reescribe el
fichero al arrancar el shell, necesaria porque los pid **se reciclan**.

**Sin forks en el camino caliente**: el flag se lee con un redirect builtin + regex, no con `jq` —
un `jq` cada 10 s durante una partida de tres horas sería justo el coste que este gate existe para
quitar. El ajuste (`gamingFreeze` en `preferences.json`, ausente = activado) sí usa `jq`, pero
cacheado 30 s; se lee **en vivo**, no una vez al arrancar, porque es un control de recursos:
apagarlo descongela en ≤30 s sin reiniciar ningún monitor, incluso a mitad de partida.

**El mismo gate congela también en MODO AHORRO, y ese es su segundo motivo.** La lista de lo que
se congela es idéntica —sondeo caro y aplazable— porque la razón es hermana: al jugar el
mantenimiento molesta, con la batería baja **cuesta autonomía** (`smartctl` despierta discos,
`updates-monitor` enciende la radio). Lo decide AGS y llega **ya combinado** (ahorro activo **Y**
el interruptor de Ajustes > Energía > "Reducir procesos en segundo plano", `freezeBackground` en
`~/.config/power-save/config.json`, ausente = activado) como **`powerSaveFreeze`** en ese mismo
`runtime-state.json` — mismo fichero porque se reescribe **entero** en cada cambio y dos
escritores se pisarían; lo publica `gamingState.ts`, suscrito al estado de `powerState.ts`.

**Bash NO rederiva "¿estoy en ahorro?", y esa es la decisión.** Mirar `/sys/class/power_supply` a
mano ya salió mal una vez —lista también la pila del **ratón**, que reporta `Discharging` para
siempre (ver `_is_system_battery` en `oom-monitor.sh`)—, mientras que AGS ya tiene la respuesta
buena por upower y con el umbral que enseña la UI. Una sola fuente de verdad, y el error de
paralaje entre lo que dice Ajustes y lo que hace el gate deja de ser posible.

**Son dos interruptores, no uno**: `gamingFreeze` gobierna **solo** el motivo "juego" — apagar la
congelación al jugar no debe apagar la del ahorro, y al revés. Lo demás se comparte tal cual: la
guarda del `pid` de AGS, el fail-open (sin fichero, JSON corrupto, pid muerto o clave ausente → se
trabaja) y el bucle de espera, que **relee ambos motivos** en cada vuelta, así que salir del ahorro
—o desactivar el ajuste— descongela en ≤`GAMING_GATE_POLL` sin reiniciar ningún monitor.

**`GAMING_GATE_SLEEP` no es decorativo.** `updates-monitor` lo pone a `blocking sleep` porque bash
**difiere las señales** mientras espera a un hijo en primer plano: con un `sleep` normal, el `pkill`
del toggle maestro de AGS no mataría el script hasta acabar la espera. En `oom-monitor` los
sub-monitores ya duermen en primer plano, así que ahí `sleep` a secas es lo coherente.

### Apps al inicio (`inicializador/apps-inicio.sh` + Ajustes > Apps al inicio)

Abrir Spotify, un daemon de controladores o un script propio al entrar al escritorio, sin editar
ninguna configuración a mano. La **lista es dato** —`~/.config/gigishell/apps-inicio.json`, que
escribe AGS— y quien la **ejecuta** es este script, al que `gigishell/autostart.lua` llama con una
sola línea a **t=7**.

**Por qué la lista no vive en `autostart.lua`.** Añadir una app al inicio no puede obligar a tocar
Lua: un error de sintaxis ahí deja la sesión **sin atajos salvo `SUPER + Q`** (ver
[`hyprland-lua-migracion.md`](hyprland-lua-migracion.md)), que es un precio absurdo por una línea de
preferencia personal. En el config queda solo el **momento** en que se abren, que sí es una decisión
del calendario de arranque; la lista queda fuera, como `display.json` o `devices.json`.

**Y no, esto no corre "antes de Hyprland"**, por mucho que viva en el inicializador. No existe ese
momento para una app gráfica: hasta que el compositor no está en pie no hay `WAYLAND_DISPLAY` al que
conectarse. Lo que sí se gana es que la lista sea independiente del config del compositor. Mismo
reparto que `init.sh`, que también sale de un `exec-once` pese a llamarse inicializador.

**t=7, y las apps escalonadas entre sí.** Son lo más caro que puede entrar en el arranque —apps de
escritorio completas, cada una con su runtime y su GL— y a t=0 competirían con AGS por el driver,
que es el medio segundo que decide cuándo se ve la barra. Más tarde tampoco: quien pone Spotify en
el inicio lo quiere ahí al llegar. Dentro, las apps salen de una en una con `RETARDO_ENTRE` (2 s)
por medio, porque media docena arrancando a la vez es exactamente la avalancha que el resto del
calendario se pasa entero evitando — solo que aquí el usuario puede crearla con tres clics. El
primer lanzamiento **no** espera: el retardo del arranque global ya lo pone el `sleep 7` del punto
de llamada, y el de aquí es solo el hueco *entre* apps.

**Una vez por sesión, con marca en `$XDG_RUNTIME_DIR`.** `hyprctl reload full-reset` **repite** el
autostart (es su razón de ser), así que sin guarda cada recarga del compositor mientras se afina
algo abriría un segundo Spotify. La marca lleva el `HYPRLAND_INSTANCE_SIGNATURE`, que cambia con
cada arranque del compositor y no con una recarga: sesión nueva sí, recarga no. Se escribe **al
final** y solo si se llegó a recorrer la lista — ponerla antes convertiría un JSON ilegible en
"esta sesión ya lanzó sus apps". `--forzar` se la salta, y `--probar <id>` lanza una sola entrada
(activa o no, sin tocar la marca): es lo que hay detrás del botón ▶ de cada fila en Ajustes.

**Cada app nace ya en su escritorio, por regla de exec y no moviéndola después.**
`hl.dsp.exec_cmd(cmd, {workspace='N silent'})`, la misma técnica que documenta [Anclar las ventanas
al escritorio donde las lanzaste](#anclar-las-ventanas-al-escritorio-donde-las-lanzaste-anclajepy--los-dos-lanzadores):
la regla se aplica al **mapear** la ventana, así que no hay el frame en que nace en el sitio
equivocado. Y `silent` —"ábrela ahí pero no me lleves"— **solo existe como regla de exec**: medido
en esta máquina, `[noinitialfocus]` NO es una regla de exec y la ventana roba el foco igual. Por eso
en la UI el interruptor «Sin llevarte a él» está muerto mientras no haya un escritorio fijado, en
vez de ofrecer un ajuste que no se aplicaría; y por eso el modelo lo **apaga al guardar** si el
escritorio vuelve a «Donde estés» (`normalizarAppInicio` en
`ags/servicios/aplicaciones/appsInicioModelo.ts`, con prueba).

**Lo que NO se ofrece: abrir al scratchpad.** Técnicamente sale (`{workspace='special:magic
silent'}`, comprobado), pero el atajo del especial se retiró a propósito de `gigishell/keybinds.lua` —
un especial vacío que se abre no dibuja nada y el scratchpad **se destruye al quedarse vacío**
(`misc.close_special_on_empty`). O sea que una app enviada ahí no tendría forma de volver. "En otro
escritorio, en silencio" es la versión alcanzable de "minimizada".

**Tres caminos de lanzamiento, y los tres hacen falta.** `hyprctl` **no señala un dispatch rechazado
en su código de salida** —responde por stdout y sale 0 igualmente—, así que la cadena mira la
**salida**, no el `rc`: forma Lua → sintaxis legacy `dispatch exec "[reglas] cmd"` (por si la sesión
viva todavía viniera de un config hyprlang) → `setsid sh -c` sin regla ninguna. Degradar a "la app
se abre donde sea" es infinitamente mejor que "la app no se abre". Los tres caminos están medidos.

**El comando viaja byte a byte, y por eso no se usa `@tsv`.** Cada entrada sale de `jq` en
**base64** y se vuelve a parsear: con `@tsv`, un comando con una barra invertida o una tabulación
llegaría escapado y alterado, sin un solo error por medio. Después va dentro de un literal de cadena
Lua, escapando `\` y `'` (misma función que `lanzar-anclado.py`). Verificado con un comando que
mezcla comillas de los dos tipos y una barra invertida: idéntico por el camino de `hyprctl` y por el
de la reserva `setsid`.

**Convive con el escáner de apps de aquí abajo, y conviene saberlo**: t=7 cae **dentro** de su
ventana de 30 s, y esas son justo las ventanas que el escáner existe para encontrar. Con
`escanerAppsInicio` activado, te llevará al escritorio de estas apps al cerrar su ventana — lo que
en la práctica deshace el "sin llevarte a él" de una entrada silenciosa. No es un fallo de ninguno
de los dos: son dos funciones con intenciones opuestas y hay que elegir.

**El shell escribe la lista; el shell NO la lanza.** Si AGS abriera estas apps, dejarían de
arrancar exactamente en la sesión en que el shell falla — que es cuando más falta hace tener
delante el navegador o el terminal. La única excepción es el botón «probar», que es una acción del
usuario con el shell ya delante, y aun así pasa por **este mismo script** (`--probar <id>`) en vez
de hacer su propio `sh -c`: un botón de probar que ejecute por otro camino no prueba nada, diría
que funciona cuando el que falla es el camino real.

**Saneado del comando** (`sanearComando`, puro y con prueba): se quitan los códigos de campo de la
Desktop Entry Spec (`%U`, `%F`, `%i`…) porque aquí no se abre ningún fichero y la app recibiría un
`%U` literal como argumento, y se aplana a **una sola línea** — un salto de línea dentro del comando
no lo rompe, lo convierte en **dos comandos**. El recorrido de los `%` es de una sola pasada porque
`%%` es un porcentaje escapado: encadenando reemplazos, el `%` superviviente puede releerse como el
comienzo de otro código.

### Escáner de apps al iniciar sesión (`gigishell/escaner-apps.lua`)

Al empezar la sesión se abren ventanas **solas** (autostart, restauración de sesión) y no siempre
en el escritorio que estás mirando: acabas delante de uno vacío mientras tus apps están en otro.
Esto mira los primeros 30 s y te lleva donde hayan quedado. `0` ventanas nuevas → no hace nada;
**un** escritorio destino → salta a él; **dos o más** → llama a `GiGiShell.compactar()` y salta al
destino **más cercano** al activo (empate → id menor).

**Era un script de bash que parseaba el socket de eventos a mano**, con la trampa de que la
dirección de `openwindow>>` llega SIN el `0x` que sí trae `hyprctl clients` — cruzar ambas fuentes
sin normalizar daba cero coincidencias en silencio. Con `hl.on("window.open", …)` la ventana llega
ya tipada (`win.address` con su `0x`) y esa clase de fallo desaparece de raíz.

**La decisión se toma AL FINAL de los 30 s, no en cada evento, y esa es la diferencia entre la
función y un tic nervioso.** Saltar según llega cada `openwindow` haría rebotar el escritorio
activo cuatro o cinco veces mientras arranca la sesión — justo el desconcierto que esto viene a
quitar. El peaje aceptado es que la corrección llega a los 30 s, no al instante.

**Se registra a t=0, y es la excepción al calendario escalonado**: escucha las aperturas de ventana
desde el propio `hyprland.start`, y las apps de autostart abren **exactamente ahí**. Retrasarlo no
es apartarlo del pico de carga, es perderse las ventanas que existe para seguir — el mismo motivo
por el que `oom-monitor` no se retrasa entero. Ya no cuesta ni un proceso: es un callback del
compositor, y a los 30 s se desuscribe (`sub:remove()`) en vez de morir un `nc`.

**La dirección del evento viene SIN el `0x`** que sí trae `hyprctl clients` (`openwindow>>ADDRESS,
workspace,class,title`, y hay que cortar en la primera coma: la línea entera trae también
workspace, clase y título). Cruzar ambas fuentes sin normalizar da cero coincidencias **en
silencio** — el script recolecta bien, resuelve a lista vacía y sale con éxito sin saltar a ningún
sitio. Fue el primer fallo real y no da ningún error.

**Los escritorios se re-resuelven DESPUÉS de compactar**, porque `GiGiShell.compactar()` renumera:
un id leído antes de compactar apunta a otro sitio (o a nada) al terminar. Como la llamada es
síncrona, la re-resolución va justo detrás, sin temporizadores de por medio. Solo cuentan las
ventanas que **no existían** al registrarse (la base se toma con `hl.get_windows()`) — lo ya
abierto no es un autolanzamiento — y se ignoran los escritorios especiales, que no son una posición
donde dejar al usuario.

**Es de un solo disparo, no un vigilante permanente**, así que se aparta de la advertencia general
de los `*-monitor.sh`: lee su preferencia al cargar el config, mira 30 s y se desuscribe. No hay
proceso vivo que se quede ejecutando código viejo, ni hace falta `pkill` + re-exec al cambiar el
ajuste — se aplica en la próxima sesión, como `limpiezaPortapapelesAlIniciar`.

**Alcance real**: corre al arrancar **Hyprland**, no al volver de una suspensión o hibernación
(volver no reinicia el compositor, así que `hyprland.start` no se vuelve a disparar). Cubre el
autostart y cualquier restauración de sesión que ocurra tras un arranque completo.

La ventana de 30 s la cierra un `hl.timer` de un disparo. Toda la maquinaria que hacía falta en
bash —leer el socket con `nc -U`/`socat`, el sondeo de repliegue cada 2 s, distinguir "el lector no
ha dicho nada" de "no se ha abierto ninguna ventana"— desapareció con la reescritura: aquí los
eventos los entrega el compositor al callback.

**Ajuste**: `escanerAppsInicio` en `~/.config/gigishell/preferences.json` (Ajustes > Personalización >
Ventanas y escritorios). **Ausente = DESACTIVADO**, al revés que la mayoría de claves de este
fichero: mover el escritorio activo por su cuenta es intrusivo y hay que optar a ello. Ese default
es también lo que hace seguro leerlo con `.escanerAppsInicio // false` — el tropiezo del operador
`//` de jq documentado en `gaming-gate.sh` (que trata un `false` literal como ausente) aquí da el
mismo resultado por ambos caminos. `GIGISHELL_ESCANER_SEGS` acorta la ventana para probarlo sin
esperar medio minuto, la misma costura que `GIGISHELL_USB_PENDING_DIR` en el monitor de USB.

### Que una ventana no acabe estrujada, al abrirse o al soltarla (`gigishell/reparto-ventanas.lua`)

**El problema es del primer cálculo de tamaño, no del layout en reposo.** dwindle parte siempre la
ventana objetivo en dos, y el objetivo por defecto es la última que tuvo el foco en ese escritorio,
así que abrir cuatro terminales seguidas da una progresión geométrica, no un reparto — medido en
este equipo (escritorio de 2032x1098): **1014 · 504 · 252 · 250**. La quinta habría nacido con
125 px. Este módulo decide, en `window.open_early` (antes de colocarla, que es el único momento sin
cirugía sobre el árbol), **qué se parte** y **por qué lado**. Las mismas ocho terminales salen a
**504x547 cada una** (medido).

**Dos palancas, y la primera sola NO basta.** (1) *Qué*: se enfoca la ventana en mosaico **más
cercana al ratón de entre las que aún dan una mitad decente** — dwindle toma como objetivo la
última enfocada, así que enfocar es la única forma de redirigir el corte; el foco se lo lleva la
ventana nueva al mapearse, así que no se nota. (2) *Por dónde*: `preselect`, que fija dos cosas a la
vez — el **eje** sale del lado largo del objetivo (ancha → se parte en vertical, alta → se apila,
que es lo que convierte la progresión en rejilla) y el **lado**, de en qué mitad de esa ventana está
el ratón, porque `preselect <dir>` coloca la nueva en ese lado. Hace falta porque con `smart_split` el
eje **no sale de la forma de la ventana, sale del cuadrante del cursor sobre ella**, y al lanzar
desde Orion o rofi el cursor está donde lo dejaste: el eje sale a suertes y se repite igual ventana
tras ventana. Medido A/B sobre la misma ventana de 2032x1098: con smart_split, 2032x547 (apilada);
sin él, 1014x1098 (lo correcto para una apaisada). O sea que enfocar la mayor sin arreglar el eje
daba ocho tiras de **2032x134**. `preselect` tiene prioridad sobre el cuadrante, sobre `smart_split`
y sobre `force_split` (ya documentado en `gigishell/keybinds.lua`, donde se usa para lo mismo en
SUPER+SHIFT+dirección), así que no hay que tocar `smart_split`, que sigue mandando en el arrastre.
En el camino de **mover a otro escritorio** `preselect` no basta y la palanca es otra: ver
*Mover una ventana a otro escritorio sin desordenarlo*, más abajo.

**La cercanía al ratón es el SEGUNDO criterio, no el primero**, y el orden es lo que lo hace
funcionar: elegir por cercanía a secas devuelve el problema de partida, porque el hueco pegado al
cursor suele ser justo la rendija que acabas de crear. Primero se filtran las candidatas por si su
mitad da la talla y solo entre las que pasan gana la más cercana (a igual distancia, la más grande);
si no pasa ninguna —escritorio lleno— manda la mayor, porque ahí ya no se puede acercar al ratón sin
estrujar. Verificado en vivo con el mismo estado de partida y el ratón en las cuatro esquinas: con
el cursor dentro de una ventana de 506x547 (mitad 506x273 → no da la talla) la nueva sale partiendo
la de 504x1098 de al lado, **por arriba o por abajo según dónde esté el ratón**; con el cursor a la
derecha, parte la columna derecha, arriba o abajo igual. `hl.get_cursor_pos()` existe y devuelve
`{x, y}` — la ausencia de esa función se dio por supuesta al escribir la primera versión y era falsa.

**La SEGUNDA ventana de un escritorio va SIEMPRE al lado, nunca debajo** — y esa sí es una regla
forzada, la única del módulo. Con una sola ventana en mosaico, la siguiente nace a la **derecha**
(`preselect right`) pase lo que pase con el ratón. No salía por el camino de los mínimos porque ahí
no puede salir: la peor mitad de una ventana que ocupa el escritorio entero da la talla de sobra, el
módulo se apartaba y el eje lo decidía `smart_split`, o sea el cuadrante donde hubieras dejado el
cursor — con el ratón en la mitad de abajo, dos franjas horizontales, la peor de las dos formas en
un panel apaisado y encima distinta en cada arranque sin que se vea por qué. El eje aquí no se
calcula, se fija; el **lado** sí es convención (derecha, el default de dwindle, para que la ventana
que ya tenías no se te mueva). De la tercera en adelante vuelve a mandar todo lo demás. Esta rama va
**antes** de la comprobación de `repartoVentanas` y **no** exige `ws.visible`: no enfoca a nadie, así
que ni es reparto ni puede arrastrar la vista a un escritorio oculto. Se apaga con
`segundaVentanaAlLado: false`.

**Es PREVENCIÓN, no una rejilla forzada**: mientras el sitio natural dé un tamaño razonable el
módulo **no interviene** y manda dwindle con su cuadrante. El listón se mide sobre la **peor mitad
posible** del objetivo natural — la que sale de partirlo por su lado **corto**, la más achatada de
las dos —, y se toma la peor porque la real depende del cursor y el cursor no se puede consultar
desde el config. Con dos ventanas de 1014x1098 la peor mitad es 507x1098 → cabe → la tercera nace
donde diga tu cursor; con cuatro de 1014x547 es 1014x273 → 273 < 320 → se interviene. Ese es
justo el punto en el que "una más" empezaba a estrujar.

**En un escritorio que NO se está viendo no se hace nada, y corregir solo el eje allí sale PEOR.**
Redirigir el corte exige enfocar, y enfocar en un escritorio oculto **arrastra la vista** a él
(medido: la sesión saltó al ws15 durante las pruebas), cosa que abrir una ventana no justifica. Y
sin poder redirigir el objetivo, el corte por el lado largo se ceba con la última ventana y la deja
cuadrada y diminuta: ocho terminales dieron **123x133** frente a las tiras de 252x1098 de dwindle a
secas. Misma área, peor forma — de ahí que se ceda entero. Afecta a lo que se lanza anclado a otro
escritorio.

**Otros límites**: no redistribuye lo ya abierto (es el cálculo de la ventana nueva); si la ventana
acaba flotando por una regla —las reglas aún no están aplicadas en `open_early`— la intervención se
deshace sola en `window.open` (`preselect none` + devolver el foco), y una red de 2 s cubre que
`window.open` no llegue nunca, porque **un `preselect` sin consumir se lo come la SIGUIENTE ventana
que abras**. Con el escritorio ya lleno interviene igual aunque no pueda arreglarlo: partir la mayor
por su lado largo sigue siendo la opción menos mala. Quien decide que ya no cabe nadie es
`gigishell/limite-ventanas.lua`, que corre después.

**Al SOLTAR una ventana arrastrada (SUPER + arrastrar) manda la otra palanca: quitarle sitio a los
vecinos.** Es el otro momento en el que un tamaño se decide de golpe — dwindle reinserta la ventana
partiendo el destino en dos, así que soltarla sobre una ventana ya pequeña la deja en la mitad de
poco. Aquí el destino **no** se puede elegir (lo has elegido tú con el ratón), así que si la ventana
cae por debajo de los mínimos se la ensancha con `resizeactive exact`, que mueve las proporciones
del árbol: el hueco sale de **encoger al vecino**, no de tapar a nadie. Se pide **solo el mínimo**,
nunca más — el sitio se le quita a otro y pasarse sería resolver un estrujón creando otro. Medido:
un drop que iba a quedar en 2032x**273** sale en 2032x**320** y el vecino baja de 547 a 223.

**La detección del soltar son dos binds MÁS** sobre `SUPER + mouse:272` (uno normal y otro con
`{release = true}`) que llaman a `GiGiShell.reparto_arrastre_inicio/fin`. Hyprland ejecuta **todos** los
binds de una combinación, así que conviven con el `bindm` nativo — verificado con un **ratón virtual
por uinput** haciendo el arrastre de verdad. Ojo: esto es `release`, **no** el `drag` de la
advertencia de `keybinds.lua`, que sí se come el primer arrastre de cada sesión.

**AL PULSAR NO SE VALIDA NADA, y ese fue el fallo que costó la tarde.** Cuando llega la pulsación,
el `bindm` nativo ya se ejecutó y la ventana **está flotando**: así dibuja Hyprland el arrastre (la
saca del mosaico y la reinserta al soltar). Descartar lo flotante ahí —lo primero que uno escribe—
hacía que la foto no se tomara nunca y que **todo esto no hiciera nada, sin un solo error**. La
geometría en ese instante sí es todavía la del mosaico. Las comprobaciones van al soltar, donde el
estado ya es el bueno; una ventana que **ya** flotaba sigue flotando allí y se descarta entonces.

**El press guarda la geometría para distinguir un arrastre de un SUPER+clic que no movió nada**, y
la comparación lleva **tolerancia de 16 px**, no una igualdad: un clic sin desplazamiento tampoco
deja la geometría intacta —Hyprland saca y mete la ventana igual, y las proporciones bailan unos
píxeles (medido: 223 → 220)—, así que con `==` un simple clic podía acabar ensanchando la ventana.
Con la tolerancia, tres clics seguidos sobre la más pequeña no mueven nada (medido).

**Trampas medidas**: `at` y `size` de una `HL.Window` son tablas **`{x=, y=}`, no arrays** — un
`v.size[1]` devuelve `nil` en silencio, el área sale 0 y toda comparación de tamaño pasa a ser
cierta (el módulo creía que todo cabía y no intervenía nunca, sin un solo error). Y
`hl.dsp.window.resize` **ignora `window = ...`**: redimensiona **siempre la activa**, también sin
avisar (medido: pidiendo agrandar tst3 se agrandó tst2). Por eso el drop comprueba que la activa
siga siendo la ventana que soltaste antes de tocar nada.

**Ajustes** en `~/.config/gigishell/preferences.json`, sin UI (como `maxVentanasEscritorio`):
`repartoVentanas` (**ausente = activado**, se comprueba `== false`), `segundaVentanaAlLado`
(**ausente = activado**, mismo criterio; apaga solo el forzado de la segunda ventana),
`anchoMinimoVentana` /
`altoMinimoVentana` (**ausentes = 480x320**; los dos a 0 lo desactivan). Se leen por `util.prefs()`,
o sea una vez por ejecución del config: cambiarlos pide un `hyprctl reload`.

### Mover una ventana a otro escritorio sin desordenarlo (`sin_smart_split`, en `gigishell/ventanas.lua`)

**Mover desordenaba el escritorio destino, y la culpa no era del módulo que movía.** Para dwindle un
`movetoworkspace` no es "cambiar de sitio": es **sacar la ventana de un árbol y reinsertarla en
otro**, exactamente igual que si naciera allí. Parte la última enfocada del destino y, con
`smart_split`, el eje de ese corte sale del **cuadrante del cursor** sobre ella. En un drop eso es
justo lo que quieres —acabas de señalar con el ratón—, pero al mover con el teclado el cursor está
donde lo dejaste hace diez minutos: el eje sale a suertes, y encima **repetido**, porque mientras no
muevas el ratón la misma tecla parte siempre por el mismo sitio. De ahí las tiras de pantalla
completa en vez de una rejilla.

**Medido** en instancia anidada con config Lua (monitor de 1014x1082, destino con una ventana que lo
ocupa entero, cursor "rancio" en el borde izquierdo, x=5 y=540):

| | ventana que llega | la que estaba |
|---|---|---|
| sin envoltorio (`smart_split` activo) | 497x1082 | 497x1082 — dos columnas estrechas |
| con envoltorio | 998x539 | 998x539 — la rejilla que toca |

Con el cursor en (500,5) **las dos salidas son idénticas**: el envoltorio solo cambia el resultado
cuando `smart_split` iba a elegir un eje distinto al del lado largo, no toca nada más.

**`preselect` NO sirve aquí**, aunque sea el truco con el que `gigishell/keybinds.lua` arregla
SUPER+SHIFT+dirección y `gigishell/reparto-ventanas.lua` la ventana nueva. Medido: con `smart_split`
activo, un `preselect right` inmediatamente antes del `movetoworkspace` —incluido en el **mismo
`hyprctl --batch`**, para descartar que se perdiera entre llamadas— da **exactamente el mismo
resultado** que sin él. El override solo lo consulta el camino de ventana nueva.

Así que la palanca es apagar `dwindle:smart_split` mientras dura la inserción y volver a encenderlo,
que es lo que hace `sin_smart_split(accion)` en `gigishell/ventanas.lua` (donde vive la tabla `dwindle`,
para que el valor restaurado no sea un literal copiado que se quede obsoleto). El restaurado va en
`pcall` **siempre**: dejarlo apagado por un fallo de `accion` sería un cambio permanente y mudo — el
arrastre dejaría de responder al cuadrante hasta el siguiente `hyprctl reload`. El apagado es
**global mientras dura la llamada**, así que la acción tiene que ser corta y síncrona: nada de
timers ni de esperar un evento dentro.

**Lo usan los cuatro caminos que mueven ventanas entre escritorios sin un ratón señalando el
destino** — y ninguno más, porque el arrastre sí tiene ese ratón y es la única razón por la que
`smart_split` está puesto:

| camino | qué mueve |
|---|---|
| `gigishell/keybinds.lua`, SUPER+SHIFT+número | la ventana activa |
| `gigishell/compactar.lua` | **el escritorio entero**, ventana a ventana |
| `gigishell/limite-ventanas.lua` | la que rebasa el tope, al primer escritorio con sitio |
| `scripts/anclaje.py` | la recién lanzada, a su escritorio de lanzamiento |

**`compactar` es el que más lo necesita**: no mueve una ventana, vacía un escritorio en otro, así que
el destino se reconstruye entero y el cuadrante rancio se aplicaba a **cada** corte. Verificado tras
el arreglo: tres ventanas en ws5 y una en ws9 acaban en ws1 (rejilla de 998x539 + dos de 497x539) y
ws2, con `smart_split` y `preserve_split` de vuelta en sus valores.

**`anclaje.py` va por `hyprctl eval`, no por `hyprctl dispatch`**, porque necesita ejecutar una
*closure* en el estado Lua del config, que es donde vive el global `GiGiShell` (verificado: `eval`
acepta varias sentencias y ejecuta funciones anónimas; lo que no hace es **devolver** su valor —
siempre responde `ok`, de ahí que el script mire el stdout y no el código de salida). Si el
envoltorio no existiera —config a medio recargar, `ventanas.lua` roto— mueve igual sin él: llegar
desordenada es mejor que no llegar. Los cuatro consumidores Lua hacen lo propio con un
`pcall(require, "gigishell.ventanas")` y repliegue a "ejecuta la acción tal cual", por la trampa nº 1
de la migración (un error aquí deja la sesión sin atajos).

### Ventanas opacas durante el modo ahorro (`opacidad_ahorro`, en `gigishell/ventanas.lua`)

Gemelo, para las ventanas del compositor, del ajuste **«quitar la transparencia de los paneles»** del
shell (Ajustes > Energía). Aquel deja opacas las láminas de AGS; este deja opacas las **ventanas**,
que es lo que transparenta `decoration:inactive_opacity` (0.92 en esta configuración: toda ventana
sin foco va semitransparente).

**Lo que se ahorra es del compositor, no del cliente.** Una superficie con alfa < 1 obliga a Hyprland
a componer lo que hay **debajo** —el resto del mosaico y el fondo— en cada fotograma que se redibuje,
y la deja fuera de los atajos de región opaca. Con las dos opacidades a 1.0 la ventana de delante
tapa de verdad. Es, como el de los paneles, de los pocos ajustes del ahorro que ahorran mientras el
usuario **mira** algo y no mientras el equipo está en reposo.

**La condición viene resuelta de AGS y aquí no se reevalúa.** `~/.config/gigishell/opacidad-ventanas.json`
trae una sola clave, `forzada`, que AGS escribe ya combinada (**modo ahorro activo Y ajuste
encendido**) — mismo criterio que `powerSaveFreeze` en `runtime-state.json`, y por el mismo motivo:
rederivar aquí «¿hay ahorro?» obligaría a mirar `/sys/class/power_supply`, que lista también la pila
del ratón (ver la sección de `oom-monitor.sh`). Fichero **ausente o corrupto → la opacidad de
siempre**; nunca una sesión con las ventanas opacas sin haberlo pedido.

**Son dos caminos y hacen falta los dos:**

| camino | quién lo dispara | para qué |
|---|---|---|
| `hyprctl eval "GiGiShell.opacidad_ahorro(<bool>)"` | `ags/servicios/energia/opacidadVentanas.ts`, en cada transición | aplicarlo **en vivo**, sin recargar |
| leer el JSON al cargar el módulo | cualquier ejecución del config | que un **`hyprctl reload`** no reponga el 0.92 a espaldas de AGS, y que una sesión que arranca ya en ahorro nazca opaca |

El segundo no es opcional: **no hay señal de recarga** que AGS pueda observar (es el mismo motivo por
el que `display.json` lo lee también `gigishell/pantalla.lua`). Y el estado de arranque se lee **antes**
del `hl.config` grande y se aplica **dentro** de él, no con una segunda llamada a continuación, para
que la recarga no tenga un instante con las ventanas transparentes.

**AGS llama a la función del config, y no manda un `hl.config` con los valores.** La opacidad a la
que hay que **volver** al salir del ahorro vive en la tabla `aspecto` de `gigishell/ventanas.lua` —
donde ya están los gaps, por la misma razón—, y copiarla en TypeScript sería la desincronización
silenciosa de siempre: el día que se cambie aquí, el ahorro restauraría el valor viejo. La forma que
se despacha es `GiGiShell and GiGiShell.opacidad_ahorro and GiGiShell.opacidad_ahorro(true)`, defensiva
porque `hyprctl eval` **envuelve lo que le pasas en un `return …;`**: con el módulo sin cargar se
invocaría un `nil` y el error saldría por stdout **con código de salida 0**, que es justo lo que hace
que estos fallos pasen inadvertidos.

**No hay apunte de recuperación, y aquí no hace falta** (al revés que con el brillo o los tiempos de
inactividad del ahorro): esto no aparta ningún valor del usuario. El estado al que se vuelve está
escrito en el propio config, así que un AGS que muera con el ahorro puesto deja como mucho las
ventanas opacas hasta el siguiente `hyprctl reload` — visible, inocuo y sin residuo en disco que
pueda contaminar los ajustes reales.

### Tope de ventanas en mosaico por escritorio (`gigishell/limite-ventanas.lua`)

Pasadas unas cuantas ventanas en mosaico el escritorio deja de ser útil: dwindle sigue partiendo el
espacio y acabas con columnas de 200 px. Este módulo pone un techo (**8** por defecto) y, cuando
una ventana nueva lo rebasaría, la **mueve al primer escritorio con sitio**.

**Hyprland NO tiene esta opción** — no existe ningún `max_tiled_windows` en 0.56 ni en el stub de
la API Lua (`/usr/share/hypr/stubs/hl.meta.lua`). Lo que sí hay ya es con qué implementarla desde
el config: `window.open` tipado + `hl.dsp.window.move` con selector por objeto. En hyprlang habría
sido un daemon leyendo el socket de eventos y cruzando direcciones con `hyprctl clients` —el
montaje de `escaner-apps.sh`, con su trampa de las address sin `0x`—; aquí son 40 líneas dentro del
propio config, sin proceso vivo, así que se aparta de la advertencia general de los `*-monitor.sh`
(no hay nada que `pkill`ear: basta `hyprctl reload`).

**El límite es del MOSAICO, no de ventanas**, y por eso se descuentan tres cosas: las **flotantes**
(ni cuentan ni se mueven — no compiten por el espacio del layout, y desterrar un diálogo o un PiP
"porque el escritorio está lleno" no tiene sentido), las **ocultas** (`hidden`, una terminal tragada
por `swallow`: existe pero no ocupa hueco) y los escritorios **especiales** (el scratchpad no es un
sitio donde imponer un tope ni donde dejar al usuario). Verificado en vivo con el tope a 2: la
tercera en mosaico salta, y una cuarta que abre flotante no cuenta ni desplaza a nadie.

**Se sigue a la ventana (`follow = true`), al revés que en `compactar.lua` y en el anclaje.** El
usuario acaba de lanzar la app, y el peor fallo aquí sería que su ventana desapareciera en silencio
a un escritorio que no sabe cuál es. El escritorio lleno se queda como estaba y tú vas donde fue la
ventana. Se cambia con `SEGUIR = false`, pero entonces hay que avisar de algún modo o la app
parecerá no haber arrancado.

**Con el anclaje hay que ARBITRAR, y el árbitro está en `anclaje.py`, no aquí.** Las dos funciones
tiraban en direcciones contrarias y ganaba el anclaje por llegar el último: el tope apartaba la
ventana nueva de un escritorio lleno y te llevaba con ella, y acto seguido el `openwindow` llegaba
al observador, que la veía "descolocada" respecto al escritorio de lanzamiento y la devolvía **en
silencio**. Resultado: tú en el escritorio nuevo y la ventana en el viejo —peor que cualquiera de
las dos funciones por separado, sin ningún error— y la novena ventana otra vez apretujada con las
ocho. Hoy `_hueco_en()` (en `anclaje.py`) **replica el recuento de este módulo** —solo mosaico, ni
flotantes ni ocultas, sin contarse a sí misma— y **no ancla si el destino está lleno**. La
jerarquía: el lanzador decide **dónde nace** la ventana, el tope decide **si ahí cabe**, y manda el
tope porque es el único de los dos que sabe algo que el lanzador no podía saber al lanzar. Si
cambias el criterio de recuento de aquí, hay que cambiarlo **en los dos sitios** o vuelve el tira y
afloja. Verificado en vivo con el tope a 2, por los dos caminos: lanzar sobre un escritorio lleno
deja la ventana en el nuevo (no vuelve), y lanzar sobre uno con hueco **sigue anclando** como
siempre.

**Ajuste**: `maxVentanasEscritorio` en `~/.config/gigishell/preferences.json`. **Ausente = 8
(activado)**; un valor **≤ 0 lo desactiva**, y esa vía hace falta precisamente porque el default es
"encendido" (borrar la clave no lo apaga). Se lee por `util.prefs()`, o sea una vez por ejecución
del config: cambiarlo pide un `hyprctl reload`. El barrido de candidatos sube desde el escritorio
actual hasta `WS_MAX` (20) y luego da la vuelta por debajo; un escritorio que aún no existe cuenta
como vacío y Hyprland lo crea al mover. Si **no hay sitio en ninguno**, la ventana se queda donde
estaba: apretujar es mejor que mandarla a un escritorio igual de lleno.

### Anclar las ventanas al escritorio donde las lanzaste (`anclaje.py` + los dos lanzadores)

Abres una app, te vas a otro escritorio mientras carga, y la ventana aparece **donde estás** en vez
de donde la abriste. `hypr/scripts/anclaje.py` es el motor que lo corrige, y lo comparten los **dos**
lanzadores: `rofi-launch.py` (SUPER+SPACE) y `lanzar-anclado.py`, por el que **Orion** abre sus apps
(`ags/modulos/orion/data/launch.ts`). Antes solo lo tenía rofi y Orion hacía `sh -c <exec>` a pelo,
así que la misma app se comportaba de una forma u otra según por dónde la abrieras.

**Dos mecanismos, no uno, y el orden importa.** `lanzar-anclado.py` lanza con
**`hyprctl dispatch exec [workspace N silent] <cmd>`**: la ventana **nace** ya en su escritorio. Antes
se lanzaba a secas y se corregía con un `movetoworkspacesilent` al llegar el `openwindow`; el
resultado final era el mismo, pero por medio la ventana llegaba a **mapearse en el escritorio
equivocado** — un parpadeo de un frame, un amago de render que ni siquiera recolocaba las ventanas
que ya había allí. Con la regla ese instante no existe. Medido con el socket de eventos:
`openwindow>>…,2` + `movewindow>>…,1` (antes) frente a `openwindow>>…,1` y ningún `movewindow`
(ahora). El **`silent`** es obligatorio —sin él, lanzar algo destinado a otro escritorio te
arrastraría allí, justo lo contrario de lo que se busca— y **no rompe el foco** en el caso normal de
lanzar en el escritorio en el que ya estás (medido).

**La regla solo cubre la PRIMERA ventana**, así que el observador de `anclaje.py` sigue haciendo
falta y no es redundante. Medido con un comando que abre dos ventanas separadas 2 s: la primera nace
en el escritorio de la regla, la segunda nace en el activo. O sea que la regla mata el artefacto en
el caso que pasa siempre (una app, una ventana) y el observador queda como red para splashes y
multiventana —ahí sí con el parpadeo— y para la rama `urgent`, que trae al escritorio actual una app
single-instance ya abierta. **Rofi no puede usar la regla**: en modo `drun` ejecuta el `Exec` del
`.desktop` él mismo, así que no hay dónde interponerla y conserva el parpadeo.

**El observador**: escucha el socket de eventos hasta 15 s, deduce la identidad de la app de la
**primera ventana nueva** (`initialClass` + pid) y a partir de ahí solo ancla lo que coincida en
clase o cuelgue de ese árbol de procesos — sin eso se llevaba al escritorio de lanzamiento cualquier
diálogo o popup ajeno que naciera en esa ventana de tiempo. Los 15 s salen de medir el peor caso
real (Steam: tres ventanas, la última a los 10 s). El detalle completo del diseño está en el
docstring de `anclaje.py`.

**Ninguno de los dos es un daemon**, así que se apartan de la advertencia general de los
`*-monitor.sh`: nacen de cero en cada lanzamiento, leen el ajuste y mueren. No hay que hacerles
`pkill` + re-exec al cambiar la preferencia.

**Ajuste**: `anclarVentanasRofi` en `~/.config/gigishell/preferences.json` (Ajustes > Personalización >
Ventanas y escritorios), **ausente = activado**. Es **una sola clave para los dos lanzadores** a
propósito: para quien la usa es una única función, y partirla solo permitiría dejarla a medias. El
nombre dice "Rofi" por historia —renombrarla apagaría el anclaje en silencio en la máquina que ya
tiene la clave escrita— y no por alcance. Cuando está **desactivado no se pone la regla** tampoco:
el ajuste significa "que cada ventana aparezca donde yo esté", y fijarla al escritorio de
lanzamiento sería justo lo que se apagó.

**El anclaje CEDE ante el tope de ventanas por escritorio.** Antes de traerse una ventana al
escritorio de lanzamiento, `_hueco_en()` comprueba que ahí quepa según `maxVentanasEscritorio`
(mismo recuento que `gigishell/limite-ventanas.lua`: solo mosaico, sin flotantes ni ocultas, sin
contar la propia ventana); si está lleno, **no la ancla** y la deja donde el tope la puso. Sin eso
las dos funciones se deshacían mutuamente y te quedabas mirando un escritorio distinto del de tu
ventana. Ver la sección del tope para el porqué de la jerarquía. Los clientes se piden **una sola
vez por ventana nueva** y de ahí salen el cliente y el recuento: antes eran dos forks de `hyprctl`
y, peor, dos instantes distintos.

**Fallos: siempre hacia "se abre sin anclar", nunca hacia "no se abre".** Sin socket, sin Hyprland o
con un `dispatch` rechazado se relanza por `sh -c`. Ojo con lo último: **`hyprctl` no señala un
dispatch rechazado en el código de salida**, responde `ok` en el stdout, así que mirar solo el
`returncode` daría por bueno un fallo y la app no se lanzaría por ningún camino.

**El lado de la barra**: un traslado silencioso **no emite `notify::clients`** (que es de altas y
bajas, no de movimientos), así que `ags/modulos/barra/escritorios/Escritorios.tsx` escucha además **`client-moved`**.
Sin eso los iconos de la barra se quedaban en el escritorio donde nació la ventana hasta que otra
cosa forzara un refresco. Ver `ags/CLAUDE.md`.

### Traer aquí la ventana single-instance de Steam (`gigishell/traer-steam.lua`)

La lista de amigos y los chats de Steam son **single-instance**: si ya tienes uno abierto en otro
escritorio y lo vuelves a pedir desde la ventana principal, Steam **no abre una segunda ventana**,
reutiliza la existente allí donde esté. Con `misc.focus_on_activate = false` (`gigishell/ventanas.lua`)
Hyprland tampoco te lleva hasta ella: solo la marca **urgent**. El síntoma es *"hago clic y no pasa
nada"* cuando en realidad la ventana sí respondió, en un escritorio que no estás mirando.

Es el mismo razonamiento del `urgent` que ya documenta la sección de `anclaje.py`, pero **aquel solo
vigila lo que lanzas desde el lanzador**, durante su ventana de observación tras el `exec`. Pedir un
chat desde la propia UI de Steam no pasa por el lanzador: ahí no hay nadie escuchando, de ahí este
módulo, que engancha `hl.on("window.urgent", …)` de forma permanente.

**`HL.Window.workspace` parece escribible y NO lo es.** `w.workspace = ws` se acepta sin error,
devuelve `ok` en `pcall`, y la ventana **se queda donde estaba** (medido en vivo con la ventana
principal de Steam, asignando tanto un objeto `HL.Workspace` como un id crudo). Es un fallo
silencioso perfecto: el código parece correcto y no hace nada. La vía real es el dispatcher.

**El mensaje de error de la API miente por omisión, y creerlo cuesta un parpadeo.** Llamar a
`hl.dsp.window.move` con una clave inválida enumera lo que espera: `direction`, `x+y(+relative)`,
`workspace`, `into_group`, `out_of_group`. **`window` no sale en esa lista, pero se acepta y
funciona.** La diferencia no es cosmética:

- **Sin selector**, `move` actúa sobre la ventana **activa**, así que hay que enfocar primero; `focus`
  salta al escritorio de la ventana y `move` trae la vista de vuelta. Funciona, pero **se ve el
  parpadeo** del escritorio yendo y viniendo.
- **Con selector**, un solo dispatch: la ventana viene sola y la vista no se mueve en ningún momento.

Comprobado en vivo: estando en el escritorio 2 con kitty enfocado y la ventana de Steam en el 3, el
dispatch único la trajo al 2 dejando `activews` en 2. El `focus` explícito posterior es solo
determinismo (el `move` ya la deja enfocada, pero eso es efecto colateral observado, no contrato) y
no puede reintroducir el salto, porque para entonces la ventana ya está en tu escritorio.

**Enfocar y elevar son dos cosas distintas, y hay que pedir las dos.** Enfocar una flotante **no la
sube en el z-order**: si en el escritorio de destino ya había otra flotante solapada, la ventana
llega enfocada pero **tapada**, y se ve el mismo *"no ha pasado nada"* que el módulo venía a
arreglar. Medido con dos ventanas flotantes colocadas en las mismas coordenadas y `grim` sobre la
zona solapada: tras `focus()` el píxel del centro seguía siendo el de la ventana de arriba
(`srgb(0,0,255)`), y solo tras `bring_to_top()` pasó a ser el de la traída (`srgb(98%,1%,1%)`). De
ahí que la secuencia termine siempre en `hl.dsp.window.bring_to_top`, también en la rama de "ya
estaba en este escritorio" — que es justo donde el tapado ocurre.

**El puntero saltaba al centro de la ventana, y el culpable es `move`.** Medido: con el cursor en
`348,765` y la ventana en `400,300` de `500x400`, tras el `move` el cursor estaba en `650,500` — el
centro exacto. `focus` y `bring_to_top` **no lo tocan**, así que evitar el enfoque no habría servido
de nada. Se arregla con **`cursor.no_warps = true`** en `gigishell/input.lua`, global a propósito y no
como apaño local (guardar la posición y restaurarla con `hl.dsp.cursor.move` también funciona): el
salto molesta igual venga de donde venga, así que afecta por igual al anclaje de `anclaje.py` y a los
atajos de foco. Verificado tras el cambio: el cursor se queda quieto durante los tres dispatch y la
ventana llega igual.

**`silent` promete menos de lo que parece: no impide que la vista siga a la ventana si la que mueves
es la ACTIVA.** Medido: mover con `silent` la ventana enfocada se llevó `activews` con ella. Lo que
garantiza que aquí no haya salto **no es la bandera**, es que la ventana urgente por definición no es
la activa — si lo fuera, ya estarías mirándola y no habría nada que traer. Se mantiene `silent`
porque en ese caso degenerado es justo lo que evita el rebote, no porque sea lo que arregla el
parpadeo.

**Acotado a `class = "steam"` a propósito**, no a cualquier `urgent`. La sección de `anclaje.py` ya
midió el precio de generalizar: cualquier ventana que pida atención acaba viajando al escritorio del
usuario, y el síntoma es *"ventanas que aparecen de repente y se van solas"*. Un `urgent` puede
venir de un diálogo de fondo, y teletransportarlo sería peor que el problema que arregla.

Fail-open hacia **no hacer nada** (todo en `pcall`): el peor caso es que la ventana se quede donde
estaba, justo el comportamiento previo al módulo. Los escritorios especiales (`id <= 0`) quedan
fuera, mismo criterio que `ancla-escritorio.lua` y `compactar.lua`. Y ojo al tocarlo: los callbacks
tienen **timeout de 100 ms**, los dos `dispatch` son inmediatos y no debe entrar nada que espere.

La regla que las hace flotantes vive aparte, en `gigishell/reglas.lua` (`steam-ventanas-secundarias`).
Va **sin `size`**: Steam pide su propia geometría por ventana y `persistent_size` recuerda la que tú
le dejes. Cuidado con el falso negativo de ahí: **flotar a mano una ventana ya mapeada en mosaico**
le deja la geometría del tiling —casi media pantalla— y parece que la regla fuerza "tamaño máximo"
cuando en realidad no había regla actuando. Hay que juzgarla con una ventana **recién abierta**.

### SUPER + tecla sin atajo no debe escribirse (`gigishell/nop-binds.lua`)

Con SUPER pulsado, una tecla que **no** forma un atajo llegaba a la aplicación: `SUPER+C` escribía
una `c`. Es al revés que en Windows, donde la tecla Win sin atajo no hace nada.

**No hay opción global para esto: Hyprland solo se traga una tecla si algún bind la captura.** El
candidato obvio es `catchall`, y el compositor lo rechaza — medido, no supuesto: responde *«Invalid
catchall, catchall keybinds are only allowed in submaps»*. La API Lua tampoco lo trae:
`HL.BindOptions` no tiene `catchall` ni `any`. Así que la única vía es **enumerar** una combinación
por tecla (letras, dígitos, puntuación, F1–F12, teclado numérico, navegación y edición; para
`SUPER`, `SUPER SHIFT`, `SUPER CTRL` y `SUPER ALT`).

**Antes era un fichero generado de 335 líneas** (`keybinds-nop.conf`) más su generador
(`generar-nop-binds.sh`), que parseaba `hyprctl binds` para saber qué combinaciones estaban ya
usadas. Hoy son **~10 líneas de bucle** en `gigishell/nop-binds.lua`, y esa es una de las tres cosas
que pagaron la migración a Lua ella sola: al vivir dentro del mismo config, la lista de "lo que ya
es un atajo" **no hay que descubrirla** — la tiene delante.

**El envoltorio `bind()` de `gigishell/keybinds.lua` es lo que lo sostiene**: anota cada combinación
(normalizada: mods ordenados y en mayúsculas, así `"SUPER SHIFT + E"` y `"shift+super+e"` casan) en
una tabla `usados`, que `nop-binds` consulta. **Todo atajo nuevo debe pasar por ese envoltorio**, no
por `hl.bind` directo. Saltárselo **no da ningún error**: solo deja esa combinación con dos binds
—el tuyo y un sordo de más—, que Hyprland ejecuta ambos, así que es inofensivo pero deja los sordos
sin reflejar la realidad. Hay un aviso gordo en la cabecera del módulo por eso.

**El no-op es `hl.dsp.no_op()`, nativo.** Antes era `submap, reset`, que solo era inerte *mientras
no existiera ningún submap* en toda la configuración — una trampa que había que documentar y que
aquí desaparece.

**Ya no hay nada que regenerar ni que se pueda desincronizar**: el bucle se recalcula en cada carga
del config. El gesto de "recoger los atajos nuevos" (activar el ajuste para forzar una
regeneración) dejó de existir porque dejó de hacer falta.

**Ajuste**: `absorberSuperSinAtajo` en `~/.config/gigishell/preferences.json` (Ajustes >
Personalización > Ventanas y escritorios), **ausente = activado** — ojo al leerlo, se comprueba
`== false` explícitamente, porque un `nil` tiene que activar. Se aplica **en caliente**: el setter
de AGS escribe la preferencia (síncrono) y dispara `hyprctl reload`, que re-ejecuta el config y
vuelve a decidir. Desactivado, los sordos sencillamente no se registran: no queda ningún fichero
residual que borrar ni comentar.

### Escritorio ancla: ir y volver (`gigishell/ancla-escritorio.lua`)

`SUPER + SHIFT + S` marca el escritorio actual como **ancla** (repetido ahí mismo, lo desmarca) y
`SUPER + S` es el vaivén: **fuera** del ancla te lleva a ella apuntando de dónde venías, y **en**
ella te devuelve a ese sitio apuntado. `vuelta` se reescribe en **cada** salto hacia el ancla, así
que "volver" significa el sitio desde el que hiciste el **último** salto, no un historial — si tras
saltar a la ancla te vas a otro escritorio a mano y pulsas otra vez, el que se apunta es ese
(verificado en vivo con los dos recorridos).

**Sustituyó al workspace especial `magic`**, que ocupaba esas dos teclas y **no estaba roto**: los
binds se registraban, el dispatcher respondía y con una ventana dentro se veía a pantalla completa
(todo medido antes de tocar nada). Lo que fallaba era el único estado en el que uno lo prueba —
`misc.close_special_on_empty` lo **destruye al quedarse vacío**, y un especial vacío que se abre no
dibuja **nada**: ni marco, ni fondo, ni aviso. O sea que parecía muerto sin dar ningún error. Si
alguien lo quiere de vuelta, el porqué y los dos dispatchers están en el comentario de
`gigishell/keybinds.lua`, junto a los binds nuevos.

**El estado va a un FICHERO, no a un local de Lua**, y ahí se aparta a propósito de
`GiGiShell.toggle_gaps()`: en el toggle de gaps el `hyprctl reload` resetea a la vez el flag y los
gaps, así que quedan coherentes; aquí no hay nada en el compositor que resetear, y un reload
borraría el ancla **sin que se note** hasta que pulsaras el atajo y no fuera a ninguna parte. Y los
reloads no son raros: AGS dispara uno al tocar `absorberSuperSinAtajo`, entre otros (verificado que
el ancla sobrevive a un `hyprctl reload`). Vive en `$XDG_RUNTIME_DIR/gigishell-ancla-escritorio`
(tmpfs), que da justo la duración que se quiere: **por sesión**, como el Wake up. En `~/.config`
sobreviviría a un reinicio y acabarías saltando a un escritorio de ayer.

**Fail-open hacia "el atajo no hace nada"**: todo va en pcall y cualquier error —fichero ilegible,
contenido a medias, la API devolviendo `nil`— degrada a "no hay ancla", que se arregla volviendo a
anclar. Lo contrario (saltar a un escritorio cualquiera por leer mal un número) movería al usuario
de sitio sin que lo pidiera, que es el fallo molesto de verdad. Por lo mismo, un id `<= 0` en el
fichero cuenta como "ninguno". Los **especiales** quedan fuera (ni se anclan ni se apuntan), igual
que en `limite-ventanas.lua` y `compactar.lua`.

**Cada gesto avisa en pantalla** (`util.notificar`, 2 s). No es adorno: anclar es invisible por
definición —no mueve nada—, y callar ahí reproduce exactamente el fallo del scratchpad, que es
"pulso y no sé si ha pasado algo". Por eso también habla el caso "estás en el ancla pero aún no hay
sitio al que volver". De ahí el `opts.crudo` nuevo de `util.notificar`: quita el prefijo
`[GiGiShell Lua]`, que existe para distinguir un **fallo del config** de un aviso de otro programa y
que en una confirmación rutinaria se lee como un error. Los avisos de fallo siguen con prefijo.

### Update monitor (`updates-monitor.sh`)

Checks for pending updates and surfaces the **important** ones as bar icons (AGS
`modulos/barra/indicadores/sistema/Actualizaciones.tsx`): **two separate icons, one for the kernel (orange Tux) and one
for GPU drivers (green)**, each shown only when its own category has something pending.
Ordinary package/dependency updates deliberately show **no icon at all** — they were pure noise;
they are only listed as context ("Otros: N paquetes") inside the popover. Launched from
`gigishell/autostart.lua` as `sleep 20 && …/updates-monitor.sh` — el retardo deja que el resto de la
sesión termine de cargar antes de la primera consulta, que toca **red** y sincroniza una BD
temporal de pacman (eran 3 s; se subió a 20 al escalonar el arranque). El retardo va ahí y no
dentro del script porque el toggle maestro de AGS lo re-ejecuta en caliente, y ahí sí se quiere
inmediato.

**A package-DB watch is what makes the icon go away after you update.** Periodic re-checks alone
left the icon stuck: `updates.json` kept advertising what you had just installed until the next
interval elapsed. So the loop blocks on `inotifywait` over the distro's local package DB
(`/var/lib/pacman/local`, `/var/lib/dpkg`, `/usr/lib/sysimage/rpm`→`/var/lib/rpm`) *or* the
periodic timeout, whichever comes first. An install touches the DB hundreds of times, so an
event is followed by a **debounce** (re-check only after 5 s of quiet). This fires whether you
updated from the popover's button or from your own terminal. Without `inotify-tools` it degrades
to the plain interval sleep (and, if `updatesPeriodic` is off, simply exits after one pass).

Every blocking wait (`inotifywait`, `sleep`) goes through the `blocking()` helper — child in the
background + `wait` + a `TERM` trap — **not** a plain foreground call. Bash defers signals while
waiting on a foreground child, so a foreground `inotifywait` (which can block indefinitely) would
make the master toggle's `pkill` a no-op: the script would survive, later notice a DB change, and
rewrite `updates.json`, resurrecting the icons with the feature switched off.

All polling is **read-only and sudo-free**, one branch per distro family detected from
`/etc/os-release`: Arch/CachyOS → `checkupdates` (pacman-contrib; syncs a *temp* DB in the
user cache, never the system one; falls back to `pacman -Qu`), Fedora → `dnf -q check-update`
(rc 100 = updates), Debian/Ubuntu → `apt list --upgradable` **against the existing cache, no
`apt update`**. Each pending package lands in one of three buckets: *GPU driver* (name matches a vendor actually
present per `lspci` — `*nvidia*`, or `*mesa*`/`*radeon*`/`*amdgpu*`/`*amdvlk*` for AMD), *kernel*
(`linux`, `linux-*`, `kernel`, `kernel-*` — so `util-linux` does **not** match), or *system*
(everything else, counted only). Results are written **atomically** (tmp+`mv`, built with `jq` so
names/versions are escaped) to `~/.config/gigishell/updates.json`:
`{checkedAt, distro, updateCmd, system: <count>, kernel: [{name, from, to}], gpu: [{…}], systemSample: [<=20 names]}`.
The widget watches that file with a `Gio.FileMonitor` — a missing/corrupt file simply means
"no updates" (icons hidden). Requires `jq`; without it the script exits without writing.

**Config** (`~/.config/gigishell/preferences.json`, written by `PersonalizationSection.tsx`):
`updatesMonitor` (master), `updatesPeriodic`, `updatesIntervalHours` (default 3). Like
`batteryMonitor`/`tempMonitor`, the bash reads these **once at process start** — but the
*master* toggle is applied hot by its AGS setter (`pkill` + delete the JSON on off, re-exec on
on), so only the periodic/interval keys need a script restart.

### Screencast monitor (`screencast-monitor.sh`)

Detecta que **algo está capturando la pantalla** y lo publica en
`~/.config/gigishell/screencast.json` (`{active, checkedAt, sources:[{kind:"share"|"record", app}]}`,
escrito atómicamente con `jq` + tmp/`mv`, y **solo cuando el conjunto de fuentes cambia** — así
compartir dos horas no reescribe el fichero ni despierta al widget; pero el memo que decide "ha
cambiado" arranca con un **centinela**, no vacío: si arrancara vacío, el primer sondeo sin nada
capturando se compararía consigo mismo y no escribiría, dejando en pie el JSON de la sesión
anterior — un "Discord compartiendo" sobrevivía al reboot y el icono se quedaba encendido). Lo consume
`ags/modulos/barra/indicadores/sistema/CapturaPantalla.tsx` con un `Gio.FileMonitor`; fichero ausente = nada
capturando = icono oculto.

Un único coordinador conserva en memoria dos estados, porque las formas de capturar no comparten
mecanismo. **Compartir pantalla** (Discord, OBS, Zoom, navegadores) pasa por
`xdg-desktop-portal-hyprland`, que crea un nodo PipeWire `Video/Source`: `pw-mon -p` alimenta un
filtro `awk` que recuerda los ids de los nodos/enlaces de vídeo y descarta todos los demás
eventos (incluido el audio); después de cada ráfaga espera **300 ms reales sin otra señal** y
solo entonces ejecuta un `pw-dump`. No se hace una consulta por cada línea encolada. Se filtra
por nodo del portal y se **excluyen las cámaras** (`v4l2_*`/`libcamera*`) para que la webcam no
encienda el icono;
además, el nodo debe estar **`running` o tener un link `active`**: Discord/Electron puede dejar
un nodo `idle` huérfano al terminar de compartir, y contar su mera existencia mantenía el icono
encendido aunque ya no hubiera captura. Cuando PipeWire lo expone, se sigue el link activo hasta
el nodo `Stream/Input/Video` para nombrar la app consumidora (si no, la etiqueta cae a
"Pantalla"). **Grabar en local** (`wf-recorder`, `gpu-screen-recorder`, `wl-screenrec`, `obs`)
usa wlr-screencopy y **no toca PipeWire**: no hay señal a la que suscribirse, así que ahí se
sondea solo `pgrep` cada 3 s, sin volver a ejecutar `pw-dump`. El coordinador combina ambos
resultados y escribe únicamente si cambia el conjunto final; no usa estado auxiliar en disco.

El trap `TERM` mata al coproceso **y a sus hijos** (`pw-mon`, `awk`) y borra el JSON. El
coproceso se ejecuta con un argv propio (`gigishell-screencast-events`): si heredara
`screencast-monitor.sh`, el `pkill -f` del toggle mataría padre e hijo a la vez y podría dejar
`pw-mon` huérfano antes de que el padre hiciera la limpieza. Requiere `jq` y `pw-dump`;
sin ellos sale sin escribir.

**Filtro de PipeWire, medido en esta máquina (no supuesto):** el nodo del portal se identifica
por `node.name == "xdg-desktop-portal-hyprland"` (**no** `xdpw-stream-*`, como se asumía antes de
medir). La webcam es también `media.class=Video/Source` (`node.name=v4l2_input.*`), por eso
excluirla con `v4l2_*`/`libcamera*` es obligatorio, no una precaución de más. La app consumidora
**sí es resoluble**: siguiendo el link (`link.output.node` del nodo del portal →
`link.input.node` de un nodo `Stream/Input/Video`, ambos números en los props) se llega a un nodo
cuyo **`node.name`** trae el nombre ("Discord") — `application.name` viene **vacío** en ese nodo,
así que el orden de preferencia es `application.name // node.name // application.process.binary
// "Pantalla"`.

**Config**: `screencastIndicator` en `~/.config/gigishell/preferences.json` (ausente = activado),
leído **una vez al arrancar** — pero el toggle es maestro y su setter de AGS lo aplica **en
caliente** (`pkill` + borrar el JSON al apagar; re-exec al encender), así que no hace falta
reiniciar nada.

### Cámara: detector de uso (`camara-monitor.sh`) + `ags/servicios/camara/`

Dos cosas distintas que conviene no confundir: **quién está usando la cámara** (privacidad, va a
la barra) y **cómo está ajustada la cámara** (brillo, exposición… va a QuickSettings y a Ajustes).
La primera la resuelve este script; la segunda, la capa de servicio de AGS. Comparten la
enumeración y poco más.

#### Por qué la detección de uso NO puede vivir dentro de AGS

El indicador de micrófono (`modulos/barra/indicadores/audio/Microfono.tsx`) presume, con razón, de
**cero procesos, cero timers**: PipeWire gestiona todas las capturas de audio y AstalWp emite
`recorder-added` al instante. Con la cámara no hay nada de eso. **Firefox, Chrome, Zoom y OBS abren
`/dev/videoN` directamente por V4L2**, sin pasar por PipeWire, así que no existe ninguna señal a la
que suscribirse. (Es el mismo hecho que obliga a `screencast-monitor.sh` a *excluir* `v4l2_*` y
`libcamera*` de sus nodos `Video/Source`: la webcam no es una captura de pantalla y tampoco es un
nodo de PipeWire cuando la usa una app normal.)

La vía obvia —mirar quién tiene el nodo abierto recorriendo `/proc/*/fd`— **se midió en esta
máquina: 28 ms por barrido con 435 procesos**. A 2 s de intervalo eso es más del 1% de una CPU
quemado durante toda la sesión, y encima dentro del proceso que pinta la barra. Descartado.

Lo que sí existe es un evento del kernel: **inotify entrega `IN_OPEN` e `IN_CLOSE` también sobre
nodos de dispositivo**, no solo sobre ficheros normales. Comprobado antes de escribir nada:

```sh
inotifywait -m -e open -e close /dev/null   # imprime OPEN y CLOSE en cada `cat /dev/null`
```

Con eso la detección es puramente reactiva: el script se bloquea en `inotifywait` y solo trabaja
cuando alguien abre o cierra de verdad la cámara. **En reposo: cero CPU, cero forks, cero timers**,
igual que `wifi-monitor.sh` o `bt-monitor.sh`.

#### Inotify dispara, `fuser` dice la verdad

No se lleva la cuenta de OPEN menos CLOSE, y no es por pereza: **contar falla en los dos sentidos.**
Una app abre el mismo nodo varias veces, y Chromium **abre y cierra al ENUMERAR** las cámaras —
antes de usar ninguna—, así que llevar la cuenta encendería el indicador cada vez que alguien entra
en una web con videollamada. Y por el otro lado, un proceso que muere de golpe cierra sus
descriptores sin que llegue ningún CLOSE que case.

Por eso inotify es solo el **disparador**: cada evento provoca una comprobación real con `fuser`,
que le pregunta al kernel quién tiene el nodo abierto *ahora*, y los PID se traducen a su `comm`
(`firefox`, `obs`) leyendo `/proc/<pid>/comm`. El barrido caro ocurre una vez por evento, no cada
dos segundos.

Entre el evento y la comprobación hay **0,4 s de asentado** (`ASENTADO`), y son justo los que
descartan el sondeo de Chromium: para cuando se mira, el abrir-y-cerrar ya terminó y `fuser` no
encuentra a nadie. Medido con un banco de pruebas que simula cinco aperturas instantáneas seguidas:
**el indicador no llega a parpadear ni una vez**; una apertura de verdad sí lo enciende.

#### Hotplug, y por qué no se vigila `/dev` con `-e open`

Los nodos a vigilar hay que rearmarlos cuando se enchufa una webcam USB. Un **segundo**
`inotifywait` vigila `/dev` con `-e create -e delete` y, al ver aparecer un `video*`, tumba al
primero para que el bucle vuelva a enumerar (con 0,5 s de margen: udev tarda unos ms en poner las
propiedades del nodo nuevo, y enumerar antes lo dejaría fuera de la vigilancia).

Lo que **no** se puede hacer es meterlo todo en un solo `inotifywait` sobre `/dev`: un watch de
directorio reporta los eventos de *todos* sus hijos, así que `-e open` sobre `/dev` entregaría cada
apertura de `/dev/null`, `/dev/urandom` y `/dev/dri/*` — miles de eventos por minuto para descartar
el 99,9%.

#### Una webcam no es un `/dev/videoN`, son varios

Una UVC corriente registra **dos o tres** nodos: el de vídeo y uno o dos de **metadatos**
(`Video Capture Metadata`, desde el kernel 4.16). Abrir el de metadatos no da imagen, y
`v4l2-ctl --list-ctrls` sobre él contesta con la lista **vacía, sin error** — o sea que quedarse con
el primer `/dev/video*` es una moneda al aire que en media de las máquinas deja la sección de
ajustes en blanco "sin motivo", y vigilarlo para detectar uso da falsos negativos.

El criterio correcto **no es el nombre** (los dos nodos comparten el `name` de sysfs) sino la
propiedad de udev **`ID_V4L_CAPABILITIES`**, que trae `:capture:` solo en los que capturan imagen.
La rellena `60-persistent-v4l.rules` llamando a `v4l_id`, así que está en cualquier distro con udev.
El script la lee con `udevadm info` y AGS con GUdev; **si la propiedad falta, no se descarta el
nodo**: es preferible vigilar de más que dejar una cámara sin indicador.

#### El contrato con AGS

`~/.config/gigishell/camara-uso.json`, escrito atómicamente (tmp + `mv`, que es por lo que el
`Gio.FileMonitor` de AGS vigila el **directorio** y nunca lee un JSON a medias):

```json
{"enUso":true,"desde":1788054504,"camaras":[{"nodo":"/dev/video0","nombre":"Integrated Camera","apps":["firefox"]}]}
```

Lo lee `ags/servicios/camara/uso.ts` con `crearFuenteArchivoJson`. Ahí `enUso` **se deriva de la
lista, no se cree el booleano del fichero**: si el script muriera a mitad de escritura, un `true`
con lista vacía dejaría el indicador de privacidad encendido para siempre sin nada que señalar, que
es la peor forma posible de fallar para un aviso de este tipo.

El script emite además `camara.en-uso` (catálogo de `lib/notif.sh`) **solo en la transición** a
encendido. El apagado no se avisa: no es un suceso de privacidad y duplicaría el ruido de cada
videollamada.

Sin `inotify-tools` el script sale en silencio **dejando el estado en LIBRE**. Un indicador de
privacidad clavado en "te están grabando" es peor que no tener indicador.

#### Los controles V4L2 se pierden solos — por eso hay persistencia

Los controles (brillo, contraste, exposición, balance de blancos…) **no viven en la cámara: viven en
el driver del kernel**, en la estructura que se crea al registrar el dispositivo. Se van al
desenchufar la webcam, al recargar `uvcvideo` y al reiniciar. Sin reposición, quien ajusta el brillo
porque su webcam sale oscura tiene que volver a ajustarlo en cada arranque, y nada le avisa: le
vuelve a salir oscura y ya está.

`ags/servicios/camara/persistencia.ts` guarda lo elegido en `~/.config/gigishell/camara.json` (fuera
del repo, como todo el estado de usuario) y lo repone al iniciar sesión **y en cada `add` de udev**,
que es justo cuando vuelve a hacer falta. Tres detalles que no son adorno:

- **Se indexa por aparato, no por nodo.** La clave es el serial USB, o `vendor:product` si el
  fabricante no pone serial — nunca `/dev/videoN`, que el kernel reparte por orden de aparición: con
  eso, enchufar la webcam en otro puerto aplicaría los ajustes de una a la otra.
- **El orden de escritura importa.** `fijarControles()` manda los `*auto*` **primero**: si
  `white_balance_automatic=0` no se ha aplicado todavía, el `white_balance_temperature=5200` que va
  detrás cae en un control `inactive` y **se descarta en silencio**. Ese orden es la diferencia
  entre que los ajustes guardados se restauren o no.
- **`flags=inactive` llega hasta la UI.** Un control encadenado a un automático encendido acepta la
  escritura, `v4l2-ctl` sale con 0 y el valor no cambia. La UI lo deshabilita en vez de dejar que el
  usuario arrastre algo que no hace nada.

Y una limitación que la UI tiene prohibido disimular: **no existe ninguna «cámara por defecto» en
Linux.** A diferencia del audio, donde WirePlumber tiene `default.configured.audio.source` (ver la
sección de endpoints de audio del CLAUDE.md de ags), ni V4L2 ni PipeWire publican nada equivalente
para vídeo: Firefox, Chrome y Zoom eligen con su propio selector interno. La «cámara preferida» de
GiGiShell vale para la vista previa, los ajustes y el indicador — y así se dice en pantalla.

La resolución y los fps corren la misma suerte: los negocia la app al abrir el stream
(`VIDIOC_S_FMT`), así que `formatos.ts` es una **ficha informativa** de lo que el aparato soporta,
nunca un desplegable que se pueda «aplicar».

#### Killswitch: bloquear la cámara (`system/camara/` + `servicios/camara/bloqueo.ts`)

El interruptor «Cámara bloqueada» de QuickSettings y de Ajustes > Cámara. AGS no bloquea nada: los
nodos `/dev/video*` son de `root:video` y quien decide sus permisos es udev, así que el trabajo lo
hace `/usr/local/bin/gigishell-camara` (root-owned, fuente en `system/camara/gigishell-camara.sh`),
autorizado sin contraseña por `/etc/sudoers.d/gigishell-camara` **solo** para `block` y `unblock`.
Mismo esquema que TLP y ClamAV. `status` queda fuera de la regla a propósito: no necesita root, solo
comprueba si existe un fichero world-readable, y meterlo ampliaría el grant sin ninguna ganancia.

**El estado ES la presencia del fichero de regla**, no un JSON nuestro. Así el bloqueo sobrevive a
reiniciar sin que nadie tenga que acordarse de reponerlo, y se deshace desde un TTY con un `rm` si
algún día la UI no arranca.

##### El número de la regla es lo más importante de todo esto

La regla se llama **`71-`**, y no `99-` como el resto de las nuestras, porque tiene que colarse
**entre dos reglas del sistema**:

```
/usr/lib/udev/rules.d/70-uaccess.rules:34   SUBSYSTEM=="video4linux", TAG+="uaccess"
/usr/lib/udev/rules.d/73-seat-late.rules    TAG=="uaccess|…", RUN{builtin}+="uaccess"
```

En el 70 se **marca** el dispositivo y en el 73 se **ejecuta** el builtin que le concede la ACL al
usuario de la sesión. Nuestro `TAG-="uaccess"` tiene que ocurrir después del 70 (o no habría nada
que quitar) y antes del 73 (o el builtin ya estaría encolado con el tag puesto). Una
`99-gigishell-camara.rules` —el nombre natural en este repo— quitaría el tag **después** de que la
decisión estuviera tomada: no daría ningún error, `udevadm control --reload-rules` diría que todo
bien, y la cámara seguiría abriéndose con normalidad. La regla se valida con `udevadm verify`.

##### Y por qué además se hace `chmod 000` a mano

La regla gobierna los nodos que udev procese **a partir de ahora**. Los que ya existen conservan la
ACL que el builtin les puso al arrancar la sesión, y `udevadm trigger` **no la revoca**: el builtin
`uaccess` solo corre cuando el dispositivo está etiquetado, así que al quitarle el tag nadie vuelve
a pasar por ahí a deshacer lo hecho. Sin el chmod, «bloquear» no tendría ningún efecto hasta
desenchufar la webcam o reiniciar.

`chmod 000` basta —y es preferible a pelearse con `setfacl`— porque **en un fichero con ACL los bits
de grupo del modo son la máscara**. Comprobado antes de escribir el helper:

```
$ setfacl -m u:nobody:rw f && chmod 000 f && getfacl -c f
user:nobody:rw-   #effective:---
mask::---
```

root sigue pudiendo abrir el nodo (`CAP_DAC_OVERRIDE`), que es lo que permite desbloquear después.

##### Y el desbloqueo tiene que deshacerlo a mano, o la cámara se queda muerta

`unblock` borraba la regla, recargaba udev y daba el trabajo por hecho. **No lo estaba**: udev fija
dueño y modo del nodo al **crearlo**, y en el evento `change` que manda `udevadm trigger` sobre un
nodo que ya existe no vuelve a aplicarlos. Medido tras un `unblock`: `c--------- root root`, con la
entrada `user:<usuario>:rw-` de la ACL intacta pero `#effective:---` por la máscara — o sea la
cámara **inaccesible hasta el siguiente arranque**, mientras `status` decía `unblocked` y la UI
pintaba el interruptor apagado. Ningún error por ningún lado, y en un portátil no hay ni la
escapatoria de desenchufarla. Es la misma asimetría de arriba en el otro sentido, así que el remedio
es simétrico: el desbloqueo repone `0660 root:video` en los nodos vivos (lo que dejan
`50-udev-default.rules` y el modo por defecto de udev), y con la máscara otra vez en `rw` la ACL de
sesión vuelve a ser efectiva.

##### Lo que el killswitch NO hace, y la UI lo dice

Impide **abrir** la cámara; no cierra un descriptor ya abierto. Una app que estuviera emitiendo
cuando se pulsa el bloqueo sigue viendo imagen hasta que suelte el dispositivo. Cortarla exigiría
matarle el proceso o descargar `uvcvideo` a la fuerza, y ninguna de las dos cosas es aceptable para
un interruptor de un panel de ajustes. Por eso `block` avisa por stderr si alguien la tiene abierta
en ese momento, y las dos vistas lo enseñan: un interruptor que dice «bloqueada» mientras el piloto
de la webcam sigue encendido sería mentira.

Efecto lateral que hay que tener presente al tocar la UI: **con la cámara bloqueada `v4l2-ctl` falla
por permisos**, así que la lista de controles sale vacía. Las dos vistas distinguen ese caso del
«esta cámara no expone controles» y relanzan la lectura al desbloquear; sin eso, desbloquear dejaría
la sección sin un solo mando hasta salir y volver a entrar.

##### La trampa que cubre `preflight.sh`

El bloqueo sobrevive a todo (es un fichero en `/etc`), pero el **helper** no: una instalación nueva
donde el paso `sistema` no llegó a correr, o un `/usr/local` limpiado, deja la cámara bloqueada **y
sin nada capaz de desbloquearla desde la UI**. `bin/preflight.sh` comprueba el par entero y lo marca
como ERROR con las dos salidas (`bash install.sh --solo sistema`, o borrar la regla a mano).

#### Vista previa

«Probar cámara» lanza un `mpv` aparte (clase `gigishell-camara-preview`, con su regla en
`gigishell/reglas.lua`) y no un widget dentro del panel. Empotrar vídeo en GTK4 exigiría un
`gtk4paintablesink` y un pipeline de GStreamer vivo dentro del proceso que pinta la barra: si el
pipeline se atasca —y una cámara desenchufada a mitad de stream lo hace— se lleva por delante el
hilo principal del **shell entero**. No compensa para un botón que se usa diez segundos.

#### Qué se probó de verdad

Esta máquina es un sobremesa **sin cámara** (`/dev/video*` no existe, `uvcvideo` sin cargar), así
que el detector se validó con un banco de pruebas que sustituye `/dev` por un directorio y el nodo
por un fichero: enumeración vacía → `enUso:false`; aparición del nodo → rearme del vigilante;
proceso que lo mantiene abierto → `enUso:true` con su `comm` resuelto; cierre → vuelta a libre; y
cinco aperturas instantáneas seguidas → ningún parpadeo. El parser de `v4l2-ctl` sí está probado
contra salida real (`controlesDatos.test.ts` usa la de una Logitech C920, con sus tres tipos de
control, un `flags=inactive` y un menú con huecos).

### Modo gestos por cámara (`gestos.sh` + `hypr/scripts/gestos/`)

Manejar el escritorio moviendo la mano delante de la webcam. Se enciende y se apaga con **SUPER+SHIFT+G**
(o desde Ajustes > Cámara > Gestos) y **no se autoarranca**: no hay ninguna línea suya en
`gigishell/autostart.lua`, al contrario que el resto de piezas de cámara. Un monitor de uso en reposo
cuesta cero porque bloquea en inotify; esto enciende la webcam, quema medio núcleo y deja la cámara
ocupada para cualquier otra aplicación. Un modo así se pide a propósito o no se pide.

Cinco gestos:

| gesto | acción |
| --- | --- |
| palma abierta desplazándose en horizontal | escritorio anterior / siguiente (`focus{workspace='e±1'}`) |
| pulgar + índice juntos (pellizco) | agarrar la ventana activa y recolocarla, sin sacarla del mosaico |
| **dos** pellizcos rápidos | flotar la ventana, o devolverla al mosaico (flip-flop) |
| puño cerrado | pausa corta: no se reconoce nada mientras lo mantengas |
| abrir y cerrar la mano **dos veces** | pausa larga (modo de espera): entra y sale |

#### Dos pellizcos rápidos: flotar o volver al mosaico

Un flip-flop sobre la ventana activa (`hl.dsp.window.float({action='toggle', window=…})`). No lleva
lógica de arrastre propia: **el arrastre ya se adapta solo** porque `_iniciar_arrastre` lee
`floating` al agarrar, así que tras alternar, el mismo pellizco sostenido pasa a mover la ventana
libremente o a recolocarla por pasos según haya quedado. Verificado en vivo, mosaico → flotante →
mosaico → flotante, comprobando además que `Arrastre.flotante` sigue al modo real.

Dos detalles de orden que no son casualidad:

- **El evento `flotar` se emite ANTES del `arrastre-inicio` del mismo frame.** Así el demonio alterna
  primero y el arrastre nace leyendo el modo nuevo; al revés habría que rehacerlo a posteriori. Y
  entre las dos cosas hay una pausa de 60 ms porque Hyprland rehace el reparto al sacar o meter una
  ventana: sin ella se leería la geometría anterior y el arrastre empezaría con un salto.
- **`action='toggle'` en TABLA**, aunque aquí el toggle sea justo lo que se quiere. El motivo es
  otro: con la cadena `'toggle'` Hyprland tira el argumento **y también el selector `window`**, así
  que alternaría la ventana ACTIVA en vez de la pedida. Suelen coincidir, y por eso el fallo pasaría
  desapercibido hasta el día en que el foco cambie a mitad de gesto.

##### Lo difícil no es detectarlo: es NO detectarlo mientras arrastras

Soltar y volver a pellizcar es lo que uno hace constantemente al mover una ventana — agarras, la
llevas un trecho, sueltas para recolocar la mano, vuelves a agarrar. Si cualquier par de pellizcos
seguidos alternara el flotante, arrastrar una ventana la sacaría y la metería en el mosaico sola cada
dos por tres. De ahí que un **toque** sea un pellizco breve (`tap_pellizco_max`, 0,45 s) **que no
llegó a mover la ventana**: las dos condiciones hacen falta, porque la duración sola dejaría pasar un
tirón corto que sí recolocó, y «no movió» sola dejaría pasar un agarre largo en el que te lo pensaste
sin mover la mano. Lo cubre `test_SOLTAR_Y_REAGARRAR_MIENTRAS_ARRASTRAS_NO_dispara`.

Y una guarda que salió de un test en rojo: **el pellizco que cierra un par no siembra otro**. Sin
ella, tres toques seguidos disparaban DOS veces (medido) — el segundo, que es el que sostienes para
arrastrar, dejaba su toque al soltarse y se emparejaba con el tercero, así que la ventana entraba y
salía del mosaico sola. Con la guarda los toques se agrupan de dos en dos, como uno espera.

El gesto dispara **al empezar el segundo pellizco**, no al soltarlo, para que ese mismo pellizco siga
vivo y ya arrastre: «dos pellizcos rápidos y la muevo flotante» en un solo movimiento continuo.

#### El modo de espera: dos pausas, y no sobra ninguna

Hay **dos** formas de decirle al modo que no te haga caso, y hacen cosas distintas:

- **Puño cerrado** — pausa mientras lo mantengas. Es un estado (`NEUTRO`), no una orden: en cuanto
  abres la mano vuelve a estar armado. Sirve para rascarte la cara sin cambiar de escritorio.
- **Abrir y cerrar la mano dos veces** — pausa **enclavada** (`ESPERA`). Baja las manos, sigue
  trabajando y el modo no vuelve a mirarte hasta que repitas el mismo gesto. Es lo que evita tener
  que apagarlo entero cuando solo quieres un rato de tranquilidad.

Tres decisiones que no se deducen del código:

- **La espera SOBREVIVE a que la mano salga del cuadro.** Es el único estado que lo hace; todo lo
  demás cae a `BUSCANDO` cuando no hay mano. Y tiene que ser así: bajar las manos es exactamente lo
  que uno hace justo después de pedir la pausa, así que si eso la deshiciera el gesto no serviría
  para nada.
- **Entrar en espera SUELTA una ventana agarrada.** Estando en espera ya no se procesa el pellizco,
  así que nadie emitiría el `arrastre-fin` y la ventana se quedaría agarrada para siempre.
- **Se cuentan CIERRES, no se casa una secuencia de cuatro posturas.** Para que haya un segundo
  cierre hay que haber abierto la mano entre medias, así que contar `abierta → puño` dentro de una
  ventana ya describe el gesto entero.

##### ⚠️ Comparar contra la postura del frame anterior NO funciona

Cerrando la mano se pasa por posturas intermedias (dos o tres dedos extendidos = `OTRA`). Si el
cierre es lento, esa intermedia **llega a confirmarse** y la secuencia real es `ABIERTA → OTRA →
PUÑO`: comparando contra la postura inmediatamente anterior el cierre no se cuenta, y el gesto falla
justo cuando se hace despacio — que es como lo hace quien todavía no le ha cogido el punto, o sea el
caso en que más parece que la función está rota. Se compara contra la última postura **relevante**
(abierta o puño), ignorando lo que haya en medio. Cubierto por
`test_el_cierre_LENTO_cuenta_aunque_pase_por_posturas_intermedias`.

Dos guardas más, cada una con su prueba: perder la mano **borra** esa referencia (meter y sacar el
puño del cuadro dos veces no es «abrir y cerrar dos veces»), y la lista de cierres **se vacía al
disparar** (si no, un tercer cierre dentro de la ventana volvería a cumplir la condición y el modo
entraría y saldría de la espera con la mano todavía haciendo el gesto).

##### El suelo de la ventana temporal lo pone `frames_confirmacion`, no la mano

`ventana_doble` son 1,8 s y parece generoso para algo que se pide «rápido». No lo es: abrir y cerrar
dos veces son **cuatro cambios de postura**, y cada uno necesita 3 frames seguidos para confirmarse
— a 15 fps eso ya son 0,8 s solo de confirmación, y con posturas intermedias de por medio se va a
~1,6 s. Con una ventana de 1 s el gesto sería sencillamente imposible y parecería que no funciona.
Es el primer número que tocar si cuesta que entre.

##### La espera NO libera la cámara ni ahorra batería, y hay que decirlo

Sigue habiendo inferencia en cada frame, porque hay que seguir mirando por si repites el gesto. La
espera solo deja de **actuar**. Quien quiera recuperar la webcam o el núcleo y cuarto tiene que
apagar el modo (SUPER+SHIFT+G). Lo único que sí se conserva es la dormancia: sin ninguna mano en el cuadro
el bucle baja a 5 fps también en espera, y al aparecer una mano vuelve al ritmo completo en el frame
siguiente, así que el gesto para salir no se pierde.

La señal de que estás en espera es el **indicador de la barra**, que cambia de glifo (󱄄 → 󱐵,
«sensor de movimiento apagado») y se apaga de color, con el tooltip diciendo cómo volver. No es
decoración: en espera no responde nada, y eso es indistinguible de que se haya roto.

#### El reparto en tres ficheros, y por qué

- **`gestos/deteccion.py`** — landmarks → intención. **Puro**: no importa mediapipe, ni cv2, ni
  habla con el compositor. Recibe tuplas `(x, y, z)` normalizadas y un instante monótono.
- **`gestos/hypr.py`** — el puente con Hyprland.
- **`gestos/gestos.py`** — cámara, modelo, bucle, estado publicado y apagado limpio.
- **`gestos.sh`** — el conmutador; es lo único que tocan el atajo y AGS.

La separación no es estética: el motor es la parte que hay que **calibrar**, y calibrarla contra una
webcam es insufrible (ponerse delante, mover la mano, adivinar por qué no disparó). Siendo puro se
prueba con recorridos sintéticos en milisegundos y **con el intérprete del sistema, sin el venv**:

```sh
python3 -m unittest discover -s hypr/scripts/gestos -p '*_test.py'
```

#### El problema de verdad no es detectar, es NO detectar de más

Reconocer «la mano se ha movido a la derecha» es fácil. Lo difícil es que **el gesto de vuelta no
dispare el contrario**: mueves la mano a la derecha (cambia de escritorio), la traes de vuelta al
centro para repetir, y ese regreso es un recorrido hacia la izquierda idéntico al que se acaba de
aceptar. Un detector ingenuo alterna escritorios y se queda donde estaba.

##### La primera solución funcionaba y hubo que quitarla igual

Era exigir que la mano **se parase** para rearmar. Contra el regreso es lo mejor que hay. Y era el
mayor estorbo del modo, reportado así: «me obliga a tenerla recta arriba en el centro un instante y
luego desplazarme; me gustaría poner la mano donde quiera y que al moverla lo detecte, y encadenar
varios movimientos sin tener que cerrar el puño para reiniciar».

Las dos quejas salen de la misma línea. Hoy son dos mecanismos, ninguno de los cuales pide nada:

- **Armar es instantáneo.** Al confirmar la mano abierta se pasa a `ARMADO` y se **tira el
  trayecto**. Lo único que hacía falta de aquella espera era no traerse el movimiento de LEVANTAR la
  mano dentro del recorrido, y para eso basta con tirarlo. De descartar la subida diagonal ya se
  encarga la regla de dominancia horizontal (`|dx| ≥ 1,5·|dy|`), con test.
- **Rearmar es por TIEMPO** (`cooldown_swipe`), no por quietud, y al salir se vuelve a tirar el
  trayecto.

##### El compromiso, medido

No hay valor que gane en todo. Barrido con un golpe de ida de 0,25 s y regresos a distintas
velocidades:

```
cooldown   regresos que disparan por error   encadenar a propósito
  0,35 s   los de 0,55 s y 0,70 s            con 0,20 s entre golpes
  0,45 s   el de 0,70 s                      con 0,40 s
  0,55 s   ninguno                           con 0,40 s     ← de fábrica
```

0,55 es estrictamente mejor que 0,45 —mismo coste de encadenado, cero errores— así que es el valor de
fábrica, y está **en Ajustes** porque el trato es una preferencia real: quien prefiera encadenar más
deprisa a cambio de que algún regreso cuele solo tiene que bajarlo.

##### `ventana_swipe` es una velocidad mínima disfrazada

Exigir 0,20 de recorrido dentro de 0,35 s es pedir **0,57 anchos de cuadro por segundo**. Bajó de
0,70 a 0,35 al quitar la quietud, y medido resultó estrictamente mejor: con 0,70 el regreso relajado
(0,9 s y 1,3 s) disparaba el gesto contrario y con 0,35 no, mientras que un golpe deliberado —incluso
lento, 0,55 s— sigue disparando igual. El límite está sobre los **0,8 s** para cruzar medio cuadro:
por encima ya no cuenta. Es deliberado — un swipe es un golpe seco, y eso es lo que lo separa de
mover la mano por moverla.

⚠️ **Esa ventana interactúa con la tolerancia a frames perdidos, y el ritmo importa.** Las dos están
en SEGUNDOS, así que a mitad de ritmo los mismos «3 frames perdidos» son el doble de tiempo y se
comen la ventana entera. Medido: **a 30 fps un swipe aguanta 8 frames perdidos con la ventana en
0,35; a 15 fps no llegaría a 3.** Es otra razón por la que el ritmo por defecto son 30 y no 15, y por
la que los tests de huecos se corren explícitamente a `dt = 1/30` y no al 1/15 del banco.

#### Un puño junta el pulgar y el índice igual que un pellizco

El fallo más caro de los medidos, y lo cazó una prueba antes de que ninguna mano se pusiera delante
de la cámara. La detección natural del pellizco es la distancia pulgar-índice normalizada por el
tamaño de la mano. **Pero al cerrar el puño, la punta del pulgar queda pegada a la del índice**: la
razón de un puño ronda 0,6, por debajo del umbral de salida. O sea que un puño se detecta como
pellizco, y con eso se van los dos gestos a la vez — el «no me hagas caso» nunca llega a `NEUTRO` y
cerrar la mano agarra una ventana.

La distancia no puede distinguirlos porque en los dos casos es corta. Lo que sí los distingue es
**dónde** está esa unión: en un pellizco el índice apunta hacia fuera y la punta queda lejos de la
muñeca; en un puño está recogida contra la palma. De ahí `alcance_indice()` (distancia punta del
índice → muñeca, en unidades de mano): un pellizco pasa de 1,1 y un puño no llega a 0,8. Se exige
tanto para entrar como **para seguir dentro**, así que cerrar la mano encima de un arrastre lo
suelta en vez de dejarlo agarrado.

Otras dos decisiones del motor que parecen detalles y no lo son:

- **El centro de la palma, no la muñeca.** El punto 0 es el landmark más ruidoso del modelo (está
  en el borde del recorte) y baila varios puntos porcentuales con la mano inmóvil. Ese temblor se
  traduce en velocidad aparente, y la velocidad es justo lo que decide si la mano está quieta. Se
  usa la media de muñeca y los cuatro nudillos.
- **Dedo extendido = distancia a la muñeca, no coordenada Y.** Con Y, una mano girada de lado da un
  recuento sin sentido — y una mano de lado es exactamente como se pone al hacer un swipe.

#### ⚠️ Y con la mano ABIERTA detectaba pellizcos: el veto de los cuatro dedos

Reportado justo después de arreglar lo anterior: «cuando tengo la mano abierta a veces me detecta el
pellizco, es muy sensible». Causa directa: se había subido `pellizco_entra` de 0.45 a 0.55 para dar
margen al pellizco (0.36 dejaba solo nueve centésimas), y **el margen que se quitó fue el de la mano
abierta**. Los 0.98 de la mano abierta son de una pose con los dedos bien separados; relajada y en
movimiento baja mucho más de lo que sugiere ese número.

Devolver el umbral a 0.45 habría bastado a medias. El arreglo bueno sale de mirar la tercera columna
de las medidas, que hasta entonces no se usaba para nada:

```
             razón_pellizco   alcance_indice   dedos_extendidos
puño              0.26          0.78 – 0.80          0
pellizco          0.36          1.19 – 1.21          0
mano abierta      0.98          1.77 – 1.78          4
```

**La mano abierta es la única de las tres con los cuatro dedos estirados.** Así que «con cuatro dedos
estirados NO hay pellizco» la separa **sin depender de la distancia pulgar-índice**, que es justo la
medida que se estaba colando. Hay test con razones absurdamente bajas (0.10, más baja que un puño):
con cuatro dedos fuera sigue siendo mano abierta.

El corte es **cuatro y no tres** a propósito: un pellizco «de OK» —índice tocando el pulgar, los
otros tres estirados— cuenta 3 y tiene que seguir funcionando. También tiene test.

##### Y el fixture volvió a mentir, otra vez

Añadir el veto tumbó **quince** pruebas de golpe. No era el veto: la mano sintética pellizcaba con
los **cuatro dedos estirados**, una postura que no existe — la misma clase de irrealidad que ya había
descalibrado `alcance_indice_min`. El pellizco sintético se reconstruyó contra las medidas y ahora
las clava (razón 0.36, alcance 1.20, dedos 0).

De paso cayó una afirmación que estaba mal en una prueba: con el pellizco desactivado, una mano
pellizcando **queda como PUÑO, no como ABIERTA**. Un pellizco real tiene los cuatro dedos recogidos
igual que un puño, así que sin el discriminante eso *es* un puño. La prueba anterior esperaba ABIERTA
porque describía la mano imposible.

Es la tercera vez en esta sección que el mismo error muerde. **Un fixture sintético que no se ha
contrastado con una medida real no es una prueba: es una suposición con `assert`.**

#### El socket de Hyprland, no `hyprctl`

`hypr.py` habla directamente con `$XDG_RUNTIME_DIR/hypr/$HIS/.socket.sock` y es la única pieza del
repo que lo hace; el resto usa `hyprctl` con `subprocess`, y está bien porque son de un solo
disparo. Este demonio manda una orden **por frame** durante un arrastre. Medido en esta máquina,
50 llamadas a `j/activewindow` por cada vía:

```
socket unix directo : 0.05 ms/llamada
hyprctl (subprocess): 7.38 ms/llamada      ← 148 veces más
```

A 15 fps son 0,75 ms/s contra **110 ms/s** quemados solo en `fork`+`exec`, con el demonio ya pagando
33 ms por frame de inferencia.

#### ⚠️ `w.at` es de solo lectura, y MIENTE al comprobarlo

`HL.Window` tiene un campo `at`, y el camino evidente para mover una ventana sería asignarlo. **No
funciona**: el compositor responde `attempt to modify read-only hl object` y la ventana no se mueve.

Lo peligroso es cómo se comporta al medirlo. Un `pcall` alrededor de la asignación devuelve
**`ok=true, err=nil`** —medido— porque el rechazo no es un `error()` de Lua que pcall pueda atrapar:
se anota en la respuesta del `eval` y la ejecución sigue como si nada. Así que la sonda «¿es
escribible?» contesta que SÍ, la ventana no se mueve, y no hay ninguna excepción a la que agarrarse.
**Solo mirando la respuesta cruda del socket aparece el error** — ni el pcall, ni el código de
salida, ni `hyprctl` (que se come el mensaje) lo delatan. Lo mismo vale para `w.size`.

La forma correcta la da el propio compositor si se le pasa una clave que no conoce:

```
hl.window.move: unrecognized arguments.
Expected one of: direction, x+y(+relative), workspace, into_group, out_of_group
```

O sea `hl.dsp.window.move({x=…, y=…, window='address:0x…'})`, sin `relative` = absoluto. Se usa el
absoluto y no el relativo a propósito: cada orden recoloca desde el ancla, así que un frame perdido
no descoloca nada, mientras que sumando incrementos el error se acumula y la ventana se queda atrás
de la mano.

Con un aviso: **sobre una ventana en mosaico no hace nada y responde `ok`.** Medido. Tiene sentido
—la posición la decide el layout— pero significa que el valor de retorno no se puede leer como «se
ha movido», así que tampoco sirve para *descubrir* si una ventana era flotante intentándolo. Hay que
mirar `floating` antes.

#### ⚠️ EL PELLIZCO NO SACA LA VENTANA DEL MOSAICO

La primera versión ponía la ventana a flotar para poder darle coordenadas. Movía, sí, y por eso
pasó las pruebas — pero rompía lo que importa: **una ventana sacada del mosaico ya no vuelve a
recolocarse sola**, así que el escritorio quedaba desbaratado después de cada gesto y había que
recomponerlo a mano. Es el fallo clásico de resolver «mover una ventana» con la herramienta que da
control absoluto en vez de con la que respeta el gestor.

Lo correcto es que el modo de la ventana lo decida **la ventana**, no el gesto. De ahí los dos
caminos, elegidos leyendo `floating` UNA vez al agarrar:

| la ventana está… | qué se le pide | por qué |
| --- | --- | --- |
| en mosaico | `recolocar()`: pasos discretos por dirección | su posición la decide el layout; lo único que se le puede pedir es que Hyprland rehaga el reparto |
| ya flotando | `mover()`: posición absoluta | para eso sirve flotar |

**El movimiento direccional NO vale para una ventana flotante**, y es lo que obliga a tener los dos
caminos en vez de uno: medido, `movewindow <dir>` sobre una flotante la **estampa contra el borde de
la pantalla** (`[764,3]` → `[0,3]` → `[0,0]` con dos órdenes), no la desplaza un poco.

##### El `preselect` de delante no es adorno

`recolocar()` manda tres órdenes, no una, y son la misma secuencia que usa SUPER+SHIFT+flecha en
`gigishell/keybinds.lua` (donde está la medición completa):

```lua
hl.dsp.layout('preselect <dir>')
hl.dsp.window.move({direction='<dir>', window='address:0x…'})
hl.dsp.layout('preselect none')
```

Sin el `preselect`, dwindle resuelve `movewindow <dir>` sacando la ventana del árbol y
reinsertándola junto a un punto focal 1 px más allá del borde: el lado del corte sale de en qué
**cuadrante** del vecino cae ese punto —un ángulo, no la dirección que has pedido—. Con dos ventanas
coincide; con tres o más, no.

El `preselect none` del final limpia el override. Hyprland lo consume al reinsertar, pero un
`movewindow` que **no mueve nada** (la ventana ya está en ese borde) sale antes de tocar el árbol y
lo dejaría puesto: la siguiente ventana que abrieras nacería en esa dirección sin que nadie lo haya
pedido. **En un gesto esto pasa constantemente** —llevas la mano al borde y sigues empujando—, así
que aquí importa bastante más que con el teclado.

##### Lo que se intentó primero y NO funciona: el arrastre nativo con warp del cursor

Lo elegante habría sido iniciar `hl.dsp.window.drag()` (el dispatcher del `bindm` de
SUPER+botón izquierdo) y llevar el cursor con la mano: Hyprland recoloca al soltar, exactamente como
con el ratón. **No funciona.** Medido: con el arrastre iniciado, seis `hl.dsp.cursor.move` seguidos
mueven el puntero pero la ventana **no se mueve ni un píxel**, ni durante ni al soltar. El arrastre
sigue el movimiento REAL del puntero, no los saltos — es el mismo motivo por el que `ags/CLAUDE.md`
advierte de que warpar el cursor no sirve para probar un hover: no se entregan eventos de cruce.

Y tiene una trampa cara: `hl.dsp.window.drag()` acepta **cualquier** argumento y responde `ok`
(`{nonsense=1}` incluido), así que no hay forma de saber por la respuesta si ha hecho algo. Durante
las pruebas dejó **tres ventanas del usuario flotando**, una de ellas fuera de pantalla en `x=-248`;
si lo tocas, comprueba `floating` en `hyprctl clients` después.

##### El reanclaje es lo que convierte los pasos en un arrastre

Tras cada paso, el ancla se mueve a donde está la mano AHORA. Midiendo siempre desde el ancla
inicial, una mano que se queda quieta a tres pasos de distancia seguiría cumpliendo el umbral en
cada frame y la ventana **se iría al infinito** mientras no soltaras el pellizco (hay test:
`test_la_mano_QUIETA_LEJOS_no_sigue_dando_pasos`). `intervalo_paso` (0,28 s) es la otra mitad: cada
paso provoca un reparto nuevo con su animación, y sin él un gesto rápido encadenaba varios antes de
que se viera ninguno — la ventana aparecía tres huecos más allá sin que se pudiera seguir el
recorrido.

#### Coordenadas: `monitors` mezcla dos sistemas y no lo dice

Esto solo afecta al camino **flotante** (el único que da coordenadas); una ventana en mosaico se
recoloca por pasos y no pasa por aquí.

`hyprctl monitors` da `width`/`height` en píxeles **físicos**, mientras que el `at`/`size` de una
ventana viene en píxeles **lógicos**. En este portátil (1920x1200 con escala 1,25) el monitor dice
1920x1200 pero el escritorio útil mide 1536x960, que es donde viven las ventanas. Acotar el arrastre
contra 1920x1200 dejaría meter la ventana 384 px fuera de la pantalla por la derecha sin dar ningún
error: simplemente desaparecería. `geometria_monitor()` divide por la escala y descuenta `reserved`.

El acotado en sí tampoco es cosmético: sin él un gesto amplio deja la ventana entera fuera de la
pantalla, y como está flotante no hay forma de recuperarla con el ratón. Se deja siempre un cuarto
de la ventana (mínimo 80 px) dentro.

#### `fullscreen` es un MODO, no un booleano

0 nada, **1 maximizada**, 2 pantalla completa. Solo la 2 impide arrastrar. Con `if v.get("fullscreen")`
cualquier ventana simplemente maximizada quedaría fuera del arrastre, que es la mitad de las ventanas
de una sesión normal. Es la misma trampa que documenta el repo para la detección de juegos.

#### OpenCV 5 no abre la cámara por nombre

En OpenCV 4, `VideoCapture("/dev/video0", CAP_V4L2)` era lo idiomático. En el **OpenCV 5.0.0** de
estos repos esa misma llamada avisa `VIDEOIO(V4L2): backend is generally available but can't be used
to capture by name` y devuelve un capture cerrado — la forma «correcta de toda la vida» falla, y
falla con un mensaje que parece informativo. Lo que sí funciona con el backend V4L2 es el **índice**:
`/dev/videoN` → `VideoCapture(N, CAP_V4L2)`. `Camara._abrir()` prueba las tres formas en orden en vez
de clavar una, porque el número de OpenCV no es algo que este repo controle.

#### El hilo lector existe por el retraso, no por el rendimiento

V4L2 encola frames. Si la cámara entrega a 30 fps y el bucle consume a 15 (la inferencia cuesta
33 ms), cada `read()` devuelve el frame más viejo de la cola: el retraso crece hasta quedarse en
varias décimas de segundo fijas. En un indicador no se notaría; en un gesto es la diferencia entre
que la ventana siga a la mano y que vaya detrás. `CAP_PROP_BUFFERSIZE` no es fiable con V4L2 (el
backend lo ignora en muchos drivers), así que se drena de verdad: un hilo lee todo lo que la cámara
dé y guarda **solo el último**, y el bucle coge ese.

#### Lo que cuesta, medido — y una cifra que estuvo MAL

Primero el error, porque la moraleja vale para cualquier medición de este demonio. Una primera medida
dio **129% de un núcleo** y se documentó como tal. Era un **artefacto**: se tomó sobre el proceso
recién arrancado, así que dentro de la ventana entraban la carga del modelo y el calentamiento de
XNNPACK. Hay que dejarlo asentarse unos segundos antes de contar.

Las cifras buenas, en un A/B con todo igual salvo lo indicado (15 fps, sin mano en el cuadro, 90
frames por configuración, `getrusage` sobre el propio proceso):

```
 640x480  @ 15 fps → 41% de un núcleo   ·  inferencia 20,6 ms
1280x720  @ 15 fps → 50% de un núcleo   ·  inferencia 21,1 ms
1280x720  @ 20 fps → 82% de un núcleo
1280x720  @ 30 fps → 90% de un núcleo   ← el ritmo por defecto desde la v2
1280x720  @  5 fps → 24% de un núcleo   (dormitando)
```

**El ritmo por defecto son 30 fps y no 15**, y no es solo por responder antes: la cámara entrega
29,6 fps reales, así que a 15 se **tiraba uno de cada dos frames** — y el que se tiraba podía ser el
único nítido de un gesto rápido. A 30 se procesa todo lo que llega. De paso, `frames_confirmacion`
(3 frames) baja de 200 ms a 100 ms, que es la mitad de la sensación de lentitud. El cambio va con
migración de esquema (`version` 1 → 2 en `gestos.json`), y **solo sube el valor si era el 15 de
fábrica**: quien lo hubiera bajado a propósito por batería lo hizo por un motivo.

Sigue habiendo dos mandos: el de fps en Ajustes (5..30) y el **bajón automático** — sin mano en el
cuadro durante 4 s el bucle cae a 5 fps, porque buscar una mano que no está no merece el ritmo
completo. Un arrastre en curso no dormita nunca.

Lo que **no** es el problema, aunque lo pareciera: el hilo lector. Medido, `grab()` bloquea 33,33 ms
esperando el frame de la cámara y decodificarlo cuesta **0,01 ms** — o sea que el lector se pasa la
vida dormido en el kernel. Separar `grab()` de `retrieve()` para «ahorrar la decodificación» no
ahorraría nada; la única palanca es la inferencia.

#### 720p sale casi gratis, y hay que PEDIR MJPG para conseguirlo

Medido, 70 frames por configuración:

```
 640x480  MJPG → inferencia 21,2 ms | ciclo 33,7 ms | techo 29,4 fps
1280x720  MJPG → inferencia 19,4 ms | ciclo 33,7 ms | techo 29,4 fps
1920x1080 MJPG → inferencia 23,5 ms | ciclo 36,2 ms | techo 27,5 fps
```

El cuello de botella son los **30 fps de la cámara**, no el proceso: a 720p el ciclo completo es
idéntico. Y 720p da **cuatro veces más píxeles al recorte de la mano**, que es de donde salen los 21
landmarks — mejor recorte, mejor distinción entre un puño y un pellizco o entre un dedo extendido y
uno a medio doblar. 1080p ya cuesta y no aporta: MediaPipe reescala el recorte a 224x224 igual.

⚠️ **Sin pedir MJPG explícitamente no se pasa de 640x480, y no da ningún error.** Esta webcam publica
YUYV solo hasta 640x480 y reserva 720p/1080p para MJPG (`v4l2-ctl --list-formats-ext`); OpenCV abre
en YUYV por defecto, así que un `CAP_PROP_FRAME_WIDTH = 1280` a secas **se acepta, se ignora y
`cap.get(3)` sigue devolviendo 640**. Así se descubrió: las tres resoluciones daban exactamente el
mismo número de milisegundos. El `CAP_PROP_FOURCC` va **antes** del tamaño.

#### La exposición NO se puede bajar en esta cámara, y era la vía obvia

La mano en movimiento sale borrosa porque la webcam expone **31,2 ms** (`exposure_time_absolute` =
312, en unidades de 100 µs), casi el intervalo entero de un frame a 30 fps. Lo evidente es forzar
exposición manual corta. Medido, y **no funciona aquí**:

```
auto (31,2 ms)        → brillo 131/255
manual 20 ms, gain 0  → brillo  15/255
manual 12 ms, gain 4  → brillo  28/255
manual  5 ms, gain 4  → brillo  19/255
```

En manual la imagen se va a negro: el modo automático («Aperture Priority») aplica una ganancia
interna que el control `gain` —que llega hasta **4**— no puede replicar ni de lejos. O sea que
acortar la exposición cambia borrosidad por oscuridad, y el modelo falla igual. La vía está cerrada
en esta webcam; con otra que tenga rango de ganancia sería la primera que probar.

`exposure_dynamic_framerate` está en **1** (su valor por defecto es 0), o sea que la cámara puede
bajar los fps para alargar la exposición con poca luz. En las medidas con luz normal entregaba 29,7
fps reales, así que aquí no estaba actuando — pero es el primer sospechoso si el modo va peor de
noche.

#### ⚠️ UN SOLO FRAME PERDIDO MATABA EL GESTO ENTERO

Es el arreglo con más efecto de todo el motor, y el que explica el «a veces va y a veces no» que se
reportó en uso real.

`frame()` trataba un frame sin mano como «la mano ya no está»: tiraba el trayecto, devolvía la
máquina a `BUSCANDO` y cerraba cualquier arrastre. Medido sobre el motor:

```
swipe limpio                        → 1 swipe
el MISMO swipe con UN frame perdido → 0 swipes, estado 'buscando'
coste de recuperación               → 6 frames de mano abierta = 0,40 s
```

Y perder la mano un frame suelto es **lo normal**, no la excepción: con 31 ms de exposición la mano
en movimiento sale borrosa y MediaPipe no la encuentra. O sea que el modo fallaba **precisamente en
los frames del gesto** y funcionaba con los movimientos lentos — de ahí la irregularidad.

La cura es `gracia_perdida` (0,35 s): mientras el hueco sea más corto que eso, `frame()` **devuelve
sin tocar nada** —ni postura, ni trayecto, ni estado, ni arrastre—, porque un fallo de visión no es
un cambio de lo que hace la mano. Pasada la gracia sí se da por bajada, y ahí sí se cancela todo (si
no, un recorrido de hace diez segundos seguiría contando y la ventana agarrada no se soltaría nunca).

Tres detalles con prueba propia: **no se concede gracia antes de haber visto una mano** (al arrancar
no hay estado que preservar), **la gracia no se encadena** (tras darla por perdida se pone
`_visto_ultimo = None`; si no, un frame con mano cada medio segundo mantendría viva una sesión
indefinidamente), y los huecos breves **tampoco rompen el gesto de espera**.

#### ⚠️ LA CARA SE DETECTA COMO UNA MANO, Y CON `num_hands=1` TAPA LA BUENA

Reportado en uso real: «detecta mi cara como mi mano a veces» y «no detecta apenas». Las dos cosas
son el mismo fallo, y el enlace no es obvio.

`num_hands=1` hace que MediaPipe devuelva **solo** la detección de mayor puntuación. Si el detector
de palmas se cree una cara —pasa, y con puntuación altísima: **0,98 medido**— esa falsa mano ocupa
la única plaza y la mano de verdad **no llega al motor**. O sea que un falso positivo no añade ruido:
**tapa la señal buena**, y desde fuera se ve exactamente como «no me detecta nada».

Parte de la culpa fue de aquí: se habían bajado los tres umbrales a 0.4/0.3 para que la mano borrosa
no se descartara, y `min_hand_detection_confidence` es justamente el que gobierna ADQUIRIR una mano
nueva. Aflojarlo es pedirle al detector que se crea cualquier cosa. Los tres umbrales **no valen lo
mismo**, y la asimetría es todo el diseño:

```
detección   0.6   ← cuesta ADQUIRIR una mano nueva (esto es lo que frena las caras)
presencia   0.5
seguimiento 0.3   ← es fácil CONSERVAR una que ya se tenía, aunque salga borrosa
```

La segunda mitad es pedir **dos** manos y elegir. `elegir_mano()` (puro, con test) no intenta saber
qué es una cara: usa **continuidad**. Elegir por puntuación no sirve —una cara puntúa como una mano—
pero lo que una cara no puede hacer es estar donde estaba tu mano hace 33 ms, así que se toma la
candidata más cercana al centro de palma del frame anterior. Sin referencia previa (primer frame, o
tras perder la mano) se cae a la puntuación, que es el único momento en que un falso positivo puede
colarse; dura hasta que aparece la mano de verdad. Medido: `num_hands=2` cuesta **7 puntos de CPU**
(70% → 77% a 24 fps), porque el modelo de landmarks solo corre dos veces cuando de verdad encuentra
dos cosas.

#### El delegado GPU casi dobla la velocidad

MediaPipe Tasks acepta `BaseOptions(delegate=...)`. Medido sobre los **mismos 50 frames**:

```
CPU → 29,7 ms/inferencia
GPU → 16,2 ms/inferencia
```

Y en el demonio vivo, a 30 fps y 720p: **81% de un núcleo en CPU contra 42% en GPU**. Es la única
palanca de rendimiento que quedaba — el resto del pipeline por frame son 0,8 ms en total
(`cv2.flip` 0,29 · `cvtColor` 0,18 · `mp.Image` 0,34), o sea que la inferencia es el **96%** del
trabajo y optimizar cualquier otra cosa es perder el tiempo.

Con **repliegue a CPU** si el delegado no arranca, y no es paranoia: la GPU necesita un contexto GL
utilizable y eso puede fallar por driver, por cómo esté montada la sesión o por VRAM ocupada. Un modo
que no arranca es mucho peor que uno lento; el fallo se anota en `~/.cache/gigishell/gestos.log`.

#### ⚠️ DOS SUPOSICIONES MÍAS QUE LOS DATOS TUMBARON

Medido con `--diagnostico` sobre una sesión real (491 frames con la mano, 170 sin ella):

```
SIN manos → detecta el 25% del tiempo   ← falsos positivos
CON la mano → detecta el 88%
frames con DOS detecciones simultáneas → 0
confianza media → 0.98
```

**1. `num_hands=2` no resuelve lo que yo creía.** La teoría era que la cara ocupaba la única plaza y
tapaba la mano. Pero hubo **cero** frames con dos detecciones a la vez: en modo VIDEO, MediaPipe
*sigue* la mano que ya tiene y solo vuelve a correr el detector de palmas cuando la pierde, así que
nunca llega a haber dos candidatas. La cara y la mano **se alternan**, no compiten. `elegir_mano`
está bien escrita y probada, pero en la práctica casi nunca tiene que elegir.

**2. Subir el umbral de confianza NO filtra los falsos positivos.** Es el consejo obvio y es falso:
puntúan **0,98**, exactamente lo mismo que una mano de verdad. La confianza no discrimina aquí por
mucho que se suba, y por eso el propio diagnóstico lo dice ahora en su lectura — para que el
siguiente no pierda la tarde en ello.

Lo que queda por hacer con ese 25% es caracterizarlo con datos antes de escribir ningún filtro. Ya se
ha fallado dos veces adivinando en este mismo punto.

#### ⚠️ El umbral del pellizco estaba calibrado contra una mano que no existe

Reportado: «para que detecte pellizco tienes que colocar muy bien la mano, si no dice puño».

`alcance_indice_min` valía **1.00**, y ese número salió de la mano SINTÉTICA de `deteccion_test.py`,
que pellizca con el índice mucho más estirado de lo que pellizca nadie. Medido después con
`--calibrar` sobre una mano real (120 muestras por postura, distribuciones cerradísimas, p05 ≈ p95):

```
             razón_pellizco   alcance_indice        dedos
puño              0.26          0.78 – 0.80           0
pellizco          0.36          1.19 – 1.21           0
mano abierta      0.98          1.77 – 1.78           4
```

Dos cosas que solo se ven con estos números delante:

- **El puño puntúa MÁS BAJO que el pellizco en `razon_pellizco`** (0.26 contra 0.36). Por esa medida
  sola, un puño es «más pellizco» que un pellizco. Es la confirmación empírica de por qué
  `alcance_indice` tiene que existir.
- **El corte NO va en el punto medio.** El medio de 0.80 y 1.19 es **0.99**, o sea prácticamente el
  1.00 con el que se reportó el fallo. Y ahí está la trampa: la calibración mide tu **mejor pose**,
  sostenida cuatro segundos; el gesto real se hace de pasada y con la mano moviéndose, y cae bastante
  más bajo. Un margen del 16% suena razonable sobre el papel y aun así falló en la mano de quien lo
  usa.

Los dos errores tampoco cuestan lo mismo: un puño leído como pellizco agarra una ventana y se suelta
abriendo la mano —molesto y reversible—, mientras que un pellizco que no registra hace el gesto
**inutilizable**. Con costes asimétricos el corte se pega al lado estable (el puño, que apenas varía)
con un cuarto del hueco de margen: **0.90**, que deja 0.10 sobre el puño y tolera un pellizco un 24%
por debajo de su valor posado. `--calibrar` aplica ese mismo sesgo al recomendar.

Con los mismos datos se subió también `pellizco_entra` de 0.45 a **0.55**: con 0.45 el margen contra
el pellizco posado (0.36) eran nueve centésimas, y un pellizco casual se sale de ahí. La mano abierta
está en 0.98, así que subir no acerca nada al otro extremo.

**Las medidas están clavadas como prueba** (`TestUmbralesContraManoREAL`): mover un umbral rompe el
test en vez de romper el gesto en silencio. Y esa clase reimplementa la decisión de
`_postura_cruda` con números sueltos en vez de fabricar landmarks — construir una mano sintética que
diera exactamente esos valores sería volver al error que documenta.

La lección general: **una geometría sintética sirve para escribir la lógica, no para fijar sus
umbrales.**

#### Calibración: `--calibrar`

```sh
~/.local/share/gigishell/gestos/venv/bin/python ~/.config/hypr/scripts/gestos/gestos.py --calibrar
```

Pide las tres posturas, mide `razon_pellizco`, `alcance_indice` y los dedos extendidos en cada una, y
dice el corte recomendado con el sesgo de arriba. Si los dos rangos se solapan lo dice en vez de
inventar un número — con esa medida no habría corte que acertara siempre, y esa información vale más
que un valor falsamente preciso. No escribe nada: el valor se pone a mano en `Config`, que es un
ajuste de una sola vez y no merece otro fichero de configuración.

#### Barrido de parámetros: `barrido.py`

```sh
python3 ~/GiGiShell/hypr/scripts/gestos/barrido.py
```

La tercera herramienta, y cada una responde algo distinto:

| herramienta | responde |
| --- | --- |
| `gestos.py --calibrar` | qué geometría tiene TU mano en cada postura |
| `gestos.py --diagnostico` | qué está viendo la cámara ahora mismo |
| `barrido.py` | qué hace el MOTOR ante recorridos conocidos |

Las dos primeras necesitan cámara y una mano delante. Esta no necesita nada: fabrica los recorridos y
mide el motor puro, así que corre con el intérprete del sistema, sin venv, y da el mismo resultado en
cualquier máquina. **Las tablas de esta sección salen de ahí** — si tocas un umbral, re-córrelo y
actualiza el documento.

Su valor no es reproducir números: es que varias de sus tablas **desmintieron lo que parecía
evidente**. «Un tiempo muerto más corto siempre encadena mejor» → falso, 0,45 y 0,55 encadenan igual
pero 0,45 deja colar un regreso. «Estrechar la ventana perderá los gestos lentos» → falso, un golpe
de 0,55 s sigue disparando. «La ventana del swipe y la tolerancia a huecos son independientes» →
falso, el ritmo las acopla.

⚠️ **Las manos sintéticas viven en `manos_sinteticas.py`, no en el fichero de pruebas**, y eso no es
organización: `*_test.py` está en el `.gitignore` a propósito (con un hook de pre-push que rechaza el
push si alguno acaba rastreado), así que en un checkout limpio el fichero de pruebas **no existe** y
`barrido.py` no habría arrancado en ninguna máquina que no fuera la de desarrollo.

#### Diagnóstico: `--diagnostico`

```sh
~/.local/share/gigishell/gestos/venv/bin/python ~/.config/hypr/scripts/gestos/gestos.py --diagnostico 20
```

Mide qué ve la cámara **sin tocar el escritorio** (a propósito: un swipe que cambie de escritorio en
mitad de la prueba se lleva la ventana donde estás leyendo los números).

**Son DOS fases, y la primera es la importante.** Primero se mide *sin ninguna mano delante*: todo lo
que detecte ahí es un falso positivo, y eso **no se puede deducir de la fase con la mano** — ahí un
porcentaje alto de detección parece bueno aunque la mitad sean caras. Después se mide con la mano
moviéndose, que es la tasa útil. Las dos cifras juntas dicen qué tocar; por separado, ninguna.

Reporta además los frames con DOS detecciones simultáneas (la cara compitiendo con la mano), el
tamaño aparente de la mano —si pasa de 0,25 del cuadro, está demasiado cerca y se sale— y la peor
racha sin detección contra la tolerancia de `gracia_perdida`.

Existe porque «a veces no me detecta» no es accionable y «sin levantar la mano detecta algo el 20%
del tiempo» sí lo es. Toma el mismo cerrojo que el demonio: la cámara es de uno solo.

#### Los dos JSON, y quién escribe cada uno

| fichero | lo escribe | lo lee |
| --- | --- | --- |
| `~/.config/gigishell/gestos.json` | AGS (Ajustes > Cámara > Gestos) | el demonio, **una vez al arrancar** |
| `~/.config/gigishell/gestos-estado.json` | el demonio | AGS (`servicios/gestos/estado.ts`) |

Dos ficheros con un dueño cada uno, y no uno con dos escritores que se pisarían.

**La configuración no se aplica en caliente: el demonio se reinicia.** Recargarla en vivo obligaría
a vigilar el fichero desde el bucle de inferencia y a rehacer la máquina de estados a mitad de un
gesto. Como el modo se enciende a ratos y arrancar cuesta ~1 s, sale más barato reiniciarlo;
`guardar()` lo hace solo si estaba activo. Por eso los deslizadores de Ajustes **se posan 700 ms**
antes de guardar: sin eso, arrastrar uno apagaría y encendería la cámara sesenta veces por segundo.

**El estado no se publica por frame.** Al otro lado hay un `Gio.FileMonitor` que reinterpreta el
JSON en cada cambio, dentro del proceso que pinta la barra. A 15 fps serían 15 parseos por segundo
durante todo el modo para redibujar un icono que casi nunca cambia. Se publica solo cuando cambia
algo visible y como mucho cada 200 ms. Al tocar cualquiera de los dos lados hay que conservar ese
trato: no es una optimización suelta, es la razón de que el modo no se note.

#### Este proceso se ve, y así tiene que ser

Mientras corre tiene `/dev/videoN` abierto, así que `camara-monitor.sh` enciende el indicador rojo de
privacidad y avisa «Cámara en uso» diciendo `python`. **No se hace nada por evitarlo**: ese indicador
existe justo para que nada mire por la cámara sin que se vea, y un modo del propio escritorio no es
una excepción. Por eso tampoco se emite una notificación propia al activarlo — sería un segundo
aviso de lo mismo. En la barra se ven **dos** iconos y son dos hechos distintos:

- 󰄀 rojo pulsante — algo está mirando por la cámara (privacidad).
- 󱄄 violeta fijo — el escritorio obedece a tus manos (modo). Se **ilumina** cuando hay una mano en
  el cuadro, que es la única realimentación de que el modo te ve: sin ella, «no me hace caso» y «no
  me ve» son indistinguibles, que es el problema número uno de cualquier control por cámara.

La consecuencia menos agradable: **con el modo encendido no se puede hacer una videollamada**, porque
una webcam UVC no admite dos capturas a la vez. Si al arrancar la cámara ya está ocupada, el demonio
no insiste — dice quién la tiene y sale. Y el killswitch manda: con la cámara bloqueada se niega a
arrancar con el motivo escrito, en vez de dar un EACCES genérico que mandaría al usuario a buscar un
problema de hardware que no existe.

#### Instalación: un venv, y por qué

MediaPipe no está en los repos oficiales. En AUR hay dos y ninguno sirve: `python-mediapipe` compila
contra `python-tensorflow` (build de horas) y `python-mediapipe-bin` se quedó en la 0.10.32. La rueda
de PyPI (**1.0.1**) sí funciona con el Python 3.14 de Arch —comprobado— pero `pip` al sistema está
prohibido (PEP 668) y `--break-system-packages` hace lo que su nombre dice. De ahí el paso `gestos`
del instalador: venv en `~/.local/share/gigishell/gestos/venv` con `--system-site-packages` (para
reaprovechar `python-numpy` y `python-opencv` del sistema; sin eso pip se bajaría su propia copia de
OpenCV y habría dos, ganando la de pip). El modelo (`hand_landmarker.task`, 7,8 MB) se descarga
aparte y **no se versiona**: el repo no tiene ningún otro blob.

**Un venv muere con cada actualización mayor de Python.** Guarda la versión con la que se creó, así
que cuando Arch pase a 3.15 apuntará a un intérprete que ya no existe y el modo dejará de arrancar.
No es un fallo mudo (`gestos.sh` avisa con el motivo y Ajustes lo enseña) pero la solución es
rehacerlo: `bash install.sh --solo gestos`. `bin/preflight.sh --installed` lo caza comprobando que el
intérprete **importe**, no que exista: un venv colgando conserva todos sus ficheros y pasa cualquier
test de existencia.

#### `flock`, no un fichero de PID

El demonio toma un `flock` sobre `$XDG_RUNTIME_DIR/gigishell-gestos.lock` y escribe dentro su PID;
`gestos.sh` lo lee y lo **confirma contra `/proc/<pid>/cmdline`** antes de creérselo. Un PID escrito
a mano se queda obsoleto si el proceso muere de golpe y el siguiente arranque se cree que ya hay uno
vivo, dejando el modo inarrancable hasta borrar el fichero. Y un `pgrep -f gestos.py` a secas casaría
con el editor que tenga el fichero abierto o con la propia línea del script — matar por ese patrón es
exactamente cómo se acaba matando algo que no era.

`apagar()` **espera de verdad** a que el proceso muera antes de devolver el control: un `off` seguido
de un `on` se encontraría el nodo todavía ocupado y fallaría con «la cámara ya la está usando
python3».

### USB (`usb-monitor.sh`, `usb-eject.sh`, `usb-repair.sh`) + `system/udev/`

**La raíz del problema con los USB no es el shell, es `vm.dirty_ratio`.** Linux acepta hasta el
10 % de la RAM en páginas sucias (aquí ~1,5 GB) antes de forzar el volcado, así que una copia a un
pendrive lento se traga los datos a velocidad de RAM: el diálogo llega al 100 % y "termina" en
segundos con cientos de MB aún sin bajar al dispositivo. Al retirarlo — aunque sea minutos después —
el kernel escupe `Buffer I/O error on dev sdb1 … lost async page write` y los datos **se han perdido
de verdad** (a nosotros el volumen NTFS nos quedó `Mark volume as dirty`). Por eso el síntoma solo
aparecía **al mover archivos**: sin escrituras pendientes no hay writeback que fallar.

La cura vive fuera del repo, en `system/udev/99-gigishell-usb-writeback.rules`. La instala **`install.sh`
(paso 6)** con `install -Dm644` en `/etc/udev/rules.d/`; en una máquina ya montada hay que copiarla a
mano con `sudo`. **No** es un symlink, y no puede serlo: udev lee `/etc` antes de que `$HOME` esté
montado, y apuntar `/etc` a un directorio escribible por el usuario sería una escalada silenciosa.
La regla baja `bdi/max_bytes` a 16 MiB y pone `strict_limit=1` **solo** en almacenamiento externo. La barra de progreso pasa a ser honesta. Dos detalles medidos, no supuestos:
el `bdi` cuelga del **disco entero** (`/sys/block/sdb/bdi`), las particiones **no tienen `bdi` ni
`removable`** propios → la regla apunta al disco; y se filtra por **`ID_BUS=="usb"`, no por
`removable=="1"`**, porque los **discos duros USB externos reportan `removable=0`** (lo extraíble es
la carcasa, no el medio) y se habrían quedado fuera justo los que más datos mueven.

`usb-monitor.sh` escucha **dos subsistemas en un solo stream** (`usb` + `block`). Un pendrive genera
eventos de ambos, así que sin cuidado saldrían **dos popups** por enchufe: si el dispositivo es de
clase *mass storage* el aviso genérico **se calla** y habla el evento de bloque, que sabe el modelo
y puede ofrecer botón.

**Deducir la clase del evento del `usb_device` no basta, y cuando falla salen los DOS popups.** Se
miraba solo `ID_USB_INTERFACES` (contiene `:08` — las entradas son de 6 dígitos entre `:`, así que
`":08"` solo puede casar al principio de una). Esa heurística falla en dos direcciones: hay bloques
de evento que llegan **con las propiedades a medias** (de ahí el "USB conectado — *dispositivo
desconocido*", que además delata que tampoco venía `ID_MODEL`), y hay dispositivos que se enganchan
a `usb-storage` por una interfaz de clase **propietaria** (`ff…`: lectores de tarjetas, algunas
carcasas) sin ningún `:08` que mirar. En ambos casos salta el genérico y **acto seguido** el de
almacenamiento con el nombre bueno.

Hoy la señal no es la clase declarada sino el hecho **observado** de que el dispositivo acabe
exponiendo un dispositivo de bloque — que solo se sabe unos instantes después. El aviso genérico se
**retiene 3 s** (`DEFER_SECS`) y se **cancela** si en esa ventana llega un evento de bloque de *ese*
dispositivo. El enlace entre ambos es `DEVPATH`: el del bloque cuelga del árbol del `usb_device`
(`…/usb1/1-5` → `…/usb1/1-5/1-5:1.0/host…/block/sdb`), o sea que el del padre es **prefijo** del
hijo. Es una relación exacta, **no una correlación por tiempo**: dos dispositivos enchufados a la
vez no se cancelan el uno al otro (verificado). El diferido también cubre el caso de tirar del
pendrive antes de los 3 s, que antes sacaba un "conectado" **después** del "desconectado".

Los pendientes son un fichero por aviso en `$XDG_RUNTIME_DIR/gigishell-usb-pending/` (con su `DEVPATH`
y su etiqueta dentro), y quien dispara **reclama el suyo con un `mv`** antes de notificar: el
rename es atómico y falla si ya no está, así que no hay ventana entre "compruebo que sigue vivo" y
"notifico" por la que una cancelación pueda colarse. El directorio se **borra al arrancar** el
script porque un proceso anterior muerto a mitad deja huérfanos que nadie reclamaría.

**Al DESCONECTAR el duplicado tiene la misma raíz, pero se arregla al revés.** Un dispositivo
compuesto o detrás de un hub expone **varios `usb_device` anidados**, y el kernel emite un `remove`
por cada uno; como el aviso colgaba de ese evento, salían dos popups por un solo tirón — y el del
nodo padre no suele traer `ID_MODEL`, de ahí el "dispositivo desconocido" que acompañaba al bueno.
(Es también la otra mitad de la causa en la conexión: ahí el que se cuela es el padre, y el
diferido ya lo cancela porque el `DEVPATH` del bloque cuelga de él.) En la desconexión no hay
ningún evento posterior que sirva de prueba, así que en vez de cancelar se **fusiona**: el aviso se
retiene `DEFER_SECS` y los removes emparentados por `DEVPATH` colapsan en uno solo con el mejor
nombre disponible.

La regla de fusión es **asimétrica a propósito**, y esa asimetría es lo que la hace correcta llegue
el padre antes o después que los hijos (el kernel suele emitir hijo→padre, pero no se depende de
ello): si el entrante **desciende** de un pendiente lo absorbe y se queda con **su** `DEVPATH` —el
más profundo, que es la función real y la que tiene nombre—; si el entrante es **antecesor** de un
pendiente se **descarta**, porque el hijo ya cubre ese tirón, y solo le cede su etiqueta si el hijo
venía sin nombre. Guardar el `DEVPATH` **más profundo** es justo lo que evita colapsar **hermanos**:
al retirar un hub con tres pendrives, los tres son hermanos entre sí (ninguno desciende de otro) →
**tres** avisos, y el remove del hub se descarta; si se guardara el del hub, los tres se fundirían
en uno. Verificado con A/B sobre seis escenarios (anidado en los dos órdenes, hub con 3 discos,
hijo sin nombre y padre con él, suelto, y dos dispositivos a la vez): el original saca 13 avisos,
el nuevo 9 — uno por dispositivo físico.

**El nombre al desconectar sale de una caché, porque el evento no puede tenerlo.** La fusión
arregla *cuántos* avisos salen, no *cómo se llaman*: aunque el `remove` que sobrevive sea el más
profundo, muchas veces ninguno de los dos trae `ID_MODEL` y el aviso decía «dispositivo
desconocido» — mientras que al **conectar** el nombre salía bien. No es un fallo de parseo: cuando
llega el `remove`, el dispositivo **ya no está en sysfs** y no hay a quién preguntarle. La única
forma de saberlo es haberlo guardado al enchufar, indexado por lo único que el `remove` sí trae
siempre: el `DEVPATH`, que es el **puerto**. Eso es `$XDG_RUNTIME_DIR/gigishell-usb-cache/`
(`GIGISHELL_USB_CACHE_DIR` para probar, y también para **pre-sembrar** el estado, que es la única forma
de testear el reinicio del monitor). Cuatro decisiones que no son obvias:

- **NO se borra al arrancar**, al revés que los pendientes, y **no** entra en el `trap … EXIT`. Es
  el error más fácil de introducir aquí, por simetría. Recargar el monitor es `pkill` + relanzar (o
  `hyprctl reload full-reset`): borrar dejaría sin nombre la desconexión de todo lo ya enchufado,
  justo el caso que esto arregla. Un pendiente huérfano es un aviso que nadie reclamará; una entrada
  de caché huérfana es solo un nombre que quizá no haga falta. Está en `XDG_RUNTIME_DIR` y **no** en
  `~/.cache` porque los `DEVPATH` se reutilizan entre arranques: sobrevivir al reboot sería nombrar
  el puerto en vez del dispositivo. Las huérfanas las quita `prune_cache()` en el arranque, por dos
  criterios: el path ya no existe, o existe pero el `idVendor:idProduct` de sysfs **ya no coincide**
  (otro pendrive en el mismo puerto, enchufado con el monitor parado — su `add` tampoco se vio).
- **La búsqueda casa por prefijo en las dos direcciones** (el `remove` puede llegar por el padre o
  por un hijo), con una salvaguarda: un **descendiente solo vale si es ÚNICO**. Con dos o más, los
  candidatos son **hermanos** —el hub con tres pendrives— y quedarse con cualquiera le pondría a un
  dispositivo el nombre de otro sin ningún error visible. Con ≥2 no se devuelve nada y no se pierde
  nada: ese pendiente del padre lo descarta igualmente la fusión.
- **Se resuelve al INGERIR el `remove`, no al vencer el temporizador.** Además de que
  `fire_due_pendings` ya no conoce los `DEVPATH` absorbidos, esto arregla una fuga de nombre que la
  fusión tenía sola: si el `remove` del hub llega **antes** que el del primer pendrive, el pendrive
  entra por la rama «el entrante desciende de un pendiente» y, al venir sin nombre, **heredaba la
  etiqueta del hub**. Con la caché llega ya con `known=1` y no se le pisa nada.
- **Se borra la entrada EXACTA y nada más.** Borrar el subárbol es el bug: con el `remove` del hub
  primero se llevaría por delante los nombres de sus tres pendrives. Como el kernel emite un
  `remove` por **cada** `usb_device`, cada entrada se borra sola con el suyo.

Manda el **evento** cuando trae nombre; la caché es respaldo, nunca autoridad (es una foto de un
puerto, el evento es el dato vivo). Por lo mismo, el evento de **bloque** enriquece la entrada del
`usb_device` del que cuelga —así se nombra el pendrive cuyo `add` llegó con las propiedades a
medias— pero **no pisa** un nombre usb ya bueno: el `ID_MODEL` del bloque sale de un INQUIRY SCSI
**truncado a 16 caracteres**. A quién enriquecer se sabe por el antecesor cacheado más profundo, no
parseando el path: `${d%/*:*.*/*}` es la tentación y está mal, porque en expansión de parámetros
`*` cruza `/` y el corte se va al puente PCI. Medido con eventos sintéticos: sin caché el hub con
tres pendrives saca «dispositivo desconocido (×3)»; con ella, los tres nombres correctos, el mismo
número de avisos y en cualquier orden de llegada.

**Los hermanos siguen siendo tres dispositivos, pero ya no son tres popups.** La fusión resuelve
"un dispositivo, varios eventos"; no toca —ni debe— el caso de tres dispositivos de verdad. Eso lo
resuelve la capa de arriba: los tres vencen su espera en el **mismo instante**, así que el volcado
del temporizador es el lote natural y sale un único «3 dispositivos USB conectados» con los tres
nombres en el cuerpo. Con uno solo, el texto es el de siempre. Ver `lib/notif-agrupar.sh`.

**El reloj vive ahora en el bucle principal, no en un subshell por pendiente.** Antes cada aviso
retenido arrastraba su propio `( sleep DEFER_SECS; … ) &`, y de ahí salía la limitación anterior:
**quien notificaba era el subshell, que no puede saber que hay otros dos hermanos a punto de
notificar lo mismo**. Hoy el `read` del bucle —que ya estaba bloqueado ahí sin hacer nada— lleva un
timeout hasta el próximo vencimiento (`pending_at`, epoch en memoria; sin pendientes bloquea sin
timeout, como siempre), y quien dispara es el único proceso que lo ve todo. De propina: cero
subshells por evento y **ninguna carrera** entre reclamar y cancelar, porque ya solo hay un actor
tocando los pendientes. `pending_orden` conserva el orden de llegada — recorrer un array asociativo
de bash da un orden de hash, y en una lista de tres nombres eso se nota.

Los pendientes de conexión (`c.*`) y de desconexión (`r.*`) **comparten directorio pero no glob**, y
un aviso ya reclamado se renombra a `.fired.*` —fuera de ambos globs— para que no pueda reaparecer
como pendiente vivo y falsear una cancelación o una fusión. `GIGISHELL_USB_PENDING_DIR` permite
apuntar el directorio a otro sitio: es la costura para probar el script sin pisarle los pendientes
al monitor que está corriendo (que además los **borra al arrancar**).

`ID_USB_INTERFACES` y una lectura de `bInterfaceClass` en sysfs siguen ahí, pero **degradados a
atajos**: solo sirven para ahorrarse la espera cuando la respuesta ya se sabe (un pendrive normal se
calla al instante). Si dicen que no, **no se concluye nada** — se difiere. El coste aceptado es que
un teclado tarda 3 s en anunciarse; es un popup pasivo, y se prefiere eso a un falso "dispositivo
desconocido". El sysfs es atajo y no garantía porque las interfaces **no siempre existen todavía**
cuando llega el `add` del `usb_device`.

- **Abrir** (botón en el aviso de conexión, y **el que dispara el clic derecho** sobre el popup) →
  `usb-open.sh <disco>`: elige la partición (la ya montada; si no, la mayor con sistema de ficheros
  reconocido, descartando swap/LUKS/LVM/RAID, e incluyendo el disco pelado por los pendrives sin
  tabla de particiones), la monta con `udisksctl` si hace falta y abre Dolphin ahí (`xdg-open` de
  plan B), desacoplado con `setsid` para no colgarlo del monitor. Va **primera** en la notificación
  a propósito: AGS trata la primera acción visible como la principal. La ruta se relee de
  `/proc/mounts` —desescapando el octal, que `\040` en una etiqueta con espacios es lo normal— y no
  del «Mounted … at …», cuyo texto ha cambiado entre versiones de udisks. Nada de `sudo`/`pkexec`,
  por el mismo motivo que `usb-repair.sh`.
- **Expulsar** (segundo botón del mismo aviso) → `usb-eject.sh <disco>`: desmonta todas las
  particiones y hace `power-off`. El unmount de udisks **hace el flush y espera**: cuando vuelve, los
  datos están físicamente en el pendrive. Si `power-off` falla (hubs que no lo soportan) **no** es
  error: ya está todo volcado, que es lo que protege los datos.
- **Volumen sucio** → en cada partición USB nueva se llama a `org.freedesktop.UDisks2.Filesystem.Check`
  (solo lectura); si no está limpia **se repara sola** (`usb-repair.sh` → `Filesystem.Repair`), sin
  botón ni pregunta. Se puede porque la operación es **conservadora, no destructiva**: en NTFS udisks
  ejecuta `ntfsfix`, que según su propio man **no es un chkdsk** — repara inconsistencias
  fundamentales, resetea el journal y **programa la comprobación de verdad para el primer arranque de
  Windows**. Auto-reparar no esconde nada. Y el instante del enchufe es la **única ventana** en la que
  el volumen está sucio y todavía sin montar, que es lo que `Repair` exige: preguntar aquí solo servía
  para que la ventana se cerrara mientras el usuario decidía. Se recomprueba `/proc/mounts` justo antes
  de reparar — si el gestor de archivos lo montó en ese hueco, **no** se le desmonta por la cara: ahí
  (y solo ahí) se cae al aviso con botón, donde el desmontaje lo autoriza el clic.

#### `Check` NO lee un flag: es un fsck completo, y SECUESTRA el USB mientras corre

El fallo silencioso más caro de esta sección, porque el síntoma no apunta a ningún sitio: **al enchufar
un pendrive, Dolphin no lo abre y se queda «pensando» para siempre; al quitarlo y volverlo a meter, lo
abre bien**. Ni un error, ni una línea de log que nombre a `usb-monitor.sh`.

`org.freedesktop.UDisks2.Filesystem.Check` no consulta el bit de «sucio» del superbloque: udisks lanza
la herramienta del sistema de ficheros (`fsck.exfat -n`, `e2fsck -fn`, `fsck.fat -n`…), que recorre
**toda** la metainformación del volumen y lo deja ocupado mientras tanto. Medido con un pendrive exFAT
de 239 GB: `fsck.exfat -n /dev/sda1` pasaba de **1 min 40 s** y seguía. Durante todo ese rato el USB no
se puede montar, ni por el botón «Abrir» ni desde Dolphin, que es literalmente lo que se ve.

Lo que lo convertía en «a veces sí y a veces no» era que la guarda de «si ya está montado me callo»
miraba `/proc/mounts` **una sola vez, tras un `sleep 2`**. Eso es una carrera que se pierde por un
segundo:

| | partición visible | montada | qué veía el vistazo a t=2 s |
|---|---|---|---|
| **1ª vez en la sesión** | t≈2 s (hay que cargar `usb-storage` **en frío**) | t≈4 s | no montada → **arranca el fsck** → Dolphin en bucle |
| **2ª vez** | t≈0 s (módulo caliente) | t≈1 s | montada → se aparta → todo bien |

Tres arreglos, y hacen falta los tres:

- **Tope de tamaño** (`CHECK_MAX_BYTES`, 64 GiB). El coste del fsck crece con el volumen y el beneficio
  no: un volumen sucio **se monta perfectamente** (exFAT escupe un `Volume was not properly unmounted`
  al log y sigue), así que bloquear el dispositivo minutos para averiguar algo que no impide usarlo es
  un mal cambio. Por encima del tope no se comprueba sola; a mano sigue estando entero
  (`usb-repair.sh /dev/sdXN`).
- **Ventana de asentamiento** (`CHECK_SETTLE_SECS`, 25 s). Se **sondea** `/proc/mounts` en vez de mirar
  una vez, y montar gana siempre que ocurra. 25 s cubre de sobra la vida del popup con el botón
  «Abrir» (20 s), que es el tiempo real que tiene el usuario para decidir: si pulsa, montamos y ya no
  hay nada que comprobar.
- **`busctl --timeout=` explícito**, aquí y en `usb-repair.sh`. El de DBus por defecto son **25 s** y un
  fsck los pasa de largo. Al vencer, `busctl` devuelve error, eso caía en el `|| exit 0` y el volumen
  se daba por **limpio**… mientras `udisksd` seguía fsckeando con el dispositivo bloqueado y sin nadie
  mirando. Comprobado en vivo: sin un solo `busctl` en la tabla de procesos, un `fsck.exfat -n` llevaba
  más de minuto y medio corriendo. En `usb-repair.sh` era peor todavía: la reparación se daba por
  fallida y se avisaba de ello mientras udisks la terminaba bien por debajo.

Dos consecuencias que se arrastraban de aquí:

- **`usb-repair.sh` desmontaba y no volvía a montar en ningún camino de error.** Una reparación fallida
  dejaba el pendrive enchufado y **sin montar** — el mismo síntoma que esto viene a evitar — y como el
  aviso que salía era el del fallo de la reparación, nada apuntaba a que además se había quedado
  desmontado. Ahora hay un `remontar()` que se llama en todas las salidas, y solo remonta **si el
  desmontaje fue nuestro**: en el camino automático el volumen nunca estuvo montado y montarlo sería
  cambiarle el estado del escritorio al usuario sin pedirlo.
- **El aviso de «extracción insegura» mentía.** `oom-monitor.sh` clasificaba cualquier `i/o error` en un
  extraíble como *«se quitó con escrituras pendientes»*, sin mirar la operación. Al tirar del pendrive
  mientras **nuestro propio fsck lo estaba leyendo**, el kernel suelta decenas de `op 0x0:(READ)` y el
  aviso afirmaba que podía haber archivos incompletos. No había ninguno: no se había escrito nada. Ver
  la sección de `oom-monitor.sh`.

**Por qué udisks y no `fsck`/`ntfsfix` directos**: van a un dispositivo `root:disk 660`, harían falta
privilegios, y escalarlos vía pkexec desde un script de `~/.config` (escribible por el usuario) sería
exactamente la escalada silenciosa contra la que avisa CLAUDE.md. Con udisks el
trabajo privilegiado lo hace `udisksd` y lo autoriza polkit — y **no hay prompt de contraseña**
porque `modify-device` es `allow_active=yes` para dispositivos que **no** son del sistema (en un
disco interno sí lo pediría: `modify-device-system` → `auth_admin_keep`). `Check`/`Repair` **exigen
el volumen desmontado**; si ya está montado, `check_volume` se calla (no vamos a desmontar por la
cara). Cualquier error —fs no soportado, falta la herramienta— también es silencio: esto es una
comodidad y no puede convertirse en una fuente de ruido. Reparar **NTFS** necesita `ntfsfix`, que
viene en el paquete **`ntfsprogs`** — **no** en `ntfs-3g`, que hoy solo trae el driver FUSE
(`pacman -F` puede decir lo contrario: su base de ficheros va desfasada respecto a lo instalado).

### Brillo: dos hardwares, y uno de ellos necesita `sudo` una vez (`system/modules-load.d/`)

El brillo **no es una sola cosa**. En un **portátil** lo maneja la GPU y el kernel lo publica en
`/sys/class/backlight` → `brightnessctl`. En un **sobremesa** ese directorio está **vacío**: el
monitor externo no aparece ahí porque su brillo vive en el firmware del propio monitor, y solo se
habla con él por **DDC/CI** (I2C sobre el cable de vídeo) → `ddcutil setvcp 10`. Lo implementa AGS
en `ags/servicios/pantalla/brightness.ts`, que elige backend solo; ver `ags/CLAUDE.md`.

Para el camino DDC hace falta el módulo **`i2c-dev`**, que no carga nadie por su cuenta. Sin él no
existen los nodos `/dev/i2c-*`, `ddcutil` no ve nada y el slider **desaparece** (que es el
comportamiento correcto: no hay backend). Lo persiste `system/modules-load.d/i2c-dev.conf`, que como
la regla udev de USB va a `/etc` y **no se symlinkea**: lo copia **`install.sh` (paso 6)**, que además
hace el `modprobe` para no obligar a reiniciar. En una máquina ya montada, a mano:

```sh
sudo install -Dm644 system/modules-load.d/i2c-dev.conf /etc/modules-load.d/i2c-dev.conf
sudo modprobe i2c-dev   # modules-load.d solo actúa en el arranque
```

El **acceso** a los nodos no requiere nada más: la regla udev que ya trae el paquete `ddcutil`
(`/usr/lib/udev/rules.d/60-ddcutil-i2c.rules`) marca los buses de la tarjeta gráfica con
`TAG+="uaccess"`, o sea ACL para el usuario de la sesión — **no** hace falta meterse en el grupo
`i2c` ni relogear. Medido en esta máquina (RTX 3060 + ASUS XG27AQDMES por DP): bus `/dev/i2c-3`,
VCP 10 soportado, rango 0–100.

**El brillo por hardware tiene un SUELO, y por debajo atenúa el gamma.** `setvcp 10 0` es el
mínimo que acepta la electrónica del panel — en el OLED de esta máquina, todavía claramente
luminoso. Así que el slider está partido en dos tramos: por encima de un suelo manda el hardware
(DDC/backlight) y por debajo se atenúa el **gamma**, que aplica `hyprsunset` sobre la CTM del KMS.
Es el mismo proceso que sostiene la luz nocturna, y por eso `applyNight()` en
`ags/servicios/pantalla/service.ts` es el **único dueño** y reconcilia los dos canales juntos: lo
mantiene vivo si lo pide cualquiera de los dos, y usa una temperatura neutra (6000 K) cuando solo
hace falta para el gamma — si no, bajar el brillo encendería de paso la luz nocturna. La lógica del
reparto es pura y probada (`ags/servicios/pantalla/atenuacion.ts`); ver `ags/CLAUDE.md` para el
detalle, incluida la restauración desde disco (el gamma no deja residuo: muere con la sesión, al
revés que el valor DDC, que el monitor graba en su firmware).

**`brightnessctl` no se invoca desde ningún otro sitio, y es a propósito.** Sin dispositivos de clase
`backlight` **no falla**: cae al primer dispositivo de clase `leds` y acaba encendiendo el **LED de
scroll-lock del teclado**, devolviendo 0 — un fallo mudo que la UI no podía detectar. Por eso las
teclas `XF86MonBrightness*` de `gigishell/keybinds.lua` ya **no** lo llaman (van por `ags request
brightness-up|down`, que aplica al backend que haya y enseña el OSD) y la llamada que queda en
`init.sh` lleva `-c backlight` explícito.

### Puntero: hyprcursor y XCursor son DOS MITADES, no una migración (`bin/generar-hyprcursor.sh`)

**XCursor no se puede retirar, y plantearlo como "migrar a hyprcursor" lleva a la conclusión
equivocada.** hyprcursor cubre **solo el cursor que dibuja el compositor**. XWayland no lo soporta
—es Xcursor y punto— y GTK/Qt dibujan su propio puntero desde `XCURSOR_THEME`. Así que un tema aquí
es **un directorio con las dos mitades**: `cursors/` (PNG por tamaño, XCursor) y
`hyprcursors/*.hlc` + `manifest.hl` (hyprcursor). Con esa forma **un solo nombre** vale para las dos
variables, que es lo que emiten `gigishell/dispositivos.lua` y AGS. Es la forma que ya traen los temas
con soporte de fábrica (Bibata-Modern-Ice).

**El problema real no era "estamos en XCursor": era que el tema NO ESTABA FIJADO.** Nada ponía
`XCURSOR_THEME`/`HYPRCURSOR_THEME`, así que Hyprland caía a gsettings (`cursor-theme = 'default'`),
un nombre que libhyprcursor **no sabe resolver**: casa temas por **nombre de directorio** con
`manifest.hl` y **no lee `index.theme` ni sigue `Inherits`** (el `~/.icons/default` que escribió
nwg-look y que hereda de Bibata solo lo entiende XCursor). Y ante un nombre que no encuentra
**libhyprcursor no falla**: coge **el primer tema con `manifest.hl` que se cruce**, ignorando el
nombre pedido. Medido con `hyprcursor_manager_create_with_logger` contra la `.so` instalada:

```
getFullPathForThemeName: failed, trying without name of Adwaita
Found theme Adwaita at ~/.local/share/icons/Bibata-Modern-Ice
```

`valid=false` solo si **no hay ningún** tema hyprcursor en el sistema (verificado apuntando `HOME` y
`XDG_DATA_DIRS` a un sitio vacío). O sea que el puntero del escritorio lo decidía **el orden de
lectura del directorio** —ni alfabético ni "el primero instalado": comprobado instalando un segundo
tema, la elección no cambió—, y bastaba instalar otro tema para cambiarlo sin tocar nada.
**Por eso `temaCursor` no enciende hyprcursor: fija CUÁL**, que es lo que faltaba.

**Ajuste**: `temaCursor` en `~/.config/gigishell/devices.json` (Ajustes > Dispositivos > Puntero).
**Vacío = no se emite ningún `hl.env`** y manda el tema de la sesión — el mismo criterio que el
`locale` de `gigishell/env.lua`, y por el mismo motivo: un nombre de fábrica cambiaría el puntero de
una máquina que nunca ha tocado el ajuste, y encima nombraría un tema que puede no existir en ella.
El desplegable **solo lista temas con `manifest.hl`**: elegir uno sin él dejaría al compositor
dibujando otro tema en silencio. El nombre se valida contra `^[A-Za-z0-9._+-]+$` **en origen**
(`normalize()`), porque acaba en un `hyprctl setcursor` y en un literal Lua de `hl.env()`; lo que
**no** se comprueba es que el tema exista, para que un `devices.json` traído de otra máquina
conserve la elección.

**`hl.env` solo alcanza a lo que Hyprland lance a partir de ese momento**, así que cambiar el tema
en caliente no reescribe el puntero de las apps ya abiertas: cambian al reiniciarse. El `setcursor`
sí afecta al compositor al instante. AGS escribe además `cursor-theme` en GSettings, no por GTK
solamente: es de donde lo lee Hyprland al arrancar con `cursor:sync_gsettings_theme` activo, y
dejarlo desincronizado revive el tema viejo en el siguiente login.

**`bin/generar-hyprcursor.sh` le añade la mitad hyprcursor a un tema XCursor** (`--list` enseña los
instalados y su estado). Sale **siempre** a `~/.local/share/icons`, nunca a `/usr/share/icons`: ahí
los ficheros son de un paquete y pacman no los rastrearía, así que una actualización dejaría mitades
descuadradas sin avisar. Es idempotente (`--force` rehace). Lo llama `install.sh` (paso 10) sobre
`$CURSOR_THEME`, por defecto `Bibata-Modern-Ice` — que va por el mecanismo de paquete **opcional**
porque vive en chaotic-aur y en un Arch puro haría fallar el `pacman -S` entero. El instalador
**no elige el tema**: preparar el terreno sí, cambiarle el puntero a quien no lo ha pedido no.

**Lo que el generador NO hace es inventar resolución.** Un tema XCursor son PNG por tamaño, así que
el `.hlc` generado lleva **esos mismos PNG** con `resize_algorithm = none` (verificado destripando
un `.hlc` generado: `default_000.png` 16×16, `default_001.png` 24×24…). El salto de calidad de
hyprcursor —SVG, nítido a cualquier tamaño y escala— **solo lo dan los temas autorados en SVG**,
como Bibata-Modern-Ice, cuyos `.hlc` sí contienen un `.svg`. Sobre un tema de paquete esto da
**paridad, no nitidez**. Dato para dimensionarlo: en Bibata la mitad SVG ocupa **328 KB** y la
XCursor **28 MB**.

**Y antes de eso moría por un paquete que NADIE declaraba: `xcur2png`.** `hyprcursor-util
--extract` **no lee los XCursor él mismo**: comprueba `xcur2png --help` y le pasa cada fichero
(visible en las cadenas del binario). Sin él aborta con `Failed: missing dependency: -x requires
xcur2png.`, y **el paquete `hyprcursor` no lo arrastra** — en Arch/CachyOS ni siquiera figura como
`optdepend`. El instalador pedía `hyprcursor` y daba por hecho el resto, así que en toda máquina
recién instalada el paso 10 fallaba **siempre**, y el aviso que salía era el mismo que el de abajo:
«no pude generar el tema hyprcursor 'Bibata-Modern-Ice' … elegí otro con `--list`». Mandaba a
cambiar de tema cuando **ningún** tema podía funcionar; probar otro reproduce el fallo idéntico y
parece que el generador está roto. Tres sitios, porque el diagnóstico tiene que llegar antes que el
síntoma: `xcur2png` se declara junto a `hyprcursor` en el paso de paquetes, el generador lo
comprueba **antes de extraer** y muere diciendo qué instalar y que *no es problema del tema*, y
`preflight.sh` lo exige junto a `hyprcursor-util` (que tampoco estaba en su lista).

**El paso 10 moría por un paquete que el propio instalador trata como opcional.** El gate de
`bibata-cursor-theme` era `pacman -Si`, que **no ve AUR**: en una máquina con paru/yay pero sin
chaotic-aur el paquete se descartaba **pudiendo instalarse**, Bibata no llegaba nunca, y el paso
terminaba con «no pude generar el tema hyprcursor 'Bibata-Modern-Ice'. Elegí otro con --list» — un
aviso que culpa al tema y manda a elegir otro cuando lo que falta es un paquete. Tres cambios:

- El gate acepta el ayudante de AUR (`[[ -n "$AYUDANTE_AUR" ]] || pacman -Si …`); `paquetes_instalar`
  ya sabe pasarle los AUR-only sin abortar.
- Un tema por defecto ausente ya **no es un fallo**: se cae al primer tema instalado
  (`breeze_cursors`, `Adwaita`, o el primero que liste el generador). Generar la mitad hyprcursor de
  otro tema **no le cambia el puntero a nadie** —eso sigue siendo `temaCursor` en `devices.json`—,
  así que el peor caso de equivocarse es un directorio de más. Un tema pedido **explícitamente**
  (`--cursor` o `CURSOR_THEME=` en el entorno) sí avisa, porque ahí el nombre lo eligió alguien:
  esa distinción es `CURSOR_THEME_EXPLICITO`, y hay que calcularla **antes** de aplicar el valor por
  defecto o siempre sale «explícito».
- El aviso incluye el **stderr real del generador**. Antes el motivo se lo llevaba el scroll de
  pacman y el resumen final decía que algo falló sin decir por qué.

**Y el guardián de idempotencia miraba solo el DESTINO, lo que degradaba a Bibata sin pedir
`--force`.** La cabecera del script ya advierte que rehacer un tema autorado en SVG sustituye sus
328 KB de SVG por el repaquetado en PNG de su propia mitad XCursor. Pues eso pasaba **sin
`--force`**: con Bibata instalado por paquete en `/usr/share/icons` (que trae su `manifest.hl` de
fábrica), el destino `~/.local/share/icons/Bibata-Modern-Ice` está **vacío**, el guardián no veía
nada y el script se ponía a repaquetar. Y la copia peor **tapa a la buena**, porque
`~/.local/share/icons` tiene más precedencia que `/usr/share/icons`. Sin un solo error, y con un
`Listo: … 47 formas` que parecía un éxito. Ahora se comprueba también el origen: si ya trae
`manifest.hl`, no hay nada que añadir. `--ruta <tema>` es el otro añadido — imprime el directorio
del tema o sale 1 — para que `install.sh` pregunte "¿está instalado?" sin reimplementar el orden de
precedencia de XCursor, que solo vive aquí.

### Perfiles TLP conmutables (`system/tlp/` + `servicios/energia/tlp.ts`)

Ajustes > Energía ofrece un selector **Normal/Ahorro** que cambia el perfil TLP en batería. El
problema de fondo es el mismo que el del brillo DDC y la regla udev de USB: **`tlp.conf` vive en
`/etc` y aplicarlo (`tlp start`) necesita root, pero AGS corre como usuario**. La regla de oro del
repo prohíbe que algo que toca root sea un symlink al árbol escribible por el usuario (escalada
silenciosa), así que la estructura separa **fuente versionada** de **copia de confianza root-owned**:

- **Fuente (versionada, la editas tú):** `system/tlp/{normal,ahorro}.conf` (perfiles completos que
  se intercambian **enteros**), `system/tlp/gigishell-tlp-apply.sh` (el helper) y
  `system/tlp/sudoers-gigishell-tlp` (la regla, con `__GIGISHELL_USER__` de placeholder).
- **Instalado por `install.sh` paso 6, todo root-owned:** helper → `/usr/local/bin/gigishell-tlp-apply`
  (755); perfiles → `/etc/gigishell/tlp/{normal,ahorro}.conf` (644); regla → `/etc/sudoers.d/gigishell-tlp`
  (440), generada sustituyendo el usuario real y **validada con `visudo -cf` ANTES de instalarla** (una
  regla sudoers malformada rompe `sudo` en toda la máquina). Se instala **solo si `tlp` está presente**;
  en un equipo sin TLP la función queda oculta.

**El flujo:** AGS ejecuta `sudo -n /usr/local/bin/gigishell-tlp-apply {normal|ahorro}`, que copia
`/etc/gigishell/tlp/<modo>.conf` → `/etc/tlp.conf` (atómico, tmp+`mv`), lanza `tlp start` y anota el modo
en `/etc/gigishell/tlp/active` (world-readable, que AGS relee al arrancar sin sudo). **`install.sh` NO
toca `/etc/tlp.conf`** — eso lo hace el helper la primera vez que el usuario elige un perfil; si tenías
un `tlp.conf` afinado, pega su contenido en `system/tlp/normal.conf` antes de reinstalar.

**`tlp.service` se habilita en el bucle de servicios de `install.sh`, y faltaba.** El instalador
añadía los paquetes (`tlp tlp-rdw`, solo si `tiene_bateria`) y los perfiles conmutables, pero su
bucle de `systemctl enable --now` cubría únicamente `NetworkManager.service` y `bluetooth.service`:
**la unidad de TLP no la activaba nadie**. El fallo es silencioso porque el selector de Ajustes >
Energía seguía funcionando igual — el helper hace `tlp start`, que aplica el perfil **en caliente** y
no depende de la unidad — y `/etc/tlp.conf` persiste entre reinicios; lo que no ocurría es que ese
fichero se APLICARA al arrancar o al cambiar de AC a batería. Resultado: un portátil recién
instalado empezaba cada sesión sin TLP puesto hasta que alguien movía el selector o entraba en modo
ahorro, sin un solo error por ningún lado. Ahora el bucle recorre un array `unidades` al que se le
suma `tlp.service` **bajo el mismo `tiene_bateria`** que decide instalar el paquete (en un sobremesa
no se toca nada, y así no compite con `power-profiles-daemon`). El `list-unit-files` que ya guardaba
el bucle sigue delante: si el paquete no llegó a instalarse, avisa y sigue en vez de abortar.
`tlp-rdw` no tiene unidad propia que activar — va por dispatcher de NetworkManager.

**Y `power-profiles-daemon` se desactiva antes, porque si no la mitad del arreglo no sirve.** TLP y
ppd escriben LOS MISMOS ajustes del kernel (governor, EPP, ASPM, autosuspend USB): con los dos
vivos gana el que escriba el último y el portátil acaba en un estado que no es ninguno de los dos
perfiles. No da error, solo consumo — y CachyOS trae ppd activo en varias ediciones, así que en una
máquina recién instalada pasa por defecto. `install.sh` lo `disable --now` justo antes de activar
`tlp.service`, y solo en el mismo `tiene_bateria`. Se **desactiva**, no se enmascara: volver atrás
es un `systemctl enable --now power-profiles-daemon.service`.

**`enable --now` era el propio bug: un arranque en caliente fallido se llevaba por delante la
activación.** `systemctl enable --now tlp.service` es UN comando con dos efectos de vidas
distintas —dejar la unidad activada para los próximos arranques y arrancarla ahora— y basta con
que falle el segundo para perder los dos. Y el segundo falla de verdad: `tlp init start` **aborta**
si encuentra otro gestor de energía vivo (`conflicting power management service is active`). La
instalación terminaba avisando «no pude activar tlp.service» y el portátil se quedaba **sin la
unidad activada**, cuando el `enable` habría funcionado perfectamente — de ahí que un
`sudo systemctl enable tlp` a mano después lo arreglara siempre, que es exactamente el síntoma que
se reportó. Ahora el bucle hace `enable` y `start` **por separado y en ese orden**: si el arranque
en caliente falla, la unidad ya quedó activada y el aviso lo dice («quedó activada pero no arrancó
ahora … se aplicará al reiniciar») en vez de mandar a arreglar algo que ya está bien. Los dos
avisos incluyen el stderr real de `systemctl`, que antes se tiraba: el aviso decía que algo falló
pero nunca por qué.

**Y la lista de conflictos es la de TLP, no solo ppd.** Mirar únicamente
`power-profiles-daemon.service` no basta para que el `start` funcione: TLP aborta también con
`tuned.service` y `auto-cpufreq.service`, y **`tuned-ppd` *provee* power-profiles-daemon**, así que
comprobar el nombre de ppd no la ve. El bucle recorre las tres con el mismo criterio
(`is-enabled` o `is-active` → `disable --now`, avisando sin abortar).

**El preflight lo comprueba ahora, que es lo que faltaba para que no se repita.** En modo
`--installed`, y solo si hay batería del SISTEMA (mismo criterio de `scope != Device` que usa
`install.sh`), exige que `tlp` esté instalado y que `tlp.service` esté `is-enabled`, y avisa si ppd
sigue vivo. Antes nada validaba esto: por eso un portátil pudo estar meses con los paquetes
instalados, los perfiles en `/etc/gigishell/tlp/` y la unidad apagada, y el preflight decir que la
instalación estaba correcta.

**Por qué es seguro y no una escalada:** todo lo que `sudo` toca es root-owned, y la regla sudoers
casa el comando **exacto con argumento fijo** (`normal`/`ahorro`), no un script en `~/.config`. Editar
la copia del repo no cambia lo que corre como root hasta reinstalar con `sudo` a propósito. El `-n` de
`sudo` evita colgarse pidiendo contraseña: sin la regla, falla en el acto.

**Lado AGS (`servicios/energia/tlp.ts`):** `tlpAvailable` exige `tlp` + el helper + batería presente
(mismo patrón que el brillo sin backend DDC — la tarjeta se oculta entera si falta algo). El estado
inicial sale de leer `/etc/gigishell/tlp/active` directamente. `tlpBusy` bloquea el selector mientras el
helper corre (evita dos `tlp start` a la vez). Es un **selector manual e independiente** del "Forzar
modo ahorro" y del umbral de batería. **Forzar modo ahorro** (`forcePowerSave` en
`~/.config/power-save/config.json`) es lo otro nuevo: hace `powerSaveActive` verdadero ignorando
nivel/carga/presencia de batería, así que también funciona en un sobremesa.

### Security monitor (`oom-monitor.sh`) + sandboxed launcher (`run-untrusted.sh`)

Despite the filename, `hypr/scripts/oom-monitor.sh` is the general **security event monitor** —
OOM killer is just one of ~16 scanned event types. Five sub-monitors run in parallel (`&` + `wait`):

**No se retrasa entero desde `gigishell/autostart.lua` — se escalona por dentro, y la asimetría es el
diseño.** Sus sub-monitores no corren el mismo riesgo si empiezan tarde. Los que **siguen**
(`journalctl -kf`/`-f` con `-n 0`, que salta el backlog a propósito, e `inotifywait`) no
recuperan lo pasado: retrasarlos convertiría un OOM, un `sudo` fallido o un cambio en
`/etc/shadow` en una **ventana ciega** — justo lo que el script existe para evitar. Los que
**sondean** leen un estado que sigue ahí cuando lo mires, así que apartarlos no pierde nada y son
además los caros: `DELAY_UNITS=25` (su primera pasada solo siembra, no notifica: retrasarla es
literalmente invisible), `DELAY_SMART=45` (despierta cada disco; el sondeo es horario) y
`DELAY_DOWNLOADS=60` (el más caro: recorre Descargas y, ante un fichero nuevo, lo hashea y lo pasa
por ClamAV, que recarga ~200 MB de firmas **por invocación**). Los `sleep` van **dentro de cada
función y tras sus guardas**, para no dejar uno colgando por un monitor apagado. Medido en vivo:
los tres seguidores enganchan a t=0 y las pasadas caen en t=25/45/60.

**Los seis sub-monitores tienen sustituto en Rust: `gigishell-eventd`** (crate en `eventd/`,
plan completo en [`rust-migracion.md`](rust-migracion.md)). Si `~/.local/bin/gigishell-eventd`
existe, `oom-monitor.sh` le **pregunta** qué cubre (`gigishell-eventd --modulos`): si lo cubre todo
le cede el proceso con **`exec`** y no queda ningún bash; si cubre solo una parte (un binario de
una fase anterior), lo lanza como hijo (`--hijo`) y corre en bash el resto, así que nunca queda un
monitor sin nadie. Sin el binario, o con `GIGISHELL_EVENTD=0`, corren todas las funciones bash de
siempre. **Relanzar = volver a ejecutar `oom-monitor.sh`**, en cualquier modo: el script retira
al arrancar lo que corriera antes (`_retirar_anteriores`), tanto un `oom-monitor.sh` en modo bash
como un daemon que ya hizo `exec` —cuya línea de órdenes ya no dice «oom-monitor.sh», así que
`pkill -f oom-monitor.sh` no lo encuentra—. Sin eso, instalar el binario y relanzar dejaba el bash
viejo vivo junto al daemon (avisos duplicados, dos `clamscan` por descarga, dos escritores del
índice), y quitarlo dejaba el daemon junto al bash nuevo. El daemon además lleva su cerrojo
(`$XDG_RUNTIME_DIR/gigishell-eventd.pid`, `flock`: la instancia nueva manda SIGTERM a la vieja),
así que un `hyprctl reload full-reset` no duplica avisos. Pararlo: `pkill -x gigishell-event`
(el nombre de proceso se corta a 15 caracteres). Qué cambia y qué NO:

- **Mismo contrato de cara a AGS**: mismas reglas en el mismo orden, mismos ids
  `x-gigishell-event`, mismos títulos/cuerpos, misma agrupación (calma 4 s, tope 20 s, lista de 8,
  cap 300; en archivos, ventana ancha 30 s/900 s durante una actualización y «un texto repetido
  = un cambio»). Los tests (`cargo test` en `eventd/`) fijan los casos que el bash documenta.
- **Dos procesos: un supervisor y un trabajador con cinco hilos**, en vez de un bash por
  monitor con sus `journalctl -f` e `inotifywait -m` colgando. El supervisor existe porque en el
  bash cada monitor iba aislado y aquí no: un aborto en cualquier hilo (`panic = "abort"`) o un
  OOM tumba los seis a la vez, y quedarse sin vigilancia SIN SABERLO es el peor fallo posible.
  Si el trabajador muere, lo relanza a los 5 s y avisa (`monitor.fallo`); tras **5 caídas en
  10 min** avisa en crítico y se convierte (`exec`, mismo pid) en `oom-monitor.sh` con
  `GIGISHELL_EVENTD=0`, o sea, en los monitores bash. El trabajador se relanza como
  `/proc/self/exe`, no por ruta: `instalar.sh` sustituye el fichero y la ruta vieja pasaría a
  «(deleted)». Tampoco se usa `eprintln!`/`thread::spawn` a pelo: los dos hacen panic si fallan
  (stderr roto, sin hilos) y eso abortaría todo por una línea de diagnóstico. Dentro del
  trabajador: journal por sd-journal (FFI, disyunción `_TRANSPORT=kernel` OR los
  identificadores), inotify nativo, y los dos sondeos (`systemctl --failed` cada 120 s y
  `smartctl` cada hora, con sus retardos de 25 s y 45 s y la puerta de juego portada de
  `lib/gaming-gate.sh`), más el escáner de Descargas. Anon ~0,4 MB; el resto del RSS (~20 MB) son páginas de los ficheros del
  journal mapeadas, caché compartida y reclamable, igual que le pasaba a `journalctl`.
- **La línea que ven las reglas del journal ya no lleva fecha ni host**: se reconstruye como
  `kernel: <msg>` o `<ident>[<pid>]: <msg>`. El prefijo `ident[pid]:` hay que conservarlo: la
  regla de sudo busca «sudo» en la línea y el mensaje de «3 incorrect password attempts» no lo
  contiene, solo el prefijo.
- **`security.json` se relee en caliente** (mtime, como mucho una vez por segundo) en los cinco.
  Apagar `serviceHealth` y volver a encenderlo **resiembra** las unidades: lo que cayó mientras
  estaba apagado no llega de golpe como nuevo. `monitor_downloads` sigue leyéndolo en cada barrido.
- **Los discos para SMART salen de `/sys/block/*/device`** (sin `lsblk | awk`): descarta zram,
  loop, dm y md porque no tienen `device`, y los ópticos por prefijo.
- **Se vigila también `sshd-session`**: desde OpenSSH 9.8 los «Failed password» salen con ese
  identificador y el `-t sshd` del bash no los veía.
- **Cada categoría tiene su propia ventana de agrupación**: una ráfaga de NVRM ya no retrasa el
  aviso de un `sudo` fallido que llegue en medio.
- **Escáner de Descargas**: mismo índice (`download-index`, `mtime|tamaño|ruta`) y mismos hashes
  (`download-hashes`) en `~/.cache/gigishell/`, así que el cambio no vuelve a analizar nada. El
  hash XXH64 se calcula **en proceso** y da byte a byte lo mismo que `xxh64sum` (un test lo
  compara con el binario); en una máquina que caía a `sha1sum`/`md5sum` por no tener xxhash, lo
  ya analizado se analiza una vez más. Se hashea en un hilo de vida corta con `nice 19` + E/S
  idle, **no en el hilo del escáner**: la prioridad se hereda, y el botón «Lanzar aislado» lanza
  la app del usuario desde ese hilo. `clamscan` sigue siendo un proceso (`nice -n 19 ionice -c
  3`), un lote por barrido, cortado si entra una pausa. inotify sigue siendo solo el
  despertador, con watches propios que se reponen en cada barrido (cubren subcarpetas nuevas) en
  vez de relanzar `inotifywait -r`. Los tres avisos con botón (`--wait -A`) esperan en un hilo
  cada uno; el de «sin firmas» con su techo de 120 s.
- **Si el journal no se puede abrir, el proceso NO sale**: los hilos de archivos y sondeos no
  dependen de él y seguirían muertos con él. Pero lo **avisa en crítico** (`monitor.fallo`): sin
  journal no hay avisos de OOM, sudo, SSH ni errores de disco.
- **Si el `exec` del script falla** (binario corrupto, sin permiso), `shopt -s execfail` evita
  que el bash termine —sin él un bash no interactivo SALE—, se avisa y corren los seis monitores
  bash.
- **Rutas de Descargas como bytes, nunca como texto**: un nombre no UTF-8 (un `.zip` de Windows
  extraído sin `-O`) pasado a `String` llevaba U+FFFD y dejaba de existir: ni hash, ni aviso, ni
  ClamAV, en silencio y en cada barrido. El bash sí lo analizaba.
- **Solo un `clamscan` que sale con 0 o 1 marca el lote como analizado.** El bash solo excluía
  el 2 (sin firmas); un `clamscan` matado por el OOM (ClamAV 1.x ronda 1 GB) o un 126/127
  (desinstalado a mitad de sesión) se daba por limpio PARA SIEMPRE, porque el memo va por hash
  de contenido. `nice`/`ionice` se anteponen solo si existen, como en el bash.
- **SMART sin permisos ahora SÍ avisa** (`disco.smart-sin-permisos`, una vez por sesión). El bash
  lo esperaba de una salida vacía, pero sin root `smartctl` imprime su cabecera y «Permission
  denied» en stdout: el aviso no salía nunca y el sondeo no hacía nada sin decirlo. Sin
  `smartctl` instalado no se sondea ni se avisa (el bash hacía `return`).
- La lista del lote de `clamscan` va a `$XDG_RUNTIME_DIR`, no a `/tmp` con nombre predecible
  (otro usuario podía crearla antes y, con `protected_regular`, el escáner no escribía nunca).
- La raíz de Descargas se vigila SIEMPRE, también cuando un barrido cae en pausa: si no, lo
  descargado al salir de la pausa esperaba a la red de seguridad (5 min) en vez de ~3 s.
- **Como hijo (`--hijo`) muere con su padre por `PR_SET_PDEATHSIG`**, así que no necesita la red
  de huérfanos. Tras el `exec` NO se pide: no hay bash que seguir, y el padre que haya (un
  `sh -c` de paso, un `setsid`) puede morir en cualquier momento sin que signifique nada.
- Ojo con `pkill -f oom-monitor.sh` en el modo con bash: lanzado desde un shell cuya propia línea
  de órdenes contiene ese texto (un `bash -c '…'`, o la herramienta de un agente) se mata también
  a sí mismo antes de relanzar nada.

Compilar e instalar: `eventd/instalar.sh` o `bash install.sh --solo eventd` (pasan los tests
antes; `preflight.sh --installed` avisa si el binario es más viejo que `eventd/src`); quitar:
`eventd/instalar.sh --quitar`. Para comparar con el bash sin avisos duplicados:
`GIGISHELL_EVENTD=0` al lanzar el monitor y, a la vez, `gigishell-eventd --simular`, que imprime
por stdout lo que habría notificado y **no escribe ningún estado en disco** (índice, hashes), así
que no le pisa el índice al bash. Sí lanza `clamscan` sobre lo nuevo.

- `monitor_kernel` — `journalctl -kf` (kernel-only, avoids matching app logs): OOM, panic,
  hung tasks, disk I/O errors, hardware errors (MCE/ECC/EDAC), unsigned/out-of-tree kernel
  modules, GPU/NVIDIA errors, CPU throttling, segfaults.
  **Cada tipo es su propia categoría agrupada** (`lib/notif-agrupar.sh`): una GPU atragantada repite
  la misma línea NVRM decenas de veces y ahora sale un «40 errores de GPU» con la línea listada una
  vez y su `(×40)`. Los **cooldowns** por dispositivo (E/S) y por proceso (segfault) siguen ahí y no
  sobran: son capas distintas — el cooldown decide **qué se encola** (un disco agonizando no aporta
  nada nuevo cada 200 ms), la agrupación decide **cómo se presenta**; sin cooldown, agrupar solo
  cambiaría "40 popups" por "un popup cada 20 s, para siempre". **El kernel panic no se agrupa**: el
  sistema se está yendo y la ventana de calma puede ser más de lo que le queda a la sesión.
  **`diskError` clasifica el dispositivo antes de alarmar.** Casaba `*"i/o error"*` a pelo contra
  cualquier línea del kernel, así que arrancar un pendrive sin expulsarlo (que suelta un
  `Buffer I/O error on dev sdb1 … lost async page write` por cada página no volcada) disparaba una
  **crítica "Error de disco" por línea** — un disco sano denunciado como moribundo. Ahora se saca
  el dispositivo de la línea (`_io_dev`), se resuelve a su disco padre (`_disk_base`; las particiones
  no tienen `bdi`/`removable` propios) y solo es "Error de disco" si `_disk_is_internal`: el nodo
  **sigue existiendo** y `removable=0`. No basta con mirar si existe — el nodo sobrevive unos ms al
  desconecte, y el flag `removable` cubre esa carrera. Si es extraíble o ya desapareció, sale un
  aviso normal **"Extracción insegura"** (datos, no hardware). Una línea que no nombre dispositivo
  **sí** alarma (fail-safe). Además hay cooldown de 30 s **por dispositivo**: un disco muriéndose de
  verdad suelta decenas de líneas por segundo. Ver la sección de USB para la causa raíz y la cura.
  **Y dentro de "extraíble", se mira si la E/S era LECTURA o ESCRITURA** (`_io_es_escritura`), porque
  el texto del aviso —«se quitó **con escrituras pendientes**, puede haber archivos incompletos»— es
  una afirmación sobre los datos del usuario y era falsa la mitad de las veces. Caso real que lo
  destapó: tirar del pendrive mientras lo estaba leyendo el `fsck.exfat -n` que lanzaba nuestro propio
  `check_volume` (ver la sección de USB) llena el log de `op 0x0:(READ)` y salía el aviso de escrituras
  perdidas sin que se hubiera escrito **nada**. Hoy la lectura tiene su propio id
  (`usb.extraccion-en-lectura`, silenciable aparte) y su propio texto, que no habla de archivos
  incompletos. El **cooldown pasa a ser por dispositivo Y tipo**: en una extracción a mitad de una
  copia llegan lecturas y escrituras entremezcladas, y con una sola clave la primera línea —casi
  siempre una lectura, que es la que más readahead genera— se comía los 30 s y **ocultaba las
  escrituras**, que son las que sí importan. La ambigüedad se resuelve a favor de no alarmar: una línea
  que no diga de qué tipo es cuenta como lectura.
- `monitor_system` — `journalctl -f` filtered by `-t` identifier (sudo, sshd, su, pkexec,
  polkitd, systemd, systemd-coredump): failed-to-start services, sudo/su/polkit auth failures,
  SSH accepted/failed, coredumps, and a sliding-window "crash storm" detector (≥3 coredumps
  in <60s).
  **Agrupado por tipo**, y aquí la ráfaga típica no es hardware sino un ataque o un servicio en
  bucle: un SSH expuesto recibe cientos de `Failed password` por minuto y una unidad rota reintenta
  cada pocos segundos. El aviso de sudo **no lleva dato variable a propósito** (no se filtra la línea
  del journal al popup), así que encola texto vacío y lo que informa es el recuento: «5 fallos de
  sudo» + el cuerpo de siempre. **La tormenta de crashes no se agrupa**: ya es un resumen, y trae su
  propio límite de uno por minuto.
  **Escaladas de privilegios (`privEsc`) — solo avisa de lo que NO se autorizó con contraseña.**
  pkexec emite **dos** líneas por escalada: la de PAM (`pam_unix(polkit-1:session): session
  opened`, que no dice *qué* se ejecuta) y la de `Executing command … [COMMAND=…]`. Ninguna de las
  dos avisa: la de PAM se descarta siempre (no es informativa), y la de `COMMAND=` significa que el
  propio usuario acaba de meter su contraseña en el diálogo de polkit para autorizar justo esa
  escalada — notificarla no añade señal, solo ruido. Esto empezó siendo una allowlist de globs
  (`PRIVESC_ALLOW`) para silenciar solo a GameMode, que escala por pkexec **cada vez que un juego
  arranca y otra vez al cerrarse** (`/usr/lib/gamemode/cpugovctl set performance`,
  `procsysctl split_lock_mitigate`, `gpuclockctl`) y convertía jugar en una lluvia de avisos
  críticos "Escalada de privilegios" que enseñaba a ignorar la categoría entera; se generalizó a
  *todo* `COMMAND=` porque cualquier pkexec autenticado con contraseña tiene el mismo problema, no
  solo el de GameMode. Lo que **sigue** avisando es la escalada que NO pasó por una contraseña
  válida: un pkexec **denegado** no abre sesión PAM ni loguea `COMMAND=`, pero sí `Not authorized`,
  que la rama sigue captando — igual que los fallos de autenticación de `su` y de polkit. Ojo: esto
  asume que todo pkexec de este repo pide contraseña (`auth_admin`/`auth_admin_keep`); si algún día
  se invocara pkexec para una acción `allow_active=yes` (sin prompt, como hace UDisks para
  removibles — ver la sección de USB para por qué esa ruta deliberadamente NO pasa por pkexec),
  esa escalada también callaría sin haber pasado por una contraseña.
- `monitor_files` — `inotifywait` on the *parent directories* of critical paths (not the files
  themselves, so atomic write+rename replacements like `visudo`/`passwd` are still caught):
  `/etc/passwd`, `shadow`, `sudoers`, `ld.so.preload`, `sshd_config`, plus persistence
  locations (`sudoers.d/`, `pam.d/`, `cron.d/`, `systemd/system/`, `~/.config/autostart/`,
  `~/.ssh/authorized_keys`, `/boot/`).
  **Notifica por ráfaga, no por fichero** (vía `lib/notif-agrupar.sh`, ver su sección). Emitía una
  notificación **por cada ruta**, y todas las de `/etc` son críticas con `-t 0` (sin autocierre):
  un `pacman -Syu` normal dejaba decenas de tarjetas críticas apiladas del mismo tema, que se
  despachan cerrándolas en bloque sin leer ninguna — el mismo resultado que apagar la categoría, y
  por la misma razón que la allowlist de `privEsc`. Las cuatro categorías (`archivos.critico-modificado`,
  `archivos.persistencia`, `archivos.clave-ssh`, `archivos.boot`) se acumulan por separado, así que
  una avalancha en `/boot` no se traga un cambio en `/etc/shadow`. `create` + `close_write` del
  mismo fichero son dos eventos del mismo cambio y la deduplicación de la librería los colapsa.

  **Una actualización de paquetes NO es persistencia, y por eso se desvía entera a un aviso
  informativo.** Agrupar bajó el volumen pero no arregló el fondo: `pacman -Syu` deja `.pacnew` en
  `/etc/pam.d`, reinstala units en `/etc/systemd/system`, toca `/etc/passwd` vía sysusers y renueva
  kernel+initramfs, así que cada actualización disparaba "Posible persistencia" con `-t 0`
  hablando de cambios que el propio usuario acababa de autorizar con su contraseña. Dos filtros:

  1. Los **artefactos del gestor** (`*.pacnew`, `*.pacsave`, `*.pacorig`, sus equivalentes
     `dpkg-*`/`rpm*`) se descartan **siempre**, dentro o fuera de una actualización. Un `.pacnew`
     es justo la prueba de que pacman **no** tocó tu fichero activo — anunciarlo como persistencia
     dice lo contrario de lo que significa. Es el fichero de las capturas del usuario
     (`/etc/pam.d/chpasswd.pacnew`).
  2. Mientras hay **transacción de paquetes en curso** (`pkg_tx_activa`), `fcrit`/`fpersist`/`fboot`
     se encolan en `fpkg` → `archivos.actualizacion`, urgencia `low` y autocierre a 15 s: un solo
     "Actualización del sistema · N archivos" en vez de decenas de críticas. **No se callan del
     todo a propósito**: si algo tocó `/etc` mientras actualizabas, sigue constando. `~/.ssh/authorized_keys`
     es la excepción que **nunca** se desvía — ningún paquete la escribe.

  La detección es el **lock** (`/var/lib/pacman/db.lck`), no el proceso: existe exactamente durante
  la transacción *incluidos los hooks* —que es cuando llegan la mayoría de los eventos— y mirarlo
  es un `stat` por evento. Para gestores cuyo lock es un fichero permanente con `flock` (dpkg) el
  `-e` no valdría, así que ahí se cae a un `pgrep -x` limitado a uno cada 2 s. `PKG_GRACIA`=90 s de
  margen tras soltarse el lock porque `paru`/`yay` lo sueltan y retoman entre la fase de repos y la
  del AUR, y hay hooks (dkms, mkinitcpio) que escriben justo después; sin margen la avalancha
  volvía por ese hueco. Eso **es** una ventana ciega de 90 s por operación de paquetes, aceptada a
  sabiendas: quien puede correr pacman como root no necesita esconder nada en `/etc`.

  Durante la transacción la ventana de agrupación se ensancha (`PKG_CALMA`=30 s / `PKG_TOPE`=900 s)
  y se restaura al acabar. Sin eso, el tope normal de 20 s partiría una actualización de tres
  minutos en quince resúmenes. Efecto colateral asumido: la ventana es de todo el bucle, así que la
  alerta de clave SSH puede llegar hasta 30 s tarde si coincide con una actualización.

- `monitor_smart` — hourly `smartctl -H -A` polling per physical disk (zram/loop/dm-/sr
  excluded); warns once if it can't read SMART (permissions), alerts on `FAILED`/`FAILING_NOW`.
- `monitor_units` — polls `systemctl --failed` (system *and* user buses) every 120s; the first
  pass only seeds state so pre-existing failures aren't reported as new. Tras un apagón sucio o una
  actualización caen **varias unidades a la vez** y la pasada las devuelve todas juntas: **la pasada
  es el lote**, se encolan y se vuelcan al terminarla — agrupar aquí no cuesta ni un segundo de
  retraso, porque no hace falta ninguna ventana de tiempo.
- `monitor_downloads` — **event-driven `find` sweep** of the locale-aware Downloads dir
  (`xdg-user-dir DOWNLOAD`, falling back to `~/Downloads`/`~/Descargas`; this machine's is
  `~/Descargas`). **inotify is a *wakeup*, not the scanner**: the body is `_dl_sweep` (a nested
  function that sees the persistent state — `_idx`/`_scanned`/`seeded`/`dir` — via bash dynamic
  scope), and the loop blocks on `inotifywait -q -r -t <safety> -e create,close_write,moved_to,moved_from,delete`.
  On an event it **debounces** (~3s of quiet, 30s hard cap) so extracting a game = *one* sweep, not
  thousands; on the `<safety>`=300s timeout it sweeps anyway (net for inotify `IN_Q_OVERFLOW` / the
  `-r` new-subdir blind spot — the sweep is authoritative regardless of which events inotify dropped).
  Idle = blocked, ~zero CPU (vs the old fixed 30s poll). Falls back to a plain 30s poll if
  `inotify-tools` is absent, and degrades to it on inotify errors (rc=1, e.g. watch-limit).
  **Content-hash dedup** (replaced the old permanent `path|size` scheme in `download-seen`, whose
  append-only, never-pruned, reboot-surviving state meant a file was scanned exactly once *ever* —
  re-adding it, even a *different* file of the same size at the same path, was silently skipped).
  Two state files under `~/.cache/gigishell/`: `download-index` (`mtime|size|path`, a cheap per-file
  memo, **pruned** to currently-existing files each pass so it can't grow unbounded) and
  `download-hashes` (one `xxh64sum` per already-analyzed *content*, persistent — append-only but
  **capped**: once it passes 10 MB it's truncated to the last 100 entries via `tail -n 100` and the
  in-memory `_scanned` set is rebuilt to match; ~17 B/entry so this is a years-away hard valve, not
  routine). Rule: memo hit
  (`mtime|size` unchanged) → skip without hashing; changed/new → hash it — if that content hash was
  already analyzed, skip (same file re-added ≠ re-scan), else scan it (different content = different
  hash = scanned, even at the same path/size). `download-seen` is deleted on startup by the new code.
  Two jobs: (1) **flags new executables** (`is_runnable`: `+x`, ELF magic, `.appimage/.run/.exe/…`)
  with a "Lanzar aislado" action button — seeded silently on first run to avoid a flood; (2)
  **ClamAV-scans ALL new files** (not just executables — a virus can be a `.com`, document, etc.).
  Prefers `clamscan` (standalone) over `clamdscan` (needs the `clamd` daemon running). NB: the first
  sweep after the state is reset (or after this migration) hashes+scans every existing download once
  — a one-time heavier pass.
  **Resource controls (all live-read from `security.json` each sweep — no reboot needed, unlike the
  event toggles):** hashing and ClamAV run under `nice -n19 ionice -c3` (idle). `_dl_paused` defers
  the *whole* sweep when an enabled pause gate is active *now* — `dlPauseOnBattery` / `dlPauseInPowerSave`
  (battery read from `/sys/class/power_supply`, ver el aviso de abajo; threshold from
  `~/.config/power-save/config.json`) /
  `dlPauseWhileGaming` (reads `~/.config/gigishell/runtime-state.json` `{gaming}`, written by AGS
  `servicios/energia/gamingState.ts`, which reuses the `isGameClient` heuristic — `ags/modulos/barra/juegos/`,
  ver `ags/CLAUDE.md`). Deferred work marks nothing, so
  it's picked up when the gate clears. The size cap is `dlMaxScanGB` (default 1 GB), also live.

  **`/sys/class/power_supply/` NO lista solo la batería del equipo, y creerlo rompía la pausa por
  batería en un sobremesa.** El ratón inalámbrico aparece ahí (aquí un Logitech G305 →
  `hidpp_battery_0`) y reporta `status=Discharging` **siempre**: un ratón sin cable siempre tira de
  su pila. `_on_battery`/`_battery_pct` recorrían el directorio entero y se quedaban con el primero
  que casara, así que este sobremesa se creía **"a batería" de forma permanente** y el % era el del
  **ratón**. Con `dlPauseOnBattery` activado eso habría pausado el escáner de descargas **para
  siempre**, en silencio y sin nada en la UI que lo delatara (no llegó a saltar solo porque esa
  pausa está en `false`). El kernel ya lo distingue y `_is_system_battery()` lo usa: fuera
  `scope=Device` (así marca las pilas de periféricos; la del equipo es `scope=System` o **no trae
  `scope`**, como los `BAT0` de portátil) y fuera `type != Battery` (el adaptador es `type=Mains`).
  Verificado con A/B (viejo: "con batería" = sí; nuevo: no) y con un BAT0 simulado para no romper
  el portátil. Mismo patrón en el `HAS_BATTERY` de `boot-healthcheck.sh`, que hace `grep -i bat`
  sobre esa lista y **también** casa con el ratón — ahí sale inofensivo de milagro, porque el bucle
  que va detrás globa `BAT*` y no encuentra nada.
  **Un `clamscan` que FALLA no es un `clamscan` limpio — y darlo por limpio era un agujero real.**
  El lote va a `2>/dev/null` y solo se leían las líneas `FOUND`, sin mirar el código de salida
  (0 = limpio, 1 = virus, **2 = ERROR**: sin base de firmas, permisos, fichero ilegible). Con la
  DB vacía —ClamAV recién instalado y `freshclam` **sin ejecutar nunca**, que es como se encontró
  esta máquina: `/var/lib/clamav` a 0 ficheros— `clamscan` salía con 2 y cero `FOUND`, así que el
  lote caía en la rama de "terminó bien" y **se marcaba como analizado**. Y como el memo va por
  **hash de contenido y es permanente**, esos ficheros no se volverían a analizar **nunca**, ni
  después de instalar las firmas: el escáner era un sello de "analizado" que no analizaba nada
  (medido aquí: **747 hashes** sellados con 0 firmas cargadas). Hoy `rc == 2` → `engine_ok=false`
  → **no se marca `_idx` ni `_scanned`** (el lote se reintenta solo cuando haya motor) + un aviso
  crítico **una vez por proceso** (`_dl_warned_engine`, mismo patrón que `warned_perm` en
  `monitor_smart`; sin el freno sería un aviso por barrido). Un `rc=1` **sí** marca: el análisis
  ocurrió y el hallazgo ya se notificó. Al arreglarlo aparece un efecto de segundo orden que
  obliga a `_alerted`: si no se marca `_idx`, el mismo ejecutable vuelve a entrar en `new_exec`
  en **cada** barrido (uno cada 5 min por la red de seguridad de inotify), así que
  `_alerted` (solo RAM, clave `ruta` → firma `mtime|tamaño`) da **un aviso por fichero y sesión**,
  y vuelve a avisar si el fichero cambia. En el camino sano `_alerted` no hace nada: allí `_idx`
  ya salta el fichero. **Lo ya sellado en falso NO se reevalúa solo**: tras instalar las firmas hay que borrar
  **los dos** ficheros de caché, `~/.cache/gigishell/download-index` **y** `download-hashes` (se
  reconstruyen). Borrar solo `download-hashes` **no sirve** y es un error fácil: la primera guarda
  del barrido es `_idx` (`download-index`, memo `mtime|tamaño`) y hace `continue` **antes** de
  llegar a hashear, así que el fichero se saltaría igual. La alternativa sin borrar nada es el
  escaneo forzado de Ajustes (`scan-downloads.sh`), que ignora el memo — pero tampoco lo
  actualiza, así que el escáner automático los seguirá dando por analizados. Verificado con A/B sobre un `clamscan` simulado (rc 0/1/2) y con 3 barridos
  seguidos para el spam.

  **Coste en REPOSO del barrido, y las dos cosas que lo dominaban.** El bucle está dirigido por
  eventos y en reposo el proceso queda bloqueado en `inotifywait`, pero la red de seguridad lo
  despierta cada 300 s pase lo que pase, y ese barrido "vacío" costaba mucho más de lo que parece:
  (1) **un `stat` por fichero** en la fase A.2 — con 67 ficheros en Descargas, **40 ms y 67 forks**
  cada vez; hoy el `find` de la fase A.1 trae `mtime` y tamaño con `-printf '%T@|%s|%p'` y la fase
  A.2 los lee del array `_stat`: **2 ms y ningún fork** (el `stat` queda solo como repliegue para un
  fichero aparecido entre medias). `%T@` trae fracción, que se trunca sin fork para conservar el
  formato entero `mtime|tamaño` del índice en disco, y el troceo va a mano porque **la ruta puede
  llevar `|`**. (2) **cuatro `jq` sobre `security.json`** para leer las tres pausas y el tope, o sea
  cuatro procesos y cuatro lecturas del mismo fichero por barrido: hoy es **un solo `jq`** con
  `join("|")` (5 ms → 1 ms). Un barrido en reposo pasa así de ~45 ms y ~72 procesos a ~4 ms y ~3.
  Ojo con el repliegue de `dlPauseWhileGaming` ante una salida ilegible: es `true`, porque replica
  lo que significa "clave ausente", y no el `false` de la inicialización (que es el caso distinto de
  "no hay ni jq ni fichero"). (3) **`_dl_paused` ya no forkea `jq`**: además de una vez por barrido,
  se consulta **cada 2 s durante todo el `clamscan`** del lote (ver la Fase B), y cada llamada
  forkeaba uno o dos `jq` sobre ficheros de tres líneas. Ahora se leen con `read` y una expresión
  regular de bash — el mismo idioma que ya usa `lib/gaming-gate.sh` para ese mismo
  `runtime-state.json`— y no cuesta ningún proceso.

  **Interruptible scan**: `clamscan` reloads its ~200 MB signature DB on *every* invocation (~13 s
  here), so the batch is **not** chunked — one `clamscan --file-list` over the whole batch runs in the
  background while a `_dl_paused` poll (every 2 s) `kill`s it if a gate activates mid-scan (latency
  ~2 s). Completing marks `_idx`+hashes for all; a kill marks nothing, so the batch re-scans on
  resume (FOUND lines already printed before the kill still alert). **In-progress downloads**
  are skipped: browser/manager temp markers (`.part`/`.crdownload`/`.aria2`/`.!qB`/… *and their base
  name*) plus anything modified in the last 15s (still being written); a file moved out of Downloads
  mid-scan is skipped by a per-file existence recheck. Files over the cap raise a "Escanear"
  notification (wired to `scan-file.sh`). `scan-downloads.sh` is the **forced** full scan (Settings
  button) that ignores the master toggle, the pauses and the cap — it resolves the dir and delegates
  to `scan-file.sh` (now also `nice`/`ionice`-wrapped).

  **Un `.zip` lleno de muestras daba una crítica `-t 0` por firma.** Las líneas `FOUND` se encolan y
  se vuelcan **al terminar de leer la salida de ese `clamscan`**: el lote del escaneo es el grupo
  natural, así que no hay ventana de tiempo ni retraso. Los **archivos grandes sin analizar** siguen
  el mismo tope que los ejecutables nuevos (≤4 individuales con su botón «Escanear igualmente», más
  → un resumen sin botón): el botón es **por fichero**, así que agrupar cuesta el botón, y hasta
  cuatro compensa; descomprimir un juego suelta media docena de archivos enormes de golpe, y eso son
  seis popups con botón que nadie va a pulsar uno por uno.

#### El mismo gate, en los otros cuatro monitores

`pkg_tx_activa` no es solo cosa de `monitor_files`: una actualización hace ruido en casi todos, y
**solo se silencia lo que una actualización provoca por definición**. Lo que sigue avisando durante
una actualización: OOM, errores de E/S, MCE/ECC, kernel panic, throttling, sudo/pkexec/SSH. Lo que
se descarta mientras dura la transacción (+`PKG_GRACIA`):

| Monitor | Evento silenciado | Por qué es ruido |
|---|---|---|
| `monitor_kernel` | `gpu.error`, `kernel.modulo-sin-firmar` | reemplazar el `.ko` de nvidia bajo una sesión viva escupe NVRM/`nvidia_drm` *ERROR*; dkms recompilando loguea "loading out-of-tree module" |
| `monitor_kernel` | `app.crash` (segfault) | cambiarle las `.so` a un proceso vivo lo tumba; se descarta **antes** del cooldown, para no gastarlo en un crash que no se iba a notificar |
| `monitor_system` | `servicio.fallo-arranque`, coredumps y la tormenta de crashes | las units se reinician con los binarios a medio reemplazar |
| `monitor_units` | la pasada **entera** | no se filtra el aviso: se salta el barrido sin tocar `_known`, así que una unidad que quede rota se reporta en la pasada siguiente — filtrando solo el aviso se habría sembrado como "preexistente" y no habría avisado nunca |

**La GPU necesita algo más que la ventana de la transacción, y ese es el caso que motivó todo esto.**
Al actualizar `nvidia`/`linux` los módulos del disco se reemplazan pero el cargado sigue siendo el
viejo **hasta que reinicias**: a partir de ahí cada acceso a la GPU suelta un `*ERROR*` de
`nvidia_drm`, horas después de que pacman terminara. `pkg_sesion_desincronizada` lo detecta sin
preguntarle al gestor de paquetes — `/usr/lib/modules/$(uname -r)` desaparecido (el kernel en
ejecución ya no está instalado), o `/sys/module/nvidia/version` (en ejecución) ≠ `modinfo -F version
nvidia` (en disco) — y a partir de ahí calla GPU y módulos hasta el reinicio. Una vez da positivo no
se vuelve a comprobar: sin reiniciar no puede dejar de ser cierto. **No calla en silencio**: la
primera vez emite `sistema.reinicio-pendiente` ("Reinicio pendiente", `normal`, autocierre),
que es a la vez la explicación del silencio y la acción que lo arregla.

**Apagado limpio: matar el monitor dejaba un `inotifywait -m` vivo PARA SIEMPRE.** Los seis
sub-monitores son hijos directos (`func &`) y comparten la línea de órdenes del padre, así que
`pkill -f oom-monitor.sh` —la forma documentada de relanzarlo tras editarlo, y por donde pasa
`hyprctl reload full-reset`— sí se los lleva. Sus **nietos** no: el `inotifywait -m` de
`monitor_files` no tiene `-t`, se queda bloqueado esperando eventos, lo adopta `init` y ahí sigue,
vigilando `/etc`, `/boot` y `~/.ssh` con sus watches y ~3,7 MB de RSS, sin nadie al otro lado de la
tubería. Muere solo, pero solo al **primer evento** (el SIGPIPE al escribir en una tubería sin
lector), y en `/etc` eso puede tardar días. Medido: un huérfano de 1 h 48 min de una instancia
anterior, y uno nuevo por cada ciclo de matar/relanzar. Los `journalctl -f` de
`monitor_kernel`/`monitor_system` tienen la misma forma.

Hicieron falta **tres** piezas, y se llegó a ellas en ese orden porque cada una destapó el límite de
la anterior:
1. **`trap` en el padre** (`_limpiar_al_salir` → `_matar_descendientes`, matando de abajo arriba:
   al revés el padre muere primero y al nieto ya no lo encuentra ningún `pgrep -P`).
2. **Las tres tuberías largas van en 2º plano con `wait`.** El trap por sí solo no llegaba a
   correr: **bash aplaza las señales mientras espera a un hijo en primer plano**, y esos hijos son
   un `journalctl -f` y un `inotifywait -m` que no terminan nunca. Con `{ tubería; } & wait $!` la
   espera es interrumpible y el trap se atiende al instante. Es el mismo patrón que el envoltorio
   `blocking` de `updates-monitor.sh`, que ya lo documentaba para su `inotifywait`, y el que
   `screencast-monitor.sh` resuelve con `coproc` + `exec -a`. `monitor_downloads` usa la misma idea
   con `_esperar_evento`: allí el hijo sí acaba solo, pero un SIGTERM podía quedarse pendiente hasta
   cinco minutos y durante ese rato el barrido aún podía arrancar un `clamscan` que ya no quiere
   nadie.
3. **Recogida de huérfanos, al arrancar y como ÚLTIMO paso de la limpieza.** Tampoco bastaba con
   (1)+(2): `pkill -f` casa con **todos** los niveles de bash a la vez —el principal, los seis
   sub-monitores y el subshell de cada tubería—, así que cuando el trap del padre corre, el subshell
   intermedio ya puede estar muerto y su `inotifywait` reparentado a init, fuera del alcance de
   `pgrep -P`. Un huérfano recién hecho sí es reconocible sin ambigüedad: mismo usuario, **ppid 1** y
   la línea de órdenes exacta que emitimos. Los patrones son literales a propósito: un `pgrep -f
   inotifywait` a secas se llevaría por delante el vigilante de pacman de `updates-monitor.sh`.

Verificado con tres ciclos de arrancar/`pkill`/contar: **0 huérfanos** en los tres, contra uno por
ciclo antes.

**Config**: every scanned category is gated by a boolean in `~/.config/gigishell/security.json`
(written by `ags/modulos/ajustes/seguridad/SeccionSeguridad.tsx`, absent key = enabled). The bash reads it
**once at process start** — toggling a switch in the AGS Seguridad tab only takes effect after
a reboot or manually restarting this script (the UI says so). Journal reads use `-n 0` to skip
backlog, so a fresh login doesn't re-fire notifications for old events.

**`hypr/scripts/run-untrusted.sh`** — launches a single file through scan-then-contain: ClamAV
first (`clamdscan` preferred, falls back to `clamscan` if the daemon isn't running; a positive
hit blocks the launch entirely, an inconclusive scan warns but still proceeds), then Firejail
(`--whitelist`-only home, `--noroot --nodbus --net=none`). It does **not** disinfect the file —
it contains blast radius if the file turns out to be malicious. Wired into `monitor_downloads`:
new-executable notifications carry a `notify-send -A` action button that invokes it. Requires
`firejail` (and `wine` for `.exe`/`.msi`) to actually be installed — otherwise it notifies and
refuses to launch rather than running unsandboxed.

**`hypr/scripts/scan-file.sh`** — on-demand ClamAV scan of a single path (no size cap; `clamscan -r`
so it descends into archives), notifying clean / infected / couldn't-scan. Invoked by the "Escanear"
button on the oversized-file notification and by the "Analizar un archivo con ClamAV" path field in
`ags/modulos/ajustes/seguridad/SeccionSeguridad.tsx`. Both `run-untrusted.sh` and `scan-file.sh` prefer `clamscan` and fall back
across engines, and both surface a clear "run `sudo freshclam`" hint when the signature DB is missing.

### Firmas de ClamAV desde la UI (`system/clamav/` + `servicios/seguridad/clamav.ts`)

**Sin firmas no hay antivirus, y hasta ahora el único sitio donde arreglarlo era una terminal.**
Los tres consumidores de ClamAV (el barrido de descargas, `scan-file.sh`, `run-untrusted.sh`)
detectan la base ausente y dicen "ejecuta `sudo freshclam` (o activa clamav-freshclam.service)",
pero eso llega por `notify-send` y hay que acordarse. Peor: mientras tanto el barrido **no marca
nada** (rc 2 → no se sella; ver la sección de `monitor_downloads`), así que la función queda
parada esperando a un gesto que no está en ninguna UI. Ajustes > Seguridad > Antivirus tiene ahora
la tarjeta **Base de firmas**: fecha de la última actualización, el interruptor «Mantener las firmas
al día» y un botón que actualiza **ahora**.

**Mismo esquema que TLP, y por el mismo motivo**: `/var/lib/clamav` es de `clamav`, el log de
freshclam está en `/var/log/clamav` y `systemctl enable` es de root, así que AGS no toca nada —
delega en `/usr/local/bin/gigishell-clamav-update` (root-owned, instalado por **`install.sh` paso 9**
desde `system/clamav/gigishell-clamav-update.sh`), autorizado sin contraseña por
`/etc/sudoers.d/gigishell-clamav` **solo** para dos argumentos fijos (`update` y `auto-off`: los demás verbos del helper salieron de la regla al dejar de usarse — un NOPASSWD que puede *encender* un demonio no se deja puesto por si acaso). Ni el helper ni la regla se
symlinkean: apuntar algo que corre como root al árbol escribible por el usuario sería la escalada
silenciosa contra la que avisan las secciones de USB, i2c-dev y TLP.

**«Actualizar las firmas al iniciar sesión» es un BOOLEANO, y NO QUEDA NINGÚN TEMPORIZADOR DE
ACTUALIZACIÓN DE CLAMAV EN EL SISTEMA.** Antes esa fila encendía y apagaba
`clamav-freshclam.service`: el estado vivía en systemd (había que preguntárselo con `systemctl
is-enabled` para pintar el interruptor) y la actualización ocurría **por periodo**, cada pocas
horas, hiciera falta o no, con el equipo delante o parado. Hoy el interruptor es `clamavAutoUpdate`
en `~/.config/gigishell/security.json` —activado por defecto, el mismo fichero que ya leen los
escáneres— y quien actualiza es **`hypr/scripts/actualizar-firmas.sh --auto`**, disparado desde **un
solo sitio**: `gigishell/autostart.lua`, t=40, una vez por arranque de Hyprland.

**Por qué basta con el arranque.** Una sesión de escritorio empieza casi a diario, así que las
firmas entran al día y se quedan al día durante toda la sesión; freshclam publica varias veces al
día, pero para reconocer lo que importa sirve de sobra una base de menos de 24 h. Lo que se gana es
que **durante la sesión no queda nada corriendo**: ni un reloj, ni un servicio, ni un reintento por
barrido. Un reintento a mitad de sesión sería un temporizador con otro nombre, y descargar ~200 MB
por detrás mientras el usuario trabaja es justo el trabajo de fondo que se quiere evitar.

**Ni los escáneres actualizan por su cuenta, y eso corrige una primera versión de esto mismo.** Hubo
una en la que el barrido de descargas, al ver `rc 2`, disparaba la actualización en silencio. Se
retiró: convertía un barrido de fondo en un disparador de 200 MB, y reintentarlo barrido tras
barrido —aunque fuera con antirrebote— era exactamente el periodo que se acababa de quitar. Hoy los
tres consumidores (`oom-monitor.sh`, `scan-file.sh`, `run-untrusted.sh`) solo **avisan con botón**
(`firmas_aviso_con_boton`): a mitad de sesión actualizar es un gesto del usuario, y es de un clic.

**En el arranque no se notifica NADA**, ni al empezar, ni al acabar, ni al fallar: el interruptor
promete que se hace solo. **Tres guardas antes de descargar, todas sin red ni sudo**: (1) el
booleano; (2) **antirrebote de una hora** desde el último intento —lo apunta la marca
`~/.cache/gigishell/firmas-auto` (`<epoch> <rc>`)—, que es lo que impide que un `hyprctl reload
full-reset`, que vuelve a ejecutar el autostart, reintente la descarga en cada recarga cuando el
arranque anterior falló; y (3) la **edad de la base**: `daily.{cld,cvd}` con menos de 24 h no se
toca, así que arrancar la sesión cinco veces en un día no descarga cinco veces. Cuando no toca, el
script sale en **~4 ms** (un `jq` y un `stat`) y no deja nada vivo.

**Qué se sigue leyendo del sistema y qué no.** El interruptor es nuestro, así que su estado siempre
se conoce y la fila se pinta salvo que **falte el helper root** — sin él ni el botón ni la
actualización del arranque pueden funcionar, y un interruptor que no aplica nada es peor que su
ausencia (ahí el texto dice qué instalar). Lo que se sigue preguntando al sistema es lo que solo el
sistema sabe: la **fecha** de la base (mtime de `/var/lib/clamav/daily.*`) y si el **servicio
periódico** heredado sigue vivo (`systemctl is-enabled`). Ese segundo dato solo se pinta cuando vale
`true`; `null` (no se pudo consultar) no afirma nada, mismo criterio que `teclaCedidaAHyprland`.
**Y AGS tampoco sondea**: `refreshClamavState()` se llama al montar la tarjeta y tras una orden del
helper — no hay `setInterval` ni `Gio.FileMonitor` en `servicios/seguridad/clamav.ts`. Si algún día
aparece uno, será el primer temporizador de ClamAV del sistema y hay que justificarlo ahí.

**El helper conserva `update-enable`, `auto-on` y `auto-off` aunque el interruptor ya no los use.**
`auto-off` sigue teniendo un consumidor: si `clamav-freshclam` se quedó habilitado de la etapa
anterior (o lo enciende una reinstalación del paquete), `refreshClamavState` lo detecta y lo **apaga
una vez, en silencio** — si no, volvería a haber un actualizador periódico, y encima invisible. Los
otros dos verbos se quedan por compatibilidad con instalaciones a medio migrar y porque la regla
sudoers ya los autoriza; el botón "Actualizar ahora" y el del popup usan los dos `update` a secas.
`install.sh` **ya no habilita el servicio**: descarga las firmas una vez con el helper y deja el
resto al booleano.

**El helper PARA el servicio antes de actualizar, y no es un capricho.** `clamav-freshclam` mantiene
`freshclam.log` bloqueado, así que un `freshclam` suelto con el demonio vivo aborta con *"locked by
another process"*. La alternativa obvia —`systemctl restart clamav-freshclam`— actualiza pero es
**asíncrona**: no deja ni código de salida ni salida que enseñarle al usuario, o sea que el botón no
podría distinguir "actualizado" de "sigue sin firmas". Se para, se actualiza en primer plano y se
vuelve a dejar como estaba. La ventana sin demonio son segundos. Sigue haciendo falta aunque el
servicio ya no sea el actualizador: puede seguir corriendo de una instalación anterior, y un
`freshclam` suelto con él vivo aborta.

**Leer el estado NO pasa por el helper ni por sudo**: la fecha sale del `mtime` de
`/var/lib/clamav/daily.{cld,cvd}` (world-readable) y el "se actualiza solo" de `systemctl
is-enabled`, que cualquiera puede consultar. Preguntarle al sistema es lo único que no puede mentir
— el helper puede estar instalado y el servicio apagado a mano, igual que con `HandlePowerKey` en
la sección del botón de encendido. `clamavAutoUpdate` es `boolean | null` por lo mismo: `null` = no
se pudo consultar, y **no** se afirma nada en la UI.

**Sin el helper la tarjeta SE SIGUE PINTANDO, y ahí se aparta del selector TLP a propósito.**
La primera versión la ocultaba entera copiando aquel criterio, y estaba mal: en TLP "falta TLP"
significa *esta función no aplica a esta máquina* y esconderla es correcto; aquí significa *te falta
un paso de instalación*, así que ocultarla reproduce **el problema exacto que la tarjeta viene a
resolver** — un arreglo que existe pero que no hay dónde encontrar (reportado en vivo: "no veo los
ajustes"). Con `clamavHelperInstalled` en falso se enseña el estado igual y el botón cede el sitio a
la orden que hay que ejecutar una vez. Lo único que la hace desaparecer es `clamavPresent`: sin
ClamAV no hay firmas de las que hablar.

**El aviso de "no puedo analizar" lleva BOTÓN, y ese es el punto**: es el único fallo de esta
familia con una cura de un solo gesto, y un popup que dice "ejecuta `sudo freshclam`" y se va en un
minuto le pide al usuario que se acuerde de algo cuando ya esté en una terminal. Las tres
notificaciones que lo reportan —el `rc == 2` del barrido de descargas (`oom-monitor.sh`), y el "no
se pudo analizar" de `scan-file.sh` y `run-untrusted.sh`— llevan ahora
`-A "update=Actualizar firmas"` → **`hypr/scripts/actualizar-firmas.sh`**, el lado de usuario
del helper. Se pulsa con **clic derecho** sobre el popup (ver `ags/CLAUDE.md`, "Acciones D-Bus en el
popup"), y `calcularDuracionPopup()` lo acota a 60 s.

**Ese aviso lo emite ahora `firmas_aviso_con_boton` (`lib/firmas.sh`) y lleva TECHO DE ESPERA, que es
lo que le faltaba.** `notify-send --wait` no espera al popup: espera a que el **daemon** cierre la
notificación, y con `-t 0` el daemon no la cierra nunca. O sea que a los 60 s el popup desaparecía
—y con él la única forma de pulsar el botón, porque estas notificaciones no llegan al historial (ver
el "peaje conocido" de `ags/CLAUDE.md`)— y el `notify-send` se quedaba colgado **hasta el fin de la
sesión** esperando un clic ya imposible: un proceso zombi por arranque, invisible y para siempre.
Ahora se manda con `-t 60000` (que el daemon y el popup caduquen a la vez) y un vigilante mata el
`notify-send` a los 120 s. El `timeout` **no puede envolver la llamada**, porque `notificar` es una
función de shell y no un binario: un `timeout bash -c` perdería la función y el aviso saldría sin
identidad (sin `x-gigishell-event`, o sea inconfigurable desde Ajustes).

**Por qué un script y no llamar al helper desde el `-A`**: hace falta algo que **notifique el
resultado** —el helper solo imprime por stdout, y de una acción de `notify-send` no lee nadie— y que
no se pueda lanzar dos veces a la vez (`flock -n`: freshclam descarga ~200 MB, y dos clics serían
dos descargas peleándose por el mismo lock del log). El botón de Ajustes **no** pasa por él: AGS
llama al helper directo porque ya tiene su `clamavBusy` y sus propias notificaciones. Sin la regla
sudoers, `sudo -n` falla en el acto y el script traduce el error a "ejecuta `install.sh`" en vez de
enseñar el mensaje crudo de sudo — colgarse pidiendo contraseña sería lo peor de todo, porque esto
sale de un clic en un popup y no hay terminal donde teclearla.

**En `oom-monitor.sh` el `--wait -A` va en subshell de fondo, y no es opcional**: bloquea hasta el
clic o el cierre, así que en primer plano detendría el barrido entero hasta que alguien mirase el
popup (mismo motivo que en `download_alert`). En `run-untrusted.sh` también, y ahí por otra razón:
el usuario ha pedido **lanzar** algo y esperar a que mire el popup retrasaría el lanzamiento. En
`scan-file.sh` sí va en primer plano — su trabajo ya terminó cuando notifica.

**Al arreglar las firmas, lo ya sellado en falso NO se reevalúa solo.** Es la secuela documentada en
`monitor_downloads`: si el barrido llegó a correr con la base vacía *antes* del arreglo de `rc == 2`,
esos ficheros quedaron marcados como analizados **para siempre**. Hay que borrar **los dos** ficheros
de caché (`~/.cache/gigishell/download-index` **y** `download-hashes`) y relanzar `oom-monitor.sh`
(`pkill` + `setsid nohup`), porque el índice y el conjunto de hashes se cargan en RAM al arrancar el
script: borrarlos en caliente no sirve de nada.

### Desinstalar apps desde Orion (`desinstalar-app.sh`)

El panel derecho de Orion —el que se despliega al pulsar una app— tiene una acción **Desinstalar**
además de Abrir / Editar config / Fijar en inicio. La ejecuta `hypr/scripts/desinstalar-app.sh`, con
dos verbos que reciben **los mismos argumentos**: `detectar` (solo consulta, devuelve JSON) y
`desinstalar` (hace el trabajo). Los dos detectan por su cuenta, así que `desinstalar` no depende de
que nadie haya llamado antes a `detectar`.

**Se desinstala DE UN CLIC: no hay pantalla de confirmación, y `detectar` NO lo usa la UI.** Hubo una
—con el método, el paquete y la lista completa de lo que `-Rs` se llevaría— y se quitó a petición del
usuario. El razonamiento por el que se acepta: **la confirmación es el propio diálogo de contraseña
de polkit**, que no se puede saltar, sale con el nombre del comando y hay que atender de todas
formas; una pantalla previa era un segundo "¿seguro?" delante de otro que ya existe. `detectar` se
conserva como entrada de **diagnóstico** — es la forma de responder «¿por qué eligió este método?» o
«¿qué se llevaría por delante?» sin borrar nada, y es con lo que se prueban los cinco caminos.
Peaje asumido y explícito: en los métodos que **no** pasan por pkexec (Flatpak de usuario, Steam,
y el borrado manual **dentro de `$HOME`**) no hay ninguna confirmación de por medio — el clic borra.

**Es FAIL-SAFE, al revés que casi todo el repo.** El resto de scripts de GiGiShell son fail-open —ante
la duda, hacen el trabajo—. Aquí toda ambigüedad termina en "no se desinstala nada" con el motivo
escrito, porque el fallo silencioso de esto sería borrar software que nadie pidió borrar. Lo mismo en
el lado TS: `interpretarSalida` trata como `error` **todo lo que no sea exactamente `ok` o
`cancelado`** — dar por buena una salida que no se entiende borraría el favorito de una app que quizá
sigue instalada.

**pkexec, no `sudo` ni `paru`/`yay`, y los tres motivos son distintos.** Esto sale de un clic en una
interfaz gráfica: no hay terminal donde teclear nada, así que `sudo` se colgaría en un stdin
inexistente. `pkexec` es lo que abre el diálogo (hyprpolkitagent, ya lanzado desde
`gigishell/autostart.lua`) y su acción por defecto es `auth_admin` — pide la contraseña del usuario
porque está en `wheel`, y **no la recuerda**: cada desinstalación la vuelve a pedir, que es lo
correcto para algo irreversible. Los helpers del AUR **no sirven de ejecutores** aunque estén
instalados: se niegan a correr como root y por dentro llaman a `sudo`, el mismo callejón sin salida.
Y tampoco hacen falta — **`pacman -Rns` borra igual un paquete del AUR que uno de los repos**; el
helper solo interviene en la *instalación*. Se detectan para dos cosas reales: etiquetar el paquete
como AUR en la UI y **limpiar su clon en la caché** (`~/.cache/{paru,yay}/clone/<pkg>`), que pacman no
conoce y se quedaría ocupando disco.

**Cinco métodos, y el ORDEN de detección es lo que evita el peor fallo.** Steam y Flatpak van
**antes** que pacman porque sus `.desktop` viven en `~/.local/share/applications` y no los posee
ningún paquete: al revés caerían en la rama "manual" y se ofrecería borrar el **acceso directo**,
dejando el juego de 80 GB en disco y al usuario convencido de haberlo desinstalado.

1. **Steam** (`steam://rungameid/N`) → `steam steam://uninstall/N`. Steam no tiene desinstalación no
   interactiva: abre su propio diálogo, y por eso el botón dice "Abrir Steam" y se avisa — si no, esa
   ventana parecería llegar de la nada.
2. **Flatpak** (`flatpak run …`) → `flatpak uninstall -y --delete-data`. Escala solo por polkit si el
   runtime es de sistema.
3. **pacman** → `pacman -Qoq` **primero sobre el `.desktop`** y solo si no lo posee nadie, sobre el
   binario: el `Exec` puede ser un envoltorio (`sh -c`, `env`) y resolvería al intérprete. Se
   distingue AUR con `pacman -Qmq`.
4. **Manual** (curl \| sh, AppImage, tarball): nadie lo posee. Se listan **solo ficheros concretos,
   nunca directorios** —un `rm -rf` sobre un directorio adivinado convierte esta función en una
   pérdida de datos—: el binario, su destino si es symlink (donde vive lo que instalan los scripts de
   curl) y el `.desktop` **solo si es del usuario**. Root únicamente si algo cae fuera de `$HOME`.
5. **Desconocido** → no se ofrece nada, con el motivo escrito.

**El desenlace viaja por STDOUT (`ok`/`externo`/`cancelado`/`error`) con rc=0**, no en el código de
salida. `execAsync` rechaza con el **stderr** ante cualquier rc≠0, así que codificarlo ahí dejaba "el
usuario cerró el diálogo de contraseña" indistinguible de un fallo real. Los rc≠0 quedan para lo que
ni siquiera llegó a intentarse (uso incorrecto, sin `jq`). Solo un `ok` borra el favorito y tira la
caché del catálogo.

**`externo` es el desenlace de Steam y NO puede colapsarse a `ok`.** Ahí no se ha desinstalado nada
todavía: el juego sigue instalado hasta que el usuario confirme en la ventana de Steam, y de eso no
nos vamos a enterar nunca. Tratarlo como éxito hacía dos cosas mal a la vez — borrar el favorito de
un juego que quizá sigue ahí, y **hacer reaparecer Orion justo encima del diálogo de Steam**, que es
el mismo problema de capas que motiva todo lo de abajo.

**El script es el ÚNICO que notifica el resultado**, y tiene que serlo: `pkexec` puede tardar lo que
tarde el usuario en teclear la contraseña, y para entonces Orion lleva rato cerrado. La excepción es
"falta el script", donde AGS notifica por su cuenta — si no, con Orion ya cerrado el usuario se
quedaría mirando un escritorio en el que no ha pasado absolutamente nada.

**Un rc≠0 de `pacman -Rs --print` NO es un fallo del script: es la respuesta.** Significa que otro
paquete depende de este, y su texto es la explicación que hay que enseñar. Sale por **stdout**, no
por stderr (medido). Se recorta a cuatro líneas más un contador: pacman emite una por cada
dependiente, y con algo como `glibc` son **68 KB** de texto idéntico que ni la UI pinta ni nadie lee.

**`-Rs` arrastra las dependencias que quedan huérfanas**, así que desinstalar `kitty` se lleva cuatro
paquetes. Sin pantalla de confirmación eso ya no se ve **antes**, solo después: la notificación de
éxito dice cuántos se quitaron, y `detectar` sigue siendo la forma de mirarlo de antemano.

**`CRITICOS` sigue existiendo aunque su aviso ya no tenga dónde pintarse.** pacman se niega solo
cuando algo depende del paquete, pero varios de los que dejan la sesión inutilizable son **hojas** del
grafo (`hyprland`, `sddm`, el propio shell) y saldrían sin una sola queja. Hoy el campo `aviso` solo
lo devuelve `detectar`; si algún día vuelve a haber UI previa, ese es el dato que tiene que pintar en
ámbar. **No conviertas la lista en un bloqueo**: el usuario manda.

**AGS APARTA ORION ANTES DE LANZAR NADA, y no es cortesía.** El diálogo de contraseña de polkit es
una ventana normal y Orion es una layer-shell **`OVERLAY`**, capa que va por encima de **todas** las
ventanas normales por definición del protocolo; encima Orion tiene keymode `ON_DEMAND`, o sea que
también pelea por el teclado. Con Orion en pantalla el diálogo salía **debajo** y había que cerrarlo
a mano para poder escribir. Y no basta con llamar a `hidePanel()` primero: la salida son ~280 ms de
animación más un par de frames antes de que la superficie se desmapee, así que
`data/uninstall.ts` **sondea el estado real de la ventana** (`app.get_windows()`, nombre `orion` +
`visible`) en vez de dormir una constante copiada de `Orion.tsx`, que se habría desincronizado en
silencio la primera vez que alguien la retocara. Con techo de ~1 s: si la animación se atasca se
sigue adelante, porque lo peor que pasa entonces es el comportamiento de antes.

**Y se APARTA, no se cierra: al terminar Orion vuelve donde estaba.** Un `hidePanel()` es una salida
de verdad —vacía búsqueda y resultados, y devuelve la sección a Inicio salvo con
`orionRecordarUltimaSeccion` activado—, y aquí el usuario no ha pedido salir de ningún sitio: se le
estaba quitando la vista por un motivo puramente técnico, así que perderle el sitio es un efecto
colateral, no una decisión. `suspenderPanel()`/`reanudarPanel()` (`ags/modulos/orion/state.ts`)
guardan una foto, cierran sin limpiar y la reponen. Ver `ags/CLAUDE.md` para las tres reglas que
tiene: qué pasa si el usuario reabre Orion por su cuenta, por qué la ficha del panel derecho solo se
suelta tras un `ok`, y por qué `externo` **descarta** la foto en vez de olvidarla.

**Cada desinstalación pasa por pkexec, y `oom-monitor.sh` NO avisa de ello.** `pkexec` loguea su
`COMMAND=`, y desde que esa rama calla todo pkexec autenticado con contraseña (ver la sección de
`monitor_system` → `privEsc`), una desinstalación no genera «Escalada de privilegios»: el usuario
acaba de autorizarla a mano, así que no hay nada que señalar.

### Almacenamiento y autolimpieza (`analizar-almacenamiento.sh`, `limpiar-almacenamiento.sh`, `limpieza-arranque.sh` + `system/limpieza/`)

Ajustes > **Almacenamiento** (qué ocupa el disco, catálogo de apps por tamaño) y **Liberar espacio**
(limpiezas manuales y autolimpieza). Cuatro piezas, y están separadas a propósito:

| Pieza | Qué hace | Privilegio |
| --- | --- | --- |
| `analizar-almacenamiento.sh` | mide y emite JSON. **No borra nada.** | usuario (+ `sudo -n` solo para contar instantáneas) |
| `limpiar-almacenamiento.sh` | ejecuta una o varias acciones, emite JSON con lo liberado | mezcla, ver abajo |
| `limpieza-arranque.sh` | comprobación de un disparo al iniciar sesión: decide si toca | ninguno propio |
| `system/limpieza/gigishell-limpieza.sh` | la parte de root, root-owned + sudoers NOPASSWD | root |
| `hypr/scripts/lib/limpieza-rutas.sh` | **la lista única de qué borra cada acción**; la sourcean el analizador y el limpiador | (se sourcea) |

**Un solo volcado de paquetes para todo el análisis, y lo produce `expac`.** El inventario lo piden
tres consumidores —el total instalado, los huérfanos y el catálogo de aplicaciones— y antes cada uno
lanzaba su propio `pacman -Qi`: sobre 1632 paquetes son **~285 ms cada vez**, o sea casi 0,6 s del
análisis gastados en volver a preguntar lo mismo. Primero se pasó a volcar `pacman -Qi` una sola vez
a un temporal (**1,03 s → 0,72 s de CPU**); hoy ese volcado lo genera **`expac -Q '%n\t%m\t%w\t%l\t%d'`**,
que cuesta **~18 ms** —quince veces menos— porque lee la base de datos local y emite solo los cinco
campos pedidos, en vez de formatear veinte por paquete para que awk descarte quince.

El formato del volcado es **TSV, una línea por paquete**: `nombre · bytes · explicit|dependency ·
fecha · descripción`. Los bytes llegan **ya en bytes** (`%m`); el volcado de `pacman -Qi` los daba
formateados (`"12,34 MiB"`) y cada consumidor tenía que deshacer la unidad —trabajo, y un redondeo a
dos decimales sumado 1600 veces—. `pacman -Qi` **sigue como respaldo** (expac es un paquete aparte,
no viene con pacman) y produce el mismo TSV, así que la conversión de unidades vive solo ahí y nada
aguas abajo sabe de dónde salió el volcado. Con el TSV, los huérfanos se filtran **dentro de awk**
contra un conjunto en vez de con `pacman -Qi -- pkg…`, la cuenta de paquetes es un `wc -l` y el
catálogo de apps es un `print` de columnas en vez de una máquina de estados sobre bloques.

Medido en este equipo (1619 paquetes, caché caliente), verbo `todo`: **0,74 s → 0,41 s de reloj y
1,02 s → 0,67 s de CPU**, con salida equivalente —las cifras de expac son *más* exactas: 120 KB de
diferencia sobre 21 GB, que es el redondeo que `pacman -Qi` introducía—. Lo que queda del coste ya
no es el inventario sino `pacman -Qmq` (~245 ms, AUR), `pacman -Qtdq` (~170 ms, huérfanos) y
`paccache` en simulación (~146 ms), que corren en paralelo entre los tres sondeos.

Un aviso al tocar el respaldo: `pacman -Qi` sale traducido, y todo este parseo depende del
`export LC_ALL=C` de la cabecera del script. Sin él el awk no casa ni un campo y el volcado sale
**vacío** —sin error—, con `paquetes`/`huerfanos` en `null` y `apps` en lista vacía.

El volcado se genera **antes** de forkear los tres sondeos paralelos del verbo `todo`: una variable asignada dentro de un subshell no vuelve al padre, así que con creación
perezosa habrían seguido siendo tres invocaciones, solo que simultáneas — la misma CPU con mejor
pinta en el reloj de pared. Su `trap` de borrado se **encadena** con el de los tres temporales de
salida: un `trap` nuevo sustituye al anterior, y sin eso el volcado se quedaba en `/tmp`.

**La creación perezosa dejaba ROTOS los verbos `categorias` y `apps`, y nadie lo vio porque la UI
usa `todo`.** El volcado se creaba desde `$(_volcado_qi)`, o sea dentro de una **sustitución de
órdenes**: el subshell creaba el temporal *y su propio `trap EXIT`*, y ese trap lo borraba al
terminar la sustitución — justo antes de que el padre fuera a leerlo. La salida era literal:

```
$ analizar-almacenamiento.sh categorias
grep: /tmp/gigishell-qi.OjK6sR: No such file or directory
awk: fatal: cannot open file `/tmp/gigishell-qi.M5T47Z' for reading
```

con `paquetes` y `huerfanos` en `bytes: null` (la sección los pintaba «—») y `apps` devolviendo una
lista **vacía**. El verbo `todo` se salvaba por casualidad: ya llamaba al volcado desde el padre por
otro motivo. Hoy la creación es explícita (`_preparar_qi`, siempre desde el padre) y `_volcado_qi`
solo imprime la ruta — una función que únicamente imprime es segura dentro de `$( )`.

**El análisis se cachea en `~/.cache/gigishell/almacenamiento.json` y por eso la sección se pinta llena
en el primer frame**, igual que Ajustes > Sistema: recorrer `~/.cache`, `/var/cache/pacman` y el hogar
con `du` cuesta ~1,4 s con caché de inodos caliente y decenas de segundos en frío. Cada `du` corre
bajo `timeout` (20 s por defecto) y lo que no llega sale como **`bytes: null`**, que la UI pinta como
`—`. **`null` y `0` NO son lo mismo y no deben unificarse**: una carpeta sin permisos de lectura
pintada como `0 B` hace creer que ya está limpio lo que pueden ser 40 GB.

**`df` lista los subvolúmenes btrfs como discos distintos, con cifras idénticas.** En esta
instalación de CachyOS, `/`, `/home`, `/root`, `/srv`, `/var/cache`, `/var/log` y `/var/tmp` son
subvolúmenes del **mismo** `/dev/nvme0n1p3`: la sección enseñaba siete discos de 1 TB, como si
hubiera siete. Se deduplica por **dispositivo**, quedándose con el punto de montaje más corto (`/`).
`disk-monitor.sh` ya hacía lo mismo (`declare -A seen  # device -> 1, to dedup btrfs subvolumes`):
es el mismo problema resuelto dos veces porque las dos piezas leen `df` por su cuenta.

**El color de la barra NO usa los umbrales de `disk-monitor.sh`.** La barra corta en 75/90 % de
*uso*; el monitor avisa por espacio libre **absoluto** (menos de 5 GiB). Que no coincidan es
correcto: un 10 % libre son 100 GB en un disco de 1 TB y 5 GB en uno de 50. El color es una pista
de lectura del reparto, la notificación es la alarma. **Y sí, la alarma también la dispara esta
sección**: el mismo `df` que pinta la barra pasa por `servicios/disco/alerta.ts` (ver
`disk-monitor.sh` en «Monitores de recursos restantes»), que es lo que extiende el aviso a toda la
sesión sin añadir ningún sondeo. Lo que NO comparten es el criterio: el color sigue siendo el
porcentaje, el aviso sigue siendo el espacio absoluto.

**Contar instantáneas es de root, y snapper miente con rc=0.** `snapper --machine-readable csv list`
sin privilegios responde «Sin permisos» y **sale con 0**, así que el `grep -c` daba 0 y la fila
desaparecía como si el equipo no tuviera instantáneas; `btrfs subvolume list /` al menos falla con
rc≠0. Por eso la cuenta sale del helper root (`gigishell-limpieza instantaneas`) vía `sudo -n`, y sin
helper instalado **la fila no se enseña** en vez de afirmar que hay cero. El *tamaño* de las
instantáneas no se da y no es un olvido: el espacio exclusivo de un snapshot solo lo sabe
`btrfs qgroup show` (qgroups + root), y sumar sus `du` daría una cifra enorme y falsa —todo lo
compartido contado una vez por snapshot—.

**Tres niveles de privilegio, y de ahí sale qué se puede automatizar:**

1. **usuario** — todo lo que vive bajo `$HOME` (cachés, miniaturas, papelera, descargas, flatpak).
2. **`sudo -n` al helper** — lo de root que **se regenera solo**: caché de pacman (`paccache -rk1`
   + `-ruk0`), journal (`--vacuum-size`), `/var/tmp`, huérfanos (`pacman -Rns $(pacman -Qtdq)`).
   El NOPASSWD es lo que permite la autolimpieza desatendida.
3. **`pkexec`** — lo irreversible: vaciar la caché **entera** (`pacman -Scc`), que deja el equipo sin
   poder revertir una actualización sin red. **Nunca automatizable**, y esa invariante está probada
   (`servicios/disco/catalogo.test.ts`): si alguien añade una acción de pkexec, la prueba la impide
   entrar en el lote desatendido. Un diálogo de contraseña que aparece solo, de madrugada, no lo lee
   nadie — se aprende a darle a Enter sin mirar, que es peor que no tenerlo.

**«Borrar lo que yo elija» (`rutasPersonalizadas`) es la única acción cuyo objetivo NO lo decide este
repositorio**, y por eso es la única con un filtro. Acepta carpetas y ficheros, y los trata distinto
porque lo contrario sorprende:

- **Carpeta** → se borra su **contenido** y la carpeta sobrevive. Igual que en miniaturas: hay
  aplicaciones que no recrean su directorio de trabajo y dejan de funcionar hasta el siguiente
  login. Y deja el error reversible en el sentido que importa — lo que configuraste sigue ahí.
- **Fichero** → se borra él mismo, que es lo que espera cualquiera que escriba la ruta de un
  fichero.

El reparto lo hace `objetivos_de_ruta` (en la lib), **compartido con el analizador**: si cada script
expandiera la ruta por su cuenta volveríamos al problema de origen de toda esta sección — dos ideas
distintas de qué se borra y una cifra que no describe nada. Nada de esto pasa por la papelera.

El filtro es `ruta_personalizada_valida`, en `lib/limpieza-rutas.sh`, y **vive ahí y no en la UI a
propósito**: el JSON se puede editar a mano, restaurar de un backup viejo o venir de otro equipo
donde esa ruta significaba otra cosa. Quien borra es quien valida. Ajustes llama al **mismo** filtro
con `limpiar-almacenamiento.sh --validar-ruta` para dar el error al momento; dos implementaciones
—una en TypeScript para avisar y otra en bash para borrar— acabarían discrepando, y discrepar aquí
significa borrar algo que la interfaz había dado por rechazado.

Qué rechaza, y por qué cada cosa:

- **No canónica** → se resuelve con `realpath -m` **antes** de comparar. Sin eso, un `~/basura` que
  en realidad es un symlink a `/` pasa cualquier comprobación textual y `rm -rf` sigue el enlace
  igual. Está probado con ese caso exacto.
- **Protegidas**: `/`, `$HOME`, `~/.config`, `~/.local`(+`share`/`state`), `~/.cache`, `~/.ssh`,
  `~/.gnupg`, `~/.dotfiles`, `~/.mozilla`, `/home`, `/root` y los directorios raíz del sistema. No
  es una lista de «cosas de root» —como usuario no podrías borrarlas— sino de directorios cuyo
  **contenido es la configuración o la identidad de la sesión**, donde el vaciado no se nota hasta
  el siguiente arranque y ya no hay vuelta atrás.
- **Ancestro de `$HOME`** por prefijo, además de la lista, para cubrir un hogar fuera de `/home`.
- **Relativa, inexistente, o ni carpeta ni fichero regular.** Un socket, una FIFO o un nodo de
  dispositivo bajo `$HOME` se rechazan explícitamente en vez de dejar que `rm` haga algo raro con
  ellos: nadie los configura a mano aquí, y un error claro vale más que un borrado sorprendente.

Lo rechazado **no se ignora en silencio**: viaja en el `mensaje` del resultado. Una ruta que dejó de
existir tiene que decirlo, porque «limpieza correcta, 0 bytes» es indistinguible de «no había nada
que borrar». Y sin ninguna ruta válida el estado es `omitida`, no `ok`: no se ha hecho nada de lo
que se pedía.

**Es automatizable**, o sea que puede correr desatendida desde `limpieza-arranque.sh` — que es el
motivo de que el filtro exista. Su casilla nace apagada como todas, y en el catálogo va marcada
`peligrosa`.

**La otra mitad: `rutasProtegidas`, lo que NINGUNA limpieza toca.** Misma pantalla, lista aparte,
verbo contrario. Existe porque `CACHE_PRESERVADO` la decide este repositorio y cada equipo tiene su
carpeta que técnicamente es caché pero cuesta cara de perder (el perfil de un navegador que guarda
la sesión bajo `~/.cache`, la caché de compilación del proyecto de esta semana). Sin ella, salvarla
obligaba a **desmarcar la acción entera** y no limpiar nada.

Tres reglas, y la tercera es la que la hace útil (`filtrar_protegidos`, en la lib):

1. El objetivo **es** una ruta protegida, o está **dentro** de ella → no se toca.
2. No tiene nada que ver → se borra como siempre.
3. El objetivo **contiene** una ruta protegida (proteges `~/.cache/foo/perfil` y la limpieza iba a
   llevarse `~/.cache/foo` entero) → **no se salta el objetivo: se desciende un nivel** y se vuelve
   a filtrar. Se borra todo lo de dentro menos lo protegido. Saltarse el objetivo entero «por si
   acaso» habría convertido proteger un fichero de 4 KB en no limpiar el gigabyte que lo rodea.

Se aplica en **`_borrar_medido` y `_vaciar`**, o sea el punto por el que pasa todo lo que borra el
propio script: cachés de usuario, miniaturas, papelera, descargas y las rutas personalizadas.
**Lo que borra un tercero NO puede respetarla** —`paccache`, `paru -Sc`, `npm cache clean`,
`pip cache purge`, `flatpak uninstall`, el helper root— porque esas herramientas no aceptan
exclusiones; está dicho en la UI, porque una protección que no protege es peor que no tenerla.

El filtro es mucho más flojo que el de las rutas a borrar, y a propósito: aquí el error posible es
**proteger de más**, que como mucho deja algo sin limpiar. Solo se rechazan la ruta vacía, la
relativa y `/` (protegerlo entero no protege nada: significaría no limpiar). **No se exige que
exista** — proteger una carpeta que una aplicación aún no ha creado, o que está en un disco externo
desconectado, tiene que seguir valiendo cuando aparezca. Lo que sí es obligatorio es
**canonicalizar** (`--validar-protegida` lo hace antes de guardar): la comparación que decide si algo
se salva es **textual**, así que `~/x/../x` no casaría con nada. Las protegidas se **podan** al
leerlas (fuera duplicados y descendientes de otra), porque el analizador las mide con `du` para
descontarlas y una anidada se contaría dos veces.

Añadir una ruta a las dos listas a la vez no es una configuración, es un descuido, y **gana la
protección**: `ruta_personalizada_valida` rechaza la ruta con ese motivo en vez de dejarla en la
lista sin borrar nunca nada, y la UI la retira de la lista de borrar al protegerla.

**El analizador descuenta lo protegido de `liberable`, nunca de `bytes`** (lo protegido sigue
ocupando disco y tiene que seguir saliendo en el desglose, que es donde se ve dónde está el
espacio). En `rutasPersonalizadas` la paridad es exacta —se aplica el mismo `filtrar_protegidos`
sobre la misma lista— y en `cacheUsuario`, `miniaturas` y `cacheDesarrollo` se resta con `du`. En
**papelera y descargas** el descuento puede quedarse **corto por abajo** con un filtro de días: se
resta todo lo protegido que haya dentro aunque parte no fuera a borrarse todavía por no ser lo
bastante antiguo. Es la dirección segura del error —prometer de menos, nunca de más— y el caso es
raro de por sí. Verificado de punta a punta en un `$HOME` de juguete: caché de 650 KB con 200 KB
protegidos dentro de una carpeta que sí se limpia → el analizador promete 400 KB, el limpiador
libera 400 KB y el fichero protegido sigue ahí.

**«Limpiar descargas antiguas» BORRA; mandar a la papelera es opcional y va apagado.** Antes usaba
`gio trash` siempre, y eso hacía que la cifra mintiera: la papelera vive en el **mismo sistema de
ficheros**, así que mover 5 GB ahí no libera un solo byte de disco —solo cambia de carpeta— mientras
la acción informaba de «5 GB liberados». Un botón bajo el rótulo «Liberar espacio» que no liberaba
espacio hasta que además vaciabas la papelera.

El interruptor **`descargasAPapelera`** (Ajustes > Liberar espacio, justo debajo de los días)
devuelve el comportamiento antiguo para quien quiera la red de seguridad, y entonces la contabilidad
es honesta al revés: la acción termina en `ok` con **`liberado: 0`** y un `mensaje` que dice cuánto
ha movido, y el analizador da **`liberable: 0`** para esa categoría. El espacio lo liberará «Vaciar
papelera», que tiene su propia fila y su propia cifra; contarlo en las dos sería prometer el mismo
hueco dos veces. La clave se lee con `has()` y no con `//`, porque en jq el `//` considera falsy a
`false` y con el interruptor apagado devolvería el valor por defecto (mismo fallo que ya documenta
`limpieza-arranque.sh` para `notificar`).

Consecuencia en la UI: `textoResultado` enseña el `mensaje` cuando un `ok` lo trae. Sin esa rama, la
fila decía «No había nada que liberar» justo después de mover 5 GB. Y `_legible` (bash) tiene que
dar el mismo formato que `formatearBytes` (TypeScript) —`3,9 MiB`: unidades binarias con la `i`,
espacio y coma decimal—, porque las dos cifras acaban una al lado de la otra en la misma sección.
`--to=iec` no vale: cuenta en 1024 pero rotula `MB`.

**El borrado enumera primero y mide UNA vez, en vez de recorrer el directorio dos veces.** El patrón
original de cada acción era `antes=$(du dir); …borrar…; liberado=$((antes - $(du dir)))`. Tenía dos
costes y un defecto:

- **Dos travesías completas del directorio**, incluida la parte que nunca se toca: en `cacheUsuario`
  eso son `~/.cache/nvidia` (1 GB) y `~/.cache/yay` (557 MB) recorridos dos veces para nada, y en
  `descargas` la carpeta entera —que puede tener decenas de GB— para averiguar cuánto pesaban cuatro
  ficheros viejos. Con la caché de inodos caliente son 9 ms y da igual; esto corre en el **arranque
  de sesión**, con la caché fría, que es donde `du` cuesta segundos.
- **Un fork por ruta dentro de `_tam`** (un `du` *y* un `awk` cada una): dieciséis procesos para
  sumar los cuatro directorios de `cacheDesarrollo`.
- **La resta iba sobre un blanco móvil**: entre las dos pasadas el navegador reescribe su caché, así
  que podía salir negativa y había que recortarla a 0.

Hoy `_borrar_medido` enumera lo que se va a borrar, lo mide una sola vez, lo borra y descuenta lo que
haya sobrevivido —comprobación que normalmente no recorre nada, porque no sobrevive nada—. No puede
salir negativa. Se sigue midiendo antes y después **solo** en las cuatro acciones donde borra un
tercero y no hay lista que enumerar: `paru -Sc`, `npm cache clean`/`pip cache purge`, `pacman -Scc` y
`flatpak uninstall --unused`.

**El vaciado de la papelera por antigüedad forkeaba una vez por elemento.** Un `while read` con un
`basename` **y** un `rm` dentro: con 2000 elementos, cuatro mil procesos para borrar dos mil cosas.
Hoy un único `find -printf '%p\0…/info/%f.trashinfo\0'` emite ya el par (fichero, `.trashinfo`) sin
`basename` —`%f` es el nombre a secas— y el borrado va por `xargs -0`, que además trocea solo y no se
pasa de `ARG_MAX`. Medido sobre una papelera de 2000 elementos, con resultado idéntico:

```
antes   1757 ms   415 procesos externos
ahora    112 ms    17 procesos externos
```

**De paso se arregló que `cacheUsuario` borrara el DIRECTORIO `~/.cache/thumbnails`, no su
contenido.** Su `find … -exec rm -rf` operaba sobre las entradas de primer nivel, así que se llevaba
la carpeta entera — exactamente el fallo contra el que avisa el comentario de `_vaciar` (sin ese
directorio, GTK deja de generar miniaturas hasta el siguiente login). Ya no aplica porque
`thumbnails` está en la lista de preservados, pero la enumeración por entradas hace que el caso ni
se pueda volver a dar.

**Las preferencias se leen con UN `jq`, no con uno por clave.** Eran tres procesos (~10 ms cada uno)
pagados siempre, también al ejecutar una acción que no mira ninguna de las tres. Mismo patrón que ya
usaban `limpieza-arranque.sh` y el analizador; los valores por defecto tienen que coincidir entre los
tres ficheros o vuelve a haber dos verdades sobre la misma configuración.

**Ninguna herramienta informa de forma fiable de cuánto liberó** (`paccache` imprime texto libre,
`journalctl --vacuum-size` no imprime nada útil, `rm` menos), así que el espacio liberado se mide con
`du` **antes y después**. Como `du` mide un blanco móvil —el navegador reescribe su caché entre las
dos pasadas—, la resta puede salir negativa y se recorta a 0; el estado sigue siendo `ok`.

**Cada categoría lleva DOS cifras, y confundirlas era el fallo principal de la sección.** `bytes` es
lo que la categoría **ocupa**; `liberable` es lo que quedaría libre si pulsas su botón. Casi nunca
coinciden, y las diferencias no son de redondeo:

| Categoría | Por qué `liberable` < `bytes` |
| --- | --- |
| `cachePaquetes` | se conserva la última versión de cada paquete instalado (`paccache -rk1`) |
| `registros` | el journal se recorta a `retenerJournal`; **por debajo de ese tamaño libera 0** |
| `temporales` | mide `/tmp` + `/var/tmp`, pero `/tmp` es tmpfs (RAM) y no se toca: solo cuenta `/var/tmp`, y solo lo anterior a un día |
| `cacheUsuario` | el borrado respeta las cachés de GPU, las de GiGiShell y todo lo que tiene botón propio |
| `descargas` | **con 0 días no borra NADA**, aunque la carpeta ocupe 50 GB |
| `papelera` | con N días, solo lo anterior a N |
| `flatpak` | `liberable: null` — ver abajo |

La estimación de «Liberar espacio» sumaba `bytes`. Medido en este equipo con las casillas por
defecto del usuario: **prometía 28,2 GiB donde se liberaban 21,7 GiB**, y el desglose de al lado
enseñaba «Registros · 100 MiB» con un botón que no habría devuelto ni un byte (la retención está en
200M). Con «Descargas» marcada la cifra habría sido la carpeta entera. Hoy `estimarLiberable`
(`servicios/disco/catalogo.ts`) suma `liberable`, y la fila enseña la segunda cifra debajo de la
primera **solo cuando difieren** — repetirla en «Miniaturas», donde son iguales, sería ruido.

**`liberable: null` es «no se ha podido saber», y no es lo mismo que 0.** Hoy solo lo usa Flatpak:
la acción quita los runtimes que ya no usa ninguna app y `flatpak uninstall --unused` **no tiene
`--dry-run`**; reconstruir su criterio a mano (cruzar `flatpak list --columns=ref` contra los
runtimes que declara cada app, con extensiones y versiones) sería una segunda implementación que se
desviaría de la real en la primera actualización de flatpak. Contar la instalación entera —apps
incluidas—, que es lo que se hacía antes, era la sobrestimación más grande de la lista. Con una
casilla así marcada la frase cambia a «se liberarían **al menos** X», en vez de presentar una
estimación incompleta como si fuera exacta.

**Deduplicar la simulación de `paccache` no es cosmético.** Las dos listas de candidatos **se
solapan**: `-k1` propone borrar las versiones viejas de todo paquete con más de una, y `-uk0` todas
las versiones de lo que ya no está instalado — un paquete desinstalado con dos versiones en caché
sale en las dos. Sumar sin `sort -u` daba **24,94 GB liberables sobre un directorio de 23,23 GB**:
la estimación prometía más espacio del que existe. Por lo mismo no vale leer los dos «disk space
saved» que imprime paccache y sumarlos (13,08 + 10,15 GiB = 23,23 GiB, más que el directorio
entero); además vienen redondeados a dos decimales de GiB, con un error de hasta 10 MB por
invocación. Se suman los tamaños reales de los ficheros candidatos, y `_cat` aplica de todos modos
un **tope duro** (`liberable` nunca puede superar a `bytes`) como red frente a las dos medidas
tomadas en instantes distintos.

**El analizador lee las preferencias, y tiene que leerlas.** `retenerJournal`, `diasPapelera` y
`diasDescargas` no deciden solo *cómo* se limpia: deciden *cuánto*. Un solo `jq` al arrancar, con
los mismos valores por defecto que `limpiar-almacenamiento.sh` — si los dos cayeran a defaults
distintos volveríamos a tener dos verdades. Consecuencia en el shell: cambiar cualquiera de esos
tres campos **invalida el análisis en caché**, que sigue siendo «reciente» dentro de su ventana de
diez minutos. `preferencias.ts` publica un contador (`revisionLimpieza`) al que la sección se
suscribe para reanalizar; sin él, escribías «30 días» en Descargas y la cifra no se movía.

**El consumidor de ese contador AGRUPA, y hasta hace poco no lo hacía.** La documentación de
`revisionLimpieza` decía «es un contador y no un booleano para que dos cambios seguidos emitan dos
veces; el consumidor agrupa», pero cada emisión llamaba a `refrescar` directo: añadir tres carpetas
personalizadas seguidas lanzaba **tres análisis completos**, cada uno midiendo un estado que ya
había cambiado. La agrupación vive hoy en `modulos/ajustes/disco/usarAnalisis.ts`, junto con el
resto del estado compartido, y son dos piezas que evitan trabajo *repetido*, no trabajo lento:

- **`enVuelo`** deduplica el sondeo: dos vistas montando a la vez —lo normal, porque `SettingsPanel`
  se instancia una vez por monitor— o el botón «Volver a analizar» pulsado durante un análisis se
  enganchan al que ya corre en vez de forkear otro `analizar-almacenamiento.sh` sobre el mismo disco;
- **`pendiente`** recuerda lo que llegó mientras tanto. Engancharse no es lo mismo que descartar:
  dedupar a secas es correcto para dos vistas que quieren lo mismo, pero un cambio de
  `revisionLimpieza` durante un sondeo es justamente la señal de que ese sondeo está midiendo con
  la configuración *anterior*. Se sirve con **una** repetición al terminar —una sola, así que una
  ráfaga colapsa en «el que corre + uno más», y ese último ya mide el estado final—, y solo si
  queda alguna vista montada. Sin esto volvía el «escribo 30 días en Descargas y la cifra no se
  mueve», ahora dependiendo de si acertabas a escribirlo durante el análisis o después.

**Lo que `cacheUsuario` NO borra, y por qué.** Un `rm -rf ~/.cache/*` a ciegas cuesta datos reales:
se excluye `gigishell` (mapa de fuentes del CSS, sondeo de hardware), que no es caché de nada porque
nadie lo regenera. `/tmp` tampoco se toca: es un tmpfs (RAM) y borrarlo bajo los pies de los
procesos vivos rompe sockets y ficheros de bloqueo.

**Y se excluye además TODO LO QUE TIENE BOTÓN PROPIO: `paru`/`yay`, `thumbnails`, `pip`,
`go-build` y las cachés de la GPU.** Los dos primeros ya estaban, por otra razón (el helper de AUR se limpia bien con
`-Sc`; borrarlo a mano lo deja reconstruyéndolo todo). Los otros tres entraron al arreglar la
estimación: `miniaturas` y `cacheDesarrollo` viven **dentro** de `~/.cache`, así que mientras
`cacheUsuario` se los llevara por delante era imposible que la suma de tres casillas independientes
diera el espacio real —`thumbnails` se contaba dos veces— y el botón suelto era impredecible,
porque borraba lo que otro botón decía gestionar. **Ahora cada acción borra exactamente lo suyo y la
suma de lo marcado ES el espacio que se libera, para cualquier combinación.** Para vaciar `~/.cache`
entero se marcan las tres (más «Limpiar caché de sombreadores», que no es una casilla sino un botón
— ver justo abajo). Del mismo arreglo salió que `cacheDesarrollo` mida `~/.cargo/registry/cache`
y no `~/.cargo/registry` entero: dentro está también `src/`, el código fuente descomprimido del que
dependen las compilaciones ya hechas, que la acción no toca y que doblaba la cifra de esa fila.

**`CACHE_PRESERVADO` son PATRONES de `find -name`, no nombres literales, y eso arregló un fallo
real**: la entrada era `radv_builtin_shaders` a secas mientras que el fichero que RADV escribe se
llama `radv_builtin_shaders64` (el sufijo es el tamaño de puntero), así que la exclusión no casaba
con nada y `cacheUsuario` se lo llevaba por delante. Aquí no se notó nunca porque esta máquina es
NVIDIA. Igual con `qtshadercache-<arch>-<endianness>-<abi>`, que lleva el triplete de la máquina
dentro del nombre. El analizador ya no concatena `$CACHE_HOME/$nombre` para descontarlos —eso solo
acertaba con los literales, y lo que casaba por patrón se prometía como liberable sin serlo—: pide
las rutas a `cache_preservado_rutas`, un `find` de primer nivel en la lib.

### «Limpiar caché de sombreadores» (`cacheSombreadores`) — la única acción de usuario SIN casilla

Lo que compilan los drivers de la GPU para no recompilarlo: Mesa (OpenGL y RADV), NVIDIA, AMDVLK, el
caché de shaders de Qt, los kernels de CUDA de `~/.nv/ComputeCache` y el **`steamapps/shadercache`**
de Steam. La lista es `rutas_shaders`, en la lib, y la comparten el analizador y el limpiador; se
expande con `objetivos_de_ruta` (contenido si es carpeta, el fichero si es fichero), así que los
directorios sobreviven vacíos — varios drivers no recrean el suyo hasta el siguiente arranque de la
aplicación.

**Solo botón: no es automatizable, y no por privilegios.** Corre entera bajo `$HOME` sin pedir nada.
Queda fuera del lote desatendido porque su coste no se paga en disco sino en la siguiente partida:
recompilar, con tirones mientras tanto, y en el caso de Steam **volver a descargar** lo que ya
tenías. Eso se decide mirando la cifra. Eso obligó a un campo nuevo en el catálogo del shell,
**`manual`**, separado de `privilegio`: `ACCIONES_AUTOMATIZABLES` filtra por los dos, y sin él la
única forma de dejarla fuera habría sido mentir sobre sus permisos. La barrera de verdad sigue
siendo la lista blanca `AUTOMATIZABLES` de `limpieza-arranque.sh`, que tampoco la incluye.

**La entrada gorda es Steam**: 14 GB en este equipo frente a los ~1 GB de todo lo demás junto. Se
listan sus **tres** ubicaciones posibles (nativa, el symlink histórico `~/.steam/steam` y la de
Flatpak) y se **canonicaliza con `realpath` antes de deduplicar**: en esta máquina las dos primeras
son literalmente el mismo directorio, y medirlo dos veces habría duplicado la cifra de la fila.
Verificado en un `$HOME` de juguete con las dos rutas apuntando al mismo sitio: 750 KB medidos, 750
KB liberados, no 1,15 MB.

**La lista vive en `hypr/scripts/lib/limpieza-rutas.sh`, que sourcean los dos scripts.** Antes cada
uno tenía su idea de qué entra y qué no: el limpiador con sus `! -name` escritos a mano y el
analizador sin enterarse de ninguno. Con la lista repartida, la cifra que enseña Ajustes es una
ficción en cuanto alguien toca una de las dos mitades — que es exactamente cómo empezó esta avería.

**La autolimpieza NO es un daemon, y esto es una corrección de la primera versión.** Empezó siendo
`limpieza-monitor.sh`: dormía 60 s, comprobaba y se quedaba en un `while :; do pasada; sleep 3600;
done` el resto de la sesión. Coste medido de **cada** pasada: hasta **15 procesos `jq`** —uno por
clave de configuración, más uno por cada una de las 11 acciones automatizables, dentro del bucle—
más un `df`, y casi siempre para responder «todavía no toca»: con el intervalo por defecto de 24 h,
23 de cada 24 despertares no hacían nada salvo forkear quince veces y volverse a dormir. Encima
dejaba un bash residente por sesión.

Hoy `limpieza-arranque.sh` corre **una vez**, desde el autostart (t=12), y su camino normal es
**una lectura y un `if`**: un solo `jq -n --slurpfile` que abre los dos JSON (configuración y
estado) y emite una línea TSV con todo lo que hace falta decidir. Medido: **2,9 ms** y cero
procesos residentes cuando no toca limpiar. `command -v jq` no cuenta — es un builtin de bash— y
`date` desapareció a favor de `printf '%(%s)T'`, que también lo es. El `df` del umbral solo se
ejecuta si hay umbral configurado.

**Lo que se pierde, y es deliberado**: un equipo encendido durante días ya no autolimpia hasta el
siguiente inicio de sesión. Se acepta porque lo que esto borra —caché de paquetes, journal,
temporales, miniaturas— crece con el **uso**, no con el reloj, y porque el botón «Ejecutar ahora»
(`--ahora`, que se salta intervalo y umbral) cubre el caso raro. Si algún día hiciera falta la
comprobación periódica, el sitio correcto es un timer de `systemd --user`, **no** volver al bucle:
un timer duerme sin proceso.

La marca de la última limpieza vive en `~/.cache/gigishell/limpieza.json` y **no** en el JSON de
configuración: AGS reescribe ese fichero entero con un `replace_contents`, así que se llevaría la
marca por delante. Se pone **antes** de limpiar — si algo se cuelga se pierde un ciclo, en vez de
relanzar la limpieza entera en cada inicio de sesión para siempre. El umbral se mira **después**
del intervalo y sin tocar la marca: con el disco holgado no hay nada que hacer, pero un disco que
se llena mañana no debe esperar un ciclo entero.

**`//` de jq considera falsy a `false`, no solo a `null`.** `.notificar // true` devolvía `true`
con la opción desactivada, o sea que la limpieza avisaba igual después de que el usuario apagara el
aviso. Las claves **booleanas** se leen con `if (… | has("clave")) then …`; las numéricas sí pueden
usar `//` porque en jq un `0` es truthy.

**Configuración y defaults.** `~/.config/gigishell/almacenamiento.json`, escrito por
`servicios/disco/preferencias.ts` y releído por los scripts **en cada pasada** (a diferencia de
`security.json`, que `oom-monitor.sh` lee una sola vez al arrancar). La autolimpieza nace **apagada
y con todas las casillas sin marcar**, al revés que `security.json` —donde todo viene ON—: allí los
defaults deciden si algo se *vigila*, aquí si algo se *borra sin preguntar*. Encender o apagar el
interruptor no lanza ni mata nada: la comprobación de arranque leerá el valor nuevo en la
siguiente sesión.

**No hay proceso que relanzar al tocar el interruptor**, y esa es la consecuencia visible de lo
anterior: `setAutoLimpieza` solo escribe `auto` en el JSON, que es lo que leerá el siguiente
arranque. La versión de bucle hacía `pkill -f limpieza-monitor.sh` + re-exec, como
`screencast-monitor` y `updates-monitor`; eso ya no aplica y se quitó. (Al actualizar desde la
versión antigua, un `limpieza-monitor.sh` de la sesión en curso sigue vivo hasta cerrar sesión: el
fichero ya no existe, así que no vuelve.)

**Instalación:** `install.sh` paso 9-bis instala el helper en `/usr/local/bin/gigishell-limpieza` y la
regla en `/etc/sudoers.d/gigishell-limpieza` (validada con `visudo -cf` antes de moverla). Sin el
helper, las acciones de nivel 2 devuelven `estado:"sin-permisos"` con el paso que falta, y todo lo
de `$HOME` sigue funcionando. Igual que los helpers de TLP y ClamAV, **no se symlinkea**: apuntar un
comando NOPASSWD a un fichero escribible por el usuario es una escalada silenciosa.

**La desinstalación de aplicaciones NO está aquí**, aunque el catálogo las liste por tamaño: la hace
`desinstalar-app.sh` desde Orion, que ya distingue repos, AUR, Flatpak, Steam e instalación manual y
tiene su propia lógica fail-safe (ver su sección más arriba). Duplicarla en Ajustes habría dado dos
caminos con dos criterios distintos para la misma operación irreversible.

### Comprobación de arranque (`boot-healthcheck.sh`)

Es el `exec-once` más caro del arranque —de ahí que vaya al final del calendario escalonado, a
`t=30` (ver la sección de `gigishell/autostart.lua` más arriba)— y por eso está pensado para ser **silencioso
en una máquina sana**: solo notifica por categoría cuando encuentra un problema, y todo (incluida la
pasada limpia) queda en `hypr/logs/boot-healthcheck.log` (ignorado por git, ver `.gitignore`).
Ejecutado a mano responde al instante — el retraso lo pone quien lo lanza, no el script.

**Los problemas se acumulan y se emiten al FINAL, no según se encuentran.** Este script comprueba
~19 cosas de una tacada y cada aviso sale con `--expire-time=0`, o sea **sin autocierre**: un
arranque regulero (servicios fallidos + errores en el journal + arranque lento + red inactiva +
batería degradada) recibía al usuario con cinco tarjetas permanentes que hay que cerrar a mano una
por una — y lo que se aprende de eso es a cerrarlas todas sin leerlas. Desde `RESUMEN_DESDE=3`
problemas sale **uno solo**, `arranque.resumen`, con la lista de títulos y un puntero al log;
con uno o dos siguen saliendo individuales, que es lo mejor cuando son pocos porque conservan su
identidad y su remedio concreto. Aquí **no** se usa `lib/notif-agrupar.sh`: aquella agrupa N
eventos **del mismo tipo** llegados en ráfaga, y esto es lo contrario —N problemas de tipos
distintos que comparten un momento—, así que el resumen es un aviso propio y no un recuento.
El cuerpo de cada problema lleva su remedio (`revisa: journalctl -b …`) y esos ni caben ni se leen
apilados en un popup: **por eso el resumen remite al log**, que ya los registraba todos.

**Ojo con la urgencia:** once llamadas pasan `warning`, que **no es un nivel válido** (`notify-send`
solo acepta `low`/`normal`/`critical`; con cualquier otro escribe *«Unknown urgency»* y sale con
rc=1 **sin enviar nada** — ver la sección de notificaciones). Aquí el campo se conserva porque
alimenta también el **log**, donde sí distingue gravedad; `urgencia_valida()` lo traduce a `normal`
en el único punto de emisión. Es la red que impide que ese fallo vuelva a colarse en este script.

**Fase 1 autodescubre el hardware presente** (batería, GPU NVIDIA, NVMe, SATA, soporte SMART,
sensores de ventilador, swap, Bluetooth, audio, red, USB) y la Fase 2 solo comprueba las categorías
cuyo hardware existe — un sobremesa sin batería no recibe ningún chequeo de batería, ni un aviso de
que no la tiene. La GPU NVIDIA se detecta por **PCI** (`lspci`/`vendor` sysfs), no por si el módulo
`nvidia` está cargado: mirar el módulo primero se comería precisamente el caso que este chequeo
existe para pillar (GPU presente, driver no cargado).

**Varios comandos caros se ejecutan una sola vez y se reutilizan entre chequeos** (`sensors`,
`rfkill list bluetooth`, `aplay -l`, `ip link show`, `journalctl -b -1`): cada uno alimenta dos
comprobaciones distintas (existencia + estado) con la misma lectura, en vez de invocar el comando
dos veces por una diferencia de grep. El de ventilador parado además se beneficia de que sea **la
misma muestra**: correlaciona la temperatura de CPU y las RPM del ventilador de una única lectura de
`sensors`, no de dos llamadas casi simultáneas que podrían no coincidir.

**Los errores de kernel/journal se deduplican por proceso/unidad**, no por línea — N repeticiones
de la misma fuente cuentan como un solo problema, y se filtra ruido conocido de antemano (ACPI,
init de Bluetooth, nouveau, WMI, variables EFI, pstore, firmware). El chequeo de suspensión/hibernación
mira el **arranque anterior** (`journalctl -b -1`), no el actual: busca errores de suspend/hibernate,
servicios `systemd-*sleep*` en estado failed, y señales de reinicio forzado (watchdog, "rebooted
forcefully", modo de emergencia) — con `sddm-helper` excluido a propósito porque incrusta el log de
Xorg, que contiene literalmente la cadena "nowatchdog" en su `cmdline` y daría un falso positivo.

**La salud de batería compara `energy_full` contra `energy_full_design`** (o su par `charge_*` en
equipos que no exponen energía), no un simple porcentaje de carga — es la métrica de degradación
real de la celda, y avisa por debajo del 80 % de la capacidad de diseño original.

### Grabar pantalla (`grabar-pantalla.sh`)

**Capturas y grabaciones comparten esquema de teclas**: la **tecla** dice el alcance y el **SHIFT**
dice si es foto o vídeo — `SUPER+Z` recorte / `SUPER+SHIFT+Z` grabar ventana, `SUPER+X` pantalla
completa / `SUPER+SHIFT+X` grabar el monitor activo. Estaban en `CTRL+F`/`CTRL+S`/`CTRL+SHIFT+F`/
`CTRL+SHIFT+S`, y moverlas a `mainMod` **le devuelve `CTRL+S` y `CTRL+F` a las aplicaciones**: eran
binds globales, así que el compositor se los tragaba antes de llegar a ninguna ventana y no se podía
guardar ni buscar con el atajo de siempre. `SUPER+SHIFT+P` (región con slurp) se queda fuera del
esquema porque no es un tercer alcance sino otra herramienta: `wf-recorder` a pelo, sin el toggle ni
el audio del sistema de este script — se detiene matando el proceso, no repitiendo el atajo.

Toggle de dos invocaciones: la primera arranca `wf-recorder` en segundo plano y bloquea esperándolo;
la segunda (mismo atajo) detecta que ya hay una grabación y le manda `SIGINT` para que cierre el
contenedor MP4 correctamente en vez de dejarlo truncado. Todo el estado va protegido por un
`flock` sobre un fichero de bloqueo — necesario porque pulsar el atajo dos veces seguidas rápido es
exactamente el caso de uso.

**Validar "hay una grabación activa" no se conforma con que el PID exista.** Comprueba además que
`/proc/$pid/comm` sea literalmente `wf-recorder` **y** que `/proc/$pid/cmdline` contenga la ruta de
salida exacta que se guardó — un PID reciclado por otro proceso cualquiera tras un cierre forzado no
basta para que el toggle lo confunda con "sigue grabando". Solo si esa doble comprobación falla se
borra el fichero de estado (nunca antes, para no perder la referencia a una grabación real que sigue
viva).

**El modo `ventana` restringe `slurp` a las ventanas realmente seleccionables**: geometrías sacadas
de `hyprctl clients -j`, filtradas a las que están en un workspace **visible ahora mismo** (según
`hyprctl monitors -j`), mapeadas, no ocultas y con tamaño > 0 — en vez de dejar a `slurp` seleccionar
una región libre de la pantalla. Cancelar con Esc sale con código 0 en silencio, no es un error.

Graba **siempre** con el audio interno del sistema: resuelve el sink por defecto con
`pactl get-default-sink` y usa su fuente `.monitor`, verificando primero que esa fuente exista de
verdad en `pactl list short sources` antes de arrancar. Tras lanzar `wf-recorder` espera 0.25 s y
comprueba que el proceso siga vivo — así un fallo inmediato de salida, audio o códec no se anuncia
como "grabación iniciada" cuando en realidad murió al instante.

### Portapapeles (`clipboard-history.sh`, `limpiar-portapapeles.sh`, `miniatura-portapapeles.sh`)

`clipboard-history.sh start` arranca el watcher (`wl-paste --watch cliphist store`) con
**`setsid --fork`**, no con `exec` ni en primer plano: así queda reparentado a init y sobrevive a
quien lo lanzó — tanto Hyprland (`gigishell/autostart.lua`) como AGS (`execAsync`) llaman a `start`, y antes
el watcher moría junto con AGS por usar `exec`. Dos patrones de proceso distintos cumplen roles
distintos: uno general (cualquier límite de `-max-items`) sirve para detectar y **sustituir** un
watcher que quedó con un límite antiguo sin perder el historial ya guardado (`stop` no vale para
eso: también hace `cliphist wipe`), y uno exacto (límite actual) sirve para el caso normal de "ya
está corriendo bien, no hacer nada".

`picker` (SUPER+V) es un toggle de Rofi: si ya está abierto, la segunda pulsación lo cierra. Con el
historial desactivado por preferencia no abre nada (`stop` ya lo vació, no hay qué mostrar). El AWK
que arma la lista distingue tres tipos de entrada de `cliphist`: imágenes binarias (miniatura vía
`miniatura-portapapeles.sh`), rutas de imagen en texto (decodificando `file://` con sus `%XX`), y
texto normal — conservando el ID de `cliphist` en una columna oculta para poder decodificar la
selección exacta. Cancelar (Esc) sale con 0 sin tocar el portapapeles, para no pisar con un
`wl-copy` vacío lo que el usuario tenía copiado.

`miniatura-portapapeles.sh` no crea ficheros intermedios ni caché propia: canaliza
`cliphist decode` directo a ImageMagick, con límites de memoria/mapa/disco (128 MiB/0/0) para acotar
el coste de generar una miniatura bajo demanda, escribiendo ya en la ruta que espera Rofi.

`limpiar-portapapeles.sh` tiene dos entradas: `limpiar` (llamada directa, p. ej. desde AGS) y
`al-iniciar` (la usa `gigishell/autostart.lua`, respeta la preferencia `limpiezaPortapapelesAlIniciar`).
Borra primero la selección activa de Wayland (`wl-copy --clear`) y solo después el historial
persistente (`cliphist wipe`) — en ese orden: si el watcher llegara a capturar el clear como una
entrada nueva, el wipe posterior se la lleva también.

### Tema oscuro de las apps KDE (`reparar-kdeglobals.sh`)

Repone `[UiSettings] ColorScheme=BreezeDark` en `kdeglobals`. Lo llaman `gigishell/autostart.lua`
(t=0, junto a los dos `gsettings` del tema GTK) y `bin/link.sh` (en cada pasada). Es one-shot:
mira y, o corrige, o se muere — no deja nada en `ps`.

**El fallo silencioso.** `kdeglobals` está versionado y symlinkeado a `~/.config/kdeglobals`.
Cualquier app KDE que guarde ajustes globales —Dolphin > Preferencias es la habitual— reescribe el
fichero **entero** con KConfig y se deja por el camino los grupos que ningún proceso vivo vuelve a
declarar. El que se pierde es `[UiSettings]`, que es justo el que lee `KColorSchemeManager`: a
partir de ahí Dolphin se abre en tema **CLARO** aunque `[General] ColorScheme=BreezeDark`, los
grupos `[Colors:*]` materializados y `QT_QPA_PLATFORMTHEME=qt6ct` sigan intactos. No hay ningún
error por ningún lado; solo se nota al abrir el gestor de archivos. Bajo Plasma lo repondría el
propio escritorio, pero aquí no hay nadie que lo haga.

**Una comprobación por sesión basta, y está medido.** Se vigiló el fichero con `inotifywait` mientras
se abría Dolphin, se esperaba y se cerraba con SIGTERM: **cero escrituras**, clave intacta. El uso
normal no rompe nada — lo que lo borra es guardar desde un diálogo de preferencias, cosa de una vez
cada muchos días. Por eso no hay watcher permanente: un `awk` sobre 4 KB al entrar, y cuando la
clave está (lo normal) no se escribe nada.

**Trampa al tocarlo: hay que resolver el symlink antes de escribir.** El script genera el resultado
en un temporal y lo mueve encima. Si el `mv` cae sobre la ruta canónica `~/.config/kdeglobals`
—que es un symlink— **reemplaza el symlink por un fichero regular**, y a partir de ahí el repo y lo
que leen las apps son dos ficheros distintos. Lo peor es que todo parece ir bien (el tema sale
oscuro) hasta que un `dotfiles checkout` deja de tener efecto. Comprobado al escribir el script; de
ahí el `readlink -f` antes del `mv`. Por la misma razón `link.sh` le pasa la ruta **del repo** y no
la canónica: él corre también en instalaciones donde el symlink aún no existe, y crear ahí un
fichero real le estorbaría su propio enlazado.

Solo se reescribe ese grupo: si `[UiSettings]` existe con otro valor se corrige conservando sus
demás claves, y si no existe se crea antes de `[WM]` (el orden alfabético de KConfig). Los ajustes
que cambies desde los diálogos de las apps se conservan. `bin/preflight.sh --installed` comprueba
las dos mitades: que la clave esté en `kdeglobals` y que el autostart llame al script.

### Utilidades cortas de un solo uso

- **`GiGiShell.daltonismo(modo)`** (`gigishell/daltonismo.lua`) — aplica o quita un shader de pantalla
  (`decoration.screen_shader`) para protanopia/deuteranopia/tritanopia. Sin sondeo: lo invoca AGS al
  cambiar el ajuste (`hyprctl eval`) y el propio `hyprland.lua` en cada arranque/recarga para
  restaurar `modoDaltonismo` de `preferences.json`; sin argumento lee esa preferencia en el momento,
  sin caché (`util.leer_json`, no `util.prefs()`).
- **`GiGiShell.compactar()`** (`gigishell/compactar.lua`) — renumera los escritorios ocupados a IDs
  consecutivos desde 1, moviendo ventanas en silencio y siguiendo al escritorio activo hasta su
  nuevo número. Sale sin hacer nada si no hay ninguna ventana en ningún escritorio. Es el motor que
  usa `gigishell/escaner-apps.lua` cuando detecta dos o más escritorios destino (ver esa sección) — y
  por lo que esa sección advierte que los IDs deben releerse **después** de compactar. Al ser una
  llamada Lua síncrona el resultado está disponible al volver (medido: 0,2 ms), sin la carrera que
  había con el script.
- **`GiGiShell.toggle_orion()`** (`gigishell/orion.lua`) — antes de tocar nada comprueba el ajuste maestro
  `orion` en `preferences.json`: si está desactivado no manda el toggle a AGS, porque deliberadamente
  no hay ninguna ventana registrada que responda. Luego intenta `ags request toggle-orion` y solo si
  falla o no devuelve `"ok"` cae a `ags toggle orion` — cubre la breve ventana de una recarga en la
  que el config en disco ya se actualizó pero la instancia de AGS en marcha todavía no, sin la cual
  el atajo quedaría inservible justo en ese momento.
  **Era `toggle-orion.sh`**, y lo que pagó el inline fue la comprobación de la preferencia: el script
  la leía con `jq` —un fork de bash y otro de jq en cada pulsación— más una rama de repuesto con
  `grep` por si jq no estaba instalado; aquí es un `util.leer_json` sin procesos ni dependencias. La
  llamada a AGS **sí sigue saliendo a un shell** (`hl.exec_cmd`, asíncrono): un `ags request` dentro
  del callback del bind lo bloquearía, y los callbacks tienen 100 ms. Ausente = activado, así que la
  comprobación es `== false` explícito — un `nil` tiene que dejar pasar. Fail-open hacia "el atajo
  funciona": si la lectura falla, se manda el toggle igual.
- **`GiGiShell.toggle_gaps()`** (definida en `gigishell/keybinds.lua`, junto a su bind) — alterna
  gaps/borde/rounding a 0 (modo compacto) y de vuelta al diseño normal. **Los valores de vuelta
  se LEEN de `gigishell/ventanas.lua`**, que exporta la tabla `aspecto` (`gaps_in`, `gaps_out`,
  `border_size`, `rounding`) con la que él mismo se configura — antes eran literales copiados en
  el toggle con una advertencia de "replícalo si los cambias", y esa advertencia no da ningún
  error cuando se incumple: el toggle "restauraba" un espaciado que ya no era el tuyo y parecía
  que el atajo estropeaba el diseño. `ventanas.lua` es el **único escritor** de esas cuatro claves
  en todo el config (`reglas.lua` solo las nombra en ejemplos comentados), así que no hay un
  segundo sitio con el que desincronizarse. El `require` va en `pcall` con repliegue a los valores
  de siempre: un error ahí dejaría la sesión **sin ningún atajo** (la trampa nº 1 del config Lua),
  y perder este toggle no vale eso. **`border_size` entra ahora en el ciclo** — el atajo se llamaba
  "toggle-gaps-borders" pero nunca tocó el borde, porque el diseño de hoy lo tiene a 0 y no se
  notaba; subirlo algún día habría dejado un marco pintado en el único modo cuya razón de ser es
  que las ventanas se toquen. El estado vive en una `local` de Lua, no en un fichero de
  `$XDG_RUNTIME_DIR`: igual de efímero, y con la ventaja de que un `hyprctl reload` resetea a la vez
  el flag y los gaps — el esquema viejo restauraba los gaps pero el fichero sobrevivía, así que el
  siguiente toggle "restauraba" un estado en el que ya estabas.
- **`wallpaper.sh`** — aplica fondos; **ya no decide cuál** (eso es
  `wallpaper-select.py`, sección aparte más abajo). Cinco modos: sin argumento (arranque, respeta
  `randomOnStart`), `--random` (botón de Orion), `--auto` (reevaluar la franja horaria, lo llama el
  planificador de AGS), `--grupo <id>` y `<ruta>`. Los campos `current` y `currentGroup` de
  `~/.config/gigishell/wallpaper.json` los escribe **siempre este script** tras aplicar un fondo, y
  `randomOnStart` lo escribe **siempre AGS** desde su toggle — cada lado hace read-modify-write
  conservando los campos del otro, así que ninguno pisa el ajuste del otro por accidente. Léelo con
  el mismo cuidado que el resto del repo: `.randomOnStart // true` sería incorrecto (el `//` de `jq`
  trataría un `false` real como ausente). Si el selector falla se repliega al `shuf` de siempre; la
  excepción es `--auto`, que **no** se repliega — sin saber qué franja rige, sortear sería un cambio
  a destiempo y sin motivo visible, y que no pase nada es el fallo correcto ahí.

### Franjas horarias y grupos de fondos (`wallpaper-select.py` + `lib/seleccion_fondos.py`)

El sorteo de fondos ya no es "uno cualquiera de la carpeta": primero se mira **qué fondos están
permitidos a esta hora** y solo entre esos se sortea. El motivo original es que no salga un fondo
claro de madrugada, pero de paso permite atardeceres a su hora. Todo se gestiona desde Orion >
Temas; lo único que sigue haciéndose por el explorador de archivos es **añadir imágenes** a
`Wallpapers/`.

**Son DOS sistemas de franjas, no uno, y mezclarlos fue la primera tentación**:

- Las **franjas globales** (`día`/`tarde`/`noche` de fábrica, N libres) gobiernan los fondos
  **sueltos**. Cada fondo declara en cuáles es apto; **sin declaración es apto siempre**, así que
  estrenar la función —o copiar una imagen nueva a la carpeta— no deja nada invisible sin que nadie
  lo pida.
- La **línea de 24 h propia de cada grupo** gobierna sus variantes, y es **independiente** de las
  globales: un grupo puede mudar a las 5:00 aunque "día" empiece a las 7:00. Cada tramo lleva una
  **lista** de imágenes, no una: con varias se sortea entre ellas.

Ambas listas se definen **solo por el inicio** de cada entrada y llegan hasta el comienzo de la
siguiente, envolviendo la medianoche — con tres franjas se ponen tres horas, no seis. **Antes del
primer inicio del día manda la ÚLTIMA entrada** (la que viene de ayer): a las 00:30 con la primera
franja a las 07:00 rige "noche". Es el caso que se olvida al escribir esta aritmética a mano, y hay
test a los dos lados por eso.

**Un grupo es UNA entidad de cara al sorteo** —es la definición de grupo: para el sistema es un
fondo, no N— y sus imágenes **no compiten además como fondos sueltos**. Si lo hicieran, meter cuatro
variantes en un grupo cuadruplicaría sus posibilidades frente a un fondo suelto. **Un tramo con la
lista vacía es la forma de decir "aquí este grupo no sale"**, que es lo que implementa "un grupo sin
imagen apta para la franja actual queda fuera de la selección" sin necesitar una segunda marca de
aptitud encima de la línea de tiempo. Un grupo cuyas imágenes hayan desaparecido del disco queda
fuera por la misma vía.

**LA DECISIÓN TIENE UN SOLO DUEÑO, y ese es todo el diseño.** Hay **dos** disparadores para la misma
elección: el arranque de la sesión (`wallpaper.sh` desde `gigishell/autostart.lua`, en t=0, cuando AGS
todavía no existe) y el cruce de franja (AGS, con el escritorio ya vivo). Con dos implementaciones
acabarían discrepando en silencio — el escritorio mostrando un fondo que el planificador cree que es
otro—, así que la lógica vive entera en `hypr/scripts/lib/seleccion_fondos.py` (**puro**: no lee
ficheros, no mira el reloj; todo entra por parámetros, y tiene 41 pruebas en
`lib/seleccion_fondos_test.py`). `wallpaper-select.py` es su única cara: hace la E/S y emite una
línea `<grupo o vacío>\t<ruta>`. **Python y no jq**: el operador `//` ya ha mordido tres veces en
este repo, y esto es demasiada lógica para bash.

**Al cambiar de franja, un GRUPO conserva su identidad y solo muda de variante; un fondo SUELTO que
deja de ser apto se sustituye por otro al azar**, y si sigue siendo apto no se toca. Eso lo sostiene
`currentGroup` en `wallpaper.json`: sin él, al reevaluar solo se vería una ruta y no habría forma de
distinguir "muda de variante" de "sortea otro fondo".

**Dentro de un tramo con varias imágenes NO se re-sortea en cada pasada** (`preferir` en
`resolver_grupo`): el planificador puede despertar más veces de las previstas —el troceo, una
suspensión, un arranque a mitad de tramo— y sin eso el fondo cambiaría sin haber cruzado ningún
límite. Por lo mismo, `auto` **no imprime nada** si lo que toca ya está puesto: reaplicarlo
dispararía la transición de `awww`, un parpadeo en cada comprobación.

**Fail-open, y en dos escalones.** Si tras aplicar los filtros no queda **ni un candidato** (todo
marcado como no apto de noche), se **ignoran los filtros** y se sortea entre todo lo que haya: un
fondo "equivocado" es visible y corregible, un escritorio sin fondo no. Y si el selector entero falla
—falta python, JSON corrupto, un bug—, `wallpaper.sh` cae a su `shuf` de siempre.

**El reloj lo pone AGS** (`ags/servicios/fondos/planificador.ts`), que es lo único que bash no puede
tener sin convertirse en otro daemon. No decide nada: pregunta `next-change` al mismo script y llama
a `wallpaper.sh --auto`.

**Un solo temporizador, armado exacto, sin sondeo**: se duerme el tiempo que falta y punto — entre
dos cambios de franja el coste es cero, ni un despertar ni un fork. Y ese tiempo es el del próximo
límite **relevante**, no el de cualquier franja definida: `limites_relevantes()` mira el estado, así
que **con un grupo puesto solo cuentan los tramos de ESE grupo** (sus variantes no miran las franjas
globales, luego un cambio de "día" a "tarde" no puede alterar nada mientras él esté en pantalla) y
**con un fondo suelto, solo las franjas globales**. Los tramos de los demás grupos no pueden cambiar
nada de lo que hay en pantalla; despertar por ellos sería trabajo tirado. Sin límites relevantes no
se arma **ningún** temporizador. Se rearma ante las tres cosas que invalidan la cuenta atrás: al
vencer, al editarse `wallpapers.json`, y al cambiar el fondo puesto (`wallpaper.json`) — esto último
es obligatorio desde que el cálculo depende del estado, porque aplicar un grupo cambia por completo
qué límites importan.

**⚠️ La suspensión se resuelve con una señal, no troceando el temporizador.** `GLib.timeout_add`
cuenta sobre el reloj **monotónico**, que no avanza mientras el equipo duerme: una espera de ocho
horas armada de una tacada sonaría ocho horas de *actividad* después, y el caso real es justo ese
(suspendes de día, despiertas de noche con un fondo claro). La primera versión lo cubría **troceando
a 15 min**, o sea despertando 96 veces al día para no hacer nada casi ninguna. Se cubre igual —y con
precisión de segundos en vez de un cuarto de hora de desfase— escuchando **`PrepareForSleep`** de
logind por D-Bus: al volver (`false`) se reevalúa contra el reloj de pared y se rearma. Cuesta una
suscripción y ningún despertar. Sin logind se degrada a corregir en el siguiente límite.

Reevaluar de más sigue siendo gratis (`--auto` no aplica nada si el fondo que toca ya está puesto),
que es lo que permite tirar del rearme sin miedo a parpadeos.

**Config**: `~/.config/gigishell/wallpapers.json` (`{version, franjas, grupos, fondos}`), la escribe
solo Orion. **Ausente o vacía = el comportamiento de siempre** (todo apto, sorteo plano), así que
esto no cambia nada hasta que se configura. Ver `ags/CLAUDE.md` para el lado de la UI.

### Monitores de recursos restantes (`battery-monitor.sh`, `temp-monitor.sh`, `ram-monitor.sh`, `disk-monitor.sh`, `bt-monitor.sh`)

Los tres primeros comparten un mismo molde: bucle de sondeo con **solo builtins de bash** en el
camino caliente (sin forks salvo `notify-send`/`jq` cuando de verdad hay algo que decir), histéresis
para no oscilar en el umbral, e **intervalo de sondeo adaptativo** (más corto cerca del umbral, más
largo con margen de sobra) para reducir despertares. Los tres leen su interruptor de
`preferences.json` **una sola vez al arrancar** con el mismo cuidado repetido por todo el repo: NO
`.claveMonitor // true`, porque el operador `//` de `jq` trata un `false` literal como ausente y ese
"apagado" nunca surtiría efecto — se lee con `if has(...)`.

- **`battery-monitor.sh`** — sondeo adaptativo (30/60/90 s) de `/sys/class/power_supply/BAT0`. Nunca
  avisa de modo ahorro ni de batería baja mientras carga (se resetean los flags al pasar a
  `Charging`). Espeja el umbral de ahorro de energía de AGS leyendo
  `~/.config/power-save/config.json` cada 10 min como mucho. El primer estado tras arrancar
  (`prev_status=""`) se trata como válido en vez de como un caso aparte, para no disparar un falso
  "cargador desconectado" en el login. La detección de "carga completa" cubre tanto `status=Full`
  como `Charging` al 100 % — hay baterías que nunca reportan `Full`.

  **Apagado preventivo** (Ajustes > Energía, `apagadoPreventivo`/`apagadoPreventivoPct` en
  `preferences.json`, encendido al 3 % de fábrica). Al llegar a ese porcentaje descargando, el
  monitor lanza `apagado-preventivo.sh` con `setsid` (un `pkill` del monitor no debe cancelar un
  apagado en curso): notificación crítica con botón «Cancelar» y 60 s de cuenta atrás, cierre
  ordenado de todas las ventanas por `hl.dsp.window.close` (lo que deja a cada app guardar su
  sesión o preguntar por lo no guardado; se espera hasta 20 s) y `systemctl poweroff`. Enchufar
  el cargador aborta en cualquier punto anterior al apagado. El disparo queda latcheado hasta que
  el equipo cargue, así que un «Cancelar» vale hasta entonces.

  **Apagar o hibernar** (`apagadoPreventivoAccion`, `"apagar"` de fábrica). Con `"hibernar"` no se
  cierran las ventanas —es justo lo que hibernar evita— y se llama a `systemctl hibernate`. La
  disponibilidad se pregunta ANTES del aviso (`gigishell-hibernacion estado`, o `CanHibernate` de
  logind sin el helper), para que la notificación diga lo que va a pasar: si no se puede, se apaga
  y el aviso lo dice. Si `systemctl hibernate` falla igualmente, se cae al apagado ordenado. Ojo:
  **`systemctl hibernate` devuelve 0 al DESPERTAR**, así que tras él el script sale — seguir
  apagaría el equipo recién restaurado. Ajustes deja elegir «Hibernar» aunque no esté disponible,
  con el motivo y el «se apagará» escritos debajo, en vez de bloquear el botón y esconder el porqué.

  Tres cosas no obvias:
  - **El interruptor «Monitor de batería» ya NO mata el script**, solo silencia sus avisos. Antes
    salía al arrancar, y colgar el apagado de él habría dejado el equipo sin apagado preventivo
    por haber quitado unas notificaciones, sin ningún síntoma hasta agotar la batería. Sin `BAT0`
    (sobremesa) sí sale.
  - **El mínimo es 3 % por UPower**: su `PercentageAction` (2 % de fábrica, `/etc/UPower/UPower.conf`)
    es un corte sin aviso; con un umbral igual o menor, UPower actuaría primero y este ajuste
    nunca llegaría a verse. El máximo (20 %) es `APAGADO_TECHO` del monitor: por encima ni se lee
    la preferencia, para no pagar un fork de `jq` en marcha normal — si se sube uno hay que subir
    el otro.
  - **El `notify-send --wait` en segundo plano cierra el descriptor del `flock` (`exec 9>&-`)**:
    heredado, retenía el cerrojo hasta que la notificación caducaba y bloqueaba en silencio el
    siguiente disparo tras un apagado cancelado al enchufar.
- **`temp-monitor.sh`** — resuelve la ruta sysfs de `coretemp` ("Package id 0") **una sola vez** al
  arrancar, no en cada vuelta; la GPU usa `nvidia-smi` (este driver no expone temperatura por hwmon
  en esta máquina) solo si está presente. Histéresis 85 °C/80 °C, sondeo 15 s cerca del umbral, 60 s
  en reposo.
- **`ram-monitor.sh`** — usa `MemAvailable` de `/proc/meminfo`, no un porcentaje de uso: es la
  estimación del propio kernel de lo reutilizable sin llegar a swap (descuenta caché reclamable), así
  que no confunde el cacheo agresivo normal de Linux con memoria realmente agotada. Umbral absoluto en
  MB (no %) porque el mismo porcentaje significa márgenes reales muy distintos en un portátil de 4 GB
  que en un sobremesa de 32 GB. El parseo aprovecha que `MemAvailable` sale entre las primeras líneas
  del fichero para cortar el bucle en cuanto aparece.
- **`disk-monitor.sh`** — **no es un daemon**: corre una vez al login y sale. El espacio libre no
  tiene fuente de eventos y quedarse sin él es raro, así que una sola comprobación al arrancar es el
  compromiso correcto — coste cero el resto de la sesión.

  **«No tiene fuente de eventos» está comprobado, no supuesto** (verificado sobre esta máquina;
  léelo antes de volver a buscarla, que es el impulso natural). El **kernel** no publica nada:
  inotify/fanotify vigilan sucesos de *fichero*, y `FAN_FS_ERROR` (5.16+) reporta **corrupción**
  del sistema de ficheros, no un ENOSPC inminente. **udisks2** solo señaliza montajes y cambios de
  medio, nunca capacidad. **systemd** no tiene nada equivalente (`systemd-tmpfiles` limpia, no
  avisa). **CachyOS no trae ningún demonio para esto** (`pacman -Qs`: nada). Lo único en Linux que
  *sí* empuja un evento por espacio es el **netlink de cuotas** (`quota_nl`, `QUOTA_NL_BSOFTWARN`
  al pasar el límite blando, que es lo que consume `quota_nld`), pero es **por usuario**, exige
  `quotaon`, y **btrfs no implementa cuotas de usuario** — solo qgroups, que no emiten netlink —,
  así que en este equipo (todo btrfs sobre un solo NVMe) no existe. Que nadie escuche no es una
  laguna nuestra: **GNOME (`gsd-housekeeping`) y KDE (`kded freespacenotifier`) sondean cada 60 s**.

  **La cobertura del resto de la sesión NO sale de un sondeo nuevo, sale de reaprovechar un `df`
  que ya se pagaba.** `ags/servicios/disco/alerta.ts` emite **este mismo aviso** a partir del
  análisis de Ajustes > Almacenamiento, que ya corría `analizar-almacenamiento.sh discos` en cada
  apertura de la sección. Coste marginal: **cero procesos residentes, cero temporizadores, cero
  forks de más**. Lo que se decide es puro y está testeado (`servicios/disco/vigilancia.ts` +
  `vigilancia.test.ts`); el efecto —marca, `notify-send`— vive en `alerta.ts`, y la llamada se
  hace desde `usarAnalisis.ts` y **no** desde `analizar()`, porque medir no debe notificar.

  **Tres cosas tienen que seguir coincidiendo entre los dos emisores, y ninguna da error si
  divergen** — solo dos versiones del mismo aviso que no cuadran:

  1. **Los umbrales.** `WARN_GB=5` / `MIN_GB=6` en el script ↔ `AVISO_LIBRE_BYTES` /
     `AVISO_MIN_TOTAL_BYTES` en `vigilancia.ts`. Están duplicados a propósito (el script es bash
     sin dependencias, el módulo TS es puro: compartir fichero obligaría a uno a forkear un
     parser) y los dos sitios se avisan mutuamente por comentario.
  2. **El texto.** Idéntico al que produce `lib/notif-agrupar.sh` para el grupo `lleno`, singular
     y plural. De paso se corrigió una discrepancia vieja: `bytes_to_human` calculaba en GiB
     (÷1024³) pero rotulaba **«GB»** con punto decimal, mientras AGS rotula «GiB» con coma
     (`formato.ts`) — «4.8 GB» al iniciar sesión y «4,8 GiB» al abrir Ajustes parecerían dos
     medidas que no cuadran, así que el script pasó a la etiqueta binaria y a la coma.
  3. **La espera, y su fichero.** `~/.cache/gigishell/disco-avisos`, `<epoch>\t<punto>` por línea,
     ventana de 6 h por punto de montaje. **Texto plano y no JSON a propósito**: así
     `disk-monitor.sh` lo lee con un `read` de bash y sigue sin forkear nada más que su `df` —
     meterle un `jq` por un contador de dos columnas sería pagar el arranque de sesión por nada.
     El epoch va **primero** porque un punto de montaje puede llevar espacios: tras el primer
     tabulador, todo es la ruta. Sin esta marca compartida el aviso se volvía ruido —el análisis
     corre en **cada** apertura de Ajustes, así que entrar tres veces a mirar cuánto queda daba
     tres avisos diciendo lo que ya tenías en pantalla— y además el arranque y la primera apertura
     avisaban seguidos de lo mismo. La marca se reescribe **siempre**, también vacía: borrar la de
     un disco que ya no está al límite es la mitad que hace que un disco liberado y vuelto a
     llenar avise **en el acto** en vez de esperar las 6 h. Una marca del **futuro** (reloj
     cambiado, caché de otro equipo) no silencia nada, o el aviso quedaría mudo durante años.

  **No hay ajuste nuevo para esto, y es deliberado**: el aviso es `disco.casi-lleno`, el mismo id
  que ya se configura en Ajustes > Notificaciones > Sistema. Un interruptor «avisar también desde
  el análisis» daría dos sitios donde apagar la misma cosa.

  Deduplica por dispositivo (los subvolúmenes
  btrfs reportan el mismo dispositivo bajo varios puntos de montaje) e ignora particiones por debajo
  de 6 GB (EFI, boot) por no valer la pena vigilarlas. Con **dos o tres sistemas de ficheros al
  límite** (típico con `/` y `/home` separados) salía un popup por cada uno: el barrido de `df` es
  una sola pasada, así que se encolan y se vuelcan al terminarlo, sin retrasar nada
  (`lib/notif-agrupar.sh`). El punto de montaje pasó del **título** al cuerpo — un título fijo es
  lo que permite fundir dos discos en «2 discos casi llenos», y el dato no se pierde, cambia de sitio.
- **`bt-monitor.sh`** — distingue una pérdida de Bluetooth **inesperada** de una intencionada.
  Suscripción única y siempre activa a D-Bus del sistema (barata mientras bloquea) a los eventos
  `PropertiesChanged` de `Connected` y a las llamadas al método `Disconnect()` de BlueZ: una
  desconexión manual (`bluetoothctl`, ajustes de GNOME/KDE, blueman — cualquier cosa que pase por la
  API estándar) se reconoce por esa llamada a `Disconnect()` y se calla si el `Connected: false`
  correspondiente llega dentro de una ventana de 5 s; y si el adaptador está apagado tampoco avisa
  (apagar el Bluetooth no es "perder" un dispositivo). Una pérdida genuina espera 10 s de gracia
  (cubre desconexiones breves con auto-reconexión) antes de confirmar y notificar, comprobando de
  nuevo el estado al vencer esa gracia. El nombre del dispositivo se captura en el momento de la
  caída, mientras todavía está en la caché de `bluetoothd` — puede dejar de resolverse una vez
  desconectado de verdad.
  **Los dispositivos no se pierden de uno en uno**: salirte del alcance o un fallo del controlador
  tumban a la vez los cascos, el ratón y el mando, y eso eran tres críticas con `-t 0` diciendo lo
  mismo (al revés igual: al encender el Bluetooth se reconectan en cascada). El vencimiento de la
  gracia **ya era** el lote para las pérdidas, así que agruparlas no retrasa nada respecto a antes;
  las conexiones, que eran instantáneas, se retienen `COALESCE=2` s — lo justo para que la cascada
  quepa en un aviso, en un popup informativo que dura 6.
  Ese temporizador **ya no es un `( sleep GRACE ) &` por dispositivo sino el `read -t` del bucle
  principal**, por el mismo motivo que en `usb-monitor.sh`: notificar desde el subshell impide ver
  que hay otros dos a punto de decir lo mismo. Efecto lateral bueno: una reconexión dentro de la
  gracia ahora **anula** la pérdida pendiente en memoria en vez de resolverse con dos consultas más
  a `bluetoothctl`.
