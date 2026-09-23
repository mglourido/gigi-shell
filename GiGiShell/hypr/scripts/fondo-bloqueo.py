#!/usr/bin/env python3
"""Elige fondos para hyprlock sin repetirlos hasta agotar cada vuelta."""

import fcntl
import json
import random
import sys
import time
from pathlib import Path


DIRECTORIO = Path(__file__).resolve().parents[2] / "Wallpapers"
# La ruta debe coincidir con `path` en hyprlock.conf, cuyo parser no puede
# resolver un XDG_CACHE_HOME alternativo al cargar la imagen inicial.
CACHE = Path.home() / ".cache" / "gigios"
ESTADO = CACHE / "hyprlock-fondos.json"
ENLACE = CACHE / "hyprlock-fondo"
EXTENSIONES = {".jpg", ".jpeg", ".png", ".webp"}


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


def main() -> None:
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
            if elegido:
                print(elegido)
    except (OSError, TypeError, ValueError):
        # La imagen es accesoria: un error aquí nunca debe impedir bloquear.
        if ENLACE.is_file():
            print(ENLACE)


if __name__ == "__main__":
    main()
