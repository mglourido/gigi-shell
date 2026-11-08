#!/usr/bin/env python3
"""
lanzar-anclado.py — ejecuta un comando y ancla sus ventanas al escritorio actual.

Es el único camino de lanzamiento de los dos lanzadores: Orion
(`ags/modulos/orion/data/launch.ts`) y rofi (`rofi-launch.py`, vía `-run-command`).

    lanzar-anclado.py <comando de shell>
    lanzar-anclado.py --argv <argv…>

Sin `--argv` (Orion) el comando se pasa TAL CUAL a un shell, porque lo que hay en
un `.desktop` es una línea de shell (con comillas, `env VAR=x`, tuberías), no un
argv. Si llegan varios argumentos se juntan con espacios, para que dé igual cómo
lo trocee quien llama.

Con `--argv` (rofi) llega un argv YA troceado: rofi resuelve las comillas del
`Exec` antes de sustituir `{cmd}` (medido: `env FOO="a b" app` llega como
`env`, `FOO=a b`, `app`). Juntarlo con espacios perdería esas comillas, así que
se reconstruye con `shlex.join`. Y llega en el cwd que pide el `Path=` del
`.desktop`, que la app NO heredaría porque la lanza Hyprland: se antepone un
`cd` (con `;`, no `&&`: si fallara, mejor abrir la app en otro cwd que no
abrirla).

LA VENTANA NACE YA EN SU ESCRITORIO — NO SE MUEVE DESPUÉS. Se lanza con
`hyprctl dispatch exec [workspace N silent] <cmd>`, que aplica la regla en el
momento de mapear la ventana. Antes se lanzaba a secas y se corregía con un
`movetoworkspacesilent` en cuanto llegaba el `openwindow`, y aunque el resultado
final era el mismo, por medio la ventana llegaba a mapearse en el escritorio
equivocado: un parpadeo de un frame, un amago de render que ni siquiera
recolocaba las ventanas que ya había allí. Con la regla ese instante no existe
porque la ventana nunca llega a estar en el sitio malo.

El `silent` es imprescindible: sin él, lanzar algo destinado a otro escritorio te
arrastraría a ese escritorio, que es justo lo contrario de lo que se busca. En el
caso normal —lanzar en el escritorio en el que estás— no cambia nada: medido, la
ventana sigue recibiendo el foco como siempre.

LA REGLA SOLO CUBRE LA PRIMERA VENTANA, y por eso el observador sigue aquí.
Medido: con un comando que abre dos ventanas separadas por 2 s, la primera nace
en el escritorio de la regla y la SEGUNDA nace en el activo. Así que la regla
mata el artefacto en el caso que pasa siempre (una app, una ventana) y el
observador de `anclaje.py` se queda como red para los splash y los multiventana
—ahí sí con el parpadeo, que es el precio de que Hyprland no ofrezca nada mejor—
y para la rama `urgent`, que es la que trae al escritorio actual una app
single-instance ya abierta.

Si el anclaje está DESACTIVADO no se pone la regla: el ajuste significa "que cada
ventana aparezca donde yo esté", y fijarla al escritorio de lanzamiento sería
justo lo que el usuario apagó. Se lanza entonces por el camino de siempre.

ORDEN: primero se conecta el socket, luego la foto previa, y solo entonces se
lanza. Al revés habría una ventana ciega entre el exec y el `connect()` por la
que una app rápida (kitty abre en 0,1 s) podría colar su `openwindow` antes de
que nadie escuche.

Si algo falla al observar (no hay socket, Hyprland no responde) se sale sin ruido
DESPUÉS de haber lanzado: el fallo debe degradar a "la app se abre donde sea",
nunca a "la app no se abre". Por lo mismo, si el `dispatch exec` no sale bien se
relanza por `sh -c` — el camino sin regla, sin anclaje inicial, pero que abre.
"""

import os
import shlex
import subprocess
import sys

import anclaje


def _dispatch_ok(*args):
    """¿Respondió hyprctl "ok" a este dispatch?

    hyprctl responde "ok" y NO usa el código de salida para señalar un dispatch
    rechazado, así que mirar solo el returncode daría por bueno un fallo.
    """
    try:
        r = subprocess.run(["hyprctl", "dispatch", *args],
                           capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.SubprocessError):
        return False
    return r.returncode == 0 and r.stdout.strip().startswith("ok")


def lanzar_con_regla(cmd, ws):
    """Lanza `cmd` con la ventana ya fijada al workspace `ws`. ¿Salió bien?

    Solo para workspaces normales: los especiales (scratchpad) tienen id negativo
    y no se nombran así en una regla, de modo que ahí se devuelve False y se cae
    al lanzamiento normal, con el observador haciendo su trabajo de siempre.

    Forma Lua de Hyprland 0.56 — verificada en anidada:
    `hl.dsp.exec_cmd('<cmd>', {workspace='N silent'})` hace nacer la ventana en
    el workspace pedido sin robar el foco. Aquí hubo un repliegue a la sintaxis
    legacy (`exec [workspace N silent] cmd`) para una sesión aún en hyprlang;
    los `.conf` del compositor ya no existen y esa sintaxis no funciona en la
    sesión Lua, así que solo costaba un fork más antes del `sh -c` (mismo
    criterio con el que se quitó el de `anclaje.dispatch`).
    """
    if not isinstance(ws, int) or ws < 1:
        return False
    return _dispatch_ok(
        f"hl.dsp.exec_cmd({anclaje._literal_lua(cmd)}, {{workspace='{ws} silent'}})")


def lanzar_normal(cmd):
    """Camino sin regla: `sh -c`, en su PROPIA sesión.

    El `start_new_session` importa porque este proceso muere a los 15 s y la app
    no puede irse con él. Tampoco se espera a que termine ni se mira su salida:
    aquí no hay nada que reportar, y quedarse esperando a una app que dura horas
    mantendría vivo el observador para nada.
    """
    subprocess.Popen(["sh", "-c", cmd], start_new_session=True)


def comando(args):
    """(línea de shell a lanzar, argv para la pista), según cómo llamaron.

    El argv solo sirve para sacar el nombre del programa (`anclaje.pista_de_
    comando`); si la línea de Orion no se deja trocear, no hay pista y el
    lanzamiento se reparte como si no la tuviera.
    """
    if args[:1] == ["--argv"]:
        if not args[1:]:
            return "", []
        return (f"cd {shlex.quote(os.getcwd())} 2>/dev/null; "
                f"exec {shlex.join(args[1:])}"), args[1:]
    cmd = " ".join(args).strip()
    try:
        return cmd, shlex.split(cmd)
    except ValueError:
        return cmd, []


def main():
    cmd, argv = comando(sys.argv[1:])
    if not cmd:
        return 2

    anclar = anclaje.anclaje_activado()

    try:
        sock = anclaje.conectar_eventos()
        before, before_classes, target_ws = anclaje.foto_previa()
    except Exception:
        sock = None
        target_ws = None

    # Antes del exec, como el connect(): un observador anterior —y el
    # compositor— tienen que ver este lanzamiento ya cuando nazca la ventana,
    # o se la quedarían ellos. La espera en el compositor solo con el anclaje
    # activo: apagado, nadie debe mover ventanas a este escritorio.
    registro = (anclaje.Registro(pista=anclaje.pista_de_comando(argv),
                                 ws=target_ws if anclar else None)
                if sock is not None else None)

    if not (anclar and target_ws is not None and lanzar_con_regla(cmd, target_ws)):
        lanzar_normal(cmd)

    if sock is None:
        return 0
    try:
        anclaje.observe(sock, before, target_ws, anclar=anclar,
                        before_classes=before_classes, registro=registro)
    except Exception:
        pass
    finally:
        sock.close()   # el registro lo cierra observe() en su propio finally
    return 0


if __name__ == "__main__":
    sys.exit(main())
