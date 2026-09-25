# Instalar GiGiShell en otro PC

## Instalación recomendada

En una instalación de **Arch Linux o CachyOS**, con conexión a Internet y `paru` o `yay`
disponible, ejecuta:

```sh
curl -fsSL https://raw.githubusercontent.com/mglourido/gigi-shell/main/GiGiShell/install.sh | bash
```

El instalador se encarga de:

- instalar Hyprland, AGS/Astal y las herramientas del escritorio;
- descargar la rama `laptop` mediante el repositorio bare de dotfiles;
- respaldar los archivos locales que entren en conflicto;
- crear los enlaces de `~/.config/ags`, `~/.config/hypr` y demás rutas XDG;
- elegir los perfiles de Kitty y Firefox según la presencia de una batería;
- compilar `style.scss` a `out.css`;
- reconstruir la caché de aplicaciones de Dolphin;
- copiar a `/etc` (con `sudo`) los ficheros de `system/`: la regla udev que evita perder datos al
  retirar un USB y la carga de `i2c-dev`, sin la cual no hay brillo por DDC/CI en un sobremesa;
- ejecutar la validación final.

El mismo comando sirve para actualizar un equipo que ya tenga GiGiShell instalado: hace
`fetch` en `~/.dotfiles`, avanza el checkout local hasta `origin/laptop` y vuelve a
comprobar los enlaces. Un `git pull` realizado en otro clon independiente no actualiza
por sí solo la copia desplegada por `~/.dotfiles`.

El perfil de Kitty puede forzarse sin mantener ramas distintas para cada
máquina:

```sh
curl -fsSL https://raw.githubusercontent.com/mglourido/gigi-shell/main/GiGiShell/install.sh \
  | KITTY_PROFILE=desktop bash
```

`KITTY_PROFILE` admite `auto` (predeterminado), `laptop` y `desktop`. Consulta
[los perfiles de Kitty](kitty-profiles.md) para cambiarlo después de la
instalación y diagnosticar el renderizado.

Firefox se selecciona del mismo modo con `FIREFOX_PROFILE=auto|laptop|desktop`.
El instalador localiza o crea su perfil predeterminado y enlaza allí el
`user.js`; no depende del nombre aleatorio que Firefox asigne a la carpeta.
Consulta [los perfiles de Firefox](firefox-profiles.md) para ver los
ajustes y el procedimiento de cambio.

Las shells (bash, zsh, fish) separan la personalización compartida, versionada,
de un fichero local por equipo que no se versiona y es donde escriben los
instaladores de herramientas (cargo, bun, opam...). `bin/link.sh` crea los
locales que falten; ver [configuración local de las shells](shell-local.md).

**AGS sí es obligatorio.** GiGiShell no usa una barra o centro de notificaciones externo:
`ags` ejecuta el shell completo y `AstalNotifd` proporciona el daemon y la interfaz de
notificaciones. El instalador añade `aylurs-gtk-shell-git`, `libastal-meta` y `libnotify`;
el preflight comprueba explícitamente que `ags`, `notify-send` y todos los typelibs Astal
estén disponibles.

### Después del instalador

Solo quedan estas decisiones personales:

1. **GPU:** ya no hace falta hacer nada. El instalador (paso `gpu`) lee las clases PCI de
   `/sys` y escribe el perfil en `~/.config/gigishell/gpu-perfil`; te dice cuál eligió al
   terminar. Si el acierto no te vale, escribí otro nombre a mano: el fichero **nunca se
   pisa** si ya existe. Consulta la §9.
2. **Spotify:** ejecuta `~/.config/ags/scripts/spotify-auth.sh` si quieres integrar tu
   cuenta. Es opcional y las credenciales nunca se incluyen en Git.
3. **Seguridad:** `install.sh` ya descarga las firmas de ClamAV; si te saltaste ese paso, `sudo freshclam` una vez. A partir de ahí se comprueban al iniciar sesión y se actualizan solas si están viejas (interruptor «Actualizar las firmas al iniciar sesión» en Ajustes > Seguridad > Antivirus); durante la sesión no corre ningún `clamav-freshclam` ni temporizador equivalente.
4. **Sensores:** ejecuta `sudo sensors-detect` solamente si quieres monitorización de
   temperatura y el equipo la necesita.

Finalmente, cierra y vuelve a abrir la sesión. Puedes comprobar el resultado con:

```sh
~/GiGiShell/bin/preflight.sh --installed
ags run ~/.config/ags/app.ts
```

Para iniciar Hyprland desde una TTY puedes usar:

```sh
uwsm start hyprland.desktop
```

Si utilizas un display manager, selecciona la sesión **Hyprland (uwsm)**.

La foto personal, las fuentes propietarias del lock screen y la configuración de Spotify
son opcionales; su ausencia no impide arrancar GiGiShell.

### Instalación sin gestionar paquetes

Si ya instalaste las dependencias o no usas Arch/CachyOS:

```sh
curl -fsSL https://raw.githubusercontent.com/mglourido/gigi-shell/main/GiGiShell/install.sh | INSTALL_PACKAGES=0 bash
```

En otra distribución tendrás que traducir manualmente los paquetes descritos debajo.

---

Las siguientes secciones son la referencia detallada de componentes, dependencias,
hardware, datos personales y resolución de problemas. No es necesario ejecutar cada
bloque de `pacman` después de haber usado el instalador recomendado.

## 1. Base: Hyprland + utilidades de sesión

```sh
sudo pacman -S util-linux polkit hyprland hyprlock hypridle hyprpolkitagent hyprsunset uwsm \
  xdg-desktop-portal-hyprland xdg-desktop-portal-gtk qt6-wayland qt6ct breeze
```

Esta instalación usa deliberadamente la pila estable. No añadas
`hyprqt6engine` ni `hyprqt6engine-git`: GiGiShell ya integra las aplicaciones Qt
mediante `qt6ct` y Breeze. `hyprutils` y `hyprlang` tampoco se enumeran porque
son dependencias internas de `hyprland` y Pacman debe resolver sus variantes
estables. El instalador se detiene antes de modificar paquetes si encuentra
`hyprland-git`, `hyprqt6engine-git`, `hyprutils-git` o `hyprlang-git`.

Si `hyprqt6engine-git` se instaló por error, recupera la pila estable de forma
interactiva:

```sh
sudo pacman -R hyprqt6engine-git
sudo pacman -S hyprland hyprutils hyprlang
```

En el segundo comando acepta retirar las variantes `-git`. No uses
`--noconfirm`: la respuesta predeterminada de Pacman ante esos conflictos es no
retirarlas. Verifica después con
`Hyprland --verify-config -c ~/.config/hypr/hyprland.lua`.

- `hypridle` gestiona apagar pantalla / bloquear / suspender (`hypridle.conf`).
- `hyprlock` es la pantalla de bloqueo (`hyprlock.conf`, usa `~/.local/share/gigishell/face.png`
  y el label `$USER` — no hace falta nada extra).
- `hyprpolkitagent` se lanza en `gigishell/autostart.lua` desde la ruta fija
  `/usr/lib/hyprpolkitagent/hyprpolkitagent`; si el paquete instala el binario en otro
  sitio en la otra distro, ajusta esa línea.
- `polkit` proporciona `pkexec`, que usan los ajustes de fecha, idioma e impresoras;
  `util-linux` proporciona `rfkill`, usado por el chequeo de hardware.
- `hyprsunset` es la luz nocturna (la activa `~/.config/inicializador/init.sh` leyendo
  `~/.config/gigishell/display.json`). **Nota de `hyprland.lua`**: `render.cm_enabled = false`
  está así a propósito porque el CTM de color management de Hyprland pisa el de
  `hyprsunset` y se ve lavado — no lo actives sin desactivar uno de los dos.
- `uwsm` gestiona la sesión de Hyprland mediante systemd de usuario.
- Los portales de Hyprland y GTK son necesarios para compartir pantalla y abrir
  selectores de archivos en aplicaciones Wayland.

## 2. AGS (el shell en sí)

AGS v2 (Aylur's GTK Shell) **no está en los repos oficiales de Arch**, viene de AUR:

```sh
paru -S aylurs-gtk-shell-git libastal-meta
```

`libastal-meta` trae todas las libs de Astal que usa el shell (`AstalWp`, `AstalHyprland`,
`AstalNetwork`, `AstalBluetooth`, `AstalMpris`, `AstalNotifd`, `AstalBattery`, `AstalTray`).
`AstalNotifd` es el servidor de notificaciones de la sesión: no instales otro daemon como
`dunst` o `mako` a la vez, porque competirían por el mismo nombre de D-Bus.

**Y no basta con no lanzarlo: hay que enmascararlo.** Un `dunst` meramente *instalado* y que
nadie arranca resucita solo — trae `/usr/share/dbus-1/services/org.knopwob.dunst.service`, que
registra `Name=org.freedesktop.Notifications` → `SystemdService=dunst.service`, así que la
**primera notificación de la sesión** hace que D-Bus lo active vía systemd. En el arranque eso
ocurre antes de que AGS esté listo, y como el nombre solo lo puede tener un proceso, dunst se
queda con él para el resto de la sesión: `AstalNotifd` nunca lo consigue, la señal `notified` no
se emite jamás y `ingest()` (único punto de entrada, `modulos/notificaciones/NotificationPopup.tsx`)
no llega a ejecutarse. Síntoma: los popups que ves son los de dunst y **`notifications.json` y
`notif-history.json` se quedan vacíos** — el historial no guarda nada y parece que falta código,
cuando el shell simplemente no recibe una sola notificación.

Astal *sí* se queja (`proxy.vala: cannot get proxy: dunst is already running`), pero por el
**stdout de `ags`**: lanzado desde `gigishell/autostart.lua` ese aviso no llega ni a `hyprland.log` ni al
journal, así que solo lo ve quien arranca el shell a mano. Por eso el shell **se autodiagnostica**
desde `ags/modulos/notificaciones/daemon/comprobacion.ts`: comprueba quién tiene el nombre, y si no es él,
lanza una notificación crítica (que pinta el propio daemon intruso, que es el que funciona) y
sustituye el "Historial vacío"/"Sin notificaciones" por un banner que nombra al culpable y da el
comando exacto. Se apaga solo, sin reiniciar AGS, en cuanto enmascaras al rival.

`systemctl --user disable dunst.service` **no sirve** (la unidad es `static`, no tiene `[Install]`,
existe solo para la activación por D-Bus). Hay que enmascararla:

```sh
systemctl --user mask dunst.service   # bloquea la reactivación por D-Bus
systemctl --user stop dunst.service   # suelta el nombre ahora
```

No hace falta reiniciar AGS ni desinstalar dunst: `AstalNotifd` queda **en cola** por el nombre y
lo toma en cuanto dunst lo libera. Comprobación:

```sh
busctl --user list | grep org.freedesktop.Notifications   # debe apuntar al PID de gjs, no a dunst
```

Dependencias que arrastra `aylurs-gtk-shell-git` (para que compile/corra el bundler):
`gjs`, `gtk4-layer-shell`, `gobject-introspection`, `npm`, y opcionalmente `dart-sass`
(compilar `style.scss`) y `blueprint-compiler` (no se usa aquí, pero es dependencia
opcional del paquete).

```sh
sudo pacman -S gjs gtk4-layer-shell gobject-introspection npm dart-sass
```

Comprueba versión con `ags --version` (aquí: `3.1.0`). No hay `package.json` — AGS resuelve
todo en runtime, no hace falta `npm install`.

**Compilar el CSS** — `estilos/out.css` es un artefacto generado de `estilos/style.scss` y no se
edita a mano. `install.sh` lo recompila automáticamente. Si modificas SCSS después, corre:

```sh
cd ~/.config/ags && sass --no-charset --no-source-map estilos/style.scss estilos/out.css
```

(`--no-source-map` evita dejar un `.map` suelto en `estilos/`; para desarrollo del shell, con mapa
de depuración enrutado a `~/.cache/gigishell/`, ver `ags/CLAUDE.md`.)

No hace falta hacerlo manualmente durante la primera instalación.
En Arch/CachyOS, si aparece `sass: command not found`, instálalo con
`sudo pacman -S --needed dart-sass` y vuelve a ejecutar el instalador.

**Tests de Node** (opcionales, solo para desarrollo, no para que el shell funcione):

```sh
node --test modulos/notificaciones/rules/*.test.ts modulos/notificaciones/history/*.test.ts \
  modulos/notificaciones/cleanup/*.test.ts modulos/notificaciones/settings/*.test.ts \
  servicios/spotify/*.test.ts
```

Necesita `nodejs` (probado con v26).

## 3. Fuentes

**Ojo:** pese a lo que dice `CLAUDE.md` de ags, el bar/paneles usan **"MesloLGS Nerd Font"**
como fuente principal (glifos de icono incluidos), no JetBrainsMono:

```sh
sudo pacman -S ttf-meslo-nerd
```

`hyprlock.conf` usa `Noto Sans` y `Noto Sans Mono`, instaladas por `install.sh` mediante `noto-fonts`.
No requiere copiar fuentes privadas al nuevo PC.

## 4. Bar / atajos / herramientas de escritorio

```sh
sudo pacman -S rofi rofimoji wtype noto-fonts-emoji cliphist wl-clipboard imagemagick brightnessctl ddcutil playerctl qalculate-gtk \
  wf-recorder grim slurp jq bc hyprshot nm-connection-editor blueman fish git curl \
  btop upower libgudev cups geoclue mesa-utils lshw github-cli \
  udisks2 lsof ntfsprogs dosfstools exfatprogs kmod
```

Qué usa cada cosa:

- **`hyprshot`** (capturas, `Print` / `Ctrl+Print` en `gigishell/keybinds.lua`) ya trae como
  dependencias `grim`, `slurp`, `jq`, `libnotify`, `wl-clipboard` — pero como AGS también
  llama a `grim` directamente (preview de workspace al clic-derecho sobre el número, ver
  `modulos/barra/escritorios/Escritorios.tsx`), instálalo igual explícitamente. Opcional: `hyprpicker`
  (congela pantalla durante la captura).
- **`rofi`** — lanzador de apps (`SUPER+SPACE` → `hypr/scripts/rofi-launch.py`, requiere
  además `python3`, ya lo trae el sistema base — que es también lo que necesita
  `hypr/scripts/lanzar-anclado.py`, el camino por el que Orion abre sus apps; los dos
  comparten el motor de anclaje `hypr/scripts/anclaje.py`) y selector del portapapeles (`SUPER+V`,
  con `cliphist` + `wl-clipboard`). Ambos comparten el diseño versionado en
  `GiGiShell/rofi/config.rasi`. El selector de emojis (`SUPER+.`) usa `rofimoji`,
  `wtype` y `noto-fonts-emoji`; inserta mediante un pegado temporal y restaura
  después el contenido anterior del portapapeles. Las miniaturas de imágenes
  binarias requieren `imagemagick`.
- **`playerctl`** / **`brightnessctl`** — teclas multimedia y brillo.
- **`ddcutil`** — brillo de **monitores externos** (sobremesa), por DDC/CI. Necesita además el módulo
  `i2c-dev` cargado en cada arranque, cosa que hace `/etc/modules-load.d/i2c-dev.conf` — lo instala
  `install.sh`; a mano sería
  `sudo install -Dm644 system/modules-load.d/i2c-dev.conf /etc/modules-load.d/i2c-dev.conf && sudo modprobe i2c-dev`.
  Sin eso el slider de brillo simplemente no aparece (no hay backend). En un portátil no hace falta:
  ahí el panel interno se controla por `/sys/class/backlight`.
- **`udisks2`** — comprobación, reparación, desmontaje y apagado seguro de discos USB
  desde `usb-monitor.sh`, `usb-repair.sh` y `usb-eject.sh`. `ntfsprogs`,
  `dosfstools` y `exfatprogs` aportan las herramientas de reparación para NTFS,
  FAT y exFAT; `lsof` permite indicar qué aplicación mantiene ocupado un volumen.
- **`wpctl`** (paquete `wireplumber`) — volumen/mute por teclado y en `inicializador/init.sh`.
  El panel de audio de AGS (`QuickSettings.tsx`) además llama a **`pactl`** (paquete
  `libpulse`) y **`pw-metadata`** (paquete `pipewire`) para listar/cambiar sink-inputs y el
  dispositivo por defecto:
  ```sh
  sudo pacman -S libpulse pipewire pipewire-audio pipewire-pulse pipewire-alsa \
    wireplumber gst-plugin-pipewire
  ```
- **`wf-recorder`** — grabación del monitor activo con audio del sistema como toggle
  con `CTRL+SHIFT+F`, o de una ventana elegida con `CTRL+SHIFT+S`; también permite
  grabar una región con `SUPER+SHIFT+P` vía `slurp`.
- **`qalculate-gtk`** — calculadora (`XF86Calculator`).
- **`nm-connection-editor`** / **`blueman-manager`** — los abre AGS desde QuickSettings
  para "más opciones" de red/bluetooth.
- **`bc`** — usado por `~/.config/inicializador/init.sh` para redondear brillo/volumen
  leídos de `display.json`/`system_state.json`. **En esta misma máquina falta instalado**
  ahora mismo (`bc` no está en el sistema) — instálalo en ambos PCs si no lo has hecho ya,
  si no `init.sh` fallará silenciosamente al aplicar brillo/volumen guardados.
- **`git`** — gestiona el propio árbol de dotfiles durante la instalación y actualización.
- **`curl`** — usado por el instalador y por integraciones HTTP de AGS como calendario,
  Spotify, carátulas y ubicación.

Cosas referenciadas en `gigishell/variables.lua` que son elección de terminal/gestor de archivos, no
dependencias estrictas — cambia estas líneas si usas otra cosa en el PC nuevo:

```
$terminal = kitty
$fileManager = dolphin
```

```sh
sudo pacman -S --needed \
  kitty firefox dolphin kservice ffmpegthumbs kdegraphics-thumbnailers \
  ark 7zip unrar elisa filelight gwenview haruna kate kfind kolourpaint \
  libreoffice-fresh libreoffice-fresh-es okular partitionmanager simple-scan
```

`kservice` proporciona `kbuildsycoca6`, que permite que Dolphin descubra las
aplicaciones instaladas para el menú **Abrir con…**. La configuración incluye
`~/.config/menus/applications.menu`; después de
instalarla, se pueden reconstruir manualmente las bases con:

```sh
update-mime-database ~/.local/share/mime
kbuildsycoca6 --noincremental
```

Las asociaciones predeterminadas viven en `~/GiGiShell/mimeapps.list`: Firefox
abre los PDF; Okular, el resto de documentos de lectura; Gwenview y KolourPaint,
las imágenes; Haruna y Elisa, vídeo y audio; Kate, texto normal; Obsidian,
Markdown con Kate como alternativa si no está instalado; Visual Studio Code,
código y configuración de proyectos; Ark, archivos
comprimidos; y LibreOffice, los formatos ofimáticos. Filelight, KFind, KDE
Partition Manager y Simple Scan quedan como utilidades, no como manejadores
predeterminados. `~/GiGiShell/kdeglobals` hace que las acciones de terminal de KDE
usen Kitty.

`bin/configurar-dolphin.sh` limita los miniaturizadores a imágenes comunes y SVG,
vídeo mediante `ffmpegthumbs`, PDF/PostScript mediante `gsthumbnail` y documentos
OpenDocument mediante `opendocumentthumbnail`. Desactiva miniaturas de audio,
ebooks, cómics, ejecutables y otros formatos costosos, pero conserva la
restauración de pestañas anteriores. Las animaciones de Breeze permanecen
activas porque su coste es breve y no reduce de forma apreciable la memoria base.

Los archivos de texto desconocidos caen en Kate mediante `text/plain`. Además,
los datos sin tipo reconocible (`application/octet-stream`) también caen en Kate,
mientras que los ejecutables nativos se abren como código en Visual Studio Code
en vez de lanzarse. Esto cubre cookies, locks y cachés sin extensión; un enlace
simbólico roto seguirá sin poder abrirse porque su destino no existe.
Además,
`mime/packages/text-x-xresources.xml` evita que `.Xresources` se confunda con
un cursor binario solo porque comienza por `Xcursor`; queda clasificado como
`text/x-xresources` y también se abre con Kate.

El esquema `BreezeDark` de KDE y la paleta oscura de `qt6ct` mantienen oscuras
las aplicaciones Qt, incluido Dolphin. Hyprland exporta
`QT_QPA_PLATFORMTHEME=qt6ct`; sin esa integración, Qt usa su paleta clara aunque
`kdeglobals` indique Breeze Dark. El archivo `qt6ct/qt6ct.conf` aplica la paleta
`darker` con el estilo Breeze. Además, `kdeglobals` fija Breeze Dark dentro de
`[UiSettings]`, que es el grupo consultado por `KColorSchemeManager`: dejar el
nombre únicamente en `[General]` hace que Dolphin vuelva a la paleta clara. Los
grupos `[Colors:*]` completos quedan como paleta oscura global de respaldo.
Para evitar que los menús y diálogos de Breeze queden sobredimensionados con
escalado fraccional, `qt6ct` usa Noto Sans a 10 puntos y Hyprland exporta
`QT_SCALE_FACTOR=0.9`. El ajuste solo cambia la densidad de aplicaciones Qt/KDE;
la escala general del monitor y las aplicaciones GTK no se modifican.
El tema de iconos `Tela-circle-grey` se aplica tanto a KDE mediante `kdeglobals`
como a GTK durante el arranque de Hyprland. `mime/packages/text-x-codigo.xml` corrige
los conflictos de extensiones `.ts` y `.tsx`, y da a `.conf`, `.cfg` e `.ini`
un tipo de configuración propio; así Dolphin muestra iconos de código en vez de
iconos de traducción Qt, vídeo, mapas de Tiled o archivos vacíos.

## 5. Wallpaper

```sh
sudo pacman -S awww imagemagick
```

`awww` (**no confundir con `swww`**) se lanza como
`awww-daemon` en `gigishell/autostart.lua`, y `scripts/wallpaper.sh` hace `awww img "$WALLPAPER"`
sobre un fichero elegido al azar de `~/GiGiShell/Wallpapers/*.{jpg,png}`. El repositorio ya
incluye fondos iniciales; puedes sustituirlos por los tuyos.

`imagemagick` (comando `magick`) lo usa la sección **Temas** de Orion para generar las
miniaturas de la rejilla de fondos, que cachea en `~/.cache/gigishell/wp-thumbs/` (un JPEG de
336x192 por fondo, ~15 KB). Se genera en un proceso aparte precisamente para no bloquear el
shell: los fondos originales son enormes (aquí hay PNG de 8192x6144) y decodificar uno
entero en el hilo de AGS congelaba la UI varios segundos.

Es **opcional**: sin `magick` se cae a GdkPixbuf, que hace lo mismo pero más lento y con más
carga para el shell en la primera pasada. Instalarlo es la diferencia entre ~2 s con la UI
fluida y ~4 s con la UI a tirones — solo la primera vez, porque después las miniaturas ya
están cacheadas y la rejilla abre en ~30 ms. La caché se mantiene sola: solo genera lo que
falta, rehace lo que esté corrupto y borra las miniaturas de fondos que ya no existen.

## 6. Portapapeles y utilidades base

```sh
sudo pacman -S wl-clipboard cliphist imagemagick
```

`gigishell/autostart.lua` lanza `wl-paste --watch cliphist store` para poblar el historial que usa
`SUPER+V`. El selector Rofi replica el diseño oscuro del lanzador de aplicaciones:
fondo `#313244` al 90 %, selección `#b4befe` y scrollbar rosa `#f5c2e7` al 70 %.
El lanzador, el portapapeles y la cuadrícula de emojis leen
`GiGiShell/rofi/config.rasi` mediante sus enlaces en `~/.config/rofi`; cada uno
solo aporta su distribución, placeholder y opciones de búsqueda. La búsqueda difusa del
portapapeles conserva el orden cronológico de `cliphist`. El watcher fija un máximo de
500 elementos y el selector los numera de `1` a `500`, desde el más reciente hasta el
más antiguo, sin mostrar el identificador interno utilizado para decodificarlos.
Las entradas que apuntan a un archivo de imagen entregan directamente esa ruta al
sistema de miniaturas de Rofi. Para capturas y otras imágenes binarias,
`hypr/scripts/miniatura-portapapeles.sh` decodifica por `stdin` y escribe directamente
en la ruta de caché proporcionada por Rofi, sin archivos intermedios ni una caché propia.
Desde Ajustes se puede ejecutar una limpieza manual o activar la limpieza al comenzar
la sesión. Ambas rutas pasan por `hypr/scripts/limpiar-portapapeles.sh`, que vacía la
selección activa de Wayland con `wl-copy --clear` y borra la base de `cliphist`.

## 7. Secretos (Spotify, credenciales)

El servicio Spotify de AGS (`servicios/spotify/SpotifyService.ts`) y el script
`~/.config/ags/scripts/spotify-auth.sh` guardan/leen las credenciales en **texto plano**
en `~/.config/gigishell/spotify-creds.json` (chmod 600, git-ignored). No hay KWallet ni
Secret Service: se retiró a propósito porque bajo Hyprland pedía la contraseña del monedero
en cada arranque. No hace falta instalar `kwallet`/`libsecret` ni lanzar ningún `ksecretd`.

**La contrapartida la paga cualquier app que sí espere un keyring**, y la primera es VS
Code: al no encontrar `org.freedesktop.secrets` en el bus, saca un cartel modal
("An OS keyring couldn't be identified…") en **cada** arranque. Ninguno de sus dos botones
recuerda la respuesta de forma fiable, así que el paso `vscode` del instalador escribe la
decisión de una vez en `~/.vscode/argv.json`:

```sh
bash ~/GiGiShell/install.sh --solo vscode   # o: ~/GiGiShell/bin/configurar-vscode.sh aplicar
```

Lo que fija es `"password-store": "basic"` — el equivalente permanente del botón *Use
weaker encryption*: VS Code cifra sus secretos (tokens de GitHub, cuentas de extensiones,
Settings Sync) con una clave fija en vez de con el llavero. Es el **mismo** modelo de
amenaza que las credenciales de arriba, no uno peor. Instalar `gnome-keyring` no arregla
nada por sí solo en esta máquina: con el autologin de SDDM, PAM no ve ninguna contraseña
con la que desbloquear el llavero, así que volvería a preguntar una vez por sesión —
exactamente el problema por el que se retiró KWallet.

El fichero es JSONC (JSON **con comentarios**, que VS Code escribe él mismo) y lleva el
`crash-reporter-id` de la máquina, así que `bin/configurar-vscode.sh` inserta la clave
respetando lo que hubiera en vez de regenerarlo, y no usa `jq` (que aborta ante un `//`).
`bin/preflight.sh` lo comprueba como AVISO, no como error: `argv.json` no existe hasta que
VS Code se abre por primera vez.

**Las credenciales de Spotify NO viajan copiando el repo** — el archivo está fuera de git.
En el PC nuevo ejecuta una vez:

```sh
~/.config/ags/scripts/spotify-auth.sh
```

Te pedirá client id/secret de una app tuya en el dashboard de Spotify, hará el flujo OAuth
completo (usa `python3` y `xdg-open`, ya cubiertos) y escribirá el JSON plano con las tres
claves (`client_id`, `client_secret`, `refresh_token`).

## 8. Scripts de monitorización ("escáneres") — `hypr/scripts/`

Todos se lanzan en `gigishell/autostart.lua` y notifican por `notify-send` (paquete `libnotify`,
ya cubierto por `hyprshot`/`grim` arriba, pero decláralo explícito):

```sh
sudo pacman -S libnotify smartmontools lm_sensors pciutils usbutils alsa-utils \
  util-linux inotify-tools dbus networkmanager bluez bluez-utils xdg-user-dirs
```

El instalador habilita `NetworkManager.service` y `bluetooth.service`. CUPS se instala
pero queda bajo control del interruptor **Ajustes → Dispositivos → Impresoras**, para no
mantener el servicio activo en equipos que no imprimen.

Detalle por script:

| Script | Qué vigila | Depende de |
|---|---|---|
| `battery-monitor.sh` | niveles críticos de batería / carga completa | lee `/sys/class/power_supply/BAT0` directo, sin paquete extra — **hardcodea `BAT0`**; en un PC de escritorio sin batería simplemente no encontrará nada y se queda inactivo (no falla) |
| `temp-monitor.sh` | temp. CPU/GPU altas | CPU: lee directo de sysfs (`/sys/class/hwmon/*/temp1_input` del chip `coretemp`, resuelto una vez al arrancar) — sin forkear `sensors` ni `python3`. GPU: `nvidia-smi` (`nvidia-utils`, solo si hay NVIDIA; se detecta una vez al arrancar, no en cada ciclo). **Requiere haber corrido `sudo sensors-detect` una vez en el PC nuevo** para que el driver `coretemp` esté cargado (específico de CPUs Intel; en AMD el chip se llama distinto y el script simplemente no reportará temp de CPU, sin fallar) |
| `ram-monitor.sh` | uso de RAM alto | solo `/proc/meminfo`, sin dependencias |
| `disk-monitor.sh` | espacio en disco bajo | `df`, sin dependencias extra |
| `oom-monitor.sh` | OOM killer, kernel panic, fallos SSH/sudo, segfaults, ficheros críticos modificados | `journalctl` (systemd) + `inotifywait` (`inotify-tools`) sobre `/etc/passwd /etc/sudoers /etc/hosts` |
| `wifi-monitor.sh` | desconexión/reconexión WiFi + portal cautivo | `nmcli` (NetworkManager) — event-driven vía `nmcli monitor`, sin polling; detecta interfaz, SSID y estado de conectividad todo por D-Bus, sin `iw`/`iwgetid` |
| `bt-monitor.sh` | pérdida de conexión Bluetooth | `dbus-monitor` (`dbus`) + `bluetoothctl` (`bluez-utils`) |
| `usb-monitor.sh` | conectar/desconectar USB | `udevadm` (systemd, ya en el sistema base) |
| `screencast-monitor.sh` | que algo esté **capturando la pantalla**: compartir (Discord, OBS, Zoom, navegadores) o grabar en local. Enciende `CapturaPantalla` en la barra | **no añade ningún paquete nuevo**: `jq` y `wf-recorder` (§ herramientas), `pw-dump`/`pw-mon` (paquete `pipewire`, ya instalado para el audio) y `xdg-desktop-portal-hyprland` (§ Hyprland). Sin `jq` o sin `pw-dump` el script sale sin escribir y el icono nunca aparece. **Compartir pantalla se detecta a través del portal**, así que el portal es obligatorio para esa mitad; los grabadores locales (`wf-recorder`, `gpu-screen-recorder`, `wl-screenrec`, `obs`) se detectan por proceso y solo hacen falta si los usas |
| `boot-healthcheck.sh` | chequeo general al arrancar (servicios fallidos, errores de journal, disco, NVIDIA, SMART, batería, fans, audio, bluetooth, USB) | autodescubre hardware, así que no falla si falta algo; pero para chequeos completos quiere `smartctl` (`smartmontools`), `sensors` (`lm_sensors`), `lspci`/`lsusb` (`pciutils`/`usbutils`), `rfkill` (`util-linux`), `aplay` (`alsa-utils`), `nvidia-smi` (`nvidia-utils`) |

### 8.1 Escaneo antivirus, integridad y sandbox

El monitor `oom-monitor.sh` incorpora tres funciones de seguridad adicionales:

- vigila cambios en archivos críticos mediante `inotifywait`;
- analiza archivos nuevos o modificados dentro de la carpeta XDG de Descargas con
  ClamAV, deduplicando por hash de contenido;
- ofrece analizar archivos grandes y lanzar ejecutables no confiables dentro de un
  sandbox cuando están disponibles los scripts auxiliares.

Instala sus dependencias:

```sh
sudo pacman -S --needed clamav firejail bubblewrap xxhash xdg-user-dirs file
# NO hace falta `systemctl enable --now clamav-freshclam`: GiGiShell comprueba las firmas al iniciar
# sesión y las actualiza si están viejas (ver «Actualizar las firmas al iniciar sesión» en Ajustes >
# Seguridad > Antivirus). Durante la sesión no queda ningún temporizador.
sudo freshclam
```

- `clamav` proporciona `clamscan`. Sin una base de firmas descargada, el programa existe
  pero no puede detectar nada — y esto no falla en silencio: `clamscan` sale con código
  **2** ("No supported database files found"), que `oom-monitor.sh` interpreta como
  "motor no disponible" y por eso **no** marca nada como analizado (ver más abajo).
  Usa el **servicio**, no un `freshclam` suelto de una sola vez: `enable --now` descarga
  la base ya mismo (unos 200 MB; tarda un par de minutos) y además la deja
  **actualizándose sola** — un `freshclam` manual se queda obsoleto en días y nadie
  vuelve a acordarse de repetirlo. Comprueba que cuajó con
  `systemctl status clamav-freshclam` y `ls /var/lib/clamav` (debe tener ficheros, no
  estar vacío).
- `firejail` es el motor principal usado para lanzar archivos o aplicaciones no
  confiables con aislamiento de procesos, red y sistema de archivos según el perfil
  aplicado por `run-untrusted.sh`.
- `bubblewrap` proporciona `bwrap`, usado para construir el sandbox. Esto reduce el
  acceso del proceso al sistema y puede servir como backend o alternativa cuando así lo
  decida `run-untrusted.sh`.
- Firejail y Bubblewrap no son antivirus: contienen el proceso, mientras que ClamAV
  analiza el archivo. **Ninguno convierte un archivo desconocido en seguro.**
- `xxhash` proporciona `xxh64sum` para evitar volver a escanear contenido idéntico. Si
  falta, el monitor cae a `sha1sum` o `md5sum` de `coreutils`, pero será más lento.
- `xdg-user-dirs` permite encontrar `~/Descargas` aunque el sistema use otro idioma.
- `file` lo usa `bin/verify-files.sh` para detectar ejecutables disfrazados por sus
  magic bytes antes de cada `git push`.
- `oxipng` optimiza sin pérdida los PNG nuevos o modificados de `Wallpapers/` antes
  de un `git push`. Guarda sus hashes en `~/.cache/gigishell/`; si la optimización
  cambia algún fondo, el hook detiene ese push para que puedas incluir el resultado
  en un commit, y el siguiente intento no vuelve a optimizarlo. En Arch/CachyOS
  se instala con:

  ```sh
  sudo pacman -S --needed oxipng
  ```

Tras instalar ClamAV, comprueba la configuración con un archivo legítimo cualquiera:

```sh
clamscan --version
firejail --version
bwrap --version
clamscan --no-summary ~/Descargas/algún-archivo
```

El estado se guarda en `~/.cache/gigishell/download-index` y
`~/.cache/gigishell/download-hashes`; es caché regenerable y no se copia al migrar.
**Si `oom-monitor.sh` ya llevaba corriendo sin base de firmas** (instalaste ClamAV pero
tardaste en habilitar `clamav-freshclam`), lo escaneado en ese hueco quedó **sin marcar**
como analizado — el propio script lo detecta (código 2) y no lo sella — así que en
cuanto las firmas estén listas el siguiente barrido lo recupera solo, sin tocar nada a mano.

Las preferencias viven en `~/.config/gigishell/security.json` y se leen una sola vez al arrancar
`oom-monitor.sh`: después de cambiar un interruptor de Seguridad hay que cerrar sesión o
reiniciar manualmente ese script.

Para que la interfaz y las acciones funcionen, el repo debe contener estos archivos; los
dos scripts `.sh` deben tener permiso de ejecución:

```text
GiGiShell/ags/modulos/ajustes/seguridad/SeccionSeguridad.tsx
GiGiShell/ags/modulos/ajustes/seguridad/preferencias.ts
GiGiShell/hypr/scripts/scan-file.sh
GiGiShell/hypr/scripts/run-untrusted.sh
```

Los cuatro archivos están versionados y `bin/preflight.sh` comprueba su presencia y los
permisos ejecutables de los scripts.

## 9. Elegir la configuración de GPU correcta

Antes de iniciar Hyprland en otro equipo, identifica las GPU disponibles:

```sh
lspci -k | grep -A3 -E 'VGA|3D|Display'
ls -l /dev/dri/by-path 2>/dev/null
```

Los perfiles viven en `~/.config/hypr/gigishell/gpu/` y se elige **uno** escribiendo su
nombre en `~/.config/gigishell/gpu-perfil`, un fichero local de una línea que **no se
versiona** (la elección de máquina es estado local, como manda
[`anadir-perfiles-por-equipo.md`](anadir-perfiles-por-equipo.md)):

```sh
echo sobremesa-nvidia > ~/.config/gigishell/gpu-perfil
```

Normalmente no tendrás que escribirlo: el instalador lo hace por ti en el paso `gpu`
(`install.sh --solo gpu` lo repite sin tocar nada más) recorriendo `/sys/bus/pci/devices`
y mirando la clase PCI `0x03xxxx` y el fabricante de cada tarjeta. Lee `/sys` y no
`lspci` a propósito: el paso puede correr con `--sin paquetes`, donde `pciutils` no está
garantizado. La regla es:

| Hardware detectado                    | Perfil que escribe |
| ------------------------------------- | ------------------ |
| NVIDIA + iGPU (Intel/AMD) **y batería** | `laptop-hibrida`   |
| NVIDIA sin iGPU, o NVIDIA sin batería   | `sobremesa-nvidia` |
| Solo Intel o solo AMD                   | `integrada`        |

- **Portátil Intel + NVIDIA para offload:** `laptop-hibrida`. Hyprland y la pantalla
  funcionan sobre Intel; los juegos pesados se lanzan con `prime-run`.
- **Sobremesa NVIDIA:** `sobremesa-nvidia`.
- **Solo AMD o solo Intel:** `integrada`. Ese módulo **no configura nada**, y ese es su
  cometido: Mesa y aquamarine ya eligen bien cuando hay una sola GPU, y las variables de
  los perfiles NVIDIA sobre Mesa rompen la aceleración de vídeo en vez de mejorarla.
  Existe para que «no hay nada que configurar» sea una respuesta y no un hueco — con el
  fichero ausente, `gpu.lua` no puede distinguirlo de «todavía no lo he elegido» y avisa
  en pantalla en **cada inicio de sesión**.

Los tres perfiles están versionados. El instalador **no pisa** un `gpu-perfil` que ya
exista, así que tu elección manual gana siempre. Sin fichero (o con un nombre que no
exista) no se aplica ninguno y sale un aviso en pantalla, pero el compositor arranca
igual: el primer arranque es portable.

`gigishell/env-firefox.lua` solo activa Wayland/EGL y no fuerza un driver VA-API ni desactiva el
sandbox multimedia. Los ajustes exclusivos de NVIDIA están aislados en el perfil de
sobremesa. Las preferencias internas se gestionan por separado con
`bin/firefox-profile.sh`, que enlaza el `user.js` compuesto al perfil
predeterminado real.

```sh
# solo si hay NVIDIA
sudo pacman -S nvidia-utils nvidia-prime
# si NVIDIA es la GPU principal y quieres VA-API
sudo pacman -S libva-nvidia-driver
```

## 10. Cosas específicas de ESTA máquina que hay que revisar al migrar

Estas no son paquetes, son configuración/datos ligados al hardware o cuenta actuales:

- **`gigishell/monitores.lua`** usa actualmente el fallback genérico
  (`monitor = , preferred, auto, 1`), adecuado para el monitor 2560×1440 de 27 pulgadas.
  Después puedes ajustar resolución, frecuencia, posición o escala desde AGS; usa
  `hyprctl monitors` para comprobar el descriptor y los valores aplicados.
- **Foto de perfil**: opcional y personal. Vive en `~/.local/share/gigishell/face.png` (fuera del
  repo, nunca versionada para no publicar una foto tuya) y la leen tanto `hyprlock` como el
  avatar de AGS. Se pone desde Ajustes > Cuenta. Sin foto, AGS muestra las iniciales.
- **`~/GiGiShell/Wallpapers/`** viaja con este repositorio y contiene los fondos que usa
  `wallpaper.sh`.
- Los JSON en `~/.config/gigishell/` (`display.json`, `system_state.json`,
  `preferences.json`, `notif-*.json`, etc.) sí son datos de usuario y sí conviene copiarlos
  si quieres el mismo estado (brillo, night light, reglas de notificación...) en el PC
  nuevo — son runtime data, no forman parte del código.

## 11. Orden recomendado para el PC nuevo

### Antes de migrar: preflight del repositorio

El instalador remoto solo puede descargar archivos que estén **versionados, incluidos en
un commit y publicados en `origin/laptop`**. Que AGS funcione en la máquina de desarrollo
no demuestra que esos archivos estén en Git.

Ejecuta esto en la máquina origen antes del push:

```sh
cd ~/Github-Repos/gigi-shell
git status --short
GiGiShell/bin/preflight.sh
GIGISHELL="$PWD/GiGiShell" GiGiShell/bin/link.sh --check
bash -n GiGiShell/install.sh GiGiShell/inicializador/init.sh GiGiShell/hypr/scripts/*.sh
bin/verify-files.sh
```

En este repositorio bare usa también:

```sh
dotfiles status --short --untracked-files=all -- GiGiShell .github
dotfiles ls-files GiGiShell/ags/modulos/ajustes/seguridad/SeccionSeguridad.tsx \
  GiGiShell/hypr/scripts/scan-file.sh GiGiShell/bin/preflight.sh
```

La primera orden no debe mostrar cambios pendientes antes de probar la URL pública; la
segunda debe imprimir los tres archivos. El workflow debe vivir en
`.github/workflows/gigishell-validate.yml` en la **raíz del repositorio**, no dentro de
`GiGiShell/.github/`. Después de hacer commit y push, verifica que la acción de GitHub pase
en la rama `laptop`.

Comprueba además que no falte ningún archivo referenciado por la configuración:

```sh
for f in \
  GiGiShell/hypr/scripts/clipboard-history.sh \
  GiGiShell/hypr/scripts/limpiar-portapapeles.sh \
  GiGiShell/hypr/scripts/miniatura-portapapeles.sh \
  GiGiShell/hypr/scripts/emoji-picker.sh \
  GiGiShell/rofi/config.rasi \
  GiGiShell/rofi/emoji-grid.rasi \
  GiGiShell/hypr/scripts/scan-file.sh \
  GiGiShell/hypr/scripts/run-untrusted.sh \
  GiGiShell/ags/modulos/ajustes/cuenta/SeccionCuenta.tsx \
  GiGiShell/ags/modulos/notificaciones/settings/AppsTab.tsx \
  GiGiShell/ags/modulos/ajustes/fecha-idioma/SeccionFechaIdioma.tsx \
  GiGiShell/ags/modulos/ajustes/dispositivos/SeccionDispositivos.tsx \
  GiGiShell/ags/modulos/ajustes/pantalla/SeccionPantalla.tsx \
  GiGiShell/ags/modulos/ajustes/seguridad/SeccionSeguridad.tsx \
  GiGiShell/ags/modulos/ajustes/sistema/SeccionSistema.tsx \
  GiGiShell/ags/modulos/ajustes/seguridad/preferencias.ts; do
  test -f "$f" || echo "FALTA: $f"
done
```

El preflight falla si falta código obligatorio. La foto de perfil es deliberadamente
opcional y vive fuera del repo para no publicar una foto personal; sin ella se muestran iniciales.

### Resumen de la instalación

La instalación completa está al principio de esta guía. Como lista de comprobación final:

1. Comprueba y activa, si corresponde, un único perfil GPU (§9).
2. Copia las fuentes no empaquetadas si quieres reproducir exactamente el lock screen (§3).
3. Corre `spotify-auth.sh` una vez (§7) para regenerar las credenciales.
4. Corre
   `sudo freshclam` y `sudo sensors-detect` cuando corresponda.
5. Ajusta `gigishell/monitores.lua`, el avatar opcional y los fondos si quieres personalizarlos.
6. Restaura
   `~/.config/gigishell/` solo si quieres conservar el mismo estado y recarga Hyprland
   (`hyprctl reload full-reset` o vuelve a iniciar sesión). `hyprctl reload` hace una recarga
   normal, pero no vuelve a ejecutar los `exec-once` del autostart. Comprueba con
   `ags run ~/.config/ags/app.ts` que el shell arranca sin errores.
7. Corre `~/GiGiShell/bin/preflight.sh --installed`.

## 12. Cómo poner fondos de pantalla (`~/GiGiShell/Wallpapers`)

El wallpaper lo gestiona `awww` (daemon `awww-daemon`, lanzado en `gigishell/autostart.lua`) más
`hypr/scripts/wallpaper.sh`, que también se lanza una vez al arrancar la sesión.

**Para tener fondos disponibles:**

1. Copia imágenes al directorio versionado:
   ```sh
   cp /ruta/a/tus/fotos/*.png /ruta/a/tus/fotos/*.jpg ~/GiGiShell/Wallpapers/
   ```
2. **El script solo busca `*.jpg` y `*.png`** (glob exacto en `wallpaper.sh`:
   `"$WALLPAPER_DIR"/*.{jpg,png}`). Si tus imágenes son `.jpeg`, `.webp` o `.gif`,
   renómbralas a `.jpg`/`.png` o edita esa línea del script para añadir la extensión.
3. Al iniciar sesión, `wallpaper.sh` elige **una al azar** (`shuf -n 1`) de esa carpeta y
   la aplica con una transición aleatoria (`awww img ... --transition-type random`).

**Para cambiarlo sin reiniciar sesión**, tienes dos opciones:

```sh
# Elegir otra al azar de la carpeta (reejecuta el mismo script)
~/.config/hypr/scripts/wallpaper.sh

# Poner una imagen concreta a mano
awww img ~/GiGiShell/Wallpapers/mi-foto-favorita.png --transition-type grow --transition-duration 1.5
```

No hay atajo de teclado asignado para esto en `gigishell/keybinds.lua` — si quieres uno, se añadiría
algo como `bind = $mainMod, W, exec, ~/.config/hypr/scripts/wallpaper.sh` (no está puesto
actualmente, solo como referencia si lo quieres tú mismo).

**Desde Orion** (`SUPER+ALT+Space` → sección *Temas*) tienes la rejilla de fondos: clic para
aplicar uno, botón de aleatorio, y el toggle de "fondo aleatorio al iniciar Hyprland". Copiar
o borrar un fondo en `~/GiGiShell/Wallpapers` se refleja ahí **sin reiniciar AGS** (la carpeta se
vigila con un `Gio.FileMonitor`), y su miniatura se genera y cachea sola. Ver la sección 5
para la dependencia `imagemagick` y la caché de `~/.cache/gigishell/wp-thumbs/`; borrarla entera
no rompe nada, se regenera.

Los fondos están dentro de GiGiShell, por lo que viajan con un clon completo del repositorio.

## 13. Cómo poner tu foto de perfil

La foto de perfil es opcional y privada. Vive en **una sola ruta**,
`~/.local/share/gigishell/face.png`, fuera del repo y sin versionar: no viaja a otro PC.
La forma normal de ponerla es **Ajustes > Cuenta**, que **no copia el original tal cual**:
lo endereza por su orientación EXIF, lo recorta al cuadrado centrado más grande que quepa y
lo reduce a 512x512 PNG (`ags/modulos/ajustes/cuenta/avatar.ts`). Los tres sitios donde se ve
pintan un círculo pequeño —30 y 46 px en AGS, 26 px en hyprlock—, así que 512 sobra incluso a
escala 2x; guardar la foto de móvil entera solo significaba decodificar 12 MP en cada
redibujado y que el encuadre saliera distinto en el escritorio y en el bloqueo.

Está en `XDG_DATA_HOME` y **no** en `~/.cache` a propósito: no hay master del que
regenerarla, así que un limpiador de caché (o un `rm -rf ~/.cache`) te la borraría para
siempre. `bin/link.sh` solo **migra** la ubicación antigua (`~/.cache/gigios/face.png`)
si todavía la tienes ahí; no crea ni gestiona la foto.

La leen dos sitios, y ninguno se rompe si el archivo no existe:

1. **Pantalla de bloqueo (`hyprlock`)** — `hyprlock.conf`, bloque `image` con
   `path = ~/.local/share/gigishell/face.png`. Sin archivo, omite el avatar.
2. **AGS** — `modulos/ajustes/cuenta/avatar.ts` exporta `AVATAR_PATH`, que consumen
   `ProfileAvatar.tsx` (el avatar) y `cuenta/SeccionCuenta.tsx` (el selector). Sin archivo,
   AGS cae a mostrar las iniciales del usuario.

Para cambiarla desde una terminal, en vez de por Ajustes:
```sh
mkdir -p ~/.local/share/gigishell
cp /ruta/a/tu/foto.png ~/.local/share/gigishell/face.png
```
Por esta vía **no hay recorte ni reducción**: la copia queda tal cual, y si no es cuadrada cada
consumidor la encuadra a su manera. Para el tratamiento, pásala por Ajustes > Cuenta.
AGS la recarga al reiniciar el shell (Ajustes > Cuenta la refresca en el acto).

## 14. Inventario de rutas — qué es tuyo y qué no

Rastreo completo de las rutas de fichero que tocan `~/.config/hypr` y `~/.config/ags` (y lo
que usan alrededor), separadas por qué tipo de cosa son. Útil para saber qué copiar al
migrar y qué se regenera solo.

### 14.1 Datos tuyos — cópialos si quieres el mismo estado en el PC nuevo

| Ruta | Qué guarda |
|---|---|
| `~/.config/gigishell/display.json` | brillo, night light (activo/temperatura) |
| `~/.config/gigishell/system_state.json` | estado guardado de wifi/bluetooth/volumen/mute |
| `~/.config/gigishell/audioPresets.json` | presets de audio de QuickSettings |
| `~/GiGiShell/ags/config/app_icons.json` | mapa versionado clase → glifo Nerd Font para los workspaces |
| `~/.config/gigishell/preferences.json` | preferencias de "Personalización" (p.ej. preview de workspace) |
| `~/.config/gigishell/notifications.json` | config de notificaciones |
| `~/.config/gigishell/notif-rules.json` | reglas del motor de notificaciones |
| `~/.config/gigishell/notif-history.json` | historial de notificaciones |
| `~/.config/gigishell/notif-cleanup-state.json` | estado del motor de limpieza de notifs |
| `~/.config/gigishell/notif-migrated.json` | marca de migración ya aplicada (evita re-migrar) |
| `~/.config/gigishell/security.json` | interruptores del monitor de seguridad; se leen al iniciar `oom-monitor.sh` |
| `~/.config/gigishell/calendario.json` | tus eventos del panel de calendario (antes `~/.config/ags/calendar-events.json`, que caía **dentro** del repo; AGS lo migra solo la primera vez y borra el original) |
| `~/.config/gigishell/reloj.json` | tus alarmas (el temporizador y el cronómetro son de sesión y no se guardan) |
| `~/.config/gigishell/google-calendar-creds.json` | credenciales de Google Calendar en texto plano (chmod 600, git-ignored); regenerar con `ags/scripts/google-calendar-auth.sh` |
| `~/.config/gigishell/google-calendar-sync.json` | tokens incrementales de Google; borrarlo solo cuesta una sincronización completa |
| `~/.local/share/orion/favorites.json` | apps favoritas fijadas en Orion (nota: `CLAUDE.md` dice que los perfiles de Orion viven en `~/.local/share/jarvis/profiles/` — **es un error**, el código real usa `~/.local/share/orion/`) |
| `~/.local/share/orion/profiles/*.json` | sesiones guardadas de Orion (`ProfileManager.ts`) |
| `~/.config/power-save/config.json` | umbral de ahorro de energía + toggles (ver `servicios/energia/powerState.ts`) |
| `~/.local/share/gigishell/face.png` | foto privada opcional, fuera del repo; se pone desde Ajustes > Cuenta (§13) |
| `~/GiGiShell/Wallpapers/*.jpg` / `*.png` | tus fondos de pantalla (§12) |
| `~/GiGiShell/audio/*.oga` | sonidos de alarmas y notificaciones; sustituir un fichero por otro del mismo nombre cambia el sonido de todo el sistema (ver `audio/README.md`) |
| `~/.config/gigishell/spotify-creds.json` | credenciales de Spotify en texto plano (chmod 600, git-ignored — ver §7); regenerar con `spotify-auth.sh` |

### 14.2 Config/código del dotfiles — genérico, viaja igual para cualquiera que use este setup

Todo lo demás dentro de `~/.config/hypr/*.conf`, `~/.config/hypr/scripts/`,
`~/.config/hypr/envs/`, y todo `~/.config/ags/`: `app.ts`, `modulos/**`, `componentes/**`, `estado/**`, `servicios/**`, `utilidades/**`, `estilos/style.scss`
(→ `estilos/out.css` generado, no se edita a mano; su `.map` de depuración se genera fuera del repo, en `~/.cache/gigishell/`).

### 14.3 Fuera de `hypr/` y `ags/`, pero incluidos en este repositorio

Esto es lo más fácil de olvidar en una migración porque **no vive bajo ninguno de los dos
directorios que sueles copiar**:

| Ruta | Por qué importa |
|---|---|
| `~/.config/hypr/gigishell/keybinds.lua` | compactar workspaces (`SUPER+SHIFT+N`) y alternar gaps (`SUPER+SHIFT+E`) son hoy `GiGiShell.compactar()` y `GiGiShell.toggle_gaps()` **dentro del config Lua**; los `compact-workspaces.sh` / `toggle-gaps-borders.sh` de esta tabla desaparecieron en la migración a Lua |
| `~/.config/inicializador/init.sh` | lo lanza `gigishell/autostart.lua`; está versionado en `GiGiShell/inicializador/` y `GiGiShell/bin/link.sh` crea el enlace |
| `~/.local/share/fonts/SF Pro Display/*.otf` | fuente del lock screen, no empaquetada (§3) |
| `~/.local/share/fonts/steelfish outline regular/*.otf` | fuente del lock screen, no empaquetada (§3) |

Las fuentes manuales son las únicas entradas de esta tabla que hay que copiar por separado.

### 14.4 Rutas efímeras — se regeneran solas, no hace falta copiarlas ni preocuparse

| Ruta | Para qué es |
|---|---|
| `/tmp/ags-ws-preview-*.png` | capturas de `grim` para el preview de workspace al clic-derecho |
| `$XDG_RUNTIME_DIR/gigishell-gaps-disabled` | marca si el toggle está en modo "sin gaps" |
| `~/.cache/ags/media` | carátulas de álbum cacheadas por el reproductor multimedia |
| `~/.config/hypr/logs/boot-healthcheck.log` | log propio; rota solo y no es necesario para funcionar |
