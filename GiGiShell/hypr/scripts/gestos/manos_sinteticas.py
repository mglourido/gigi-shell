"""Manos sintéticas: los 21 landmarks de MediaPipe fabricados a mano.

Las usan `deteccion_test.py` (las pruebas del motor) y `barrido.py` (el barrido
de parámetros). Vive en su propio módulo, y **eso no es organización: es que
`barrido.py` no puede importar del fichero de pruebas**. El `.gitignore` de este
repo ignora `*_test.py` a propósito —hay hasta un hook de pre-push que rechaza el
push si alguno acaba rastreado— así que en un checkout limpio el fichero de
pruebas NO EXISTE, y una herramienta que dependiera de él fallaría al importar en
cualquier máquina que no fuera la de desarrollo.

── ⚠️ UNA MANO SINTÉTICA NO SIRVE PARA FIJAR UMBRALES ────────────────────────
Sirve para escribir y probar la LÓGICA (que un recorrido a la derecha produzca un
swipe a la derecha, que perder un frame no tire el gesto). No sirve para decidir
dónde va un corte, y en este módulo eso se aprendió tres veces por las malas:

  - `alcance_indice_min` se fijó en 1.00 mirando la mano de aquí, que pellizcaba
    con el índice mucho más estirado de lo que pellizca nadie. En uso real
    obligaba a «colocar muy bien la mano, si no dice puño».
  - El pellizco de aquí tenía los CUATRO dedos estirados. Cuando se añadió el
    veto de «cuatro dedos estirados no es un pellizco» —que arregla los falsos
    pellizcos con la mano abierta— tumbó quince pruebas que describían una
    postura imposible.
  - Y con ese mismo fixture, una prueba afirmaba que con el pellizco desactivado
    la mano queda como ABIERTA. Queda como PUÑO: un pellizco real tiene los
    dedos recogidos igual que un puño.

Hoy el pellizco de `mano()` está construido contra medidas reales tomadas con
`gestos.py --calibrar` (razón 0.36, alcance 1.20, dedos 0). Los umbrales de
verdad se prueban aparte, contra esos números, en `TestUmbralesContraManoREAL`.
"""

from __future__ import annotations

# Fracción de cuadro que mide la mano sintética de la muñeca al nudillo del
# corazón. Es la unidad en la que el motor normaliza el pellizco.
ESCALA = 0.10


def mano(x=0.5, y=0.5, *, extendidos=4, pellizco=False):
    """21 landmarks de una mano con la palma centrada en (x, y).

    La muñeca va por debajo del centro y los nudillos por encima, a `ESCALA` de
    distancia; cada dedo sale hacia arriba desde su nudillo. Un dedo "doblado"
    pone la punta MÁS CERCA de la muñeca que su PIP, que es el criterio exacto
    que mira `dedos_extendidos`.
    """
    puntos = [(0.0, 0.0, 0.0)] * 21
    munieca = (x, y + ESCALA * 0.6)
    puntos[0] = (*munieca, 0.0)

    # Nudillos en abanico por encima de la muñeca.
    nudillos = {}
    for i, indice in enumerate((5, 9, 13, 17)):
        nx = x + (i - 1.5) * ESCALA * 0.35
        ny = y - ESCALA * 0.4
        nudillos[indice] = (nx, ny)
        puntos[indice] = (nx, ny, 0.0)
    # `escala_mano` mide muñeca → nudillo del corazón: forzamos que valga ESCALA.
    puntos[9] = (x, y + ESCALA * 0.6 - ESCALA, 0.0)
    nudillos[9] = (puntos[9][0], puntos[9][1])

    for i, (mcp, pip, punta) in enumerate(((5, 6, 8), (9, 10, 12), (13, 14, 16), (17, 18, 20))):
        nx, ny = nudillos[mcp]
        largo = ESCALA * 0.9
        if i < extendidos:
            puntos[pip] = (nx, ny - largo * 0.45, 0.0)
            puntos[punta] = (nx, ny - largo, 0.0)
        else:
            # Doblado: el PIP sigue subiendo pero la punta se RECOGE contra la
            # palma. Que la punta vuelva de verdad hacia dentro no es un detalle
            # cosmético del fixture: es lo que hace que un puño se distinga de
            # un pellizco (ver `alcance_indice`). Con la punta apenas por debajo
            # del nudillo, el puño sintético daba un alcance de índice casi
            # normal y la prueba del puño sobre el pellizco no medía nada.
            puntos[pip] = (nx, ny - largo * 0.45, 0.0)
            puntos[punta] = (nx, y + ESCALA * 0.15, 0.0)

    if pellizco:
        # ── EL PELLIZCO SE CONSTRUYE CONTRA LAS MEDIDAS REALES ──────────────
        # La primera versión lo hacía con los CUATRO dedos estirados y el pulgar
        # llevado a la punta del índice. Esa mano no existe: medido con
        # `--calibrar`, un pellizco de verdad tiene los cuatro dedos recogidos
        # (`dedos_extendidos` = 0) y el índice doblado pero con la punta hacia
        # DELANTE, lejos de la muñeca (`alcance_indice` ≈ 1.20), tocando el
        # pulgar (`razon_pellizco` ≈ 0.36).
        #
        # No es un detalle del fixture: con la mano de antes, el veto de «cuatro
        # dedos estirados no es un pellizco» —que es lo que arregla los falsos
        # pellizcos con la mano abierta— tumbaba quince pruebas que en realidad
        # estaban describiendo una postura imposible. Es la misma lección de
        # `TestUmbralesContraManoREAL`, otra vez.
        for _mcp, pip, punta in ((9, 10, 12), (13, 14, 16), (17, 18, 20)):
            nx = puntos[pip][0]
            puntos[punta] = (nx, y + ESCALA * 0.15, 0.0)
        # Índice: doblado (la punta no llega más lejos que su PIP) pero adelantado.
        puntos[6] = (x - ESCALA * 0.5, y - ESCALA * 0.6, 0.0)
        puntos[8] = (x - ESCALA * 0.3, y - ESCALA * 0.56, 0.0)
        puntos[4] = (x + ESCALA * 0.06, y - ESCALA * 0.56, 0.0)
        puntos[3] = (x + ESCALA * 0.35, y - ESCALA * 0.2, 0.0)
    else:
        puntos[4] = (x - ESCALA * 1.1, y, 0.0)
        puntos[3] = (x - ESCALA * 0.8, y + ESCALA * 0.2, 0.0)
    return puntos
