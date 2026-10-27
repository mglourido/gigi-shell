# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Mapa: dónde está cada cosa

Este archivo es el índice. Lo detallado vive en `CLAUDE.md` de subcarpetas y en `docs/`, para no cargar en cada sesión lo que solo importa en una zona. Los `CLAUDE.md` de subcarpetas se cargan al leer un archivo de esa carpeta, pero no antes: **antes de editar en una zona, lee su `CLAUDE.md`** (columna «Leer»). Casi todos documentan un fallo silencioso ya medido —efecto sin error visible— que se repite si no se conoce.

| Zona | Qué hay | Leer |
|---|---|---|
| `ags/` | el shell: arquitectura, estado global, estilos y el índice de sus áreas | `ags/CLAUDE.md`, y de ahí el de cada área (abajo) |
| `hypr/` | config de Hyprland en Lua, hypridle/hyprlock, scripts, perfiles de GPU y sus trampas | `hypr/CLAUDE.md`, `docs/hypr-estructura.md`, `docs/hyprland-lua-migracion.md` |
| `inicializador/` | `init.sh` (repone el estado del hardware) y `apps-inicio.sh` | `inicializador/CLAUDE.md` |
| `system/` | ficheros de `/etc` y `/usr/local/bin` (udev, TLP, ClamAV, cámara…) | `system/CLAUDE.md` |
| `system/sddm/` | plantilla del saludador y su tema | `system/sddm/CLAUDE.md`, `system/sddm/tema/README.md` |
| `system/hibernacion/` | helper y preparación de la hibernación | `system/hibernacion/CLAUDE.md` |
| `eventd/` | daemon Rust que sustituye a los sub-monitores de `oom-monitor.sh` | `eventd/CLAUDE.md`, `docs/rust-migracion.md` |
| `almacenamiento/` | binario Rust de análisis y limpieza de disco | `almacenamiento/CLAUDE.md` |
| `guardian/` | daemon Rust root de protección de archivos | `guardian/CLAUDE.md` |
| `audio/` | sonidos de alarmas y notificaciones | `audio/README.md` |
| `bin/`, `install.sh` | symlinks, preflight, bootstrap | secciones «Symlinks» y «Per-machine profiles» de este archivo; `docs/SETUP.md` |

**Áreas de `ags/`** (cada una con su `CLAUDE.md`; rutas desde `ags/`; el índice con más detalle está en `ags/CLAUDE.md`):
- `modulos/barra` (barra, menú del logo Arch, Mantener despierto, escritorios) · `modulos/barra/indicadores` (actualizaciones, micrófono, cadena de estado, captura de pantalla) · `modulos/barra/multimedia/spotify` y `servicios/spotify`
- `servicios/juegos` (detección de juegos) · `servicios/camara` · `servicios/multimedia` (audio: endpoints, presets, mezcla de apps) · `servicios/pantalla` (pantallas, reglas horarias, luz nocturna, brillo) · `servicios/energia` (ahorro, botón de encendido, tapa, GameMode) · `servicios/fondos` (franjas horarias, acento)
- `modulos/ajustes-rapidos` (Quick Settings: Wi-Fi, Bluetooth) · `modulos/notificaciones` y `modulos/notificaciones/sonido` · `modulos/orion` (el lanzador «Jarvis») · `modulos/calendario` (calendario, reloj, Google)
- `modulos/ajustes` (general, atajos, Sistema) · `modulos/ajustes/inicio` · `modulos/ajustes/predeterminadas` · `modulos/ajustes/disco` (Almacenamiento) · `modulos/ajustes/seguridad`

**Documentos de `docs/`:**
- `hyprland-modulos.md` (~5000 líneas, una sección `###` por módulo; `grep -n '^### ' docs/hyprland-modulos.md` las lista): Wake up/`idle-action.sh`, bloqueo de pantalla, salida de suspensión, hibernación, polkit, botón de encendido, tapa, hints de notificaciones de scripts, congelar tareas al jugar, apps al inicio, escáner de apps, reparto/límite/anclaje de ventanas, Steam single-instance, SUPER sin atajo, escritorio ancla, monitores (updates, screencast, recursos), cámara, modo gestos, USB, brillo, puntero hyprcursor, TLP, security monitor y lanzador aislado, ClamAV, protección de archivos, desinstalar apps, almacenamiento y autolimpieza, caché de sombreadores, boot-healthcheck, grabar pantalla, portapapeles, tema KDE, franjas horarias de fondos.
- `hypr-estructura.md` (directorio de `hypr/`, orden de carga de módulos, qué script se dispara desde dónde) · `hyprland-lua-migracion.md` · `deteccion-juegos.md` · `suspension-falsa.md` · `rust-migracion.md`
- `anadir-perfiles-por-equipo.md`, `kitty-profiles.md`, `firefox-profiles.md` (perfiles `laptop`/`desktop`) · `shell-local.md` (config de las shells, compartida y local)
- `SETUP.md` (instalar en otro PC) · `revision-paquetes-install.md` · `superpowers/` (planes y specs de trabajo)

**Datos de usuario y secretos:** `~/.config/gigishell/` y compañía, fuera del repo — ver «Runtime config & secrets» más abajo; la lista de JSON que escribe el shell está en `ags/CLAUDE.md` § «User-editable config».

## What this is

`~/GiGiShell` is a personal Hyprland/Wayland desktop system, organized dotfiles-style:
the real files live here and are "installed" to their canonical
XDG paths via **symlinks**, not copies. The three big components are:

- `ags/` — the desktop shell (AGS v2 / Astal, TypeScript + JSX for GTK4). **Has its
  own detailed `ags/CLAUDE.md` — read that before touching shell code.** Symlinked to `~/.config/ags`.
- `hypr/` — Hyprland config, hyprlock/hypridle, GPU profiles, and background monitor
  scripts. Symlinked to `~/.config/hypr`.
- `inicializador/` — lo que se restaura o se abre al empezar la sesión, llamado desde el autostart
  de Hyprland. `init.sh` repone el estado del hardware guardado (brillo, luz nocturna, wifi,
  bluetooth, volumen); `apps-inicio.sh` abre las apps que el usuario haya puesto en la lista de
  inicio (`~/.config/gigishell/apps-inicio.json`, escrita desde Ajustes > Apps al inicio). Ninguno de
  los dos corre "antes de Hyprland" pese al nombre del directorio: los dos salen de un `exec-once`,
  porque hasta que el compositor no está en pie no hay `WAYLAND_DISPLAY`. Symlinked to
  `~/.config/inicializador`.

Directorios de apoyo (cada uno con su `CLAUDE.md` o README donde importa; ver el mapa de arriba):

- `Wallpapers/` — usado directamente por `wallpaper.sh`, sin symlink.
- `audio/` — sonidos de alarmas y notificaciones, también sin symlink (se leen de `~/GiGiShell/audio`): un `sound-name` se resuelve **primero** contra esta carpeta y solo si falta se delega en el tema de sonidos del sistema, que sin `sound-theme-freedesktop` instalado deja la alarma muda sin dar ningún error. Ver `audio/README.md`.
- `bin/link.sh` (gestor de symlinks), `bin/preflight.sh`, `install.sh` (bootstrap de una máquina nueva) y `docs/` (specs, planes y guías).
- `eventd/` — daemon Rust `gigishell-eventd`: sustituye a los seis sub-monitores de `oom-monitor.sh` cuando está instalado en `~/.local/bin`; una regla de seguridad cambiada en un sitio hay que cambiarla en el otro. Ver `eventd/CLAUDE.md` y `docs/rust-migracion.md`.
- `almacenamiento/` — binario Rust `gigishell-almacenamiento`: análisis y limpieza de Ajustes > Almacenamiento; los scripts de `hypr/scripts/` le ceden el proceso con `exec` y, sin binario, corren su respaldo bash. Ver `almacenamiento/CLAUDE.md`.
- `guardian/` — daemon Rust root `gigishell-guardian`, la **protección de archivos** (BPF LSM + fanotify); se instala **apagado** y su política vive en `/var/lib/gigishell-guardian/`, no en `~/.config`. Ver `guardian/CLAUDE.md`.
- `system/` — ficheros para `/etc` y `/usr/local/bin` que **no** se symlinkean: se instalan con `sudo`. Ver `system/CLAUDE.md`; la plantilla de SDDM y su tema, en `system/sddm/CLAUDE.md`; la hibernación, en `system/hibernacion/CLAUDE.md`.

`mime/`, `qt6ct/`, `menus/`, `kdeglobals`, `mimeapps.list` en la raíz no son un componente
propio: son fragmentos sueltos de integración de escritorio (tema Qt, asociación de apps, menú
XDG, tipos MIME) sin relación funcional entre sí. Cada uno vive en la raíz porque **espeja la
ruta relativa a `~/.config` (o `~/.local/share/mime`) de su destino**, tal como se ve en el mapeo
de `bin/link.sh` — agruparlos en una carpeta temática rompería esa correspondencia 1:1.

**`kdeglobals` y `mimeapps.list` ya NO se enlazan a `~/.config`**: son **bases** que se instalan
(copia con sudo, paso de ficheros de sistema de `install.sh`) en `/etc/xdg/`, y `~/.config/kdeglobals`
y `~/.config/mimeapps.list` quedan como ficheros **locales** del usuario, fuera de git. Enlazados,
cualquier app que guardara un ajuste (Dolphin > Preferencias, «Abrir con», Firefox como
predeterminado, `xdg-mime default`) escribía **dentro del repo**. KConfig y la especificación de
mimeapps hacen cascada sobre `XDG_CONFIG_DIRS`, así que la base sigue valiendo para todo lo que el
usuario no haya cambiado. Consecuencia: **editar esos dos ficheros en el repo no surte efecto hasta
reinstalarlos** (`sudo install -Dm644 ~/GiGiShell/<f> /etc/xdg/<f>`); `link.sh` y `preflight.sh`
avisan cuando difieren. Por qué `/etc/xdg` y no una ruta de `$HOME`: en la sección "Bases de
escritorio" de `bin/link.sh`.

`power-save/config.json` y `orion/favorites.json` viven directamente en `~/.config/power-save/` y
`~/.local/share/orion/`, sin symlink de por medio, junto con el resto de datos de runtime (ver la
sección siguiente): dentro del árbol que gestiona git, un `git clean`, un reset del checkout bare o
restaurar un backup del repo se los llevaría por delante. `bin/link.sh` migra automáticamente
cualquier instalación que todavía tenga el esquema viejo (`GiGiShell/cache/power-save/` y
`GiGiShell/state/orion/`).

## Git caveat

There is no `.git` here — **git commands run from `~/GiGiShell` fail.** GiGiShell is
a subtree of a separate *bare* repo at **`~/.gigishell`** (named so it doesn't collide with a user's
own dotfiles bare repo), operated via the alias `gigishell`
(`git --git-dir=~/.gigishell --work-tree="$HOME"`, defined in the shared bash/zsh/fish config; see
`install.sh`). For `status`/`log`/`blame` use the explicit form
`git --git-dir=$HOME/.gigishell --work-tree=$HOME … -- GiGiShell`: the alias may not exist in a
non-interactive shell.
`install.sh`, `link.sh` and `preflight.sh` still carry a fallback for a legacy `~/.dotfiles`, and it
must stay gated: they use it **only if it is unmistakably ours** (bare, `origin` pointing at
`github.com/mglourido/gigi-shell`, and `GiGiShell/install.sh` in HEAD) — never loosen it, because
they write `core.hooksPath` and run `checkout` on whatever repo they pick. A personal bare that
merely contains GiGiShell (other remote) is left alone.

## Symlinks: install / repair / verify

The symlink layout is the load-bearing mechanism — edits here only take effect once the
canonical XDG paths point back to these files.

```sh
bin/link.sh          # create/repair symlinks; never overwrites a real dir/file (warns instead)
bin/link.sh --check  # report status only (exit 0 if everything OK)
bin/link.sh --force  # back up whatever is in the way (to ~/.gigishell-backup-<date>) then link
```

`link.sh` is idempotent and data-safe. Beyond symlinking it also: migrates the profile photo
from its old home (`~/.cache/gigios/face.png`) to `~/.local/share/gigishell/face.png` — the single
copy, read by both AGS and hyprlock, set from Ajustes > Cuenta and never versioned (it's personal).
Ajustes no copia el original: lo endereza por EXIF, lo recorta cuadrado y lo reduce a 512x512 PNG
(`ags/modulos/ajustes/cuenta/avatar.ts`), que es lo que necesitan los tres círculos donde se ve.
It lives in `XDG_DATA_HOME`, **not** the cache, because nothing regenerates it: there is no master
in the repo, so a cache cleaner would delete it for good. It also
migrates leftover AGS JSON from the old `~/.config/ags/config/` into `~/.config/gigishell/`;
re-applies `core.hooksPath`; comprueba que las bases de `/etc/xdg/` (`kdeglobals`,
`mimeapps.list`) estén instaladas y al día, y **retira los symlinks viejos** de `~/.config` hacia
ellas — solo cuando la base ya existe, para no dejar las apps KDE en tema claro.
`[UiSettings] ColorScheme=BreezeDark` lo lee KColorSchemeManager de la base en `/etc/xdg` aunque una
app KDE reescriba `kdeglobals` y borre el grupo en el fichero del usuario. `install.sh` is the fresh-machine path: it clones the bare
repo into `~/.gigishell`, checks out into `$HOME` (backing up conflicts), then runs `link.sh --force`.

## Per-machine application profiles

Before adding or modifying `laptop`/`desktop` configuration for an application,
read **`docs/anadir-perfiles-por-equipo.md`**. It defines the repository-wide
layout, the `auto|laptop|desktop|status` selector contract, tracked versus local
generated files, installer and preflight integration, and clean-install tests.
Follow the Kitty and Firefox implementations as its reference cases. This rule
also applies to changes made only in `install.sh`, `bin/preflight.sh`, ignore
rules, or profile documentation; do not create an independent profile mechanism
unless the application's limitations are documented there.

## Cómo trabajar aquí

**Confirma antes de decidir la experiencia de usuario.** Asegúrate de tener claro qué pide el
usuario antes de cambiar nada. Si una elección cambia el comportamiento visible, la disposición, el
flujo o la interacción, pregúntalo en vez de inferir la intención.

**Piensa el cambio entero antes de editar.** Revisa el flujo de datos, los puntos de integración y
los casos límite que toca, y anticipa incompatibilidades, regresiones y mantenimiento futuro. Como
norma, cada componente va en su propio archivo: se lee menos y varios componentes pueden tocarse a
la vez sin colisionar. Mantenlos juntos solo si de verdad mejora la cohesión.

**Recursos y fiabilidad.** AGS es parte del escritorio: un fallo te deja sin interfaz.
- La RAM, el disco y la CPU son restricciones de primera clase. Evita fugas, cachés o escrituras
  persistentes sin un beneficio claro y el trabajo pesado en rutas calientes. Se prioriza la
  funcionalidad y el bajo consumo sobre el «código bonito»: un poco de código extra está bien si no
  cambia el coste en ejecución; las asignaciones extra, los objetos retenidos o decenas de MB de RAM
  desperdiciados, no.
- Prefiere actualizaciones por eventos (estado, suscripciones, señales existentes) a sondeos o
  temporizadores.
- Mantén corto lo síncrono y saca lo costoso de render y de eventos frecuentes, para no congelar la
  interfaz.
- Contén o trata de forma defensiva todo error posible (`try/catch`, degradar con seguridad) para
  que un problema aislado no rompa el shell.
- Si pruebas enfoques que luego descartas (estaban mal, no funcionaban o la solución final los
  reemplazó), borra ese código antes de terminar: ni código muerto, ni ramas sin uso, ni utilidades
  abandonadas, ni restos de intentos intermedios.
- Antes de añadir una función o un elemento de interfaz, busca si ya existe algo equivalente y
  reutilízalo o extrae un componente compartido. No fusiones a ciegas si eso encarece la memoria o
  el tiempo de ejecución.
- El código debe funcionar en todas las máquinas y configuraciones donde se espera que corra, no
  solo en una.
- Si aparece un bug recurrente, o una decisión (tomada o descartada) que evite regresiones o explique
  por qué se eligió una solución, documéntalo donde vive el componente: `docs/hyprland-modulos.md` o
  el `CLAUDE.md` de su carpeta.
- Evita dependencias obsoletas si hay alternativa mantenida y compatible. Si cambian dependencias,
  rutas o la estructura de instalación, revisa también `install.sh`, `bin/link.sh` y la
  documentación afectada.

**Estilo y nombres.** Español consistente en los nombres y la documentación orientados al código
(variables, funciones, comentarios), salvo que una API, dependencia o interfaz externa exija otro
idioma. En `ags/`: TypeScript/TSX con widgets funcionales, imports explícitos de `ags/gtk4` y
`gi://...`, y módulos locales por funcionalidad. Los módulos de Hyprland son `.lua` con nombres
descriptivos en minúsculas (`hypr/gigishell/`), y los scripts, `.sh` en kebab-case. CSS: todo en
el parcial del área correspondiente de `ags/estilos/` (`style.scss` es solo la entrada y el orden de
sus `@use` fija la cascada) y coherente con el diseño existente salvo que el usuario pida otra cosa;
antes de crear un bloque, mira si cabe en uno existente y si los estilos pueden agruparse en el
elemento padre en vez de duplicarse en los hijos. `~/.cache/gigishell/out.css` es una caché
regenerada: no se edita, se recompila con `ags/scripts/compilar-css.sh`.

**Control de versiones.**
- Los archivos nuevos hay que prepararlos con `gigishell add` (ver «Git caveat»): uno sin rastrear
  no se sube. Eso no incluye temporales, cachés ni artefactos generados.
- Los archivos de pruebas (`*.test.*`, `*.spec.*` y los demás patrones de `.gitignore`) se quedan
  solo en local aunque formen parte de la validación. No uses `git add -f`: el hook de pre-push los
  rechaza.
- Commits: resúmenes cortos y acotados en español, imperativos o descriptivos. Un pull request
  describe los cambios visibles para el usuario, lista los comandos ejecutados, anota la
  verificación manual en AGS/Hyprland e incluye capturas o grabaciones si cambia la interfaz.

**Pruebas y desarrollo.** Las pruebas de TypeScript usan el ejecutor nativo de Node y viven junto a
la implementación como `*.test.ts`, sobre lógica pura sin imports de GTK (reglas de notificaciones,
historial, limpieza, migraciones de ajustes, lógica de pantalla, parseo de Spotify):
`node --test ruta/al/archivo.test.ts`. Los cambios de interfaz se verifican a mano con `ags quit` y
después `ags run ~/.config/ags/app.ts`. `hyprctl reload` aplica la config de Hyprland sin reiniciar
los `exec-once`; `hyprctl reload full-reset` los reinicia y vuelve a ejecutar
`hypr/gigishell/autostart.lua`.

## Runtime config & secrets live OUTSIDE the repo

User/runtime state is **not** versioned. It lives in `~/.config/gigishell/` (`display.json`,
`system_state.json`, `notifications.json`, `preferences.json`, `almacenamiento.json` —la
autolimpieza de disco, que además leen `hypr/scripts/limpiar-almacenamiento.sh` y
`limpieza-arranque.sh` con `jq`—, `apps-inicio.json` —las apps que se abren al iniciar sesión, que
lee `inicializador/apps-inicio.sh`—, `apps-predeterminadas.json` —el terminal elegido en Ajustes >
Apps predeterminadas, que lee `hypr/scripts/abrir-terminal.sh` en cada SUPER+Q; el resto de esa
sección (navegador, PDF, carpetas…) no va aquí sino a `~/.config/mimeapps.list`, el fichero local
que pisa la base de `/etc/xdg`—, `camara.json` —los controles V4L2 guardados por aparato, que
se reponen solos porque el kernel los pierde al desenchufar o reiniciar— y `camara-uso.json` —lo
que escribe `hypr/scripts/camara-monitor.sh` cuando una app abre la cámara—,
`inactividad.json` —los tiempos vigentes de hypridle (apagar pantalla, bloquear, suspender,
hibernar, bloquear al suspender): `hypr/hypridle.conf` es estático y los recibe como variables
`$IDLE_*` a través de `hypr/scripts/hypridle.sh`, por eso hypridle nunca se lanza a pelo—,
`gestos.json` y `gestos-estado.json` —el modo gestos por cámara: el primero lo escribe Ajustes y lo lee el demonio
al arrancar, el segundo al revés; dos ficheros con un dueño cada uno, no uno con dos escritores— y `hibernacion.json`
—el tiempo total de inactividad hasta hibernar y **cuál de los dos mecanismos** lo cumple; lo lee
`idle-action.sh` para decidir si suspende con alarma RTC o sin ella—, …), plus `~/.config/jarvis/`
and `~/.local/share/jarvis/` for the Orion launcher, `~/.config/power-save/config.json`
(umbral y filtros de modo ahorro) and `~/.local/share/orion/favorites.json` (favoritos del
launcher — ver "What this is" para por qué estos dos últimos dejaron de vivir dentro del repo).
These are data written/read by widgets and scripts at runtime — not code. No todo `config` es
temporal: la configuración explícita de AGS que forma parte del código (`apps_icons`, mapeos
internos, recursos estáticos) pertenece al repo; el estado temporal o editable por el usuario desde
la UI (paneles, preferencias cambiables, valores de sesión) va al `~/.config` del usuario o del
sistema.

`~/.config/gigishell/spotify-creds.json` y `~/.config/gigishell/google-calendar-creds.json` son
**secretos en texto plano** (chmod 600) y no pueden commitearse ni copiarse dentro del repo. Se
crean una sola vez con `ags/scripts/spotify-auth.sh` y `ags/scripts/google-calendar-auth.sh`.

**El calendario nunca escribe dentro del repositorio.** `~/.config/ags` es un symlink a
`~/GiGiShell/ags`, así que un fichero ahí caería en el árbol versionado, y las citas del usuario
—dato personal— no deben acabar en git. Los datos van a
`~/.config/gigishell/calendario.json` (eventos + configuración, con `version` de esquema) y
`~/.config/gigishell/reloj.json` (alarmas). `modulos/calendario/persistencia/repositorio.ts` migra el
antiguo `~/.config/ags/calendar-events.json` una sola vez y **borra el original**: no destructivo
significa que no se pierde nada, no que se deje una copia dentro de git. El orden es escribir el
destino y solo entonces borrar el origen. Las alarmas se persisten; el temporizador y el cronómetro
son de sesión.

## ⚠️ El config es LUA

Desde Hyprland 0.55 hyprlang está deprecado: **si existe `hyprland.lua`, Hyprland lo carga y no
mira ningún `hyprland.conf`**. El config de esta máquina es **`hypr/hyprland.lua`** + los módulos
de **`hypr/gigishell/*.lua`**. Los `.conf` de hyprlang ya no están en el repo (git los conserva si
hiciera falta consultarlos). Los `.conf` que **siguen** en `hypr/` son de **otros programas**
(`hypridle`, `hyprlock`, `hyprpaper`), que mantienen hyprlang a propósito.

**Historia completa, motivo y trampas medidas al portar (léelo antes de tocar cualquier `.lua` bajo
`hypr/`): [`docs/hyprland-lua-migracion.md`](docs/hyprland-lua-migracion.md).** Resumen de lo
imprescindible para no romper la sesión:

- Un error de Lua deja la sesión **sin atajos** salvo `SUPER + Q` (abre kitty). Cada módulo se
  carga con `util.carga` (require + pcall) para que uno roto no tumbe el resto. Si un arranque sale
  mal: TTY (`Ctrl+Alt+F2`) y `gigishell checkout -- GiGiShell/hypr`.
- **`hyprctl keyword` YA NO EXISTE** → `hyprctl eval 'hl.config({...})'`.
- **`hyprctl dispatch` con sintaxis legacy tampoco funciona** → `hyprctl dispatch
  "hl.dsp.exec_cmd('cmd')"`. Ojo: ninguna de las dos formas falla por código de salida en la sesión
  equivocada — hay que mirar el stdout, no el rc. Los scripts migrados llevan fallback inline.
- **Un dispatcher conmutable con argumento de CADENA es un TOGGLE SILENCIOSO.**
  `hl.dsp.dpms('on')` NO enciende: `tableToggleAction()` sale por
  `if (!lua_istable(...)) return TOGGLE_ACTION_TOGGLE` y tira el `'on'`, respondiendo `ok`.
  La forma correcta es la TABLA: `hl.dsp.dpms({ action = 'on' })`. Vale para todo
  `eTogglableAction` (dpms, fullscreen, float, pin, lockgroups…). Costó el bug de la pantalla
  negra al salir de suspensión — ver la sección de suspensión en
  [`docs/hyprland-modulos.md`](docs/hyprland-modulos.md).
- `hyprctl binds -j` devuelve JSON válido desde Hyprland 0.56.1; en 0.56.0 usa la salida de texto por el fallo de esa versión.
- Los callbacks (`hl.on`, binds con función) tienen **timeout de 100 ms**: nada bloqueante dentro.
- **Todo atajo nuevo debe pasar por el envoltorio `bind()`** de `gigishell/keybinds.lua`, no por
  `hl.bind` directo — si no, no da error, solo deja un bind sordo duplicado (ver
  `gigishell/nop-binds.lua` en el documento enlazado).
- AGS **no genera código Lua**: escribe JSON (`display.json`, `devices.json`, `datetime.json` …) y
  el config lo lee con `util.leer_json`. Un JSON ausente o corrupto degrada al valor por defecto sin
  tumbar la sesión.
- Sin decodificador JSON nativo en el intérprete embebido: usa el vendorizado `gigishell/json.lua`.

## Hyprland structure

Directorio, orden de carga de módulos y qué script se dispara desde dónde: [`docs/hypr-estructura.md`](docs/hypr-estructura.md). Detalle y porqué de cada módulo individual: **[`docs/hyprland-modulos.md`](docs/hyprland-modulos.md)**, con una sección `###` por módulo — léela antes de tocar el script o módulo que nombra su título, porque casi todas documentan un fallo silencioso ya medido. Las trampas de `hypr/` (perfil de GPU por máquina, JSON de AGS que lee el config, `render.cm_enabled`, autostart escalonado, modo gestos, tapa del portátil) están en [`hypr/CLAUDE.md`](hypr/CLAUDE.md). Tres que conviene saber ya:

- **Nadie llama a `hyprlock` directamente**: los cuatro sitios que bloquean la sesión pasan por `hypr/scripts/bloquear.sh`, que sortea el fondo del bloqueo y lleva la única guarda de instancia única.
- **El modo gestos por cámara (SUPER+SHIFT+G) es el único daemon de `hypr/scripts/` que NO sale del autostart**: abre la webcam y la deja ocupada para el resto de apps, así que se pide a propósito (`hypr/scripts/gestos.sh`). Lee su sección antes de tocarlo.
- **Editar un `*-monitor.sh` no afecta al que ya está corriendo**: hace falta `pkill -f <script>` + relanzarlo, o `hyprctl reload full-reset` (que sí re-ejecuta el autostart; un `hyprctl reload` normal no).

## Hibernación: un número en la UI, dos mecanismos debajo

Ajustes > Pantalla > Suspensión tiene **un solo** tiempo de hibernación (inactividad total), pero por dentro hay dos mecanismos —systemd `suspend-then-hibernate` con alarma RTC, o el listener `hibernate` de `hypridle.conf`— y elegir mal es un fallo mudo: durante una suspensión el userspace está congelado, así que un listener posterior a la suspensión no se dispara nunca. La autoridad es `~/.config/gigishell/hibernacion.json`. Detalle, preparación y trampas en [`system/hibernacion/CLAUDE.md`](system/hibernacion/CLAUDE.md) y en la sección de hibernación de [`docs/hyprland-modulos.md`](docs/hyprland-modulos.md) — léelos antes de tocar `servicios/energia/hibernacion.ts`, `system/hibernacion/` o el listener `hibernate`.

## init.sh (hardware state restore)

`inicializador/init.sh` lee `~/.config/gigishell/{display,system_state}.json` y repone brillo, luz nocturna, wifi, bluetooth y volumen/mute, con valores por defecto cuando falta una clave. Es la contraparte de la UI de AGS, que *escribe* esos JSON. Dos fallos silenciosos medidos (el brillo no se restaura en un sobremesa; el volumen espera al sink de PipeWire) están en [`inicializador/CLAUDE.md`](inicializador/CLAUDE.md).
