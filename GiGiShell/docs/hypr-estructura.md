# Estructura de `hypr/`

Mapa de qué hay en `hypr/` y en qué orden se carga. Para instalar, ver
[SETUP.md](SETUP.md); para el **porqué** de cada decisión de diseño (por qué el
arranque se escalona así, por qué un fichero se genera y no se edita a mano, qué
falla si tocas X sin saber Y) ver las secciones de Hyprland de
[`../CLAUDE.md`](../CLAUDE.md), que este documento no duplica.

> **El config es Lua, no hyprlang.** Desde Hyprland 0.55, si existe
> `hyprland.lua` el compositor lo carga y **no mira ningún `hyprland.conf`**. Los
> `.conf` de hyprlang se borraron al terminar la migración (2026-07-23); `git`
> los conserva si hiciera falta consultarlos. Los `.conf` que siguen aquí son de
> **otros programas** (`hypridle`, `hyprlock`, `hyprpaper`), que mantienen
> hyprlang a propósito.

## Árbol de directorios

```text
hypr/                       (symlink: ~/.config/hypr)
├── hyprland.lua             punto de entrada; render{} + la lista de módulos
├── gigishell/                  los módulos del config (ver tabla)
│   ├── util.lua             carga protegida, lectura de JSON, avisos en pantalla
│   ├── json.lua             decodificador JSON vendorizado (Hyprland no trae uno)
│   ├── variables.lua        nombres de app y rutas (las viejas `$variables`)
│   └── gpu/                 un módulo por hardware; lo elige un fichero local
│       ├── laptop-hibrida.lua
│       ├── sobremesa-nvidia.lua
│       └── integrada.lua
│   ├── pantalla.lua         lee display.json (Ajustes > Pantalla)
│   ├── dispositivos.lua     lee devices.json (Ajustes > Dispositivos)
├── hypridle.conf            otro binario; lo lanza el autostart
├── hyprlock.conf            pantalla de bloqueo, base sin meteorología
├── hyprlock-tiempo.conf     añade meteorología si hay ubicación permitida
├── hyprpaper.conf           vacío, sin uso (el wallpaper va por awww)
├── shaders/                 shaders de corrección de color (daltonismo)
│   └── daltonismo-{protanopia,deuteranopia,tritanopia}.frag
├── scripts/                 todo el código de scripting (ver abajo)
│   ├── lib/
│   │   └── gaming-gate.sh   se SOURCEA desde otros scripts, no se ejecuta solo
│   └── __pycache__/         generado por Python, gitignored
└── logs/                    runtime, gitignored (`boot-healthcheck.log`)
```

## Carga de `hyprland.lua`

`hyprland.lua` no configura casi nada por sí mismo: fija `render.cm_enabled = false`
(lo gestiona `hyprsunset`, no Hyprland — ver `CLAUDE.md`) y carga los módulos de
`gigishell/` en este orden exacto. Cada uno entra por `util.carga()` (`require` +
`pcall`): **un módulo roto avisa en pantalla y no tumba el resto**, porque un
error de Lua sin capturar deja la sesión sin atajos.

| # | Módulo | Contenido | Quién lo edita |
| --- | --- | --- | --- |
| 1 | `gigishell/env.lua` | Variables de entorno del sistema (cursor, Qt, `LC_TIME`) | a mano — **el idioma lo LEE** de `datetime.json` |
| 2 | `gigishell/monitores.lua` | Regla comodín: preferido, escala 1 (fallback) | a mano |
| 3 | `gigishell/pantalla.lua` | Resolución/Hz/escala/VRR por monitor concreto (`desc:`) | a mano — **el dato** lo escribe AGS en `display.json` |
| 4 | `gigishell/input.lua` | Teclado, ratón, touchpad y gestos (valores base) | a mano |
| 5 | `gigishell/ventanas.lua` | Gaps, bordes, sombras, blur, opacidad, `layout` + `sin_smart_split()`, el envoltorio que usan los cuatro caminos que mueven ventanas entre escritorios, y `opacidad_ahorro()` | a mano — **la opacidad forzada del modo ahorro** la escribe AGS en `opacidad-ventanas.json` |
| 6 | `gigishell/animaciones.lua` | Curvas y animaciones | a mano |
| 7 | `gigishell/reglas.lua` | Reglas de ventana y de capa | a mano |
| 8 | `gigishell/compactar.lua` | `GiGiShell.compactar()` — renumera escritorios | a mano |
| 9 | `gigishell/boton-apagado.lua` | `GiGiShell.boton_apagado()` — el botón físico | a mano |
| 10 | `gigishell/tapa.lua` | `GiGiShell.tapa_cerrada()` / `GiGiShell.tapa_abierta()` — qué hace el portátil al cerrar la tapa (reutiliza las acciones de `boton-apagado`) | a mano — **la acción** la escribe AGS en `preferences.json` |
| 11 | `gigishell/daltonismo.lua` | `GiGiShell.daltonismo(modo)` — shader de accesibilidad | a mano |
| 12 | `gigishell/orion.lua` | `GiGiShell.toggle_orion()` — el atajo del launcher | a mano |
| 13 | `gigishell/ancla-escritorio.lua` | `GiGiShell.anclar_escritorio()` / `GiGiShell.saltar_ancla()` — ir al escritorio ancla y volver | a mano |
| 14 | `gigishell/keybinds.lua` | Todos los atajos + `GiGiShell.toggle_gaps()` | a mano |
| 15 | `gigishell/autostart.lua` | Lo que arranca la sesión, con el calendario escalonado | a mano |
| 16 | `gigishell/escaner-apps.lua` | Salto al escritorio donde abrieron las apps de autostart | a mano |
| 17 | `gigishell/reparto-ventanas.lua` | Que una ventana no acabe estrujada: al abrirse (elige qué se parte y por qué lado) y al soltarla arrastrada (le hace hueco a costa de los vecinos) | a mano |
| 18 | `gigishell/limite-ventanas.lua` | Tope de ventanas en mosaico por escritorio (mueve la que sobra) | a mano |
| 19 | `gigishell/permisos.lua` | Permisos del ecosistema (requiere reiniciar Hyprland) | a mano |
| 20 | `gigishell/gpu.lua` | Elige el perfil de GPU y carga `gigishell/gpu/<perfil>.lua` | **fichero local**, ver abajo |
| 21 | `gigishell/gaming.lua` | Ajustes de rendimiento válidos en ambas máquinas | a mano |
| 22 | `gigishell/userprefs.lua` | Overrides personales sueltos | a mano |
| 23 | `gigishell/dispositivos.lua` | Teclado/ratón/touchpad concretos; va DESPUÉS de `userprefs` a propósito | a mano — **el dato** lo escribe AGS en `devices.json` |
| 24 | `gigishell/env-firefox.lua` | Variables portables Firefox+Wayland | a mano |
| 25 | `gigishell/nop-binds.lua` | Binds sordos: absorbe SUPER + tecla que no sea atajo | a mano (es un bucle: se recalcula solo) |

**El orden no es estético**: `gigishell/pantalla` pisa al comodín de monitores,
`gigishell/dispositivos` pisa a `userprefs`, y `nop-binds` va el último porque
necesita saber qué combinaciones ya usó `keybinds`.

Al final, `hyprland.lua` llama a `GiGiShell.daltonismo()` — el equivalente al viejo
`exec =`: reaplica el shader de accesibilidad también en cada `hyprctl reload`,
no solo al arrancar.

**Lo que AGS ajusta desde la UI llega por JSON, no por código generado.**
`gigishell/pantalla.lua` lee `~/.config/gigishell/display.json`, `gigishell/dispositivos.lua`
lee `devices.json` y `gigishell/env.lua` saca el idioma de `datetime.json`; AGS
escribe el dato y el config decide, aprovechando que Lua tiene condiciones y
bucles. Antes había dos chunks generados (`monitor-settings.lua`,
`input-settings.lua`) cargados con un `util.carga_opcional` que ya no existe: el
mismo dato se escribía dos veces y los ficheros, machine-specific, acababan
versionados. Un JSON ausente o corrupto degrada al comodín (240 Hz → 60,
escala 1.25 → 1) sin tumbar la sesión — `util.leer_json` devuelve `nil` y el
módulo sale sin aplicar nada.

## `hyprpaper.conf` está vacío y sin uso

No lo lanza nadie. El wallpaper lo gestiona `awww` (`awww-daemon` +
`scripts/wallpaper.sh`).

## `hypridle.conf` / `hyprlock.conf`: otros programas, otro formato

Son binarios `hypr*` **separados del compositor** y siguen en hyprlang a
propósito (así lo dice el anuncio oficial de Hyprland 0.55: no necesitan un
lenguaje Turing-completo). `hypridle` lo lanza `gigishell/autostart.lua`, y sus
`on-timeout` no ejecutan la acción directamente sino que pasan por
`scripts/idle-action.sh` (la puerta del "Wake up" — ver `CLAUDE.md`).
`hyprlock.conf` no se lanza nunca por sí solo: `hypridle` (`lock_cmd`,
`before_sleep_cmd`), `idle-action.sh` y AGS pasan por `scripts/bloquear.sh`.
Este avanza la cola de `scripts/fondo-bloqueo.py`, incluso entre bloqueos:
hyprlock recarga cada 30 s con fundido y recorre los fondos sin repetir hasta
agotar cada vuelta. El widget
del tiempo solo se añade si `~/.config/gigishell/datetime.json` permite una ubicación
con coordenadas; entonces consulta Open-Meteo cada diez minutos mientras dura el bloqueo.

**Primera tecla tras despertar.** Si la pantalla estaba apagada, Hyprland puede
usar esa tecla para activar DPMS antes de entregarla al bloqueo. Tras suspensión
también hay [un fallo abierto en hyprlock](https://github.com/hyprwm/hyprlock/issues/499)
por el que la primera pulsación puede perderse con la pantalla ya visible. Las
opciones visuales del campo no reenvían ese evento: no se deben simular teclas
ni modificar PAM para compensarlo. El campo mantiene los puntos visibles para
que el usuario vea cuántos caracteres se registraron.

## Perfiles de GPU: `gigishell/gpu/`

Cuatro módulos, uno por hardware. **Ya no se descomenta una línea**: el perfil de
cada máquina lo dice `~/.config/gigishell/gpu-perfil`, un fichero local de una línea
**fuera del repo** (la elección de máquina es estado local, como manda
[`anadir-perfiles-por-equipo.md`](anadir-perfiles-por-equipo.md)):

```sh
echo sobremesa-nvidia > ~/.config/gigishell/gpu-perfil
```

Lo escribe el instalador (paso `gpu`) leyendo las clases PCI de `/sys`, y **nunca pisa
un fichero que ya exista**: si el acierto automático no te vale, lo cambiás a mano y el
instalador respeta tu elección en las siguientes pasadas.

`integrada.lua` no configura nada y ESE es su cometido: es la forma de decir «esta
máquina es Intel o AMD sola, no hay nada que ajustar». Antes eso se decía dejando el
fichero ausente, y `gpu.lua` no puede distinguir «todavía no lo he elegido» de «lo elegí
y es que no hace falta»: avisaba en pantalla en CADA inicio de sesión, para siempre.

Ausente o con un nombre inválido = no se aplica ningún perfil y sale un aviso en
pantalla; el compositor arranca igual (fail-open).

## `hypr/scripts/`: categorías

No todos arrancan igual. Cuatro disparadores distintos:

**1. Daemons de `gigishell/autostart.lua`**, con el calendario escalonado (motivo
completo en la cabecera de ese módulo y en `CLAUDE.md`):

| t= | Script | Por qué ahí |
| --- | --- | --- |
| 0 | `wallpaper.sh`, `limpiar-portapapeles.sh` + `clipboard-history.sh start`, `oom-monitor.sh`, `tapa-inhibidor.sh` | se ve, o no puede perder eventos |
| 3–6,5 | `bt-monitor.sh`, `usb-monitor.sh`, `wifi-monitor.sh`, `screencast-monitor.sh`, `camara-monitor.sh` | dirigidos por eventos, compiten con el servicio al que se enganchan |
| 8–15 | `ram-monitor.sh`, `temp-monitor.sh`, `battery-monitor.sh`, `disk-monitor.sh` | sondeos de estado, nada urgente al segundo 0 |
| 20–30 | `updates-monitor.sh`, `boot-healthcheck.sh` | lo caro (red, journal completo, SMART) |
| 45 | `limpieza-arranque.sh` | el único que puede borrar decenas de miles de ficheros; **no es un daemon**: lee un JSON, decide y sale (2,9 ms si no toca) |

El escáner de apps de inicio ya no es un script: vive en
`gigishell/escaner-apps.lua`, que escucha `window.open` con datos ya tipados en vez
de parsear el socket de eventos a mano.

`tapa-inhibidor.sh` es el raro de la tabla: no es un monitor ni sondea nada. Le
quita a logind el interruptor de la **tapa** (inhibidor `handle-lid-switch`, sin
privilegios) para que la acción la decida Ajustes > Energía, y se queda bloqueado
en un `tail --pid` que muere con Hyprland — a propósito, para que al caer la sesión
logind recupere la tapa y vuelva a suspender. Ver su sección en
[`hyprland-modulos.md`](hyprland-modulos.md).

**2. Atajos de teclado** (`gigishell/keybinds.lua`): `rofi-launch.py`
(`SUPER+SPACE`), `clipboard-history.sh picker` (`SUPER+V`), `emoji-picker.sh`
(`SUPER+.`), `grabar-pantalla.sh`
/ `grabar-pantalla.sh ventana` (`CTRL+SHIFT+F` / `CTRL+SHIFT+S`), `gestos.sh`
(`SUPER+SHIFT+G`).

`gestos.sh` es el único de esa lista que enciende y apaga un **daemon**, y el
único daemon de `hypr/scripts/` que **no** sale de `autostart.lua`: abre la
webcam, cuesta medio núcleo y deja la cámara ocupada para el resto de apps, así
que se pide a propósito. El trabajo vive en `scripts/gestos/` (tres módulos
Python: motor puro con pruebas, puente con el compositor por socket, y el bucle
de cámara). Ver su sección en `docs/hyprland-modulos.md`.

Cinco atajos **ya no llaman a ningún script**: son funciones Lua dentro del
propio config — pegar ventanas (`GiGiShell.toggle_gaps`), compactar escritorios
(`GiGiShell.compactar`), el botón de encendido (`GiGiShell.boton_apagado`), el filtro
de daltonismo (`GiGiShell.daltonismo`) y el launcher Orion
(`GiGiShell.toggle_orion`, `SUPER+ALT+SPACE`). AGS invoca las que necesita por
`hyprctl eval 'GiGiShell.<fn>(…)'`.

**3. Invocados por AGS** (toggles de Ajustes, con `pkill` + re-exec en caliente
donde aplica): `updates-monitor.sh`, `screencast-monitor.sh` (interruptores
maestros), `analizar-almacenamiento.sh todo`, `limpiar-almacenamiento.sh <accion>`
y `limpieza-arranque.sh --ahora` (Ajustes > Almacenamiento; ninguno de los tres
es residente, así que no llevan `pkill`),
`wallpaper.sh <ruta>` / `--random` (Orion), `lanzar-anclado.py`
(lanzador de Orion).

`usb-monitor.sh` llama él mismo a `usb-eject.sh` (botón "Expulsar" de la
notificación de conexión) y a `usb-repair.sh` (automático en cuanto detecta un
volumen sucio, sin botón ni pregunta — ver `CLAUDE.md`).

**4. Seguridad y sandboxing**, encadenados entre sí más que disparados desde
fuera: `oom-monitor.sh` (el propio daemon) llama a `run-untrusted.sh` (botón
"Lanzar aislado") y a `scan-file.sh` (botón "Escanear" y también usado desde
Ajustes > Seguridad); `scan-downloads.sh` es el escaneo forzado desde esa misma
sección.

`anclaje.py` es aparte: no lo lanza nadie directamente, lo importan como
observador tanto `rofi-launch.py` como `lanzar-anclado.py` (ver `CLAUDE.md`,
sección de anclaje de ventanas).

`scripts/lib/gaming-gate.sh` no es un script ejecutable por sí mismo — se
`source`ea desde `updates-monitor.sh` y desde `oom-monitor.sh` (sus
sub-monitores SMART y unidades) para congelar ese sondeo caro mientras juegas o
en modo ahorro. `monitor_downloads` (también dentro de `oom-monitor.sh`) usa en
cambio su propia pausa independiente (`dlPauseWhileGaming`), no esta librería
— ver `CLAUDE.md`.

## Ver también

- [`SETUP.md`](SETUP.md) — instalación en una máquina nueva, perfil de GPU,
  pasos manuales.
- [`../CLAUDE.md`](../CLAUDE.md) — el porqué detrás de cada script y cada
  decisión no obvia (las trampas medidas de la API Lua, el hint
  `x-gigishell-source`, por qué `gaming-gate.sh` congela lo que congela y no más,
  la puerta del Wake up, USB, brillo, seguridad…).
