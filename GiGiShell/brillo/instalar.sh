#!/usr/bin/env bash
# Compila gigishell-brillo y lo deja en ~/.local/bin, que es donde lo busca el bind de
# XF86MonBrightness* (hypr/gigishell/keybinds.lua) cuando `ags request` falla.
#
#   brillo/instalar.sh            compilar, pasar los tests e instalar
#   brillo/instalar.sh --quitar   borrar el binario (sin AGS, las teclas de brillo no hacen nada)
#
# No hay nada que relanzar: el bind lo ejecuta bajo demanda.
set -euo pipefail

DEST="$HOME/.local/bin/gigishell-brillo"
cd "$(dirname "$(readlink -f "$0")")"

if [[ "${1:-}" == --quitar ]]; then
    rm -f "$DEST"
    echo "Quitado $DEST"
    exit 0
fi

export PATH="$HOME/.cargo/bin:$PATH"
command -v cargo >/dev/null || { echo "Falta cargo (sudo pacman -S rustup && rustup default stable)" >&2; exit 1; }

# Fuera del repo; la misma ruta que fija brillo/.cargo/config.toml.
export CARGO_TARGET_DIR="$HOME/.cache/gigishell/cargo/brillo"
cargo test --release --quiet
cargo build --release --quiet
install -Dm755 "$CARGO_TARGET_DIR/release/gigishell-brillo" "$DEST"
echo "Instalado $DEST"
