# CLAUDE.md — hypr (Hyprland y sus scripts)

Parte de la guía de GiGiShell (mapa de zonas en el [`CLAUDE.md` raíz](../CLAUDE.md)).

Antes de tocar un `.lua`: sección «El config es LUA» del `CLAUDE.md` raíz y [`docs/hyprland-lua-migracion.md`](../docs/hyprland-lua-migracion.md).

Para el directorio, el orden de carga de módulos y qué script se dispara desde dónde, ver
[`docs/hypr-estructura.md`](docs/hypr-estructura.md). Para el detalle y el porqué de cada módulo
individual (GPU/pantalla/idioma por máquina, Wake up, congelar tareas al jugar, USB, brillo DDC,
puntero/hyprcursor, TLP, security monitor, ClamAV, protección de archivos, desinstalar apps, almacenamiento y autolimpieza,
boot-healthcheck, apps al inicio, grabar pantalla, portapapeles, cámara (ajustes V4L2 y
detector de uso), franjas horarias de fondos,
monitores de batería/temperatura/RAM/disco/BT, y una decena más), ver
**[`docs/hyprland-modulos.md`](docs/hyprland-modulos.md) — léelo antes de
tocar el script o módulo que nombra su título**, porque casi todos documentan un fallo silencioso
ya medido (efecto sin error visible) que se repite si no se conoce.

Puntos que conviene recordar sin abrir el documento:

- El **perfil de GPU** es machine-specific y lo elige `~/.config/gigishell/gpu-perfil` (fichero local
  fuera del repo), no un comentario a mano. Lo escribe el instalador (paso `gpu`, detección por
  clase PCI en `/sys`) y **nunca pisa uno que ya exista**. `integrada.lua` es el perfil vacío a
  propósito de una Intel/AMD sola: con el fichero ausente, `gpu.lua` avisa en pantalla en cada
  inicio de sesión porque no puede distinguir «no hay nada que configurar» de «no lo he elegido».
- `gigishell/dispositivos.lua`, `gigishell/pantalla.lua` y `gigishell/env.lua` leen JSON de
  `~/.config/gigishell/` (dispositivos, pantalla, idioma) escrito por AGS — ausencia de clave = no se
  aplica nada, nunca un valor de fábrica que sorprenda en otra máquina.
- `render.cm_enabled` está deliberadamente **off**: `hyprsunset` posee la CTM de KMS para la luz
  nocturna, y el color management de Hyprland encima lava la imagen.
- El arranque (`gigishell/autostart.lua`) está **escalonado a propósito** (t=0 lo visible, t=3..6
  eventos, t=8..15 sondeos, t=20..30 lo caro) — no captures ese detalle sin leer el documento si vas
  a tocar los tiempos.
- **Nadie llama a `hyprlock` directamente**: los cuatro sitios que bloquean la sesión pasan por
  `hypr/scripts/bloquear.sh`, que sortea el fondo del bloqueo (un wallpaper al azar, vía un symlink
  sin extensión en la caché — hyprlang no sabe sustituir comandos) y lleva la única guarda de
  instancia única, que hyprlock no tiene. Ver su sección en
  [`docs/hyprland-modulos.md`](docs/hyprland-modulos.md).
- **El modo gestos por cámara (SUPER+SHIFT+G) es el único daemon de `hypr/scripts/` que NO sale del
  autostart**: abre la webcam, cuesta medio núcleo y la deja ocupada para el resto de apps (no se
  puede hacer una videollamada con él encendido), así que se pide a propósito. Lo enciende y apaga
  `hypr/scripts/gestos.sh`; el trabajo está en `hypr/scripts/gestos/` y su entorno (venv con
  MediaPipe + modelo de manos) lo instala `install.sh` fuera del repo. **Antes de
  tocarlo lee su sección en [`docs/hyprland-modulos.md`](docs/hyprland-modulos.md)**: documenta que
  **el pellizco NO saca la ventana del mosaico** (hacerlo movía bien pero la dejaba sin recolocarse
  nunca más: una tilada se recoloca por pasos con la secuencia `preselect`/`movewindow`/`preselect
  none`, y solo una que YA estaba flotando recibe coordenadas), que el arrastre nativo
  (`hl.dsp.window.drag`) **no sigue un cursor warpado** y además acepta cualquier argumento
  respondiendo `ok`, que `w.at` de `HL.Window` es de SOLO LECTURA pero un `pcall` alrededor de la
  asignación devuelve `ok=true, err=nil`, que `hl.dsp.window.move` responde `ok` sin mover nada
  sobre una ventana en mosaico, que un puño cerrado es geométricamente indistinguible de un
  pellizco por distancia pulgar-índice, que OpenCV 5 ya no abre la cámara por nombre **ni pasa de
  640x480 sin pedir MJPG explícitamente** (se acepta, se ignora y no da ningún error), y sobre todo
  que **UN SOLO frame sin mano mataba el gesto entero**: el motor lo trataba como «la mano ya no
  está», tiraba el trayecto y volvía a BUSCANDO con 0,40 s de rearme — y perder un frame es lo
  NORMAL al mover la mano deprisa, porque sale borrosa. Era la causa del «a veces va y a veces no».
  Y que **`num_hands=1` deja que una CARA detectada como mano TAPE la mano de verdad** (la cara
  puntúa 0,98: ocupa la única plaza y la mano no llega, que desde fuera se ve como «no detecta
  nada»); se piden dos y se elige por CONTINUIDAD, no por puntuación. Para medir qué ve la cámara
  sin tocar el escritorio: `gestos.py --diagnostico`, que mide en dos fases —primero SIN manos, para
  contar falsos positivos— porque la tasa de detección a solas no distingue una mano de una cara.

- **La TAPA del portátil no se le quita a logind desde `/etc`, y es a propósito.** Qué hace cerrar
  la tapa lo decide Ajustes > Energía (`accionTapa` en `preferences.json`, ejecutada por
  `gigishell/tapa.lua` desde `switch:on:Lid Switch`), pero para eso hay que desactivar
  `HandleLidSwitch`, que es de logind y de fábrica suspende. Con el botón de encendido eso se
  resolvió con un `ignore` permanente en `/etc`; con la tapa **no se puede**: valdría también para
  el saludador y para una sesión caída, y cerrar el portátil en la pantalla de login lo dejaría
  encendido dentro de la mochila, sin ningún síntoma hasta que quema. Se usa un **inhibidor** de
  logind (sin privilegios) que sostiene `hypr/scripts/tapa-inhibidor.sh` mientras Hyprland viva:
  si la sesión se cae, logind recupera la tapa y vuelve a suspender. Ver su sección en
  [`docs/hyprland-modulos.md`](docs/hyprland-modulos.md) antes de tocar nada de esto — documenta
  también por qué el inhibidor se ata a un `tail --pid` y no a un `sleep`, y por qué «no hacer nada
  si hay una pantalla externa» tiene que reimplementarse a mano.
- **Puente con AGS.** Los requests se registran en `ags/puentes.ts`, y se buscan solo por el
  primer argumento. Un atajo sin reserva usa `ags request` directo. **Quien tenga reserva usa
  `hypr/scripts/pedir-ags.sh`**: `ags request` solo falla con AGS caído, espera sin límite con AGS
  congelado, y `unknown request` o `error: …` salen con código 0, así que un `||` no los ve. Límite:
  al agotarse los 2 s, AGS aún puede atender el request cuando se descongele.
- **Editar un `*-monitor.sh` no afecta al que ya está corriendo**: hace falta `pkill -f
  <script>` + relanzarlo, o `hyprctl reload full-reset` (que sí re-ejecuta el autostart; un
  `hyprctl reload` normal no).
