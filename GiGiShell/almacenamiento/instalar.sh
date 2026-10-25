#!/usr/bin/env bash
# Compila gigishell-almacenamiento y lo deja en ~/.local/bin, que es donde lo buscan
# hypr/scripts/analizar-almacenamiento.sh y limpiar-almacenamiento.sh: con el binario presente le
# ceden todo con `exec`; sin él siguen con su implementación bash (respaldo, ver docs).
#
#   almacenamiento/instalar.sh            compilar, pasar los tests e instalar
#   almacenamiento/instalar.sh --quitar   borrar el binario (los scripts vuelven al bash)
#
# No hay nada que relanzar: los scripts se ejecutan bajo demanda y ven el binario en la siguiente
# llamada.
set -euo pipefail

DEST="$HOME/.local/bin/gigishell-almacenamiento"
cd "$(dirname "$(readlink -f "$0")")"

if [[ "${1:-}" == --quitar ]]; then
    rm -f "$DEST"
    echo "Quitado $DEST"
    exit 0
fi

export PATH="$HOME/.cargo/bin:$PATH"
command -v cargo >/dev/null || { echo "Falta cargo (sudo pacman -S rustup && rustup default stable)" >&2; exit 1; }

# Fuera del repo; la misma ruta que fija almacenamiento/.cargo/config.toml.
export CARGO_TARGET_DIR="$HOME/.cache/gigishell/cargo/almacenamiento"
cargo test --release --quiet
cargo build --release --quiet
install -Dm755 "$CARGO_TARGET_DIR/release/gigishell-almacenamiento" "$DEST"
echo "Instalado $DEST"
