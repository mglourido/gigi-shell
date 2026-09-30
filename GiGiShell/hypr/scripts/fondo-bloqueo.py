#!/usr/bin/env python3
"""Elige fondos para hyprlock sin repetirlos hasta agotar cada vuelta.

También fija el TINTE de las tarjetas del bloqueo según el fondo inicial.
hyprlock no desenfoca widgets sueltos (0.9.6: blur_* solo existe en
`background`), así que las tarjetas imitan el cristal con un color oscuro
translúcido del mismo tono que el fondo. hyprlang no sustituye comandos: el
tinte se escribe como variables en un fichero que hyprlock.conf incluye, y solo
vale para el fondo con el que se bloqueó (las rotaciones posteriores no releen
la configuración).
"""

import colorsys
import fcntl
import json
import math
import os
import random
import subprocess
import sys
import time
from pathlib import Path


DIRECTORIO = Path(__file__).resolve().parents[2] / "Wallpapers"
# La ruta debe coincidir con `path` en hyprlock.conf, cuyo parser no puede
# resolver un XDG_CACHE_HOME alternativo al cargar la imagen inicial.
CACHE = Path.home() / ".cache" / "gigishell"
ESTADO = CACHE / "hyprlock-fondos.json"
ENLACE = CACHE / "hyprlock-fondo"
EXTENSIONES = {".jpg", ".jpeg", ".png", ".webp"}
TINTES = CACHE / "hyprlock-tintes.json"
TINTE_CONF = CACHE / "hyprlock-tinte.conf"
# Gris azulado neutro para fondos aún sin analizar o si magick falla.
TINTE_DEFECTO = (0.62, 0.15)


def archivos_disponibles(directorio: Path) -> list[str]:
    try:
        return sorted(str(archivo) for archivo in directorio.iterdir()
                      if archivo.is_file() and archivo.suffix.lower() in EXTENSIONES)
    except OSError:
        return []


def elegir_fondo(archivos: list[str], estado: dict) -> tuple[str, dict]:
    actual = estado.get("actual", "")
    if not archivos:
        return actual, estado

    pendientes = [ruta for ruta in estado.get("pendientes", []) if ruta in archivos]
    if not pendientes:
        pendientes = archivos.copy()
        random.shuffle(pendientes)
        # Una vuelta nueva nunca repite de inmediato el último fondo, salvo si solo hay uno.
        if len(pendientes) > 1 and pendientes[-1] == actual:
            pendientes[0], pendientes[-1] = pendientes[-1], pendientes[0]

    actual = pendientes.pop()
    return actual, {"actual": actual, "pendientes": pendientes}


def leer_estado() -> dict:
    try:
        dato = json.loads(ESTADO.read_text())
        return dato if isinstance(dato, dict) else {}
    except (OSError, ValueError):
        return {}


def guardar_estado(estado: dict) -> None:
    temporal = ESTADO.with_suffix(".tmp")
    temporal.write_text(json.dumps(estado))
    temporal.replace(ESTADO)


def actualizar_enlace(ruta: str) -> None:
    temporal = CACHE / "hyprlock-fondo.tmp"
    temporal.unlink(missing_ok=True)
    temporal.symlink_to(ruta)
    temporal.replace(ENLACE)


def analizar_tinte(ruta: str) -> tuple[float, float]:
    """Tono dominante (media circular pesada por croma) y saturación acotada."""
    # `-sample` y no `-resize`: no promedia la imagen entera y baja un PNG de
    # 16000x9001 de ~5 s a <1 s. `[0]` evita leer todos los frames de un GIF/WebP.
    crudo = subprocess.run(["magick", f"{ruta}[0]", "-sample", "32x32!", "-depth", "8", "rgb:-"],
                           capture_output=True, timeout=15, check=True).stdout
    sx = sy = 0.0
    total = len(crudo) // 3
    for i in range(0, total * 3, 3):
        tono, luz, sat = colorsys.rgb_to_hls(*(c / 255 for c in crudo[i:i + 3]))
        # Croma HSL: los grises y los casi negros/blancos no votan el tono.
        peso = sat * (1 - abs(2 * luz - 1))
        sx += math.cos(2 * math.pi * tono) * peso
        sy += math.sin(2 * math.pi * tono) * peso
    if not total:
        raise ValueError("imagen vacía")
    # Un fondo multicolor se anula a sí mismo y queda casi gris; el techo de
    # 0.35 impide que uno muy saturado dé tarjetas chillonas.
    return (math.atan2(sy, sx) / (2 * math.pi)) % 1, min(math.hypot(sx, sy) / total * 1.5, 0.35)


def leer_tintes() -> dict:
    try:
        dato = json.loads(TINTES.read_text())
        return dato if isinstance(dato, dict) else {}
    except (OSError, ValueError):
        return {}


def tinte_guardado(ruta: str, tintes: dict) -> tuple[float, float] | None:
    dato = tintes.get(ruta)
    try:
        if dato and dato["mtime"] == os.stat(ruta).st_mtime:
            return float(dato["tono"]), float(dato["sat"])
    except (OSError, KeyError, TypeError, ValueError):
        pass
    return None


def rgba(tono: float, luz: float, sat: float, alfa: float) -> str:
    r, g, b = (round(c * 255) for c in colorsys.hls_to_rgb(tono, luz, sat))
    return f"rgba({r}, {g}, {b}, {alfa})"


def escribir_tinte_conf(tinte: tuple[float, float]) -> None:
    tono, sat = tinte
    temporal = TINTE_CONF.with_suffix(".tmp")
    temporal.write_text(
        "# Generado por fondo-bloqueo.py en cada bloqueo; no editar.\n"
        f"$tinte = {rgba(tono, 0.14, sat, 0.55)}\n"
        f"$tinte_borde = {rgba(tono, 0.78, sat, 0.22)}\n"
        f"$tinte_campo = {rgba(tono, 0.07, sat, 0.45)}\n")
    temporal.replace(TINTE_CONF)


def calcular_tintes() -> None:
    """Analiza en segundo plano los fondos que no estén en caché."""
    with (CACHE / "hyprlock-tintes.lock").open("w") as bloqueo:
        try:
            fcntl.flock(bloqueo, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return  # Otro análisis ya está en marcha.
        os.nice(10)
        archivos = archivos_disponibles(DIRECTORIO)
        tintes = {ruta: dato for ruta, dato in leer_tintes().items() if ruta in archivos}
        for ruta in archivos:
            if tinte_guardado(ruta, tintes):
                continue
            try:
                tono, sat = analizar_tinte(ruta)
                tintes[ruta] = {"mtime": os.stat(ruta).st_mtime, "tono": tono, "sat": sat}
            except (OSError, ValueError, subprocess.SubprocessError):
                continue
            temporal = TINTES.with_suffix(".tmp")
            temporal.write_text(json.dumps(tintes))
            temporal.replace(TINTES)


def preparar_tinte(ruta: str) -> None:
    # Nunca se analiza aquí: un PNG gigante retrasaría el bloqueo casi un segundo.
    # Un fondo nuevo usa el tinte neutro esta vez y queda analizado para la siguiente.
    tinte = tinte_guardado(ruta, leer_tintes())
    escribir_tinte_conf(tinte or TINTE_DEFECTO)
    if tinte is None:
        subprocess.Popen([sys.executable, __file__, "tintes"], start_new_session=True,
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL)


def main() -> None:
    if len(sys.argv) > 1 and sys.argv[1] == "tintes":
        try:
            CACHE.mkdir(parents=True, exist_ok=True)
            calcular_tintes()
        except OSError:
            pass
        return
    iniciar = len(sys.argv) > 1 and sys.argv[1] == "iniciar"
    try:
        CACHE.mkdir(parents=True, exist_ok=True)
        with (CACHE / "hyprlock-fondos.lock").open("w") as bloqueo:
            fcntl.flock(bloqueo, fcntl.LOCK_EX)
            estado = leer_estado()
            # hyprlock llama a reload_cmd una vez por monitor. Todas las llamadas
            # del mismo refresco reciben el mismo fondo y consumen una sola posición.
            lapso = time.monotonic() - estado.get("instante", -100)
            # El contador monotónico se reinicia al arrancar. Un valor guardado
            # de una sesión anterior no puede congelar la cola en este arranque.
            if not iniciar and 0 <= lapso < 5:
                elegido = estado.get("actual", "")
            else:
                elegido, estado = elegir_fondo(archivos_disponibles(DIRECTORIO), estado)
                estado["instante"] = time.monotonic()
                guardar_estado(estado)
                if elegido:
                    actualizar_enlace(elegido)
            if iniciar:
                try:
                    preparar_tinte(elegido)
                except (OSError, subprocess.SubprocessError):
                    pass  # hyprlock.conf ya trae valores por defecto.
            if elegido:
                print(elegido)
    except (OSError, TypeError, ValueError):
        # La imagen es accesoria: un error aquí nunca debe impedir bloquear.
        if ENLACE.is_file():
            print(ENLACE)


if __name__ == "__main__":
    main()
