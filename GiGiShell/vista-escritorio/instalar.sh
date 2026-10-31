#!/usr/bin/env bash
# Compila gigishell-vista-escritorio y lo deja en ~/.local/bin, que es donde lo busca
# ags/modulos/barra/escritorios/vistaEnVivo.ts cada vez que se abre una miniatura; sin él la barra
# usa su respaldo (ver ags/modulos/barra/CLAUDE.md).
#
#   vista-escritorio/instalar.sh            compilar, pasar los tests e instalar
#   vista-escritorio/instalar.sh --quitar   borrar el binario
#
# No hay nada que relanzar: la barra lo arranca bajo demanda y ve el binario en la siguiente
# miniatura.
set -euo pipefail

DEST="$HOME/.local/bin/gigishell-vista-escritorio"
cd "$(dirname "$(readlink -f "$0")")"

if [[ "${1:-}" == --quitar ]]; then
    rm -f "$DEST"
    echo "Quitado $DEST"
    exit 0
fi

export PATH="$HOME/.cargo/bin:$PATH"
command -v cargo >/dev/null || { echo "Falta cargo (sudo pacman -S rustup && rustup default stable)" >&2; exit 1; }

# Fuera del repo; la misma ruta que fija vista-escritorio/.cargo/config.toml.
export CARGO_TARGET_DIR="$HOME/.cache/gigishell/cargo/vista-escritorio"
cargo test --release --quiet
cargo build --release --quiet
install -Dm755 "$CARGO_TARGET_DIR/release/gigishell-vista-escritorio" "$DEST"
echo "Instalado $DEST"
