#!/usr/bin/env bash
# Compila gigishell-eventd y lo deja en ~/.local/bin, que es donde lo busca
# hypr/scripts/oom-monitor.sh. Sin el binario el monitor sigue funcionando con sus
# funciones bash, así que este paso es opcional y se puede deshacer borrándolo.
#
#   eventd/instalar.sh            compilar, pasar los tests e instalar
#   eventd/instalar.sh --quitar   borrar el binario (oom-monitor vuelve al bash)
#
# Tras instalar o quitar hay que relanzar el monitor para que lo note:
#   pkill -f oom-monitor.sh; setsid -f ~/.config/hypr/scripts/oom-monitor.sh
set -euo pipefail

DEST="$HOME/.local/bin/gigishell-eventd"
cd "$(dirname "$(readlink -f "$0")")"

if [[ "${1:-}" == --quitar ]]; then
    rm -f "$DEST"
    echo "Quitado $DEST"
    exit 0
fi

# rustup deja cargo en ~/.cargo/bin, que no siempre está en el PATH de un script.
export PATH="$HOME/.cargo/bin:$PATH"
command -v cargo >/dev/null || { echo "Falta cargo (sudo pacman -S rustup && rustup default stable)" >&2; exit 1; }

cargo test --release --quiet
cargo build --release --quiet
# `install` escribe a un temporal y renombra: sustituye el binario aunque esté corriendo.
install -Dm755 target/release/gigishell-eventd "$DEST"
echo "Instalado $DEST"
