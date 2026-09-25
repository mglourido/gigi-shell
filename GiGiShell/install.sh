#!/usr/bin/env bash
# Instalador de archivos de configuración y GiGiShell para Arch Linux/CachyOS.
# Instala GiGiShell y sus archivos de configuración en Arch Linux o CachyOS, o recupera
# una instalación existente. Respalda los conflictos y crea los enlaces simbólicos.
#
# Uso:
#   curl -sSL https://raw.githubusercontent.com/mglourido/gigi-shell/main/GiGiShell/install.sh | bash
#   bash install.sh --solo-paquetes                   # solo dependencias
#   bash install.sh --sin-paquetes                    # instalación completa sin gestionar paquetes
#   curl -sSL <url> | bash -s -- --sin-paquetes
#   curl -sSL <url> | DOTFILES_BRANCH=<rama> bash      # otra rama del repositorio (no por equipo: para eso están *_PROFILE)
#   curl -sSL <url> | KITTY_PROFILE=desktop bash      # forzar perfil de Kitty
#   curl -sSL <url> | FIREFOX_PROFILE=desktop bash    # forzar perfil de Firefox
#   curl -sSL <url> | SDDM_AUTOLOGIN=0 bash           # SDDM pide contraseña en vez de entrar solo
#
# Opciones: --solo-paquetes y --sin-paquetes. Sin opciones se ejecuta la instalación completa.
#
# Variables:
#   DOTFILES_REPO    URL del repositorio (por defecto, HTTPS público)
#   DOTFILES_BRANCH  rama a instalar (por defecto: main)
#   KITTY_PROFILE    auto, laptop, desktop o conservar
#   FIREFOX_PROFILE  auto, laptop, desktop o conservar
#   INSTALL_HIBERNATION 1 prepara hibernación (por defecto: 0; también se pregunta)
#   TLP_SELECCION   auto, si o no (por defecto: auto)
#   CURSOR_THEME     tema del puntero al que añadir la parte de hyprcursor
#   SDDM_AUTOLOGIN   1 inicia sesión automáticamente en Hyprland (valor predeterminado);
#                    0 muestra la pantalla de inicio. En instalaciones nuevas vale 1;
#                    si ya existe nuestra configuración, conserva Ajustes > Cuenta > Inicio de sesión.
#   ASSUME_YES       1 confirma pacman y omite la revisión de PKGBUILD de paru/yay
#
# PAQUETES: fuerza la sincronización de las bases y actualiza el sistema con `pacman -Syyu`.
#          Después instala las dependencias en una sola operación.
# DESCARGAS: pkgfile y las firmas de ClamAV se descargan en segundo plano.
# REPETICIÓN: puedes volver a ejecutar el instalador; los fallos recuperables se resumen al final.
set -euo pipefail

REPO_URL="${DOTFILES_REPO:-https://github.com/mglourido/gigi-shell.git}"
BRANCH="${DOTFILES_BRANCH:-main}"
DOTGIT="$HOME/.dotfiles"
# GiGiShell vive en $HOME dentro del repositorio bare desplegado allí.
GIGISHELL="$HOME/GiGiShell"
BACKUP_BASE="$HOME/.dotfiles-backup-$(date +%Y%m%d-%H%M%S)"
BACKUP="$BACKUP_BASE"
BACKUP_RESERVADO=0
MODO_INSTALACION=completa
KITTY_PROFILE_EXPLICITO=0; [[ -n "${KITTY_PROFILE:-}" ]] && KITTY_PROFILE_EXPLICITO=1
FIREFOX_PROFILE_EXPLICITO=0; [[ -n "${FIREFOX_PROFILE:-}" ]] && FIREFOX_PROFILE_EXPLICITO=1
KITTY_PROFILE="${KITTY_PROFILE:-auto}"
FIREFOX_PROFILE="${FIREFOX_PROFILE:-auto}"
INSTALL_HIBERNATION="${INSTALL_HIBERNATION:-0}"
TLP_SELECCION="${TLP_SELECCION:-auto}"
# Un tema PEDIDO (CURSOR_THEME= en el entorno) que no esté instalado es un
# error que hay que indicar; el tema predeterminado que no esté es solo un paquete opcional
# ausente, y ahí el paso cae a otro tema en vez de fallar. Sin esta distinción las dos
# situaciones daban el mismo aviso, que era el que confundía. Se mira ANTES de aplicar
# el valor por defecto, que es lo que hace distinguibles los dos casos.
CURSOR_THEME_EXPLICITO=0
[ -n "${CURSOR_THEME:-}" ] && CURSOR_THEME_EXPLICITO=1
CURSOR_THEME="${CURSOR_THEME:-Bibata-Modern-Ice}"
ASSUME_YES="${ASSUME_YES:-0}"
# Se recuerda si la variable venía PUESTA antes de darle valor: sin eso no hay forma
# de distinguir «quiero autologin» de «no dije nada», y el paso `sddm` reescribiría en
# cada reinstalación una decisión que el usuario puede haber cambiado desde
# Ajustes > Cuenta > Inicio de sesión (que escribe la misma clave). Ver el paso `sddm`.
SDDM_AUTOLOGIN_EXPLICITO=0; [ -n "${SDDM_AUTOLOGIN+x}" ] && SDDM_AUTOLOGIN_EXPLICITO=1
SDDM_AUTOLOGIN="${SDDM_AUTOLOGIN:-1}"

dotfiles() { git --git-dir="$DOTGIT" --work-tree="$HOME" "$@"; }
info() { printf '\033[1;36m::\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31mxx\033[0m %s\n' "$*" >&2; exit 1; }

# Reserva la carpeta con mkdir atómico: dos ejecuciones en el mismo segundo no
# compartirán destino ni podrán sobrescribir las copias de seguridad anteriores.
reservar_backup() {
  (( BACKUP_RESERVADO )) && return 0
  local candidato="$BACKUP_BASE" sufijo=0
  while ! mkdir -- "$candidato" 2>/dev/null; do
    [[ -e "$candidato" || -L "$candidato" ]] || die "No pude crear la carpeta de copias de seguridad: $candidato"
    sufijo=$((sufijo + 1))
    candidato="$BACKUP_BASE-$sufijo"
  done
  BACKUP="$candidato"
  BACKUP_RESERVADO=1
}

# Todo aviso queda anotado, no solo impreso. En una instalación larga los avisos se
# pierden entre cientos de líneas de pacman, y el resultado es la peor variante posible:
# una instalación incompleta que parece correcta porque terminó con "completa". El
# resumen final los repite juntos y decide el código de salida.
DEGRADED=()
warn() {
  printf '\033[1;33m!!\033[0m %s\n' "$*"
  DEGRADED+=("$*")
}

case "$#" in
  0) ;;
  1)
    case "$1" in
      --solo-paquetes) MODO_INSTALACION=solo-paquetes ;;
      --sin-paquetes)  MODO_INSTALACION=sin-paquetes ;;
      *) die "Opción desconocida: '$1'. Usa --solo-paquetes o --sin-paquetes." ;;
    esac
    ;;
  *) die "Usa como máximo una opción: --solo-paquetes o --sin-paquetes." ;;
esac

# `curl | bash` no tiene stdin utilizable, así que cualquier orden interactiva (pacman
# preguntando por un proveedor, chsh pidiendo la contraseña) lee del pipe y se come el
# resto del script. Con ASSUME_YES=1 no hace falta terminal: nada pregunta.
INTERACTIVE=0
[[ -r /dev/tty ]] && INTERACTIVE=1

run_interactive() {
  if ((INTERACTIVE)); then
    "$@" </dev/tty
  else
    ((ASSUME_YES)) \
      || die "Necesito una terminal interactiva. Descarga install.sh y ejecútalo con bash, o vuelve a iniciarlo con ASSUME_YES=1."
    "$@" </dev/null
  fi
}

preguntar_si_no() {
  local pregunta="$1" predeterminado="$2" respuesta
  if (( ! INTERACTIVE )); then
    [[ "$predeterminado" == si ]]
    return
  fi
  if [[ "$predeterminado" == si ]]; then
    read -r -p "$pregunta [S/n] " respuesta </dev/tty || respuesta=
    [[ -z "$respuesta" || "$respuesta" =~ ^([sS]|si|SI|Sí|sí)$ ]]
  else
    read -r -p "$pregunta [s/N] " respuesta </dev/tty || respuesta=
    [[ "$respuesta" =~ ^([sS]|si|SI|Sí|sí)$ ]]
  fi
}

perfil_actual() {
  local selector="$1" destino
  [[ -L "$selector" ]] || return 1
  destino="$(readlink -e "$selector" 2>/dev/null)" || return 1
  case "$destino" in
    *laptop*) printf 'laptop\n' ;;
    *desktop*) printf 'desktop\n' ;;
    *) return 1 ;;
  esac
}

elegir_perfil() {
  local aplicacion="$1" actual="$2" respuesta
  if (( ! INTERACTIVE )); then
    [[ -n "$actual" ]] && printf 'conservar\n' || printf 'auto\n'
    return
  fi
  if [[ -n "$actual" ]]; then
    printf 'Perfil actual de %s: %s. Elige [1] conservar, [2] auto, [3] laptop, [4] desktop (Intro conserva): ' "$aplicacion" "$actual" >/dev/tty
  else
    printf 'Elige el perfil de %s: [1] auto, [2] laptop, [3] desktop (Intro usa auto): ' "$aplicacion" >/dev/tty
  fi
  read -r respuesta </dev/tty || respuesta=
  if [[ -n "$actual" ]]; then
    case "$respuesta" in
      ''|1) printf 'conservar\n' ;;
      2) printf 'auto\n' ;;
      3) printf 'laptop\n' ;;
      4) printf 'desktop\n' ;;
      *) die "Opción de perfil no válida para $aplicacion." ;;
    esac
  else
    case "$respuesta" in
      ''|1) printf 'auto\n' ;;
      2) printf 'laptop\n' ;;
      3) printf 'desktop\n' ;;
      *) die "Opción de perfil no válida para $aplicacion." ;;
    esac
  fi
}

# En una reinstalación, conservar por defecto la elección local que ya está activa.
# Una instalación nueva sigue usando `auto`; KITTY_PROFILE/FIREFOX_PROFILE permiten forzarla.
if [[ "$MODO_INSTALACION" != solo-paquetes ]] && (( ! KITTY_PROFILE_EXPLICITO )); then
  perfil_guardado="$(perfil_actual "${KITTY_CONFIG_DIRECTORY:-${XDG_CONFIG_HOME:-$HOME/.config}/kitty}/active-profile.conf" || true)"
  KITTY_PROFILE="$(elegir_perfil Kitty "$perfil_guardado")"
fi
if [[ "$MODO_INSTALACION" != solo-paquetes ]] && (( ! FIREFOX_PROFILE_EXPLICITO )); then
  perfil_guardado="$(perfil_actual "${FIREFOX_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/firefox}/active-profile.js" || true)"
  FIREFOX_PROFILE="$(elegir_perfil Firefox "$perfil_guardado")"
fi

# La hibernación crea un swapfile de varios GiB y modifica el arranque; solo se prepara
# con consentimiento explícito. Si se rechaza en una instalación existente, se conserva
# cualquier preparación previa sin tocarla.
if [[ "$MODO_INSTALACION" != solo-paquetes && "$INSTALL_HIBERNATION" == 0 ]]; then
  if preguntar_si_no "¿Quieres preparar la hibernación? (crea swapfile y modifica GRUB)" no; then
    INSTALL_HIBERNATION=1
  else
    info "Hibernación omitida; no se modifica la configuración que ya pudiera existir."
  fi
fi

case "$ASSUME_YES" in 0|1) ;; *) die "ASSUME_YES debe valer 0 o 1; recibido: '$ASSUME_YES'." ;; esac
case "$SDDM_AUTOLOGIN" in 0|1) ;; *) die "SDDM_AUTOLOGIN debe valer 1 (entrar solo) o 0 (pedir contraseña); recibido: '$SDDM_AUTOLOGIN'." ;; esac
case "$KITTY_PROFILE" in
  auto|laptop|desktop|conservar) ;;
  *) die "KITTY_PROFILE debe ser auto, laptop, desktop o conservar; recibido: '$KITTY_PROFILE'." ;;
esac
case "$FIREFOX_PROFILE" in
  auto|laptop|desktop|conservar) ;;
  *) die "FIREFOX_PROFILE debe ser auto, laptop, desktop o conservar; recibido: '$FIREFOX_PROFILE'." ;;
esac
case "$INSTALL_HIBERNATION" in 0|1) ;; *) die "INSTALL_HIBERNATION debe valer 0 o 1." ;; esac
case "$TLP_SELECCION" in auto|si|no) ;; *) die "TLP_SELECCION debe ser auto, si o no." ;; esac
(( EUID != 0 )) || die "No ejecutes este instalador como root; usa tu usuario normal (sudo se pedirá cuando haga falta)."

# Una batería del sistema es lo que distingue un portátil, igual que en
# bin/kitty-profile.sh: los periféricos (ratones, mandos) también publican type=Battery,
# pero con scope=Device. Aquí decide si se instala TLP.
tiene_bateria() {
  local type_file type supply scope
  for type_file in /sys/class/power_supply/*/type; do
    [[ -r "$type_file" ]] || continue
    IFS= read -r type < "$type_file" || continue
    [[ "$type" == Battery ]] || continue
    supply="${type_file%/type}"
    if [[ -r "$supply/scope" ]]; then
      IFS= read -r scope < "$supply/scope" || continue
      [[ "$scope" == Device ]] && continue
    fi
    return 0
  done
  return 1
}

# En portátiles se mantiene TLP salvo que ya haya otro gestor activo. En ese caso se
# pregunta antes de detenerlo; sin terminal, el valor seguro es conservar el gestor actual.
TLP_HABILITADO=0
gestor_energia_activo=0
if tiene_bateria; then
    for unidad_energia in power-profiles-daemon.service tuned.service auto-cpufreq.service; do
      if systemctl is-enabled --quiet "$unidad_energia" 2>/dev/null || systemctl is-active --quiet "$unidad_energia" 2>/dev/null; then
        gestor_energia_activo=1
        break
      fi
    done
    case "$TLP_SELECCION" in
      si) TLP_HABILITADO=1 ;;
      no) TLP_HABILITADO=0 ;;
      auto)
        if (( gestor_energia_activo )); then
          if preguntar_si_no "Hay otro gestor de energía activo. ¿Quieres sustituirlo por TLP?" no; then TLP_HABILITADO=1; fi
        elif [[ "$MODO_INSTALACION" != sin-paquetes ]] || systemctl is-enabled --quiet tlp.service 2>/dev/null; then
          TLP_HABILITADO=1
        fi
        ;;
    esac
fi

# Perfil de GPU de esta máquina, deducido del hardware. Vive aquí arriba y no dentro
# del paso `gpu` porque lo necesitan DOS pasos: `paquetes` (para saber si hay que
# instalar el driver VA-API de NVIDIA) y `gpu` (para escribir el perfil). Tenerlo dos
# veces era garantía de que un día dejaran de coincidir.
#
# Se lee /sys y no `lspci`: este modo puede correr con --sin-paquetes, donde pciutils
# no está garantizado, y un `command -v lspci` fallido dejaría el perfil sin elegir sin
# que se note. Clases PCI 0x03xxxx = VGA / 3D controller / Display controller.
detectar_perfil_gpu() {
  local dispositivo clase vendor nvidia=0 integrada=0 encontrada=0
  for dispositivo in /sys/bus/pci/devices/*; do
    [[ -r "$dispositivo/class" && -r "$dispositivo/vendor" ]] || continue
    IFS= read -r clase < "$dispositivo/class" || continue
    [[ "$clase" == 0x03* ]] || continue
    IFS= read -r vendor < "$dispositivo/vendor" || continue
    encontrada=1
    case "$vendor" in
      0x10de) nvidia=1 ;;
      0x8086|0x1002|0x1022) integrada=1 ;;
    esac
  done
  ((encontrada)) || return 1
  if ((nvidia)); then
    # Híbrida solo en portátil: en un sobremesa con iGPU y NVIDIA la pantalla cuelga
    # casi siempre de la NVIDIA, que es lo que asume sobremesa-nvidia.
    if ((integrada)) && tiene_bateria; then printf 'laptop-hibrida'
    else printf 'sobremesa-nvidia'; fi
  elif ((integrada)); then
    printf 'integrada'
  else
    return 1
  fi
}

# Un sudo que caduca a mitad de una instalación de veinte minutos abre un prompt de
# contraseña en medio del scroll de pacman, y con `curl | bash` ni siquiera puede leerse.
# Se pide una vez al principio y se renueva en segundo plano mientras dura el instalador.
SUDO_KEEPALIVE_PID=""
sudo_prime() {
  command -v sudo >/dev/null || return 0
  if ! sudo -n true 2>/dev/null; then
    info "Se necesitan permisos de administrador para instalar paquetes y archivos en /etc."
    run_interactive sudo -v || die "No se pudieron obtener permisos de sudo."
  fi
  [[ -n "$SUDO_KEEPALIVE_PID" ]] && return 0
  while true; do sudo -n true 2>/dev/null || break; sleep 50; done &
  SUDO_KEEPALIVE_PID=$!
}
limpiar_keepalive() {
  [[ -n "$SUDO_KEEPALIVE_PID" ]] && { kill "$SUDO_KEEPALIVE_PID" 2>/dev/null || true; }
  return 0
}
trap limpiar_keepalive EXIT

# Descargas largas que NO bloquean a nadie: se lanzan en segundo plano en cuanto es
# posible y se recogen al final, justo antes de validar.
#
# Las dos son puro tráfico de red y ningún paso intermedio depende de ellas:
#   - pkgfile      lista de archivos de los repositorios; solo la usa `command-not-found`.
#   - firmas ClamAV ~200 MB; solo las usa el escáner de descargas, ya en sesión.
# Antes se hacían en serie en mitad del instalador y su tiempo se SUMABA al de todo lo
# demás. Ahora se solapan con la instalación de paquetes, el checkout, los symlinks, los
# perfiles, el CSS y las bases MIME.
PKGFILE_PID=""
CLAMAV_PID=""
esperar_descargas_de_fondo() {
  if [[ -n "$PKGFILE_PID" ]]; then
    wait "$PKGFILE_PID" \
      || warn "No pude actualizar pkgfile; command-not-found funcionará tras ejecutar 'sudo pkgfile --update'."
    PKGFILE_PID=""
  fi
  if [[ -n "$CLAMAV_PID" ]]; then
    info "Esperando a que terminen de bajar las firmas de ClamAV ..."
    if wait "$CLAMAV_PID"; then
      CLAMAV_ESTADO="descargada"
    else
      CLAMAV_ESTADO="fallida"
      warn "No se pudieron descargar las firmas de ClamAV; el escáner no podrá analizar archivos hasta que se actualicen."
    fi
    CLAMAV_PID=""
  fi
}

# Resumen de todo lo que quedó a medias. Sin esto, los avisos se pierden entre el scroll
# de pacman y una instalación degradada es indistinguible de una correcta: termina igual,
# con "Instalación base completa". Aquí se repiten juntos y al final del todo, que es lo
# único que se lee de verdad. Lo llaman los dos finales posibles: el completo y el de
# --solo-paquetes.
resumen_degradado() {
  if ((${#PAQUETES_FALLIDOS[@]})); then
    echo
    printf '\033[1;33mPaquetes que no se pudieron instalar (%d):\033[0m\n' "${#PAQUETES_FALLIDOS[@]}"
    printf '  - %s\n' "${PAQUETES_FALLIDOS[@]}"
    printf '  Reintento: sudo pacman -S --needed %s\n' "${PAQUETES_FALLIDOS[*]}"
  fi
  if ((${#DEGRADED[@]})); then
    echo
    printf '\033[1;33mAvisos (%d) — la instalación terminó, pero esto quedó sin hacer:\033[0m\n' "${#DEGRADED[@]}"
    printf '  !! %s\n' "${DEGRADED[@]}"
  fi
}

# Instala una regla sudoers a partir de su plantilla versionada.
#
# VIVE AQUÍ, EN EL NIVEL SUPERIOR, y no dentro del bloque del paso `mime` como estaba:
# quien la llama es el paso `sistema` (TLP, ClamAV, limpieza), así que omitir MIME no debe
# impedir que la función esté definida y pueda usarse.
# La primera llamada salía con 127 «orden no encontrada», que con `set -e` ABORTA el
# instalador entero. Una función no es un paso; no puede colgar de que un paso corra. Tres bloques hacían
# esto mismo copiado y pegado (TLP, ClamAV, limpieza), cada uno con su `mktemp` sin
# comprobar: si /tmp estaba lleno o era de solo lectura, `mktemp` fallaba, `sed` escribía
# en una ruta vacía y `visudo -cf ""` validaba cualquier cosa. Aquí se comprueba una vez.
#
# El orden importa y es el mismo de antes: se materializa el usuario real en un temporal,
# se VALIDA con visudo y solo entonces se instala. Una regla sudoers malformada en
# /etc/sudoers.d rompe sudo en toda la máquina, así que nunca se escribe sin validar.
instalar_sudoers() {
  local plantilla="$1" destino="$2" aviso="$3" tmp
  [[ -r "$plantilla" ]] || { warn "Falta la plantilla sudoers $plantilla; $aviso"; return 1; }
    tmp="$(mktemp)" || { warn "No pude crear un archivo temporal para $destino; $aviso"; return 1; }
  if ! sed "s/__GIGISHELL_USER__/$(id -un)/" "$plantilla" > "$tmp"; then
    rm -f "$tmp"
    warn "No pude preparar la regla sudoers $destino; $aviso"
    return 1
  fi
  if sudo visudo -cf "$tmp" >/dev/null; then
    sudo install -Dm440 "$tmp" "$destino" \
      || warn "No pude instalar $destino; $aviso"
  else
    warn "La regla sudoers de $destino no validó; no la instalo. $aviso"
  fi
  rm -f "$tmp"
}

# Instala paquetes SIN que uno malo se lleve por delante al resto.
#
# Antes era un único `pacman -S --needed "${official[@]}"` con `set -e` detrás: si un
# solo nombre de la lista había desaparecido de los repos, cambiado de nombre o tenía un
# conflicto, pacman salía != 0, el instalador moría ahí mismo y no llegaba a hacer NI LOS
# SYMLINKS. Un paquete renombrado río arriba dejaba el escritorio sin instalar.
#
# Ahora: (1) se descartan los nombres que los repos configurados no ofrecen — eso solo es
# un aviso, no un fallo; (2) se intenta la instalación en lote, que es lo rápido y lo que
# resuelve bien las dependencias; (3) si el lote falla, se reintenta paquete a paquete
# para aislar al culpable, y se sigue con todos los demás. Lo que no entre se anota y sale
# en el resumen final.
# El ayudante de AUR, detectado UNA vez. Si existe, es también quien instala los
# paquetes de repo: `paru`/`yay` resuelven repos y AUR en la MISMA transacción, así que
# no hay que decidir por adelantado de dónde sale cada nombre ni encadenar dos
# instalaciones con dos confirmaciones.
AYUDANTE_AUR=""
if command -v paru >/dev/null 2>&1; then AYUDANTE_AUR=paru
elif command -v yay >/dev/null 2>&1; then AYUDANTE_AUR=yay
fi

PAQUETES_FALLIDOS=()

# UNA transacción para todo: repos oficiales + AUR.
#
# Antes eran dos pasadas: `sudo pacman -S` con la lista oficial y, después,
# `paru/yay -S aylurs-gtk-shell-git libastal-meta` aparte. Eso costaba dos
# confirmaciones, dos resoluciones de dependencias y —lo caro de verdad— una
# COMPILACIÓN desde AUR de `libastal-meta` (una quincena de bibliotecas Vala/C) que en
# muchas máquinas NO HACÍA FALTA: con `chaotic-aur` configurado, `aylurs-gtk-shell-git`
# y `libastal-meta` existen ya como BINARIO. Al mezclarlo todo en una lista, el ayudante
# coge la versión de repositorio cuando la hay y solo compila lo que de verdad es exclusivo de AUR.
#
# Sin ayudante instalado se cae a `sudo pacman` con lo que haya en los repos y se avisa
# de lo que quede fuera: es exactamente el comportamiento anterior, no una regresión.
paquetes_instalar() {
  local -a deseados=("$@") disponibles=() ausentes=() fallidos=()
  local paquete
  local -a gestor flags=(-S --needed)
  if [[ -n "$AYUDANTE_AUR" ]]; then
    gestor=("$AYUDANTE_AUR")
    # Sin esto, un paquete AUR abre tres preguntas por PKGBUILD (ver diff, editar,
    # limpiar) que en `curl | bash` no puede contestar nadie. Solo con ASSUME_YES=1: por
    # defecto se respeta que el usuario quiera revisar lo que se compila.
    if ((ASSUME_YES)); then
      flags+=(--noconfirm)
      case "$AYUDANTE_AUR" in
        paru) flags+=(--skipreview) ;;
        yay)  flags+=(--answerdiff=None --answeredit=None --answerclean=None --removemake) ;;
      esac
    fi
  else
    gestor=(sudo pacman)
    ((ASSUME_YES)) && flags+=(--noconfirm)
  fi

  # DOS llamadas a pacman, no dos por paquete. Con ~150 paquetes el bucle de
  # `pacman -Si` + `pacman -Qq` uno a uno tardaba más de medio minuto SIN IMPRIMIR NADA
  # entre el "Comprobando la disponibilidad ..." y la primera línea de pacman: parecía
  # colgado y invitaba a un Ctrl+C en mitad del instalador. En lote son décimas.
  #
  # LC_ALL=C es obligatorio: el campo se llama "Name" en inglés y "Nombre" en español, y
  # el parseo depende de él. Sin fijar el locale, en una máquina en español TODOS los
  # paquetes salían como ausentes.
  #
  # `pacman -Si` con un nombre inexistente en la lista NO aborta: informa de los que
  # encuentra y manda el resto a stderr (que se descarta), así que un nombre renombrado
  # río arriba sigue detectándose como ausente en vez de tumbar la comprobación entera.
  info "Comprobando la disponibilidad de ${#deseados[@]} paquetes ..."
  local -A conocidos=()
  while IFS= read -r paquete; do
    [[ -n "$paquete" ]] && conocidos["$paquete"]=1
  done < <(
    { LC_ALL=C pacman -Si "${deseados[@]}" 2>/dev/null | awk -F': +' '/^Name +:/ { print $2 }'
      LC_ALL=C pacman -Qq "${deseados[@]}" 2>/dev/null; } | sort -u
  )
  for paquete in "${deseados[@]}"; do
    if [[ -n "${conocidos[$paquete]:-}" ]]; then
      disponibles+=("$paquete")
    else
      ausentes+=("$paquete")
    fi
  done
  # Lo que no está en ningún repo NO es necesariamente un error: puede ser AUR-only. Con
  # ayudante se le pasa igual y que lo resuelva él; sin ayudante sí es lo que falta.
  if ((${#ausentes[@]})); then
    if [[ -n "$AYUDANTE_AUR" ]]; then
      info "No se encontraron en los repositorios configurados; los buscaré en AUR con $AYUDANTE_AUR: ${ausentes[*]}"
      disponibles+=("${ausentes[@]}")
    else
      warn "No se encontraron en los repositorios configurados: ${ausentes[*]}. Comprueba los nombres o instala paru/yay si son paquetes de AUR."
    fi
  fi
  ((${#disponibles[@]})) || { warn "No hay paquetes instalables; omito esta operación."; return 0; }

  if run_interactive "${gestor[@]}" "${flags[@]}" "${disponibles[@]}"; then
    return 0
  fi

  warn "Falló la instalación conjunta; reintento paquete a paquete para localizar el problema."
  for paquete in "${disponibles[@]}"; do
    pacman -Qq "$paquete" >/dev/null 2>&1 && continue
    run_interactive "${gestor[@]}" "${flags[@]}" "$paquete" >/dev/null 2>&1 \
      || fallidos+=("$paquete")
  done
  if ((${#fallidos[@]})); then
    PAQUETES_FALLIDOS+=("${fallidos[@]}")
    warn "No se pudieron instalar: ${fallidos[*]}"
    warn "Reintenta luego con: ${gestor[*]} -S --needed ${fallidos[*]}"
  fi
  return 0
}

# La base de pacman puede estar bloqueada por una actualización en otra terminal o por el
# monitor de actualizaciones del propio escritorio. Sin esto el fallo salía como un error
# de pacman a media instalación; comprobarlo antes permite decir qué pasa y no empezar.
comprobar_pacman_libre() {
  [[ -e /var/lib/pacman/db.lck ]] || return 0
  # Se mira /proc a pelo, sin fuser (psmisc) ni pgrep (procps-ng): esta comprobación corre
  # ANTES de instalar nada, así que no puede depender de un paquete que quizá falte —
  # sería un fallo de la comprobación disfrazado de "no hay pacman corriendo".
  local comm_file pid comando
  for comm_file in /proc/[0-9]*/comm; do
    [[ -r "$comm_file" ]] || continue
    IFS= read -r comando < "$comm_file" 2>/dev/null || continue
    case "$comando" in
      pacman|pacman-key|paru|yay|checkupdates|pamac*)
        pid="${comm_file#/proc/}"; pid="${pid%/comm}"
        die "Hay otro gestor de paquetes en marcha ($comando, PID $pid). Espera a que termine y vuelve a ejecutar el instalador."
        ;;
    esac
  done
  warn "Existe /var/lib/pacman/db.lck pero ningún gestor de paquetes lo usa (¿una actualización interrumpida?)."
  die "Elimina el archivo con 'sudo rm /var/lib/pacman/db.lck' y vuelve a ejecutar el instalador."
}

install_packages() {
  local official=(
    git curl python xdg-utils shared-mime-info base-devel util-linux polkit
    less man-db tar hwinfo openbsd-netcat neovim
    # Estas cuatro llegaban SIEMPRE como dependencia transitiva de otra cosa, así que
    # nunca se notó que no estaban declaradas. Se declaran porque su ausencia no da
    # error, da un escritorio a medias:
    #   procps-ng  pgrep/pkill — los usan 21 ficheros; sin ellos ningún *-monitor.sh se
    #              relanza ni se detiene, y `hyprctl reload full-reset` deja duplicados.
    #   glib2      gsettings (el tema oscuro y los iconos de las apps GTK, autostart.lua)
    #              y `gio trash`, que es como manda a la papelera Ajustes > Almacenamiento.
    #   fontconfig fc-match, que es con lo que preflight.sh comprueba las fuentes.
    #   gawk       awk con extensiones GNU en los scripts de análisis.
    procps-ng glib2 fontconfig gawk
    # expac: el inventario de paquetes de Ajustes > Almacenamiento (nombre, tamaño en bytes,
    # razón de instalación, fecha y descripción de una pasada). `pacman -Qi` hace lo mismo en
    # ~285 ms contra los ~18 ms de expac; el analizador cae a `pacman -Qi` si falta, así que su
    # ausencia solo se nota en el reloj.
    expac
    # pacman-contrib: da `checkupdates` a updates-monitor.sh (sincroniza su propia BD
    # temporal en vez de leer la del sistema). Sin él el monitor sigue funcionando
    # cayendo a `pacman -Qu`, pero eso exige una BD ya sincronizada por el usuario.
    # Da además `paccache`, que es quien limpia la caché de paquetes desde Ajustes >
    # Liberar espacio y quien simula (`-d`) cuánto liberaría antes de tocar nada.
    pacman-contrib
    # Mantén esta pila en paquetes estables. qt6ct + Breeze proporcionan el
    # tema Qt; hyprqt6engine-git no es necesario y fuerza bibliotecas -git.
    hyprland hyprlock hypridle hyprpolkitagent hyprsunset uwsm
    # sddm: el gestor de sesión. No estaba declarado y nadie lo echaba en falta porque
    # CachyOS lo trae de serie en su ISO — pero una instalación desde un Arch pelado
    # terminaba "completa" y arrancaba en un TTY, sin nada que lanzara Hyprland. El paso
    # `sddm` lo configura y lo activa; aquí solo se garantiza que el paquete exista.
    sddm
    # Los tres Qt que necesita el TEMA del saludador (system/sddm/tema/, ver su README):
    #   qt6-svg               los iconos de Assets/ son SVG; sin él los botones de
    #                         apagar/reiniciar/usuario salen en blanco.
    #   qt6-multimedia-ffmpeg el fondo es un .mp4; sin el backend de ffmpeg el vídeo no
    #                         arranca y se queda el PNG de reserva. No da ningún error:
    #                         parece que el tema simplemente no está animado.
    #   qt6-virtualkeyboard   el teclado en pantalla. Es el peligroso de los tres: el paso
    #                         `sddm` solo escribe InputMethod=qtvirtualkeyboard si encuentra
    #                         su módulo QML, porque fijarlo sin el paquete deja el greeter
    #                         sin arrancar (pantalla negra al encender, sin mensaje).
    qt6-svg qt6-multimedia-ffmpeg qt6-virtualkeyboard
    # hyprcursor: Hyprland ya depende de la librería, pero el paso 10 usa el
    # BINARIO hyprcursor-util (mismo paquete) para generar la mitad hyprcursor
    # del tema de puntero. Se pide explícito para que sea una dependencia
    # declarada del instalador y no un efecto colateral de otro paquete.
    #
    # xcur2png NO es adorno: `hyprcursor-util --extract` no lee los XCursor él mismo,
    # se los pasa a ese binario (comprueba `xcur2png --help` y aborta con "missing
    # dependency: -x requires xcur2png"). El paquete hyprcursor NO lo arrastra —en Arch
    # ni siquiera figura como optdepend— así que en una máquina recién instalada el paso
    # 10 fallaba SIEMPRE, y el aviso que salía ("no pude generar el tema hyprcursor
    # 'Bibata-Modern-Ice' … elige otro con --list") mandaba a cambiar de tema cuando
    # ningún tema iba a funcionar. Aquí la única cura es declararlo.
    hyprcursor xcur2png
    # xorg-xwayland: hypr/gigishell/reglas.lua tiene reglas específicas para ventanas
    # XWayland (el arreglo de arrastres) y monitores.lua configura su escalado. Hyprland
    # solo lo recomienda, no lo requiere: sin él las apps X11 (Steam, juegos, instaladores)
    # no abren y el fallo aparece como "la app no arranca", no como una dependencia ausente.
    xorg-xwayland
    xdg-desktop-portal-hyprland xdg-desktop-portal-gtk qt6-wayland qt6ct
    gjs gtk4-layer-shell gobject-introspection dart-sass
    # noto-fonts (además del -emoji): qt6ct/qt6ct.conf fija "Noto Sans" y "Noto Sans Mono"
    # como fuentes general y monoespaciada de TODAS las apps Qt, y preflight.sh lo exige.
    # Solo estaba noto-fonts-emoji, que no trae ninguna de las dos: sin esto Qt cae a la
    # fuente sustituta que le toque y las ventanas salen con otra tipografía y otra métrica.
    ttf-meslo-nerd ttf-cascadia-code-nerd noto-fonts noto-fonts-emoji
    rofi rofimoji wtype cliphist wl-clipboard imagemagick brightnessctl ddcutil playerctl
    qalculate-gtk wf-recorder grim slurp jq hyprshot btop
    # Dependencias directas de las funciones de cámara: v4l-utils da controles y
    # formatos V4L2, psmisc aporta fuser para detectar procesos que usan el dispositivo,
    # y mpv abre la vista previa. Haruna ya traía mpv indirectamente, pero el shell lo
    # ejecuta directamente y debe declararlo por sí mismo.
    v4l-utils psmisc mpv
    # libcanberra: reproduce el `sound-name` de las notificaciones (alarmas y temporizador del
    # panel de reloj). Sin él la alerta se ve pero no suena, sin error visible.
    libcanberra
    # sound-theme-freedesktop: los ficheros que libcanberra resuelve por NOMBRE
    # (`alarm-clock-elapsed`, `complete`). Llegaba siempre como dependencia transitiva y por
    # eso nunca se notó que no estaba declarado, pero su ausencia es el fallo mudo perfecto:
    # canberra-gtk-play no encuentra la entrada, no imprime nada, y la alarma simplemente NO
    # SUENA. Un `sound-name` se resuelve primero contra ~/GiGiShell/audio (ver audio/README.md) y
    # solo se delega en el tema cuando allí falta, así que el agujero depende de qué sonidos
    # tenga el usuario en esa carpeta.
    #
    # Se declara ahora porque la SUSPENSIÓN FALSA depende de ello: sus ajustes por defecto
    # prometen que las alarmas siguen sonando con el equipo "dormido"
    # (docs/suspension-falsa.md, «Alarmas, temporizador y No molestar»), y un despertador que
    # no suena porque falta un paquete que nadie declaró es el peor fallo de esa función.
    sound-theme-freedesktop
    # cava: la FFT de la onda de Spotify de la barra. Sin él la onda no falla, cae a su
    # animación procedimental — así que es una mejora, no un requisito.
    cava
    nm-connection-editor blueman fish
    # kconfig: da kreadconfig6/kwriteconfig6, que usa bin/configurar-dolphin.sh (paso 4
    # de este instalador) y bin/preflight.sh ya exige explícitamente.
    kitty firefox dolphin kservice kconfig breeze ffmpegthumbs kdegraphics-thumbnailers
    ark 7zip unrar elisa filelight gwenview haruna kate kfind kolourpaint
    libreoffice-fresh libreoffice-fresh-es okular partitionmanager simple-scan
    tela-circle-icon-theme-grey
    zsh oh-my-zsh-git zsh-completions zsh-autosuggestions
    zsh-syntax-highlighting zsh-history-substring-search zsh-theme-powerlevel10k
    fzf eza bat duf pkgfile fastfetch
    libpulse pipewire pipewire-audio pipewire-pulse pipewire-alsa wireplumber
    gst-plugin-pipewire libnotify awww upower libgudev
    smartmontools lm_sensors pciutils usbutils udisks2 lsof ntfsprogs dosfstools exfatprogs
    alsa-utils inotify-tools dbus kmod
    networkmanager bluez bluez-utils xdg-user-dirs
    clamav firejail bubblewrap xxhash file oxipng cups geoclue gamemode
    mesa-utils lshw github-cli
  )

  command -v pacman >/dev/null || die "La instalación automática de paquetes solo admite Arch/CachyOS. Usa --sin-paquetes y sigue las instrucciones de docs/SETUP.md."
  command -v sudo >/dev/null || die "Falta sudo. Instálalo y concede permisos al usuario antes de continuar."
  comprobar_pacman_libre
  sudo_prime

  # Mantener sincronizadas las bases y los paquetes antes de instalar dependencias.
  # Arch es una distribución rolling release y una instalación parcial (-Sy o -S sin
  # -u) puede dejar una mezcla de versiones incompatible. ASSUME_YES también confirma esta
  # actualización; en el modo normal pacman conserva su confirmación interactiva.
  local -a flags_actualizacion=(-Syyu)
  ((ASSUME_YES)) && flags_actualizacion+=(--noconfirm)
  info "Actualizando el sistema (sudo pacman ${flags_actualizacion[*]}) ..."
  run_interactive sudo pacman "${flags_actualizacion[@]}" \
    || die "No se pudo actualizar el sistema con pacman -Syyu; se detiene la instalación de dependencias."

  # Pacman acepta paquetes -git como proveedores de hyprutils/hyprlang. Si ya
  # están presentes, instalar Hyprland estable puede abrir un diálogo de
  # conflictos o, peor, conservar una mezcla con ABI incompatible. No se
  # desinstalan solos porque una máquina puede usar hyprland-git a propósito.
  local paquete
  local -a pila_hyprland_incompatible=()
  for paquete in hyprland-git hyprqt6engine-git hyprutils-git hyprlang-git; do
    pacman -Qq "$paquete" >/dev/null 2>&1 && pila_hyprland_incompatible+=("$paquete")
  done
  if (( ${#pila_hyprland_incompatible[@]} )); then
    warn "Hay paquetes incompatibles con la pila estable que instala GiGiShell:"
    printf '  - %s\n' "${pila_hyprland_incompatible[@]}" >&2
      die "No se modificará esa pila automáticamente. Sigue los pasos de recuperación de docs/SETUP.md y vuelve a ejecutar el instalador."
  fi

  # CachyOS ofrece su perfil Pure de Fish y el actualizador de mirrors. En Arch
  # puro esos paquetes no existen, así que solo se agregan cuando el repositorio
  # configurado los proporciona. VS Code se instala solo si ningún paquete ya
  # aporta el comando `code` (por ejemplo visual-studio-code-bin).
  local optional_official
  for optional_official in cachyos-fish-config cachyos-rate-mirrors; do
    pacman -Si "$optional_official" >/dev/null 2>&1 && official+=("$optional_official")
  done

  # bibata-cursor-theme no está en los repos oficiales (vive en chaotic-aur y en AUR), y
  # va aparte porque en un Arch puro SIN ayudante haría fallar el `pacman -S` ENTERO y
  # con él el resto de dependencias. Pero el gate era `pacman -Si` a secas, que NO VE AUR:
  # en una máquina con paru/yay y sin chaotic-aur el paquete se descartaba pudiendo
  # instalarse, Bibata no llegaba nunca, y el paso 10 moría con "no pude generar el tema
  # hyprcursor 'Bibata-Modern-Ice'" — un aviso que culpaba al tema cuando lo que faltaba
  # era el paquete. Con ayudante se añade y que lo resuelva él (paquetes_instalar ya
  # trata los AUR-only sin abortar); sin ayudante se mantiene el gate de siempre.
  if [[ -n "$AYUDANTE_AUR" ]] || pacman -Si bibata-cursor-theme >/dev/null 2>&1; then
    official+=(bibata-cursor-theme)
  else
    info "bibata-cursor-theme no está en los repositorios y falta paru/yay; usaré otro tema instalado."
  fi
  command -v code >/dev/null 2>&1 || official+=(code)

  # TLP solo en portátiles. El paso 9 instala sus perfiles conmutables ÚNICAMENTE si
  # `tlp` ya existe, y nadie lo instalaba nunca: Ajustes > Energía se quedaba sin el
  # selector Normal/Ahorro en una máquina recién instalada, sin decir por qué. En un
  # sobremesa no se instala a propósito — TLP ahí no aporta y compite con
  # power-profiles-daemon si el usuario lo tiene.
  if (( TLP_HABILITADO )); then
    official+=(tlp tlp-rdw)
  else
    tiene_bateria || info "No se detectó batería; TLP solo se instala en portátiles."
    (( gestor_energia_activo )) && info "Se conserva el gestor de energía activo; no se instalará TLP."
  fi

  # Controlador VA-API de NVIDIA, solo si hay una NVIDIA. Los perfiles que el paso `gpu`
  # elige para esas máquinas (sobremesa-nvidia) exporta LIBVA_DRIVER_NAME=nvidia y
  # NVD_BACKEND=direct, y sin este paquete esa
  # variable apunta a un driver que NO EXISTE: la aceleración de vídeo por hardware no
  # se degrada, deja de funcionar, y no lo dice nadie. El propio perfil ya avisaba
  # ("Requiere el paquete 'libva-nvidia-driver'") pero el instalador no lo instalaba,
  # así que la promesa dependía de que el usuario leyera un comentario en un .lua.
  #
  # El resto de la pila NVIDIA (nvidia-utils y el módulo del kernel) NO se toca a
  # propósito: el módulo va atado al kernel de cada máquina (aquí, por ejemplo,
  # linux-cachyos-nvidia-open) y elegirlo mal deja el equipo sin arrancar a la sesión
  # gráfica. Este paquete, en cambio, no depende del kernel.
  # Se mira el perfil YA ELEGIDO antes que la detección, por la misma razón por la que
  # el paso `gpu` nunca pisa un fichero existente: la elección del usuario manda.
  # laptop-hibrida NO entra aunque lleve una NVIDIA: ese perfil deja el vídeo en la
  # Intel a propósito y no toca LIBVA_DRIVER_NAME.
  perfil_gpu_efectivo=""
  if [[ -s "$HOME/.config/gigishell/gpu-perfil" ]]; then
    perfil_gpu_efectivo="$(tr -d '[:space:]' < "$HOME/.config/gigishell/gpu-perfil")"
  else
    perfil_gpu_efectivo="$(detectar_perfil_gpu 2>/dev/null || true)"
  fi
  case "$perfil_gpu_efectivo" in
    sobremesa-nvidia) official+=(libva-nvidia-driver) ;;
  esac

  # AGS y las bibliotecas Astal entran EN LA MISMA LISTA, no en una pasada aparte.
  # Son dependencias del escritorio como cualquier otra; que su origen habitual sea AUR
  # es un detalle del proveedor, no una fase distinta de la instalación. Metidas aquí:
  #   - una sola confirmación y una sola resolución de dependencias,
  #   - si un repo configurado las ofrece como binario (chaotic-aur las tiene), se
  #     instalan como binario y NO se compila `libastal-meta`, que era lo que convertía
  #     una instalación nueva en una espera de varios minutos.
  # El `--needed` hace que en una reejecución no se toquen: ya no hace falta el sondeo de
  # `command -v ags` + los ocho typelibs que había aquí para decidir si valía la pena.
  official+=(aylurs-gtk-shell-git libastal-meta)

  # pkgfile en SEGUNDO PLANO: descarga la lista de ficheros de los 7 repos (decenas de
  # MB) y no la necesita ningún paso posterior — solo el `command-not-found` del shell,
  # que se usa después de instalar. Se espera al final (`esperar_descargas_de_fondo`),
  # justo antes de validar. Es tiempo que antes se sumaba y ahora se solapa.
  if command -v pkgfile >/dev/null 2>&1; then
    info "Actualizando el índice de pkgfile en segundo plano ..."
    sudo -n pkgfile --update >/dev/null 2>&1 &
    PKGFILE_PID=$!
  fi

  info "Instalando ${#official[@]} paquetes en una operación${AYUDANTE_AUR:+ con $AYUDANTE_AUR} ..."
  paquetes_instalar "${official[@]}"

  if [[ -z "$AYUDANTE_AUR" ]] && ! command -v ags >/dev/null 2>&1; then
    warn "No se pudo instalar AGS/Astal porque falta paru o yay. Instala uno y repite bash ~/GiGiShell/install.sh --solo-paquetes; el resto continúa."
  fi

  # Uno por uno y no en una sola orden: `systemctl enable --now a b` falla ENTERO si una
  # de las dos unidades no existe (bluez no instalado, por ejemplo), y entonces la red
  # tampoco quedaba activada aunque NetworkManager sí estuviera.
  local -a unidades=(NetworkManager.service bluetooth.service)
  # TLP solo donde se instaló (portátil, ver más arriba). Sin habilitar su unidad, el
  # perfil de /etc/tlp.conf NO se aplica al arrancar ni al cambiar de AC a batería: el
  # selector de Ajustes > Energía seguía funcionando —el helper hace `tlp start`, que
  # actúa en caliente— pero cada reinicio empezaba sin TLP hasta que alguien lo movía
  # a mano o entraba en modo ahorro. `tlp-rdw` no tiene unidad propia que activar (va
  # por dispatcher de NetworkManager).
  if (( TLP_HABILITADO )); then
    unidades+=(tlp.service)
    # TLP y los demás gestores de energía se pelean por los mismos ajustes del kernel
    # (governor, EPP, ASPM) y el resultado depende de quién escriba el último: el portátil
    # acaba con una mezcla que no es ninguno de los dos perfiles. Es un requisito de TLP,
    # no una preferencia nuestra. CachyOS trae power-profiles-daemon activo en varias de
    # sus ediciones, así que en una máquina recién instalada esto pasa por defecto.
    # Se DESACTIVAN, no se enmascaran: revertirlo es un `systemctl enable --now`.
    #
    # La lista es la MISMA que comprueba el propio TLP, y por eso no basta con ppd: si
    # cualquiera de estas sigue viva, `tlp init start` ABORTA con "conflicting power
    # management service is active" y el arranque en caliente de tlp.service falla —
    # justo lo que dejaba la instalación avisando de que no pudo activar TLP. `tuned` entra
    # con nombre propio porque `tuned-ppd` *provee* power-profiles-daemon: mirar solo el
    # nombre de ppd no la ve.
    local conflicto
    for conflicto in power-profiles-daemon.service tuned.service auto-cpufreq.service; do
      systemctl is-enabled --quiet "$conflicto" 2>/dev/null ||
        systemctl is-active --quiet "$conflicto" 2>/dev/null || continue
      info "Desactivando $conflicto: entra en conflicto con TLP (lo usa Ajustes > Energía)."
      sudo systemctl disable --now "$conflicto" \
        || warn "No se pudo desactivar $conflicto; entrará en conflicto con TLP. Desactívalo con: sudo systemctl disable --now $conflicto"
    done
  fi
  info "Activando los servicios que usa el panel de red, Bluetooth y la energía ..."
  # `enable` y `start` SEPARADOS, y en ese orden. `systemctl enable --now` es UN solo
  # comando con dos efectos de vidas distintas —dejar la unidad activada para los
  # próximos arranques, y arrancarla ahora— y basta con que falle el segundo para
  # perder los dos: eso es lo que pasaba con `tlp.service`, que al arrancar en caliente
  # puede negarse (TLP aborta si detecta otro gestor de energía todavía vivo, y el
  # `disable --now` de power-profiles-daemon de más arriba no siempre ha terminado de
  # soltar los ajustes del kernel). El instalador avisaba "no pude activar tlp.service"
  # y el equipo se quedaba SIN la unidad activada, cuando el `enable` habría funcionado
  # perfectamente — de ahí que un `sudo systemctl enable tlp` a mano después lo
  # arreglara siempre. Ahora un arranque en caliente fallido no cancela la activación:
  # peor caso, TLP entra en el siguiente reinicio, que es cuando importa.
  local unidad estado_enable estado_start
  for unidad in "${unidades[@]}"; do
    systemctl list-unit-files "$unidad" >/dev/null 2>&1 || {
      warn "La unidad $unidad no existe (¿falló su paquete?); no la activo."
      continue
    }

    if systemctl is-enabled --quiet "$unidad" 2>/dev/null; then
      estado_enable=0
    elif estado_enable="$(sudo systemctl enable "$unidad" 2>&1)"; then
      estado_enable=0
    else
      warn "No pude activar $unidad para los próximos arranques: ${estado_enable:-error de systemctl}"
      estado_enable=1
    fi

    systemctl is-active --quiet "$unidad" 2>/dev/null && continue
    estado_start="$(sudo systemctl start "$unidad" 2>&1)" && continue
    # Sólo se pierde el efecto de ESTA sesión; si el enable quedó hecho, el aviso lo dice
    # para no mandar al usuario a arreglar algo que ya está bien.
    if (( estado_enable == 0 )); then
      warn "$unidad quedó activada pero no arrancó ahora (${estado_start:-error de systemctl}); se aplicará al reiniciar."
    else
      warn "No pude arrancar $unidad (${estado_start:-error de systemctl}); actívala antes de iniciar Hyprland."
    fi
  done
}

# ¿El shell de login de $1 en /etc/passwd es el binario $2? Relee /etc/passwd en cada
# llamada a propósito: es lo que permite usarla como verificación DESPUÉS del chsh.
# readlink -f a los dos lados porque /bin/zsh y /usr/bin/zsh son el mismo binario en
# Arch, y compararlos como cadenas hacía que cada reejecución intentase el chsh otra vez.
shell_de_login_es() {
  local usuario="$1" objetivo="$2" actual
  actual="$(getent passwd "$usuario" | cut -d: -f7)"
  [[ "$(readlink -f "$actual" 2>/dev/null)" == "$(readlink -f "$objetivo")" ]]
}

# Cambiar el shell es el ÚLTIMO paso y no puede ser fatal: llegados aquí todo lo demás
# ya está instalado, y morir por el shell dejaba un escritorio completo reportado como
# instalación fallida. Además `chsh` pide contraseña, así que sin terminal (curl | bash)
# no hay forma de hacerlo: se avisa con la orden exacta y se sigue.
#
# El shell de login es ZSH, y Fish NO es una alternativa a medio camino: son dos shells
# paralelos, corre uno u otro, y todo el trabajo está en Zsh. `fish-parity.zsh` reproduce
# sobre Zsh lo que da Fish (rutas y MANPAGER de cachyos-config.fish, sus alias y
# funciones, el historial con fecha, la búsqueda por fragmento con las flechas, la paleta
# exacta del tema por defecto de Fish y su Ctrl+C). Fish se instala como REFERENCIA de esa
# paridad —por eso el preflight solo le comprueba la sintaxis—, no para usarlo: un login
# en Fish pierde los ~270 alias de Zsh (todo el plugin git de Oh My Zsh y los atajos de
# navegación) y se queda en unos 30.
#
# `chsh` NO SIRVE COMO SEÑAL DE ÉXITO. Devuelve 0 en casos donde /etc/passwd no cambia
# —PAM lo deniega y lo reporta por stderr, o el shell no está en /etc/shells y algunas
# implementaciones solo avisan—, así que fiarse del código de salida dejaba una
# instalación "completa" con la terminal abriendo el shell de antes y ni un error a la
# vista: el mismo fallo mudo que el symlink de `display-manager.service` en el paso
# `sddm`. Por eso se vuelve a leer /etc/passwd DESPUÉS y es esa lectura, no el rc, la que
# decide si el paso salió bien.
configure_default_shell() {
  local zsh_path current_shell current_user

  zsh_path="$(command -v zsh 2>/dev/null || true)"
  [[ -n "$zsh_path" ]] || {
    warn "Zsh no está instalado; el shell predeterminado se queda como estaba."
    return
  }
  # Sin esta línea en /etc/shells, chsh lo rechaza para un usuario sin privilegios (y
  # login/SDDM tratarían la cuenta como restringida). El paquete `zsh` la añade solo;
  # comprobarlo distingue "falta el paquete a medio instalar" de "no pude cambiarlo".
  grep -Fxq "$zsh_path" /etc/shells || {
    warn "$zsh_path no figura en /etc/shells; no puedo activarlo como shell predeterminado."
    return
  }

  current_user="$(id -un)"
  current_shell="$(getent passwd "$current_user" | cut -d: -f7)"
  if shell_de_login_es "$current_user" "$zsh_path"; then
    info "Zsh ya es el shell predeterminado de $current_user."
    return
  fi

  if ! preguntar_si_no "El shell actual es $current_shell. ¿Quieres cambiarlo a Zsh?" si; then
    info "Se conserva el shell de inicio actual ($current_shell)."
    return
  fi

  if ((INTERACTIVE)); then
    info "Estableciendo Zsh como shell predeterminado de $current_user (shell actual: $current_shell) ..."
    run_interactive chsh -s "$zsh_path" || true
    if shell_de_login_es "$current_user" "$zsh_path"; then
      info "Zsh quedó como shell predeterminado de $current_user; surte efecto al volver a iniciar sesión."
      return
    fi
  fi
  warn "No se pudo cambiar el shell a Zsh (sigue siendo $current_shell). Ejecuta: chsh -s '$zsh_path'"
  }

  case "$MODO_INSTALACION" in
  solo-paquetes) info "Modo: solo instalar paquetes." ;;
  sin-paquetes) info "Modo: instalación completa sin gestionar paquetes." ;;
  *) info "Modo: instalación completa." ;;
  esac
  echo

  if [[ "$MODO_INSTALACION" != sin-paquetes ]]; then
  install_packages
  else
  info "Paquetes omitidos; no se comprobará su disponibilidad."
  fi

  if [[ "$MODO_INSTALACION" == solo-paquetes ]]; then
  esperar_descargas_de_fondo
  echo
  info "Instalación de paquetes terminada."
  resumen_degradado
  exit 0
  fi

  command -v git >/dev/null || die "git no está instalado."

  # --- 1. Clonar el repo bare (o reutilizar) ---
    if [ -d "$DOTGIT" ]; then
    # Existir no basta: un clon interrumpido (Ctrl+C, red caída) deja el directorio creado
    # pero sin repo dentro, y a partir de ahí TODAS las reejecuciones fallaban en el fetch
    # con "not a git repository" sin decir que la causa es un clon a medias.
    if git --git-dir="$DOTGIT" rev-parse --git-dir >/dev/null 2>&1; then
    info "Ya existe $DOTGIT; actualizaré el repositorio."
    else
      reservar_backup
      warn "$DOTGIT no es un repositorio Git válido; lo guardaré en $BACKUP."
      mv "$DOTGIT" "$BACKUP/dotfiles-roto"
    fi
    fi
    if [ ! -d "$DOTGIT" ]; then
    info "Clonando $REPO_URL en $DOTGIT ..."
    # Sin esto, un clon fallido deja el directorio a medias y la siguiente ejecución
    # tropieza con él en vez de reintentar limpio.
    git clone --bare "$REPO_URL" "$DOTGIT" || {
      rm -rf "$DOTGIT"
      die "No se pudo clonar $REPO_URL. Comprueba la conexión y la URL y vuelve a ejecutar el instalador."
    }
    fi

    # refspec estándar para tener refs/remotes/origin/* y upstreams correctos
    dotfiles config remote.origin.fetch "+refs/heads/*:refs/remotes/origin/*"
    dotfiles config status.showUntrackedFiles no
    info "Fetch de origin ..."
    dotfiles fetch --prune origin || die "Falló la actualización desde origin. Comprueba la conexión y vuelve a ejecutar el instalador."

    dotfiles rev-parse --verify --quiet "refs/remotes/origin/$BRANCH" >/dev/null \
    || die "La rama '$BRANCH' no existe en origin. Prueba con DOTFILES_BRANCH=<rama>."

    # --- 2. Checkout/actualización con backup de conflictos ---
    # -B es importante al reutilizar ~/.dotfiles: un checkout normal de una rama
    # local existente no la avanza después del fetch y dejaría instalada una versión
    # antigua. La copia desplegada debe seguir exactamente origin/$BRANCH.
    #
    # PERO `-B` MUEVE EL PUNTERO DE LA RAMA. En una máquina ya instalada —que es el caso
    # normal al reejecutar el instalador— cualquier commit local que todavía no esté en
    # origin desaparece del historial: solo queda en el reflog, donde nadie lo va a buscar
    # porque nada avisa de que se perdió. Antes de tocar nada se comprueba y se deja una
    # etiqueta de rescate con un nombre que se puede volver a encontrar.
    if dotfiles rev-parse --verify --quiet "refs/heads/$BRANCH" >/dev/null; then
    commits_locales="$(dotfiles rev-list --count "origin/$BRANCH..$BRANCH" 2>/dev/null || echo 0)"
    if [[ "$commits_locales" != 0 ]]; then
      rescate="gigishell-preinstall-$(date +%Y%m%d-%H%M%S)"
      dotfiles tag "$rescate" "$BRANCH" >/dev/null 2>&1 || true
      warn "La rama local '$BRANCH' tiene $commits_locales commit(s) que no están en origin."
      dotfiles log --oneline "origin/$BRANCH..$BRANCH" 2>/dev/null | sed 's/^/    /' >&2 || true
      warn "Los guardé en la etiqueta '$rescate'; recupéralos con: dotfiles log $rescate"
    fi
    fi

    # Los ficheros rastreados que hayas modificado a mano podrían bloquear el checkout. Se
    # enumeran antes de actualizar para mostrar cuáles difieren del destino; solo se mueven
    # al backup los que realmente impidan el checkout.
    # Solo cuentan los que EXISTEN en $HOME: en una máquina nueva el diff da todo el árbol como
    # borrado y el aviso listaba cientos de ficheros que no se iban a respaldar porque no hay nada.
    modificados="$(dotfiles diff --name-only "origin/$BRANCH" -- 2>/dev/null \
    | while IFS= read -r f; do [[ -e "$HOME/$f" || -L "$HOME/$f" ]] && printf '%s\n' "$f"; done || true)"
    if [[ -n "$modificados" ]]; then
    warn "Estos archivos difieren de origin/$BRANCH y podrían bloquear la actualización:"
    printf '%s\n' "$modificados" | sed 's/^/    /' >&2
    fi

    info "Actualizando los archivos desde origin/$BRANCH ..."
    # Preparar los posibles bloqueos antes del checkout, usando listas NUL de Git en vez
    # de interpretar el mensaje traducible del error. Se contemplan cambios rastreados,
    # archivos sin seguimiento y enlaces rotos, incluidos los ignorados por Git. Se
    # consultan solo las rutas de destino, sin recorrer todo HOME buscando ignorados.
    declare -A cambios_destino=() cambios_locales=() archivos_actuales=() bloqueos_checkout=() bloqueos_ignorados=()
    archivos_destino_lista=() cambios_destino_lista=() cambios_locales_lista=() archivos_actuales_lista=()
    mapfile -d '' -t archivos_destino_lista < <(dotfiles ls-tree -r -z --name-only "origin/$BRANCH" 2>/dev/null)
    mapfile -d '' -t archivos_actuales_lista < <(dotfiles ls-files -z 2>/dev/null)
    for f in "${archivos_actuales_lista[@]}"; do archivos_actuales["$f"]=1; done
    if dotfiles rev-parse --verify HEAD >/dev/null 2>&1; then
    mapfile -d '' -t cambios_destino_lista < <(dotfiles diff --name-only --no-renames -z HEAD "origin/$BRANCH" -- 2>/dev/null)
    mapfile -d '' -t cambios_locales_lista < <(dotfiles diff --name-only --no-renames -z HEAD -- 2>/dev/null)
    for f in "${cambios_destino_lista[@]}"; do cambios_destino["$f"]=1; done
    for f in "${cambios_locales_lista[@]}"; do cambios_locales["$f"]=1; done
    fi
    for f in "${!cambios_locales[@]}"; do
    [[ -n "${cambios_destino[$f]:-}" ]] && bloqueos_checkout["$f"]=1
    done
    for f in "${archivos_destino_lista[@]}"; do
    if [[ -z "${archivos_actuales[$f]:-}" && ( -e "$HOME/$f" || -L "$HOME/$f" ) ]]; then
      bloqueos_checkout["$f"]=1
      dotfiles check-ignore -q -- "$f" 2>/dev/null && bloqueos_ignorados["$f"]=1
    fi
    padre="$f"
    while [[ "$padre" == */* ]]; do
      padre="${padre%/*}"
        if [[ -z "${archivos_actuales[$padre]:-}" && ( -e "$HOME/$padre" || -L "$HOME/$padre" ) && ( ! -d "$HOME/$padre" || -L "$HOME/$padre" ) ]]; then
          bloqueos_checkout["$padre"]=1
          dotfiles check-ignore -q -- "$padre" 2>/dev/null && bloqueos_ignorados["$padre"]=1
        fi
    done
    done

    # Git puede sobrescribir sin error algunos archivos ignorados que origin empieza a
    # versionar. Copiamos esas rutas antes del checkout, aunque Git no las anuncie como
    # conflicto; al copiar, un fallo ajeno no aparta el archivo de su sitio.
    for f in "${!bloqueos_ignorados[@]}"; do
    [[ -e "$HOME/$f" || -L "$HOME/$f" ]] || continue
    [[ -f "$HOME/$f" || -L "$HOME/$f" ]] || continue
    reservar_backup
    mkdir -p "$BACKUP/$(dirname "$f")"
    cp -a -- "$HOME/$f" "$BACKUP/$f" \
      || die "No pude respaldar el archivo ignorado que coincide con origin: $HOME/$f"
    echo "  Copia de seguridad (archivo ignorado): $f"
    unset 'bloqueos_checkout[$f]'
    done

    if ! checkout_error="$(LC_ALL=C dotfiles checkout -B "$BRANCH" "origin/$BRANCH" 2>&1)"; then
    if [[ "$checkout_error" != *"would be overwritten by checkout"* \
       && "$checkout_error" != *"would lose untracked files"* ]]; then
      printf '%s\n' "$checkout_error" >&2
      die "Falló git checkout por un motivo distinto de un conflicto de archivos; no moví ningún archivo."
    fi
    respaldados=0
    for f in "${!bloqueos_checkout[@]}"; do
      [[ -e "$HOME/$f" || -L "$HOME/$f" ]] || continue
      reservar_backup
      mkdir -p "$BACKUP/$(dirname "$f")"
      mv "$HOME/$f" "$BACKUP/$f"
      echo "  Copia de seguridad: $f"
      respaldados=$((respaldados + 1))
    done
    # Si el estado de Git no explica el fallo, no se mueve nada a ciegas ni se repite
    # el checkout: se conserva el mensaje original para distinguir permisos, disco, etc.
    if ((respaldados == 0)); then
      printf '%s\n' "$checkout_error" >&2
      die "Falló git checkout y no pude identificar archivos bloqueantes. 'dotfiles status' oculta archivos sin seguimiento por configuración; comprueba también 'dotfiles status --untracked-files=normal'."
    fi
    warn "Se respaldaron $respaldados archivo(s) que impedían actualizar la rama. Copias en: $BACKUP."
    LC_ALL=C dotfiles checkout -B "$BRANCH" "origin/$BRANCH" \
      || die "Git sigue sin poder actualizar los archivos; revisa $BACKUP."
    fi
    dotfiles branch --set-upstream-to="origin/$BRANCH" "$BRANCH" >/dev/null 2>&1 || true
    info "Dotfiles en su lugar (rama $BRANCH)."

  # --- 3. Symlinks de GiGiShell (respaldando lo que estorbe) ---
    LINK="$GIGISHELL/bin/link.sh"
    if [ -x "$LINK" ]; then
    info "Creando enlaces simbólicos de GiGiShell ..."
    if (( BACKUP_RESERVADO )); then
      LINK_BACKUP="$BACKUP" bash "$LINK" --force || die "No se pudieron crear todos los enlaces. Revisa los mensajes anteriores."
    else
      bash "$LINK" --force || die "No se pudieron crear todos los enlaces. Revisa los mensajes anteriores."
    fi
    else
    die "No encontré $LINK. El repositorio no contiene GiGiShell/bin/link.sh."
    fi

  # --- 4. Ficheros de sistema (/etc) ---
    # Los archivos de sistema se instalan aquí, justo detrás de los enlaces simbólicos.
    # Solo dependen del checkout ($HOME/GiGiShell/system) y de sudo.
    # NO se symlinkean, se copian: udev y systemd leen /etc antes de que $HOME esté montado, y
    # apuntar /etc a un directorio escribible por el usuario sería una escalada silenciosa.
    # Sin este paso la instalación arranca igual, pero con dos fallos mudos:
    #   • sin la regla udev, una copia a un USB "termina" con cientos de MB aún en RAM y retirar
    #     el pendrive pierde los datos de verdad (ver CLAUDE.md, sección USB);
    #   • sin i2c-dev no existen los nodos /dev/i2c-*, así que ddcutil no ve el monitor y el
    #     slider de brillo desaparece en un sobremesa (en un portátil da igual: usa sysfs).
    SYSTEM_DIR="$GIGISHELL/system"
    if [ -d "$SYSTEM_DIR" ] && command -v sudo >/dev/null; then
    info "Instalando los archivos de sistema en /etc (se solicitará la contraseña de sudo si hace falta) ..."
    # Con --sin-paquetes no se pasó por install_packages, así que sudo no está
    # precalentado y el primer `sudo install` abriría un prompt de contraseña en mitad del
    # paso. Es idempotente: si ya hay credencial válida, no hace nada.
    sudo_prime
    if sudo install -Dm644 "$SYSTEM_DIR/udev/99-gigishell-usb-writeback.rules" \
         /etc/udev/rules.d/99-gigishell-usb-writeback.rules; then
      sudo udevadm control --reload-rules \
        || warn "No pude recargar udev; la regla de USB se aplicará al reiniciar."
    else
      warn "No pude instalar la regla udev de USB. Instálala a mano (ver CLAUDE.md, sección USB)."
    fi
    if sudo install -Dm644 "$SYSTEM_DIR/modules-load.d/i2c-dev.conf" \
         /etc/modules-load.d/i2c-dev.conf; then
      # modules-load.d solo actúa en el arranque: cargarlo ahora evita tener que reiniciar
      # para que el brillo por DDC/CI funcione ya en esta sesión.
      sudo modprobe i2c-dev || warn "No pude cargar i2c-dev ahora; se cargará al reiniciar."
    else
      warn "No pude instalar i2c-dev.conf; el brillo por DDC/CI no funcionará hasta hacerlo."
    fi
    # Botón de encendido: se lo cedemos a Hyprland. Sin esto logind lo maneja él
    # (HandlePowerKey=poweroff de fábrica), a nivel de asiento y sin pasar por el
    # compositor, así que el bind se ejecuta pero el apagado de logind lo tapa y la
    # acción elegida en Ajustes > Energía no se nota nunca (fallo mudo).
    if sudo install -Dm644 "$SYSTEM_DIR/logind.conf.d/99-gigishell-powerkey.conf" \
         /etc/systemd/logind.conf.d/99-gigishell-powerkey.conf; then
      # `reload` y no `restart`: reiniciar logind puede llevarse la sesión por delante.
      sudo systemctl reload systemd-logind \
        || warn "No pude recargar systemd-logind; el botón de encendido usará la acción de logind hasta reiniciar."
    else
      warn "No pude ceder el botón de encendido a Hyprland; seguirá apagando el equipo (ver CLAUDE.md, sección del botón de encendido)."
    fi
    # TLP: perfiles conmutables Normal/Ahorro. Solo si TLP está instalado (en un
    # equipo sin TLP la función queda oculta en Ajustes > Energía). Todo lo que toca
    # root es root-owned: helper en /usr/local/bin, perfiles en /etc/gigishell/tlp, y la
    # regla sudoers acotada al comando exacto. NO se toca /etc/tlp.conf aquí: eso lo
    # hace el helper cuando el usuario elige un perfil.
    if (( TLP_HABILITADO )) && command -v tlp >/dev/null 2>&1; then
      if [[ "$MODO_INSTALACION" == sin-paquetes ]]; then
        for conflicto in power-profiles-daemon.service tuned.service auto-cpufreq.service; do
          systemctl is-enabled --quiet "$conflicto" 2>/dev/null ||
            systemctl is-active --quiet "$conflicto" 2>/dev/null || continue
          info "Desactivando $conflicto para usar TLP."
          sudo systemctl disable --now "$conflicto" \
            || warn "No se pudo desactivar $conflicto; puede competir con TLP."
        done
      fi
      sudo install -Dm755 "$SYSTEM_DIR/tlp/gigishell-tlp-apply.sh" /usr/local/bin/gigishell-tlp-apply \
        && sudo install -Dm644 "$SYSTEM_DIR/tlp/normal.conf" /etc/gigishell/tlp/normal.conf \
        && sudo install -Dm644 "$SYSTEM_DIR/tlp/ahorro.conf" /etc/gigishell/tlp/ahorro.conf \
        || warn "No pude instalar los perfiles TLP de GiGiShell."
      instalar_sudoers "$SYSTEM_DIR/tlp/sudoers-gigishell-tlp" /etc/sudoers.d/gigishell-tlp \
        "el cambio de perfil de energía pedirá contraseña."
    else
      info "TLP no está instalado; instala 'tlp' y vuelve a ejecutar bash ~/GiGiShell/install.sh para configurar los perfiles de energía."
    fi
    # Cámara: interruptor "Cámara bloqueada" de QuickSettings y de Ajustes > Cámara. Mismo
    # esquema que TLP y ClamAV (helper root-owned + regla sudoers acotada a los verbos exactos)
    # porque los nodos /dev/video* son de root:video y quien decide sus permisos es udev. Sin
    # esto el interruptor no se pinta; el resto de la sección de cámara (controles, vista previa,
    # detector de uso) funciona igual, que por eso no va condicionado a ningún paquete.
    sudo install -Dm755 "$SYSTEM_DIR/camara/gigishell-camara.sh" /usr/local/bin/gigishell-camara \
      || warn "No pude instalar el script auxiliar de cámara; no aparecerá el interruptor de bloqueo."
    instalar_sudoers "$SYSTEM_DIR/camara/sudoers-gigishell-camara" /etc/sudoers.d/gigishell-camara \
      "bloquear la cámara pedirá contraseña."
    # ClamAV: botón "Actualizar firmas" de Ajustes > Seguridad > Antivirus. Mismo esquema que TLP
    # (helper root-owned + regla sudoers acotada al comando exacto) porque /var/lib/clamav es de
    # `clamav` y detener/iniciar/deshabilitar el servicio es de root. Sin esto el botón no se pinta;
    # la actualización sigue pudiendo hacerse a mano con `sudo freshclam`.
    if command -v freshclam >/dev/null 2>&1; then
      sudo install -Dm755 "$SYSTEM_DIR/clamav/gigishell-clamav-update.sh" /usr/local/bin/gigishell-clamav-update \
        || warn "No pude instalar el script auxiliar de ClamAV; no aparecerá el botón de firmas en Ajustes."
      instalar_sudoers "$SYSTEM_DIR/clamav/sudoers-gigishell-clamav" /etc/sudoers.d/gigishell-clamav \
        "actualizar las firmas pedirá contraseña."
    else
      info "ClamAV no está instalado; instala 'clamav' y vuelve a ejecutar bash ~/GiGiShell/install.sh para configurar las firmas."
    fi
    # Limpieza de disco: Ajustes > Almacenamiento > Liberar espacio. Tercer helper con el mismo
    # esquema (root-owned + sudoers acotado), y aquí el NOPASSWD es lo que hace posible la
    # AUTOLIMPIEZA desatendida: un diálogo de contraseña que aparece solo, de madrugada, no lo lee
    # nadie. Por eso el helper solo expone verbos cuyo efecto se regenera (caché de pacman, journal,
    # /var/tmp, huérfanos); vaciar la caché entera y borrar instantáneas siguen pidiendo contraseña
    # por pkexec desde su botón. Sin esto, esas limpiezas salen como "falta el ayudante" en la UI y
    # el resto (todo lo que vive bajo $HOME) sigue funcionando.
    sudo install -Dm755 "$SYSTEM_DIR/limpieza/gigishell-limpieza.sh" /usr/local/bin/gigishell-limpieza \
      || warn "No pude instalar el script auxiliar de limpieza; el sistema pedirá instalarlo al liberar espacio."
    instalar_sudoers "$SYSTEM_DIR/limpieza/sudoers-gigishell-limpieza" /etc/sudoers.d/gigishell-limpieza \
      "la autolimpieza quedará limitada a tu carpeta personal (sin caché de pacman ni journal)."
    else
    warn "No puedo configurar los archivos de /etc (falta sudo o $SYSTEM_DIR); el brillo DDC/CI y la escritura a USB quedarán sin configurar."
    fi

  # La descarga de firmas es un paso independiente del resto de la configuración de /etc.
  # Este bloque no depende de que se ejecute antes otra configuración del sistema.
  if command -v freshclam >/dev/null 2>&1 \
  && command -v sudo >/dev/null 2>&1 \
  && [[ ! -x /usr/local/bin/gigishell-clamav-update ]] \
  && [[ -r "$GIGISHELL/system/clamav/gigishell-clamav-update.sh" ]]; then
  sudo_prime
  sudo install -Dm755 "$GIGISHELL/system/clamav/gigishell-clamav-update.sh" \
    /usr/local/bin/gigishell-clamav-update \
    || warn "No se pudo instalar el actualizador de ClamAV; no se descargarán las firmas."
  instalar_sudoers "$GIGISHELL/system/clamav/sudoers-gigishell-clamav" \
    /etc/sudoers.d/gigishell-clamav "actualizar las firmas pedirá contraseña."
  fi
  if ! command -v freshclam >/dev/null 2>&1; then
    CLAMAV_ESTADO="no_disponible"
    info "ClamAV no está instalado; omito la descarga de firmas."
    elif ! command -v sudo >/dev/null 2>&1; then
    CLAMAV_ESTADO="no_disponible"
    warn "No se encuentra sudo; no se pueden actualizar las firmas de ClamAV."
    elif [[ ! -x /usr/local/bin/gigishell-clamav-update ]]; then
    CLAMAV_ESTADO="no_disponible"
    warn "No se encuentra el actualizador de ClamAV; vuelve a ejecutar bash ~/GiGiShell/install.sh para instalarlo."
    elif compgen -G '/var/lib/clamav/daily.c?d' >/dev/null &&
    [[ -n "$(find /var/lib/clamav -maxdepth 1 -name 'daily.c?d' -mtime -1 -print -quit 2>/dev/null)" ]]; then
    CLAMAV_ESTADO="al_dia"
    info "Las firmas de ClamAV ya están al día; no es necesario descargarlas."
    else
    # Se lanzan en segundo plano porque ningún paso intermedio depende de ellas.
    # Se recogen en `esperar_descargas_de_fondo`, antes de la validación final.
    # sudo -n evita que un proceso en segundo plano se quede esperando una contraseña.
    sudo_prime
    info "Descargando la base de firmas de ClamAV en segundo plano (~200 MB) ..."
    sudo -n /usr/local/bin/gigishell-clamav-update update >/dev/null 2>&1 &
    CLAMAV_PID=$!
    CLAMAV_ESTADO="descargando"
    fi

  if [[ "$INSTALL_HIBERNATION" == 1 ]]; then
  # --- Hibernación ---
  #
  # Va APARTE del paso `sistema`: crea un fichero de varios GiB y modifica el arranque, por
  # eso se ejecuta únicamente tras consentimiento explícito.
  #
  # Sin este paso, el tiempo de hibernación de Ajustes > Pantalla > Suspensión sale apagado con
  # su motivo ("sin swap o sin resume"), que es la degradación que se busca: visible, no muda.
  SYSTEM_DIR="$GIGISHELL/system"
  if [ -d "$SYSTEM_DIR/hibernacion" ] && command -v sudo >/dev/null; then
    sudo_prime
    info "Preparando la hibernación (swapfile + resume= + NVIDIA). Esto tarda un rato ..."
    if sudo bash "$SYSTEM_DIR/hibernacion/gigishell-hibernacion-setup.sh"; then
      HIBERNACION_LISTA=1
    else
      warn "No pude preparar la hibernación. El resto de la instalación sigue; revisa la salida de arriba."
    fi
  else
    warn "No puedo configurar la hibernación (falta sudo o $SYSTEM_DIR/hibernacion)."
  fi
  fi

  # --- SDDM: configuración + activación como gestor de sesión ---
    #
    # Son DOS cosas distintas y cada una falla en silencio por su lado:
    #
    #   • La configuración (/etc/sddm.conf.d/zz-gigishell.conf): autologin en Hyprland,
    #     tema del saludador y rango de usuarios. Sin ella SDDM arranca igual, con su
    #     aspecto de fábrica y pidiendo contraseña — molesto, no roto.
    #
    #   • La ACTIVACIÓN, que en systemd ES UN SYMLINK:
    #       /etc/systemd/system/display-manager.service -> /usr/lib/systemd/system/sddm.service
    #     Lo crea `systemctl enable sddm.service`, porque la unidad declara
    #     `Alias=display-manager.service`. Sin ese enlace no hay ningún error: el equipo
    #     arranca hasta un TTY y ahí se queda. Todo lo que instalan los pasos anteriores
    #     está bien y nada lo lanza. Por eso este paso comprueba el enlace DESPUÉS de
    #     activar, en vez de fiarse del código de salida de systemctl.
    #
    # Igual que los ficheros de /etc del paso anterior, la config NO se symlinkea a
    # ~/GiGiShell: SDDM la lee como root y antes de que exista sesión de usuario, y apuntar
    # /etc a un directorio escribible por el usuario sería una escalada silenciosa. Se
    # materializa desde la plantilla system/sddm/zz-gigishell.conf.in sustituyendo los campos
    # que son de cada máquina (usuario, sesión, tema, método de entrada).
    #
    # EL NOMBRE ES "zz-" A PROPÓSITO, no es un capricho: conf.d se lee en orden alfabético
    # y gana el último, y los dígitos van ANTES que las letras. El nombre anterior
    # (99-gigios.conf) quedaba por delante de los restos de HyDE (the_hyde_project.conf) y
    # los dejaba a ELLOS mandando, en silencio. Ver la cabecera de la plantilla.
    SDDM_PLANTILLA="$GIGISHELL/system/sddm/zz-gigishell.conf.in"
    SDDM_DESTINO=/etc/sddm.conf.d/zz-gigishell.conf
    # Restos de instalaciones anteriores de GiGiShell con el nombre malo. No se deja: dos
    # ficheros nuestros con valores distintos es exactamente el enredo que cuesta una tarde.
    SDDM_DESTINO_VIEJO=/etc/sddm.conf.d/99-gigios.conf
    # El drop-in de antes del renombrado del proyecto (GiGiOS -> GiGiShell). Se lee para
    # conservar el autologin que el usuario tuviera y se retira igual que el anterior.
    SDDM_DESTINO_GIGIOS=/etc/sddm.conf.d/zz-gigios.conf

    # Último valor no comentado de una clave en un .conf de SDDM. Vale para comprobar si
    # /etc/sddm.conf —que tiene MÁS precedencia que todo /etc/sddm.conf.d/, ver
    # `man 5 sddm.conf`— nos está pisando lo que acabamos de escribir.
    sddm_valor() {
    [[ -r "$1" ]] || return 0
    awk -F= -v clave="$2" '
      /^[[:space:]]*[#;]/ { next }
      {
        campo = $1
        gsub(/^[[:space:]]+|[[:space:]]+$/, "", campo)
        if (campo == clave) {
          sub(/^[^=]*=/, "")
          gsub(/^[[:space:]]+|[[:space:]]+$/, "", $0)
          valor = $0
        }
      }
      END { print valor }
    ' "$1" 2>/dev/null
    }

    if ! command -v sudo >/dev/null; then
    warn "No puedo configurar SDDM (falta sudo); el equipo podría arrancar en una consola sin gestor de sesión."
    elif [ ! -r "$SDDM_PLANTILLA" ]; then
    warn "Falta $SDDM_PLANTILLA; no configuro SDDM."
    elif ! pacman -Qq sddm >/dev/null 2>&1 && ! command -v sddm >/dev/null 2>&1; then
    warn "SDDM no está instalado; no lo configuro ni lo activo. Instala sddm y vuelve a ejecutar bash ~/GiGiShell/install.sh."
    else
    info "Configurando SDDM ..."
    sudo_prime

    # Sesión: el .desktop que SDDM le pasará a autologin. /usr/local/share tiene
    # prioridad sobre /usr/share (es donde caen las sesiones instaladas a mano), y es el
    # orden en que las lee el propio SDDM. Si no hay ninguna, el campo se deja VACÍO en
    # vez de inventarse un nombre: un Session= que no existe deja el autologin fallando
    # en bucle contra el saludador, que es peor que no tenerlo.
    SDDM_SESION=""
    for _dir in /usr/local/share/wayland-sessions /usr/share/wayland-sessions; do
      if [ -r "$_dir/hyprland.desktop" ]; then SDDM_SESION=hyprland.desktop; break; fi
    done
    [ -n "$SDDM_SESION" ] \
      || warn "No encontré hyprland.desktop en wayland-sessions; SDDM arrancará sin sesión predefinida."

    # --- El tema del saludador ---
    # Se INSTALA aquí, desde system/sddm/tema/ (variante jake_the_dog de
    # sddm-astronaut-theme; ver system/sddm/tema/README.md). Se COPIA a
    # /usr/share/sddm/themes/gigishell y no se symlinkea a ~/GiGiShell por la misma razón que
    # la configuración: el greeter corre como el usuario `sddm`, antes de que exista
    # ninguna sesión, y /home puede ni estar montado todavía (LUKS, disco aparte). Un
    # tema ilegible no da error — SDDM cae a su aspecto de fábrica y ya.
    SDDM_TEMA_ORIGEN="$GIGISHELL/system/sddm/tema"
    SDDM_TEMA_DESTINO=/usr/share/sddm/themes/gigishell
    if [ -r "$SDDM_TEMA_ORIGEN/metadata.desktop" ]; then
      info "Instalando el tema de inicio de sesión en $SDDM_TEMA_DESTINO ..."
      # --delete: si una actualización quita un fichero del tema, el de la copia vieja
      # no puede quedarse (un Themes/*.conf huérfano confundiría al siguiente que mire).
      # rsync no está garantizado en un Arch pelado, así que el camino sin él es borrar
      # y copiar, que para 2,5 MB da igual.
      if command -v rsync >/dev/null 2>&1; then
        sudo rsync -a --delete "$SDDM_TEMA_ORIGEN/" "$SDDM_TEMA_DESTINO/" \
          || warn "No se pudo copiar el tema de inicio de sesión; SDDM conservará el que tuviera."
      else
        sudo rm -rf "$SDDM_TEMA_DESTINO" \
          && sudo mkdir -p "$SDDM_TEMA_DESTINO" \
          && sudo cp -a "$SDDM_TEMA_ORIGEN/." "$SDDM_TEMA_DESTINO/" \
          || warn "No se pudo copiar el tema de inicio de sesión; SDDM conservará el que tuviera."
      fi
      # Legible por el usuario `sddm`, que no es root: la copia hereda los permisos del
      # checkout y un umask restrictivo del usuario dejaría el tema sin leer.
      sudo chmod -R a+rX "$SDDM_TEMA_DESTINO" 2>/dev/null || true

      # La FUENTE va aparte, a /usr/share/fonts. El tema NO usa FontLoader: pide
      # Font="Thunderman" por nombre y quien la resuelve es fontconfig. Si no está
      # instalada en el sistema, Qt sustituye por la fuente por defecto y el saludador se
      # ve distinto SIN dar ningún error — el fallo aparece como "el tema no quedó igual".
      if [ -d "$SDDM_TEMA_ORIGEN/Fonts" ]; then
        if sudo install -d -m755 /usr/share/fonts/gigishell \
           && sudo install -m644 "$SDDM_TEMA_ORIGEN"/Fonts/* /usr/share/fonts/gigishell/; then
          # fc-cache actualiza el índice de fontconfig. Sin él la fuente está en disco
          # pero fc-match no la encuentra hasta el siguiente arranque.
          # El `|| true` NO es decorativo: con `set -e` esta línea es la última del
          # bloque, y sin fontconfig instalado (--sin-paquetes) el `command -v` falso
          # abortaría el instalador entero por no poder refrescar una caché de fuentes.
          { command -v fc-cache >/dev/null 2>&1 && sudo fc-cache -f >/dev/null 2>&1; } || true
        else
          warn "No se pudieron instalar las fuentes del tema en /usr/share/fonts/gigishell; la pantalla de inicio de sesión usará otra tipografía."
        fi
      fi
    else
      warn "No se encuentra $SDDM_TEMA_ORIGEN; no se instalará el tema de inicio de sesión."
    fi

    # Solo se fija si el directorio existe DE VERDAD tras el intento anterior. GiGiShell trae
    # su propio tema, así que no hay que caer a ninguno ajeno: aquí se listaban también
    # «Candy» y «sugar-candy», restos del instalador de HyDE que no pertenecen a ningún
    # paquete (`pacman -Qo` no los reconoce). Preferirlos era heredar el aspecto de otro
    # escritorio en cuanto el nuestro fallara al copiarse — mejor caer al tema empotrado
    # de SDDM, que al menos se ve como lo que es. Un Current= apuntando a un tema ausente
    # no da error: SDDM cae a ese tema empotrado y el aspecto cambia sin más.
    SDDM_TEMA=""
    if [ -d "$SDDM_TEMA_DESTINO" ]; then
      SDDM_TEMA=gigishell
    else
      info "El tema de GiGiShell no está en $SDDM_TEMA_DESTINO; la pantalla de inicio de sesión usará el aspecto predeterminado."
    fi

    # Teclado en pantalla: se fija SÓLO si el módulo QML está de verdad en el sistema.
    # InputMethod=qtvirtualkeyboard sin qt6-virtualkeyboard no degrada, ROMPE: el greeter
    # no llega a dibujarse y el equipo arranca a una pantalla negra, sin mensaje y sin
    # forma de entrar salvo por TTY. Vacío es «no fijes ninguno», que siempre funciona.
    SDDM_INPUTMETHOD=""
    for _qml in /usr/lib/qt6/qml /usr/lib/qt/qml /usr/lib64/qt6/qml; do
      if [ -d "$_qml/QtQuick/VirtualKeyboard" ]; then SDDM_INPUTMETHOD=qtvirtualkeyboard; break; fi
    done
    [ -n "$SDDM_INPUTMETHOD" ] \
      || info "qt6-virtualkeyboard no está instalado; la pantalla de inicio de sesión no tendrá teclado en pantalla."

    # Autologin: reproduce el comportamiento de esta máquina (entrar directo a Hyprland).
    # Se apaga con SDDM_AUTOLOGIN=0, y entonces el campo va vacío — que para SDDM es «no
    # hay autologin», no «autologin del usuario ''».
    #
    # Y ojo con REINSTALAR: esta misma clave la conmuta Ajustes > Cuenta > Inicio de
    # sesión (ags/modulos/ajustes/cuenta/autologin.ts). Volver a escribir aquí el valor
    # por defecto le desharía al usuario su decisión en silencio — no da ningún error,
    # simplemente el equipo vuelve a entrar solo (o a pedir contraseña) en el siguiente
    # arranque. Por eso, si SDDM_AUTOLOGIN no se pasó y ya existe nuestro fichero, manda
    # lo que el fichero diga; la variable sigue ganando siempre que se escriba.
    _sddm_quiere_autologin=$SDDM_AUTOLOGIN
    _sddm_previo="$SDDM_DESTINO"
    [ -r "$_sddm_previo" ] || _sddm_previo="$SDDM_DESTINO_GIGIOS"
    if ((!SDDM_AUTOLOGIN_EXPLICITO)) && [ -r "$_sddm_previo" ]; then
      if [ -n "$(sddm_valor "$_sddm_previo" User)" ]; then _sddm_quiere_autologin=1; else _sddm_quiere_autologin=0; fi
      ((_sddm_quiere_autologin == SDDM_AUTOLOGIN)) \
        || info "Conservo el inicio automático como estaba ($( ((_sddm_quiere_autologin)) && echo activado || echo desactivado )); pásame SDDM_AUTOLOGIN=$SDDM_AUTOLOGIN para forzarlo."
    fi
    if ((_sddm_quiere_autologin)) && [ -n "$SDDM_SESION" ]; then
      SDDM_USUARIO="$(id -un)"
    else
      SDDM_USUARIO=""
      ((_sddm_quiere_autologin)) && info "Sin sesión detectada: dejo SDDM pidiendo usuario y contraseña."
    fi

    if _sddm_tmp="$(mktemp)"; then
      if sed -e "s/__GIGISHELL_USER__/$SDDM_USUARIO/" \
             -e "s/__GIGISHELL_SESSION__/$SDDM_SESION/" \
             -e "s/__GIGISHELL_INPUTMETHOD__/$SDDM_INPUTMETHOD/" \
             -e "s/__GIGISHELL_THEME__/$SDDM_TEMA/" \
             "$SDDM_PLANTILLA" > "$_sddm_tmp" \
         && sudo install -Dm644 "$_sddm_tmp" "$SDDM_DESTINO"; then
        info "Escrito $SDDM_DESTINO (autologin: ${SDDM_USUARIO:-no}, tema: ${SDDM_TEMA:-por defecto})."
        # Solo se borra el viejo DESPUÉS de que el nuevo esté en su sitio.
        for _sddm_viejo in "$SDDM_DESTINO_VIEJO" "$SDDM_DESTINO_GIGIOS"; do
          if [ -e "$_sddm_viejo" ]; then
            sudo rm -f "$_sddm_viejo" && info "Retirado $_sddm_viejo (nombre antiguo)."
          fi
        done
        # /etc/sddm.conf gana sobre TODO el directorio conf.d pese a lo que sugiere el
        # nombre. Si trae una de nuestras claves con otro valor, lo que acabamos de
        # escribir no se aplica y no hay forma de notarlo mirando el fichero correcto.
        # No se toca: es de la distribución, y borrarlo a espaldas del usuario podría
        # llevarse ajustes que no son nuestros.
        for _clave in User Session Current InputMethod; do
          _suyo="$(sddm_valor /etc/sddm.conf "$_clave")"
          case "$_clave" in
            User)        _nuestro="$SDDM_USUARIO" ;;
            Session)     _nuestro="$SDDM_SESION" ;;
            Current)     _nuestro="$SDDM_TEMA" ;;
            InputMethod) _nuestro="$SDDM_INPUTMETHOD" ;;
          esac
          if [ -n "$_suyo" ] && [ "$_suyo" != "$_nuestro" ] && [ "$_suyo" != "${_nuestro%.desktop}" ]; then
            warn "/etc/sddm.conf fija $_clave=$_suyo y tiene más precedencia que $SDDM_DESTINO (donde vale '${_nuestro:-vacío}'): prevalece ese valor. Revísalo o quita esa línea."
          fi
        done
      else
        warn "No pude escribir $SDDM_DESTINO; SDDM se queda con la configuración que hubiera."
      fi
      rm -f "$_sddm_tmp"
    else
      warn "No pude crear un temporal para la configuración de SDDM; la dejo como estaba."
    fi

    # --- Activación (el symlink display-manager.service) ---
    # SIN `--now`: levantar SDDM desde dentro de una sesión gráfica viva le pelea la VT
    # al compositor que ya está corriendo. Se activa para el próximo arranque.
    _dm="$(readlink -f /etc/systemd/system/display-manager.service 2>/dev/null || true)"
    if [ -n "$_dm" ] && [ "$(basename "$_dm")" != sddm.service ]; then
      warn "El gestor de sesión activo es $(basename "$_dm"), no SDDM; no se cambiará. Para usar SDDM: sudo systemctl enable -f sddm.service"
    elif [ -n "$_dm" ]; then
      info "SDDM ya está activado (display-manager.service -> $_dm)."
    else
      info "Activando SDDM como gestor de sesión ..."
      sudo systemctl enable sddm.service \
        || warn "Falló 'systemctl enable sddm.service'."
      # Se comprueba el ENLACE, no el código de salida: es el enlace lo que arranca el
      # escritorio, y quedarse sin él es la diferencia entre un equipo que entra en
      # Hyprland y uno que se para en un TTY.
      if [ -L /etc/systemd/system/display-manager.service ]; then
        info "OK: display-manager.service -> $(readlink /etc/systemd/system/display-manager.service)"
      else
        warn "SDDM no se activó: falta display-manager.service. El equipo arrancará en una consola; actívalo con: sudo systemctl enable sddm.service"
      fi
    fi
    fi

  GESTOS_ESTADO="fallido"
    # --- Entorno del MODO GESTOS por cámara ---
    #
    # Dos cosas que no pueden vivir en el repo: un venv de Python y un modelo de 7,8 MB.
    #
    # ── POR QUÉ UN VENV Y NO UN PAQUETE ────────────────────────────────────────────────
    # MediaPipe no está en los repos oficiales. En AUR hay dos, y ninguno sirve:
    # `python-mediapipe` compila contra `python-tensorflow` (build de horas) y
    # `python-mediapipe-bin` se quedó en la 0.10.32. La rueda de PyPI (1.0.1) sí funciona
    # con el Python 3.14 de Arch — comprobado antes de escribir esto — pero `pip` al sistema
    # está prohibido en Arch (PEP 668, `externally-managed-environment`) y saltárselo con
    # --break-system-packages es exactamente lo que su nombre dice.
    #
    # `--system-site-packages` para reaprovechar `python-numpy` y `python-opencv`, que sí son
    # paquetes del sistema: sin él, pip se bajaría su propia copia de OpenCV (~90 MB) y
    # tendríamos dos, con la de pip ganando por orden de búsqueda.
    #
    # ── EL VENV MUERE CON CADA ACTUALIZACIÓN MAYOR DE PYTHON, Y HAY QUE DECIRLO ────────
    # Un venv guarda la versión de Python con la que se creó. Cuando Arch pase a 3.15, este
    # venv apuntará a un intérprete que ya no existe y el modo dejará de arrancar. No es un
    # fallo mudo —`gestos.sh` avisa con el motivo y Ajustes lo enseña— pero la solución es
    # rehacerlo: `bash ~/GiGiShell/install.sh`. Por eso el paso BORRA un venv roto en vez
    # de intentar repararlo.
    GESTOS_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/gigishell/gestos"
    GESTOS_MODELO="$GESTOS_DIR/hand_landmarker.task"
    GESTOS_VENV="$GESTOS_DIR/venv"
    # URL oficial de Google para el modelo del Hand Landmarker (variante float16, la que
    # recomiendan para CPU). No se versiona en el repo: son 7,8 MB de binario que git
    # guardaría entero en cada cambio, y el repo no tiene ningún otro blob.
    GESTOS_URL="https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task"

    mkdir -p "$GESTOS_DIR"

    # El venv se rehace si su intérprete ya no existe (ver arriba).
    if [ -d "$GESTOS_VENV" ] && [ ! -x "$GESTOS_VENV/bin/python" ]; then
    warn "El entorno de gestos apuntaba a un Python que ya no existe; lo rehago."
    rm -rf "$GESTOS_VENV"
    fi

    if [ ! -x "$GESTOS_VENV/bin/python" ]; then
    info "Creando el entorno de gestos (venv con MediaPipe) ..."
    if python3 -m venv --system-site-packages "$GESTOS_VENV" 2>/dev/null; then
      # `--upgrade` en pip primero: las ruedas de MediaPipe usan etiquetas de plataforma
      # que un pip viejo no sabe leer y rechaza con "no matching distribution", que suena
      # a "no existe para tu sistema" cuando el problema es el propio pip.
      if ! "$GESTOS_VENV/bin/pip" install --quiet --upgrade pip >/dev/null 2>&1; then
        warn "No se pudo actualizar pip; el modo gestos no se instalará en esta ejecución."
        rm -rf "$GESTOS_VENV"
      elif ! "$GESTOS_VENV/bin/pip" install --quiet mediapipe; then
        warn "No se pudo instalar MediaPipe. El modo gestos (SUPER+SHIFT+G) no funcionará; vuelve a intentarlo con: bash ~/GiGiShell/install.sh"
        rm -rf "$GESTOS_VENV"
      fi
    else
      warn "No pude crear el venv de gestos (¿falta python-virtualenv?). El modo gestos no funcionará."
    fi
    else
    info "El entorno de gestos ya existe."
    fi

    # El modelo, aparte del venv: son dos fallos independientes y arreglar uno no debe
    # obligar a rehacer el otro (bajar 200 MB de MediaPipe otra vez por un .task que se
    # truncó sería absurdo).
    if [ ! -s "$GESTOS_MODELO" ]; then
    info "Descargando el modelo de manos (7,8 MB) ..."
    # A un temporal y solo entonces al sitio: una descarga cortada dejaría un .task
    # truncado que MediaPipe rechaza al arrancar con un error de FlatBuffer que no dice
    # nada, y el usuario no tendría forma de saber que hay que volver a bajarlo.
    if curl -fsSL --retry 3 -o "$GESTOS_MODELO.parcial" "$GESTOS_URL"; then
      mv -f "$GESTOS_MODELO.parcial" "$GESTOS_MODELO"
    else
      rm -f "$GESTOS_MODELO.parcial"
      warn "No se pudo descargar el modelo de manos. El modo gestos (SUPER+SHIFT+G) no funcionará; vuelve a intentarlo con: bash ~/GiGiShell/install.sh"
    fi
    else
    info "El modelo de manos ya está descargado."
    fi

    # Comprobación de verdad: que el intérprete del venv pueda IMPORTAR lo que hace falta.
    # Que pip dijera "ok" no basta — una rueda instalada para otra versión de Python instala
    # sin quejarse y revienta al importar, que es justo el modo de fallo que este paso
    # existe para descartar.
    if [ -x "$GESTOS_VENV/bin/python" ] && [ -s "$GESTOS_MODELO" ]; then
    if "$GESTOS_VENV/bin/python" -c 'import mediapipe, cv2' >/dev/null 2>&1; then
      GESTOS_ESTADO="listo"
      info "Modo gestos listo: SUPER+SHIFT+G lo enciende y lo apaga."
    else
      warn "El entorno de gestos se instaló pero no importa (mediapipe/cv2). El modo no funcionará."
    fi
    fi

    EVENTD_ESTADO="fallido"
  # --- Monitor de seguridad en Rust (gigishell-eventd) ---
    #
    # Es OPCIONAL a propósito: `oom-monitor.sh` pregunta al binario qué sabe hacer y, si no
    # existe, corre sus funciones bash de siempre. Por eso este paso nunca instala por su
    # cuenta la cadena de Rust (~500 MB para compilar un binario de 500 KB): si no hay
    # `cargo`, lo dice y sigue. Ver docs/rust-migracion.md.
    #
    # rustup instalado a mano deja cargo en ~/.cargo/bin, que no siempre está en el PATH de
    # un script no interactivo; se añade aquí para no dar por ausente algo que sí está.
    export PATH="$HOME/.cargo/bin:$PATH"
    if ! command -v cargo >/dev/null 2>&1; then
    EVENTD_ESTADO="sin-cargo"
    warn "No hay cargo: el monitor de seguridad seguirá en bash. Instala Rust y vuelve a ejecutar bash ~/GiGiShell/install.sh para compilarlo."
    elif ! command -v cc >/dev/null 2>&1; then
    EVENTD_ESTADO="sin-cargo"
    warn "Hay cargo pero no un enlazador (cc): instala base-devel y vuelve a ejecutar bash ~/GiGiShell/install.sh para compilarlo."
    else
    info "Compilando gigishell-eventd (pasa los tests antes de instalar) ..."
    # `instalar.sh` corre `cargo test` y solo instala si pasan: un binario que no cumple
    # las reglas del bash es peor que ningún binario, porque el script le cede todo.
    if bash "$GIGISHELL/eventd/instalar.sh"; then
      EVENTD_ESTADO="listo"
    else
      warn "No se pudo compilar gigishell-eventd; el monitor de seguridad seguirá en bash. Reintento: bash ~/GiGiShell/install.sh"
    fi
    fi

  # --- 4. Aplicar el perfil ligero de Dolphin ---
    DOLPHIN_CONFIGURATOR="$GIGISHELL/bin/configurar-dolphin.sh"
    # No es fatal: el perfil de Dolphin son miniaturas y comportamiento del gestor de
    # archivos. Necesita kwriteconfig6, así que con --sin-paquetes o con kconfig sin
    # instalar fallaba y se llevaba por delante la instalación entera por un ajuste estético.
    if [ -x "$DOLPHIN_CONFIGURATOR" ]; then
    info "Configurando miniaturas y comportamiento de Dolphin ..."
    "$DOLPHIN_CONFIGURATOR" aplicar \
      || warn "No se pudo aplicar el perfil de Dolphin (¿falta kconfig?). Vuelve a intentarlo con: $DOLPHIN_CONFIGURATOR aplicar"
    else
    warn "No encontré $DOLPHIN_CONFIGURATOR; Dolphin se queda con sus ajustes de fábrica."
    fi

  # --- 5. Seleccionar el perfil de rendimiento de Kitty ---
    KITTY_SELECTOR="$GIGISHELL/bin/kitty-profile.sh"
    if [ -x "$KITTY_SELECTOR" ]; then
    info "Seleccionando el perfil de Kitty ($KITTY_PROFILE) ..."
    "$KITTY_SELECTOR" "$KITTY_PROFILE" \
      || warn "No se pudo activar el perfil de Kitty '$KITTY_PROFILE'. Vuelve a intentarlo con: $KITTY_SELECTOR $KITTY_PROFILE"
    else
    warn "No encontré $KITTY_SELECTOR; Kitty arrancará sin perfil de rendimiento."
    fi

  # --- 6. Seleccionar y aplicar el perfil de rendimiento de Firefox ---
    FIREFOX_SELECTOR="$GIGISHELL/bin/firefox-profile.sh"
    if [ -x "$FIREFOX_SELECTOR" ]; then
    info "Seleccionando el perfil de Firefox ($FIREFOX_PROFILE) ..."
    "$FIREFOX_SELECTOR" "$FIREFOX_PROFILE" \
      || warn "No se pudo activar el perfil de Firefox '$FIREFOX_PROFILE'. Vuelve a intentarlo con: $FIREFOX_SELECTOR $FIREFOX_PROFILE"
    else
    warn "No encontré $FIREFOX_SELECTOR; Firefox arrancará sin perfil de rendimiento."
    fi

  # --- 6b. Fijar el almacén de secretos de VS Code ---
    # VS Code lo instala el paso `paquetes` (official+=(code)), pero NADIE en esta sesión
    # ofrece el Secret Service `org.freedesktop.secrets`: KWallet/ksecretd está retirado a
    # propósito (hypr/gigishell/autostart.lua) y gnome-keyring no se instala. Sin esto, toda
    # instalación limpia recibe un cartel modal pidiendo el llavero del sistema en CADA
    # arranque de VS Code. El porqué del compromiso, en la cabecera del script.
    VSCODE_CONFIGURATOR="$GIGISHELL/bin/configurar-vscode.sh"
    if [ -x "$VSCODE_CONFIGURATOR" ]; then
    info "Fijando el almacén de secretos de VS Code ..."
    "$VSCODE_CONFIGURATOR" aplicar \
      || warn "No se pudo configurar password-store en ~/.vscode/argv.json. Vuelve a intentarlo con: $VSCODE_CONFIGURATOR aplicar"
    else
    warn "No encontré $VSCODE_CONFIGURATOR; VS Code pedirá el llavero del sistema en cada arranque."
    fi

  # --- 7. Generar el CSS que importa app.ts ---
    SCSS="$GIGISHELL/ags/estilos/style.scss"
    CSS="$GIGISHELL/ags/estilos/out.css"
    APP_ICONS="$GIGISHELL/ags/config/app_icons.json"

    [[ -f "$SCSS" ]] || die "Falta $SCSS. La copia de GiGiShell está incompleta; vuelve a ejecutar el instalador o comprueba la rama '$BRANCH'."
    if [[ ! -s "$APP_ICONS" ]]; then
    warn "Falta $APP_ICONS o está vacío; los workspaces usarán iconos gráficos."
    elif command -v jq >/dev/null 2>&1; then
    jq -e 'type == "object" and length > 0 and all(to_entries[]; (.key | type == "string") and (.value | type == "string"))' \
      "$APP_ICONS" >/dev/null \
      || warn "$APP_ICONS no contiene un mapa válido; los workspaces usarán iconos gráficos."
    fi
    # out.css es una caché sin versionar: la genera ags/scripts/compilar-css.sh (el mismo
    # que corre antes de cada `ags run`). Sin sass solo es fatal si no hay ninguno previo.
    info "Compilando el CSS de AGS ..."
    if ! "$GIGISHELL/ags/scripts/compilar-css.sh" --forzar; then
    [[ -s "$CSS" ]] || die "No se pudo generar $CSS (¿falta dart-sass o hay un error de Sass?)."
    warn "No se pudo recompilar el CSS; conservo el out.css anterior."
    fi

  # --- 8. Reconstruir las bases MIME y de aplicaciones de KDE/Dolphin ---
    if command -v update-mime-database >/dev/null; then
    info "Reconstruyendo la base MIME del usuario ..."
    # Sin `|| warn` esto abortaba el instalador con `set -e` cuando la base MIME del
    # usuario tenía un XML inválido: un tipo MIME roto tumbaba una instalación entera.
    update-mime-database "$HOME/.local/share/mime" \
      || warn "Falló update-mime-database; los tipos MIME propios pueden no reconocerse."
    else
    warn "No encontré update-mime-database; los tipos MIME propios no estarán disponibles."
    fi

    if command -v kbuildsycoca6 >/dev/null; then
    info "Reconstruyendo la caché de aplicaciones de KDE 6 ..."
    kbuildsycoca6 --noincremental \
      || warn "Falló kbuildsycoca6; el menú 'Abrir con...' puede quedar incompleto."
    elif command -v kbuildsycoca5 >/dev/null; then
    info "Reconstruyendo la caché de aplicaciones de KDE 5 ..."
    kbuildsycoca5 --noincremental \
      || warn "Falló kbuildsycoca5; el menú 'Abrir con...' puede quedar incompleto."
    else
    warn "No encontré kbuildsycoca6 ni kbuildsycoca5; el menú 'Abrir con...' podría quedar vacío."
    fi



  # --- 10. Perfil de GPU de esta máquina ---
    # Sin este fichero, gigishell/gpu.lua avisa EN PANTALLA EN CADA INICIO DE SESIÓN («sin
    # perfil de GPU: escribe uno en ~/.config/gigishell/gpu-perfil»). Era el único paso de
    # docs/SETUP.md que quedaba pendiente después del instalador, y como el escritorio
    # arranca igual, lo normal era no hacerlo nunca y convivir con el aviso.
    #
    # La elección NO se versiona (es estado local por máquina, igual que el perfil de
    # Kitty o el de Firefox; ver docs/anadir-perfiles-por-equipo.md), por eso se escribe
    # aquí y no en el repo.
    #
    # La detección (detectar_perfil_gpu) está definida arriba, junto a tiene_bateria:
    # el paso `paquetes` la necesita antes que este para decidir el driver VA-API.
    GPU_PERFIL="$HOME/.config/gigishell/gpu-perfil"
    if [[ -s "$GPU_PERFIL" ]]; then
    info "Perfil de GPU ya elegido ($(tr -d '[:space:]' < "$GPU_PERFIL")); no lo toco."
    elif perfil_gpu="$(detectar_perfil_gpu)"; then
    if mkdir -p "$(dirname "$GPU_PERFIL")" && printf '%s\n' "$perfil_gpu" > "$GPU_PERFIL"; then
      info "Perfil de GPU detectado y escrito en $GPU_PERFIL: $perfil_gpu"
    else
      warn "No pude escribir $GPU_PERFIL; Hyprland avisará al iniciar sesión. Escríbelo a mano: echo $perfil_gpu > $GPU_PERFIL"
    fi
    else
    warn "No pude identificar la GPU de esta máquina; elige el perfil a mano (ver docs/SETUP.md §9): echo <perfil> > $GPU_PERFIL"
    fi

  # --- 10. Mitad hyprcursor del tema de puntero ---
    # El compositor dibuja su cursor con hyprcursor; XWayland y los toolkits siguen
    # con XCursor. Un tema de paquete solo trae la mitad XCursor, y libhyprcursor
    # ante un nombre que no encuentra no falla: coge el primer tema con manifest.hl
    # que haya, por orden de lectura del directorio. Sin esto, el tema que elija el
    # usuario en Ajustes no tendría mitad hyprcursor y el compositor acabaría
    # dibujando OTRO tema. Esto le añade esa mitad a $CURSOR_THEME, dejando un único
    # nombre válido para las dos variables.
    #
    # NO se elige el tema aquí: eso es `temaCursor` en ~/.config/gigishell/devices.json,
    # que escribe el usuario desde Ajustes > Dispositivos > Puntero. Generar el tema
    # es preparar el terreno; cambiarle el puntero a alguien que no lo ha pedido, no.
    CURSOR_GEN="$GIGISHELL/bin/generar-hyprcursor.sh"
    CURSOR_AVISO_HECHO=0
    CURSOR_THEME="${CURSOR_THEME:-Bibata-Modern-Ice}"
    if [ -x "$CURSOR_GEN" ]; then
    # El tema por defecto viene de un paquete que puede no estar (ver el gate de
    # bibata-cursor-theme en el paso de paquetes: otra distro, sin chaotic-aur y sin
    # ayudante de AUR). Antes eso terminaba en "no pude generar el tema hyprcursor
    # 'Bibata-Modern-Ice'", un aviso que mandaba a elegir otro tema cuando el problema
    # era un paquete ausente. Si NADIE pidió ese tema explícitamente, se cae a uno que
    # sí esté instalado en vez de fallar: generar la mitad hyprcursor de otro tema no
    # le cambia el puntero a nadie —eso lo decide `temaCursor` en devices.json— así que
    # el peor caso de equivocarse es un directorio de más.
    if ! "$CURSOR_GEN" --ruta "$CURSOR_THEME" >/dev/null 2>&1; then
      if ((CURSOR_THEME_EXPLICITO)); then
        # Aviso ya dado y concreto: el `else` de más abajo no debe añadir encima un
        # "no hay ningún tema instalado" que además sería falso (los hay; el que falta
        # es el pedido).
        warn "El tema de puntero '$CURSOR_THEME' no está instalado; mira los disponibles con '$CURSOR_GEN --list'."
        CURSOR_THEME=""
        CURSOR_AVISO_HECHO=1
      else
        # Preferencias en orden, y como último recurso el primero que liste el propio
        # script: así una distro con otros nombres de tema tampoco se queda sin nada.
        CURSOR_ALTERNATIVA=""
        for CURSOR_CANDIDATO in breeze_cursors Adwaita \
          "$("$CURSOR_GEN" --list 2>/dev/null | awk 'NR>1 { print $1; exit }')"; do
          [ -n "$CURSOR_CANDIDATO" ] || continue
          "$CURSOR_GEN" --ruta "$CURSOR_CANDIDATO" >/dev/null 2>&1 || continue
          CURSOR_ALTERNATIVA="$CURSOR_CANDIDATO"
          break
        done
        if [ -n "$CURSOR_ALTERNATIVA" ]; then
          info "'$CURSOR_THEME' no está instalado; preparo '$CURSOR_ALTERNATIVA' en su lugar."
          CURSOR_THEME="$CURSOR_ALTERNATIVA"
        else
          CURSOR_THEME=""
        fi
      fi
    fi

    if [ -n "$CURSOR_THEME" ]; then
      info "Preparando el tema de puntero '$CURSOR_THEME' para hyprcursor ..."
      # No es fatal: sin esto el escritorio arranca igual, solo que con el puntero
      # de XCursor. Un tema que no esté instalado (otra distro, otro nombre) no debe
      # tumbar una instalación por lo demás correcta. El stderr del generador se mete
      # EN el aviso: antes se lo llevaba el scroll de la instalación y el resumen final
      # decía que algo falló sin decir por qué.
      ERROR_CURSOR="$("$CURSOR_GEN" "$CURSOR_THEME" 2>&1 >/dev/null)" \
        || warn "No se pudo generar el tema hyprcursor '$CURSOR_THEME': ${ERROR_CURSOR:-error del generador}. Elige otro con '$CURSOR_GEN --list' y vuelve a ejecutar el instalador."
    elif ((CURSOR_AVISO_HECHO == 0)); then
      warn "No hay ningún tema de puntero instalado al que añadirle la mitad hyprcursor; el compositor usará XCursor."
    fi
    fi

  # --- 11. Verificación y notas finales ---
  configure_default_shell

# La validación ya no aborta con `die`. Morir aquí imprimía "la instalación no está
# completa" y CORTABA antes de las notas finales, que es justo donde se explica qué hacer
# a continuación; y con `set -e` ni siquiera se veía el resumen de lo que sí se hizo. Se
# anota el resultado, se imprime todo, y el código de salida lo decide el resumen final.
# Recoger aquí lo que se lanzó en segundo plano, y no antes: es el último punto donde
# todavía se puede avisar de que algo no bajó, y para entonces ya se han solapado con
# todo lo demás. Va delante de la validación porque el preflight comprueba `pkgfile`.
esperar_descargas_de_fondo

preflight_fallo=0
if [ -x "$GIGISHELL/bin/preflight.sh" ]; then
  info "Validando la instalación ..."
  HOME="$HOME" GIGISHELL="$GIGISHELL" "$GIGISHELL/bin/preflight.sh" --installed \
    || preflight_fallo=1
else
  warn "No se encontró bin/preflight.sh; no puedo validar la instalación."
  preflight_fallo=1
fi
echo
if ((preflight_fallo)); then
  warn "La validación encontró errores; consulta el detalle anterior."
fi
# El resumen final informa del resultado de validación y del modo de instalación.
if ((preflight_fallo)); then
  info "Instalación finalizada con errores de validación."
elif [[ "$MODO_INSTALACION" == sin-paquetes ]]; then
  info "Instalación completa sin gestionar paquetes."
else
  info "Instalación base completa."
fi
echo "  • Rama:     $BRANCH"
if [[ -d "$BACKUP" ]] && [[ -n "$(find "$BACKUP" -mindepth 1 -print -quit 2>/dev/null)" ]]; then
  echo "  • Copias de seguridad: $BACKUP"
fi
cat <<'EOF'
  • Secretos: ~/.config/gigishell/spotify-creds.json y ~/.config/gigishell/google-calendar-creds.json
              NO están en el repositorio (excluidos de Git). Restaura tus copias o ejecuta
              ~/GiGiShell/ags/scripts/spotify-auth.sh y ~/GiGiShell/ags/scripts/google-calendar-auth.sh
EOF
if command -v zsh >/dev/null 2>&1 \
  && shell_de_login_es "$(id -un)" "$(command -v zsh)"; then
  cat <<'EOF'
  • Shell:    Zsh es el shell predeterminado.
EOF
fi
if [[ "$KITTY_PROFILE" == conservar ]]; then
  printf '  • Kitty:    se conserva el perfil que ya estaba activo.\n'
else
  printf '  • Kitty:    perfil seleccionado: %s. Cámbialo con ~/GiGiShell/bin/kitty-profile.sh <perfil>.\n' "$KITTY_PROFILE"
fi
if [[ "$FIREFOX_PROFILE" == conservar ]]; then
  printf '  • Firefox:  se conserva el perfil que ya estaba activo.\n'
else
  printf '  • Firefox:  perfil seleccionado: %s. Cámbialo con ~/GiGiShell/bin/firefox-profile.sh <perfil> y reinícialo.\n' "$FIREFOX_PROFILE"
fi
if [ -L /etc/systemd/system/display-manager.service ]; then
    gestor_actual="$(basename "$(readlink -f /etc/systemd/system/display-manager.service)")"
    if [[ "$gestor_actual" == sddm.service ]]; then
      printf '  • SDDM:     activado (display-manager.service -> %s)%s.\n' \
        "$gestor_actual" \
        "$( [[ -n "${SDDM_USUARIO:-}" ]] && printf ', inicio automático en Hyprland' || printf ', solicitará contraseña')"
    else
      printf '  • SDDM:     no activado; el gestor actual es %s y se ha conservado.\n' "$gestor_actual"
    fi
  else
    cat <<'EOF'
  • SDDM:     No se activó; el equipo arrancará en una consola. Actívalo con:
              sudo systemctl enable sddm.service
EOF
fi
cat <<'EOF'
  • Cambios:  el remoto está configurado con HTTPS; para subir cambios, cámbialo a SSH:
              dotfiles remote set-url origin git@github.com:mglourido/gigi-shell.git
EOF
GPU_PERFIL="${GPU_PERFIL:-$HOME/.config/gigishell/gpu-perfil}"
if [[ -s "$GPU_PERFIL" ]]; then
  printf '  • GPU:      perfil «%s» en %s (consulta docs/SETUP.md §9 para cambiarlo).\n' \
    "$(tr -d '[:space:]' < "$GPU_PERFIL")" "$GPU_PERFIL"
else
  cat <<'EOF'
  • GPU:      no se pudo elegir perfil. Escribe uno en ~/.config/gigishell/gpu-perfil o
              Hyprland avisará en cada inicio de sesión; consulta docs/SETUP.md §9.
EOF
fi
cat <<'EOF'
  • Puntero:  elige el tema en Ajustes > Dispositivos > Puntero. Sin elegirlo, el
              compositor usa el puntero de XCursor; para añadir soporte hyprcursor
              a otro tema, ~/GiGiShell/bin/generar-hyprcursor.sh --list.
EOF
if [[ "$GESTOS_ESTADO" == listo ]]; then
  cat <<'EOF'
  • Gestos:   SUPER+SHIFT+G activa el modo. Configúralo en Ajustes > Cámara > Gestos.
              Mientras esté activo, la cámara no estará disponible para videollamadas;
              el indicador rojo de la barra lo señala.
EOF
elif [[ "$GESTOS_ESTADO" == fallido ]]; then
  cat <<'EOF'
  • Gestos:   no se pudo completar la instalación del modo gestos por cámara. Revisa los avisos
              anteriores y vuelve a intentarlo con: bash ~/GiGiShell/install.sh
EOF
fi
case "$EVENTD_ESTADO" in
  listo) cat <<'EOF'
  • Seguridad: el monitor corre en Rust (gigishell-eventd). En una sesión ya abierta, vuelve
              a ejecutar ~/.config/hypr/scripts/oom-monitor.sh para que lo use.
EOF
  ;;
  sin-cargo|fallido) cat <<'EOF'
  • Seguridad: el monitor sigue en bash (no se compiló gigishell-eventd). Funciona igual;
              para pasarlo a Rust: bash ~/GiGiShell/install.sh
EOF
  ;;
esac
case "$CLAMAV_ESTADO" in
  descargada|al_dia)
    if [[ "$CLAMAV_ESTADO" == descargada ]]; then
      estado_firmas="descargadas"
    else
      estado_firmas="ya estaban al día"
    fi
    printf '  • Antivirus: firmas %s. Se revisan al iniciar sesión y se actualizan si tienen más de un día. Consulta la fecha o desactiva la actualización automática en Ajustes > Seguridad > Antivirus.\n' "$estado_firmas"
    ;;
  fallida)
    cat <<'EOF'
  • Antivirus: no se pudieron descargar las firmas de ClamAV. El escáner no podrá analizar
              archivos hasta que se actualicen. Puedes volver a intentarlo con:
              sudo /usr/local/bin/gigishell-clamav-update update
EOF
    ;;
  no_disponible)
    cat <<'EOF'
  • Antivirus: no se pudieron descargar las firmas de ClamAV porque falta ClamAV, sudo o el
              actualizador del sistema. Revisa los avisos anteriores y vuelve a ejecutar bash ~/GiGiShell/install.sh.
EOF
    ;;
esac
if [[ "$INSTALL_HIBERNATION" == 1 ]]; then
  if [[ -n "${HIBERNACION_LISTA:-}" ]]; then
    cat <<'EOF'
  • Hibernar: hace falta REINICIAR. resume= entra por la línea de comandos del kernel y la de
              la sesión actual ya está fijada, así que hasta el reinicio 'gigishell-hibernacion
              estado' seguirá diciendo disponible=no y la fila de Ajustes saldrá apagada. Tras
              reiniciar, el tiempo se pone en Ajustes > Pantalla > Suspensión.
EOF
  else
    cat <<'EOF'
  • Hibernar: la preparación NO terminó bien. Sin swapfile persistente y sin resume= el equipo
              no puede hibernar, y la fila de Ajustes se queda apagada con su motivo. Repítelo
              con: sudo bash ~/GiGiShell/system/hibernacion/gigishell-hibernacion-setup.sh
EOF
  fi
fi
cat <<'EOF'
  • Disco:    Ajustes > Almacenamiento muestra el uso y permite liberar espacio. La limpieza
              automática se configura allí y requiere activación explícita.
  • Sistema:  si necesitas sensores, ejecuta 'sudo sensors-detect'.
  • Sesión:   cierra la sesión y vuelve a entrar para aplicar los cambios y actualizar $SHELL;
              después comprueba con 'ags run ~/.config/ags/app.ts'.
EOF

resumen_degradado

# Código de salida: 1 solo si la validación falló. Los avisos por sí solos no son un
# fallo (falta un paquete opcional, no hay terminal para chsh), y devolver error por
# ellos haría que un `install.sh && algo` encadenado dejara de funcionar sin motivo.
if ((preflight_fallo)); then
  echo
  printf '\033[1;31mxx\033[0m %s\n' "Revisa los errores de la validación y repite el instalador cuando los hayas resuelto." >&2
  exit 1
fi
exit 0
