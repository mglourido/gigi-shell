#!/usr/bin/env python3
# Genera los sprites pixel-art del lagarto (caminando, colgado, tumbado; cada
# uno con variante izquierda/derecha) a partir de rejillas ASCII. Regenerar
# tras cualquier retoque:
#   python3 generar_lagarto.py
from PIL import Image
import os

TEAL = (148, 227, 213, 255)      # $teal de estilos/_colores.scss
TEAL_DARK = (94, 168, 156, 255)  # contorno/sombra, mismo tono más oscuro
EYE = (8, 8, 12, 255)            # $bg-bar, para que el ojo se lea sobre el teal

# Rejillas de caminata, en orientación "de pie" (patas abajo): se voltean al
# final para que las patas queden arriba, pegadas al borde de la barra. '.'
# vacío, '#' cuerpo, 'o' contorno/sombra, '@' ojo.
FRAME_A = [
    "..........................",
    "..........................",
    "...........#####..........",
    "........#####o###o........",
    "......#############@......",
    ".oo#################......",
    "o#####################....",
    "..o#####o###o#o####o......",
    "....o...o...o.o..o........",
    "....#...#.......#.........",
    "....#...#.......#.........",
    "..........................",
]

FRAME_B = [
    "..........................",
    "..........................",
    "...........#####..........",
    "........#####o###o........",
    "......#############@......",
    ".oo#################......",
    "o#####################....",
    "..o#####o###o#o####o......",
    "......o...o...o.o..o......",
    "......#.......#...#.......",
    "......#.......#...#.......",
    "..........................",
]

# El resto de poses se autoran YA en orientación final (patas arriba), porque
# no comparten el ciclo de marcha y así resulta más directo razonar sobre
# ellas ("¿qué toca la barra?" = fila 0).
CUERPO_FINAL = [
    "..o#####o###o#o####o......",
    "o#####################....",
    ".oo#################......",
    "......#############@......",
    "........#####o###o........",
    "...........#####..........",
]
# Tumbado: el cuerpo pegado directamente a la barra, sin ninguna pata a la
# vista — "ocultar las patas".
TUMBADO = list(CUERPO_FINAL)


def render(grid):
    h = len(grid)
    w = len(grid[0])
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    px = img.load()
    for y, row in enumerate(grid):
        for x, ch in enumerate(row):
            if ch == "#":
                px[x, y] = TEAL
            elif ch == "o":
                px[x, y] = TEAL_DARK
            elif ch == "@":
                px[x, y] = EYE
    # Recorta el margen transparente de la rejilla: sin esto el sprite lleva
    # aire de sobra por los cuatro lados y nunca queda pegado al borde real.
    bbox = img.getbbox()
    return img.crop(bbox) if bbox else img


# Colgado: 90° respecto a la caminata, colgando en vertical de las patas
# TRASERAS (las delanteras se soltaron del todo). Se construye girando el
# cuerpo entero -no una rejilla ASCII propia-, porque a mano es muy fácil
# dibujar un cuerpo en horizontal que "parece" girado pero no lo está de
# verdad (proporciones, curvatura del lomo...). Girar la silueta ya validada
# garantiza que es la MISMA silueta, solo rotada.
LARGO_PATA_COLGADO = 4


def construir_colgado() -> Image.Image:
    # ROTATE_270 (90° horario): la cola —extremo izquierdo del cuerpo en
    # horizontal, que es el que llevaba las patas traseras— queda arriba, y
    # la cabeza (el ojo) cuelga abajo. Comprobado a ojo con una rotación de
    # prueba: ROTATE_90 dejaba el ojo arriba, que es justo lo contrario de
    # "colgado boca abajo".
    cuerpo = render(CUERPO_FINAL).transpose(Image.ROTATE_270)

    ancho = cuerpo.width
    lienzo = Image.new("RGBA", (ancho, LARGO_PATA_COLGADO + cuerpo.height), (0, 0, 0, 0))
    lienzo.paste(cuerpo, (0, LARGO_PATA_COLGADO), cuerpo)

    px = lienzo.load()
    # Dos patas traseras EN VERTICAL agarrando el borde de la barra, una
    # pegada a cada lado del cuerpo (no una sola en el centro: así se lee
    # como "agarrado con las dos", no como un hilo).
    columnas_pata = (0, ancho - 1) if ancho > 1 else (0,)
    for x in columnas_pata:
        for y in range(LARGO_PATA_COLGADO):
            px[x, y] = TEAL_DARK if y == 0 else TEAL

    bbox = lienzo.getbbox()
    return lienzo.crop(bbox) if bbox else lienzo


# Escalado NEAREST (no bilineal, para no difuminar el pixel art) sobre cada
# rejilla/imagen ya recortada. 1.75 deja la caminata en ~38x16.
ESCALA = 1.75

out_dir = os.path.dirname(os.path.abspath(__file__))

# (nombre, imagen ya renderizada sin voltear, ¿hay que voltearla verticalmente
# para poner las patas arriba?)
POSES = (
    ("lagarto-a", render(FRAME_A), True),
    ("lagarto-b", render(FRAME_B), True),
    ("lagarto-tumbado", render(TUMBADO), False),
    ("lagarto-colgado", construir_colgado(), False),
)

for name, imagen, volteable in POSES:
    if volteable:
        imagen = imagen.transpose(Image.FLIP_TOP_BOTTOM)
    if ESCALA != 1:
        imagen = imagen.resize(
            (round(imagen.width * ESCALA), round(imagen.height * ESCALA)), Image.NEAREST,
        )
    imagen.save(os.path.join(out_dir, f"{name}-derecha.png"))
    imagen.transpose(Image.FLIP_LEFT_RIGHT).save(os.path.join(out_dir, f"{name}-izquierda.png"))

print("listo:", sorted(os.listdir(out_dir)))
