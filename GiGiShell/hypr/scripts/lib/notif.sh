# shellcheck shell=bash
# lib/notif.sh — IDENTIDAD por notificación del sistema. Se SOURCEA, no se ejecuta.
#
# EL PROBLEMA: todo lo que sale de `hypr/scripts/` llegaba a AGS con el mismo hint
# (`x-gigios-source:system`) y, en la mayoría de los scripts, sin `-a`, o sea con
# `app_name` = "notify-send". Vistas desde el motor de reglas, «USB desconectado»,
# «Disco casi lleno» y «Escalada de privilegios» eran EXACTAMENTE la misma cosa:
# el único gancho para distinguirlas era el texto del título, que cambia con el
# contenido (`"RAM muy baja: 812MB disponibles"`, `"CPU sobrecalentada: 91°C"`) y con
# cualquier retoque de redacción. Consecuencia práctica: las notificaciones del
# sistema NO se podían configurar por separado — silenciar una obligaba a escribir a
# mano una regla con un `contains` frágil, y en varios casos ni eso, porque dos avisos
# distintos comparten prefijo.
#
# LA SOLUCIÓN: cada punto de emisión declara QUIÉN es, con un identificador estable
# que no depende del texto:
#
#     -h string:x-gigios-event:<id>
#
# El id es la clave primaria del aviso. Sobrevive a que se reescriba el título, a que
# el cuerpo lleve cifras variables y a que dos ramas del script emitan textos
# distintos para el mismo suceso (los dos avisos de "ejecutable nuevo en Descargas",
# el singular y el plural, comparten id a propósito: quien silencia uno quiere los dos
# callados). AGS lo lee en `procesamiento/ingesta.ts`, lo mete en `NotifInput.event` y
# el motor de reglas casa por él (`match.event`); el catálogo de
# `modulos/notificaciones/rules/catalogoSistema.ts` los enumera para que Ajustes >
# Notificaciones > Sistema pueda listarlos y editarlos UNO A UNO aunque nunca hayan
# llegado a dispararse.
#
# CÓMO SE USA:
#
#     # shellcheck source=lib/notif.sh
#     source "$HOME/.config/hypr/scripts/lib/notif.sh"
#     NOTIF_APP="USB"                       # opcional: `-a` para todos los avisos
#     notificar usb.conectado -u normal "USB conectado" "$label" -t 8000
#
# Todo lo que va detrás del id se le pasa tal cual a `notify-send`, así que `-A`,
# `--wait`, `--icon` y compañía siguen funcionando igual:
#
#     act=$(notificar descargas.ejecutable-nuevo --wait -t 45000 -A "launch=Lanzar aislado" …)
#
# AL AÑADIR UN AVISO NUEVO, DA DE ALTA SU ID EN EL CATÁLOGO de AGS. Si no, el aviso
# funciona igual (nada depende de que esté catalogado) pero no aparece en la lista de
# Ajustes, que es justo lo que este fichero existe para permitir.
#
# EL ID SE VALIDA AQUÍ. Un id con espacios o comillas rompería el `a{sv}` del hint sin
# error visible: `notify-send` acepta `-h string:clave:valor` partiendo por el PRIMER
# ':' y se traga cualquier basura detrás, así que un id mal formado no falla — deja el
# aviso con una identidad silenciosamente distinta de la catalogada, que es el peor de
# los mundos (parece configurable y no lo es). Con un id inválido se emite igual, pero
# SIN el hint y con un aviso por stderr: perder la notificación sería mucho peor que
# perder su identidad.
: "${NOTIF_APP:=}"

_notif_id_valido() { [[ "$1" =~ ^[a-z0-9]+([.-][a-z0-9]+)*$ ]]; }

notificar() {
    local evento=$1; shift
    local -a extra=()
    [[ -n "$NOTIF_APP" ]] && extra+=(-a "$NOTIF_APP")
    if _notif_id_valido "$evento"; then
        extra+=(-h "string:x-gigios-event:$evento")
    else
        printf 'notificar: id de evento inválido: %q (se emite sin identidad)\n' "$evento" >&2
    fi
    notify-send -h string:x-gigios-source:system "${extra[@]}" "$@"
}
