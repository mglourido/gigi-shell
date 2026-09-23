#!/usr/bin/env python3
"""
acento-fondo.py — saca la paleta de acentos del shell a partir de un fondo de escritorio.

    acento-fondo.py <ruta-de-la-imagen>

SALIDA: una línea JSON `{"acentos": [3 hex], "brutos": [3 hex]}` por stdout.
`brutos` son los colores tal cual salieron de la imagen y `acentos` los mismos ya
corregidos para que se lean sobre la barra; se devuelven los dos porque cuando un
acento sorprende lo primero que hay que saber es si la culpa es de la extracción o
de la corrección.

SON TRES Y NO UNO, y esto es lo que hace que la barra cambie de verdad. El tema
tiene tres acentos con papeles distintos —el violeta de los workspaces y el reloj,
el azul de los controles, el turquesa de los iconos— y colapsarlos en un color deja
la barra monocroma. Van ordenados por peso: `acentos[0]` es el principal.

CÓDIGOS DE SALIDA: 0 con línea. Cualquier fallo (Pillow ausente, imagen ilegible,
ruta vacía, fondo sin color) sale con 1 y SIN línea, y el llamador se queda con la
paleta de fábrica del tema. Un fondo no puede dejar el shell sin colores.

⚠️ EL FONDO SIN COLOR SE DISTINGUE POR STDERR, y no es un adorno: es la única
respuesta que el llamador puede CACHEAR. `sin-acento` por stderr (con rc 1) quiere
decir "esta imagen no tiene acento que sacar", que es una propiedad de la imagen y
vale para siempre; los demás fallos con rc 1 son del entorno (Pillow desinstalado,
fichero a medio copiar) y cachearlos congelaría el tema de fábrica hasta que
alguien vaciara la caché a mano. `execAsync` de AGS solo entrega stderr —el código
de salida no llega—, así que la marca va por ahí.

QUIÉN LO LLAMA: `servicios/fondos/acento.ts` de AGS, cada vez que cambia el fondo
y solo si el ajuste "acento adaptativo" está activado. No lo llama `wallpaper.sh`:
el acento es cosa del shell, no de quien aplica el fondo, y así el arranque de la
sesión —que aplica fondo antes de que AGS exista— no paga esto.

POR QUÉ NO VALEN LOS COLORES DOMINANTES A SECAS
-----------------------------------------------
El dominante de casi cualquier foto es un gris o un marrón apagado, y sobre la
barra (negro casi puro) eso no se distingue del texto atenuado: el acento tiene que
CANTAR. Por eso la puntuación premia la saturación por encima de la cobertura, y
por eso después hay una corrección con suelo de saturación y de luminosidad más una
comprobación de contraste WCAG contra el fondo de la barra. Sin ese suelo, un fondo
de bosque nocturno daba un verde oscuro que sobre negro era ilegible; sin el techo
de la cobertura en la puntuación, cuatro píxeles de neón se llevaban el acento.

⚠️ LA SATURACIÓN HSV NO SIRVE PARA DESCARTAR GRISES, Y ESTE ES EL FALLO MEDIDO
------------------------------------------------------------------------------
`#010000` (negro, a efectos prácticos) tiene saturación **1.0** en HSV, y `#0f1318`
tiene 0.37: filtrar por `s` deja pasar justo los colores cuyo TONO es ruido de
cuantización, y como el tono es lo único que la corrección respeta, el acento
salía inventado. Medido sobre la carpeta real: `gojo.png` (dominante `#010000`)
daba un rojo puro `#f00c0c`, y `arcade_decay_red.png` (`#0f1318`) daba un AZUL.
El filtro que sí discrimina es el **croma absoluto** `max(rgb) - min(rgb)`, que no
se dispara al acercarse al negro ni al blanco. Un fondo de verdad gris (una captura,
un boceto a lápiz) no tiene acento que sacar: se sale con 1 y el tema se queda con
el suyo, que es la respuesta honesta y no un color inventado.
"""

from __future__ import annotations

import colorsys
import json
import sys

# Lo que se escribe en stderr cuando la imagen no tiene acento que sacar. Es
# CONTRATO con `servicios/fondos/acento.ts`: ver la nota de los códigos de salida.
MARCA_SIN_ACENTO = "sin-acento"


class SinAcento(Exception):
    """La imagen no tiene ningún color del que sacar un acento."""

# Fondo contra el que se mide el contraste: `$bg-bar` de `estilos/_colores.scss`.
FONDO_BARRA = (8, 8, 12)

# Suelos de la corrección. Son deliberadamente altos: el acento histórico del tema
# es #89b4fa (s=0.45, v=0.98), así que cualquier cosa por debajo se vería como un
# color "roto" al lado del resto de la paleta, no como una elección.
SAT_MIN, SAT_MAX = 0.42, 0.95
VAL_MIN = 0.72
CONTRASTE_MIN = 4.5   # AA de WCAG para texto normal

# Un candidato tiene que tener color de verdad para que su TONO signifique algo.
# El primer umbral es el bueno; el segundo es el segundo intento para fondos de
# paleta apagada (nieblas, sepias) antes de rendirse. Ver la nota del croma arriba.
CROMA_MIN = 24
CROMA_MIN_RELAJADO = 10

# ...y el croma tampoco basta SOLO, por el motivo simétrico: es absoluto, así que un
# beige (#c0b0a7) o una tinta china sobre crema (#f0ebd8) lo pasan de sobra mientras
# su tono sigue siendo ruido — y como la corrección de abajo sube la saturación hasta
# 0,42 conservando el tono, el acento salía INVENTADO: naranja de una foto gris de un
# gato, amarillo de un dibujo a tinta en blanco y negro. Medido sobre la carpeta real.
# El suelo de saturación RELATIVA (croma/max, o sea la `s` de HSV) es lo que descarta
# eso sin tocar los colores de verdad apagados. También arregla el caso contrario: en
# una foto con neones, un cielo lavado que ocupa media imagen le ganaba el acento
# principal a los neones por cobertura.
SAT_MIN_CANDIDATO = 0.20
SAT_MIN_CANDIDATO_RELAJADO = 0.16
VAL_MIN_CANDIDATO, VAL_MAX_CANDIDATO = 0.12, 0.96

# Separación mínima entre los tonos de la paleta, en vueltas de la rueda de color
# (0.07 ≈ 25°). Sin ella los tres acentos salían del mismo cielo azul de la foto y
# el resultado era justo el monocromo que tener tres viene a evitar.
SEPARACION_TONO = 0.07

# Giro para inventar los análogos cuando la imagen no da tonos suficientes
# (0.083 = 30°). Ver `paleta()`.
GIRO_ANALOGO = 0.083


def luminancia(rgb: tuple[int, int, int]) -> float:
    def canal(c: float) -> float:
        c /= 255.0
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4
    r, g, b = (canal(c) for c in rgb)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contraste(a: tuple[int, int, int], b: tuple[int, int, int]) -> float:
    la, lb = luminancia(a), luminancia(b)
    claro, oscuro = max(la, lb), min(la, lb)
    return (claro + 0.05) / (oscuro + 0.05)


def candidatos(ruta: str) -> list[tuple[int, int, int]]:
    """Los colores con color de la imagen, del más 'de la casa' al menos."""
    import warnings

    from PIL import Image

    with warnings.catch_warnings():
        # Un 4K comprimido dispara DecompressionBombWarning de Pillow, que iría a
        # stderr en cada cambio de fondo por una imagen que el usuario eligió a mano.
        warnings.simplefilter("ignore")
        with Image.open(ruta) as im:
            # `draft()` es GRATIS y ahorra un tercio del coste en los JPEG: le pide
            # al decodificador que descomprima ya reducido (la escala 1/2, 1/4 o 1/8
            # del propio DCT), así que el 4K nunca llega a existir entero en RAM. En
            # PNG no hace nada —no hay decodificado parcial que pedir— y por eso el
            # resultado de esos no cambia ni un dígito respecto a antes.
            im.draft("RGB", (160, 160))
            # El convert va ANTES del thumbnail a propósito: reducir una imagen en
            # modo P (paleta) resampla ÍNDICES, que Pillow resuelve con NEAREST, y
            # eso cambia los colores que se miden. Cuesta unos ms de más en los
            # pocos fondos que son P y mantiene la medición igual para todos.
            im = im.convert("RGB")
            # 160 px de lado basta: buscamos la paleta, no el detalle, y esto deja el
            # coste por debajo de los 200 ms incluso con un 4K.
            im.thumbnail((160, 160))
            # 24 colores y no 16: con tres acentos que sacar hacen falta más tonos
            # sobre la mesa para que la separación mínima tenga de dónde elegir.
            cuantizada = im.quantize(colors=24, method=Image.Quantize.MEDIANCUT)
            colores = cuantizada.convert("RGB").getcolors(maxcolors=1 << 16) or []

    if not colores:
        return []

    total = sum(n for n, _ in colores)

    def puntuar(croma_min: int, sat_min: float) -> list[tuple[int, int, int]]:
        puntuados = []
        for n, rgb in colores:
            if max(rgb) - min(rgb) < croma_min:
                continue
            _, s, v = colorsys.rgb_to_hsv(*(c / 255 for c in rgb))
            if s < sat_min:
                continue
            if not (VAL_MIN_CANDIDATO <= v <= VAL_MAX_CANDIDATO):
                continue
            cobertura = n / total
            # La cobertura entra con exponente < 1 para APLASTAR su ventaja: un color
            # que ocupa el 40 % solo vale ~2,3 veces uno que ocupa el 3 %, no 13. Así
            # el cielo de una foto no gana siempre por tamaño.
            puntos = (cobertura ** 0.45) * (0.10 + s) * (0.35 + min(v, 0.9))
            puntuados.append((puntos, rgb))
        puntuados.sort(key=lambda par: par[0], reverse=True)
        return [rgb for _, rgb in puntuados]

    return (puntuar(CROMA_MIN, SAT_MIN_CANDIDATO)
            or puntuar(CROMA_MIN_RELAJADO, SAT_MIN_CANDIDATO_RELAJADO))


def distancia_tono(a: float, b: float) -> float:
    """Separación entre dos tonos en la rueda de color, en vueltas (0..0.5)."""
    d = abs(a - b) % 1.0
    return min(d, 1.0 - d)


def paleta(ruta: str, cuantos: int = 3) -> list[tuple[int, int, int]]:
    """Los `cuantos` colores más de la casa, con TONOS DISTINTOS entre sí.

    La separación mínima es el punto: sin ella los tres salen del mismo cielo azul
    de la foto y el resultado es el monocromo que tener tres viene a evitar.

    Y cuando la imagen de verdad no tiene tantos tonos (un fondo carmesí entero) no
    se repite el mismo color: se GIRA el principal para sacar sus análogos, que da
    una paleta armónica en vez de tres copias del mismo acento.
    """
    elegidos: list[tuple[int, int, int]] = []
    tonos: list[float] = []
    for rgb in candidatos(ruta):
        h, _, _ = colorsys.rgb_to_hsv(*(c / 255 for c in rgb))
        if all(distancia_tono(h, t) >= SEPARACION_TONO for t in tonos):
            elegidos.append(rgb)
            tonos.append(h)
            if len(elegidos) == cuantos:
                return elegidos

    if not elegidos:
        raise SinAcento("fondo sin color del que sacar un acento")

    # El giro alterna de signo para que los derivados caigan a lado y lado del
    # principal en la rueda, en vez de amontonarse todos hacia el mismo sitio.
    h, s, v = colorsys.rgb_to_hsv(*(c / 255 for c in elegidos[0]))
    giros = [GIRO_ANALOGO, -GIRO_ANALOGO, 2 * GIRO_ANALOGO]
    while len(elegidos) < cuantos:
        giro = giros[len(elegidos) - 1]
        elegidos.append(tuple(round(c * 255) for c in colorsys.hsv_to_rgb((h + giro) % 1.0, s, v)))
    return elegidos


def corregir(rgb: tuple[int, int, int]) -> tuple[int, int, int]:
    """Sube el color hasta que se lea sobre la barra, conservando su TONO."""
    h, s, v = colorsys.rgb_to_hsv(*(c / 255 for c in rgb))
    # El tono es lo único intocable: es lo que ata el acento al fondo. Saturación
    # y luminosidad son negociables porque de ellas depende que se vea.
    s = min(max(s, SAT_MIN), SAT_MAX)
    v = max(v, VAL_MIN)

    def a_rgb(h: float, s: float, v: float) -> tuple[int, int, int]:
        return tuple(round(c * 255) for c in colorsys.hsv_to_rgb(h, s, v))

    # Primero se sube el brillo, que es lo que menos desvirtúa el tono.
    while v < 1.0 and contraste(a_rgb(h, s, v), FONDO_BARRA) < CONTRASTE_MIN:
        v = min(1.0, v + 0.02)
    # Y solo si con v=1 sigue sin llegar (azules y rojos puros, que son oscuros por
    # naturaleza) se lava la saturación: mejor un acento pastel que uno ilegible.
    while s > 0.20 and contraste(a_rgb(h, s, v), FONDO_BARRA) < CONTRASTE_MIN:
        s -= 0.02

    return a_rgb(h, s, v)


def hexa(rgb: tuple[int, int, int]) -> str:
    return "#%02x%02x%02x" % rgb


def main(argv: list[str]) -> int:
    args = [a for a in argv[1:] if not a.startswith("--")]
    if not args:
        return 1
    try:
        brutos = paleta(args[0])
    except SinAcento:
        print(MARCA_SIN_ACENTO, file=sys.stderr)
        return 1
    except Exception:
        return 1
    print(json.dumps({
        "acentos": [hexa(corregir(rgb)) for rgb in brutos],
        "brutos": [hexa(rgb) for rgb in brutos],
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
