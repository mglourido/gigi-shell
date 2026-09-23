#!/usr/bin/env bash
# Instalador de dotfiles (repo bare) + GiGiShell para Arch Linux/CachyOS.
# Clona el repo, hace checkout en $HOME (respaldando lo que choque) y crea los
# symlinks de GiGiShell. Pensado para una máquina nueva o recuperación.
#
# Uso:
#   curl -sSL https://raw.githubusercontent.com/mglourido/gigi-shell/main/GiGiShell/install.sh | bash
#   bash install.sh --help                            # todas las opciones
#   curl -sSL <url> | DOTFILES_BRANCH=<rama> bash      # otra rama del repo (no per-equipo: eso va por *_PROFILE)
#   curl -sSL <url> | INSTALL_PACKAGES=0 bash         # sin instalar paquetes
#   curl -sSL <url> | KITTY_PROFILE=desktop bash      # forzar perfil de Kitty
#   curl -sSL <url> | FIREFOX_PROFILE=desktop bash    # forzar perfil de Firefox
#   curl -sSL <url> | SDDM_AUTOLOGIN=0 bash           # SDDM pide contraseña en vez de entrar solo
#
# Opciones equivalentes cuando se ejecuta el fichero (no por pipe):
#   --branch <rama>      --repo <url>       --no-packages
#   --kitty <perfil>     --firefox <perfil> --cursor <tema>
#   --yes                sin preguntas (pacman --noconfirm); para reinstalar sin vigilarlo
#
# ELEGIR QUÉ PASOS SE EJECUTAN (se pueden combinar todos los que quieras):
#   --sin  a,b,c   ejecuta todo MENOS esos pasos
#   --solo a,b,c   ejecuta SOLO esos pasos
#   --pasos        lista los nombres disponibles y sale
#
# Ambas admiten lista separada por comas y se pueden repetir:
#   bash install.sh --solo paquetes                  # solo dependencias, no toca nada más
#   bash install.sh --sin clamav-db                  # todo, pero sin bajar las firmas
#   bash install.sh --sin dolphin,kitty,firefox      # varios de una vez
#   bash install.sh --sin cursor --sin shell         # repetible, equivale a la lista
#
# Alias que se conservan por compatibilidad con lo que ya escribías:
#   --no-packages = --sin paquetes      --solo-paquetes  = --solo paquetes
#   --skip-clamav-db = --sin clamav-db
#
# Variables:
#   DOTFILES_REPO    URL del repo   (por defecto HTTPS público)
#   DOTFILES_BRANCH  rama a instalar (por defecto: main)
#   INSTALL_PACKAGES 1 instala las dependencias (por defecto); 0 las omite
#   KITTY_PROFILE    auto, laptop o desktop (por defecto: auto)
#   FIREFOX_PROFILE  auto, laptop o desktop (por defecto: auto)
#   CURSOR_THEME     tema de puntero al que añadir la mitad hyprcursor
#   SDDM_AUTOLOGIN   1 SDDM entra solo en Hyprland con tu usuario (por defecto); 0 muestra el saludador.
#                    Si NO se pasa y ya hay configuración nuestra, se respeta lo que
#                    diga (lo mismo que conmuta Ajustes > Cuenta > Inicio de sesión)
#   ASSUME_YES       1 equivale a --yes
#   SKIP_CLAMAV_DB   1 equivale a --skip-clamav-db
#   ONLY_PACKAGES    1 equivale a --solo-paquetes
#   INSTALL_STEPS    lista para --solo   (ej. INSTALL_STEPS=paquetes,css)
#   SKIP_STEPS       lista para --sin    (ej. SKIP_STEPS=clamav-db,cursor)
#
# VELOCIDAD: todas las dependencias van en UNA sola transacción (repos + AUR juntos si hay
# paru o yay), y las dos descargas largas que no bloquean a nadie —el índice de pkgfile y los
# ~200 MB de firmas de ClamAV— se lanzan en segundo plano y se recogen al final. Para una
# reinstalación desatendida, --yes: quita la confirmación de pacman y las preguntas de
# revisión de PKGBUILD del ayudante de AUR.
#
# REEJECUTARLO ES SEGURO Y ES EL MODO NORMAL DE ACTUALIZAR. Todos los pasos son
# idempotentes: lo ya instalado se detecta y se omite, y lo que no se puede completar
# degrada con aviso en vez de abortar. Solo son fatales los fallos que dejarían el
# escritorio sin arrancar (checkout, symlinks, CSS de AGS); el resto se acumula y se
# resume al final, para que una dependencia caída no te deje media instalación sin saber
# qué falta.
set -euo pipefail

REPO_URL="${DOTFILES_REPO:-https://github.com/mglourido/gigi-shell.git}"
BRANCH="${DOTFILES_BRANCH:-main}"
DOTGIT="$HOME/.dotfiles"
# Raíz de GiGiShell dentro del checkout: el repo bare se desprotege en $HOME y la carpeta
# cuelga de ahí. Un solo sitio, para que renombrarla no obligue a buscar cada ruta a mano.
GIGISHELL="$HOME/GiGiShell"
BACKUP="$HOME/.dotfiles-backup-$(date +%Y%m%d-%H%M%S)"
INSTALL_PACKAGES="${INSTALL_PACKAGES:-1}"
KITTY_PROFILE="${KITTY_PROFILE:-auto}"
FIREFOX_PROFILE="${FIREFOX_PROFILE:-auto}"
# Un tema PEDIDO (--cursor o CURSOR_THEME= en el entorno) que no esté instalado es un
# error que hay que decir; el tema por DEFECTO que no esté es sólo un paquete opcional
# ausente, y ahí el paso cae a otro tema en vez de fallar. Sin esta distinción las dos
# situaciones daban el mismo aviso, que era el que confundía. Se mira ANTES de aplicar
# el valor por defecto, que es lo que hace distinguibles los dos casos.
CURSOR_THEME_EXPLICITO=0
[ -n "${CURSOR_THEME:-}" ] && CURSOR_THEME_EXPLICITO=1
CURSOR_THEME="${CURSOR_THEME:-Bibata-Modern-Ice}"
ASSUME_YES="${ASSUME_YES:-0}"
SKIP_CLAMAV_DB="${SKIP_CLAMAV_DB:-0}"
ONLY_PACKAGES="${ONLY_PACKAGES:-0}"
# Se recuerda si la variable venía PUESTA antes de darle valor: sin eso no hay forma
# de distinguir «quiero autologin» de «no dije nada», y el paso `sddm` reescribiría en
# cada reinstalación una decisión que el usuario puede haber cambiado desde
# Ajustes > Cuenta > Inicio de sesión (que escribe la misma clave). Ver el paso `sddm`.
SDDM_AUTOLOGIN_EXPLICITO=0; [ -n "${SDDM_AUTOLOGIN+x}" ] && SDDM_AUTOLOGIN_EXPLICITO=1
SDDM_AUTOLOGIN="${SDDM_AUTOLOGIN:-1}"

# Catálogo de pasos seleccionables. El orden es el de ejecución, que es también el orden
# en que los lista `--pasos`. Añadir un paso nuevo es añadirlo aquí y envolver su bloque
# en `if paso_activo <nombre>`; no hay que tocar el parseo de opciones.
declare -A DESC_PASO=(
  [paquetes]="TODAS las dependencias (repos + AUR) en una sola tanda + servicios de red, BT y energía"
  [repo]="clonar/actualizar ~/.dotfiles y hacer el checkout en \$HOME"
  [symlinks]="enlazar las rutas XDG a ~/GiGiShell (bin/link.sh)"
  [dolphin]="perfil ligero de Dolphin (miniaturas y comportamiento)"
  [kitty]="perfil de rendimiento de Kitty"
  [firefox]="perfil de rendimiento de Firefox"
  [vscode]="almacén de secretos de VS Code (sin keyring en esta sesión)"
  [css]="compilar ags/estilos/out.css con sass"
  [mime]="bases MIME y caché de aplicaciones de KDE"
  [sistema]="ficheros de /etc: udev USB, i2c-dev, botón de encendido, helpers TLP/ClamAV/limpieza/cámara"
  [hibernacion]="habilitar la hibernación: swapfile persistente, resume= en el kernel y VRAM de NVIDIA"
  [sddm]="configurar SDDM y activarlo como gestor de sesión (display-manager.service)"
  [gpu]="elegir el perfil de GPU de esta máquina (~/.config/gigios/gpu-perfil)"
  [clamav-db]="descarga de la base de firmas de ClamAV (~200 MB)"
  [gestos]="entorno del modo gestos por cámara (venv con MediaPipe + modelo de manos, ~200 MB)"
  [cursor]="generar la mitad hyprcursor del tema de puntero"
  [shell]="poner Zsh como shell predeterminado"
  [preflight]="validación final de la instalación"
)
ORDEN_PASOS=(paquetes repo symlinks sistema hibernacion sddm clamav-db gestos dolphin kitty firefox vscode css mime gpu cursor shell preflight)

SOLO_PASOS=()
SIN_PASOS=()

listar_pasos() {
  printf 'Pasos que admiten --sin y --solo:\n\n'
  local paso
  for paso in "${ORDEN_PASOS[@]}"; do
    printf '  %-11s %s\n' "$paso" "${DESC_PASO[$paso]}"
  done
  printf '\nEjemplo: bash install.sh --sin clamav-db,cursor\n'
}

# Acepta "a,b,c" y también "a b c", y es acumulativa: --sin a --sin b == --sin a,b.
# Un nombre mal escrito es un error inmediato y no un paso que se salta en silencio: que
# `--sin walpapers` (con una ele) se ejecutara igual descargando los fondos sería
# exactamente el tipo de fallo mudo que no se quiere.
anadir_pasos() {
  local -n destino="$1"; shift
  local bruto="$1" paso
  for paso in ${bruto//,/ }; do
    [[ -n "${DESC_PASO[$paso]:-}" ]] \
      || die "Paso desconocido: '$paso'. Usá --pasos para ver la lista."
    destino+=("$paso")
  done
}

en_lista() {
  local aguja="$1"; shift
  local elemento
  for elemento in "$@"; do [[ "$elemento" == "$aguja" ]] && return 0; done
  return 1
}

# La regla: si hay --solo, manda --solo (y --sin puede recortarlo todavía más). Si no,
# se ejecuta todo salvo lo que diga --sin.
paso_activo() {
  local paso="$1"
  ((${#SIN_PASOS[@]})) && en_lista "$paso" "${SIN_PASOS[@]}" && return 1
  ((${#SOLO_PASOS[@]})) || return 0
  en_lista "$paso" "${SOLO_PASOS[@]}"
}

dotfiles() { git --git-dir="$DOTGIT" --work-tree="$HOME" "$@"; }
info() { printf '\033[1;36m::\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31mxx\033[0m %s\n' "$*" >&2; exit 1; }

# Todo aviso queda anotado, no solo impreso. En una instalación larga los avisos se
# pierden entre cientos de líneas de pacman, y el resultado es la peor variante posible:
# una instalación incompleta que parece correcta porque terminó con "completa". El
# resumen final los repite juntos y decide el código de salida.
DEGRADED=()
warn() {
  printf '\033[1;33m!!\033[0m %s\n' "$*"
  DEGRADED+=("$*")
}

# La ayuda es la cabecera del propio fichero, para que no pueda quedar desincronizada con
# lo que el script hace. Se corta en la primera línea que no sea comentario en vez de en
# un número de línea fijo: así añadir un párrafo arriba no parte la ayuda por la mitad.
usage() {
  local fuente="${BASH_SOURCE[0]:-}"
  if [[ -r "$fuente" ]]; then
    awk 'NR==1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "$fuente"
  else
    # Ejecutado por `curl | bash` no hay fichero que leer.
    printf 'install.sh — instalador de GiGiShell.\n'
    printf 'Opciones: --branch --repo --kitty --firefox --cursor --no-packages --yes --skip-clamav-db\n'
    printf 'Descarga el fichero y ejecuta "bash install.sh --help" para la ayuda completa.\n'
  fi
}

while (($#)); do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --branch)  BRANCH="${2:?--branch necesita una rama}"; shift 2 ;;
    --repo)    REPO_URL="${2:?--repo necesita una URL}"; shift 2 ;;
    --kitty)   KITTY_PROFILE="${2:?--kitty necesita un perfil}"; shift 2 ;;
    --firefox) FIREFOX_PROFILE="${2:?--firefox necesita un perfil}"; shift 2 ;;
    --cursor)  CURSOR_THEME="${2:?--cursor necesita un tema}"; CURSOR_THEME_EXPLICITO=1; shift 2 ;;
    --yes|-y)  ASSUME_YES=1; shift ;;
    --pasos|--steps) listar_pasos; exit 0 ;;
    --sin|--skip)  anadir_pasos SIN_PASOS "${2:?--sin necesita al menos un paso}"; shift 2 ;;
    --solo|--only) anadir_pasos SOLO_PASOS "${2:?--solo necesita al menos un paso}"; shift 2 ;;
    # Alias heredados. Se traducen al mecanismo nuevo en vez de mantener su propia
    # variable: así no hay dos fuentes de verdad sobre si un paso corre o no.
    --no-packages)    anadir_pasos SIN_PASOS paquetes; shift ;;
    --skip-clamav-db) anadir_pasos SIN_PASOS clamav-db; shift ;;
    --solo-paquetes|--only-packages) anadir_pasos SOLO_PASOS paquetes; shift ;;
    *) die "Opción desconocida: '$1'. Usa --help para ver lo disponible." ;;
  esac
done

# `curl | bash` no tiene stdin utilizable, así que cualquier orden interactiva (pacman
# preguntando por un proveedor, chsh pidiendo la contraseña) lee del pipe y se come el
# resto del script. Con --yes no hace falta terminal: nada pregunta.
INTERACTIVE=0
[[ -r /dev/tty ]] && INTERACTIVE=1

run_interactive() {
  if ((INTERACTIVE)); then
    "$@" </dev/tty
  else
    ((ASSUME_YES)) \
      || die "Esta operación necesita una terminal interactiva. Descarga install.sh y ejecútalo con bash, o pásale --yes."
    "$@" </dev/null
  fi
}

case "$INSTALL_PACKAGES" in
  0|1) ;;
  *) die "INSTALL_PACKAGES debe valer 0 (omitir paquetes) o 1 (instalarlos); recibido: '$INSTALL_PACKAGES'." ;;
esac
case "$ASSUME_YES" in 0|1) ;; *) die "ASSUME_YES debe valer 0 o 1; recibido: '$ASSUME_YES'." ;; esac
case "$SKIP_CLAMAV_DB" in 0|1) ;; *) die "SKIP_CLAMAV_DB debe valer 0 o 1; recibido: '$SKIP_CLAMAV_DB'." ;; esac
case "$ONLY_PACKAGES" in 0|1) ;; *) die "ONLY_PACKAGES debe valer 0 o 1; recibido: '$ONLY_PACKAGES'." ;; esac
case "$SDDM_AUTOLOGIN" in 0|1) ;; *) die "SDDM_AUTOLOGIN debe valer 1 (entrar solo) o 0 (pedir contraseña); recibido: '$SDDM_AUTOLOGIN'." ;; esac

# Las variables de entorno se traducen al selector, igual que los alias de línea de
# órdenes, para que exista una sola fuente de verdad sobre qué pasos corren.
((ONLY_PACKAGES)) && anadir_pasos SOLO_PASOS paquetes
((INSTALL_PACKAGES)) || anadir_pasos SIN_PASOS paquetes
((SKIP_CLAMAV_DB)) && anadir_pasos SIN_PASOS clamav-db
[[ -n "${INSTALL_STEPS:-}" ]] && anadir_pasos SOLO_PASOS "$INSTALL_STEPS"
[[ -n "${SKIP_STEPS:-}" ]] && anadir_pasos SIN_PASOS "$SKIP_STEPS"

# Un --solo cuyos pasos estén todos también en --sin no ejecutaría NADA y terminaría
# diciendo "instalación completa". Mejor decirlo antes de empezar.
if ((${#SOLO_PASOS[@]})); then
  hay_activo=0
  for paso_probe in "${ORDEN_PASOS[@]}"; do
    paso_activo "$paso_probe" && { hay_activo=1; break; }
  done
  ((hay_activo)) || die "La combinación de --solo y --sin no deja ningún paso por ejecutar."
fi
case "$KITTY_PROFILE" in
  auto|laptop|desktop) ;;
  *) die "KITTY_PROFILE debe ser auto, laptop o desktop; recibido: '$KITTY_PROFILE'." ;;
esac
case "$FIREFOX_PROFILE" in
  auto|laptop|desktop) ;;
  *) die "FIREFOX_PROFILE debe ser auto, laptop o desktop; recibido: '$FIREFOX_PROFILE'." ;;
esac
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

# Perfil de GPU de esta máquina, deducido del hardware. Vive aquí arriba y no dentro
# del paso `gpu` porque lo necesitan DOS pasos: `paquetes` (para saber si hay que
# instalar el driver VA-API de NVIDIA) y `gpu` (para escribir el perfil). Tenerlo dos
# veces era garantía de que un día dejaran de coincidir.
#
# Se lee /sys y no `lspci`: este paso puede correr con --sin paquetes, donde pciutils
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
    # Híbrida sólo en portátil: en un sobremesa con iGPU y NVIDIA la pantalla cuelga
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
  sudo -n true 2>/dev/null && return 0
  info "Se necesitan permisos de administrador para instalar paquetes y ficheros de /etc."
  run_interactive sudo -v || die "No pude obtener permisos de sudo."
  while true; do sudo -n true 2>/dev/null || break; sleep 50; done &
  SUDO_KEEPALIVE_PID=$!
}
limpiar_keepalive() {
  [[ -n "$SUDO_KEEPALIVE_PID" ]] && kill "$SUDO_KEEPALIVE_PID" 2>/dev/null
  return 0
}
trap limpiar_keepalive EXIT

# Descargas largas que NO bloquean a nadie: se lanzan en segundo plano en cuanto es
# posible y se recogen al final, justo antes de validar.
#
# Las dos son puro tráfico de red y ningún paso intermedio depende de ellas:
#   - pkgfile      lista de ficheros de los repos; sólo la usa `command-not-found`.
#   - firmas ClamAV ~200 MB; sólo las usa el escáner de descargas, ya en sesión.
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
    wait "$CLAMAV_PID" \
      || warn "No pude descargar las firmas de ClamAV; se reintentará solo al iniciar sesión."
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
# quien la llama es el paso `sistema` (TLP, ClamAV, limpieza), así que con `--sin mime`
# —o con cualquier `--solo` que no incluyera `mime`— la función NO llegaba a definirse y
# la primera llamada salía con 127 «orden no encontrada», que con `set -e` ABORTA el
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
  tmp="$(mktemp)" || { warn "No pude crear un fichero temporal para $destino; $aviso"; return 1; }
  if ! sed "s/__GIGIOS_USER__/$(id -un)/" "$plantilla" > "$tmp"; then
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
# coge la versión de repo cuando la hay y sólo compila lo que de verdad es AUR-only.
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
    # limpiar) que en `curl | bash` no puede contestar nadie. Solo con --yes: por
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
      info "Fuera de los repos (los busca $AYUDANTE_AUR en AUR): ${ausentes[*]}"
      disponibles+=("${ausentes[@]}")
    else
      warn "Los repos configurados no ofrecen: ${ausentes[*]} (¿renombrados? ¿falta un repo? ¿hace falta 'pacman -Sy'?)"
      warn "Sin paru ni yay no puedo buscarlos en AUR. Instala uno y repite el instalador."
    fi
  fi
  ((${#disponibles[@]})) || { warn "No hay ningún paquete instalable; omito este lote."; return 0; }

  if run_interactive "${gestor[@]}" "${flags[@]}" "${disponibles[@]}"; then
    return 0
  fi

  warn "La instalación en lote falló; reintento paquete a paquete para aislar el problema (esto tarda más)."
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
        die "Hay otro gestor de paquetes en marcha ($comando, PID $pid). Espera a que termine y repite el instalador."
        ;;
    esac
  done
  warn "Existe /var/lib/pacman/db.lck pero ningún gestor de paquetes lo usa (¿una actualización interrumpida?)."
  die "Borralo con 'sudo rm /var/lib/pacman/db.lck' y repetí el instalador."
}

install_packages() {
  local official=(
    git curl python xdg-utils shared-mime-info base-devel util-linux polkit
    less man-db wget tar hwinfo openbsd-netcat neovim
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
    # `sddm` lo configura y lo activa; aquí sólo se garantiza que el paquete exista.
    sddm
    # Los tres Qt que necesita el TEMA del saludador (system/sddm/tema/, ver su README):
    #   qt6-svg               los iconos de Assets/ son SVG; sin él los botones de
    #                         apagar/reiniciar/usuario salen en blanco.
    #   qt6-multimedia-ffmpeg el fondo es un .mp4; sin el backend de ffmpeg el vídeo no
    #                         arranca y se queda el PNG de reserva. No da ningún error:
    #                         parece que el tema simplemente no está animado.
    #   qt6-virtualkeyboard   el teclado en pantalla. Es el peligroso de los tres: el paso
    #                         `sddm` sólo escribe InputMethod=qtvirtualkeyboard si encuentra
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
    # xorg-xwayland: hypr/gigios/reglas.lua tiene reglas específicas para ventanas
    # XWayland (el arreglo de arrastres) y monitores.lua configura su escalado. Hyprland
    # solo lo recomienda, no lo requiere: sin él las apps X11 (Steam, juegos, instaladores)
    # no abren y el fallo aparece como "la app no arranca", no como una dependencia ausente.
    xorg-xwayland
    xdg-desktop-portal-hyprland xdg-desktop-portal-gtk qt6-wayland qt6ct
    gjs gtk4-layer-shell gobject-introspection npm dart-sass
    # noto-fonts (además del -emoji): qt6ct/qt6ct.conf fija "Noto Sans" y "Noto Sans Mono"
    # como fuentes general y monoespaciada de TODAS las apps Qt, y preflight.sh lo exige.
    # Solo estaba noto-fonts-emoji, que no trae ninguna de las dos: sin esto Qt cae a la
    # fuente sustituta que le toque y las ventanas salen con otra tipografía y otra métrica.
    ttf-meslo-nerd ttf-cascadia-code-nerd noto-fonts noto-fonts-emoji
    rofi rofimoji wtype cliphist wl-clipboard imagemagick brightnessctl ddcutil playerctl
    qalculate-gtk wf-recorder grim slurp jq bc hyprshot btop
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
    clamav firejail bubblewrap xxhash file cups geoclue gamemode
    mesa-utils lshw github-cli
  )

  command -v pacman >/dev/null || die "La instalación automática solo admite Arch/CachyOS (falta pacman). Usá INSTALL_PACKAGES=0 y seguí docs/SETUP.md."
  command -v sudo >/dev/null || die "Falta sudo. Instálalo y concede permisos al usuario antes de continuar."
  comprobar_pacman_libre
  sudo_prime

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
    die "No modifico esa pila automáticamente. Sigue la recuperación de docs/SETUP.md y repite el instalador."
  fi

  # CachyOS ofrece su perfil Pure de Fish y el actualizador de mirrors. En Arch
  # puro esos paquetes no existen, así que sólo se agregan cuando el repositorio
  # configurado los proporciona. VS Code se instala sólo si ningún paquete ya
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
    info "bibata-cursor-theme no está en los repos y no hay paru/yay: el paso del puntero usará otro tema instalado."
  fi
  command -v code >/dev/null 2>&1 || official+=(code)

  # TLP solo en portátiles. El paso 9 instala sus perfiles conmutables ÚNICAMENTE si
  # `tlp` ya existe, y nadie lo instalaba nunca: Ajustes > Energía se quedaba sin el
  # selector Normal/Ahorro en una máquina recién instalada, sin decir por qué. En un
  # sobremesa no se instala a propósito — TLP ahí no aporta y compite con
  # power-profiles-daemon si el usuario lo tiene.
  if tiene_bateria; then
    official+=(tlp tlp-rdw)
  else
    info "Sin batería del sistema: omito TLP (los perfiles de energía son cosa de portátil)."
  fi

  # Driver VA-API de NVIDIA, sólo si hay una NVIDIA. Los perfiles que el paso `gpu`
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
  if [[ -s "$HOME/.config/gigios/gpu-perfil" ]]; then
    perfil_gpu_efectivo="$(tr -d '[:space:]' < "$HOME/.config/gigios/gpu-perfil")"
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
  # MB) y no la necesita ningún paso posterior — sólo el `command-not-found` del shell,
  # que se usa después de instalar. Se espera al final (`esperar_descargas_de_fondo`),
  # justo antes de validar. Es tiempo que antes se sumaba y ahora se solapa.
  if command -v pkgfile >/dev/null 2>&1; then
    info "Actualizando el índice de pkgfile en segundo plano ..."
    sudo -n pkgfile --update >/dev/null 2>&1 &
    PKGFILE_PID=$!
  fi

  info "Instalando dependencias (${#official[@]} paquetes, una sola tanda${AYUDANTE_AUR:+ vía $AYUDANTE_AUR}) ..."
  paquetes_instalar "${official[@]}"

  if [[ -z "$AYUDANTE_AUR" ]] && ! command -v ags >/dev/null 2>&1; then
    warn "AGS/Astal no están y no encontré paru ni yay para buscarlos en AUR. Instalá uno y repetí el instalador; el resto de la instalación continúa."
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
  if tiene_bateria; then
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
    # con nombre propio porque `tuned-ppd` *provee* power-profiles-daemon: mirar sólo el
    # nombre de ppd no la ve.
    local conflicto
    for conflicto in power-profiles-daemon.service tuned.service auto-cpufreq.service; do
      systemctl is-enabled --quiet "$conflicto" 2>/dev/null ||
        systemctl is-active --quiet "$conflicto" 2>/dev/null || continue
      info "Desactivando $conflicto: entra en conflicto con TLP (lo usa Ajustes > Energía)."
      sudo systemctl disable --now "$conflicto" \
        || warn "No pude desactivar $conflicto; competirá con TLP. Hacelo con: sudo systemctl disable --now $conflicto"
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
# implementaciones sólo avisan—, así que fiarse del código de salida dejaba una
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

  if ((INTERACTIVE)); then
    info "Estableciendo Zsh como shell predeterminado de $current_user (shell actual: $current_shell) ..."
    run_interactive chsh -s "$zsh_path" || true
    if shell_de_login_es "$current_user" "$zsh_path"; then
      info "Zsh quedó como shell predeterminado de $current_user; surte efecto al volver a iniciar sesión."
      return
    fi
  fi
  warn "No pude cambiar el shell a Zsh (sigue en $current_shell). Ejecutalo vos: chsh -s '$zsh_path'"
}

# Resumen de lo que se va a hacer, antes de hacerlo. Con opciones combinadas es fácil
# equivocarse de lista; verlo escrito evita descubrir a posteriori que faltaba un paso.
pasos_previstos=()
pasos_omitidos=()
for paso_probe in "${ORDEN_PASOS[@]}"; do
  if paso_activo "$paso_probe"; then pasos_previstos+=("$paso_probe")
  else pasos_omitidos+=("$paso_probe"); fi
done
info "Pasos a ejecutar: ${pasos_previstos[*]:-ninguno}"
((${#pasos_omitidos[@]})) && info "Pasos omitidos:    ${pasos_omitidos[*]}"
echo

if paso_activo paquetes; then
  install_packages
else
  info "Omito las dependencias (no se instala ni se comprueba ningún paquete)."
fi

# Si no hay que tocar el repo no hace falta git, y exigirlo impediría un
# `--solo paquetes` en una máquina donde git todavía no está.
if paso_activo repo; then
  command -v git >/dev/null || die "git no está instalado."
fi

if paso_activo repo; then
  # --- 1. Clonar el repo bare (o reutilizar) ---
  if [ -d "$DOTGIT" ]; then
    # Existir no basta: un clon interrumpido (Ctrl+C, red caída) deja el directorio creado
    # pero sin repo dentro, y a partir de ahí TODAS las reejecuciones fallaban en el fetch
    # con "not a git repository" sin decir que la causa es un clon a medias.
    if git --git-dir="$DOTGIT" rev-parse --git-dir >/dev/null 2>&1; then
      info "Ya existe $DOTGIT; hago fetch en vez de clonar."
    else
      warn "$DOTGIT existe pero no es un repositorio git válido (clon interrumpido); lo aparto en $BACKUP."
      mkdir -p "$BACKUP"
      mv "$DOTGIT" "$BACKUP/dotfiles-roto"
    fi
  fi
  if [ ! -d "$DOTGIT" ]; then
    info "Clonando $REPO_URL (bare) en $DOTGIT ..."
    # Sin esto, un clon fallido deja el directorio a medias y la siguiente ejecución
    # tropieza con él en vez de reintentar limpio.
    git clone --bare "$REPO_URL" "$DOTGIT" || {
      rm -rf "$DOTGIT"
      die "No pude clonar $REPO_URL. Revisá la red y la URL, y repetí el instalador."
    }
  fi

  # refspec estándar para tener refs/remotes/origin/* y upstreams correctos
  dotfiles config remote.origin.fetch "+refs/heads/*:refs/remotes/origin/*"
  dotfiles config status.showUntrackedFiles no
  info "Fetch de origin ..."
  dotfiles fetch --prune origin || die "Falló el fetch de origin. Revisá la red y repetí el instalador."

  dotfiles rev-parse --verify --quiet "refs/remotes/origin/$BRANCH" >/dev/null \
    || die "La rama '$BRANCH' no existe en origin. Probá DOTFILES_BRANCH=<rama>."

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
      rescate="gigios-preinstall-$(date +%Y%m%d-%H%M%S)"
      dotfiles tag "$rescate" "$BRANCH" >/dev/null 2>&1 || true
      warn "La rama local '$BRANCH' tiene $commits_locales commit(s) que no están en origin."
      dotfiles log --oneline "origin/$BRANCH..$BRANCH" 2>/dev/null | sed 's/^/    /' >&2 || true
      warn "Los guardé en la etiqueta '$rescate'; recuperalos con: dotfiles log $rescate"
    fi
  fi

  # Los ficheros rastreados que hayas modificado a mano se van al backup unos párrafos más
  # abajo. Enumerarlos ANTES es la diferencia entre "el instalador se llevó mis cambios" y
  # saber exactamente cuáles y dónde están.
  # Solo cuentan los que EXISTEN en $HOME: en una máquina nueva el diff da todo el árbol como
  # borrado y el aviso listaba cientos de ficheros que no se iban a respaldar porque no hay nada.
  modificados="$(dotfiles diff --name-only "origin/$BRANCH" -- 2>/dev/null \
    | while IFS= read -r f; do [ -e "$HOME/$f" ] && printf '%s\n' "$f"; done || true)"
  if [[ -n "$modificados" ]]; then
    warn "Estos ficheros rastreados difieren de origin/$BRANCH y se respaldarán en $BACKUP:"
    printf '%s\n' "$modificados" | sed 's/^/    /' >&2
  fi

  info "Actualizando el checkout a origin/$BRANCH ..."
  # LC_ALL=C: el bloque de abajo identifica los ficheros en conflicto por la sangría de la
  # lista que imprime git. Con la máquina en español git traduce el mensaje, y aunque hoy la
  # sangría coincida, depender del idioma del sistema para decidir QUÉ FICHEROS SE MUEVEN es
  # exactamente el fallo mudo que no se quiere: fijar el locale lo hace determinista.
  if ! LC_ALL=C dotfiles checkout -B "$BRANCH" "origin/$BRANCH" 2>/dev/null; then
    warn "Hay archivos existentes que chocan; los respaldo en $BACKUP"
    checkout_error="$(LC_ALL=C dotfiles checkout -B "$BRANCH" "origin/$BRANCH" 2>&1 || true)"
    respaldados=0
    while IFS= read -r f; do
      [ -e "$HOME/$f" ] || continue
      mkdir -p "$BACKUP/$(dirname "$f")"
      mv "$HOME/$f" "$BACKUP/$f"
      echo "  backup: $f"
      respaldados=$((respaldados + 1))
    done < <(
      printf '%s\n' "$checkout_error" \
        | grep -E '^[[:space:]]+[^[:space:]]' \
        | sed 's/^[[:space:]]*//'
    )
    # Si el parseo no encontró NINGÚN fichero que mover, reintentar es inútil: se volvería a
    # fallar igual y el mensaje ("revisá $BACKUP") apuntaría a un directorio vacío. Mejor
    # enseñar lo que dijo git, que es lo único que explica el fallo real.
    if ((respaldados == 0)); then
      printf '%s\n' "$checkout_error" >&2
      die "El checkout falló y no pude identificar qué ficheros lo impiden (mensaje de git arriba)."
    fi
    LC_ALL=C dotfiles checkout -B "$BRANCH" "origin/$BRANCH" \
      || die "El checkout siguió fallando; revisá $BACKUP."
  fi
  dotfiles branch --set-upstream-to="origin/$BRANCH" "$BRANCH" >/dev/null 2>&1 || true
  info "Dotfiles en su lugar (rama $BRANCH)."
else
  info "Omito el repo: no toco ~/.dotfiles ni el checkout de \$HOME."
fi

if paso_activo symlinks; then
  # --- 3. Symlinks de GiGiShell (respaldando lo que estorbe) ---
  LINK="$GIGISHELL/bin/link.sh"
  if [ -x "$LINK" ]; then
    info "Creando symlinks de GiGiShell ..."
    LINK_BACKUP="$BACKUP" bash "$LINK" --force || die "No se pudieron crear todos los enlaces. Revisa los mensajes anteriores."
  else
    die "No encontré $LINK. El checkout no contiene GiGiShell/bin/link.sh."
  fi
else
  info "Omito los symlinks: las rutas XDG se quedan como estén."
fi

if paso_activo sistema; then
  # --- 4. Ficheros de sistema (/etc) ---
  # ADELANTADO a propósito, justo detrás de los symlinks: es aquí donde arranca la
  # descarga de firmas de ClamAV (~200 MB, en segundo plano), y cuanto antes empiece
  # más se solapa con lo que queda (perfiles, CSS, bases MIME, puntero, validación).
  # Sólo depende del checkout ($HOME/GiGiShell/system) y de sudo, de nada posterior.
  # NO se symlinkean, se copian: udev y systemd leen /etc antes de que $HOME esté montado, y
  # apuntar /etc a un directorio escribible por el usuario sería una escalada silenciosa.
  # Sin este paso la instalación arranca igual, pero con dos fallos mudos:
  #   • sin la regla udev, una copia a un USB "termina" con cientos de MB aún en RAM y retirar
  #     el pendrive pierde los datos de verdad (ver CLAUDE.md, sección USB);
  #   • sin i2c-dev no existen los nodos /dev/i2c-*, así que ddcutil no ve el monitor y el
  #     slider de brillo desaparece en un sobremesa (en un portátil da igual: usa sysfs).
  SYSTEM_DIR="$GIGISHELL/system"
  if [ -d "$SYSTEM_DIR" ] && command -v sudo >/dev/null; then
    info "Instalando los ficheros de sistema en /etc (pide sudo) ..."
    # Con INSTALL_PACKAGES=0 no se pasó por install_packages, así que sudo no está
    # precalentado y el primer `sudo install` abriría un prompt de contraseña en mitad del
    # paso. Es idempotente: si ya hay credencial válida, no hace nada.
    sudo_prime
    if sudo install -Dm644 "$SYSTEM_DIR/udev/99-gigios-usb-writeback.rules" \
         /etc/udev/rules.d/99-gigios-usb-writeback.rules; then
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
    if sudo install -Dm644 "$SYSTEM_DIR/logind.conf.d/99-gigios-powerkey.conf" \
         /etc/systemd/logind.conf.d/99-gigios-powerkey.conf; then
      # `reload` y no `restart`: reiniciar logind puede llevarse la sesión por delante.
      sudo systemctl reload systemd-logind \
        || warn "No pude recargar systemd-logind; el botón de encendido usará la acción de logind hasta reiniciar."
    else
      warn "No pude ceder el botón de encendido a Hyprland; seguirá apagando el equipo (ver CLAUDE.md, sección del botón de encendido)."
    fi
    # TLP: perfiles conmutables Normal/Ahorro. Solo si TLP está instalado (en un
    # equipo sin TLP la función queda oculta en Ajustes > Energía). Todo lo que toca
    # root es root-owned: helper en /usr/local/bin, perfiles en /etc/gigios/tlp, y la
    # regla sudoers acotada al comando exacto. NO se toca /etc/tlp.conf aquí: eso lo
    # hace el helper cuando el usuario elige un perfil.
    if command -v tlp >/dev/null 2>&1; then
      sudo install -Dm755 "$SYSTEM_DIR/tlp/gigios-tlp-apply.sh" /usr/local/bin/gigios-tlp-apply \
        && sudo install -Dm644 "$SYSTEM_DIR/tlp/normal.conf" /etc/gigios/tlp/normal.conf \
        && sudo install -Dm644 "$SYSTEM_DIR/tlp/ahorro.conf" /etc/gigios/tlp/ahorro.conf \
        || warn "No pude instalar los perfiles TLP de GiGiShell."
      instalar_sudoers "$SYSTEM_DIR/tlp/sudoers-gigios-tlp" /etc/sudoers.d/gigios-tlp \
        "el cambio de perfil de energía pedirá contraseña."
    else
      info "TLP no está instalado; omito los perfiles conmutables de energía (se activarán al instalar 'tlp')."
    fi
    # Cámara: interruptor "Cámara bloqueada" de QuickSettings y de Ajustes > Cámara. Mismo
    # esquema que TLP y ClamAV (helper root-owned + regla sudoers acotada a los verbos exactos)
    # porque los nodos /dev/video* son de root:video y quien decide sus permisos es udev. Sin
    # esto el interruptor no se pinta; el resto de la sección de cámara (controles, vista previa,
    # detector de uso) funciona igual, que por eso no va condicionado a ningún paquete.
    sudo install -Dm755 "$SYSTEM_DIR/camara/gigios-camara.sh" /usr/local/bin/gigios-camara \
      || warn "No pude instalar el helper de cámara; el interruptor de bloqueo no aparecerá."
    instalar_sudoers "$SYSTEM_DIR/camara/sudoers-gigios-camara" /etc/sudoers.d/gigios-camara \
      "bloquear la cámara pedirá contraseña."
    # ClamAV: botón "Actualizar firmas" de Ajustes > Seguridad > Antivirus. Mismo esquema que TLP
    # (helper root-owned + regla sudoers acotada al comando exacto) porque /var/lib/clamav es de
    # `clamav` y habilitar el servicio de actualización es de root. Sin esto el botón no se pinta;
    # la actualización sigue pudiendo hacerse a mano con `sudo freshclam`.
    if command -v freshclam >/dev/null 2>&1; then
      sudo install -Dm755 "$SYSTEM_DIR/clamav/gigios-clamav-update.sh" /usr/local/bin/gigios-clamav-update \
        || warn "No pude instalar el helper de ClamAV; el botón de firmas no aparecerá en Ajustes."
      instalar_sudoers "$SYSTEM_DIR/clamav/sudoers-gigios-clamav" /etc/sudoers.d/gigios-clamav \
        "actualizar las firmas pedirá contraseña."
      # Sin firmas el escáner de descargas no puede analizar NADA, así que se descargan aquí, una
      # vez, de forma síncrona (tarda unos minutos y baja ~200 MB).
      #
      # Y NO se habilita `clamav-freshclam.service`, que es lo que hacía antes: mantenerlas al día
      # es hoy un booleano de GiGiShell (`clamavAutoUpdate` en security.json, activado por defecto) que
      # dispara `hypr/scripts/actualizar-firmas.sh --auto` UNA vez al iniciar sesión, y solo si la
      # base falta o pasa de un día. Durante la sesión no queda ningún temporizador de ClamAV. Dejar
      # el servicio encendido reintroduciría justo eso, y encima sin interruptor a la vista (el shell
      # lo apaga solo si se lo encuentra vivo; ver servicios/seguridad/clamav.ts).
      #
      # Y NO se vuelven a descargar en cada reejecución del instalador. Antes se bajaban
      # siempre: reinstalar o actualizar los dotfiles costaba varios minutos y ~200 MB de
      # descarga para acabar con la misma base que ya estaba en disco. Se mira si la base
      # existe y tiene menos de un día — exactamente el mismo criterio que usa
      # actualizar-firmas.sh --auto al iniciar sesión — y si es así se omite.
      if ! paso_activo clamav-db; then
        info "Omito la descarga de firmas de ClamAV; se hará sola al iniciar sesión."
      elif compgen -G '/var/lib/clamav/daily.c?d' >/dev/null &&
        [[ -n "$(find /var/lib/clamav -maxdepth 1 -name 'daily.c?d' -mtime -1 -print -quit 2>/dev/null)" ]]; then
        info "Las firmas de ClamAV ya están al día; no las descargo."
      else
        # En SEGUNDO PLANO: son ~200 MB y nada de lo que viene después los necesita.
        # Se recogen en `esperar_descargas_de_fondo`, antes de la validación final.
        # `sudo -n` y no `sudo`: un proceso de fondo que se pare a pedir contraseña se
        # queda colgado sin que se vea el prompt. La credencial ya está caliente
        # (sudo_prime + keepalive); si no lo estuviera, falla rápido y se avisa.
        info "Descargando la base de firmas de ClamAV en segundo plano (~200 MB) ..."
        sudo -n /usr/local/bin/gigios-clamav-update update >/dev/null 2>&1 &
        CLAMAV_PID=$!
      fi
    else
      info "ClamAV no está instalado; omito el helper de firmas (se activará al instalar 'clamav')."
    fi
    # Limpieza de disco: Ajustes > Almacenamiento > Liberar espacio. Tercer helper con el mismo
    # esquema (root-owned + sudoers acotado), y aquí el NOPASSWD es lo que hace posible la
    # AUTOLIMPIEZA desatendida: un diálogo de contraseña que aparece solo, de madrugada, no lo lee
    # nadie. Por eso el helper solo expone verbos cuyo efecto se regenera (caché de pacman, journal,
    # /var/tmp, huérfanos); vaciar la caché entera y borrar instantáneas siguen pidiendo contraseña
    # por pkexec desde su botón. Sin esto, esas limpiezas salen como "falta el ayudante" en la UI y
    # el resto (todo lo que vive bajo $HOME) sigue funcionando.
    sudo install -Dm755 "$SYSTEM_DIR/limpieza/gigios-limpieza.sh" /usr/local/bin/gigios-limpieza \
      || warn "No pude instalar el helper de limpieza; las limpiezas de sistema pedirán instalarlo."
    instalar_sudoers "$SYSTEM_DIR/limpieza/sudoers-gigios-limpieza" /etc/sudoers.d/gigios-limpieza \
      "la autolimpieza quedará limitada a tu carpeta personal (sin caché de pacman ni journal)."
  else
    warn "Omito los ficheros de /etc (falta sudo o $SYSTEM_DIR). Brillo DDC/CI y escrituras a USB quedan sin configurar."
  fi
else
  info "Omito los ficheros de /etc (udev USB, i2c-dev, botón de encendido, helpers)."
fi

if paso_activo hibernacion; then
  # --- Hibernación ---
  #
  # Va APARTE del paso `sistema` aunque instale ficheros en /etc, y es a propósito: este paso
  # CREA UN FICHERO DE VARIOS GiB en el disco y REESCRIBE LA LÍNEA DE COMANDOS DEL KERNEL. Eso
  # no se cuela dentro de un paso que la gente lanza a la ligera; tiene que poder omitirse con
  # `--sin hibernacion` y lanzarse solo con `--solo hibernacion`.
  #
  # Sin este paso, el tiempo de hibernación de Ajustes > Pantalla > Suspensión sale apagado con
  # su motivo ("sin swap o sin resume"), que es la degradación que se busca: visible, no muda.
  SYSTEM_DIR="$GIGISHELL/system"
  if [ -d "$SYSTEM_DIR/hibernacion" ] && command -v sudo >/dev/null; then
    sudo_prime
    # El helper de runtime y su regla sudoers se instalan SIEMPRE que se pida el paso, incluso
    # si la preparación del swap fallara: el retardo es un ajuste, y que el usuario pueda fijarlo
    # antes de que la máquina sepa hibernar no rompe nada (systemd lee HibernateDelaySec cuando
    # le toca). Al revés sí duele: swap listo y helper ausente = ajuste que no se puede tocar.
    sudo install -Dm755 "$SYSTEM_DIR/hibernacion/gigios-hibernacion.sh" /usr/local/bin/gigios-hibernacion \
      || warn "No pude instalar el helper de hibernación; el tiempo de hibernación no se podrá cambiar desde Ajustes."
    instalar_sudoers "$SYSTEM_DIR/hibernacion/sudoers-gigios-hibernacion" /etc/sudoers.d/gigios-hibernacion \
      "cambiar el tiempo de hibernación pedirá contraseña en cada pulsación (y el ajuste quedará inservible)."
    info "Preparando la hibernación (swapfile + resume= + NVIDIA). Esto tarda un rato ..."
    if sudo bash "$SYSTEM_DIR/hibernacion/gigios-hibernacion-setup.sh"; then
      HIBERNACION_LISTA=1
    else
      warn "No pude preparar la hibernación. El resto de la instalación sigue; revisa la salida de arriba."
    fi
  else
    warn "Omito la hibernación (falta sudo o $SYSTEM_DIR/hibernacion)."
  fi
else
  info "Omito la hibernación (swapfile, resume= y VRAM de NVIDIA)."
fi

if paso_activo sddm; then
  # --- SDDM: configuración + activación como gestor de sesión ---
  #
  # Son DOS cosas distintas y cada una falla en silencio por su lado:
  #
  #   • La configuración (/etc/sddm.conf.d/zz-gigios.conf): autologin en Hyprland,
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
  # materializa desde la plantilla system/sddm/zz-gigios.conf.in sustituyendo los campos
  # que son de cada máquina (usuario, sesión, tema, método de entrada).
  #
  # EL NOMBRE ES "zz-" A PROPÓSITO, no es un capricho: conf.d se lee en orden alfabético
  # y gana el último, y los dígitos van ANTES que las letras. El nombre anterior
  # (99-gigios.conf) quedaba por delante de los restos de HyDE (the_hyde_project.conf) y
  # los dejaba a ELLOS mandando, en silencio. Ver la cabecera de la plantilla.
  SDDM_PLANTILLA="$GIGISHELL/system/sddm/zz-gigios.conf.in"
  SDDM_DESTINO=/etc/sddm.conf.d/zz-gigios.conf
  # Restos de instalaciones anteriores de GiGiShell con el nombre malo. No se deja: dos
  # ficheros nuestros con valores distintos es exactamente el enredo que cuesta una tarde.
  SDDM_DESTINO_VIEJO=/etc/sddm.conf.d/99-gigios.conf

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
    warn "Omito SDDM (falta sudo). El equipo puede arrancar en un TTY sin gestor de sesión."
  elif [ ! -r "$SDDM_PLANTILLA" ]; then
    warn "Falta $SDDM_PLANTILLA; no configuro SDDM."
  elif ! pacman -Qq sddm >/dev/null 2>&1 && ! command -v sddm >/dev/null 2>&1; then
    warn "SDDM no está instalado; no lo configuro ni lo activo (sudo pacman -S --needed sddm && bash install.sh --solo sddm)."
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
    # /usr/share/sddm/themes/gigios y no se symlinkea a ~/GiGiShell por la misma razón que
    # la configuración: el greeter corre como el usuario `sddm`, antes de que exista
    # ninguna sesión, y /home puede ni estar montado todavía (LUKS, disco aparte). Un
    # tema ilegible no da error — SDDM cae a su aspecto de fábrica y ya.
    SDDM_TEMA_ORIGEN="$GIGISHELL/system/sddm/tema"
    SDDM_TEMA_DESTINO=/usr/share/sddm/themes/gigios
    if [ -r "$SDDM_TEMA_ORIGEN/metadata.desktop" ]; then
      info "Instalando el tema del saludador en $SDDM_TEMA_DESTINO ..."
      # --delete: si una actualización quita un fichero del tema, el de la copia vieja
      # no puede quedarse (un Themes/*.conf huérfano confundiría al siguiente que mire).
      # rsync no está garantizado en un Arch pelado, así que el camino sin él es borrar
      # y copiar, que para 2,5 MB da igual.
      if command -v rsync >/dev/null 2>&1; then
        sudo rsync -a --delete "$SDDM_TEMA_ORIGEN/" "$SDDM_TEMA_DESTINO/" \
          || warn "No pude copiar el tema del saludador; SDDM se queda con el que hubiera."
      else
        sudo rm -rf "$SDDM_TEMA_DESTINO" \
          && sudo mkdir -p "$SDDM_TEMA_DESTINO" \
          && sudo cp -a "$SDDM_TEMA_ORIGEN/." "$SDDM_TEMA_DESTINO/" \
          || warn "No pude copiar el tema del saludador; SDDM se queda con el que hubiera."
      fi
      # Legible por el usuario `sddm`, que no es root: la copia hereda los permisos del
      # checkout y un umask restrictivo del usuario dejaría el tema sin leer.
      sudo chmod -R a+rX "$SDDM_TEMA_DESTINO" 2>/dev/null || true

      # La FUENTE va aparte, a /usr/share/fonts. El tema NO usa FontLoader: pide
      # Font="Thunderman" por nombre y quien la resuelve es fontconfig. Si no está
      # instalada en el sistema, Qt sustituye por la fuente por defecto y el saludador se
      # ve distinto SIN dar ningún error — el fallo aparece como "el tema no quedó igual".
      if [ -d "$SDDM_TEMA_ORIGEN/Fonts" ]; then
        if sudo install -d -m755 /usr/share/fonts/gigios \
           && sudo install -m644 "$SDDM_TEMA_ORIGEN"/Fonts/* /usr/share/fonts/gigios/; then
          # fc-cache actualiza el índice de fontconfig. Sin él la fuente está en disco
          # pero fc-match no la encuentra hasta el siguiente arranque.
          # El `|| true` NO es decorativo: con `set -e` esta línea es la última del
          # bloque, y sin fontconfig instalado (INSTALL_PACKAGES=0) el `command -v` falso
          # abortaría el instalador entero por no poder refrescar una caché de fuentes.
          { command -v fc-cache >/dev/null 2>&1 && sudo fc-cache -f >/dev/null 2>&1; } || true
        else
          warn "No pude instalar las fuentes del tema en /usr/share/fonts/gigios; el saludador usará otra tipografía."
        fi
      fi
    else
      warn "No encontré $SDDM_TEMA_ORIGEN; no instalo el tema del saludador."
    fi

    # Sólo se fija si el directorio existe DE VERDAD tras el intento anterior. GiGiShell trae
    # su propio tema, así que no hay que caer a ninguno ajeno: aquí se listaban también
    # «Candy» y «sugar-candy», restos del instalador de HyDE que no pertenecen a ningún
    # paquete (`pacman -Qo` no los reconoce). Preferirlos era heredar el aspecto de otro
    # escritorio en cuanto el nuestro fallara al copiarse — mejor caer al tema empotrado
    # de SDDM, que al menos se ve como lo que es. Un Current= apuntando a un tema ausente
    # no da error: SDDM cae a ese tema empotrado y el aspecto cambia sin más.
    SDDM_TEMA=""
    if [ -d "$SDDM_TEMA_DESTINO" ]; then
      SDDM_TEMA=gigios
    else
      info "El tema de GiGiShell no está en $SDDM_TEMA_DESTINO; el saludador usará el aspecto de fábrica."
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
      || info "qt6-virtualkeyboard no está; el saludador irá sin teclado en pantalla."

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
    if ((!SDDM_AUTOLOGIN_EXPLICITO)) && [ -r "$SDDM_DESTINO" ]; then
      if [ -n "$(sddm_valor "$SDDM_DESTINO" User)" ]; then _sddm_quiere_autologin=1; else _sddm_quiere_autologin=0; fi
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
      if sed -e "s/__GIGIOS_USER__/$SDDM_USUARIO/" \
             -e "s/__GIGIOS_SESSION__/$SDDM_SESION/" \
             -e "s/__GIGIOS_INPUTMETHOD__/$SDDM_INPUTMETHOD/" \
             -e "s/__GIGIOS_THEME__/$SDDM_TEMA/" \
             "$SDDM_PLANTILLA" > "$_sddm_tmp" \
         && sudo install -Dm644 "$_sddm_tmp" "$SDDM_DESTINO"; then
        info "Escrito $SDDM_DESTINO (autologin: ${SDDM_USUARIO:-no}, tema: ${SDDM_TEMA:-por defecto})."
        # Sólo se borra el viejo DESPUÉS de que el nuevo esté en su sitio.
        if [ -e "$SDDM_DESTINO_VIEJO" ]; then
          sudo rm -f "$SDDM_DESTINO_VIEJO" \
            && info "Retirado $SDDM_DESTINO_VIEJO (nombre antiguo, lo pisaba the_hyde_project.conf)."
        fi
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
            warn "/etc/sddm.conf fija $_clave=$_suyo y tiene MÁS precedencia que $SDDM_DESTINO (donde vale '${_nuestro:-vacío}'): manda el suyo. Revisalo o quitá esa línea."
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
      warn "El gestor de sesión activo es $(basename "$_dm"), no SDDM; no lo cambio. Si querés SDDM: sudo systemctl enable -f sddm.service"
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
        warn "SDDM no quedó activado: no existe /etc/systemd/system/display-manager.service. Sin él el equipo arranca en un TTY, sin escritorio y sin error. Activalo con: sudo systemctl enable sddm.service"
      fi
    fi
  fi
else
  info "Omito SDDM: ni la configuración del saludador ni su activación como gestor de sesión."
fi

if paso_activo gestos; then
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
  # rehacerlo: `bash install.sh --solo gestos`. Por eso el paso BORRA un venv roto en vez
  # de intentar repararlo.
  GESTOS_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/gigios/gestos"
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
      "$GESTOS_VENV/bin/pip" install --quiet --upgrade pip >/dev/null 2>&1
      if ! "$GESTOS_VENV/bin/pip" install --quiet mediapipe; then
        warn "No pude instalar MediaPipe. El modo gestos (SUPER+SHIFT+G) no funcionará; reintenta: bash install.sh --solo gestos"
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
      warn "No pude descargar el modelo de manos. El modo gestos (SUPER+SHIFT+G) no funcionará; reintenta: bash install.sh --solo gestos"
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
      info "Modo gestos listo: SUPER+SHIFT+G lo enciende y lo apaga."
    else
      warn "El entorno de gestos se instaló pero no importa (mediapipe/cv2). El modo no funcionará."
    fi
  fi
else
  info "Omito el entorno del modo gestos (SUPER+SHIFT+G no funcionará hasta instalarlo con --solo gestos)."
fi

if paso_activo dolphin; then
  # --- 4. Aplicar el perfil ligero de Dolphin ---
  DOLPHIN_CONFIGURATOR="$GIGISHELL/bin/configurar-dolphin.sh"
  # No es fatal: el perfil de Dolphin son miniaturas y comportamiento del gestor de
  # archivos. Necesita kwriteconfig6, así que con INSTALL_PACKAGES=0 o con kconfig sin
  # instalar fallaba y se llevaba por delante la instalación entera por un ajuste estético.
  if [ -x "$DOLPHIN_CONFIGURATOR" ]; then
    info "Configurando miniaturas y comportamiento de Dolphin ..."
    "$DOLPHIN_CONFIGURATOR" aplicar \
      || warn "No se pudo aplicar el perfil de Dolphin (¿falta kconfig?). Reintentá: $DOLPHIN_CONFIGURATOR aplicar"
  else
    warn "No encontré $DOLPHIN_CONFIGURATOR; Dolphin se queda con sus ajustes de fábrica."
  fi
else
  info "Omito el perfil de Dolphin."
fi

if paso_activo kitty; then
  # --- 5. Seleccionar el perfil de rendimiento de Kitty ---
  KITTY_SELECTOR="$GIGISHELL/bin/kitty-profile.sh"
  if [ -x "$KITTY_SELECTOR" ]; then
    info "Seleccionando el perfil de Kitty ($KITTY_PROFILE) ..."
    "$KITTY_SELECTOR" "$KITTY_PROFILE" \
      || warn "No se pudo activar el perfil de Kitty '$KITTY_PROFILE'. Reintentá: $KITTY_SELECTOR $KITTY_PROFILE"
  else
    warn "No encontré $KITTY_SELECTOR; Kitty arrancará sin perfil de rendimiento."
  fi
else
  info "Omito el perfil de Kitty."
fi

if paso_activo firefox; then
  # --- 6. Seleccionar y aplicar el perfil de rendimiento de Firefox ---
  FIREFOX_SELECTOR="$GIGISHELL/bin/firefox-profile.sh"
  if [ -x "$FIREFOX_SELECTOR" ]; then
    info "Seleccionando el perfil de Firefox ($FIREFOX_PROFILE) ..."
    "$FIREFOX_SELECTOR" "$FIREFOX_PROFILE" \
      || warn "No se pudo activar el perfil de Firefox '$FIREFOX_PROFILE'. Reintentá: $FIREFOX_SELECTOR $FIREFOX_PROFILE"
  else
    warn "No encontré $FIREFOX_SELECTOR; Firefox arrancará sin perfil de rendimiento."
  fi
else
  info "Omito el perfil de Firefox."
fi

if paso_activo vscode; then
  # --- 6b. Fijar el almacén de secretos de VS Code ---
  # VS Code lo instala el paso `paquetes` (official+=(code)), pero NADIE en esta sesión
  # ofrece el Secret Service `org.freedesktop.secrets`: KWallet/ksecretd está retirado a
  # propósito (hypr/gigios/autostart.lua) y gnome-keyring no se instala. Sin esto, toda
  # instalación limpia recibe un cartel modal pidiendo el llavero del sistema en CADA
  # arranque de VS Code. El porqué del compromiso, en la cabecera del script.
  VSCODE_CONFIGURATOR="$GIGISHELL/bin/configurar-vscode.sh"
  if [ -x "$VSCODE_CONFIGURATOR" ]; then
    info "Fijando el almacén de secretos de VS Code ..."
    "$VSCODE_CONFIGURATOR" aplicar \
      || warn "No se pudo fijar password-store en ~/.vscode/argv.json. Reintentá: $VSCODE_CONFIGURATOR aplicar"
  else
    warn "No encontré $VSCODE_CONFIGURATOR; VS Code pedirá el llavero del sistema en cada arranque."
  fi
else
  info "Omito el ajuste de secretos de VS Code."
fi

if paso_activo css; then
  # --- 7. Generar el CSS que importa app.ts ---
  SCSS="$GIGISHELL/ags/estilos/style.scss"
  CSS="$GIGISHELL/ags/estilos/out.css"
  APP_ICONS="$GIGISHELL/ags/config/app_icons.json"

  [[ -f "$SCSS" ]] || die "Falta $SCSS. El checkout de GiGiShell está incompleto; vuelve a ejecutar el instalador o comprueba la rama '$BRANCH'."
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
else
  info "Omito la compilación del CSS (se conserva el out.css que haya)."
fi

if paso_activo mime; then
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

else
  info "Omito la reconstrucción de las bases MIME y de KDE."
fi


if paso_activo gpu; then
  # --- 10. Perfil de GPU de esta máquina ---
  # Sin este fichero, gigios/gpu.lua avisa EN PANTALLA EN CADA INICIO DE SESIÓN («sin
  # perfil de GPU: escribe uno en ~/.config/gigios/gpu-perfil»). Era el único paso de
  # docs/SETUP.md que quedaba pendiente después del instalador, y como el escritorio
  # arranca igual, lo normal era no hacerlo nunca y convivir con el aviso.
  #
  # La elección NO se versiona (es estado local por máquina, igual que el perfil de
  # Kitty o el de Firefox; ver docs/anadir-perfiles-por-equipo.md), por eso se escribe
  # aquí y no en el repo.
  #
  # La detección (detectar_perfil_gpu) está definida arriba, junto a tiene_bateria:
  # el paso `paquetes` la necesita antes que este para decidir el driver VA-API.
  GPU_PERFIL="$HOME/.config/gigios/gpu-perfil"
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
else
  info "Omito la elección del perfil de GPU."
fi

if paso_activo cursor; then
  # --- 10. Mitad hyprcursor del tema de puntero ---
  # El compositor dibuja su cursor con hyprcursor; XWayland y los toolkits siguen
  # con XCursor. Un tema de paquete solo trae la mitad XCursor, y libhyprcursor
  # ante un nombre que no encuentra no falla: coge el primer tema con manifest.hl
  # que haya, por orden de lectura del directorio. Sin esto, el tema que elija el
  # usuario en Ajustes no tendría mitad hyprcursor y el compositor acabaría
  # dibujando OTRO tema. Esto le añade esa mitad a $CURSOR_THEME, dejando un único
  # nombre válido para las dos variables.
  #
  # NO se elige el tema aquí: eso es `temaCursor` en ~/.config/gigios/devices.json,
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
        || warn "No pude generar el tema hyprcursor '$CURSOR_THEME': ${ERROR_CURSOR:-error del generador}. Elige otro con '$CURSOR_GEN --list' y volvé a correrlo."
    elif ((CURSOR_AVISO_HECHO == 0)); then
      warn "No hay ningún tema de puntero instalado al que añadirle la mitad hyprcursor; el compositor usará XCursor."
    fi
  fi
else
  info "Omito la generación del tema hyprcursor."
fi

# --- 11. Verificación y notas finales ---
if paso_activo shell; then
  configure_default_shell
else
  info "Omito el cambio de shell predeterminado."
fi

# La validación ya no aborta con `die`. Morir aquí imprimía "la instalación no está
# completa" y CORTABA antes de las notas finales, que es justo donde se explica qué hacer
# a continuación; y con `set -e` ni siquiera se veía el resumen de lo que sí se hizo. Se
# anota el resultado, se imprime todo, y el código de salida lo decide el resumen final.
# Recoger aquí lo que se lanzó en segundo plano, y no antes: es el último punto donde
# todavía se puede avisar de que algo no bajó, y para entonces ya se han solapado con
# todo lo demás. Va delante de la validación porque el preflight comprueba `pkgfile`.
esperar_descargas_de_fondo

preflight_fallo=0
if ! paso_activo preflight; then
  info "Omito la validación final."
elif [ -x "$GIGISHELL/bin/preflight.sh" ]; then
  info "Validando la instalación ..."
  HOME="$HOME" GIGIOS="$GIGISHELL" "$GIGISHELL/bin/preflight.sh" --installed \
    || preflight_fallo=1
else
  warn "No encontré bin/preflight.sh; no puedo validar la instalación."
fi
echo
if ((preflight_fallo)); then
  warn "La validación final encontró errores (detalle arriba). La instalación NO está completa."
fi
# Las notas dicen lo que REALMENTE se hizo. Antes era un heredoc fijo que afirmaba
# "Zsh quedó como predeterminado" y "las firmas ya se descargaron" aunque esos pasos se
# hubieran omitido con --sin/--solo: el instalador terminaba mintiendo sobre su propio
# resultado, que es peor que no decir nada.
if ((${#pasos_omitidos[@]})); then
  info "Instalación parcial completa (pasos ejecutados: ${pasos_previstos[*]})."
else
  info "Instalación base completa."
fi
echo "  • Rama:     $BRANCH"
[ -d "$BACKUP" ] && echo "  • Backups:  $BACKUP"
cat <<'EOF'
  • Secretos: ~/.config/gigios/spotify-creds.json y ~/.config/gigios/google-calendar-creds.json
              NO vienen en el repo (git-ignored). Restaura tus copias o corre
              ~/GiGiShell/ags/scripts/spotify-auth.sh y ~/GiGiShell/ags/scripts/google-calendar-auth.sh
EOF
paso_activo shell && cat <<'EOF'
  • Shell:    Zsh quedó como predeterminado en /etc/passwd, pero NO basta con abrir una
              terminal nueva: CERRÁ LA SESIÓN Y VOLVÉ A ENTRAR. Kitty mira $SHELL antes
              que /etc/passwd, y $SHELL lo fija el login para toda la sesión de Hyprland.
EOF
paso_activo kitty && cat <<'EOF'
  • Kitty:    el perfil se eligió según KITTY_PROFILE; cambiá con ~/GiGiShell/bin/kitty-profile.sh.
EOF
paso_activo firefox && cat <<'EOF'
  • Firefox:  el perfil se eligió según FIREFOX_PROFILE; reiniciá Firefox tras cambiarlo.
EOF
if paso_activo sddm; then
  if [ -L /etc/systemd/system/display-manager.service ]; then
    printf '  • SDDM:     activado (display-manager.service -> %s)%s.\n' \
      "$(basename "$(readlink -f /etc/systemd/system/display-manager.service)")" \
      "$( ((SDDM_AUTOLOGIN)) && printf ', entra solo en Hyprland' || printf ', pedirá contraseña')"
  else
    cat <<'EOF'
  • SDDM:     NO quedó activado: sin /etc/systemd/system/display-manager.service el
              equipo arranca en un TTY, sin escritorio y sin ningún error a la vista.
              Actívalo con: sudo systemctl enable sddm.service
EOF
  fi
fi
paso_activo repo && cat <<'EOF'
  • Push:     el remoto quedó en HTTPS; para pushear, cambialo a SSH:
              dotfiles remote set-url origin git@github.com:mglourido/gigi-shell.git
EOF
if paso_activo gpu; then
  if [[ -s "${GPU_PERFIL:-}" ]]; then
    printf '  • GPU:      perfil «%s» en %s (cambialo escribiendo otro nombre; ver docs/SETUP.md §9).\n' \
      "$(tr -d '[:space:]' < "$GPU_PERFIL")" "$GPU_PERFIL"
  else
    cat <<'EOF'
  • GPU:      no se pudo elegir perfil. Escribe uno en ~/.config/gigios/gpu-perfil o
              Hyprland avisará en cada inicio de sesión; ver docs/SETUP.md §9.
EOF
  fi
else
  cat <<'EOF'
  • Hardware: antes de iniciar Hyprland elige el perfil GPU; ver docs/SETUP.md.
EOF
fi
paso_activo cursor && cat <<'EOF'
  • Puntero:  elige el tema en Ajustes > Dispositivos > Puntero. Sin elegirlo, el
              compositor usa el puntero de XCursor; para añadir soporte hyprcursor
              a otro tema, ~/GiGiShell/bin/generar-hyprcursor.sh --list.
EOF
if paso_activo gestos; then
  cat <<'EOF'
  • Gestos:   el modo gestos por cámara está instalado. SUPER+SHIFT+G lo enciende y lo apaga;
              Ajustes > Cámara > Gestos elige qué gestos van y lo calibra. Mientras esté
              encendido la cámara queda OCUPADA (no se puede hacer una videollamada a la
              vez) y el indicador rojo de la barra se enciende, a propósito.
EOF
else
  cat <<'EOF'
  • Gestos:   NO se instaló el entorno del modo gestos. SUPER+SHIFT+G avisará de que falta;
              instalalo con: bash ~/GiGiShell/install.sh --solo gestos
EOF
fi
if paso_activo clamav-db; then
  cat <<'EOF'
  • Antivirus: las firmas de ClamAV ya se descargaron. A partir de ahora se comprueban al
              INICIAR SESIÓN y se actualizan solas y en silencio si tienen más de un día; no
              queda ningún servicio ni temporizador actualizando durante la sesión. Ajustes >
              Seguridad > Antivirus enseña la fecha, permite actualizarlas al momento y apagar
              ese automatismo.
EOF
else
  cat <<'EOF'
  • Antivirus: NO se descargaron las firmas de ClamAV en esta pasada. Se comprueban y se
              actualizan solas al INICIAR SESIÓN si faltan o tienen más de un día; hasta
              entonces el escáner de descargas no puede analizar nada.
EOF
fi
if paso_activo hibernacion; then
  if [[ -n "${HIBERNACION_LISTA:-}" ]]; then
    cat <<'EOF'
  • Hibernar: hace falta REINICIAR. resume= entra por la línea de comandos del kernel y la de
              la sesión actual ya está fijada, así que hasta el reinicio 'gigios-hibernacion
              estado' seguirá diciendo disponible=no y la fila de Ajustes saldrá apagada. Tras
              reiniciar, el tiempo se pone en Ajustes > Pantalla > Suspensión.
EOF
  else
    cat <<'EOF'
  • Hibernar: la preparación NO terminó bien. Sin swapfile persistente y sin resume= el equipo
              no puede hibernar, y la fila de Ajustes se queda apagada con su motivo. Repítelo
              con: bash ~/GiGiShell/install.sh --solo hibernacion
EOF
  fi
fi
cat <<'EOF'
  • Disco:    Ajustes > Almacenamiento analiza qué ocupa el equipo y cataloga las apps por
              tamaño; "Liberar espacio" limpia y, si lo activas, lo hace solo. La autolimpieza
              nace APAGADA y con todas las casillas sin marcar: nada se borra sin pedirlo.
  • Sistema:  si necesitas sensores, ejecuta 'sudo sensors-detect'.
  • Sesión:   cierra y abre sesión; después comprueba con 'ags run ~/.config/ags/app.ts'.
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
