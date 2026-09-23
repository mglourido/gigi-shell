"""Motor de gestos: de 21 puntos de una mano a una intención.

Este módulo es PURO a propósito: no importa mediapipe, ni cv2, ni habla con
Hyprland. Recibe listas de tuplas `(x, y, z)` normalizadas 0..1 y un instante
monótono, y devuelve eventos. Todo lo demás vive en `gestos.py`.

La separación no es estética. El motor es la parte que hay que CALIBRAR —umbrales
de swipe, histéresis del pellizco, cuánta quietud exigir— y calibrar contra una
cámara real es insoportable: hay que ponerse delante, mover la mano y adivinar por
qué no ha disparado. Siendo puro se prueba con recorridos sintéticos en
milisegundos (`deteccion_test.py`) y con el intérprete del sistema, sin el venv.

── EL PROBLEMA DE VERDAD NO ES DETECTAR, ES NO DETECTAR DE MÁS ────────────────
Reconocer "la mano se ha movido a la derecha" es fácil. Lo difícil es que
rascarte la nariz no te cambie de escritorio, y sobre todo que **el gesto de
vuelta no dispare el contrario**: mueves la mano a la derecha (cambia de
escritorio), la traes de vuelta al centro para repetir... y ese regreso es un
recorrido hacia la izquierda idéntico al que se acaba de aceptar. Un detector
ingenuo alterna escritorios y se queda donde estaba.

Se resuelve con el estado REPOSO: tras aceptar un swipe hay un tiempo muerto
(`cooldown_swipe`) y, al salir de él, **se TIRA el trayecto**. Esas dos cosas
juntas son lo que mata el regreso: su primer tramo cae dentro del tiempo muerto y
no se mira, y el resto empieza a contar desde cero, así que casi nunca llega al
umbral.

Hubo una versión que en vez del tiempo muerto exigía que la mano se PARARA, y
técnicamente funcionaba mejor contra el regreso. Se retiró porque era el mayor
estorbo del modo: obligaba a levantar la mano y quedarse quieto antes del primer
gesto, y a frenar del todo entre uno y el siguiente — no se podía ir a la
izquierda y volver a la derecha de un tirón. El tiempo muerto no pide nada al
usuario, y lo que pierde está medido en `deteccion_test.py`.

── POR QUÉ EL CENTRO DE LA PALMA Y NO LA MUÑECA ──────────────────────────────
La muñeca (punto 0) es el landmark más ruidoso del modelo: está en el borde del
recorte que MediaPipe hace de la mano y su estimación baila varios puntos
porcentuales entre frames aunque la mano esté inmóvil. Ese temblor se traduce en
velocidad aparente, y la velocidad es justo lo que decide si la mano está quieta.
Se usa la media de la muñeca y los cuatro nudillos (5, 9, 13, 17), que es el
centro geométrico de la palma y promedia el ruido de cinco estimaciones.
"""

from __future__ import annotations

import math
from collections import deque
from dataclasses import dataclass, field
from enum import Enum

# ── Índices de los 21 landmarks de MediaPipe Hands ──────────────────────────
MUNECA = 0
PULGAR_IP, PULGAR_PUNTA = 3, 4
# Por dedo: (nudillo MCP, articulación PIP, punta TIP)
DEDOS = (
    (5, 6, 8),    # índice
    (9, 10, 12),  # corazón
    (13, 14, 16), # anular
    (17, 18, 20), # meñique
)
NUDILLOS = (5, 9, 13, 17)
CORAZON_MCP = 9


class Postura(Enum):
    """Lo que la mano ESTÁ haciendo en un frame, sin memoria."""
    NINGUNA = "ninguna"      # no hay mano en el cuadro
    ABIERTA = "abierta"      # palma extendida: arma el swipe
    PUNO = "puno"            # puño cerrado: el "no me hagas caso"
    PELLIZCO = "pellizco"    # pulgar e índice juntos: agarra la ventana
    OTRA = "otra"            # una mano cualquiera que no es ninguna de las tres


class Estado(Enum):
    """Dónde está la máquina, con memoria."""
    BUSCANDO = "buscando"        # sin mano
    NEUTRO = "neutro"            # puño: pausa explícita del usuario
    ARMADO = "armado"            # palma abierta y lista para un swipe
    REPOSO = "reposo"            # acaba de disparar; espera a que la mano pare
    ARRASTRANDO = "arrastrando"  # pellizco activo moviendo una ventana
    ESPERA = "espera"            # en pausa LARGA: solo se mira el doble cierre


@dataclass
class Config:
    """Umbrales. Todo lo espacial va en FRACCIÓN DEL ANCHO DEL CUADRO, no en
    píxeles: así los mismos números valen a 640x480 y a 1280x720, y cambiar la
    resolución de captura no descalibra los gestos."""

    #: Recorrido horizontal mínimo para aceptar un swipe.
    umbral_swipe: float = 0.20
    #: Ventana temporal en la que ese recorrido tiene que caber (s).
    #:
    #: Es, de hecho, una VELOCIDAD MÍNIMA disfrazada: exigir 0.20 de recorrido en
    #: 0.35 s es pedir 0,57 anchos de cuadro por segundo. Bajó de 0.70 a 0.35 al
    #: quitar el rearme por quietud, y medido resultó ser estrictamente mejor —
    #: con 0.70 el regreso relajado de la mano (0,9 s y 1,3 s) disparaba el gesto
    #: contrario, y con 0.35 no; un golpe deliberado, incluso lento (0,55 s),
    #: sigue disparando igual. La contrapartida es que un deslizamiento MUY lento
    #: (más de ~0,9 s para cruzar medio cuadro) ya no cuenta: un swipe es un
    #: golpe seco, y eso es lo que lo separa de mover la mano por moverla.
    ventana_swipe: float = 0.35
    #: Tiempo muerto tras aceptar un swipe, antes de admitir el siguiente (s).
    #:
    #: ⚠️ ANTES ESTO ERA "espera a que la mano se PARE", y era el mayor estorbo
    #: del modo. Obligaba a: levantar la mano y quedarse quieto un instante antes
    #: del primer gesto, y frenar del todo entre uno y el siguiente — no se podía
    #: ir a la izquierda y volver a la derecha de un tirón.
    #:
    #: El tiempo muerto resuelve lo mismo que la quietud (que el viaje de VUELTA
    #: de la mano no dispare el gesto contrario) sin pedir nada al usuario,
    #: porque al rearmar se TIRA el trayecto: el tramo de vuelta que cae dentro
    #: del tiempo muerto no se mira, y lo que queda después casi nunca llega al
    #: umbral. Ver `_swipe` y la medición de hasta qué velocidad de retorno
    #: aguanta.
    #: Medido con un barrido (golpe de ida de 0,25 s y regresos a distintas
    #: velocidades). El compromiso es directo y no hay valor que gane en todo:
    #:
    #:     cooldown   regresos que disparan por error   encadenar a propósito
    #:       0.35 s   los de 0,55 s y 0,70 s            con 0,20 s entre golpes
    #:       0.45 s   el de 0,70 s                      con 0,40 s
    #:       0.55 s   ninguno                           con 0,40 s
    #:
    #: 0.55 es estrictamente mejor que 0.45 (mismo coste de encadenado, cero
    #: errores), así que es el valor de fábrica. Se puede bajar desde Ajustes
    #: para encadenar más deprisa a cambio de que algún regreso cuele.
    cooldown_swipe: float = 0.55
    #: Pellizco: distancia pulgar-índice dividida por el tamaño de la mano.
    #: Dos umbrales, no uno — ver `_actualizar_pellizco`.
    #:
    #: Medido (mediana): puño 0.26 · pellizco 0.36 · mano abierta 0.98. Nótese
    #: que **el puño puntúa MÁS BAJO que el pellizco**: por esta medida sola un
    #: puño es «más pellizco» que un pellizco, que es exactamente por qué hacen
    #: falta `alcance_indice_min` y el veto de los cuatro dedos.
    #:
    #: ⚠️ ESTUVO EN 0.55 Y HUBO QUE DEVOLVERLO. Se subió para dar margen al
    #: pellizco (0.36 dejaba solo nueve centésimas), y el margen que se quitó fue
    #: el de la MANO ABIERTA: reportado, «cuando tengo la mano abierta a veces me
    #: detecta el pellizco». Los 0.98 de la mano abierta son de una pose con los
    #: dedos bien separados; relajada y en movimiento baja mucho más de lo que
    #: sugiere ese número. El margen del pellizco lo da ahora `alcance_indice`,
    #: que es donde estaba el problema de verdad.
    pellizco_entra: float = 0.45
    pellizco_sale: float = 0.70
    #: Con este número de dedos largos estirados NO puede ser un pellizco, se
    #: junten o no el pulgar y el índice. Ver `_actualizar_pellizco`.
    dedos_veto_pellizco: int = 4
    #: Cuánto tiene que sobresalir la punta del índice para que la unión
    #: pulgar-índice cuente como pellizco y no como puño. Ver `alcance_indice`.
    #:
    #: MEDIDO con `--calibrar` sobre una mano real, 120 muestras por postura y
    #: distribuciones muy cerradas (p05 ≈ p95):
    #:
    #:     puño      0.78 – 0.80
    #:     pellizco  1.19 – 1.21
    #:     abierta   1.77 – 1.78
    #:
    #: ⚠️ EL CORTE NO VA EN EL PUNTO MEDIO, Y AHÍ ESTÁ TODO EL ASUNTO. El medio
    #: sería 0.99 — casi el 1.00 que había cuando se reportó «para que detecte
    #: pellizco tienes que colocar muy bien la mano». Y no era mentira ni una
    #: contradicción: esos 1.19 se miden **posando la mano cuatro segundos**,
    #: mientras que un pellizco de verdad, hecho de pasada y con la mano en
    #: movimiento, cae bastante más bajo. La calibración mide tu mejor pose, no
    #: tu pose habitual.
    #:
    #: Los dos errores tampoco cuestan lo mismo: un puño leído como pellizco
    #: agarra una ventana y se suelta abriendo la mano —molesto y reversible—,
    #: mientras que un pellizco que no registra hace el gesto INUTILIZABLE. Con
    #: costes asimétricos, el corte se acerca al lado estable: el puño, que
    #: apenas varía (0.78–0.80). 0.90 deja 0.10 de margen sobre el puño y tolera
    #: un pellizco que caiga muy por debajo de su valor posado.
    alcance_indice_min: float = 0.90
    #: Frames seguidos con la misma postura antes de creérsela. Filtra el frame
    #: suelto en que el modelo ve un puño mientras cierras la mano.
    frames_confirmacion: int = 3
    #: Cuánto se tolera que el modelo PIERDA la mano sin dar nada por terminado.
    #:
    #: ⚠️ Es el número que más afecta a que el modo "funcione a veces sí y a
    #: veces no", y sin él valía 0. Medido: UN SOLO frame sin mano tiraba el
    #: trayecto entero, mataba el swipe en curso y devolvía la máquina a
    #: BUSCANDO, con 0,40 s más de rearme. Y perder la mano un frame es
    #: exactamente lo que pasa cuando la mueves deprisa: con la exposición de una
    #: webcam corriente (31 ms medidos en esta) la mano sale borrosa justo en los
    #: frames del gesto.
    gracia_perdida: float = 0.35
    #: Recorrido de la mano que provoca UN paso de recolocación en el mosaico.
    #: Más corto que el swipe (0.20) a propósito: aquí ya estás pellizcando, o
    #: sea que la intención está declarada y no hace falta un gesto amplio para
    #: distinguirla de un movimiento cualquiera.
    paso_arrastre: float = 0.11
    #: Tiempo mínimo entre dos pasos (s). Ver `Motor._paso`.
    intervalo_paso: float = 0.28
    #: Amplificación del movimiento al arrastrar, **solo para una ventana que YA
    #: estaba flotando**. Una en mosaico no se mueve a coordenadas, se recoloca
    #: por pasos, y este número no la afecta. Con 1.0 hay que recorrer la
    #: pantalla entera con la mano; 1.8 la cruza con un gesto cómodo.
    ganancia_arrastre: float = 1.8
    #: Cuánto pueden tardar los dos pellizcos del gesto de flotar (s). Más corta
    #: que la del gesto de espera porque aquí solo hay DOS cambios de postura
    #: confirmados de por medio (pellizco → suelto → pellizco), no cuatro.
    ventana_doble_pellizco: float = 1.2
    #: Un pellizco más largo que esto ya no cuenta como "rápido": es un agarre.
    #: Es lo que separa «dos toques» de «he soltado y he vuelto a agarrar para
    #: seguir moviendo la ventana», que es lo que uno hace continuamente.
    tap_pellizco_max: float = 0.45
    #: Cuánto pueden tardar los dos cierres del gesto de espera (s).
    #:
    #: No puede ser mucho más corto, y el suelo no lo pone la mano sino
    #: `frames_confirmacion`: abrir-cerrar dos veces son CUATRO cambios de
    #: postura, y cada uno necesita 3 frames seguidos para confirmarse — a 15 fps
    #: eso ya son 0,8 s solo de confirmación. Con una ventana de 1 s el gesto
    #: sería imposible de hacer y parecería que no funciona.
    ventana_doble: float = 1.8
    #: Interruptores por gesto (Ajustes > Cámara > Gestos).
    swipe_activo: bool = True
    pellizco_activo: bool = True
    puno_activo: bool = True
    espera_activa: bool = True
    doble_pellizco_activo: bool = True


@dataclass
class Evento:
    """Lo que el motor decide que ha pasado. `gestos.py` lo traduce a órdenes."""
    #: swipe | arrastre-inicio | arrastre | arrastre-paso | arrastre-fin |
    #: espera | flotar
    tipo: str
    #: swipe → izquierda | derecha
    #: arrastre-paso → izquierda | derecha | arriba | abajo
    #: espera → entrar | salir
    direccion: str | None = None
    #: Solo en `arrastre`: desplazamiento acumulado desde el ancla fija, en
    #: fracción de cuadro y ya amplificado. `arrastre-paso` no lo usa — un paso
    #: es una dirección, no una distancia.
    dx: float = 0.0
    dy: float = 0.0


@dataclass
class _Muestra:
    t: float
    x: float
    y: float


# ── Geometría ───────────────────────────────────────────────────────────────

def _dist(a, b) -> float:
    """Distancia 2D. La Z de MediaPipe es una profundidad RELATIVA a la muñeca
    en unidades que no son las de X/Y, así que meterla en la distancia mezcla
    escalas y estropea las dos medidas que dependen de ella (dedo extendido y
    pellizco). Se ignora a propósito."""
    return math.hypot(a[0] - b[0], a[1] - b[1])


def centro_palma(puntos) -> tuple[float, float]:
    """Media de muñeca y nudillos. Ver la cabecera: promedia el ruido."""
    idx = (MUNECA,) + NUDILLOS
    return (
        sum(puntos[i][0] for i in idx) / len(idx),
        sum(puntos[i][1] for i in idx) / len(idx),
    )


def escala_mano(puntos) -> float:
    """Tamaño aparente de la mano: muñeca → nudillo del corazón.

    Es el denominador de toda medida que tenga que valer igual con la mano
    cerca y lejos de la cámara. Sin normalizar, el pellizco se detectaría solo a
    una distancia concreta: acercando la mano, dos dedos separados están más
    lejos EN EL CUADRO que dos dedos juntos vistos desde atrás.

    Nunca devuelve 0: una mano degenerada (el modelo colapsando los puntos en un
    frame malo) haría una división por cero justo en el peor momento.
    """
    return max(_dist(puntos[MUNECA], puntos[CORAZON_MCP]), 1e-6)


def dedos_extendidos(puntos) -> int:
    """Cuántos de los cuatro dedos largos están estirados.

    El criterio es la DISTANCIA A LA MUÑECA de la punta frente a la de su PIP,
    no la coordenada Y. Con Y, una mano girada de lado o boca abajo da un
    recuento sin sentido — y una mano de lado es exactamente como se pone al
    hacer un swipe. Con distancias es invariante al giro.

    El pulgar no cuenta: al cerrar el puño queda por encima o por debajo de los
    demás según la persona, y con cualquier umbral fijo se lleva por delante la
    distinción entre puño y palma. Para lo único que hace falta el pulgar aquí
    es para el pellizco, que lo mide aparte.
    """
    munieca = puntos[MUNECA]
    n = 0
    for _mcp, pip, punta in DEDOS:
        # El 1.05 es margen contra el ruido: sin él, un dedo a medio doblar
        # alterna entre extendido y no en frames consecutivos.
        if _dist(puntos[punta], munieca) > _dist(puntos[pip], munieca) * 1.05:
            n += 1
    return n


def razon_pellizco(puntos) -> float:
    """Separación pulgar-índice en unidades de "manos". <0.45 es un pellizco."""
    return _dist(puntos[PULGAR_PUNTA], puntos[DEDOS[0][2]]) / escala_mano(puntos)


def alcance_indice(puntos) -> float:
    """Cuánto sobresale la punta del índice respecto al tamaño de la mano.

    ── ESTA FUNCIÓN EXISTE POR UN FALLO CONCRETO, NO POR COMPLETITUD ──────────
    Al cerrar el puño, la punta del pulgar queda pegada a la del índice: la
    `razon_pellizco` de un puño ronda 0.6, por debajo del umbral de salida. O
    sea que **un puño se detecta como pellizco**, y con eso se van los dos
    gestos a la vez — el "no me hagas caso" nunca llega a NEUTRO y cerrar la
    mano agarra una ventana. Lo cazó `test_el_puno_encima_del_pellizco_lo_suelta`
    antes de que ninguna mano se pusiera delante de la cámara.

    La distancia pulgar-índice no puede distinguirlos porque en los dos casos es
    corta. Lo que sí los distingue es DÓNDE está esa unión: en un pellizco el
    índice apunta hacia fuera y la punta queda lejos de la muñeca; en un puño
    está recogida contra la palma. Un pellizco pasa de 1.1; un puño no llega a
    0.8.
    """
    return _dist(puntos[DEDOS[0][2]], puntos[MUNECA]) / escala_mano(puntos)


def elegir_mano(candidatos, anterior):
    """De varias manos detectadas, cuál es LA TUYA.

    ── POR QUÉ SE PIDEN DOS MANOS SI SOLO SE USA UNA ──────────────────────────
    Con `num_hands=1` MediaPipe devuelve la detección de mayor puntuación y
    descarta el resto. Si el detector de palmas se cree una CARA —pasa, y con
    puntuación altísima: 0,98 medido— esa falsa mano ocupa la única plaza y la
    mano de verdad **no llega**. O sea que un falso positivo no añade ruido:
    TAPA la señal buena, y desde fuera se ve como "no me detecta nada".

    Pidiendo dos, la mano real sí llega y solo hay que saber elegir.

    ── LA REGLA ES CONTINUIDAD, NO PUNTUACIÓN ────────────────────────────────
    Elegir por confianza no sirve: la cara puntúa igual de alto que una mano. Lo
    que una cara no puede hacer es estar donde estaba tu mano hace 33 ms. Así que
    en cuanto hay una mano seguida, se elige la candidata MÁS CERCANA a ella y la
    cara queda descartada por lejanía, sin necesidad de saber qué es una cara.

    Sin referencia previa (primer frame, o tras perder la mano) no queda más
    remedio que la puntuación. Es el único momento en que un falso positivo puede
    colarse, y dura hasta que aparece la mano de verdad.

    `candidatos` es una lista de `(puntos, puntuacion)`; `anterior`, el centro de
    palma del último frame con mano, o `None`.
    """
    if not candidatos:
        return None
    if anterior is None:
        return max(candidatos, key=lambda c: c[1])[0]

    def lejania(candidato):
        x, y = centro_palma(candidato[0])
        return math.hypot(x - anterior[0], y - anterior[1])

    return min(candidatos, key=lejania)[0]


# ── El motor ────────────────────────────────────────────────────────────────

class Motor:
    """Máquina de estados. Una instancia por sesión de modo gestos.

    Uso:  `for evento in motor.frame(t, puntos): ...`  con `puntos=None` cuando
    el frame no trae ninguna mano. Devolver una lista (y no un evento suelto)
    permite que un frame cierre un arrastre y abra otra cosa sin perder nada.
    """

    def __init__(self, cfg: Config | None = None):
        self.cfg = cfg or Config()
        self.estado = Estado.BUSCANDO
        self.postura = Postura.NINGUNA
        # Historial del centro de la palma, podado a `ventana_swipe`.
        self._trayecto: deque[_Muestra] = deque()
        # Confirmación de postura: la candidata y cuántos frames lleva.
        self._candidata = Postura.NINGUNA
        self._repeticiones = 0
        self._pellizcando = False
        # Dos anclas, y no una: la fija mide el desplazamiento continuo desde
        # que empezó el pellizco; la de pasos se REANCLA en cada paso. Ver
        # `_paso` para por qué no puede ser la misma.
        self._ancla: tuple[float, float] | None = None
        self._ancla_paso: tuple[float, float] | None = None
        self._ultimo_paso = 0.0
        #: Cuándo se entró en REPOSO. `None` = no se está en tiempo muerto.
        self._reposo_desde: float | None = None
        #: Instantes de los pellizcos BREVES ya terminados (los "toques"),
        #: podados a `ventana_doble_pellizco`. Uno más = gesto de flotar.
        self._taps: deque[float] = deque()
        #: Cuándo empezó el pellizco en curso, y si llegó a mover la ventana.
        #: Los dos deciden si al soltarlo cuenta como toque. Ver `_tap_pellizco`.
        self._pellizco_desde: float | None = None
        self._pellizco_movio = False
        #: Este pellizco YA cerró un par y disparó el gesto de flotar. Al
        #: soltarlo no puede sembrar un toque nuevo — ver `_anotar_tap`.
        self._pellizco_disparo = False
        #: Instantes de cada CIERRE de mano (abierta → puño), podados a
        #: `ventana_doble`. Dos dentro de la ventana = gesto de espera.
        self._cierres: deque[float] = deque()
        #: Instante del último frame CON mano. `None` = no se ha visto ninguna
        #: desde el último reinicio, así que no hay nada que conservar.
        self._visto_ultimo: float | None = None
        #: Última postura que era abierta o puño, ignorando las intermedias.
        #: Ver `_doble` para por qué no vale mirar la postura del frame anterior.
        self._ultima_relevante: Postura = Postura.NINGUNA
        #: Última acción aceptada, para que el demonio la publique.
        self.ultimo_gesto: str | None = None

    # ── Postura del frame ───────────────────────────────────────────────────

    def _actualizar_pellizco(self, puntos) -> bool:
        """Pellizco con HISTÉRESIS: se entra por debajo de 0.45 y no se sale
        hasta pasar de 0.70.

        Con un solo umbral el pellizco parpadea. La razón ronda el valor de
        corte mientras sostienes el gesto (el modelo mueve la punta del pulgar
        un par de puntos entre frames), así que la ventana se agarraba y se
        soltaba varias veces por segundo: al soltar, Hyprland reanima la ventana
        hacia su sitio, y el arrastre salía a tirones en vez de seguir la mano.
        """
        razon = razon_pellizco(puntos)
        # ── VETO 1: la mano abierta no pellizca ────────────────────────────
        # Con los cuatro dedos largos estirados no hay pellizco que valga. Sale
        # de las medidas reales: la mano abierta es la ÚNICA de las tres posturas
        # con dedos=4 (el pellizco y el puño los tienen recogidos, los dos a 0),
        # así que este veto separa **sin depender de la distancia pulgar-índice**
        # — que es justo la medida que se estaba colando cuando se reportó «con
        # la mano abierta a veces me detecta el pellizco».
        #
        # El corte es 4 y no 3 a propósito: un pellizco «de OK», con el índice
        # tocando el pulgar y los otros tres estirados, cuenta 3 y tiene que
        # seguir funcionando. Solo la mano ENTERAMENTE abierta veta.
        if dedos_extendidos(puntos) >= self.cfg.dedos_veto_pellizco:
            self._pellizcando = False
            return False
        # ── VETO 2: el índice tiene que estar FUERA, no recogido ───────────
        # Es lo único que separa un pellizco de un puño, donde el pulgar también
        # toca el índice. Se exige tanto para entrar como para seguir dentro, así
        # que cerrar la mano encima de un arrastre lo suelta en vez de dejarlo
        # agarrado. Ver `alcance_indice`.
        if alcance_indice(puntos) < self.cfg.alcance_indice_min:
            self._pellizcando = False
            return False
        if self._pellizcando:
            if razon > self.cfg.pellizco_sale:
                self._pellizcando = False
        elif razon < self.cfg.pellizco_entra:
            self._pellizcando = True
        return self._pellizcando

    def _postura_cruda(self, puntos) -> Postura:
        if puntos is None:
            return Postura.NINGUNA
        # El pellizco se mira PRIMERO: una mano pellizcando tiene tres dedos
        # largos estirados, así que el recuento la llamaría "abierta" y el
        # arrastre nunca llegaría a empezar.
        if self.cfg.pellizco_activo and self._actualizar_pellizco(puntos):
            return Postura.PELLIZCO
        extendidos = dedos_extendidos(puntos)
        if extendidos >= 3:
            return Postura.ABIERTA
        if extendidos <= 1:
            return Postura.PUNO
        return Postura.OTRA

    def _confirmar(self, cruda: Postura) -> Postura:
        """Una postura no vale hasta repetirse `frames_confirmacion` veces.

        Excepción: NINGUNA entra al instante. Si la mano sale del cuadro hay que
        soltar el arrastre YA — esperar tres frames deja la ventana pegada al
        último punto conocido y, peor, si la mano vuelve a entrar por otro sitio
        la ventana pega un salto.
        """
        if cruda is Postura.NINGUNA:
            self._candidata, self._repeticiones = cruda, 0
            return cruda
        if cruda is self._candidata:
            self._repeticiones += 1
        else:
            self._candidata, self._repeticiones = cruda, 1
        if self._repeticiones >= self.cfg.frames_confirmacion:
            return cruda
        # Mientras no se confirme, se mantiene la anterior. Sostener el
        # PELLIZCO así es lo que evita soltar la ventana en el frame en que el
        # modelo pierde un dedo.
        return self.postura

    # ── Trayecto y velocidad ────────────────────────────────────────────────

    def _a_reposo(self, ahora: float) -> None:
        """Entra en el tiempo muerto posterior a un gesto."""
        self.estado = Estado.REPOSO
        self._reposo_desde = ahora

    def _podar(self, ahora: float) -> None:
        limite = ahora - self.cfg.ventana_swipe
        while self._trayecto and self._trayecto[0].t < limite:
            self._trayecto.popleft()

    def _velocidad(self) -> float:
        """Ancho de cuadro por segundo entre las dos últimas muestras.

        Deliberadamente instantánea y no promediada sobre la ventana: la usa el
        rearme, que pregunta "¿está la mano quieta AHORA?". Promediada, el
        arranque rápido de un swipe seguiría contando como movimiento medio
        segundo después de haberse parado, y el rearme llegaría tarde.
        """
        if len(self._trayecto) < 2:
            return 0.0
        a, b = self._trayecto[-2], self._trayecto[-1]
        dt = b.t - a.t
        if dt <= 0:
            return 0.0
        return math.hypot(b.x - a.x, b.y - a.y) / dt

    def _anotar_tap(self, ahora: float) -> None:
        """Al soltar un pellizco, decidir si contó como un TOQUE rápido.

        ── SIN ESTE FILTRO EL GESTO SERÍA INSUFRIBLE ──────────────────────────
        Soltar y volver a pellizcar es lo que uno hace CONSTANTEMENTE al mover
        una ventana: agarras, la llevas un trecho, sueltas para recolocar la mano
        y vuelves a agarrar. Si cualquier par de pellizcos seguidos alternara el
        flotante, arrastrar una ventana la sacaría y la metería en el mosaico
        sola cada dos por tres.

        Un toque es un pellizco **breve** (`tap_pellizco_max`) **que no llegó a
        mover la ventana**. Las dos condiciones hacen falta: la duración sola
        dejaría pasar un tirón corto que sí recolocó, y "no movió" sola dejaría
        pasar un agarre largo en el que te lo pensaste sin mover la mano.
        """
        if self._pellizco_desde is None:
            return
        breve = (ahora - self._pellizco_desde) <= self.cfg.tap_pellizco_max
        # El pellizco que YA cerró un par no siembra otro. Sin esto, tres toques
        # seguidos disparaban DOS veces (medido): el segundo —el que sostienes
        # para arrastrar— dejaba su toque al soltarse y se emparejaba con el
        # tercero, así que la ventana entraba y salía del mosaico sola. Con la
        # guarda, los toques se agrupan de dos en dos como uno espera.
        if breve and not self._pellizco_movio and not self._pellizco_disparo:
            self._taps.append(ahora)
        self._pellizco_desde = None
        self._pellizco_movio = False
        self._pellizco_disparo = False

    def _doble_pellizco(self, ahora: float) -> bool:
        """¿Este pellizco que empieza es el segundo de un par rápido?

        Se dispara al EMPEZAR el segundo y no al soltarlo, para que el mismo
        pellizco siga vivo y ya arrastre la ventana con su modo nuevo — que es
        justo lo que se pide: "dos pellizcos rápidos y la arrastro flotante".

        Se vacía la lista al disparar: si no, un tercer pellizco dentro de la
        ventana volvería a alternar y la ventana entraría y saldría del mosaico
        con la mano todavía en el gesto.
        """
        limite = ahora - self.cfg.ventana_doble_pellizco
        while self._taps and self._taps[0] < limite:
            self._taps.popleft()
        if not self._taps:
            return False
        self._taps.clear()
        return True

    def _doble(self, ahora: float) -> bool:
        """¿Se acaba de abrir y cerrar la mano DOS veces seguidas?

        Es el gesto que entra y sale del modo de espera. Se cuentan los CIERRES
        (abierta → puño): para que haya un segundo cierre hay que haber abierto
        la mano entre medias, así que contar cierres ya describe el gesto entero
        sin tener que casar una secuencia de cuatro posturas.

        ── POR QUÉ NO VALE MIRAR LA POSTURA DEL FRAME ANTERIOR ────────────────
        Cerrando la mano se pasa por posturas intermedias (dos o tres dedos
        extendidos = `OTRA`). Si el cierre es lento, esa intermedia llega a
        confirmarse y la secuencia real es ABIERTA → OTRA → PUÑO: comparando
        contra la postura inmediatamente anterior, el cierre NO se contaría y el
        gesto fallaría justo cuando se hace despacio, que es como lo hace quien
        aún no le ha cogido el punto. Se compara contra la última postura
        RELEVANTE (abierta o puño), ignorando lo que haya en medio.

        La mano saliendo del cuadro borra esa referencia: volver a entrar con el
        puño cerrado no es un cierre, es una mano que aparece cerrada.
        """
        if self.postura is Postura.NINGUNA:
            self._ultima_relevante = Postura.NINGUNA
        elif self.postura in (Postura.ABIERTA, Postura.PUNO):
            if self.postura is Postura.PUNO and self._ultima_relevante is Postura.ABIERTA:
                self._cierres.append(ahora)
            self._ultima_relevante = self.postura

        limite = ahora - self.cfg.ventana_doble
        while self._cierres and self._cierres[0] < limite:
            self._cierres.popleft()

        if len(self._cierres) < 2:
            return False
        # Se vacía al disparar: si no, un tercer cierve dentro de la ventana
        # volvería a cumplir la condición y el modo entraría y saldría de la
        # espera con la mano todavía haciendo el gesto.
        self._cierres.clear()
        return True

    def _paso(self, ahora: float, x: float, y: float) -> str | None:
        """¿Toca dar UN paso de recolocación, y hacia dónde?

        ── POR QUÉ PASOS Y NO UNA POSICIÓN ────────────────────────────────────
        Una ventana en mosaico no tiene posición propia: la decide el layout. Lo
        único que se le puede pedir es «recolócala hacia allá» y dejar que
        Hyprland rehaga el reparto. De ahí que esto devuelva una dirección y no
        unas coordenadas.

        ── EL REANCLAJE ES LO QUE HACE QUE SEA UN ARRASTRE ────────────────────
        Tras cada paso, el ancla se mueve a donde está la mano AHORA, así que
        seguir desplazándola da otro paso, y otro. Midiendo siempre desde el
        ancla inicial, en cambio, una mano que se queda quieta a 3 pasos de
        distancia seguiría cumpliendo el umbral en cada frame y la ventana se
        iría al infinito mientras no soltaras el pellizco.

        `intervalo_paso` es la otra mitad: cada paso provoca un reparto nuevo del
        mosaico con su animación, y sin él un gesto rápido encadenaba varios
        antes de que se viera ninguno — la ventana aparecía tres huecos más allá
        sin que el usuario hubiera podido seguir el recorrido.

        El eje se decide por dominancia simple (`>=`), sin exigir que uno gane
        al otro por un margen como en el swipe: aquí una diagonal no es una
        ambigüedad que haya que descartar, es alguien llevando la ventana a una
        esquina — y alternando pasos horizontales y verticales llega.
        """
        if self._ancla_paso is None:
            return None
        if ahora - self._ultimo_paso < self.cfg.intervalo_paso:
            return None
        dx = x - self._ancla_paso[0]
        dy = y - self._ancla_paso[1]
        if abs(dx) >= abs(dy):
            if abs(dx) < self.cfg.paso_arrastre:
                return None
            direccion = "derecha" if dx > 0 else "izquierda"
        else:
            if abs(dy) < self.cfg.paso_arrastre:
                return None
            direccion = "abajo" if dy > 0 else "arriba"
        self._ancla_paso = (x, y)
        self._ultimo_paso = ahora
        return direccion

    def _swipe(self) -> str | None:
        """¿Hay un recorrido horizontal limpio en la ventana?

        Se exigen DOS cosas y no una: desplazamiento neto suficiente **y** que
        sea mayoritariamente horizontal. Sin lo segundo, levantar la mano en
        diagonal para saludar cuenta como swipe; el 1.5 pide que el recorrido en
        X sea vez y media el de Y, que descarta las diagonales sin obligar a una
        horizontal de tiralíneas.
        """
        if len(self._trayecto) < 3:
            return None
        primera, ultima = self._trayecto[0], self._trayecto[-1]
        dx, dy = ultima.x - primera.x, ultima.y - primera.y
        if abs(dx) < self.cfg.umbral_swipe:
            return None
        if abs(dx) < abs(dy) * 1.5:
            return None
        # El cuadro se refleja en `gestos.py` (modo espejo), así que la X ya
        # crece hacia la derecha DEL USUARIO. Aquí no se vuelve a invertir.
        return "derecha" if dx > 0 else "izquierda"

    # ── Entrada de un frame ─────────────────────────────────────────────────

    def _hueco_breve(self, ahora: float) -> bool:
        """¿Es esto una pérdida momentánea de la mano, y no que la hayas bajado?

        El modelo pierde la mano un frame suelto continuamente: la webcam expone
        31 ms (medido en esta máquina, y no se puede bajar — en manual la imagen
        se va a 15/255), así que una mano en MOVIMIENTO sale borrosa y MediaPipe
        no la encuentra. O sea que los frames que se pierden son justo los del
        gesto, no los de la mano quieta.

        Sin esta tolerancia el efecto era brutal y silencioso: un único frame sin
        mano tiraba el trayecto, mataba el swipe a medias y devolvía la máquina a
        BUSCANDO — 0,40 s más de rearme, medido. Es la explicación de "a veces va
        y a veces no": iba cuando movías la mano despacio.

        Nunca se concede gracia si no se ha visto una mano todavía: al arrancar
        no hay ningún estado que preservar, y darla dejaría el primer frame sin
        pasar por la puesta a cero.
        """
        if self._visto_ultimo is None:
            return False
        return (ahora - self._visto_ultimo) <= self.cfg.gracia_perdida

    def frame(self, ahora: float, puntos) -> list[Evento]:
        eventos: list[Evento] = []

        if puntos is None and self._hueco_breve(ahora):
            # No se toca NADA: ni la postura, ni el trayecto, ni el estado, ni el
            # arrastre. Se finge que este frame no ha existido, que es justo lo
            # que es — un fallo de visión, no un cambio de lo que hace la mano.
            return eventos

        anterior = self.postura
        self.postura = self._confirmar(self._postura_cruda(puntos))
        if puntos is not None:
            self._visto_ultimo = ahora

        if puntos is None:
            self._trayecto.clear()
            self._pellizcando = False
            if self.estado is Estado.ARRASTRANDO:
                eventos.append(Evento("arrastre-fin"))
            self._ancla = None
            self._ancla_paso = None
            # La ESPERA sobrevive a que la mano salga del cuadro, y es lo único
            # de aquí que lo hace. Es un modo que el usuario ha pedido a
            # propósito ("no me leas ahora"), no un estado del seguimiento:
            # bajar las manos no puede deshacerlo, o el gesto no serviría de
            # nada — bajar las manos es justo lo que uno hace después.
            if self.estado is not Estado.ESPERA:
                self.estado = Estado.BUSCANDO
            # Se corta la gracia: ya se ha dado por perdida la mano, y sin esto
            # cada frame siguiente volvería a preguntar por una ventana que ya
            # expiró.
            self._visto_ultimo = None
            self._doble(ahora)  # solo para que borre la referencia de posturas
            return eventos

        x, y = centro_palma(puntos)
        self._trayecto.append(_Muestra(ahora, x, y))
        self._podar(ahora)

        # ── Espera: entrar y salir con dos aperturas seguidas ───────────────
        # Va lo PRIMERO, antes incluso del arrastre: es la única orden que tiene
        # que llegar estando el modo en espera, y también la única que puede
        # interrumpir un arrastre en curso.
        if self.cfg.espera_activa and self._doble(ahora):
            if self.estado is Estado.ESPERA:
                # Se sale a REPOSO y no a ARMADO: la mano viene de cuatro
                # cambios de postura seguidos y el trayecto está lleno de ese
                # movimiento, que dispararía un swipe fantasma al instante.
                self._a_reposo(ahora)
                self._trayecto.clear()
                eventos.append(Evento("espera", direccion="salir"))
            else:
                if self.estado is Estado.ARRASTRANDO:
                    eventos.append(Evento("arrastre-fin"))
                self._ancla = None
                self._ancla_paso = None
                self._pellizcando = False
                self.estado = Estado.ESPERA
                eventos.append(Evento("espera", direccion="entrar"))
            self.ultimo_gesto = "espera"
            return eventos

        if self.estado is Estado.ESPERA:
            # En espera NO se mira nada más. Es el sentido entero del modo.
            return eventos

        # ── Arrastre: tiene prioridad sobre todo lo demás ───────────────────
        #
        # Se emiten DOS descripciones del mismo gesto y el motor no elige entre
        # ellas, porque para elegir habría que saber si la ventana está en
        # mosaico — y eso es cosa del compositor, no de un módulo puro:
        #
        #   `arrastre`       desplazamiento CONTINUO desde el ancla fija.
        #   `arrastre-paso`  un paso DISCRETO en una dirección, con reanclaje.
        #
        # `gestos.py` usa el primero con una ventana ya flotante (moverla a una
        # coordenada es lo que significa flotar) y el segundo con una en mosaico
        # (donde la posición la decide el layout y lo único correcto es pedir
        # una recolocación). Ver su `_aplicar`.
        if self.postura is Postura.PELLIZCO:
            if self.estado is not Estado.ARRASTRANDO:
                # ¿Es el SEGUNDO pellizco rápido? Entonces esto no es un agarre
                # más: es la orden de alternar el flotante de la ventana.
                #
                # El evento va ANTES del `arrastre-inicio` a propósito: así
                # `gestos.py` alterna primero y crea el arrastre leyendo el modo
                # NUEVO, que es lo que hace que el mismo pellizco siga y ya
                # arrastre como toca (libre si acaba de quedar flotante, por
                # pasos si acaba de volver al mosaico). Al revés habría que
                # rehacer el arrastre a posteriori.
                self._pellizco_disparo = (
                    self.cfg.doble_pellizco_activo and self._doble_pellizco(ahora)
                )
                if self._pellizco_disparo:
                    eventos.append(Evento("flotar"))
                    self.ultimo_gesto = "flotar"
                self._pellizco_desde = ahora
                self._pellizco_movio = False
                self._ancla = (x, y)
                self._ancla_paso = (x, y)
                # Se arranca el reloj de pasos aquí, y no en 0: el propio gesto
                # de juntar los dedos mueve algo la mano, y sin esta gracia el
                # primer paso salía del acto de pellizcar, no de mover.
                self._ultimo_paso = ahora
                self.estado = Estado.ARRASTRANDO
                self.ultimo_gesto = "pellizco"
                eventos.append(Evento("arrastre-inicio"))
                return eventos
            if self._ancla is not None:
                eventos.append(Evento(
                    "arrastre",
                    dx=(x - self._ancla[0]) * self.cfg.ganancia_arrastre,
                    dy=(y - self._ancla[1]) * self.cfg.ganancia_arrastre,
                ))
            direccion = self._paso(ahora, x, y)
            if direccion:
                self._pellizco_movio = True
                eventos.append(Evento("arrastre-paso", direccion=direccion))
            return eventos

        if self.estado is Estado.ARRASTRANDO:
            # Se ha soltado el pellizco (o se ha cerrado el puño encima).
            self._anotar_tap(ahora)
            eventos.append(Evento("arrastre-fin"))
            self._ancla = None
            self._ancla_paso = None
            # Se cae a REPOSO, no a ARMADO: la mano viene de moverse mucho y
            # abrirla justo después del arrastre dispararía un swipe fantasma
            # con el propio recorrido del arrastre, que sigue en el trayecto.
            self._a_reposo(ahora)
            return eventos

        # ── Puño: pausa explícita ───────────────────────────────────────────
        if self.postura is Postura.PUNO and self.cfg.puno_activo:
            self.estado = Estado.NEUTRO
            return eventos

        # ── Rearme tras disparar ────────────────────────────────────────────
        if self.estado is Estado.REPOSO:
            if self._reposo_desde is not None and \
                    ahora - self._reposo_desde < self.cfg.cooldown_swipe:
                return eventos
            # Se rearma por TIEMPO, no por quietud. El trayecto se tira aquí:
            # conservarlo dejaría dentro el viaje de vuelta de la mano, que
            # cumple el umbral de sobra y dispararía el swipe contrario en el
            # primer frame armado — que es justo lo que el tiempo muerto existe
            # para evitar.
            self.estado = Estado.ARMADO
            self._reposo_desde = None
            self._trayecto.clear()

        # ── Mano abierta: armar y mirar si hay swipe ───────────────────────
        if self.postura is Postura.ABIERTA:
            if self.estado in (Estado.BUSCANDO, Estado.NEUTRO):
                # ARMADO en el acto, sin pedir que la mano se pare. Lo único que
                # hacía falta de aquella espera era no traerse el movimiento de
                # LEVANTAR la mano dentro del trayecto, y para eso basta con
                # tirarlo: así se puede poner la mano abierta donde sea y
                # deslizar acto seguido.
                self.estado = Estado.ARMADO
                self._reposo_desde = None
                self._trayecto.clear()
                return eventos
            if self.estado is Estado.ARMADO and self.cfg.swipe_activo:
                direccion = self._swipe()
                if direccion:
                    eventos.append(Evento("swipe", direccion=direccion))
                    self.ultimo_gesto = f"swipe-{direccion}"
                    self._a_reposo(ahora)
                    self._trayecto.clear()
            return eventos

        # Postura OTRA (mano a medio cerrar, o de canto): no se hace nada, pero
        # tampoco se pierde el estado — soltar el armado aquí obligaría a
        # rearmar cada vez que el modelo duda un par de frames.
        if anterior is Postura.NINGUNA:
            self.estado = Estado.REPOSO
        return eventos
