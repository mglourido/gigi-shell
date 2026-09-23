#!/usr/bin/env zsh

# Entorno COMPARTIDO (versionado en dotfiles). Lo carga $ZDOTDIR/.zshenv, que es
# LOCAL de cada equipo: las rutas de herramientas (cargo...) van allí, no aquí.
# Ver GiGiOS/docs/shell-local.md.
# Entorno común para shells interactivos y no interactivos.
export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
export XDG_DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
export XDG_STATE_HOME="${XDG_STATE_HOME:-$HOME/.local/state}"
export XDG_CACHE_HOME="${XDG_CACHE_HOME:-$HOME/.cache}"
export XDG_DATA_DIRS="${XDG_DATA_DIRS:-$XDG_DATA_HOME:/usr/local/share:/usr/share}"

# Directorios de usuario. Los publica xdg-user-dirs en user-dirs.dirs, pero eso
# solo lo lee quien enlaza con la libreria; exportarlos deja que un script
# cualquiera use "$XDG_DOWNLOAD_DIR" sin invocar el comando.
#
# SIN user-dirs.dirs, xdg-user-dir DEVUELVE $HOME para todo lo que no conoce. No
# se exporta ese valor a proposito: una variable ausente hace fallar al que la
# use, pero una que apunta a $HOME hace que un `mv x "$XDG_DOWNLOAD_DIR"` vacie
# el fichero en la home sin que nadie se entere.
if command -v xdg-user-dir >/dev/null 2>&1; then
    typeset _xdg_key _xdg_val
    for _xdg_key in DESKTOP DOWNLOAD TEMPLATES PUBLICSHARE DOCUMENTS MUSIC PICTURES VIDEOS; do
        _xdg_val="${(P)${:-XDG_${_xdg_key}_DIR}}"
        [[ -n "$_xdg_val" ]] || _xdg_val="$(xdg-user-dir "$_xdg_key")"
        [[ -n "$_xdg_val" && "$_xdg_val" != "$HOME" ]] &&
            export "XDG_${_xdg_key}_DIR=$_xdg_val"
    done
    unset _xdg_key _xdg_val
fi

typeset -U path PATH
path=("$HOME/.local/bin" "${path[@]}")
export PATH

export LESSHISTFILE="${LESSHISTFILE:-/tmp/less-hist}"
export PARALLEL_HOME="$XDG_CONFIG_HOME/parallel"
export SCREENRC="$XDG_CONFIG_HOME/screen/screenrc"
export TERMINFO="$XDG_DATA_HOME/terminfo"
export TERMINFO_DIRS="$XDG_DATA_HOME/terminfo:/usr/share/terminfo"
export WGETRC="$XDG_CONFIG_HOME/wgetrc"
export PYTHON_HISTORY="$XDG_STATE_HOME/python_history"
