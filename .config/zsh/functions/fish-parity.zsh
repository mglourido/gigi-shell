# Paridad interactiva de Fish para Zsh.
# Se carga después de plugins, funciones y completados locales.
[[ -o interactive ]] || return 0

# Expone el mapa $commands antes de comprobar dependencias opcionales.
zmodload -F zsh/parameter p:commands 2>/dev/null

# Rutas y visor de manuales configurados por cachyos-config.fish.
typeset -U path PATH
typeset -a _fish_extra_paths
typeset _fish_path
_fish_extra_paths=()
for _fish_path in "$HOME/.local/bin"; do
    [[ -d "$_fish_path" ]] && _fish_extra_paths+=("$_fish_path")
done
path=("${_fish_extra_paths[@]}" "${path[@]}")
unset _fish_extra_paths _fish_path

export MANROFFOPT='-c'
if command -v bat >/dev/null 2>&1; then
    export MANPAGER="sh -c 'col -bx | bat -l man -p'"
fi

# Fish muestra fecha y hora al listar el historial. Oh My Zsh ya proporciona
# omz_history, así que solo ajustamos su formato sin sustituir el backend.
if (( $+functions[omz_history] )); then
    alias history='omz_history -t "%F %T "'
fi

# Funciones de cachyos-config.fish.
backup() {
    if (( $# != 1 )); then
        print -u2 'uso: backup ARCHIVO'
        return 2
    fi
    command cp -- "$1" "$1.bak"
}

copy() {
    if (( $# == 2 )) && [[ -d "$1" ]]; then
        command cp -R -- "$1" "$2"
    else
        command cp "$@"
    fi
}

# Alias de cachyos-config.fish que no existían en Zsh.
if command -v eza >/dev/null 2>&1; then
    alias ls='eza -al --color=always --group-directories-first --icons=always'
    alias la='eza -a --color=always --group-directories-first --icons=always'
    alias ll='eza -l --color=always --group-directories-first --icons=always'
    alias lt='eza -aT --color=always --group-directories-first --icons=always'
    alias l.="eza -a --color=always --group-directories-first --icons=always | grep -e '^\\.'"
fi

alias grubup='sudo grub-mkconfig -o /boot/grub/grub.cfg'
alias fixpacman='sudo rm /var/lib/pacman/db.lck'
alias tarnow='tar -acf'
alias untar='tar -zxvf'
alias wget='wget -c'
alias psmem='ps auxf | sort -nr -k 4'
alias psmem10='ps auxf | sort -nr -k 4 | head -10'
alias ..='cd ..'
alias ...='cd ../..'
alias ....='cd ../../..'
alias .....='cd ../../../..'
alias ......='cd ../../../../..'
alias dir='dir --color=auto'
alias vdir='vdir --color=auto'
alias grep='grep --color=auto'
alias fgrep='fgrep --color=auto'
alias egrep='egrep --color=auto'
alias hw='hwinfo --short'
alias big="expac -H M '%m\\t%n' | sort -h | nl"
alias gitpkg="pacman -Q | grep -i -- '-git' | wc -l"
if command -v cachyos-rate-mirrors >/dev/null 2>&1; then
    alias update='sudo cachyos-rate-mirrors && sudo pacman -Syu'
    alias mirror='sudo cachyos-rate-mirrors'
else
    alias update='sudo pacman -Syu'
fi
alias apt='man pacman'
alias apt-get='man pacman'
alias tb='nc termbin.com 9999'
alias cleanup='sudo pacman -Rns $(pacman -Qtdq)'
alias jctl='journalctl -p 3 -xb'
alias rip="expac --timefmt='%Y-%m-%d %T' '%l\\t%n %v' | sort | tail -200 | nl"

# Búsqueda de historial como Fish: las flechas filtran por cualquier fragmento
# ya escrito. Ctrl+R sigue perteneciendo a FZF.
_fish_history_plugin=/usr/share/zsh/plugins/zsh-history-substring-search/zsh-history-substring-search.zsh
if [[ -r "$_fish_history_plugin" ]]; then
    HISTORY_SUBSTRING_SEARCH_ENSURE_UNIQUE=1
    source "$_fish_history_plugin"
fi
unset _fish_history_plugin

# Paleta efectiva del tema predeterminado de Fish. Los índices ANSI se
# resuelven mediante kitty/theme.conf, por lo que no hay una segunda paleta
# RGB que pueda desviarse de la de Fish.
typeset -g ZSH_AUTOSUGGEST_HIGHLIGHT_STYLE='fg=8'
typeset -gA ZSH_HIGHLIGHT_STYLES
ZSH_HIGHLIGHT_STYLES=(
    default                                  'fg=6'
    unknown-token                            'fg=9'
    reserved-word                            'none'
    alias                                    'none'
    suffix-alias                             'none'
    global-alias                             'fg=6'
    builtin                                  'none'
    function                                 'none'
    command                                  'none'
    precommand                               'none'
    commandseparator                         'fg=2'
    hashed-command                           'none'
    arg0                                     'none'
    autodirectory                            'fg=6,underline'
    path                                     'fg=6,underline'
    path_pathseparator                       'fg=6,underline'
    path_prefix                              'fg=6,underline'
    path_prefix_pathseparator                'fg=6,underline'
    globbing                                 'fg=14'
    history-expansion                        'fg=14'
    command-substitution                     'fg=6'
    command-substitution-unquoted            'fg=6'
    command-substitution-quoted              'fg=3'
    command-substitution-delimiter           'fg=14'
    command-substitution-delimiter-unquoted  'fg=14'
    command-substitution-delimiter-quoted    'fg=14'
    process-substitution                     'fg=6'
    process-substitution-delimiter           'fg=14'
    arithmetic-expansion                     'fg=14'
    single-hyphen-option                     'fg=6'
    double-hyphen-option                     'fg=6'
    back-quoted-argument                     'fg=3'
    back-quoted-argument-unclosed            'fg=9'
    back-quoted-argument-delimiter           'fg=14'
    single-quoted-argument                   'fg=3'
    single-quoted-argument-unclosed          'fg=9'
    double-quoted-argument                   'fg=3'
    double-quoted-argument-unclosed          'fg=9'
    dollar-quoted-argument                   'fg=3'
    dollar-quoted-argument-unclosed          'fg=9'
    rc-quote                                 'fg=14'
    dollar-double-quoted-argument             'fg=14'
    back-double-quoted-argument               'fg=14'
    back-dollar-quoted-argument               'fg=14'
    assign                                   'fg=6'
    redirection                              'fg=6,bold'
    comment                                  'fg=1'
    named-fd                                 'fg=6'
    numeric-fd                               'fg=6'
    bracket-error                            'fg=9'
    bracket-level-1                          'fg=14'
    bracket-level-2                          'fg=14'
    bracket-level-3                          'fg=14'
    bracket-level-4                          'fg=14'
    bracket-level-5                          'fg=14'
    cursor-matchingbracket                   'fg=7,bg=8,bold'
    cursor                                   'none'
    root                                     'none'
    line                                     'none'
)
typeset -ga zle_highlight
zle_highlight=(
    'default:none'
    'isearch:fg=7,bg=8,bold'
    'region:fg=7,bg=8,bold'
    'special:standout'
    'suffix:bold'
    'paste:none'
)

# El pager de Fish usa texto normal, selección blanca sobre brblack, progreso
# blanco sobre cyan y descripciones amarillas en cursiva.
typeset -a _fish_completion_colors
_fish_completion_colors=(
    'no=0' 'fi=0' 'di=0' 'ln=0' 'pi=0' 'so=0' 'bd=0' 'cd=0'
    'or=91' 'mi=91' 'su=0' 'sg=0' 'tw=0' 'ow=0' 'st=0' 'ex=0'
    'ma=37;100;1'
)
zstyle ':completion:*' list-colors "${_fish_completion_colors[@]}"
zstyle ':completion:*:*:*:*:*' menu select
zstyle ':completion:*:descriptions' format $'\e[33m\e[3m%d\e[23m\e[39m'
zstyle ':completion:*:warnings' format $'\e[91mSin coincidencias: %d\e[39m'
zstyle ':completion:*' list-prompt $'\e[97m\e[46m\e[1mMás: %p\e[22m\e[49m\e[39m'
zstyle ':completion:*' select-prompt $'\e[97m\e[46m\e[1mSelección: %p\e[22m\e[49m\e[39m'
unset _fish_completion_colors

_fish_clear_commandline() {
    BUFFER=''
    CURSOR=0
    MARK=0
    REGION_ACTIVE=0
    POSTDISPLAY=''
    zle redisplay
}

_fish_insert_newline() {
    LBUFFER+=$'\n'
    zle redisplay
}

# Una entrada pegada o editada con varias líneas no se ejecuta accidentalmente
# con Enter: Enter añade otra línea y Ctrl+Enter confirma todo el búfer.
_fish_guarded_accept_line() {
    if [[ "$BUFFER" == *$'\n'* ]]; then
        LBUFFER+=$'\n'
        zle redisplay
    else
        zle accept-line
    fi
}

_fish_clipboard_copy() {
    if command -v wl-copy >/dev/null 2>&1; then
        print -rn -- "$BUFFER" | command wl-copy
    else
        zle -M 'wl-copy no está instalado'
        return 1
    fi
}

_fish_clipboard_paste() {
    if ! command -v wl-paste >/dev/null 2>&1; then
        zle -M 'wl-paste no está instalado'
        return 1
    fi

    local clipboard
    clipboard="$(command wl-paste --no-newline 2>/dev/null)" || return 1
    LBUFFER+="$clipboard"
    zle redisplay
}

_fish_history_by_number() {
    setopt local_options extended_glob
    local number="${KEYS[-1]}"
    local entry
    entry="$(builtin fc -ln "-$number" "-$number" 2>/dev/null)" || {
        zle beep
        return 1
    }
    BUFFER="${entry##[[:space:]]#}"
    CURSOR=${#BUFFER}
    zle redisplay
}

_fish_append_pager() {
    [[ -n "${BUFFER//[[:space:]]/}" ]] || return 0
    BUFFER="${BUFFER% } &| ${PAGER:-less};"
    CURSOR=${#BUFFER}
    zle redisplay
}

_fish_describe_command() {
    local -a words
    words=(${(z)BUFFER})
    [[ -n "${words[1]:-}" ]] || return 0
    zle -I
    command whatis -- "${(Q)words[1]}" 2>/dev/null || print -u2 "Sin descripción para ${(Q)words[1]}"
    zle reset-prompt
}

_fish_open_token() {
    local -a words editor pager
    local target
    words=(${(z)LBUFFER})
    target="${(Q)words[-1]:-}"
    if [[ -z "$target" || ! -e "$target" ]]; then
        zle -M 'No hay un archivo válido antes del cursor'
        return 1
    fi

    editor=(${(z)${VISUAL:-${EDITOR:-vi}}})
    pager=(${(z)${PAGER:-less}})
    zle -I
    if [[ -d "$target" ]]; then
        if command -v eza >/dev/null 2>&1; then
            command eza -al --color=always --group-directories-first --icons=always -- "$target"
        else
            command ls -la -- "$target"
        fi
    elif [[ -x "$target" || "$target" == *.(sh|fish|zsh|py|js|ts|tsx) ]]; then
        command "${editor[@]}" "$target"
    else
        command "${pager[@]}" "$target"
    fi
    zle reset-prompt
}

zle -N _fish_clear_commandline
zle -N _fish_insert_newline
zle -N _fish_guarded_accept_line
zle -N _fish_clipboard_copy
zle -N _fish_clipboard_paste
zle -N _fish_history_by_number
zle -N _fish_append_pager
zle -N _fish_describe_command
zle -N _fish_open_token

# El tty convierte ^C en SIGINT antes de consultar bindkey. Antes de mostrar el
# prompt lo dejamos como carácter para que ZLE ejecute el widget; justo antes de
# lanzar un comando restauramos SIGINT para no cambiar su comportamiento.
_fish_ctrl_c_for_zle() {
    [[ -t 0 ]] && command stty intr undef 2>/dev/null
    return 0
}

_fish_ctrl_c_for_commands() {
    [[ -t 0 ]] && command stty intr '^C' 2>/dev/null
    return 0
}

autoload -Uz add-zsh-hook
add-zsh-hook precmd _fish_ctrl_c_for_zle
add-zsh-hook preexec _fish_ctrl_c_for_commands
add-zsh-hook zshexit _fish_ctrl_c_for_commands
_fish_ctrl_c_for_zle

typeset _fish_keymap _fish_digit
for _fish_keymap in emacs viins; do
    # Limpiar el búfer sin crear un prompt nuevo. Fuera de ZLE, Ctrl+C sigue
    # enviando SIGINT al proceso que esté en primer plano.
    bindkey -M "$_fish_keymap" '^C' _fish_clear_commandline
    bindkey -M "$_fish_keymap" '^G' _fish_clear_commandline

    bindkey -M "$_fish_keymap" '^M' _fish_guarded_accept_line
    bindkey -M "$_fish_keymap" '^J' _fish_guarded_accept_line
    bindkey -M "$_fish_keymap" $'\e[13;5u' accept-line
    bindkey -M "$_fish_keymap" $'\e\r' _fish_insert_newline

    # Atajos compartidos de Fish que Zsh no traía enlazados.
    bindkey -M "$_fish_keymap" $'\ee' edit-command-line
    bindkey -M "$_fish_keymap" $'\ev' edit-command-line
    (( $+widgets[sudo-command-line] )) && bindkey -M "$_fish_keymap" $'\es' sudo-command-line
    bindkey -M "$_fish_keymap" '^X' _fish_clipboard_copy
    bindkey -M "$_fish_keymap" '^V' _fish_clipboard_paste
    bindkey -M "$_fish_keymap" '^Z' undo
    bindkey -M "$_fish_keymap" '^U' backward-kill-line
    bindkey -M "$_fish_keymap" $'\e[122;6u' redo
    bindkey -M "$_fish_keymap" $'\ep' _fish_append_pager
    bindkey -M "$_fish_keymap" $'\ew' _fish_describe_command
    bindkey -M "$_fish_keymap" $'\eo' _fish_open_token

    if (( $+widgets[history-substring-search-up] )); then
        bindkey -M "$_fish_keymap" '^P' history-substring-search-up
        bindkey -M "$_fish_keymap" '^N' history-substring-search-down
        bindkey -M "$_fish_keymap" $'\e[A' history-substring-search-up
        bindkey -M "$_fish_keymap" $'\e[B' history-substring-search-down
        bindkey -M "$_fish_keymap" $'\eOA' history-substring-search-up
        bindkey -M "$_fish_keymap" $'\eOB' history-substring-search-down
    fi

    for _fish_digit in {1..9}; do
        bindkey -M "$_fish_keymap" "\e$_fish_digit" _fish_history_by_number
    done
done
unset _fish_keymap _fish_digit
