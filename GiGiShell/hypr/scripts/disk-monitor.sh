#!/usr/bin/env bash
# Disk space check — one-shot. Runs once at startup (gigios/autostart.lua), warns if
# any real partition is below WARN_GB, then exits. No daemon, no polling, no
# background process: running low on disk is a once-a-year event, and free
# space has no event source anyway, so a single login-time check is the right
# cost/benefit — it stays at literally zero resources the rest of the session.
#
# "NO EVENT SOURCE" ESTÁ COMPROBADO, no supuesto, y conviene no volver a buscarla:
# el kernel no publica nada (inotify/fanotify vigilan ficheros; `FAN_FS_ERROR` es
# corrupción del sistema de ficheros, no ENOSPC inminente), udisks2 solo señaliza
# montajes y medios, systemd no tiene nada equivalente y CachyOS no trae ningún
# demonio para esto. Lo único que SÍ empuja un evento es el netlink de CUOTAS
# (`quota_nl`, al pasar el límite blando), pero es por usuario, exige `quotaon` y
# **btrfs no implementa cuotas de usuario** — solo qgroups, que no emiten netlink —,
# así que en este equipo (todo btrfs sobre un solo NVMe) no existe. GNOME
# (`gsd-housekeeping`) y KDE (`kded freespacenotifier`) sondean cada 60 s.
#
# LA COBERTURA DEL RESTO DE LA SESIÓN NO SALE DE AQUÍ, sale de reaprovechar un `df`
# que ya se pagaba: `ags/servicios/disco/alerta.ts` emite ESTE MISMO aviso a partir
# del análisis de Ajustes > Almacenamiento. Los dos comparten umbrales (abajo) y la
# marca de MARCA_AVISOS, para no avisar dos veces de lo mismo.
#
# Only partitions with at least MIN_GB total are considered, and devices are
# deduplicated (btrfs subvolumes report the same device under many mounts).

# ESTOS DOS VALORES ESTÁN DUPLICADOS en `ags/servicios/disco/vigilancia.ts`
# (`AVISO_LIBRE_BYTES` / `AVISO_MIN_TOTAL_BYTES`). Si cambias uno, cambia el otro: que
# un emisor avise a 5 GiB y el otro a 3 haría que el mismo disco pareciera lleno al
# iniciar sesión y sano al abrir Ajustes.
WARN_GB=5
MIN_GB=6   # partitions smaller than this are ignored entirely

WARN_BYTES=$(( WARN_GB * 1024 * 1024 * 1024 ))
MIN_BYTES=$(( MIN_GB  * 1024 * 1024 * 1024 ))

# Marca compartida con AGS: `<epoch>\t<punto de montaje>` por línea, uno por disco que
# sigue al límite. Texto plano y no JSON **para poder leerla con un `read` de bash**:
# este script no forkea nada más que su `df`, y meterle un `jq` por un contador de dos
# columnas sería pagar el arranque de sesión por nada. El epoch va primero porque un
# punto de montaje puede llevar espacios: tras el primer tabulador, todo es la ruta.
MARCA_AVISOS="${XDG_CACHE_HOME:-$HOME/.cache}/gigios/disco-avisos"
ESPERA_S=$(( 6 * 3600 ))   # debe coincidir con AVISO_ESPERA_S de vigilancia.ts

NOTIF_APP="Disco"
# shellcheck source=lib/notif.sh
if ! source "$HOME/.config/hypr/scripts/lib/notif.sh" 2>/dev/null; then
    # Sin la librería se pierde la IDENTIDAD del aviso (deja de poder configurarse por
    # separado en Ajustes > Notificaciones > Sistema), pero NO el aviso: eso sería peor.
    notificar() {
        shift
        local -a _a=(); [[ -n "${NOTIF_APP:-}" ]] && _a=(-a "$NOTIF_APP")
        notify-send -h string:x-gigios-source:system "${_a[@]}" "$@"
    }
fi

send_notif() {
    notificar "$1" \
        --urgency="$2" \
        --icon="drive-harddisk" \
        --expire-time=15000 \
        "$3" "$4"
}

# El barrido de `df` es una sola pasada, así que es también el lote: con dos o tres
# sistemas de ficheros al límite (típico con / y /home separados, o varios discos)
# salía un popup por cada uno diciendo lo mismo. Se encolan y se vuelca al terminar
# el bucle, sin retrasar nada.
#
# El punto de montaje pasa del TÍTULO al cuerpo ("Disco casi lleno: /home" → "Disco
# casi lleno" + "…libres en /home"): un título fijo es lo que permite que dos discos
# se fundan en "2 discos casi llenos", y el dato no se pierde, solo cambia de sitio.
if ! source "$HOME/.config/hypr/scripts/lib/notif-agrupar.sh" 2>/dev/null; then
    notif_grupo()   { :; }
    notif_encolar() { send_notif disco.casi-lleno critical "Disco casi lleno" "$2"; }
    notif_volcar()  { :; }
fi
notif_grupo lleno disco.casi-lleno critical 15000 "Disco casi lleno" "discos casi llenos" \
    "" "" "--icon=drive-harddisk"

# Pure bash formatting — no awk fork. UNIDADES BINARIAS con etiqueta binaria y COMA
# decimal, que es lo que hace `formatearBytes` en `ags/servicios/disco/formato.ts`: la
# cuenta siempre fue en GiB (÷1024³) pero se rotulaba "GB", y desde que AGS emite el
# MISMO aviso, dos redacciones distintas del mismo suceso ("4.8 GB" al iniciar sesión,
# "4,8 GiB" al abrir Ajustes) parecerían dos medidas que no cuadran.
bytes_to_human() {
    local b=$1 gb=$((1024 * 1024 * 1024)) mb=$((1024 * 1024))
    if (( b >= gb )); then
        local whole=$(( b / gb )) tenths=$(( ((b % gb) * 10 + gb / 2) / gb ))
        if (( tenths == 10 )); then whole=$(( whole + 1 )); tenths=0; fi
        # `formatearBytes` recorta el ",0": "5 GiB", no "5,0 GiB".
        if (( tenths == 0 )); then echo "${whole} GiB"; else echo "${whole},${tenths} GiB"; fi
    else
        echo "$(( b / mb )) MiB"
    fi
}

declare -A seen  # device -> 1, to dedup btrfs subvolumes
declare -A avisado  # punto de montaje -> epoch del último aviso (marca compartida)

ahora=$(printf '%(%s)T' -1)   # builtin de bash: no forkea un `date`

# La marca puede no existir (primer arranque, caché limpiada): sin marca se avisa, que es
# el lado seguro del error — como mucho se repite un aviso, nunca se calla uno.
if [[ -r "$MARCA_AVISOS" ]]; then
    while IFS=$'\t' read -r epoch punto; do
        [[ -n "$punto" && "$epoch" =~ ^[0-9]+$ ]] || continue
        avisado[$punto]=$epoch
    done < "$MARCA_AVISOS"
fi

# Lo que hay que reescribir al terminar: SOLO los discos que siguen al límite. Un disco que
# se libera pierde su marca y vuelve a avisar en cuanto se llene otra vez, sin esperar las
# seis horas; un montaje que ya no existe (un USB retirado) no deja basura creciendo.
nuevas=""

while read -r dev mnt size avail; do
    # skip already-seen devices (keep the first/shortest mount path)
    [[ -n "${seen[$dev]:-}" ]] && continue
    (( size >= MIN_BYTES )) || continue
    seen[$dev]=1

    (( avail < WARN_BYTES )) || continue

    # ¿Ya se avisó de este montaje hace poco? La ventana la comparten los dos emisores, así
    # que abrir Ajustes > Almacenamiento justo después de iniciar sesión no repite el aviso
    # (y al revés). Una marca del FUTURO —reloj cambiado, caché de otro equipo— no silencia:
    # solo cuenta lo que cae dentro de la ventana hacia atrás.
    ultimo=${avisado[$mnt]:-}
    if [[ -n "$ultimo" ]] && (( ahora - ultimo >= 0 && ahora - ultimo < ESPERA_S )); then
        nuevas+="${ultimo}"$'\t'"${mnt}"$'\n'
        continue
    fi

    nuevas+="${ahora}"$'\t'"${mnt}"$'\n'
    notif_encolar lleno "Solo quedan $(bytes_to_human "$avail") libres en ${mnt}. Libera espacio."
done < <(df -B1 --output=source,target,size,avail -x tmpfs -x devtmpfs -x efivarfs 2>/dev/null | tail -n +2)
notif_volcar

# Se escribe SIEMPRE, también vacía: borrar la marca de un disco que ya no está al límite es
# la mitad que hace que un disco liberado y vuelto a llenar avise en el acto.
mkdir -p "${MARCA_AVISOS%/*}" 2>/dev/null && printf '%s' "$nuevas" > "$MARCA_AVISOS"
