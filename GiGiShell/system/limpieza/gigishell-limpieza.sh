#!/usr/bin/env bash
# gigishell-limpieza — las partes de la limpieza de disco que son de root.
#
# ESTE FICHERO SE INSTALA ROOT-OWNED en /usr/local/bin/gigishell-limpieza (install.sh paso 10).
# NO se symlinkea desde ~/GiGiShell: corre como root vía /etc/sudoers.d/gigishell-limpieza, y apuntar a
# un script escribible por el usuario sería una escalada silenciosa (misma regla que los helpers de
# TLP y ClamAV, la regla udev de USB y i2c-dev; ver CLAUDE.md). La copia versionada en
# ~/GiGiShell/system/limpieza/ solo se vuelve efectiva al reinstalar con sudo a propósito.
#
# ── Qué entra aquí y qué NO ──────────────────────────────────────────────────
# La regla sudoers da NOPASSWD, o sea que todo lo que esté en este fichero se puede ejecutar sin
# que nadie escriba una contraseña — incluida la autolimpieza desatendida. El criterio para que un
# verbo entre aquí es **que lo borrado se regenere solo**:
#
#   paccache       paquetes .pkg.tar ya instalados; se vuelven a descargar si hicieran falta
#   journal        registros rotados; el journal sigue escribiendo
#   tmp            /var/tmp, que por definición no sobrevive a un reinicio
#   huerfanos      dependencias que ya no necesita ningún paquete instalado
#   instantaneas   SOLO CUENTA, no borra (es la sonda de solo-lectura del analizador)
#
# `huerfanos` es el que más se piensa antes de entrar, y entra porque `pacman -Rns $(pacman -Qtdq)`
# es exactamente "quita lo que nadie necesita": pacman elige la lista, no nosotros, y se niega solo
# si algo depende de un candidato. Se puede reinstalar todo con una orden. Aun así la UI lo trae
# **apagado por defecto** en la autolimpieza — es lo único de esta lista que quita software.
#
# Lo que NO está aquí y no debe añadirse sin repensar la regla sudoers:
#   - `pacman -Scc` (vaciar la caché ENTERA, incluidos los paquetes instalados): deja el sistema sin
#     forma de hacer un downgrade offline. Va por pkexec, con contraseña, desde el botón manual.
#   - borrar snapshots: es la copia de seguridad del sistema. Igual, pkexec y a mano.
#   - cualquier `rm` con una ruta que venga de fuera: aquí no se acepta ninguna ruta como argumento
#     justo por eso. El único argumento variable es el tamaño de retención del journal, y se valida.
set -uo pipefail

export LC_ALL=C

# Tamaño de una ruta en bytes, o 0. Se usa para poder informar de cuánto se ha liberado de verdad
# en vez de fiarse de lo que diga cada herramienta (paccache imprime, journalctl no).
_tam() {
    local total=0 r
    for r in "$@"; do
        [[ -e "$r" ]] || continue
        total=$((total + $(du -sxb -- "$r" 2>/dev/null | awk 'END{print $1+0}')))
    done
    echo "$total"
}

case "${1:-}" in
    # ── Sondas de solo lectura ───────────────────────────────────────────────
    # Cuántas instantáneas hay. Sale por aquí y no del analizador porque tanto
    # `snapper list` como `btrfs subvolume list` exigen root; snapper además
    # responde «Sin permisos» con **rc=0**, así que sin este verbo la cuenta
    # salía 0 y la sección aseguraba que no hay instantáneas cuando sí las hay.
    instantaneas)
        if command -v snapper >/dev/null 2>&1; then
            n=$(snapper --machine-readable csv list 2>/dev/null | tail -n +2 | grep -c . || true)
            [[ "$n" =~ ^[0-9]+$ ]] && { echo "$n"; exit 0; }
        fi
        if command -v btrfs >/dev/null 2>&1; then
            n=$(btrfs subvolume list -s / 2>/dev/null | grep -c . || true)
            [[ "$n" =~ ^[0-9]+$ ]] && { echo "$n"; exit 0; }
        fi
        echo 0
        ;;

    # ── Limpiezas ────────────────────────────────────────────────────────────
    # Caché de pacman conservando la última versión de cada paquete. `-k1` y no
    # `-k0`: con 0 no queda ni la versión INSTALADA, así que un downgrade tras
    # una actualización rota exigiría red — justo cuando lo que se ha roto puede
    # ser la red. Se limpian también los paquetes ya desinstalados (`-ruk0`),
    # que no sirven para ningún downgrade de nada.
    paccache)
        command -v paccache >/dev/null 2>&1 || { echo "falta paccache (pacman-contrib)" >&2; exit 1; }
        antes=$(_tam /var/cache/pacman/pkg)
        paccache -rk1 >/dev/null 2>&1
        paccache -ruk0 >/dev/null 2>&1
        despues=$(_tam /var/cache/pacman/pkg)
        echo $((antes - despues))
        ;;

    # Registros del journal. El argumento es el tamaño a CONSERVAR y se valida
    # contra el formato de systemd antes de tocarlo: llega desde un JSON que
    # escribe la UI, y un valor con espacios o con un `;` acabaría dentro de la
    # línea de órdenes de un proceso root.
    journal)
        retener=${2:-200M}
        [[ "$retener" =~ ^[0-9]+[KMG]$ ]] || { echo "tamaño inválido: $retener" >&2; exit 2; }
        command -v journalctl >/dev/null 2>&1 || { echo "falta journalctl" >&2; exit 1; }
        antes=$(_tam /var/log/journal)
        journalctl --vacuum-size="$retener" >/dev/null 2>&1
        despues=$(_tam /var/log/journal)
        echo $((antes - despues))
        ;;

    # /var/tmp: lo que systemd-tmpfiles ya borraría solo, pero sin esperar a sus
    # 30 días. NO se toca /tmp — es un tmpfs (RAM) y borrarlo bajo los pies de
    # los procesos vivos rompe sockets y ficheros de bloqueo en uso; se vacía
    # solo al reiniciar. Se respeta `-mtime +1` para no llevarse por delante lo
    # que un instalador esté usando ahora mismo.
    tmp)
        antes=$(_tam /var/tmp)
        find /var/tmp -xdev -mindepth 1 -mtime +1 -delete 2>/dev/null
        despues=$(_tam /var/tmp)
        echo $((antes - despues))
        ;;

    # Dependencias que ya no necesita nadie. La lista la elige pacman (`-Qtdq`),
    # no este script: si está vacía no se ejecuta nada, porque `pacman -Rns` sin
    # objetivos es un error de uso y quedaría como un fallo de la limpieza.
    huerfanos)
        command -v pacman >/dev/null 2>&1 || { echo "falta pacman" >&2; exit 1; }
        mapfile -t orfanos < <(pacman -Qtdq 2>/dev/null)
        ((${#orfanos[@]} == 0)) && { echo 0; exit 0; }
        # El tamaño se mide ANTES de borrar, con los paquetes aún instalados:
        # después ya no hay a quién preguntarle cuánto ocupaban.
        liberado=$(pacman -Qi -- "${orfanos[@]}" 2>/dev/null | awk -F': *' '
            /^Installed Size/ {
                n = $2 + 0; u = $2; sub(/^[0-9.,]+ */, "", u)
                m = (u ~ /^KiB/) ? 1024 : (u ~ /^MiB/) ? 1048576 : (u ~ /^GiB/) ? 1073741824 : 1
                t += n * m
            } END { printf "%d\n", t }')
        pacman -Rns --noconfirm -- "${orfanos[@]}" >/dev/null 2>&1 || { echo "pacman -Rns falló" >&2; exit 1; }
        echo "$liberado"
        ;;

    *)
        echo "uso: $0 {instantaneas|paccache|journal <tamaño>|tmp|huerfanos}" >&2
        exit 2
        ;;
esac
