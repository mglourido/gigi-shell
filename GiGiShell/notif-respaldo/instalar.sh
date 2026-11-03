#!/usr/bin/env bash
# Compila gigishell-notif-respaldo, lo deja en ~/.local/bin y registra su activación D-Bus.
#
#   notif-respaldo/instalar.sh            compilar, pasar los tests e instalar
#   notif-respaldo/instalar.sh --quitar   borrar el binario y la activación (con AGS caído, las
#                                         notificaciones vuelven a perderse)
#
# No hay nada que relanzar: el bus lo arranca solo cuando llega una notificación y AGS no tiene
# org.freedesktop.Notifications. Con AGS vivo no corre nunca.
#
# El .service se GENERA (no es un symlink al repo) porque `Exec=` exige una ruta absoluta y no
# expande `~` ni variables. Vive en ~/.local/share/dbus-1/services, que el bus mira ANTES que
# /usr/share: si hay un dunst o un mako instalado, su autoactivación queda tapada por esta.
set -euo pipefail

DEST="$HOME/.local/bin/gigishell-notif-respaldo"
SERVICIO="${XDG_DATA_HOME:-$HOME/.local/share}/dbus-1/services/org.freedesktop.Notifications.service"
cd "$(dirname "$(readlink -f "$0")")"

# Que el bus relea los .service ya, sin esperar a la próxima sesión. Si falla (sin sesión gráfica,
# desde un TTY), lo hará al volver a entrar.
recargar_bus() {
    busctl --user call org.freedesktop.DBus /org/freedesktop/DBus org.freedesktop.DBus ReloadConfig \
        >/dev/null 2>&1 || echo "Aviso: no se pudo recargar el bus; surtirá efecto en la próxima sesión" >&2
}

if [[ "${1:-}" == --quitar ]]; then
    rm -f "$DEST" "$SERVICIO"
    recargar_bus
    echo "Quitados $DEST y $SERVICIO"
    exit 0
fi

export PATH="$HOME/.cargo/bin:$PATH"
command -v cargo >/dev/null || { echo "Falta cargo (sudo pacman -S rustup && rustup default stable)" >&2; exit 1; }

# Fuera del repo; la misma ruta que fija notif-respaldo/.cargo/config.toml.
export CARGO_TARGET_DIR="$HOME/.cache/gigishell/cargo/notif-respaldo"
cargo test --release --quiet
cargo build --release --quiet
install -Dm755 "$CARGO_TARGET_DIR/release/gigishell-notif-respaldo" "$DEST"

mkdir -p "$(dirname "$SERVICIO")"
printf '[D-BUS Service]\nName=org.freedesktop.Notifications\nExec=%s\n' "$DEST" > "$SERVICIO"
recargar_bus
echo "Instalado $DEST y su activación en $SERVICIO"
