#!/usr/bin/env bash
# gigishell-camara — interruptor de bloqueo de la cámara (killswitch por software).
#
# ESTE FICHERO SE INSTALA ROOT-OWNED en /usr/local/bin/gigishell-camara (install.sh, paso
# `sistema`). NO se symlinkea desde ~/GiGiShell: corre como root vía /etc/sudoers.d/gigishell-camara, y
# apuntar a un script escribible por el usuario sería una escalada silenciosa (misma regla que el
# helper de TLP, el de ClamAV, el de limpieza y la regla udev de USB; ver CLAUDE.md). La copia
# versionada en ~/GiGiShell/system/camara/ solo se vuelve efectiva al reinstalar con sudo a propósito.
#
# POR QUÉ ROOT: los nodos `/dev/video*` son de `root:video` y quien decide sus permisos es udev.
# Un usuario no puede cambiarlos ni instalar la regla que hace que el bloqueo sobreviva a
# desenchufar la webcam o a reiniciar.
#
# Uso:  gigishell-camara {block|unblock|status}
#   block     bloquea TODAS las cámaras, ahora y las que se enchufen después.
#   unblock   las desbloquea.
#   status    imprime "blocked <n>" o "unblocked <n>" (n = nodos de captura presentes).
#             NO necesita root: solo mira si existe el fichero de regla, que es world-readable.
#
# ── EL NÚMERO DE LA REGLA ES LO MÁS IMPORTANTE DE ESTE FICHERO ──────────────────────────────
# La regla se llama `71-`, y no `99-` como el resto de las nuestras, porque tiene que colarse
# ENTRE dos reglas del sistema:
#
#   /usr/lib/udev/rules.d/70-uaccess.rules:34   SUBSYSTEM=="video4linux", TAG+="uaccess"
#   /usr/lib/udev/rules.d/73-seat-late.rules    TAG=="uaccess|…", RUN{builtin}+="uaccess"
#
# O sea: en el 70 se MARCA el dispositivo y en el 73 se EJECUTA el builtin que le pone la ACL al
# usuario de la sesión. Nuestro `TAG-="uaccess"` tiene que ocurrir después del 70 (o no habría nada
# que quitar) y antes del 73 (o el builtin ya se habría encolado con el tag puesto). Una regla
# `99-gigishell-camara.rules` —el nombre "natural" en este repo— quitaría el tag DESPUÉS de que el
# builtin estuviera decidido: no daría ningún error, `udevadm control --reload-rules` diría que
# todo bien, y la cámara seguiría abriéndose con normalidad. Ese es exactamente el tipo de fallo
# mudo que este repo documenta para no repetirlo.
#
# ── Y POR QUÉ ADEMÁS SE HACE `chmod 000` A MANO ─────────────────────────────────────────────
# La regla gobierna los nodos que udev procese A PARTIR de ahora. Los que ya existen conservan la
# ACL que el builtin les puso al arrancar la sesión, y `udevadm trigger` no la revoca: el builtin
# `uaccess` solo se ejecuta cuando el dispositivo ESTÁ etiquetado, así que al quitarle el tag nadie
# vuelve a pasar por ahí para deshacer lo hecho. Sin el chmod, "bloquear" no tendría ningún efecto
# hasta desenchufar la webcam o reiniciar.
#
# `chmod 000` basta —y es preferible a pelearse con `setfacl`— porque en un fichero con ACL los
# bits de grupo del modo SON la máscara: ponerlos a cero deja toda entrada con nombre en
# `#effective:---`. Comprobado antes de escribir esto:
#
#     $ setfacl -m u:nobody:rw f && chmod 000 f && getfacl -c f
#     user:nobody:rw-   #effective:---
#     mask::---
#
# root sigue pudiendo abrir el nodo (CAP_DAC_OVERRIDE), que es lo que permite desbloquear después.
#
# ── LO QUE ESTE KILLSWITCH NO HACE, Y HAY QUE DECIRLO ───────────────────────────────────────
# Impide ABRIR la cámara. No cierra un descriptor ya abierto: una app que estuviera emitiendo
# cuando se pulsa el bloqueo sigue viendo imagen hasta que suelte el dispositivo. Cortarla exigiría
# matarle el proceso o descargar el módulo del kernel a la fuerza, y ninguna de las dos cosas es
# aceptable para un interruptor de un panel de ajustes. Por eso `block` avisa por stderr si alguien
# tiene la cámara abierta en ese momento, y la UI lo enseña: un interruptor que dice "bloqueada"
# mientras el piloto de la webcam sigue encendido sería mentira.
set -uo pipefail

REGLA=/etc/udev/rules.d/71-gigishell-camara-bloqueada.rules

nodos() {
    local n=0 dev
    for dev in /dev/video*; do [[ -c $dev ]] && n=$((n + 1)); done
    printf '%d' "$n"
}

# ¿Alguien la tiene abierta AHORA? Se pregunta con `fuser`, igual que hace
# hypr/scripts/camara-monitor.sh; ausente, se calla (nunca se inventa un "sí").
en_uso() {
    command -v fuser >/dev/null 2>&1 || return 1
    local dev
    for dev in /dev/video*; do
        [[ -c $dev ]] || continue
        fuser "$dev" >/dev/null 2>&1 && return 0
    done
    return 1
}

recargar_udev() {
    udevadm control --reload-rules || return 1
    # `--action=change` para que los nodos YA presentes vuelvan a pasar por las reglas. Sin esto,
    # bloquear solo afectaría a lo que se enchufe después.
    udevadm trigger --action=change --subsystem-match=video4linux || return 1
    # `settle` para no devolverle el control a la UI antes de que los permisos estén puestos: el
    # panel relee el estado justo después y pintaría el interruptor a medio camino.
    udevadm settle --timeout=5 2>/dev/null
    return 0
}

case "${1:-}" in
    block)
        # La PRESENCIA del fichero es el interruptor. No hay estado en ningún otro sitio: así el
        # bloqueo sobrevive a reiniciar sin que nada tenga que acordarse de reponerlo, y se puede
        # deshacer desde un TTY con `rm` si algún día la UI no arranca.
        cat > "$REGLA" <<'EOF'
# Generado por gigishell-camara (GiGiShell). Su PRESENCIA es el interruptor de bloqueo
# de la cámara: para desbloquear se BORRA el fichero (`gigishell-camara unblock`).
#
# El 71 no es decorativo: 70-uaccess.rules pone TAG+="uaccess" y 73-seat-late.rules
# ejecuta el builtin que concede la ACL al usuario de la sesión. Hay que quitar el
# tag entre esas dos. En 99- llegaría tarde y no bloquearía nada, sin dar error.
SUBSYSTEM=="video4linux", TAG-="uaccess", OWNER="root", GROUP="root", MODE="0000"
EOF
        chmod 644 "$REGLA"
        recargar_udev || echo "aviso: no pude recargar udev; el bloqueo se aplicará al reiniciar" >&2
        # Los nodos vivos, a mano: ver la cabecera (la ACL ya concedida no la revoca el trigger).
        for dev in /dev/video*; do
            [[ -c $dev ]] || continue
            chown root:root "$dev" 2>/dev/null
            chmod 000 "$dev" 2>/dev/null
        done
        en_uso && echo "aviso: una aplicación tiene la cámara abierta; seguirá viéndola hasta que la cierre" >&2
        echo "blocked $(nodos)"
        ;;
    unblock)
        rm -f "$REGLA"
        recargar_udev || echo "aviso: no pude recargar udev; desbloquea del todo al reiniciar" >&2
        # ⚠️ EL TRIGGER NO DESHACE EL `chmod 000`, y creer que sí dejaba la cámara MUERTA hasta el
        # siguiente arranque —sin un solo error, y con `status` diciendo "unblocked"—. Es la misma
        # asimetría que documenta la cabecera para la ACL, en el otro sentido: udev fija dueño y
        # modo del nodo al CREARLO, y en un evento `change` sobre un nodo que ya existe no vuelve a
        # aplicarlos (medido: tras `unblock` el nodo seguía `c--------- root root`, con la entrada
        # `user:<usuario>:rw-` de la ACL intacta pero `#effective:---` por la máscara). Por eso el
        # bloqueo se hace a mano y el desbloqueo también tiene que deshacerse a mano.
        #
        # `0660 root:video` es lo que dejan `50-udev-default.rules` (`SUBSYSTEM=="video4linux",
        # GROUP="video"`) y el modo por defecto de udev; se reponen los dos porque la regla de
        # bloqueo cambia los dos. Con la máscara otra vez en `rw`, la ACL de sesión que el builtin
        # `uaccess` puso al arrancar vuelve a ser efectiva y la cámara se abre sin reiniciar.
        for dev in /dev/video*; do
            [[ -c $dev ]] || continue
            chown root:video "$dev" 2>/dev/null
            chmod 660 "$dev" 2>/dev/null
        done
        echo "unblocked $(nodos)"
        ;;
    status)
        if [[ -f "$REGLA" ]]; then echo "blocked $(nodos)"; else echo "unblocked $(nodos)"; fi
        ;;
    *)
        echo "uso: gigishell-camara {block|unblock|status}" >&2
        exit 2
        ;;
esac
