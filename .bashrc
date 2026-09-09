#
# ~/.bashrc
#

# If not running interactively, don't do anything
[[ $- != *i* ]] && return

# Keep bash close to the CachyOS fish defaults.
[[ -d "$HOME/.local/bin" ]] && case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) PATH="$HOME/.local/bin:$PATH" ;; esac
[[ -d "$HOME/Applications/depot_tools" ]] && case ":$PATH:" in *":$HOME/Applications/depot_tools:"*) ;; *) PATH="$HOME/Applications/depot_tools:$PATH" ;; esac

export MANROFFOPT="-c"
if command -v bat >/dev/null 2>&1; then
    export MANPAGER="sh -c 'col -bx | bat -l man -p'"
fi
export HISTTIMEFORMAT='%F %T '
shopt -s histappend checkwinsize cdspell dirspell 2>/dev/null

# Comandos que NO se guardan en el historial: los triviales (no aportan nada al
# buscar hacia atras) y todo lo que empiece por espacio, que es la forma de
# escribir algo puntual sin dejar rastro. HISTIGNORE compara PATRONES CONTRA LA
# LINEA ENTERA, no contra el nombre del comando: por eso hace falta "cd" y
# ademas "cd *" si se quiere excluir cualquier cd, y por eso "ls -la" no cae por
# el patron "ls". El "&" inicial descarta la repeticion del comando anterior.
# El patron del espacio va con [[:space:]], NO con el clasico [ \t]: dentro de
# unos corchetes de glob la barra invertida es literal, asi que [ \t] es el
# conjunto {espacio, barra, t} y se tragaba en silencio todo comando que
# empezara por t (top, tar, tail...).
HISTCONTROL=ignoreboth          # ignorespace + ignoredups
HISTIGNORE='&:[[:space:]]*:clear:c:cls:reset:tput reset:bash:zsh:fish:sh:dash:exit:logout:pwd:history:ls:la:ll:lt:l.:cd:cd -:cd ..:..:...:fastfetch:neofetch'
bind 'set show-all-if-ambiguous on' 2>/dev/null
bind 'set completion-ignore-case on' 2>/dev/null

if [[ -r /usr/share/bash-completion/bash_completion ]]; then
    . /usr/share/bash-completion/bash_completion
fi

# Useful aliases from the fish/CachyOS setup.
if command -v eza >/dev/null 2>&1; then
    alias ls='eza -al --color=always --group-directories-first --icons'
    alias la='eza -a --color=always --group-directories-first --icons'
    alias ll='eza -l --color=always --group-directories-first --icons'
    alias lt='eza -aT --color=always --group-directories-first --icons'
    alias l.="eza -a | grep -e '^\.'"
else
    alias ls='ls --color=auto'
    alias la='ls -A --color=auto'
    alias ll='ls -lh --color=auto'
    alias lt='ls -R --color=auto'
    alias l.="ls -A --color=auto | grep -e '^\.'"
fi

alias grep='grep --color=auto'
alias fgrep='fgrep --color=auto'
alias egrep='egrep --color=auto'
alias dir='dir --color=auto'
alias vdir='vdir --color=auto'
alias grubup="sudo grub-mkconfig -o /boot/grub/grub.cfg"
alias fixpacman="sudo rm /var/lib/pacman/db.lck"
alias tarnow='tar -acf '
alias untar='tar -zxvf '
alias wget='wget -c '
alias psmem='ps auxf | sort -nr -k 4'
alias psmem10='ps auxf | sort -nr -k 4 | head -10'
alias ..='cd ..'
alias ...='cd ../..'
alias ....='cd ../../..'
alias .....='cd ../../../..'
alias ......='cd ../../../../..'
alias hw='hwinfo --short'
alias big="expac -H M '%m\t%n' | sort -h | nl"
alias gitpkg='pacman -Q | grep -i "\-git" | wc -l'
alias update='sudo pacman -Syu'
alias mirror="sudo cachyos-rate-mirrors"
alias apt='man pacman'
alias apt-get='man pacman'
alias please='sudo'
alias tb='nc termbin.com 9999'
alias cleanup='sudo pacman -Rns $(pacman -Qtdq)'
alias jctl="journalctl -p 3 -xb"
alias rip="expac --timefmt='%Y-%m-%d %T' '%l\t%n %v' | sort | tail -200 | nl"
alias dotfiles='git --git-dir=$HOME/.dotfiles/ --work-tree=$HOME'

backup() {
    [[ $# -eq 1 ]] || { printf 'usage: backup FILE\n' >&2; return 2; }
    cp -- "$1" "$1.bak"
}

copy() {
    if [[ $# -eq 2 && -d "$1" ]]; then
        cp -r -- "${1%/}" "$2"
    else
        cp -- "$@"
    fi
}

ffcd() {
    command -v fzf >/dev/null 2>&1 || { printf 'ffcd: fzf is not installed\n' >&2; return 127; }
    local initial_query=${1:-} selected_dir
    local fzf_options=(
        --preview='ls -p {} | grep /'
        --preview-window=right:60%
        --height=80%
        --layout=reverse
        --cycle
    )
    [[ -n "$initial_query" ]] && fzf_options+=(--query="$initial_query")

    selected_dir=$(
        find . -maxdepth 7 \( -name .git -o -name node_modules -o -name .venv -o -name target -o -name .cache \) -prune -o -type d -print 2>/dev/null |
            fzf "${fzf_options[@]}"
    ) || return 1
    [[ -n "$selected_dir" && -d "$selected_dir" ]] && cd -- "$selected_dir"
}

ffe() {
    command -v fzf >/dev/null 2>&1 || { printf 'ffe: fzf is not installed\n' >&2; return 127; }
    local editor=${EDITOR:-nvim}
    command -v "$editor" >/dev/null 2>&1 || editor=vi
    local initial_query=${1:-} selected_file
    local fzf_options=(--height=80% --layout=reverse --preview-window=right:60% --cycle)
    [[ -n "$initial_query" ]] && fzf_options+=(--query="$initial_query")

    selected_file=$(find . -maxdepth 5 -type f 2>/dev/null | fzf "${fzf_options[@]}") || return 1
    [[ -n "$selected_file" && -f "$selected_file" ]] || return 1
    cd -- "$(dirname -- "$selected_file")" && "$editor" "$(basename -- "$selected_file")"
}

ffec() {
    command -v fzf >/dev/null 2>&1 || { printf 'ffec: fzf is not installed\n' >&2; return 127; }
    local editor=${EDITOR:-nvim}
    command -v "$editor" >/dev/null 2>&1 || editor=vi
    local grep_pattern=${1:-} selected_file preview_cmd
    if command -v bat >/dev/null 2>&1; then
        preview_cmd='bat --color always --style=plain --paging=never {}'
    else
        preview_cmd='cat {}'
    fi

    selected_file=$(
        grep -irl -- "$grep_pattern" ./ 2>/dev/null |
            fzf --height=80% --layout=reverse --cycle --preview-window=right:60% --preview="$preview_cmd"
    ) || return 1
    [[ -n "$selected_file" ]] || { printf 'No file selected or search returned no results.\n' >&2; return 1; }
    cd -- "$(dirname -- "$selected_file")" && "$editor" "$(basename -- "$selected_file")"
}

ffch() {
    command -v fzf >/dev/null 2>&1 || { printf 'ffch: fzf is not installed\n' >&2; return 127; }
    local selected
    selected=$(history | fzf --height=80% --layout=reverse --cycle --query="${1:-}" | sed 's/^[[:space:]]*[0-9]\+[[:space:]]*//') || return 1
    printf '%s\n' "$selected"
}

_pure_git_branch() {
    command -v git >/dev/null 2>&1 || return 0
    local branch dirty
    branch=$(git symbolic-ref --quiet --short HEAD 2>/dev/null || git rev-parse --short HEAD 2>/dev/null) || return 0
    [[ -n "$(git status --porcelain 2>/dev/null)" ]] && dirty='*'
    printf ' %s%s' "$branch" "$dirty"
}

_pure_prompt() {
    local exit_code=$?
    local blue='\[\e[34m\]' magenta='\[\e[35m\]' red='\[\e[31m\]' gray='\[\e[90m\]' reset='\[\e[0m\]'
    local symbol='❯' symbol_color=$magenta
    (( exit_code != 0 )) && symbol_color=$red
    PS1="${blue}\w${gray}$(_pure_git_branch)${reset}"$'\n'"${symbol_color}${symbol} ${reset}"
}
PROMPT_COMMAND="_pure_prompt${PROMPT_COMMAND:+; $PROMPT_COMMAND}"

# __long-cmd-notify__ — notificar comandos largos (>10s) si la terminal no tiene foco
if [[ $- == *i* ]]; then
    _lc_start=0
    _lc_cmd=""
    _lc_fresh=0
    _LC_THRESHOLD=10
    _LC_SKIP=(cd ls ll la l. clear pwd exit history source . eval builtin)

    _lc_terminal_focused() {
        command -v hyprctl &>/dev/null || return 1
        local class
        class=$(hyprctl activewindow -j 2>/dev/null | jq -r '.class // ""' 2>/dev/null)
        class="${class,,}"
        [[ "$class" == "kitty"     || "$class" == "foot"      ||
           "$class" == "alacritty" || "$class" == "wezterm"   ||
           "$class" == "ghostty"   || "$class" == *"terminal"* ]]
    }

    _lc_format() {
        local s=$1
        if (( s >= 3600 )); then printf "%dh %dm %ds" $((s/3600)) $(((s%3600)/60)) $((s%60))
        elif (( s >= 60 )); then printf "%dm %ds" $((s/60)) $((s%60))
        else printf "%ds" $s
        fi
    }

    _lc_debug_trap() {
        # Ignorar comandos de nuestros propios hooks
        [[ "$BASH_COMMAND" == _lc_* || "$BASH_COMMAND" == _pure_prompt* ]] && return 0
        # Capturar solo el primer comando después del prompt
        if (( _lc_fresh == 1 )); then
            _lc_start=$(date +%s)
            _lc_cmd="$BASH_COMMAND"
            _lc_fresh=0
        fi
    }

    _lc_prompt_cmd() {
        # $? aquí es el exit code del comando del usuario (ejecutamos primero en PROMPT_COMMAND)
        local exit_code=$? now
        now=$(date +%s)

        if (( _lc_start > 0 )); then
            local duration=$(( now - _lc_start ))
            if (( duration >= _LC_THRESHOLD )); then
                local base="${_lc_cmd%% *}"
                local skip=0
                for s in "${_LC_SKIP[@]}"; do [[ "$base" == "$s" ]] && skip=1 && break; done

                if (( skip == 0 )) && ! _lc_terminal_focused; then
                    local icon; (( exit_code == 0 )) && icon="✅" || icon="❌"
                    notify-send "${icon} Comando terminado" \
                        "${_lc_cmd} — $(_lc_format "$duration")" -t 8000 2>/dev/null
                fi
            fi
        fi

        _lc_start=0; _lc_cmd=""
        return "$exit_code"
    }

    _lc_arm() {
        _lc_fresh=1
    }

    trap '_lc_debug_trap' DEBUG
    # Ejecutar primero para capturar $?, y armar el DEBUG trap al final del prompt completo.
    PROMPT_COMMAND="_lc_prompt_cmd${PROMPT_COMMAND:+; $PROMPT_COMMAND}; _lc_arm"
fi
if [ -f "$HOME/.cargo/env" ]; then
    . "$HOME/.cargo/env"
fi


# Added by Antigravity CLI installer
export PATH="/home/paraguayo33/.local/bin:$PATH"
