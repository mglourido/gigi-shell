#!/usr/bin/env python3
"""Barrido de parámetros del motor de gestos, sobre recorridos sintéticos.

    python3 hypr/scripts/gestos/barrido.py

Es la TERCERA herramienta de calibración, y cada una responde algo distinto:

    --calibrar (gestos.py)   qué geometría tiene TU mano en cada postura
    --diagnostico (gestos.py) qué está viendo la cámara ahora mismo
    barrido.py (esto)        qué hace el MOTOR ante recorridos conocidos

Las dos primeras necesitan cámara y una mano delante. Esta no necesita nada:
fabrica los recorridos y mide el motor puro, así que corre con el intérprete del
sistema, sin el venv, y da el mismo resultado en cualquier máquina.

── PARA QUÉ SIRVE DE VERDAD ──────────────────────────────────────────────────
Los números de `Config` no son gustos: casi todos salieron de estas tablas, y
varios de ellos DESMINTIERON lo que parecía evidente. Ejemplos reales:

  - «Un tiempo muerto más corto siempre encadena mejor» → falso: 0,45 s y 0,55 s
    encadenan igual (0,40 s entre golpes) pero 0,45 deja colar un regreso.
  - «Estrechar la ventana del swipe hará que se pierdan gestos lentos» → falso:
    un golpe deliberado de 0,55 s sigue disparando con la ventana en 0,35.
  - «La ventana del swipe y la tolerancia a huecos son independientes» → falso:
    las dos están en segundos, así que el RITMO las acopla. A 30 fps un swipe
    aguanta 8 frames perdidos; a 15 no llegaría a 3.

Las tablas que imprime son las que están citadas en la sección de gestos de
`docs/hyprland-modulos.md`. Si tocas un umbral, re-córrelo y actualiza el
documento: un número sin su medición al lado vuelve a ser una suposición.
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from deteccion import Config, Motor  # noqa: E402
from manos_sinteticas import mano  # noqa: E402

#: Ritmo del demonio. Los recorridos se generan a este paso porque las tablas
#: solo valen para el ritmo en que se midieron — ver la cabecera.
DT = 1 / 30


def _tramo(x0, x1, segundos):
    n = max(2, int(segundos / DT))
    return [mano(x0 + (x1 - x0) * i / (n - 1)) for i in range(n)]


def _correr(cfg, muestras):
    motor = Motor(cfg)
    t, eventos = 0.0, []
    for p in muestras:
        eventos.extend(motor.frame(t, p))
        t += DT
    return [e.direccion for e in eventos if e.tipo == "swipe"]


def _dirs(lista):
    return ",".join(d[0].upper() for d in lista) or "-"


def tabla_regresos():
    """Tiempo muerto contra velocidad del regreso de la mano.

    Es EL compromiso del swipe: el regreso de la mano a su sitio es
    geométricamente idéntico a un gesto deliberado en sentido contrario, así que
    lo único que los separa es cuánto tarda en llegar.
    """
    print("── Regresos que disparan por error ──")
    print("   golpe de ida de 0,25 s · lo correcto es que solo salga 'D'\n")
    vueltas = (0.25, 0.40, 0.55, 0.70, 0.90, 1.30)
    print(f"   {'cooldown':>9} |" + "".join(f"{f'{v:.2f}s':>9}" for v in vueltas))
    for cooldown in (0.35, 0.45, 0.55, 0.70):
        fila = f"   {cooldown:>9.2f} |"
        for vuelta in vueltas:
            cfg = Config()
            cfg.cooldown_swipe = cooldown
            muestras = [mano(0.25)] * 12 + _tramo(0.25, 0.75, 0.25) + _tramo(0.75, 0.25, vuelta)
            fila += f"{_dirs(_correr(cfg, muestras)):>9}"
        print(fila)


def tabla_encadenado():
    """Lo que cuesta encadenar DOS gestos opuestos a propósito.

    La otra mitad del compromiso de arriba: subir el tiempo muerto quita
    regresos falsos pero obliga a dejar más respiro entre golpe y golpe.
    """
    print("\n── Encadenar derecha → izquierda a propósito ──")
    print("   dos golpes secos con un respiro de por medio · lo correcto es 'D,I'\n")
    pausas = (0.0, 0.20, 0.40, 0.60)
    print(f"   {'cooldown':>9} |" + "".join(f"{f'{p:.2f}s':>9}" for p in pausas))
    for cooldown in (0.35, 0.45, 0.55, 0.70):
        fila = f"   {cooldown:>9.2f} |"
        for pausa in pausas:
            cfg = Config()
            cfg.cooldown_swipe = cooldown
            muestras = (
                [mano(0.25)] * 12
                + _tramo(0.25, 0.75, 0.25)
                + [mano(0.75)] * max(0, int(pausa / DT))
                + _tramo(0.75, 0.25, 0.25)
            )
            fila += f"{_dirs(_correr(cfg, muestras)):>9}"
        print(fila)


def tabla_huecos():
    """Frames perdidos que aguanta un swipe, por ancho de ventana.

    ⚠️ Esta tabla es la que destapa el acoplamiento entre `ventana_swipe` y el
    RITMO: los huecos se cuentan en frames pero la ventana está en segundos.
    """
    print("\n── Frames perdidos que aguanta un swipe (a 30 fps) ──\n")
    huecos = (0, 1, 2, 3, 4, 6, 8, 12)
    print(f"   {'ventana':>8} |" + "".join(f"{h:>7}" for h in huecos))
    for ventana in (0.35, 0.45, 0.55, 0.70):
        fila = f"   {ventana:>8.2f} |"
        for h in huecos:
            cfg = Config()
            cfg.ventana_swipe = ventana
            recorrido = _tramo(0.25, 0.75, 0.35)
            corte = len(recorrido) // 2
            muestras = (
                [mano(0.25)] * 12
                + recorrido[:corte] + [None] * h + recorrido[corte:]
                + [mano(0.75)] * 10
            )
            fila += f"{'ok' if _correr(cfg, muestras) else 'FALLA':>7}"
        print(fila)


def tabla_lentitud():
    """Hasta qué lentitud sigue contando un golpe deliberado.

    `ventana_swipe` es una velocidad mínima disfrazada, y esto dice dónde queda
    el corte: por debajo de esa velocidad, mover la mano deja de ser un gesto.
    """
    print("\n── ¿Hasta qué lentitud cuenta un swipe deliberado? ──\n")
    for duracion in (0.20, 0.35, 0.50, 0.65, 0.80, 0.95, 1.20):
        muestras = [mano(0.25)] * 12 + _tramo(0.25, 0.75, duracion) + [mano(0.75)] * 20
        marca = "dispara" if _correr(Config(), muestras) else "NO dispara"
        print(f"   cruzar medio cuadro en {duracion:.2f} s → {marca}")


def valores_actuales():
    cfg = Config()
    print("\n── Lo que hay puesto ahora ──\n")
    for campo in ("umbral_swipe", "ventana_swipe", "cooldown_swipe", "gracia_perdida",
                  "paso_arrastre", "intervalo_paso", "pellizco_entra", "pellizco_sale",
                  "alcance_indice_min", "dedos_veto_pellizco", "frames_confirmacion"):
        print(f"   {campo:22} {getattr(cfg, campo)}")


if __name__ == "__main__":
    valores_actuales()
    print()
    tabla_regresos()
    tabla_encadenado()
    tabla_huecos()
    tabla_lentitud()
    print("\n(D=derecha · I=izquierda · '-'=ningún swipe)")
