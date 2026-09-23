#!/usr/bin/env python3
"""
wallpaper-select.py — decide qué fondo toca; NO lo aplica.

Es la única cara visible del motor de `lib/seleccion_fondos.py` (ahí está el
porqué del modelo: franjas globales para los fondos sueltos, línea de 24 h propia
para las variantes de cada grupo). Aquí solo va la E/S: leer los dos JSON, listar
la carpeta y traducir el resultado a una línea que bash pueda leer.

    wallpaper-select.py boot          # arranque: respeta randomOnStart
    wallpaper-select.py pick          # sorteo forzado ("Aleatorio" de Orion)
    wallpaper-select.py auto          # reevaluar la franja actual
    wallpaper-select.py grupo <id>    # clic en la tarjeta de un grupo
    wallpaper-select.py next-change   # segundos hasta el próximo límite

SALIDA: una línea `<id de grupo o vacío>\\t<ruta>`, o NADA si no hay que cambiar
nada. Ese "nada" solo lo produce `auto`, y es importante que exista: reaplicar el
fondo que ya está puesto dispararía la transición de awww, o sea un parpadeo
visible cada vez que el planificador comprueba la hora.

Quien lo llama es `wallpaper.sh`, que aplica y guarda el estado. Separar decidir
de aplicar es lo que permite probar el motor sin tocar el escritorio.

CÓDIGOS DE SALIDA: 0 siempre que la orden se entienda, incluso sin decisión.
Un fallo (config ilegible, carpeta vacía) sale con 1 y sin línea, para que bash
pueda replegarse a su sorteo de siempre — el fondo del escritorio no puede
depender de que este script funcione.
"""

from __future__ import annotations

import json
import os
import sys
from datetime import datetime

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib"))

import seleccion_fondos as sf   # noqa: E402

HOME = os.path.expanduser("~")
CONFIG_HOME = os.environ.get("XDG_CONFIG_HOME") or os.path.join(HOME, ".config")

# `GIGISHELL_WALLPAPER_*` son las costuras para probar esto sin tocar la instalación
# real, igual que `GIGISHELL_USB_PENDING_DIR` en el monitor de USB.
DIR_FONDOS = os.environ.get("GIGISHELL_WALLPAPER_DIR") or os.path.join(HOME, "GiGiShell", "Wallpapers")
CONFIG = os.environ.get("GIGISHELL_WALLPAPER_CONFIG") or os.path.join(CONFIG_HOME, "gigishell", "wallpapers.json")
ESTADO = os.environ.get("GIGISHELL_WALLPAPER_STATE") or os.path.join(CONFIG_HOME, "gigishell", "wallpaper.json")

EXTS = (".jpg", ".jpeg", ".png", ".webp")


def leer_json(ruta: str) -> dict:
    """Un JSON ausente o corrupto vale {}: se degrada al comportamiento de fábrica."""
    try:
        with open(ruta, "r", encoding="utf-8") as f:
            datos = json.load(f)
        return datos if isinstance(datos, dict) else {}
    except (OSError, ValueError):
        return {}


def disponibles() -> set[str]:
    try:
        return {os.path.join(DIR_FONDOS, n) for n in os.listdir(DIR_FONDOS)
                if n.lower().endswith(EXTS)}
    except OSError:
        return set()


def ahora_min() -> int:
    """
    Minutos del día, hora LOCAL y de pared.

    Es lo correcto aquí: "de noche" es una hora de reloj, no un instante UTC, y
    tiene que seguir siendo la misma en el cambio de horario de verano — el mismo
    criterio que las alarmas del panel de reloj.
    """
    forzado = os.environ.get("GIGISHELL_WALLPAPER_NOW")   # "HH:MM", solo para pruebas
    if forzado:
        minutos = sf.a_minutos(forzado)
        if minutos is not None:
            return minutos
    ahora = datetime.now()
    return ahora.hour * 60 + ahora.minute


def emitir(eleccion) -> int:
    if eleccion is None:
        return 1
    gid, ruta = eleccion
    print(f"{gid or ''}\t{ruta}")
    return 0


def main(argv: list[str]) -> int:
    orden = argv[1] if len(argv) > 1 else "auto"
    cfg = leer_json(CONFIG)
    estado = leer_json(ESTADO)
    rutas = disponibles()
    ahora = ahora_min()

    if orden == "next-change":
        # Se pasa el estado para que solo cuenten los límites que pueden cambiar
        # lo que hay puesto AHORA (los tramos del grupo vigente, o las franjas
        # globales si es un fondo suelto). Mirar los tramos de todos los grupos
        # despertaría al planificador a horas en las que no hay nada que hacer.
        delta = sf.proximo_cambio(cfg, ahora, estado)
        if delta is None:
            return 1
        # A segundos, descontando lo que llevamos dentro del minuto en curso: si
        # no, el planificador despertaría hasta 59 s ANTES del límite y vería la
        # franja vieja.
        print(max(1, delta * 60 - datetime.now().second))
        return 0

    if not rutas:
        return 1

    if orden == "pick":
        actual = estado.get("current")
        gid = estado.get("currentGroup")
        evitar = (gid if isinstance(gid, str) and gid else None,
                  actual if isinstance(actual, str) else "")
        return emitir(sf.elegir(cfg, ahora, rutas, evitar=evitar))

    if orden == "grupo":
        if len(argv) < 3:
            return 1
        gid = argv[2]
        grupo = sf.grupo_por_id(cfg, gid)
        if grupo is None:
            return 1
        # Sin tramo vigente el grupo no tiene nada que enseñar ahora mismo. Se
        # sale con 1 en vez de elegir otra cosa: el usuario ha pedido ESE grupo,
        # y aplicarle un fondo distinto sin decir nada sería peor que no hacer
        # nada — quien llama (Orion) puede avisar.
        ruta = sf.resolver_grupo(grupo, ahora, rutas)
        return emitir((gid, ruta)) if ruta else 1

    if orden == "boot":
        # `randomOnStart` ausente = true, y OJO con leerlo al revés: aquí no hay
        # operador `//` de jq que confunda un false con un ausente, pero el
        # criterio es el mismo que en wallpaper.sh.
        if estado.get("randomOnStart") is not False:
            return emitir(sf.elegir(cfg, ahora, rutas))
        # Con el aleatorio apagado se conserva lo elegido, pero pasado por el
        # filtro de la franja: mantener un fondo claro a las 3 de la mañana sería
        # justo lo que esta función existe para evitar. `decidir` ya resuelve las
        # tres ramas (sigue siendo apto / ya no lo es / era un grupo).
        return emitir(sf.decidir(cfg, estado, ahora, rutas))

    if orden == "auto":
        eleccion = sf.decidir(cfg, estado, ahora, rutas)
        if eleccion is None:
            return 0                      # nada que cambiar
        gid, ruta = eleccion
        actual = estado.get("current")
        gid_actual = estado.get("currentGroup") or None
        if ruta == actual and gid == gid_actual:
            return 0                      # ya está puesto: no repintar
        return emitir(eleccion)

    print(f"orden desconocida: {orden}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
