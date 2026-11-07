#!/usr/bin/env python3
"""
rofi-launch.py

Abre rofi (drun) y, tras la selección, ancla las ventanas de la app elegida al
escritorio desde el que la lanzaste. Toda esa lógica —identidad de la app,
observación del socket de eventos, rama single-instance, el ajuste y por qué el
timeout vale 15 s— vive en `anclaje.py`, compartida con `lanzar-anclado.py` (el
camino de Orion). Aquí queda solo lo propio de rofi: el toggle y sus flags.

Convivencia con los otros selectores y con Orion: SUPER+SPACE con el portapapeles
(u otro rofi) abierto lo cambia por este; abrir este cierra Orion, y abrir Orion
cierra este (los dos los hace AGS, `ags/modulos/orion/state.ts`).

Dos cierres automáticos: 5 s sin actividad (flags de abajo, los resuelve rofi) y
pasar el foco a un juego si se abrió fuera de él — ese lo hace AGS
(`ags/servicios/juegos/cierreRofi.ts`), que es quien sabe qué ventana es un juego.

Ver diseño: docs/superpowers/specs/2026-06-13-rofi-single-instance-move-design.md
"""

import subprocess
import time

import anclaje

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

    before, before_classes, target_ws = anclaje.foto_previa()

    # --- Lanzar rofi (bloquea hasta selección o cancelación) ---
    # El diseño compartido vive en rofi/config.rasi; este selector solo cambia
    # el placeholder respecto al historial del portapapeles.
    tema_busqueda = 'entry { placeholder: "Buscar aplicaciones"; }'
    resultado_rofi = subprocess.run([
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
    ])
    if resultado_rofi.returncode != 0:
        return

    # --- Observación vía socket de eventos ---
    sock = anclaje.conectar_eventos()
    anclaje.observe(sock, before, target_ws, anclar=anclaje.anclaje_activado(),
                    before_classes=before_classes)


if __name__ == "__main__":
    main()
