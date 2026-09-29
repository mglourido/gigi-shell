#!/usr/bin/env python3
"""
rofi-launch.py

Abre rofi (drun) y, tras la selección, ancla las ventanas de la app elegida al
escritorio desde el que la lanzaste. Toda esa lógica —identidad de la app,
observación del socket de eventos, rama single-instance, el ajuste y por qué el
timeout vale 15 s— vive en `anclaje.py`, compartida con `lanzar-anclado.py` (el
camino de Orion). Aquí queda solo lo propio de rofi: el toggle y sus flags.

Dos cierres automáticos: 5 s sin actividad (flags de abajo, los resuelve rofi) y
pasar el foco a un juego si se abrió fuera de él — ese lo hace AGS
(`ags/servicios/juegos/cierreRofi.ts`), que es quien sabe qué ventana es un juego.

Ver diseño: docs/superpowers/specs/2026-06-13-rofi-single-instance-move-design.md
"""

import subprocess

import anclaje


def main():
    # --- Toggle: si rofi ya está abierto, cerrarlo y salir ---
    if subprocess.run(["pgrep", "-x", "rofi"],
                      capture_output=True).returncode == 0:
        subprocess.run(["pkill", "-x", "rofi"])
        return

    before, before_classes, target_ws = anclaje.foto_previa()

    # --- Lanzar rofi (bloquea hasta selección o cancelación) ---
    # El diseño compartido vive en rofi/config.rasi; este selector solo cambia
    # el placeholder respecto al historial del portapapeles.
    tema_busqueda = 'entry { placeholder: "Buscar aplicaciones"; }'
    resultado_rofi = subprocess.run([
        "rofi", "-show", "drun",
        "-display-drun", "",
        "-no-drun-use-desktop-cache",
        "-kb-row-select", "Right",
        "-kb-move-char-forward", "Control+f",
        "-matching", "fuzzy",
        "-sort",
        "-sorting-method", "fzf",
        "-case-smart",
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
