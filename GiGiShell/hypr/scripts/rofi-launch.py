#!/usr/bin/env python3
"""
rofi-launch.py

Abre rofi (drun) y la app elegida se lanza por `lanzar-anclado.py`, el mismo
camino que Orion: rofi lo invoca con `-run-command` (y `-run-shell-command` para
las apps de terminal), así que la ventana NACE ya en el escritorio de
lanzamiento, sin el parpadeo de moverla después. Antes rofi ejecutaba el `Exec`
él mismo y este script observaba al volver la selección; se creía que
`-run-command` solo valía para el modo `run`, y es falso (medido en rofi 2.0:
drun también lo usa, con el argv ya troceado y el cwd del `Path=`). La lógica de
anclaje vive en `anclaje.py`. Aquí queda solo lo propio de rofi: el toggle y sus
flags.

Convivencia con los otros selectores y con Orion: SUPER+SPACE con el portapapeles
(u otro rofi) abierto lo cambia por este; abrir este cierra Orion, y abrir Orion
cierra este (los dos los hace AGS, `ags/modulos/orion/state.ts`).

Dos cierres automáticos: 5 s sin actividad (flags de abajo, los resuelve rofi) y
pasar el foco a un juego si se abrió fuera de él — ese lo hace AGS
(`ags/servicios/juegos/cierreRofi.ts`), que es quien sabe qué ventana es un juego.

Ver diseño: docs/superpowers/specs/2026-06-13-rofi-single-instance-move-design.md
"""

import os
import shlex
import subprocess
import time

# El lanzador anclado, junto a este script. Si faltara, rofi lanza a su manera:
# sin anclaje, pero la app se abre — nunca al revés.
LANZADOR = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                        "lanzar-anclado.py")

# Cómo se reconoce ESTE rofi entre los demás (portapapeles, emojis): su línea de
# comando empieza por `rofi -show drun`. Lo usan también `clipboard-history.sh`
# y Orion (`ags/modulos/orion/state.ts`, que cierra este rofi al abrirse y se
# cierra cuando se abre este), así que el orden de los primeros argumentos de
# abajo es parte del contrato.
PATRON_ROFI_APPS = "^rofi -show drun( |$)"


def hay_proceso(*args):
    return subprocess.run(["pgrep", *args], capture_output=True).returncode == 0


def cerrar_otro_rofi():
    """Cierra el rofi que haya abierto (otro selector) y espera a que salga.

    Rofi guarda un pidfile con cerrojo: lanzado mientras el anterior aún no ha
    salido, se niega ("Rofi already running?") y termina con código 1, así que
    sin la espera el cambio de selector se quedaría en un cierre a secas.
    """
    if not hay_proceso("-x", "rofi"):
        return
    subprocess.run(["pkill", "-x", "rofi"])
    for _ in range(20):  # hasta 1 s; rofi sale en milisegundos
        if not hay_proceso("-x", "rofi"):
            return
        time.sleep(0.05)


def main():
    # --- Toggle: si este rofi ya está abierto, cerrarlo y salir. Si el abierto
    # es OTRO selector (portapapeles, emojis), se cambia a este en vez de cerrar.
    if hay_proceso("-f", PATRON_ROFI_APPS):
        subprocess.run(["pkill", "-f", PATRON_ROFI_APPS])
        return
    cerrar_otro_rofi()

    # rofi sustituye {cmd} y vuelve a trocear la plantilla como un shell, así
    # que la ruta va citada. `{terminal} -e {cmd}` es la plantilla de fábrica.
    lanzar = []
    if os.access(LANZADOR, os.X_OK):
        base = f"{shlex.quote(LANZADOR)} --argv"
        lanzar = ["-run-command", f"{base} {{cmd}}",
                  "-run-shell-command", f"{base} {{terminal}} -e {{cmd}}"]

    # --- Lanzar rofi (bloquea hasta selección o cancelación) ---
    # El diseño compartido vive en rofi/config.rasi; este selector solo cambia
    # el placeholder respecto al historial del portapapeles.
    tema_busqueda = 'entry { placeholder: "Buscar aplicaciones"; }'
    subprocess.run([
        "rofi", "-show", "drun",  # primeros: PATRON_ROFI_APPS depende de ellos
        "-display-drun", "",
        "-no-drun-use-desktop-cache",
        "-kb-row-select", "Right",
        "-kb-move-char-forward", "Control+f",
        "-matching", "fuzzy",
        # Sin `exec` ni `categories` (los trae rofi de fábrica): con búsqueda
        # difusa, una línea Exec larga cuadra con casi cualquier cosa. La de
        # ZapZapNoGpu (~300 caracteres de `env -u … QTWEBENGINE_CHROMIUM_FLAGS=…`)
        # salía en todas las búsquedas.
        "-drun-match-fields", "name,generic,keywords",
        "-sort",
        "-sorting-method", "fzf",
        # Sin distinguir mayúsculas nunca: `-case-smart` la volvía sensible en
        # cuanto la búsqueda llevaba una mayúscula ("Fire" no encontraba "firefox").
        "-no-case-sensitive",
        "-theme-str", tema_busqueda,
        # Se cierra solo tras 5 s sin tocarlo. El reloj es de rofi y se reinicia
        # con cada tecla ("delay after inactivity" en su config por defecto), así
        # que solo salta si lo abriste y no llegaste a escribir ni moverte.
        # `kb-cancel` sale con el mismo código que Escape: el script termina abajo
        # sin anclar nada.
        "-timeout-delay", "5",
        "-timeout-action", "kb-cancel",
        *lanzar,
    ])


if __name__ == "__main__":
    main()
