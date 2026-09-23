#!/usr/bin/env python3
"""Texto breve del tiempo para hyprlock, respetando el permiso de ubicación de GiGiShell."""

import json
import math
import os
import sys
import urllib.parse
import urllib.request
from pathlib import Path


CONFIG = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")) / "gigios" / "datetime.json"


def descripcion(codigo: int) -> str:
    if codigo == 0:
        return "Despejado"
    if codigo in (1, 2):
        return "Poco nuboso"
    if codigo == 3:
        return "Nublado"
    if codigo in (45, 48):
        return "Niebla"
    if codigo in (51, 53, 55, 56, 57):
        return "Llovizna"
    if codigo in (61, 63, 65, 66, 67, 80, 81, 82):
        return "Lluvia"
    if codigo in (71, 73, 75, 77, 85, 86):
        return "Nieve"
    if codigo in (95, 96, 99):
        return "Tormenta"
    return "Tiempo actual"


def ubicacion_permitida(config: dict) -> tuple[float, float] | None:
    if config.get("locationAllowed") is not True:
        return None
    ubicacion = config.get("location")
    if not isinstance(ubicacion, dict):
        return None
    latitud = ubicacion.get("latitude")
    longitud = ubicacion.get("longitude")
    if not all(isinstance(valor, (int, float)) and not isinstance(valor, bool)
               and math.isfinite(valor) for valor in (latitud, longitud)):
        return None
    if not (-90 <= latitud <= 90 and -180 <= longitud <= 180):
        return None
    return latitud, longitud


def main() -> None:
    try:
        datos = ubicacion_permitida(json.loads(CONFIG.read_text()))
        if datos is None:
            return
        latitud, longitud = datos
        parametros = urllib.parse.urlencode({
            "latitude": latitud,
            "longitude": longitud,
            "current": "temperature_2m,weather_code",
            "timezone": "auto",
        })
        with urllib.request.urlopen(f"https://api.open-meteo.com/v1/forecast?{parametros}", timeout=4) as respuesta:
            actual = json.load(respuesta).get("current", {})
        temperatura = actual.get("temperature_2m")
        codigo = actual.get("weather_code")
        if not isinstance(temperatura, (int, float)) or not math.isfinite(temperatura):
            print("Tiempo no disponible")
            return
        if not isinstance(codigo, int):
            print("Tiempo no disponible")
            return
        print(f"{round(temperatura)} °C  ·  {descripcion(codigo)}")
    except (OSError, ValueError, TypeError, KeyError, TimeoutError):
        print("Tiempo no disponible")


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "disponible":
        try:
            sys.exit(0 if ubicacion_permitida(json.loads(CONFIG.read_text())) else 1)
        except (OSError, ValueError, TypeError):
            sys.exit(1)
    main()
