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
#   paccache       paquetes .pkg.tar que no son la versión instalada; se vuelven a descargar si hicieran falta
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

# Lo que ocupa una ruta en disco (bloques ASIGNADOS, no tamaño aparente), o 0. Se usa para poder
# informar de cuánto se ha liberado de verdad en vez de fiarse de lo que diga cada herramienta
# (journalctl no imprime nada útil). Asignados y no `du -b` porque es como mide la estimación
# (`gigishell-almacenamiento`) y porque el journal son ficheros dispersos: con `-b` daba el doble.
_tam() {
    local total=0 r
    for r in "$@"; do
        [[ -e "$r" ]] || continue
        total=$((total + $(du -sx --block-size=1 -- "$r" 2>/dev/null | awk 'END{print $1+0}')))
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
            n=$(snapper --machine-readable csv list 2>/dev/null | awk 'NR > 1 && length($0) > 0 { n++ } END { print n+0 }' || true)
            [[ "$n" =~ ^[0-9]+$ ]] && { echo "$n"; exit 0; }
        fi
        if command -v btrfs >/dev/null 2>&1; then
            n=$(btrfs subvolume list -s / 2>/dev/null | grep -c . || true)
            [[ "$n" =~ ^[0-9]+$ ]] && { echo "$n"; exit 0; }
        fi
        echo 0
        ;;

    # ── Limpiezas ────────────────────────────────────────────────────────────
    # Caché de pacman: se conserva EXACTAMENTE la versión instalada de cada paquete (con la
    # arquitectura con la que se instaló) y se borra todo lo demás, `.sig` incluidas. Conservar la
    # instalada y no `-k0`: sin ella, reinstalar tras una actualización rota exigiría red — justo
    # cuando lo que se ha roto puede ser la red. El nombre del verbo sigue siendo `paccache` porque
    # es el que autoriza la regla sudoers.
    #
    # NO se usa paccache (`-rk1` + `-ruk0`), y es un arreglo: paccache agrupa por nombre +
    # ARQUITECTURA, y CachyOS sirve el mismo paquete unas veces como `x86_64` y otras como
    # `x86_64_v3`. `firefox-155…-x86_64` y `firefox-158…-x86_64_v3` le parecían dos paquetes con una
    # versión cada uno y el viejo no se borraba nunca (52 versiones viejas en esta máquina, con
    # paccache diciendo «no candidate packages found»). Mismo criterio que la estimación de
    # `gigishell-almacenamiento` (`pacman::sobrantes_cache`): si cambia aquí, cambiarlo allí.
    #
    # Nada de esto corre con pacman en marcha (`db.lck`): le borraría el paquete que está a punto
    # de instalar o el directorio en el que descarga.
    paccache)
        cache=/var/cache/pacman/pkg
        [[ -e /var/lib/pacman/db.lck ]] && { echo "pacman está en uso (existe db.lck); se reintentará en la próxima limpieza" >&2; exit 1; }
        antes=$(_tam "$cache")
        # nombre → «versión arquitectura» instalada, leído de la base local (no de la salida
        # traducida de pacman).
        declare -A instalada=()
        while IFS=$'\t' read -r n v a; do
            [[ -n "$n" ]] && instalada[$n]="$v $a"
        done < <(awk '/^%NAME%$/{getline; n=$0} /^%VERSION%$/{getline; v=$0} /^%ARCH%$/{getline; a=$0}
                      ENDFILE{ if (n != "") print n "\t" v "\t" a; n = v = a = "" }' /var/lib/pacman/local/*/desc)
        # Sin base local legible TODO parecería sobrante: vaciar la caché entera por un fallo de
        # lectura es justo lo que este verbo no debe hacer nunca.
        ((${#instalada[@]} > 0)) || { echo "no se pudo leer la base de datos local de pacman" >&2; exit 1; }
        sobran=()
        for ruta in "$cache"/*.pkg.tar*; do
            [[ -f "$ruta" ]] || continue
            f=${ruta##*/}
            base=${f%%.pkg.tar*}
            [[ "$base" =~ ^(.+)-([^-]+-[^-]+)-([^-]+)$ ]] || continue
            [[ "${instalada[${BASH_REMATCH[1]}]:-}" == "${BASH_REMATCH[2]} ${BASH_REMATCH[3]}" ]] || sobran+=("$ruta")
        done
        ((${#sobran[@]})) && rm -f -- "${sobran[@]}"
        # Descargas a medias (`download-XXXXXX`): pacman las crea al bajar y las abandona si se
        # interrumpe, y nadie más las quita; en este equipo había 33. Solo las de más de una hora.
        find "$cache" -mindepth 1 -maxdepth 1 -type d -name 'download-*' -mmin +60 \
            -exec rm -rf -- {} + 2>/dev/null
        despues=$(_tam "$cache")
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
        journalctl --vacuum-size="$retener" >/dev/null 2>&1 || { echo "journalctl --vacuum-size falló" >&2; exit 1; }
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
        find /var/tmp -xdev -mindepth 1 -mtime +1 -delete 2>/dev/null || { echo "find /var/tmp falló" >&2; exit 1; }
        despues=$(_tam /var/tmp)
        echo $((antes - despues))
        ;;

    # Dependencias que ya no necesita nadie. La lista la elige pacman (`-Qtdq`),
    # no este script: si está vacía no se ejecuta nada, porque `pacman -Rns` sin
    # objetivos es un error de uso y quedaría como un fallo de la limpieza.
    huerfanos)
        command -v pacman >/dev/null 2>&1 || { echo "falta pacman" >&2; exit 1; }
        salida=$(pacman -Qtdq 2>/dev/null)
        rc=$?
        if ((rc != 0)); then
            # pacman devuelve rc=1 también cuando la consulta -Qdt no encuentra
            # huérfanos. Comprueba que la BD local responde antes de tratarlo como vacío.
            if ((rc == 1)) && [[ -z "$salida" ]] && pacman -Qq >/dev/null 2>&1; then
                rc=0 # Consulta válida sin paquetes huérfanos.
            else
                echo "pacman -Qtdq falló" >&2
                exit 1
            fi
        fi
        if [[ -n "$salida" ]]; then
            mapfile -t orfanos <<< "$salida"
        else
            orfanos=()
        fi
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
