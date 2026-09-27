#!/usr/bin/env bash
# Compila gigishell-guardian (protección de archivos) y lo instala como servicio
# systemd DESACTIVADO. Se ejecuta como el usuario, no con sudo: cargo compila con
# los permisos del usuario (compilar como root dejaría target/ de root) y solo la
# copia a /usr/local y /etc pide sudo.
#
#   guardian/instalar.sh            pasar los tests, compilar e instalar
#   guardian/instalar.sh --quitar   parar, desactivar y borrar lo instalado
#                                   (conserva /var/lib/gigishell-guardian: la política)
#
# Nunca hace `systemctl enable`: el servicio se enciende desde Ajustes > Protección
# de archivos. Si ya estaba activo, se reinicia para que corra el binario nuevo.
set -euo pipefail

BIN=/usr/local/bin/gigishell-guardian
CATEGORIAS=/usr/local/share/gigishell-guardian/categorias.json
UNIDAD=/etc/systemd/system/gigishell-guardian.service
SERVICIO=gigishell-guardian.service

GUARDIAN="$(dirname "$(readlink -f "$0")")"
GIGISHELL="$(dirname "$GUARDIAN")"

if [[ "$(id -u)" -eq 0 ]]; then
    echo "Ejecútalo como tu usuario, no con sudo: pedirá la contraseña solo para instalar." >&2
    exit 1
fi

if [[ "${1:-}" == --quitar ]]; then
    sudo systemctl disable --now "$SERVICIO" 2>/dev/null || true
    sudo rm -f "$BIN" "$UNIDAD"
    sudo rm -rf "$(dirname "$CATEGORIAS")"
    sudo systemctl daemon-reload
    echo "Quitado gigishell-guardian (la política sigue en /var/lib/gigishell-guardian)."
    exit 0
fi

# rustup deja cargo en ~/.cargo/bin, que no siempre está en el PATH de un script.
export PATH="$HOME/.cargo/bin:$PATH"
faltan=()
for c in cargo clang bpftool; do
    command -v "$c" >/dev/null 2>&1 || faltan+=("$c")
done
if (( ${#faltan[@]} )); then
    echo "Faltan: ${faltan[*]} (sudo pacman -S --needed rustup clang bpf)" >&2
    exit 1
fi
if ! grep -qw bpf /sys/kernel/security/lsm 2>/dev/null; then
    echo "El kernel no tiene BPF LSM activo (falta 'bpf' en /sys/kernel/security/lsm)." >&2
    exit 1
fi

cd "$GUARDIAN"
cargo test --release --quiet
cargo build --release --quiet

# `install` escribe a un temporal y renombra: sustituye el binario aunque esté corriendo.
sudo install -Dm755 target/release/gigishell-guardian "$BIN"
sudo install -Dm644 categorias.json "$CATEGORIAS"
sed "s/__UID__/$(id -u)/" "$GIGISHELL/system/guardian/gigishell-guardian.service" \
    | sudo install -Dm644 /dev/stdin "$UNIDAD"
sudo systemctl daemon-reload
if systemctl is-active --quiet "$SERVICIO"; then
    sudo systemctl restart "$SERVICIO"
    echo "Instalado y reiniciado gigishell-guardian."
else
    echo "Instalado gigishell-guardian (apagado: se enciende en Ajustes > Protección de archivos)."
fi
