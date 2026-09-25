#!/usr/bin/env bash
# Comprueba que el checkout contiene todo lo necesario y, opcionalmente, que la
# máquina instalada tiene las herramientas principales.
set -uo pipefail

GIGISHELL="${GIGISHELL:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)}"
mode="${1:-}"
errors=0
warnings=0

ok() { printf 'OK      %s\n' "$*"; }
fail() { printf 'ERROR   %s\n' "$*" >&2; errors=$((errors + 1)); }
warn() { printf 'AVISO   %s\n' "$*"; warnings=$((warnings + 1)); }

# SOLO FICHEROS VERSIONADOS. Aquí llegó a haber nueve `*.test.ts` y eso hacía que
# el instalador FALLASE SIEMPRE en una máquina nueva: `.gitignore` lleva
# `ags/**/*.test.ts` desde que los tests de AGS dejaron de versionarse, así que un
# checkout limpio no puede contenerlos por definición — el preflight final salía con
# nueve "falta ..." y el instalador terminaba con "la instalación NO está completa"
# aunque todo estuviera bien. En la máquina de desarrollo pasaba porque allí los
# ficheros existen sin estar rastreados, que es justo el caso que oculta el fallo.
# La comprobación de coherencia de más abajo impide que vuelva a colarse una ruta
# ignorada en esta lista.
required=(
  install.sh bin/link.sh bin/shell-local.sh bin/kitty-profile.sh bin/firefox-profile.sh
  bin/configurar-dolphin.sh bin/configurar-vscode.sh bin/generar-hyprcursor.sh
  ags/app.ts ags/estilos/style.scss
  mimeapps.list menus/applications.menu kdeglobals qt6ct/qt6ct.conf
  mime/packages/text-x-xresources.xml mime/packages/text-x-codigo.xml
  ags/servicios/juegos/evidencia.ts ags/servicios/juegos/iconos.ts
  ags/modulos/barra/escritorios/orden.ts
  ags/modulos/barra/escritorios/descripcion.ts
  ags/servicios/energia/tiempoMantenerDespierto.ts
  ags/servicios/bluetooth/estadoInicio.ts
  ags/servicios/bluetooth/tileState.ts
  ags/servicios/pantalla/brightness.ts ags/servicios/pantalla/atenuacion.ts
  ags/servicios/multimedia/mediaClient.ts
  ags/servicios/multimedia/mediaProgress.ts
  ags/modulos/notificaciones/daemon/BannerConflicto.tsx ags/modulos/notificaciones/daemon/comprobacion.ts
  ags/modulos/ajustes/ProfileAvatar.tsx
  ags/modulos/ajustes/seguridad/SeccionSeguridad.tsx ags/modulos/ajustes/seguridad/preferencias.ts
  ags/modulos/ajustes/accesibilidad/OpcionDaltonismo.tsx ags/modulos/ajustes/accesibilidad/daltonismo.ts
  ags/textos/ajustes/accesibilidad.json
  hypr/hyprland.lua hypr/gigishell/util.lua hypr/gigishell/json.lua hypr/gigishell/variables.lua
  hypr/shaders/daltonismo-protanopia.frag hypr/shaders/daltonismo-deuteranopia.frag hypr/shaders/daltonismo-tritanopia.frag
  hypr/gigishell/gpu.lua hypr/gigishell/gpu/laptop-hibrida.lua hypr/gigishell/gpu/sobremesa-nvidia.lua hypr/gigishell/gpu/integrada.lua
  hypr/scripts/bloquear.sh
  hypr/scripts/clipboard-history.sh hypr/scripts/limpiar-portapapeles.sh hypr/scripts/miniatura-portapapeles.sh hypr/scripts/emoji-picker.sh hypr/scripts/scan-file.sh
  hypr/scripts/usb-eject.sh hypr/scripts/usb-repair.sh
  hypr/scripts/reparar-kdeglobals.sh
  hypr/scripts/gestos.sh hypr/scripts/gestos/gestos.py hypr/scripts/gestos/deteccion.py hypr/scripts/gestos/hypr.py
  hypr/scripts/gestos/manos_sinteticas.py hypr/scripts/gestos/barrido.py
  ags/servicios/gestos/estado.ts ags/servicios/gestos/control.ts
  ags/modulos/barra/indicadores/sistema/Gestos.tsx ags/modulos/ajustes/camara/TarjetaGestos.tsx
  ags/estilos/_gestos.scss
  hypr/scripts/run-untrusted.sh hypr/scripts/desinstalar-app.sh
  hypr/scripts/wallpaper.sh hypr/scripts/wallpaper-select.py hypr/scripts/lib/seleccion_fondos.py
  system/modules-load.d/i2c-dev.conf system/udev/99-gigishell-usb-writeback.rules
  system/logind.conf.d/99-gigishell-powerkey.conf
  system/sddm/zz-gigishell.conf.in
  system/sddm/tema/metadata.desktop system/sddm/tema/theme.conf system/sddm/tema/Main.qml
  system/sddm/tema/Backgrounds/jake_the_dog.mp4 system/sddm/tema/Backgrounds/jake_the_dog.png
  system/sddm/tema/Fonts/Thunderman.ttf
  rofi/config.rasi rofi/emoji-grid.rasi
)
for path in "${required[@]}"; do
  [[ -f "$GIGISHELL/$path" ]] || fail "falta $path"
done

# Guardia contra la regresión que rompió el instalador: una ruta IGNORADA por git no
# puede exigirse, porque en la máquina de desarrollo existe (y pasa) y en un checkout
# limpio no existe nunca (y falla). El fallo no se ve donde se edita la lista, sólo en
# la máquina nueva, que es el peor sitio posible para descubrirlo. Se comprueba contra
# el mismo git que versiona GiGiShell: el repo bare de dotfiles (lo normal) o un clon
# corriente. Sin git no se comprueba nada — es una guardia de desarrollo, no un
# requisito de instalación.
PREFLIGHT_GIT=()
if command -v git >/dev/null 2>&1; then
  if git --git-dir="$HOME/.dotfiles" --work-tree="$HOME" rev-parse --git-dir >/dev/null 2>&1; then
    PREFLIGHT_GIT=(git --git-dir="$HOME/.dotfiles" --work-tree="$HOME")
  elif git -C "$GIGISHELL" rev-parse --show-toplevel >/dev/null 2>&1; then
    PREFLIGHT_GIT=(git -C "$GIGISHELL")
  fi
fi
if ((${#PREFLIGHT_GIT[@]})); then
  for path in "${required[@]}"; do
    "${PREFLIGHT_GIT[@]}" check-ignore -q "$GIGISHELL/$path" 2>/dev/null \
      && fail "required exige un fichero que .gitignore excluye: $path (un checkout limpio nunca lo tendrá)"
  done
fi

# Todos los módulos que carga el config Lua deben formar parte del checkout.
# Bajo hyprlang un `source =` ausente sacaba el overlay de error de Hyprland; en
# Lua un `require` que falla lo captura `util.carga` y solo avisa en pantalla, así
# que un módulo perdido en el checkout es MÁS silencioso que antes — de ahí que se
# valide aquí. Ya no hay excepciones: AGS dejó de generar chunks Lua
# (monitor-settings/input-settings), así que todo lo que se carga está versionado.
while IFS= read -r modulo; do
  relative="${modulo//.//}"
  [[ -f "$GIGISHELL/hypr/$relative.lua" ]] || fail "módulo Lua de Hyprland ausente: $relative.lua"
done < <(sed -nE 's/^[[:space:]]*util\.carga\("([^"]+)"\).*/\1/p' "$GIGISHELL/hypr/hyprland.lua")

# Los perfiles de GPU no se cargan por nombre fijo (los elige el fichero local
# ~/.config/gigishell/gpu-perfil), así que se validan contra la tabla de válidos.
while IFS= read -r perfil; do
  [[ -f "$GIGISHELL/hypr/gigishell/gpu/$perfil.lua" ]] || fail "perfil de GPU ausente: gigishell/gpu/$perfil.lua"
done < <(sed -nE 's/^[[:space:]]*\["([^"]+)"\][[:space:]]*=[[:space:]]*true.*/\1/p' "$GIGISHELL/hypr/gigishell/gpu.lua")

while IFS= read -r reference; do
  case "$reference" in
    '~/.config/hypr/'*) target="$GIGISHELL/hypr/${reference#'~/.config/hypr/'}" ;;
    '~/.config/inicializador/'*) target="$GIGISHELL/inicializador/${reference#'~/.config/inicializador/'}" ;;
    *) continue ;;
  esac
  [[ -e "$target" ]] || fail "autostart ausente: $reference"
done < <(grep -oE '~/.config/(hypr|inicializador)/[^ ;"]+' "$GIGISHELL/hypr/gigishell/autostart.lua" | sort -u)

# El config Lua tiene que parsear: un error de sintaxis deja la sesión SIN
# ATAJOS (solo el SUPER+Q de emergencia), así que es lo más caro que puede
# colarse en un commit. `--verify-config` no detecta errores de EJECUCIÓN, pero
# los de parseo sí, que son los que introduce una edición a mano.
if command -v Hyprland >/dev/null 2>&1; then
  Hyprland --verify-config -c "$GIGISHELL/hypr/hyprland.lua" 2>&1 | grep -q 'config ok' \
    || fail "hypr/hyprland.lua no pasa --verify-config"
fi

while IFS= read -r script; do
  bash -n "$script" || fail "sintaxis Bash: ${script#"$GIGISHELL"/}"
  # Lo que vive en un `lib/` se SOURCEA, no se ejecuta (hoy: lib/gaming-gate.sh),
  # así que exigirle el bit +x era un falso positivo: el bit invitaría a ejecutar
  # algo que ejecutado no hace nada. La comprobación de sintaxis sí aplica.
  case "$script" in */scripts/lib/*) continue ;; esac
  [[ -x "$script" ]] || fail "no es ejecutable: ${script#"$GIGISHELL"/}"
done < <(find "$GIGISHELL/hypr/scripts" "$GIGISHELL/ags/scripts" -type f -name '*.sh' -print)
for script in \
  "$GIGISHELL/install.sh" "$GIGISHELL/bin/link.sh" "$GIGISHELL/bin/preflight.sh" \
  "$GIGISHELL/bin/shell-local.sh" \
  "$GIGISHELL/bin/kitty-profile.sh" "$GIGISHELL/bin/firefox-profile.sh" \
  "$GIGISHELL/bin/generar-hyprcursor.sh" \
  "$GIGISHELL/bin/configurar-dolphin.sh" \
  "$GIGISHELL/bin/configurar-vscode.sh" \
  "$GIGISHELL/inicializador/init.sh"; do
  bash -n "$script" || fail "sintaxis Bash: ${script#"$GIGISHELL"/}"
  [[ -x "$script" ]] || fail "no es ejecutable: ${script#"$GIGISHELL"/}"
done

# Los scripts de Python no los cubría nada. Un error de sintaxis aquí no es
# ruidoso: `wallpaper.sh` se repliega a su sorteo plano y el anclaje de ventanas
# cae a `sh -c`, o sea que la función se apaga en silencio y parece que "ya no
# hace nada". Compilar es instantáneo y lo destapa.
if command -v python3 >/dev/null 2>&1; then
  while IFS= read -r script; do
    python3 -c 'import sys, tokenize; path = sys.argv[1]; compile(tokenize.open(path).read(), path, "exec")' \
      "$script" 2>/dev/null || fail "sintaxis Python: ${script#"$GIGISHELL"/}"
  done < <(find "$GIGISHELL/hypr/scripts" -type f -name '*.py' -print)

  # El motor de selección de fondos decide qué fondo toca a cada hora, y sus casos
  # límite (la vuelta de medianoche, el tramo vacío) fallan de forma muda: el
  # escritorio sale con "un" fondo, solo que el equivocado. Si el test está, se corre.
  #
  # AUSENTE NO DICE NADA, y es deliberado: ningún test se versiona (ver .gitignore),
  # así que un checkout limpio NUNCA lo tiene. Avisar aquí sería un aviso fijo en cada
  # instalación por una decisión tomada a propósito — el mismo ruido que ya rompió el
  # instalador cuando `required` exigía los `*.test.ts`. Los tests son de la máquina de
  # desarrollo; ahí es donde este bloque tiene algo que ejecutar.
  if [[ -f "$GIGISHELL/hypr/scripts/lib/seleccion_fondos_test.py" ]]; then
    (cd "$GIGISHELL/hypr/scripts/lib" && python3 -m unittest discover -p '*_test.py' -q >/dev/null 2>&1) \
      || fail "las pruebas del motor de fondos (hypr/scripts/lib) no pasan"
  fi
fi

[[ -s "$GIGISHELL/ags/estilos/out.css" ]] || warn "ags/estilos/out.css aún no está compilado (lo genera ags/scripts/compilar-css.sh al arrancar AGS)"
app_icons="$GIGISHELL/ags/config/app_icons.json"
if [[ ! -s "$app_icons" ]]; then
  warn "sin ags/config/app_icons.json (los workspaces usarán iconos gráficos)"
elif command -v jq >/dev/null 2>&1; then
  jq -e 'type == "object" and length > 0 and all(to_entries[]; (.key | type == "string") and (.value | type == "string"))' \
    "$app_icons" >/dev/null 2>&1 \
    || warn "ags/config/app_icons.json no es un mapa válido (se usarán iconos gráficos)"
fi
if [[ -e "$HOME/.local/share/gigishell/face.png" ]]; then
  ok "avatar opcional presente"
else
  warn "sin foto de perfil (se usarán iniciales; se pone en Ajustes > Cuenta)"
fi

if [[ "$mode" == "--installed" ]]; then
  # Formato comando:paquete oficial de Arch. Además de detectar la ausencia, deja un
  # comando de reparación directamente utilizable en Arch/CachyOS.
  commands=(
    hyprctl:hyprland hyprlock:hyprlock hypridle:hypridle hyprsunset:hyprsunset
    uwsm:uwsm sass:dart-sass jq:jq rofi:rofi rofimoji:rofimoji wtype:wtype magick:imagemagick
    cliphist:cliphist wl-copy:wl-clipboard wl-paste:wl-clipboard
    brightnessctl:brightnessctl ddcutil:ddcutil playerctl:playerctl wpctl:wireplumber
    pactl:libpulse pw-metadata:pipewire wf-recorder:wf-recorder grim:grim
    slurp:slurp hyprshot:hyprshot awww:awww awww-daemon:awww
    v4l2-ctl:v4l-utils fuser:psmisc mpv:mpv
    notify-send:libnotify nmcli:networkmanager
    nm-connection-editor:nm-connection-editor bluetoothctl:bluez-utils
    blueman-manager:blueman inotifywait:inotify-tools
    dbus-monitor:dbus busctl:systemd udevadm:systemd rfkill:util-linux flock:util-linux pkexec:polkit
    udisksctl:udisks2 lsof:lsof ntfsfix:ntfsprogs fsck.fat:dosfstools fsck.exfat:exfatprogs
    modprobe:kmod btop:btop kitty:kitty firefox:firefox
    zsh:zsh stty:util-linux fzf:fzf eza:eza bat:bat duf:duf
    pkgfile:pkgfile fastfetch:fastfetch less:less man:man-db whatis:man-db
    tar:tar expac:expac hwinfo:hwinfo nc:openbsd-netcat nvim:neovim
    code:code fc-match:fontconfig
    dolphin:dolphin kbuildsycoca6:kservice kwriteconfig6:kconfig qt6ct:qt6ct xdg-open:xdg-utils
    update-mime-database:shared-mime-info
    ark:ark 7z:7zip unrar:unrar elisa:elisa filelight:filelight
    gwenview:gwenview haruna:haruna kate:kate kfind:kfind
    kolourpaint:kolourpaint libreoffice:libreoffice-fresh okular:okular
    partitionmanager:partitionmanager simple-scan:simple-scan
    clamscan:clamav firejail:firejail bwrap:bubblewrap gamemoded:gamemode
    xdg-user-dir:xdg-user-dirs
    # Sonido de las notificaciones (alarmas y temporizador del panel de reloj). Se declara
    # explícito en vez de confiar en que libcanberra llegue como dependencia transitiva de otra
    # cosa: sin él, una alarma se ve pero no suena, y el fallo es silencioso por diseño.
    canberra-gtk-play:libcanberra
    # Las DOS mitades del generador de punteros (bin/generar-hyprcursor.sh). xcur2png va
    # explícito porque es la que se olvida: hyprcursor-util lo llama para leer los
    # XCursor y sin él aborta con "missing dependency: -x requires xcur2png", pero el
    # paquete hyprcursor no lo arrastra. Cuando falta, el compositor no dibuja el tema
    # elegido: libhyprcursor coge el primer tema con manifest.hl que encuentre.
    hyprcursor-util:hyprcursor xcur2png:xcur2png
  )
  for entry in "${commands[@]}"; do
    command="${entry%%:*}"
    package="${entry#*:}"
    command -v "$command" >/dev/null 2>&1 \
      || fail "falta '$command' (Arch/CachyOS: sudo pacman -S --needed $package)"
  done

  # gigishell-eventd es opcional (sin él, oom-monitor.sh corre en bash), así que su
  # ausencia es AVISO. Lo que sí importa es que no esté DESACTUALIZADO: el script le
  # cede todo al binario, y uno compilado antes de un cambio en eventd/src seguiría
  # aplicando las reglas viejas sin ningún síntoma.
  eventd_bin="$HOME/.local/bin/gigishell-eventd"
  if [[ ! -x "$eventd_bin" ]]; then
    warn "gigishell-eventd no instalado: el monitor de seguridad corre en bash (bash install.sh --solo eventd)"
  elif ! "$eventd_bin" --modulos >/dev/null 2>&1; then
    fail "gigishell-eventd no arranca (--modulos falla): recompila con $GIGISHELL/eventd/instalar.sh o quítalo con --quitar"
  elif [[ -n "$(find "$GIGISHELL/eventd/src" "$GIGISHELL/eventd/Cargo.toml" -newer "$eventd_bin" -print -quit 2>/dev/null)" ]]; then
    warn "gigishell-eventd es más viejo que su código: recompila con $GIGISHELL/eventd/instalar.sh"
  else
    ok "gigishell-eventd instalado y al día"
  fi

  fc-match 'Noto Color Emoji' 2>/dev/null | grep -qi 'NotoColorEmoji' \
    || fail "falta Noto Color Emoji (sudo pacman -S --needed noto-fonts-emoji)"

  # No basta con que el binario exista: el tramo bajo del slider de brillo atenúa por
  # SOFTWARE reduciendo el gamma (la CTM del KMS), y eso lo aplica hyprsunset. Sin soporte
  # de `--gamma` el fallo es MUDO — `execAsync(...).catch(() => {})` en
  # `ags/servicios/pantalla/brightness.ts` se traga el error y el slider simplemente deja de
  # oscurecer por debajo del suelo del monitor, sin nada que lo delate. La luz nocturna sigue
  # funcionando, así que es degradación y no instalación rota: aviso, no error.
  # Se mira el `--help` a propósito: no exige que hyprsunset esté corriendo, al contrario que
  # consultar el IPC (`hyprctl hyprsunset gamma`), que sin demonio vivo no distingue "esta
  # versión no sabe de gamma" de "ahora mismo no hay luz nocturna encendida".
  if command -v hyprsunset >/dev/null 2>&1; then
    if hyprsunset --help 2>&1 | grep -q -- '--gamma'; then
      ok "hyprsunset soporta --gamma (atenuación por software del brillo)"
    else
      warn "hyprsunset sin soporte de --gamma: el brillo no bajará del mínimo del monitor (actualiza hyprsunset)"
    fi
  fi

  # La comparación es de LÍNEA EXACTA a propósito: lo que se valida no es "esta app
  # aparece en algún sitio" sino el ORDEN, y el orden es lo que decide qué app abre el
  # archivo. Contrapartida conocida: cambiar un predeterminado desde Dolphin («Abrir con >
  # Establecer como predeterminada») reescribe mimeapps.list y hace fallar este bloque —
  # es lo buscado. Si el cambio era a propósito, se actualiza la tabla de aquí abajo en el
  # mismo commit que el mimeapps.list; si no, el fallo avisa de que una app te ha robado
  # una asociación por la espalda, que era invisible hasta que abrías el archivo.
  while IFS='|' read -r mime application; do
    grep -Fqx "$mime=$application;" "$GIGISHELL/mimeapps.list" \
      || fail "asociación MIME ausente: $mime -> $application (actual: $(grep -m1 "^$mime=" "$GIGISHELL/mimeapps.list" || echo 'sin entrada'))"
  done <<'EOF'
inode/directory|org.kde.dolphin.desktop
application/pdf|firefox.desktop
application/epub+zip|okularApplication_epub.desktop
image/png|org.kde.gwenview.desktop
video/mp4|org.kde.haruna.desktop
audio/mpeg|org.kde.elisa.desktop
text/plain|org.kde.kate.desktop
text/markdown|code.desktop;obsidian.desktop;org.kde.kate.desktop
text/x-xresources|org.kde.kate.desktop
text/x-csrc|code.desktop
text/x-configuration|code.desktop
text/x-typescript-jsx|code.desktop
application/x-executable|code.desktop
application/octet-stream|org.kde.kate.desktop
application/zip|org.kde.ark.desktop
application/vnd.openxmlformats-officedocument.wordprocessingml.document|libreoffice-writer.desktop
EOF
  grep -Fqx 'TerminalApplication=kitty' "$GIGISHELL/kdeglobals" \
    || fail "kdeglobals no configura Kitty como terminal"
  grep -Fqx 'ColorScheme=BreezeDark' "$GIGISHELL/kdeglobals" \
    || fail "kdeglobals no configura Breeze Dark como esquema de colores"
  awk '
    /^\[UiSettings\]$/ { en_ajustes=1; next }
    /^\[/ { en_ajustes=0 }
    en_ajustes && /^ColorScheme=BreezeDark$/ { encontrado=1 }
    END { exit !encontrado }
  ' "$GIGISHELL/kdeglobals" \
    || fail "kdeglobals no activa Breeze Dark para KColorSchemeManager"
  grep -Fqx 'BackgroundNormal=20,22,24' "$GIGISHELL/kdeglobals" \
    || fail "kdeglobals no contiene la paleta materializada de Breeze Dark"
  grep -Fqx 'hl.env("QT_QPA_PLATFORMTHEME", "qt6ct")' "$GIGISHELL/hypr/gigishell/env.lua" \
    || fail "Hyprland no activa qt6ct como tema de plataforma Qt"
  grep -Fq 'reparar-kdeglobals.sh' "$GIGISHELL/hypr/gigishell/autostart.lua" \
    || fail "el autostart no repone [UiSettings] en kdeglobals (lo borra cualquier app KDE al guardar ajustes)"
  grep -Fqx 'hl.env("QT_SCALE_FACTOR", "0.9")' "$GIGISHELL/hypr/gigishell/env.lua" \
    || fail "Hyprland no configura la densidad compacta de las aplicaciones Qt"
  grep -Fqx 'color_scheme_path=/usr/share/qt6ct/colors/darker.conf' "$GIGISHELL/qt6ct/qt6ct.conf" \
    || fail "qt6ct no configura la paleta oscura"
  grep -Fqx 'custom_palette=true' "$GIGISHELL/qt6ct/qt6ct.conf" \
    || fail "qt6ct no activa la paleta personalizada"
  grep -Fqx 'style=Breeze' "$GIGISHELL/qt6ct/qt6ct.conf" \
    || fail "qt6ct no configura el estilo Breeze"
  grep -Fqx 'general="Noto Sans,10,-1,5,50,0,0,0,0,0,Regular"' "$GIGISHELL/qt6ct/qt6ct.conf" \
    || fail "qt6ct no configura la fuente general compacta"
  grep -Fqx 'fixed="Noto Sans Mono,10,-1,5,50,0,0,0,0,0,Regular"' "$GIGISHELL/qt6ct/qt6ct.conf" \
    || fail "qt6ct no configura la fuente monoespaciada compacta"
  grep -Fqx 'Theme=Tela-circle-grey' "$GIGISHELL/kdeglobals" \
    || fail "kdeglobals no configura Tela circle grey como tema de iconos"
  [[ -r /usr/share/color-schemes/BreezeDark.colors ]] \
    || fail "falta Breeze Dark (sudo pacman -S --needed breeze)"
  compgen -G '/usr/lib/qt6/plugins/styles/breeze*.so' >/dev/null \
    || fail "falta el plugin de estilo Breeze para Qt 6 (sudo pacman -S --needed breeze)"
  [[ -r /usr/share/qt6ct/colors/darker.conf ]] \
    || fail "falta la paleta oscura de qt6ct (sudo pacman -S --needed qt6ct)"
  [[ -r /usr/lib/qt6/plugins/platformthemes/libqt6ct.so ]] \
    || fail "falta el plugin de plataforma de qt6ct (sudo pacman -S --needed qt6ct)"
  if pacman -Q hyprland >/dev/null 2>&1 &&
    { pacman -Q hyprutils-git >/dev/null 2>&1 || pacman -Q hyprlang-git >/dev/null 2>&1; }; then
    fail "Hyprland estable está mezclado con bibliotecas -git; restaura hyprutils e hyprlang estables"
  fi
  [[ -r /usr/lib/qt6/plugins/kf6/thumbcreator/ffmpegthumbs.so ]] \
    || fail "falta el miniaturizador de vídeo (sudo pacman -S --needed ffmpegthumbs)"
  [[ -r /usr/lib/qt6/plugins/kf6/thumbcreator/gsthumbnail.so ]] \
    || fail "falta el miniaturizador de PDF (sudo pacman -S --needed kdegraphics-thumbnailers)"
  "$GIGISHELL/bin/configurar-dolphin.sh" --check \
    || fail "el perfil ligero de Dolphin no está aplicado"
  if [[ ! -d /usr/share/icons/Tela-circle-grey && ! -d "$HOME/.local/share/icons/Tela-circle-grey" ]]; then
    fail "falta el tema Tela circle grey (sudo pacman -S --needed tela-circle-icon-theme-grey)"
  fi
  command -v ags >/dev/null 2>&1 \
    || fail "falta 'ags' (AUR: paru -S --needed aylurs-gtk-shell-git libastal-meta; también sirve yay)"
  [[ -r /usr/share/oh-my-zsh/oh-my-zsh.sh ]] \
    || fail "falta Oh My Zsh (CachyOS: sudo pacman -S --needed oh-my-zsh-git)"
  [[ -r /usr/share/zsh-theme-powerlevel10k/powerlevel10k.zsh-theme ]] \
    || fail "falta Powerlevel10k (sudo pacman -S --needed zsh-theme-powerlevel10k)"
  for plugin in zsh-autosuggestions zsh-syntax-highlighting zsh-history-substring-search; do
    compgen -G "/usr/share/zsh/plugins/$plugin/*.zsh" >/dev/null \
      || fail "falta el plugin $plugin (sudo pacman -S --needed $plugin)"
  done
  # Shells partidas en compartido (versionado) + local de cada equipo (sin
  # versionar, lo crea bin/shell-local.sh). Ver docs/shell-local.md.
  "$GIGISHELL/bin/shell-local.sh" --check >/dev/null \
    || fail "ficheros locales de las shells ausentes o sin cargar el compartido (bin/shell-local.sh)"
  # Lo propio de una máquina no puede colarse en lo compartido: otro equipo puede
  # no tener esa herramienta, o tenerla en otra ruta o con otro usuario.
  for shared_file in "$HOME/.config/bash/bashrc" "$HOME/.config/zsh/gigishell.zshenv" \
    "$HOME/.config/zsh/gigishell.zshrc" "$HOME/.config/fish/conf.d/gigishell.fish" \
    "$HOME/.config/zsh/functions/"*.zsh; do
    [[ -f "$shared_file" ]] || continue
    if grep -vE '^[[:space:]]*#' "$shared_file" \
      | grep -qE '/home/|\.cargo/|\.bun|opam-init|fnm env|depot_tools'; then
      fail "configuración de shell compartida con rutas de este equipo: $shared_file (va en el fichero local)"
    fi
  done
  bash -n "$HOME/.config/bash/bashrc" 2>/dev/null || fail "sintaxis Bash: ~/.config/bash/bashrc"
  for zsh_file in "$HOME/.zshenv" "$HOME/.config/zsh/gigishell.zshenv" "$HOME/.config/zsh/gigishell.zshrc" \
    "$HOME/.config/zsh/.zshenv" "$HOME/.config/zsh/.zshrc" "$HOME/.config/zsh/functions/"*.zsh; do
    [[ -f "$zsh_file" ]] || { fail "falta configuración Zsh: $zsh_file"; continue; }
    zsh -n "$zsh_file" || fail "sintaxis Zsh: $zsh_file"
  done
  zsh -ic '
    [[ "$(bindkey -M emacs "^C")" == *fish_clear_commandline* ]] &&
    [[ "$(bindkey -M emacs $'"'"'\e[13;5u'"'"')" == *accept-line* ]] &&
    [[ "$POWERLEVEL9K_DIR_FOREGROUND" == 4 ]] &&
    [[ "$POWERLEVEL9K_PROMPT_CHAR_OK_VIINS_FOREGROUND" == 5 ]] &&
    [[ "$ZSH_HIGHLIGHT_STYLES[default]" == fg=6 ]] &&
    (( ${precmd_functions[(I)_fish_ctrl_c_for_zle]} )) &&
    (( ${preexec_functions[(I)_fish_ctrl_c_for_commands]} ))
  ' >/dev/null 2>&1 || fail "Zsh no cargó los bindings o la paleta de Fish"

  # La comprobación de arriba mira $ZSH_HIGHLIGHT_STYLES, que fish-parity.zsh
  # RELLENA A MANO: pasaba igual de bien con zsh-syntax-highlighting sin cargar.
  # Lo mismo con las sugerencias. Durante meses ambos plugins estuvieron muertos
  # porque .zshrc los buscaba en $ZSH/plugins (de Oh My Zsh) cuando Arch los pone
  # en /usr/share/zsh/plugins: ni un error, solo una terminal sin sugerencias en
  # gris y sin colores. Aquí se interroga el RUNTIME, no la configuración.
  zsh_runtime="$(zsh -ic '
    print -r -- "autosuggest=${+functions[_zsh_autosuggest_start]}"
    print -r -- "highlight=${ZSH_HIGHLIGHT_VERSION:-no}"
    print -r -- "substring=${+widgets[history-substring-search-up]}"
    print -r -- "globdots=${${_comp_options[(r)globdots]}:-no}"
  ' 2>/dev/null)"
  [[ "$zsh_runtime" == *"autosuggest=1"* ]] \
    || fail "zsh-autosuggestions no está cargado (revisá el source en ~/.config/zsh/gigishell.zshrc)"
  [[ "$zsh_runtime" == *"highlight=no"* ]] \
    && fail "zsh-syntax-highlighting no está cargado (revisá el source en ~/.config/zsh/gigishell.zshrc)"
  [[ "$zsh_runtime" == *"substring=1"* ]] \
    || fail "zsh-history-substring-search no está cargado (lo sourcea fish-parity.zsh)"
  [[ "$zsh_runtime" == *"globdots=globdots"* ]] \
    || fail "Tab no completa ficheros ocultos: falta '_comp_options+=(globdots)' en ~/.config/zsh/gigishell.zshrc"
  grep -q 'p10k-instant-prompt' "$HOME/.config/zsh/gigishell.zshrc" \
    || fail "falta el prompt instantáneo de Powerlevel10k en ~/.config/zsh/gigishell.zshrc (cada terminal espera a que cargue todo)"
  for fish_file in "$HOME/.config/fish/conf.d/gigishell.fish" "$HOME/.config/fish/config.fish" "$HOME/.config/fish/functions/"*.fish; do
    [[ -f "$fish_file" ]] || { fail "falta configuración Fish: $fish_file"; continue; }
    fish -n "$fish_file" || fail "sintaxis Fish: $fish_file"
  done
  kitty_dir="${KITTY_CONFIG_DIRECTORY:-${XDG_CONFIG_HOME:-$HOME/.config}/kitty}"
  kitty_config="$kitty_dir/kitty.conf"
  kitty_selector="$kitty_dir/active-profile.conf"
  for kitty_file in \
    "$kitty_config" "$kitty_dir/base.conf" "$kitty_dir/theme.conf" \
    "$kitty_dir/profiles/laptop.conf" "$kitty_dir/profiles/desktop.conf"; do
    [[ -f "$kitty_file" ]] || fail "falta configuración Kitty: $kitty_file"
  done

  kitty_profile=
  kitty_expected=
  if [[ ! -L "$kitty_selector" ]]; then
    fail "falta el selector local de Kitty: $kitty_selector (ejecutá bin/kitty-profile.sh auto)"
  else
    kitty_target="$(readlink -f "$kitty_selector")"
    case "$kitty_target" in
      "$(readlink -f "$kitty_dir/profiles/laptop.conf")")
        kitty_profile=laptop
        kitty_expected='16,5,1,1,0,2000,0'
        ;;
      "$(readlink -f "$kitty_dir/profiles/desktop.conf")")
        kitty_profile=desktop
        kitty_expected='2,0,1,1,0,2000,5'
        ;;
      *) fail "el selector de Kitty apunta a un perfil desconocido: $kitty_target" ;;
    esac
  fi

  validate_kitty_options() {
    local path="$1" expected="$2" label="$3" validate_common="${4:-0}"
    KITTY_VALIDATE_CONFIG="$path" \
      KITTY_EXPECTED_OPTIONS="$expected" \
      KITTY_VALIDATE_COMMON="$validate_common" \
      kitty +runpy '
import os
import sys
from kitty.config import load_config

bad_lines = []
options = load_config(
    os.environ["KITTY_VALIDATE_CONFIG"],
    accumulate_bad_lines=bad_lines,
)
if bad_lines:
    for bad_line in bad_lines:
        print(bad_line, file=sys.stderr)
    raise SystemExit(1)
expected = tuple(int(value) for value in os.environ["KITTY_EXPECTED_OPTIONS"].split(","))
actual = (
    int(options.repaint_delay),
    int(options.input_delay),
    int(options.sync_to_monitor),
    int(options.cursor_trail),
    int(options.cursor_blink_interval[0]),
    int(options.scrollback_lines),
    int(options.scrollback_pager_history_size // (1024 * 1024)),
)
if actual != expected:
    print(f"valores efectivos {actual}; esperados {expected}", file=sys.stderr)
    raise SystemExit(1)
if os.environ["KITTY_VALIDATE_COMMON"] == "1":
    common_ok = (
        options.shell_integration == frozenset({"enabled"})
        and options.allow_remote_control == "no"
        and options.notify_on_cmd_finish.when == "invisible"
        and options.notify_on_cmd_finish.duration == 15.0
        and options.strip_trailing_spaces == "smart"
        and options.scrollback_fill_enlarged_window
        and options.tab_activity_symbol == "● "
    )
    if not common_ok:
        print("las mejoras comunes de Kitty no están activas", file=sys.stderr)
        raise SystemExit(1)
' >/dev/null 2>&1 || fail "Kitty no cargó correctamente $label"
  }

  validate_kitty_options "$kitty_dir/profiles/laptop.conf" '16,5,1,1,0,2000,0' "profiles/laptop.conf"
  validate_kitty_options "$kitty_dir/profiles/desktop.conf" '2,0,1,1,0,2000,5' "profiles/desktop.conf"
  if [[ -n "$kitty_profile" ]]; then
    validate_kitty_options "$kitty_config" "$kitty_expected" "kitty.conf con el perfil $kitty_profile" 1
  fi

  while IFS= read -r kitty_mapping; do
    awk '{$1=$1; print}' "$kitty_config" | grep -Fqx "$kitty_mapping" \
      || fail "falta el atajo de Kitty: $kitty_mapping"
  done <<'EOF'
map ctrl+enter send_text all \e[13;5u
map alt+enter send_text all \e\r
map ctrl+shift+z send_text all \e[122;6u
map ctrl+shift+enter new_window_with_cwd
map ctrl+shift+t new_tab_with_cwd
map ctrl+shift+n new_os_window_with_cwd
map ctrl+alt+z scroll_to_prompt -1
map ctrl+alt+x scroll_to_prompt 1
map ctrl+shift+g show_last_command_output
map ctrl+shift+h show_scrollback
map ctrl+shift+e open_url_with_hints
map ctrl+alt+l clear_terminal last_command active
EOF
  firefox_dir="${FIREFOX_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/firefox}"
  for firefox_file in \
    "$firefox_dir/base.js" \
    "$firefox_dir/profiles/laptop.js" \
    "$firefox_dir/profiles/desktop.js"; do
    [[ -f "$firefox_file" ]] || fail "falta configuración Firefox: $firefox_file"
  done

  while IFS='|' read -r firefox_file firefox_pref firefox_value; do
    grep -Fqx "user_pref(\"$firefox_pref\", $firefox_value);" "$firefox_dir/$firefox_file" \
      || fail "Firefox no tiene $firefox_pref=$firefox_value en $firefox_file"
  done <<'EOF'
profiles/laptop.js|dom.ipc.processCount|4
profiles/laptop.js|dom.ipc.processCount.webIsolated|2
profiles/laptop.js|browser.cache.memory.capacity|65536
profiles/laptop.js|browser.tabs.unloadOnLowMemory|true
profiles/laptop.js|browser.sessionstore.interval|60000
profiles/laptop.js|network.prefetch-next|false
profiles/laptop.js|general.smoothScroll|false
profiles/desktop.js|dom.ipc.processCount|6
profiles/desktop.js|dom.ipc.processCount.webIsolated|3
profiles/desktop.js|browser.cache.memory.capacity|131072
profiles/desktop.js|browser.tabs.unloadOnLowMemory|true
profiles/desktop.js|browser.sessionstore.interval|30000
profiles/desktop.js|network.prefetch-next|true
profiles/desktop.js|general.smoothScroll|true
EOF

  if grep -Eq \
    'user_pref\("(security\.OCSP\.enabled|browser\.safebrowsing\.(malware|phishing)\.enabled|media\.peerconnection\.enabled)",[[:space:]]*(0|false)\);|user_pref\("media\.hardware-video-decoding\.force-enabled",[[:space:]]*true\);' \
    "$firefox_dir/base.js" "$firefox_dir/profiles/"*.js; then
    fail "Firefox contiene una preferencia insegura o una aceleración forzada"
  fi
  while IFS='|' read -r firefox_pref firefox_value; do
    grep -Fqx "user_pref(\"$firefox_pref\", $firefox_value);" "$firefox_dir/base.js" \
      || fail "Firefox no restaura $firefox_pref=$firefox_value en base.js"
  done <<'EOF'
security.OCSP.enabled|1
browser.safebrowsing.malware.enabled|true
browser.safebrowsing.phishing.enabled|true
browser.safebrowsing.downloads.enabled|true
media.peerconnection.enabled|true
reader.parse-on-load.enabled|true
EOF
  "$GIGISHELL/bin/firefox-profile.sh" status >/dev/null 2>&1 \
    || fail "el perfil de Firefox no está compuesto o enlazado correctamente"

  # VS Code sin almacén de secretos fijado = un cartel modal pidiendo el llavero del
  # sistema en cada arranque, porque esta sesión no ofrece org.freedesktop.secrets (ver
  # bin/configurar-vscode.sh). Es AVISO y no ERROR: ~/.vscode/argv.json no existe hasta
  # que VS Code se abre por primera vez, así que en una instalación recién hecha faltar
  # es lo normal y el paso `vscode` lo dejará puesto en cuanto haya fichero.
  if command -v code >/dev/null 2>&1; then
    "$GIGISHELL/bin/configurar-vscode.sh" --check >/dev/null 2>&1 \
      || warn "VS Code no tiene password-store fijado (pedirá el llavero del sistema en cada arranque): bin/configurar-vscode.sh aplicar"
  fi

  font_family="$(fc-match -f '%{family}' 'CaskaydiaCove Nerd Font Mono' 2>/dev/null)"
  [[ "$font_family" == *CaskaydiaCove* || "$font_family" == *Caskaydia\ Cove* ]] \
    || fail "falta CaskaydiaCove Nerd Font (sudo pacman -S --needed ttf-cascadia-code-nerd)"
  current_user="$(id -un)"
  login_shell="$(getent passwd "$current_user" | cut -d: -f7)"
  # El shell de login es Zsh, no Fish: Fish está instalado como referencia de la paridad
  # que reproduce fish-parity.zsh (de ahí que arriba solo se le compruebe la sintaxis).
  # Se mira /etc/passwd y no $SHELL: $SHELL lo hereda el proceso que lanzó el preflight
  # del login, así que sigue valiendo lo de antes durante toda la sesión en la que se
  # corrió el chsh, y daba OK con el cambio sin aplicar (y al revés).
  [[ "$(readlink -f "$login_shell" 2>/dev/null)" == "$(readlink -f "$(command -v zsh)")" ]] \
    || fail "Zsh no es el shell predeterminado de $current_user (actual: $login_shell); corré: chsh -s \"$(command -v zsh)\" y volvé a iniciar sesión"
  if pacman -Si cachyos-fish-config >/dev/null 2>&1; then
    [[ -r /usr/share/cachyos-fish-config/cachyos-config.fish ]] \
      || fail "falta el perfil Fish de CachyOS (sudo pacman -S --needed cachyos-fish-config)"
    command -v cachyos-rate-mirrors >/dev/null 2>&1 \
      || fail "falta cachyos-rate-mirrors para los alias update/mirror"
  fi
  # cava es OPCIONAL a propósito: sin él la onda de Spotify de la barra no falla, cae a su
  # animación procedimental (servicios/multimedia/espectro.ts). No puede ser un `fail`.
  optional_commands=(nvidia-smi gh lshw glxinfo sensors smartctl magick cava)
  for command in "${optional_commands[@]}"; do
    command -v "$command" >/dev/null 2>&1 || warn "comando opcional no disponible: $command"
  done
  [[ -e /usr/share/xdg-desktop-portal/portals/hyprland.portal ]] \
    || fail "falta el portal de Hyprland (xdg-desktop-portal-hyprland)"
  [[ -e /usr/share/xdg-desktop-portal/portals/gtk.portal ]] \
    || fail "falta el portal GTK para selectores de archivos"
  [[ -e /usr/lib/girepository-1.0/GUdev-1.0.typelib ]] \
    || fail "falta el typelib GUdev (libgudev)"
  for namespace in Battery Bluetooth Hyprland Mpris Network Notifd Tray Wp; do
    compgen -G "/usr/lib/girepository-1.0/Astal${namespace}-*.typelib" >/dev/null \
      || fail "falta Astal${namespace} (AUR: paru -S --needed libastal-meta; también sirve yay)"
  done
  if command -v ags >/dev/null 2>&1; then
    bundle="$(mktemp "${TMPDIR:-/tmp}/gigishell-ags.XXXXXX")"
    if ags bundle "$GIGISHELL/ags/app.ts" "$bundle" >/dev/null 2>&1; then
      ok "AGS resuelve todos los imports"
    else
      fail "AGS no puede empaquetar app.ts; revisa imports y bibliotecas Astal"
    fi
    rm -f "$bundle"
  fi
  # Perfil de GPU. Sin él gigishell/gpu.lua avisa en pantalla EN CADA INICIO DE SESIÓN, y
  # como el escritorio arranca igual el aviso se vuelve ruido de fondo que nadie atiende.
  # El instalador lo escribe solo (paso `gpu`); aquí sólo se comprueba que quedó puesto y
  # que el nombre existe como módulo — un nombre inválido no aplica NADA y avisa igual.
  gpu_perfil_ruta="$HOME/.config/gigishell/gpu-perfil"
  if [[ -s "$gpu_perfil_ruta" ]]; then
    gpu_perfil="$(tr -d '[:space:]' < "$gpu_perfil_ruta")"
    if [[ -f "$GIGISHELL/hypr/gigishell/gpu/$gpu_perfil.lua" ]]; then
      ok "perfil de GPU: $gpu_perfil"
      # Que el nombre EXISTA no quiere decir que CORRESPONDA a esta máquina. El paso
      # `gpu` del instalador nunca pisa un perfil ya escrito (correcto: la elección es
      # del usuario), asi que un perfil que se queda obsoleto lo sigue estando para
      # siempre — cambiar de tarjeta o mover el disco a otro equipo basta. Y el fallo es
      # mudo: sobremesa-nvidia sobre una máquina sin NVIDIA exporta GBM_BACKEND=nvidia-drm
      # y LIBVA_DRIVER_NAME=nvidia sobre Mesa, que es justo lo que gpu/integrada.lua
      # describe como "rompen la aceleración de vídeo en vez de mejorarla".
      #
      # Es warn y no fail a propósito: el usuario puede tener una razón para forzar un
      # perfil (una tarjeta que la detección no clasifica bien), y esto no debe tumbar
      # una instalación por lo demás correcta.
      gpu_hay_nvidia=0
      gpu_hay_integrada=0
      for gpu_dispositivo in /sys/bus/pci/devices/*; do
        [[ -r "$gpu_dispositivo/class" && -r "$gpu_dispositivo/vendor" ]] || continue
        IFS= read -r gpu_clase < "$gpu_dispositivo/class" || continue
        [[ "$gpu_clase" == 0x03* ]] || continue
        IFS= read -r gpu_vendor < "$gpu_dispositivo/vendor" || continue
        case "$gpu_vendor" in
          0x10de) gpu_hay_nvidia=1 ;;
          0x8086|0x1002|0x1022) gpu_hay_integrada=1 ;;
        esac
      done
      case "$gpu_perfil" in
        sobremesa-nvidia|laptop-hibrida)
          (( gpu_hay_nvidia )) \
            || warn "el perfil de GPU '$gpu_perfil' asume una NVIDIA y aquí no hay ninguna: exporta GBM_BACKEND/LIBVA_DRIVER_NAME de NVIDIA sobre Mesa (echo integrada > $gpu_perfil_ruta)"
          ;;
        integrada)
          (( gpu_hay_nvidia )) \
            && warn "hay una NVIDIA pero el perfil de GPU es 'integrada', que no configura nada (ejecutá: rm $gpu_perfil_ruta && bash install.sh --solo gpu)"
          ;;
      esac
      if [[ "$gpu_perfil" == laptop-hibrida ]] && (( ! gpu_hay_integrada )); then
        warn "el perfil de GPU 'laptop-hibrida' deja el compositor en la iGPU y aquí no hay ninguna (¿querías sobremesa-nvidia?)"
      fi
      # El driver VA-API que esos dos perfiles dan por supuesto. Sin él
      # LIBVA_DRIVER_NAME=nvidia apunta a un driver inexistente y la decodificación por
      # hardware deja de funcionar sin un solo error.
      case "$gpu_perfil" in
        sobremesa-nvidia)
          pacman -Q libva-nvidia-driver >/dev/null 2>&1 \
            || fail "el perfil '$gpu_perfil' exporta LIBVA_DRIVER_NAME=nvidia pero falta libva-nvidia-driver (sudo pacman -S --needed libva-nvidia-driver)"
          ;;
      esac
    else
      fail "perfil de GPU desconocido: '$gpu_perfil' (no existe hypr/gigishell/gpu/$gpu_perfil.lua)"
    fi
  else
    warn "sin perfil de GPU en $gpu_perfil_ruta (Hyprland avisará en cada inicio; ejecutá install.sh --solo gpu)"
  fi

  # Cámara bloqueada SIN forma de desbloquearla. Es la única trampa del killswitch, y es
  # de las que dejan al usuario encerrado: el bloqueo es la PRESENCIA de un fichero de regla
  # udev, así que sobrevive a reinstalar el sistema de ficheros del repo, a reiniciar y a
  # borrar la configuración de GiGiShell. Si en esa situación falta el helper root-owned —una
  # instalación nueva donde el paso `sistema` no llegó a correr, o un /usr/local limpiado— el
  # interruptor de la UI no puede apagarlo y la cámara se queda muerta sin que nada explique
  # por qué. Se comprueba el par entero, no cada mitad por su lado.
  if [[ -f /etc/udev/rules.d/71-gigishell-camara-bloqueada.rules ]]; then
    if [[ -x /usr/local/bin/gigishell-camara ]]; then
      ok "cámara bloqueada a propósito (el interruptor de Ajustes > Cámara puede desbloquearla)"
    else
      fail "la cámara está bloqueada y falta /usr/local/bin/gigishell-camara para desbloquearla (bash install.sh --solo sistema, o sudo rm /etc/udev/rules.d/71-gigishell-camara-bloqueada.rules)"
    fi
  fi

  # Entorno del MODO GESTOS. Es OPCIONAL —el resto del escritorio funciona igual sin él— así
  # que ausente es AVISO y no error; lo que sí sería un error mudo es tenerlo a medias.
  #
  # Se comprueban las dos mitades por separado porque fallan por separado y se arreglan
  # distinto, y sobre todo se comprueba que el intérprete IMPORTE: un venv creado con un
  # Python que ya no existe (Arch sube de versión mayor y el enlace del venv queda colgando)
  # conserva todos sus ficheros y pasa cualquier test de existencia, pero no arranca. Ese es
  # justo el fallo que este bloque existe para cazar, porque desde fuera parece instalado.
  gestos_dir="${XDG_DATA_HOME:-$HOME/.local/share}/gigishell/gestos"
  if [[ -e "$gestos_dir/venv" || -e "$gestos_dir/hand_landmarker.task" ]]; then
    if [[ ! -x "$gestos_dir/venv/bin/python" ]]; then
      fail "el entorno del modo gestos está a medias: falta el intérprete del venv (bash install.sh --solo gestos)"
    elif ! "$gestos_dir/venv/bin/python" -c 'import mediapipe, cv2' >/dev/null 2>&1; then
      fail "el venv de gestos existe pero no importa mediapipe/cv2 (¿cambió la versión de Python?): bash install.sh --solo gestos"
    elif [[ ! -s "$gestos_dir/hand_landmarker.task" ]]; then
      fail "falta el modelo de manos del modo gestos (bash install.sh --solo gestos)"
    else
      ok "modo gestos instalado (SUPER+SHIFT+G)"
    fi
  else
    warn "sin entorno del modo gestos; SUPER+SHIFT+G no hará nada (opcional: bash install.sh --solo gestos)"
  fi

  # TLP. Sólo aplica donde hay batería del sistema: el instalador no instala TLP en un
  # sobremesa a propósito. La trampa que esto destapa es que el paquete puede estar
  # instalado y la unidad NO activada — el selector de Ajustes > Energía sigue
  # funcionando (el helper hace `tlp start` en caliente) y por eso nadie lo nota, pero
  # cada arranque empieza sin gestión de energía y el portátil consume de más.
  if compgen -G '/sys/class/power_supply/*/type' >/dev/null; then
    tiene_bateria_sistema=0
    for tipo_fichero in /sys/class/power_supply/*/type; do
      [[ -r "$tipo_fichero" ]] || continue
      IFS= read -r tipo < "$tipo_fichero" || continue
      [[ "$tipo" == Battery ]] || continue
      alimentacion="${tipo_fichero%/type}"
      if [[ -r "$alimentacion/scope" ]]; then
        IFS= read -r alcance < "$alimentacion/scope" || continue
        [[ "$alcance" == Device ]] && continue
      fi
      tiene_bateria_sistema=1
      break
    done
    if ((tiene_bateria_sistema)); then
      if ! command -v tlp >/dev/null 2>&1; then
        fail "falta 'tlp' en un equipo con batería (sudo pacman -S --needed tlp tlp-rdw)"
      elif ! systemctl is-enabled --quiet tlp.service 2>/dev/null; then
        fail "tlp.service no está activado: cada arranque empieza sin gestión de energía (sudo systemctl enable --now tlp.service)"
      else
        ok "TLP activo (perfiles Normal/Ahorro de Ajustes > Energía)"
      fi
      if systemctl is-enabled --quiet power-profiles-daemon.service 2>/dev/null ||
         systemctl is-active --quiet power-profiles-daemon.service 2>/dev/null; then
        warn "power-profiles-daemon compite con TLP por los mismos ajustes (sudo systemctl disable --now power-profiles-daemon.service)"
      fi
    fi
  fi

  # Hibernación. Solo se comprueba si el usuario la tiene ENCENDIDA en Ajustes: montarla es un
  # paso opcional del instalador (crea un swapfile de varios GiB), así que no tenerla no es un
  # fallo. Encenderla y que no funcione SÍ lo es, y de la peor manera: `systemctl hibernate`
  # falla al vencer el temporizador, de madrugada, sin nadie delante y sin dejar más rastro que
  # una línea en el journal. La UI ya se apaga sola si logind dice que no; esto es para el caso
  # en que se apagó DESPUÉS (alguien quitó el swapfile, o un cambio de bootloader se llevó el
  # resume= por delante) y el ajuste quedó encendido creyendo que sigue valiendo.
  archivo_hibernacion="${XDG_CONFIG_HOME:-$HOME/.config}/gigishell/hibernacion.json"
  if [[ -r "$archivo_hibernacion" ]] && command -v jq >/dev/null 2>&1 &&
     jq -e '.enabled == true' "$archivo_hibernacion" >/dev/null 2>&1; then
    if [[ ! -x /usr/local/bin/gigishell-hibernacion ]]; then
      fail "la hibernación está activada pero falta su ayudante (bash install.sh --solo hibernacion)"
    else
      case "$(/usr/local/bin/gigishell-hibernacion estado 2>/dev/null | sed -n 's/^disponible=//p')" in
        si) ok "hibernación disponible (tiempo en Ajustes > Pantalla > Suspensión)" ;;
        *)  fail "la hibernación está activada en Ajustes pero el equipo NO puede hibernar: falta swap persistente o resume= en el kernel (bash install.sh --solo hibernacion, y reiniciá)" ;;
      esac
    fi
    # El otro fallo mudo del par: con la NVIDIA cargada y sin los servicios que conservan la
    # VRAM, hibernar "funciona" y lo que falla es el DESPERTAR — pantalla negra o cuelgue, ya
    # con la sesión restaurada y sin nada que apunte a la GPU.
    if [[ -e /proc/driver/nvidia/version ]] &&
       ! systemctl is-enabled --quiet nvidia-hibernate.service 2>/dev/null; then
      warn "nvidia-hibernate.service no está activado: al volver de la hibernación puede quedar la pantalla negra (bash install.sh --solo hibernacion)"
    fi
  fi

  # SDDM. Lo que se comprueba es el SYMLINK de activación, no que el paquete esté: sin
  # /etc/systemd/system/display-manager.service el arranque se para en un TTY, con todo
  # lo demás perfectamente instalado y sin un solo error que lo explique. Es el fallo más
  # caro de diagnosticar de la lista, porque no deja rastro en ningún log del escritorio.
  if command -v sddm >/dev/null 2>&1 || pacman -Qq sddm >/dev/null 2>&1; then
    gestor_sesion="$(readlink -f /etc/systemd/system/display-manager.service 2>/dev/null || true)"
    if [[ -z "$gestor_sesion" ]]; then
      fail "ningún gestor de sesión activado: el equipo arrancará en un TTY (sudo systemctl enable sddm.service)"
    elif [[ "$(basename "$gestor_sesion")" != sddm.service ]]; then
      warn "el gestor de sesión es $(basename "$gestor_sesion"), no SDDM (bash install.sh --solo sddm si lo querés cambiar)"
    else
      ok "SDDM activado (display-manager.service -> sddm.service)"
    fi
    if [[ -r /etc/sddm.conf.d/zz-gigishell.conf ]]; then
      ok "configuración de SDDM de GiGiShell en /etc/sddm.conf.d/zz-gigishell.conf"
      # Que exista NUESTRO fichero no significa que mande. conf.d se lee en orden
      # alfabético y gana el último: cualquier drop-in que ordene DESPUÉS de zz- y fije
      # una de nuestras claves nos pisa sin dar error. Y /etc/sddm.conf, pese al nombre,
      # gana sobre todo el directorio (`man 5 sddm.conf`).
      for otro in /etc/sddm.conf.d/*; do
        [[ -f "$otro" ]] || continue
        [[ "$(basename "$otro")" > "zz-gigishell.conf" ]] || continue
        if grep -qE '^[[:space:]]*(Current|User|Session|InputMethod)[[:space:]]*=' "$otro"; then
          warn "$otro se lee DESPUÉS de zz-gigishell.conf y fija claves nuestras: manda él (revisalo o borralo)"
        fi
      done
      if [[ -e /etc/sddm.conf.d/99-gigios.conf ]]; then
        warn "queda /etc/sddm.conf.d/99-gigios.conf, de una instalación vieja y con el nombre malo (bash install.sh --solo sddm lo retira)"
      fi
    else
      warn "falta /etc/sddm.conf.d/zz-gigishell.conf: SDDM usará su configuración de fábrica (bash install.sh --solo sddm)"
    fi
    # El tema del saludador. Su ausencia no rompe nada: SDDM cae a su aspecto de fábrica.
    if [[ -r /usr/share/sddm/themes/gigishell/metadata.desktop ]]; then
      ok "tema del saludador instalado en /usr/share/sddm/themes/gigishell"
      # La fuente NO viaja dentro del tema: no hay FontLoader, el .conf pide "Thunderman"
      # por nombre y la resuelve fontconfig. Si falta, Qt sustituye en silencio y el
      # saludador se ve con otra tipografía sin ningún error.
      if command -v fc-match >/dev/null 2>&1 &&
         [[ "$(fc-match -f '%{family}' Thunderman 2>/dev/null)" != *Thunderman* ]]; then
        warn "la fuente Thunderman del saludador no está en el sistema: se verá con otra tipografía (bash install.sh --solo sddm)"
      fi
      # El fondo es un .mp4 y quien lo reproduce es QtMultimedia. Sin el backend de
      # ffmpeg se queda el PNG de reserva: parece que el tema no está animado.
      if ! pacman -Qq qt6-multimedia-ffmpeg >/dev/null 2>&1; then
        warn "falta qt6-multimedia-ffmpeg: el fondo animado del saludador no se reproducirá (se queda el PNG)"
      fi
    else
      warn "falta el tema del saludador en /usr/share/sddm/themes/gigishell (bash install.sh --solo sddm)"
    fi
  else
    fail "SDDM no está instalado: nada lanzará Hyprland al arrancar (sudo pacman -S --needed sddm && bash install.sh --solo sddm)"
  fi

  "$GIGISHELL/bin/link.sh" --check || fail "symlinks incompletos"
fi

if ((errors)); then
  printf '\n%d error(es), %d aviso(s).\n' "$errors" "$warnings" >&2
  exit 1
fi
printf '\nValidación correcta (%d aviso(s)).\n' "$warnings"
