#!/usr/bin/env bash
# desinstalar-app.sh — desinstala la app seleccionada en Orion (panel derecho).
#
#   desinstalar-app.sh detectar    <appId> <fichero.desktop> <exec>   → JSON por stdout
#   desinstalar-app.sh desinstalar <appId> <fichero.desktop> <exec>   → hace el trabajo
#
# Los dos verbos reciben LOS MISMOS argumentos y detectan por su cuenta, así que
# `desinstalar` no depende de que nadie le haya llamado antes.
#
# **`detectar` NO lo usa la UI**: Orion desinstala de un clic, sin pantalla de
# confirmación (la confirmación es el diálogo de contraseña de polkit, que no se
# puede saltar). Se conserva como entrada de DIAGNÓSTICO — es la forma de
# responder «¿por qué eligió este método?» o «¿qué se llevaría por delante?» sin
# borrar nada, y es con lo que se prueban los cinco caminos de detección.
#
# ── Por qué pkexec y no sudo, paru o yay ─────────────────────────────────────
# Esto sale de un clic en una interfaz gráfica: no hay terminal donde teclear una
# contraseña, así que `sudo` se colgaría esperando en un stdin que no existe.
# `pkexec` es lo que abre el diálogo gráfico (hyprpolkitagent, ya lanzado desde
# gigishell/autostart.lua) y su acción por defecto es `auth_admin` — pide la
# contraseña del usuario porque está en `wheel`, y NO la recuerda: cada
# desinstalación la vuelve a pedir, que es lo correcto para algo irreversible.
#
# `paru`/`yay` NO sirven de ejecutores aunque estén instalados: se niegan a
# correr como root y por dentro llaman a `sudo`, o sea el mismo callejón sin
# salida. Y tampoco hacen falta — `pacman -Rns` borra igual un paquete del AUR
# que uno de los repos; el helper solo interviene en la INSTALACIÓN. Sí se
# detectan para dos cosas reales: etiquetar el paquete como AUR en la UI y
# limpiar su clon en la caché (`~/.cache/{paru,yay}/clone/<pkg>`), que pacman no
# conoce y se quedaría ocupando disco.
#
# ── Fail-safe, al revés que casi todo lo demás del repo ──────────────────────
# El resto de scripts de GiGiShell son fail-open: ante la duda, hacen el trabajo.
# Aquí es al contrario. Todo error, toda ambigüedad y todo lo que no se sepa
# resolver termina en "no se desinstala nada" con un motivo escrito, porque el
# fallo silencioso de este script sería borrar software que el usuario no pidió
# borrar — y de eso no se vuelve.
set -uo pipefail

APP="Desinstalar"
NOTIF_APP="$APP"
# shellcheck source=lib/notif.sh
if ! source "$HOME/.config/hypr/scripts/lib/notif.sh" 2>/dev/null; then
    # Sin la librería se pierde la IDENTIDAD del aviso (deja de poder configurarse por
    # separado en Ajustes > Notificaciones > Sistema), pero NO el aviso: eso sería peor.
    notificar() {
        shift
        local -a _a=(); [[ -n "${NOTIF_APP:-}" ]] && _a=(-a "$NOTIF_APP")
        notify-send -h string:x-gigishell-source:system "${_a[@]}" "$@"
    }
fi

# Paquetes cuya desaparición deja la sesión inutilizable o el equipo sin
# arrancar. pacman ya se niega solo cuando algo depende de ellos, pero varios de
# estos son HOJAS del grafo (hyprland, sddm, el propio shell) y saldrían sin una
# sola queja. No se bloquea la operación —el usuario manda—, se marca con
# `aviso` para que el panel lo pinte en rojo antes de confirmar.
CRITICOS=(
    linux linux-lts linux-zen linux-hardened linux-cachyos
    systemd glibc bash coreutils pacman sudo polkit
    hyprland hyprlock hypridle xdg-desktop-portal-hyprland
    aylurs-gtk-shell aylurs-gtk-shell-git
    mesa nvidia nvidia-utils nvidia-open nvidia-dkms
    pipewire wireplumber networkmanager sddm greetd
)

# ── Utilidades ───────────────────────────────────────────────────────────────

# Primer token ejecutable de una línea `Exec=`. Los envoltorios (`sh -c`, `env`,
# `flatpak`…) no identifican a nadie: se salta el envoltorio y sus opciones hasta
# dar con el binario de verdad. Sin esto, media docena de apps se resolverían
# todas al mismo paquete (`bash`) y se ofrecería desinstalar el intérprete.
_binario_de() {
    local -a toks
    read -r -a toks <<<"${1:-}"
    local i=0 t
    while ((i < ${#toks[@]})); do
        t=${toks[i]}
        # `read -a` parte por espacios sin entender comillas, así que un
        # `sh -c 'kitty --hold'` deja el token como `'kitty`. Quitarlas evita
        # preguntarle a pacman por un fichero que no existe y caer en la rama
        # "manual" ofreciendo borrar nada.
        t=${t#[\"\']}; t=${t%[\"\']}
        case "${t##*/}" in
            sh|bash|zsh|env|nohup|setsid|gtk-launch)
                ((i++))
                # Saltar opciones y asignaciones VAR=valor del envoltorio.
                while ((i < ${#toks[@]})) && [[ ${toks[i]} == -* || ${toks[i]} == *=* ]]; do ((i++)); done
                ;;
            *) echo "$t"; return 0 ;;
        esac
    done
    return 1
}

# Ruta absoluta del binario. `command -v` resuelve por PATH; si ya viene
# absoluta se usa tal cual.
_ruta_binario() {
    local b=${1:-}
    [[ -z "$b" ]] && return 1
    if [[ "$b" == /* ]]; then [[ -e "$b" ]] && { echo "$b"; return 0; }; return 1; fi
    command -v -- "$b" 2>/dev/null
}

_es_critico() {
    local p=$1 c
    for c in "${CRITICOS[@]}"; do [[ "$p" == "$c" ]] && return 0; done
    return 1
}

_helper_aur() {
    local h
    for h in paru yay; do command -v "$h" >/dev/null 2>&1 && { echo "$h"; return 0; }; done
    echo ""
}

# JSON de salida. Siempre se emite un objeto completo — la UI no tiene que
# distinguir "clave ausente" de "vacío".
_emitir() {  # $1 metodo $2 objetivo $3 etiqueta $4 aviso $5 error ; paquetes/ficheros por stdin (uno por línea, en $6/$7)
    jq -n \
        --arg metodo "$1" --arg objetivo "$2" --arg etiqueta "$3" \
        --arg aviso "$4" --arg error "$5" \
        --arg helper "$(_helper_aur)" \
        --arg paquetes "${6:-}" --arg ficheros "${7:-}" \
        '{
            metodo: $metodo, objetivo: $objetivo, etiqueta: $etiqueta,
            aviso: $aviso, error: $error, helper: $helper,
            paquetes: ($paquetes | split("\n") | map(select(length > 0))),
            ficheros: ($ficheros | split("\n") | map(select(length > 0)))
        }'
}

# ── Detección ────────────────────────────────────────────────────────────────
# Rellena las globales det_* . El orden importa: Steam y Flatpak van ANTES que
# pacman porque sus `.desktop` viven en ~/.local/share/applications y no los
# posee ningún paquete, así que caerían en la rama "manual" y se ofrecería
# borrar el acceso directo — dejando el juego de 80 GB en disco y al usuario
# convencido de haberlo desinstalado.

det_metodo=""; det_objetivo=""; det_etiqueta=""; det_aviso=""; det_error=""
det_paquetes=""; det_ficheros=""

_detectar() {
    local app_id=$1 desktop=$2 exec_raw=$3

    # 1. Juego de Steam.
    if [[ "$exec_raw" =~ steam://rungameid/([0-9]+) || "$exec_raw" =~ -applaunch[[:space:]]+([0-9]+) ]]; then
        det_objetivo=${BASH_REMATCH[1]}
        if command -v steam >/dev/null 2>&1; then
            det_metodo="steam"; det_etiqueta="Juego de Steam"
            det_aviso="Lo desinstala Steam: se abrirá su propio diálogo de confirmación."
        else
            det_metodo="desconocido"; det_etiqueta="Juego de Steam"
            det_error="Steam no está instalado en este equipo."
        fi
        return
    fi

    # 2. Flatpak.
    if [[ "$exec_raw" =~ (^|/)flatpak[[:space:]] ]]; then
        local -a t; read -r -a t <<<"$exec_raw"
        local i=0 id=""
        while ((i < ${#t[@]})); do
            [[ ${t[i]} == "run" ]] && { ((i++)); break; }
            ((i++))
        done
        while ((i < ${#t[@]})); do
            [[ ${t[i]} != -* ]] && { id=${t[i]}; break; }
            ((i++))
        done
        det_objetivo=$id
        if [[ -z "$id" ]]; then
            det_metodo="desconocido"; det_etiqueta="Flatpak"
            det_error="No se pudo leer el identificador de Flatpak en la línea Exec."
        elif ! command -v flatpak >/dev/null 2>&1; then
            det_metodo="desconocido"; det_etiqueta="Flatpak"
            det_error="La app dice ser un Flatpak pero flatpak no está instalado."
        else
            det_metodo="flatpak"; det_etiqueta="Flatpak"
        fi
        return
    fi

    # 3. Paquete de pacman. Se pregunta primero por el .desktop (identifica el
    #    paquete aunque el Exec sea un envoltorio) y solo si no lo posee nadie,
    #    por el binario.
    if command -v pacman >/dev/null 2>&1; then
        local pkg="" ruta=""
        [[ -n "$desktop" && -e "$desktop" ]] && pkg=$(LC_ALL=C pacman -Qoq -- "$desktop" 2>/dev/null)
        if [[ -z "$pkg" ]]; then
            ruta=$(_ruta_binario "$(_binario_de "$exec_raw")")
            [[ -n "$ruta" ]] && pkg=$(LC_ALL=C pacman -Qoq -- "$ruta" 2>/dev/null)
        fi
        pkg=${pkg%%$'\n'*}

        if [[ -n "$pkg" ]]; then
            det_objetivo=$pkg
            det_metodo="pacman"; det_etiqueta="Paquete de los repositorios"
            # `pacman -Qm` lista lo que no está en ningún repo configurado: eso
            # es lo que vino del AUR (o se instaló a mano con -U).
            if LC_ALL=C pacman -Qmq 2>/dev/null | grep -qxF -- "$pkg"; then
                det_metodo="aur"; det_etiqueta="Paquete del AUR"
            fi

            # Qué se llevaría por delante `-Rs`. Un rc≠0 aquí NO es un fallo del
            # script: es pacman diciendo que otro paquete depende de este, y su
            # texto es la explicación que hay que enseñar. Sale por stdout, no
            # por stderr (medido), así que se captura junto.
            local salida rc
            salida=$(LC_ALL=C pacman -Rs --print --print-format '%n' -- "$pkg" 2>&1); rc=$?
            if ((rc != 0)); then
                # Se recorta a las primeras líneas: pacman emite UNA por cada
                # paquete que depende de este, y con algo como glibc son 68 KB
                # de texto idéntico que la UI no puede pintar ni el usuario leer.
                local total
                total=$(grep -c . <<<"$salida")
                det_error=$(head -n 4 <<<"$salida" | sed 's/^error: //' | paste -sd '·' - | sed 's/·/ · /g')
                ((total > 4)) && det_error+=" · (y $((total - 4)) más)"
                return
            fi
            det_paquetes=$salida

            local p
            while IFS= read -r p; do
                [[ -z "$p" ]] && continue
                if _es_critico "$p"; then
                    det_aviso="«$p» es parte del sistema o del escritorio: quitarlo puede dejar el equipo sin sesión gráfica."
                    break
                fi
            done <<<"$det_paquetes"
            return
        fi
    fi

    # 4. Instalación manual (curl | sh, AppImage, tarball…): nadie lo posee.
    #    Se listan SOLO ficheros concretos, nunca directorios: un `rm -rf` sobre
    #    un directorio adivinado es la forma de convertir esta función en una
    #    pérdida de datos. Si el binario es un symlink se añade su destino, que
    #    es donde vive de verdad lo instalado por los scripts de curl.
    local bin ruta destino
    bin=$(_binario_de "$exec_raw")
    ruta=$(_ruta_binario "$bin")
    det_objetivo=${bin:-$app_id}
    det_metodo="manual"; det_etiqueta="Instalación manual (fuera del gestor de paquetes)"

    local -a fs=()
    if [[ -n "$ruta" ]]; then
        fs+=("$ruta")
        if [[ -L "$ruta" ]]; then
            destino=$(readlink -f -- "$ruta" 2>/dev/null)
            [[ -n "$destino" && -f "$destino" ]] && fs+=("$destino")
        fi
    fi
    # El .desktop solo si es del usuario: uno de /usr/share pertenecería a un
    # paquete, y si hemos llegado hasta aquí es que no lo posee ninguno.
    [[ -n "$desktop" && -f "$desktop" && "$desktop" == "$HOME"/* ]] && fs+=("$desktop")

    if ((${#fs[@]} == 0)); then
        det_metodo="desconocido"
        det_error="No se encontró ningún fichero que borrar: ni el binario «${bin:-?}» ni un .desktop propio."
        return
    fi
    det_ficheros=$(printf '%s\n' "${fs[@]}")

    local f
    for f in "${fs[@]}"; do
        [[ "$f" != "$HOME"/* ]] && {
            det_aviso="Hay ficheros fuera de tu carpeta personal: se pedirá la contraseña."
            break
        }
    done
}

# ── Ejecución ────────────────────────────────────────────────────────────────

# pkexec devuelve 126 cuando se cierra el diálogo o la autenticación falla, y
# 127 cuando ni siquiera pudo ejecutar el programa. Distinguirlos importa:
# cancelar no es un error del que haya que avisar con un popup crítico.
_ejecutar_root() {
    local salida rc
    salida=$(pkexec "$@" 2>&1); rc=$?
    case $rc in
        0)   echo "$salida"; return 0 ;;
        126) echo "__CANCELADO__"; return 126 ;;
        *)   echo "$salida"; return "$rc" ;;
    esac
}

_limpiar_clon_aur() {  # $1 = paquete. Sin root: la caché es del usuario.
    local pkg=$1 helper d
    helper=$(_helper_aur)
    [[ -z "$helper" ]] && return 0
    for d in "$HOME/.cache/$helper/clone/$pkg" "${XDG_CACHE_HOME:-$HOME/.cache}/$helper/clone/$pkg"; do
        [[ -d "$d" ]] && rm -rf -- "$d"
    done
    return 0
}

_desinstalar() {
    local nombre=$1

    case "$det_metodo" in
        pacman|aur)
            local salida rc
            salida=$(_ejecutar_root /usr/bin/pacman -Rns --noconfirm -- "$det_objetivo"); rc=$?
            if ((rc == 126)); then
                echo "cancelado"; return 10
            elif ((rc != 0)); then
                notificar desinstalar.fallo -u critical -t 12000 "No se pudo desinstalar «$nombre»" \
                    "$(echo "$salida" | tail -n 3)"
                echo "error"; return 1
            fi
            [[ "$det_metodo" == "aur" ]] && _limpiar_clon_aur "$det_objetivo"
            local n; n=$(grep -c . <<<"$det_paquetes")
            notificar desinstalar.ok -u normal -t 8000 "«$nombre» desinstalada" \
                "Se han quitado $n paquete$([[ $n -eq 1 ]] || echo s)."
            ;;

        flatpak)
            local salida rc
            # `flatpak uninstall` escala solo por polkit cuando el runtime es de
            # sistema; en una instalación de usuario no pide nada.
            salida=$(flatpak uninstall -y --delete-data -- "$det_objetivo" 2>&1); rc=$?
            if ((rc != 0)); then
                notificar desinstalar.fallo -u critical -t 12000 "No se pudo desinstalar «$nombre»" "$(echo "$salida" | tail -n 3)"
                echo "error"; return 1
            fi
            notificar desinstalar.ok -u normal -t 8000 "«$nombre» desinstalada" "Flatpak $det_objetivo, con sus datos."
            ;;

        steam)
            # Steam no tiene una desinstalación no interactiva: esta URI abre su
            # propio diálogo. Se avisa para que el usuario sepa dónde mirar; sin
            # eso, Steam saca una ventana que parece llegar de la nada.
            setsid steam "steam://uninstall/$det_objetivo" >/dev/null 2>&1 &
            notificar desinstalar.steam -u normal -t 8000 "Desinstalar «$nombre»" "Confirma en la ventana de Steam."
            # `externo`, no `ok`: aquí NO se ha desinstalado nada todavía y no
            # vamos a enterarnos de si el usuario confirma — lo decide Steam en
            # su propia ventana. Dárselo a AGS como `ok` haría dos cosas mal:
            # borrar el favorito de un juego que quizá sigue instalado, y hacer
            # reaparecer Orion (layer OVERLAY) justo encima del diálogo de Steam.
            echo "externo"; return 0
            ;;

        manual)
            local -a fs=() root=()
            while IFS= read -r f; do [[ -n "$f" ]] && fs+=("$f"); done <<<"$det_ficheros"
            local f
            for f in "${fs[@]}"; do [[ "$f" != "$HOME"/* ]] && root+=("$f"); done

            if ((${#root[@]} > 0)); then
                local salida rc
                salida=$(_ejecutar_root /usr/bin/rm -f -- "${root[@]}"); rc=$?
                if ((rc == 126)); then echo "cancelado"; return 10; fi
                if ((rc != 0)); then
                    notificar desinstalar.fallo -u critical -t 12000 "No se pudo desinstalar «$nombre»" "$(echo "$salida" | tail -n 3)"
                    echo "error"; return 1
                fi
            fi
            for f in "${fs[@]}"; do [[ "$f" == "$HOME"/* ]] && rm -f -- "$f"; done

            notificar desinstalar.ok -u normal -t 8000 "«$nombre» desinstalada" \
                "Se han borrado ${#fs[@]} fichero$([[ ${#fs[@]} -eq 1 ]] || echo s). No estaba en el gestor de paquetes, así que puede quedar configuración suya en ~/.config."
            ;;

        *)
            notificar desinstalar.no-soportado -u critical -t 10000 "No se puede desinstalar «$nombre»" "${det_error:-Método desconocido.}"
            echo "error"; return 1
            ;;
    esac

    echo "ok"
    return 0
}

# ── Entrada ──────────────────────────────────────────────────────────────────

verbo=${1:-}
app_id=${2:-}
desktop=${3:-}
exec_raw=${4:-}
nombre=${5:-$app_id}

command -v jq >/dev/null 2>&1 || { echo '{"metodo":"desconocido","objetivo":"","etiqueta":"","aviso":"","error":"Falta jq.","helper":"","paquetes":[],"ficheros":[]}'; exit 1; }

case "$verbo" in
    detectar)
        _detectar "$app_id" "$desktop" "$exec_raw"
        _emitir "$det_metodo" "$det_objetivo" "$det_etiqueta" "$det_aviso" "$det_error" \
                "$det_paquetes" "$det_ficheros"
        ;;
    # El desenlace viaja SIEMPRE por stdout (`ok`/`cancelado`/`error`) con rc=0.
    # Codificarlo en el código de salida obligaría a AGS a leerlo del rechazo de
    # `execAsync`, que trae el stderr y no el stdout — y "el usuario cerró el
    # diálogo de contraseña" acabaría pintado como un fallo en rojo. Los rc≠0
    # quedan para lo que ni siquiera llegó a intentarse (uso incorrecto, sin jq).
    desinstalar)
        _detectar "$app_id" "$desktop" "$exec_raw"
        if [[ -n "$det_error" ]]; then
            notificar desinstalar.no-soportado -u critical -t 10000 "No se puede desinstalar «$nombre»" "$det_error"
            echo "error"; exit 0
        fi
        _desinstalar "$nombre"
        exit 0
        ;;
    *)
        echo "uso: $0 {detectar|desinstalar} <appId> <fichero.desktop> <exec> [nombre]" >&2
        exit 2
        ;;
esac
