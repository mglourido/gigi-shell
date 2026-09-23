# Configuración interactiva COMPARTIDA de Zsh (versionada en dotfiles).
# La carga $ZDOTDIR/.zshrc, que es LOCAL de cada equipo y es donde escriben los
# instaladores (bun, fnm, opam...): nada de rutas de una máquina aquí.
# Ver GiGiShell/docs/shell-local.md.
[[ -o interactive ]] || return 0

# Greeting, equivalente al del perfil Fish. Va POR ENCIMA del prompt instantáneo
# a la fuerza: p10k captura la salida de la inicializacion y la reimprime, y las
# secuencias de fastfetch (protocolo de imagenes de kitty y posicionamiento del
# cursor) no sobreviven a ese replay. El sintoma era INTERMITENTE -- medido, salia
# 1 de cada 5 arranques -- y sin ningun error ni el aviso de "console output",
# pese a INSTANT_PROMPT=verbose. Adelantarlo cuesta 5-15 ms, que no se notan.
# Solo en terminales que saben pintar el logo por el protocolo de imagenes: con
# --logo-type kitty en cualquier otra (VS Code, ssh, tty) sale basura o un
# retardo que no compensa.
if [[ -t 1 ]] && command -v fastfetch >/dev/null 2>&1; then
    case "${TERM_PROGRAM:-$TERM}" in
        kitty | xterm-kitty | ghostty | xterm-ghostty | WezTerm | konsole)
            fastfetch --logo-type kitty
            ;;
    esac
fi

# Prompt instantáneo de Powerlevel10k. Tiene que quedarse arriba del todo: pinta
# el prompt desde una cache antes de que carguen Oh My Zsh, compinit y p10k, que
# es lo que hacia esperar al abrir cada terminal. Cualquier cosa que pida entrada
# por consola (contraseñas, [y/n]) va POR ENCIMA de este bloque, como el greeting.
if [[ -r "${XDG_CACHE_HOME:-$HOME/.cache}/p10k-instant-prompt-${(%):-%n}.zsh" ]]; then
    source "${XDG_CACHE_HOME:-$HOME/.cache}/p10k-instant-prompt-${(%):-%n}.zsh"
fi

export EDITOR=code
export VISUAL="$EDITOR"

# Historial compartido y sin duplicados triviales.
HISTFILE="$ZDOTDIR/.zsh_history"
HISTSIZE=10000
SAVEHIST=10000
setopt append_history extended_history hist_expire_dups_first
setopt hist_ignore_dups hist_ignore_space share_history interactive_comments
setopt hist_reduce_blanks hist_no_store

# Comandos triviales que no se guardan en el historial. HISTORY_IGNORE es un
# PATRON de zsh (no una lista) y por si solo NO BASTA: zsh solo lo consulta al
# escribir el fichero, asi que el comando sigue en el historial de la sesion y
# la flecha arriba lo sigue sacando. El gancho zshaddhistory es el que lo deja
# fuera de verdad -- devolver 1 desde ahi descarta la linea en memoria Y en el
# fichero. Se dejan los dos porque cubren caminos distintos.
typeset -ga GIGISHELL_HIST_IGNORAR=(
    clear c cls reset 'tput reset'
    bash zsh fish sh dash
    exit logout
    pwd cd 'cd -' 'cd ..' .. ...
    history
    ls la ll lt 'l.'
    fastfetch neofetch
)
HISTORY_IGNORE="(${(j:|:)GIGISHELL_HIST_IGNORAR})"

_gigishell_historial_ignorar() {
    setopt localoptions extendedglob
    local linea=${1%%$'\n'}
    linea=${linea##[[:space:]]##}
    linea=${linea%%[[:space:]]##}
    [[ -z $linea || $linea == ${~HISTORY_IGNORE} ]] && return 1
    return 0
}
autoload -Uz add-zsh-hook
add-zsh-hook zshaddhistory _gigishell_historial_ignorar

# Oh My Zsh aporta completado y plugins; Powerlevel10k se carga por separado.
export ZSH=/usr/share/oh-my-zsh
export ZSH_CUSTOM="${ZSH_CUSTOM:-$ZSH/custom}"
ZSH_THEME=''
DISABLE_MAGIC_FUNCTIONS=true
COMPLETION_WAITING_DOTS=true
ZSH_AUTOSUGGEST_STRATEGY=(history completion)

# Oh My Zsh solo carga los plugins que trae EL PROPIO Oh My Zsh. Los de Arch
# (autosuggestions, syntax-highlighting, history-substring-search) NO viven en
# $ZSH/plugins ni en $ZSH_CUSTOM/plugins sino en /usr/share/zsh/plugins, asi que
# buscarlos aqui no encuentra nada y OMZ los ignora SIN DAR NINGUN ERROR. Se
# cargan a mano mas abajo, donde el orden entre ellos importa.
plugins=(git sudo)

if [[ -r "$ZSH/oh-my-zsh.sh" ]]; then
    source "$ZSH/oh-my-zsh.sh"
else
    autoload -Uz compinit
    compinit -d "$ZDOTDIR/.zcompdump"
fi

# Tab completa tambien ficheros y directorios ocultos (.config, .zshrc...), como
# hace Fish. compinit crea $_comp_options, asi que esto va DESPUES de cargarlo.
_comp_options+=(globdots)

if [[ -r /usr/share/zsh-theme-powerlevel10k/powerlevel10k.zsh-theme ]]; then
    source /usr/share/zsh-theme-powerlevel10k/powerlevel10k.zsh-theme
fi
[[ -r "$ZDOTDIR/.p10k.zsh" ]] && source "$ZDOTDIR/.p10k.zsh"

# Funciones y completados locales. fish-parity se carga al final para que sus
# bindings y alias sean los definitivos.
typeset _config_file
for _config_file in "$ZDOTDIR/functions/"*.zsh(N); do
    [[ "${_config_file:t}" == fish-parity.zsh ]] || source "$_config_file"
done
for _config_file in "$ZDOTDIR/completions/"*.zsh(N); do
    source "$_config_file"
done
unset _config_file

alias dotfiles='git --git-dir=$HOME/.dotfiles/ --work-tree=$HOME'
alias c='clear'
alias vc='code'
alias mkdir='mkdir -p'
alias fastfetch='fastfetch --logo-type kitty'

# Gestor de paquetes real de la máquina, sin envoltorios externos.
typeset _pkg_helper
if command -v paru >/dev/null 2>&1; then
    _pkg_helper=paru
elif command -v yay >/dev/null 2>&1; then
    _pkg_helper=yay
else
    _pkg_helper='sudo pacman'
fi
alias in="$_pkg_helper -S"
alias un="$_pkg_helper -Rns"
alias up="$_pkg_helper -Syu"
alias pl="$_pkg_helper -Qs"
alias pa="$_pkg_helper -Ss"
alias pc="$_pkg_helper -Sc"
unset _pkg_helper

# Notifica los comandos largos cuando la terminal no tiene el foco.
typeset -g _lc_start=0 _lc_cmd=''
typeset -gi _LC_THRESHOLD=10
typeset -ga _LC_SKIP=(cd ls ll la clear pwd exit history source . eval builtin)

_lc_terminal_focused() {
    command -v hyprctl >/dev/null 2>&1 || return 1
    local class
    class=$(hyprctl activewindow -j 2>/dev/null | jq -r '.class // ""' 2>/dev/null)
    class="${class:l}"
    [[ "$class" == (kitty|foot|alacritty|wezterm|ghostty) || "$class" == *terminal* ]]
}

_lc_format() {
    local seconds=$1
    if (( seconds >= 3600 )); then
        printf '%dh %dm %ds' $((seconds / 3600)) $(((seconds % 3600) / 60)) $((seconds % 60))
    elif (( seconds >= 60 )); then
        printf '%dm %ds' $((seconds / 60)) $((seconds % 60))
    else
        printf '%ds' "$seconds"
    fi
}

_lc_preexec() {
    _lc_start=$(date +%s)
    _lc_cmd="$1"
}

_lc_precmd() {
    local exit_code=$?
    (( _lc_start == 0 )) && return

    local now duration base item
    now=$(date +%s)
    duration=$((now - _lc_start))
    _lc_start=0
    (( duration < _LC_THRESHOLD )) && return

    base="${_lc_cmd%% *}"
    for item in "${_LC_SKIP[@]}"; do
        [[ "$base" == "$item" ]] && return
    done
    _lc_terminal_focused && return

    local icon=FAIL
    (( exit_code == 0 )) && icon=OK
    notify-send "$icon: Comando terminado" \
        "${_lc_cmd} — $(_lc_format "$duration")" -t 8000 2>/dev/null
}

autoload -Uz add-zsh-hook
add-zsh-hook preexec _lc_preexec
add-zsh-hook precmd _lc_precmd

# Plugins de Arch, en el unico orden que documentan sus autores:
#   syntax-highlighting -> history-substring-search -> autosuggestions
# history-substring-search lo carga fish-parity.zsh por dentro, de ahi que el
# resaltado vaya antes del source y las sugerencias despues.
_zsh_plugins=/usr/share/zsh/plugins
[[ -r "$_zsh_plugins/zsh-syntax-highlighting/zsh-syntax-highlighting.zsh" ]] &&
    source "$_zsh_plugins/zsh-syntax-highlighting/zsh-syntax-highlighting.zsh"

[[ -r "$ZDOTDIR/functions/fish-parity.zsh" ]] && source "$ZDOTDIR/functions/fish-parity.zsh"

[[ -r "$_zsh_plugins/zsh-autosuggestions/zsh-autosuggestions.zsh" ]] &&
    source "$_zsh_plugins/zsh-autosuggestions/zsh-autosuggestions.zsh"
unset _zsh_plugins
