#!/usr/bin/env python3
"""Modo gestos: la cámara como mando del escritorio.

Lo lanza y lo para `hypr/scripts/gestos.sh` (atajo SUPER+SHIFT+G). Mientras vive,
mira por la cámara, reconoce tres gestos y se los traduce a Hyprland:

    mano abierta desplazándose  →  escritorio anterior / siguiente
    pellizco (pulgar + índice)  →  agarrar y mover la ventana activa
    puño cerrado                →  pausa: no se hace caso a nada

── LAS TRES PARTES, Y POR QUÉ ESTÁN SEPARADAS ────────────────────────────────
    deteccion.py  landmarks → intención. Puro, sin cámara ni compositor, con
                  pruebas (`deteccion_test.py`). Es la parte que hay que
                  calibrar, y calibrarla contra una webcam es insufrible.
    hypr.py       el puente con el compositor, por socket y no por `hyprctl`
                  (148 veces más barato; la medición está en su cabecera).
    gestos.py     esto: cámara, modelo, bucle, estado publicado y apagado
                  limpio.

── ESTE PROCESO SE VE, Y ASÍ TIENE QUE SER ───────────────────────────────────
Mientras corre tiene `/dev/videoN` abierto, así que `hypr/scripts/camara-monitor.sh`
enciende el indicador rojo de privacidad de la barra y avisa «Cámara en uso».
No se hace nada por evitarlo: ese indicador existe justo para que nada mire por
la cámara sin que se vea, y un modo del propio escritorio no es una excepción.
Por eso tampoco se emite una notificación propia al activarlo — sería un segundo
aviso de lo mismo.

La consecuencia menos agradable es que **con el modo encendido no se puede
hacer una videollamada**: una webcam UVC no admite dos capturas a la vez. Si al
arrancar la cámara ya está ocupada, no se insiste — se dice quién la tiene y se
sale.
"""

from __future__ import annotations

import argparse
import errno
import fcntl
import json
import os
import signal
import subprocess
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from deteccion import (  # noqa: E402
    Config, Estado, Motor, centro_palma, elegir_mano, escala_mano,
)
from hypr import Hypr, SinHyprland  # noqa: E402

CONFIG_DIR = os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config")
DATA_DIR = os.environ.get("XDG_DATA_HOME") or os.path.expanduser("~/.local/share")
RUNTIME_DIR = os.environ.get("XDG_RUNTIME_DIR") or f"/run/user/{os.getuid()}"

RUTA_CONFIG = f"{CONFIG_DIR}/gigios/gestos.json"
RUTA_ESTADO = f"{CONFIG_DIR}/gigios/gestos-estado.json"
RUTA_MODELO = f"{DATA_DIR}/gigios/gestos/hand_landmarker.task"
RUTA_CERROJO = f"{RUNTIME_DIR}/gigios-gestos.lock"
HELPER_CAMARA = "/usr/local/bin/gigios-camara"

#: `fullscreen` de Hyprland es un MODO: 0 nada, 1 maximizada, 2 pantalla
#: completa de verdad. Solo la 2 impide arrastrar.
FULLSCREEN_REAL = 2

#: Sin mano en el cuadro durante este tiempo, se baja el ritmo.
#:
#: ⚠️ EL COSTE ESTUVO MAL MEDIDO Y CONVIENE SABER POR QUÉ. Una primera medida
#: dio 129% de un núcleo, y era un ARTEFACTO: se tomó sobre el demonio recién
#: arrancado, así que dentro de la ventana entraban la carga del modelo y el
#: calentamiento de XNNPACK. Con el proceso ya en régimen, y en un A/B con todo
#: igual salvo lo indicado (15 fps, sin mano en el cuadro, 90 frames por
#: configuración):
#:
#:      640x480  @ 15 fps → 41% de un núcleo
#:     1280x720  @ 15 fps → 50% de un núcleo   ← lo que se usa
#:     1280x720  @  5 fps → 24% de un núcleo   (dormitando)
#:
#: Moraleja para la próxima medición de este demonio: hay que dejarlo asentarse
#: unos segundos antes de empezar a contar, o se mide el arranque.
#:
#: El bajón sigue mereciendo la pena —de 50% a 24% por no buscar una mano que no
#: está— y el número de Ajustes sigue siendo el mando de consumo.
SEGUNDOS_PARA_DORMITAR = 4.0
FPS_DORMITANDO = 5

#: Resolución de captura. **720p sale GRATIS y da cuatro veces más píxeles al
#: recorte de la mano**, que es de donde salen los 21 landmarks: cuanto mejor
#: sea ese recorte, mejor se distinguen un puño de un pellizco y un dedo
#: extendido de uno a medio doblar. Medido en esta máquina, 70 frames por
#: configuración:
#:
#:      640x480  MJPG → inferencia 21,2 ms | ciclo 33,7 ms | techo 29,4 fps
#:     1280x720  MJPG → inferencia 19,4 ms | ciclo 33,7 ms | techo 29,4 fps
#:    1920x1080  MJPG → inferencia 23,5 ms | ciclo 36,2 ms | techo 27,5 fps
#:
#: O sea que el cuello de botella son los 30 fps de la cámara, no el proceso:
#: subir a 720p no cuesta un milisegundo. 1080p sí empieza a costar y no aporta
#: nada más, porque MediaPipe reescala el recorte a 224x224 de todas formas.
ANCHO_CAPTURA, ALTO_CAPTURA = 1280, 720

#: Ritmo del bucle. **30 y no 15**: la cámara entrega 29,6 fps reales, así que a
#: 30 se procesa CADA frame que llega y no se tira ninguno — y el que se tiraba
#: podía ser justo el único nítido de un gesto rápido. Sube además la respuesta:
#: `frames_confirmacion` son 3 frames, o sea 200 ms a 15 fps y 100 ms a 30.
#: Medido: 15 fps = 49% de un núcleo, 20 = 82%, 30 = 90%. Es el doble de gasto
#: por el doble de información, y con el bajón automático a 5 fps cuando no hay
#: ninguna mano delante el coste en reposo no cambia.
FPS_POR_DEFECTO = 30

#: ⚠️ PEDIR MJPG NO ES OPCIONAL PARA PASAR DE 640x480.
#: Esta webcam publica YUYV solo hasta 640x480 y reserva 720p/1080p para MJPG
#: (`v4l2-ctl --list-formats-ext`). OpenCV abre en YUYV por defecto, así que un
#: `CAP_PROP_FRAME_WIDTH = 1280` a secas **no falla**: se acepta, se ignora y
#: `cap.get(3)` sigue devolviendo 640. Medido — así se descubrió, porque las
#: tres resoluciones daban exactamente el mismo número.
FOURCC_MJPG = "MJPG"

#: Umbrales de confianza del modelo. Los tres NO valen lo mismo, y la asimetría
#: es todo el diseño: **cuesta encontrar una mano nueva, es fácil conservar una
#: que ya se tenía**.
#:
#: ⚠️ Aquí hubo un error que conviene no repetir. Se bajaron los tres a 0.4/0.3
#: para que la mano borrosa no se descartara, y el resultado en uso real fue que
#: el modelo empezó a **detectar la CARA del usuario como una mano**. Tiene
#: sentido: `min_hand_detection_confidence` es el que gobierna ADQUIRIR una mano
#: nueva, y aflojarlo es exactamente pedirle al detector de palmas que se crea
#: cualquier cosa. Con `num_hands=1` además compite con la mano de verdad y puede
#: ganarle, así que un falso positivo no solo añade ruido: TAPA la mano buena.
#:
#: Por eso la detección sube por encima del 0.5 de fábrica y solo el SEGUIMIENTO
#: se queda bajo: mantener viva una mano ya encontrada a través de unos frames
#: borrosos es barato en riesgo —ya se sabe que hay una mano ahí— y es justo lo
#: que hace falta durante un gesto rápido.
#: Dónde corre la inferencia. **El delegado GPU va casi el doble de rápido**:
#: medido sobre los MISMOS 50 frames, CPU 29,7 ms contra GPU 16,2 ms. Es la
#: única palanca real que queda — el resto del pipeline (leer, voltear, convertir
#: color, construir el mp.Image) suma 0,8 ms por frame, o sea nada, y la
#: inferencia es el 96% del trabajo.
USAR_GPU = True

CONFIANZA_DETECCION = 0.6
CONFIANZA_PRESENCIA = 0.5
CONFIANZA_SEGUIMIENTO = 0.3


# ── El detector ─────────────────────────────────────────────────────────────

def crear_detector(mpp, vision):
    """El HandLandmarker, en GPU si se puede y en CPU si no.

    El repliegue no es paranoia: el delegado GPU necesita un contexto GL
    utilizable, y eso puede fallar por driver, por cómo esté montada la sesión o
    por VRAM ocupada. Un modo que no arranca es mucho peor que uno lento, así
    que un fallo aquí degrada a CPU y lo dice por stderr (que acaba en
    `~/.cache/gigios/gestos.log`) en vez de tumbar el arranque.

    `num_hands=2` aunque solo se use una: ver `elegir_mano`.
    """
    def opciones(delegate):
        return vision.HandLandmarkerOptions(
            base_options=mpp.BaseOptions(model_asset_path=RUTA_MODELO, delegate=delegate),
            running_mode=vision.RunningMode.VIDEO,
            num_hands=2,
            min_hand_detection_confidence=CONFIANZA_DETECCION,
            min_hand_presence_confidence=CONFIANZA_PRESENCIA,
            min_tracking_confidence=CONFIANZA_SEGUIMIENTO,
        )

    if USAR_GPU:
        try:
            return vision.HandLandmarker.create_from_options(
                opciones(mpp.BaseOptions.Delegate.GPU))
        except Exception as e:  # noqa: BLE001
            print(f"gestos: el delegado GPU no arrancó ({e}); sigo en CPU", file=sys.stderr)
    return vision.HandLandmarker.create_from_options(
        opciones(mpp.BaseOptions.Delegate.CPU))


# ── Notificaciones ──────────────────────────────────────────────────────────
# Réplica del contrato de `hypr/scripts/lib/notif.sh`, que es bash y no se puede
# sourcear desde aquí. Los dos hints son los que hacen que el aviso sea
# CONFIGURABLE en Ajustes > Notificaciones > Sistema; sin ellos funcionaría
# igual pero quedaría fuera de la lista. Los ids están dados de alta en
# `ags/modulos/notificaciones/rules/catalogoSistema.ts`.
def notificar(evento: str, titulo: str, cuerpo: str = "", urgencia: str = "normal") -> None:
    try:
        subprocess.run(
            ["notify-send", "-a", "Gestos", "-u", urgencia,
             "-h", "string:x-gigios-source:system",
             "-h", f"string:x-gigios-event:{evento}",
             titulo, cuerpo],
            check=False, capture_output=True, timeout=5,
        )
    except (OSError, subprocess.SubprocessError):
        pass  # quedarse sin aviso no puede tumbar el modo


# ── Cámara: qué nodo y si se puede ──────────────────────────────────────────

def nodos_captura() -> list[str]:
    """Solo los nodos que CAPTURAN IMAGEN.

    Mismo criterio que `camara-monitor.sh` y `servicios/camara/dispositivos.ts`:
    la propiedad de udev `ID_V4L_CAPABILITIES` con `:capture:`. Una webcam UVC
    registra además uno o dos nodos de METADATOS que ninguna app usa para ver;
    abrir uno de esos da un stream que no es imagen, así que quedarse con el
    primer `/dev/video*` a secas es una moneda al aire.
    """
    salida = []
    for n in sorted(
        (e for e in os.listdir("/dev") if e.startswith("video")),
        key=lambda e: int(e[5:]) if e[5:].isdigit() else 999,
    ):
        nodo = f"/dev/{n}"
        try:
            r = subprocess.run(
                ["udevadm", "info", "--query=property", f"--name={nodo}"],
                capture_output=True, text=True, timeout=3,
            )
            caps = next(
                (l.split("=", 1)[1] for l in r.stdout.splitlines()
                 if l.startswith("ID_V4L_CAPABILITIES=")),
                "",
            )
        except (OSError, subprocess.SubprocessError):
            caps = ""
        # Sin la propiedad no se descarta (udev antiguo o regla desactivada):
        # misma tolerancia que el monitor de uso.
        if not caps or ":capture:" in caps:
            salida.append(nodo)
    return salida


def nombre_camara(nodo: str) -> str:
    try:
        r = subprocess.run(
            ["udevadm", "info", "--query=property", f"--name={nodo}"],
            capture_output=True, text=True, timeout=3,
        )
        for l in r.stdout.splitlines():
            if l.startswith("ID_V4L_PRODUCT="):
                return l.split("=", 1)[1]
    except (OSError, subprocess.SubprocessError):
        pass
    try:
        with open(f"/sys/class/video4linux/{os.path.basename(nodo)}/name") as f:
            return f.read().strip() or "Cámara"
    except OSError:
        return "Cámara"


def camara_bloqueada() -> bool:
    """El killswitch de Ajustes > Cámara manda sobre esto.

    No se intenta abrir para ver si falla: con la cámara bloqueada el `open`
    daría un EACCES genérico y el motivo que se le enseñaría al usuario sería
    "no se pudo abrir la cámara", que no dice nada y le manda a buscar un
    problema de hardware que no existe. Se pregunta al helper, que no necesita
    sudo para `status`.
    """
    if not os.access(HELPER_CAMARA, os.X_OK):
        return False
    try:
        r = subprocess.run([HELPER_CAMARA, "status"],
                           capture_output=True, text=True, timeout=5)
        return r.stdout.strip().startswith("blocked")
    except (OSError, subprocess.SubprocessError):
        return False


def quien_usa(nodo: str) -> list[str]:
    """Nombres de proceso que ya tienen el nodo abierto. Para poder decir
    «la está usando firefox» en vez de un error genérico."""
    try:
        r = subprocess.run(["fuser", nodo], capture_output=True, text=True, timeout=3)
    except (OSError, subprocess.SubprocessError):
        return []
    nombres = []
    for pid in r.stdout.split():
        if not pid.isdigit():
            continue
        try:
            with open(f"/proc/{pid}/comm") as f:
                nombres.append(f.read().strip())
        except OSError:
            pass
    return sorted(set(nombres))


# ── Configuración y estado publicado ────────────────────────────────────────

def leer_config() -> tuple[Config, dict]:
    """Ajustes > Cámara > Gestos escribe `gestos.json`; aquí se lee.

    Toda clave ausente cae al valor de fábrica de `Config`, y un fichero
    ilegible NO impide arrancar: degradar a los valores por defecto es visible y
    arreglable; negarse a arrancar por un JSON a medio escribir sería un modo
    que "no va" sin decir por qué.
    """
    crudo = {}
    try:
        with open(RUTA_CONFIG) as f:
            crudo = json.load(f) or {}
    except (OSError, ValueError):
        crudo = {}
    if not isinstance(crudo, dict):
        crudo = {}

    def num(clave, defecto, minimo, maximo):
        v = crudo.get(clave)
        if not isinstance(v, (int, float)) or isinstance(v, bool):
            return defecto
        return max(minimo, min(maximo, float(v)))

    def flag(clave, defecto=True):
        v = crudo.get(clave)
        return defecto if not isinstance(v, bool) else v

    cfg = Config(
        umbral_swipe=num("sensibilidad", Config.umbral_swipe, 0.08, 0.45),
        paso_arrastre=num("paso", Config.paso_arrastre, 0.05, 0.30),
        cooldown_swipe=num("cooldown", Config.cooldown_swipe, 0.20, 1.00),
        ganancia_arrastre=num("ganancia", Config.ganancia_arrastre, 0.5, 4.0),
        swipe_activo=flag("swipe"),
        pellizco_activo=flag("pellizco"),
        puno_activo=flag("puno"),
        espera_activa=flag("espera"),
        doble_pellizco_activo=flag("dobleFlotar"),
    )
    otros = {
        "fps": int(num("fps", FPS_POR_DEFECTO, 5, 30)),
        "nodo": crudo.get("nodo") if isinstance(crudo.get("nodo"), str) else None,
    }
    return cfg, otros


class Publicador:
    """Escribe `gestos-estado.json` para que AGS pinte el indicador.

    ── NO SE ESCRIBE POR FRAME, Y ESO ES LO IMPORTANTE ─────────────────────
    Al otro lado hay un `Gio.FileMonitor` (`servicios/gestos/estado.ts`) que
    reinterpreta el JSON en CADA cambio, dentro del proceso que pinta la barra.
    Publicar 15 veces por segundo sería meterle 15 parseos por segundo al shell
    durante todo el rato que dure el modo, para redibujar un icono que casi
    nunca cambia. Se publica solo cuando cambia algo que se ve, y como mucho
    cada `MIN_INTERVALO`.

    La escritura es atómica (tmp + rename) porque el monitor vigila el
    DIRECTORIO: sin el rename se leería un JSON a medias.
    """

    MIN_INTERVALO = 0.20

    def __init__(self):
        self._ultimo: dict | None = None
        self._cuando = 0.0
        os.makedirs(os.path.dirname(RUTA_ESTADO), exist_ok=True)

    def publicar(self, datos: dict, forzar: bool = False) -> None:
        ahora = time.monotonic()
        if not forzar:
            if datos == self._ultimo:
                return
            if ahora - self._cuando < self.MIN_INTERVALO:
                return
        tmp = f"{RUTA_ESTADO}.tmp.{os.getpid()}"
        try:
            with open(tmp, "w") as f:
                json.dump(datos, f)
            os.replace(tmp, RUTA_ESTADO)
        except OSError:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            return
        self._ultimo, self._cuando = dict(datos), ahora

    @staticmethod
    def apagado(motivo: str | None = None) -> dict:
        return {
            "activo": False, "desde": None, "estado": "apagado", "mano": False,
            "camara": None, "nombre": None, "ultimoGesto": None, "motivo": motivo,
            "pid": None,
        }


# ── Cerrojo de instancia única ──────────────────────────────────────────────

def tomar_cerrojo():
    """Un solo demonio a la vez.

    Con `flock`, no con un fichero de PID: un PID escrito a mano se queda
    obsoleto si el proceso muere de golpe (OOM, `kill -9`) y el siguiente
    arranque se cree que ya hay uno vivo, dejando el modo inarrancable hasta
    borrar el fichero a mano. El cerrojo lo suelta el kernel al cerrar el
    descriptor, pase lo que pase.
    """
    fd = os.open(RUTA_CERROJO, os.O_CREAT | os.O_RDWR, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError as e:
        os.close(fd)
        if e.errno in (errno.EACCES, errno.EAGAIN):
            return None
        raise
    os.truncate(fd, 0)
    os.write(fd, str(os.getpid()).encode())
    return fd


# ── Lector de cámara ────────────────────────────────────────────────────────

class Camara:
    """Hilo que mantiene SIEMPRE el último frame disponible.

    ── POR QUÉ UN HILO Y NO LEER EN EL BUCLE ───────────────────────────────
    V4L2 encola frames. Si la cámara entrega a 30 fps y el bucle consume a 15
    (la inferencia cuesta 33 ms), cada `read()` devuelve el frame más viejo de
    la cola, no el actual: el retraso crece hasta que la cola se llena y se
    queda en varias décimas de segundo fijas. En un indicador no se notaría; en
    un gesto es la diferencia entre que la ventana siga a la mano y que vaya
    detrás de ella. `CAP_PROP_BUFFERSIZE` no es fiable con V4L2 (el backend lo
    ignora en muchos drivers), así que se drena de verdad: el hilo lee todo lo
    que la cámara dé y guarda solo el último, y el bucle coge ese.
    """

    def __init__(self, nodo: str, ancho=ANCHO_CAPTURA, alto=ALTO_CAPTURA, fps=30):
        import cv2  # importado aquí para que el arranque falle con un mensaje propio
        self._cv2 = cv2
        self.cap = self._abrir(cv2, nodo)
        if self.cap is None:
            raise OSError(f"no se pudo abrir {nodo}")
        # El FOURCC va ANTES del tamaño: es lo que decide qué tamaños admite el
        # driver. Ver la nota de `FOURCC_MJPG` — sin esto, 720p se pide, se
        # acepta y no se aplica.
        self.cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*FOURCC_MJPG))
        self.cap.set(cv2.CAP_PROP_FRAME_WIDTH, ancho)
        self.cap.set(cv2.CAP_PROP_FRAME_HEIGHT, alto)
        self.cap.set(cv2.CAP_PROP_FPS, fps)
        #: Lo que la cámara ha concedido de verdad, que no tiene por qué ser lo
        #: pedido. Lo publica el modo diagnóstico.
        self.resolucion = (int(self.cap.get(cv2.CAP_PROP_FRAME_WIDTH)),
                           int(self.cap.get(cv2.CAP_PROP_FRAME_HEIGHT)))
        self._frame = None
        self._sello = 0
        self._lock = threading.Lock()
        self._vivo = True
        self._hilo = threading.Thread(target=self._bucle, daemon=True)
        self._hilo.start()

    @staticmethod
    def _abrir(cv2, nodo: str):
        """Abre la cámara probando varias formas, porque OpenCV 5 cambió cuál vale.

        En OpenCV 4, `VideoCapture("/dev/video0", CAP_V4L2)` era lo idiomático.
        En el OpenCV 5.0.0 de estos repos esa misma llamada avisa:

            VIDEOIO(V4L2): backend is generally available but can't be used
                           to capture by name

        …y devuelve un capture cerrado. O sea que la forma "correcta de toda la
        vida" falla, y falla con un aviso que parece informativo. Lo que sí
        funciona con el backend V4L2 es el ÍNDICE: `/dev/videoN` se abre con
        `VideoCapture(N, CAP_V4L2)`.

        Se prueban las tres en orden en vez de clavar una: el número de OpenCV
        no es algo que este repo controle, y la forma por nombre volverá a ser
        la buena en cuanto la arreglen. Probar cuesta unos milisegundos una vez
        por encendido.
        """
        base = os.path.basename(nodo)
        indice = int(base[5:]) if base.startswith("video") and base[5:].isdigit() else None
        intentos = []
        if indice is not None:
            intentos.append((indice, cv2.CAP_V4L2))
        intentos.append((nodo, cv2.CAP_V4L2))
        if indice is not None:
            intentos.append((indice, cv2.CAP_ANY))
        for arg, backend in intentos:
            cap = cv2.VideoCapture(arg, backend)
            if cap.isOpened():
                return cap
            cap.release()
        return None

    def _bucle(self):
        fallos = 0
        while self._vivo:
            ok, frame = self.cap.read()
            if not ok:
                fallos += 1
                # Una webcam desenchufada devuelve False para siempre. Rendirse
                # tras unos cuantos evita un hilo girando en vacío al 100%.
                if fallos > 30:
                    with self._lock:
                        self._vivo = False
                    return
                time.sleep(0.05)
                continue
            fallos = 0
            with self._lock:
                self._frame = frame
                self._sello += 1

    def ultimo(self):
        """Devuelve (frame, sello) o (None, sello). El sello permite saltarse la
        inferencia si la cámara no ha dado nada nuevo desde la última vez."""
        with self._lock:
            return self._frame, self._sello

    @property
    def viva(self) -> bool:
        return self._vivo

    def cerrar(self):
        self._vivo = False
        try:
            self._hilo.join(timeout=1.0)
        except RuntimeError:
            pass
        try:
            self.cap.release()
        except Exception:
            pass


def candidatas(resultado) -> list[tuple[list, float]]:
    """Las manos que ha devuelto MediaPipe, como `(puntos, puntuación)`.

    La puntuación sale de `handedness`, que es lo único parecido a una confianza
    que expone la API de Tasks por mano. Ausente = 0.0, que solo importa para
    desempatar en el primer frame.
    """
    salida = []
    for i, marcas in enumerate(resultado.hand_landmarks or []):
        puntuacion = 0.0
        if resultado.handedness and i < len(resultado.handedness) and resultado.handedness[i]:
            puntuacion = float(resultado.handedness[i][0].score)
        salida.append(([(p.x, p.y, p.z) for p in marcas], puntuacion))
    return salida


# ── El arrastre ─────────────────────────────────────────────────────────────

class Arrastre:
    """Estado de una ventana agarrada con el pellizco.

    ── EL PELLIZCO NO CAMBIA EL MODO DE LA VENTANA, Y ESO MANDA SOBRE TODO ─────
    Hubo una versión que ponía la ventana a flotar para poder darle coordenadas.
    Movía, sí, pero rompía lo importante: una ventana sacada del mosaico ya no
    vuelve a recolocarse sola, así que el escritorio quedaba desbaratado después
    de cada gesto y había que recomponerlo a mano. Lo correcto es dejar que
    Hyprland siga mandando en el reparto y limitarse a pedirle el movimiento.

    Así que el modo de la ventana lo decide la ventana, no el gesto, y de ahí los
    dos caminos:

      en mosaico  → `paso()`, recolocación por pasos (`recolocar`); la posición
                    la sigue decidiendo el layout.
      ya flotando → `mover()`, posición absoluta; para eso sirve flotar.

    `flotante` se lee UNA vez, al agarrar, y no se vuelve a mirar: si el usuario
    la cambia a mitad de arrastre, el gesto en curso termina con las reglas con
    las que empezó en vez de cambiar de comportamiento a media mano.
    """

    def __init__(self, hypr: Hypr, direccion: str, flotante: bool,
                 origen: tuple[int, int], tamano: tuple[int, int],
                 monitor: tuple[float, float, float, float]):
        self.hypr = hypr
        self.direccion = direccion
        self.flotante = flotante
        self.origen = origen
        self.tamano = tamano
        self.monitor = monitor
        self.ultima: tuple[int, int] | None = None

    def paso(self, direccion: str) -> None:
        """Un paso de recolocación en el mosaico. Solo para ventanas tiladas."""
        if self.flotante:
            return
        self.hypr.recolocar(direccion, self.direccion)

    def mover(self, dx: float, dy: float) -> None:
        """Posición absoluta. **Solo para una ventana que ya estaba flotando**;
        sobre una en mosaico `hl.dsp.window.move` responde `ok` sin mover nada.

        `dx`/`dy` vienen en fracción de CUADRO DE CÁMARA; aquí se pasan a
        píxeles del monitor y se acotan.

        El acotado no es cosmético: sin él, un gesto amplio deja la ventana
        entera fuera de la pantalla y como está flotante no hay forma de
        recuperarla con el ratón. Se deja siempre un trozo visible.
        """
        if not self.flotante:
            return
        mx, my, mancho, malto = self.monitor
        ancho, alto = self.tamano
        x = self.origen[0] + dx * mancho
        y = self.origen[1] + dy * malto
        # Un cuarto de la ventana (con un mínimo de 80 px) tiene que seguir
        # dentro del monitor por cada lado.
        margen_x = max(min(ancho // 4, ancho), 80)
        margen_y = max(min(alto // 4, alto), 80)
        x = max(mx - ancho + margen_x, min(mx + mancho - margen_x, x))
        y = max(my, min(my + malto - margen_y, y))
        destino = (int(x), int(y))
        # Sin este filtro se manda la misma posición mientras la mano está
        # quieta: son órdenes que no cambian nada y que reinician la animación
        # de la ventana, con lo que se ve temblar.
        if destino == self.ultima:
            return
        self.ultima = destino
        self.hypr.mover(self.direccion, destino[0], destino[1])


# ── Bucle principal ─────────────────────────────────────────────────────────

class Demonio:
    def __init__(self, nodo: str | None, verboso: bool = False):
        self.cfg, self.otros = leer_config()
        self.nodo = nodo or self.otros["nodo"]
        self.verboso = verboso
        self.publicador = Publicador()
        self.hypr = Hypr()
        self.motor = Motor(self.cfg)
        self.camara: Camara | None = None
        self.arrastre: Arrastre | None = None
        self.parar = threading.Event()
        self.ultimo_gesto: str | None = None
        self.cuando_gesto: float | None = None
        # Se rellena en `correr()`, pero tiene que existir desde ya: `_estado`
        # puede consultarse antes si el arranque falla a medio camino.
        self.nombre = "Cámara"

    # ── Comprobaciones previas ──────────────────────────────────────────────

    def resolver_camara(self) -> str:
        nodos = nodos_captura()
        if self.nodo:
            if self.nodo in nodos or os.path.exists(self.nodo):
                return self.nodo
            raise SystemExit(f"la cámara configurada ({self.nodo}) no está conectada")
        if not nodos:
            raise SystemExit("no hay ninguna cámara conectada")
        return nodos[0]

    def preparar(self) -> None:
        if camara_bloqueada():
            raise SystemExit(
                "la cámara está bloqueada en Ajustes > Cámara; desbloquéala para usar gestos"
            )
        if not os.path.exists(RUTA_MODELO):
            raise SystemExit(
                f"falta el modelo de manos ({RUTA_MODELO}); "
                "ejecuta: bash install.sh --solo gestos"
            )
        nodo = self.resolver_camara()
        usuarios = [u for u in quien_usa(nodo) if u != "python3"]
        if usuarios:
            raise SystemExit(
                f"la cámara ya la está usando {', '.join(usuarios)}; "
                "ciérralo para poder usar gestos"
            )
        # Permisos, ANTES de intentar abrir. Sin esta comprobación el fallo llega
        # como «no se pudo abrir /dev/video0», que manda al usuario a buscar un
        # problema de hardware que no existe.
        #
        # Y el caso no es hipotético: si un `gigios-camara block` se deshizo con
        # una versión del helper anterior al arreglo del `unblock`, los nodos se
        # quedan en `c--------- root root` con la ACL enmascarada — o sea la
        # cámara muerta — mientras `gigios-camara status` responde `unblocked`.
        # Por eso el mensaje nombra la reparación en vez de repetir "no se pudo".
        if not os.access(nodo, os.R_OK | os.W_OK):
            raise SystemExit(
                f"sin permiso para abrir {nodo}. Si bloqueaste la cámara alguna vez, "
                "los permisos pueden haberse quedado a medias: repáralos con "
                "'sudo chown root:video /dev/video* && sudo chmod 660 /dev/video*' "
                "y reinstala el helper con 'bash ~/GiGiShell/install.sh --solo sistema'"
            )
        self.nodo = nodo

    # ── Acciones ────────────────────────────────────────────────────────────

    def _alternar_flotante(self) -> None:
        """Dos pellizcos rápidos: la ventana activa entra o sale del mosaico.

        La pausa de después no es opcional: Hyprland rehace el reparto al sacar
        o meter una ventana, y sin ella `_iniciar_arrastre` —que corre en el
        MISMO frame, justo detrás— leería la geometría anterior y el arrastre
        empezaría con un salto. Es la misma espera que ya hacía falta cuando el
        pellizco flotaba la ventana por su cuenta.
        """
        try:
            v = self.hypr.ventana_activa()
        except SinHyprland:
            return
        if not v or v.get("fullscreen") == FULLSCREEN_REAL:
            return
        self.hypr.alternar_flotante(v["address"])
        time.sleep(0.06)

    def _iniciar_arrastre(self) -> None:
        try:
            v = self.hypr.ventana_activa()
        except SinHyprland:
            return
        if not v:
            return
        # Una ventana a pantalla completa REAL no se arrastra: `move` no haría
        # nada y el modo parecería no responder sin motivo aparente.
        #
        # `fullscreen` es un MODO, no un booleano (0 nada, 1 MAXIMIZADA, 2
        # pantalla completa) — la misma trampa que documenta el repo para la
        # detección de juegos. Con `if v.get("fullscreen")` cualquier ventana
        # simplemente maximizada quedaría fuera del arrastre, que es la mitad de
        # las ventanas de una sesión normal.
        if v.get("fullscreen") == FULLSCREEN_REAL:
            return
        direccion = v["address"]
        # AQUÍ NO SE FLOTA NADA. Es la diferencia con la primera versión, que
        # llamaba a `flotar()` para poder dar coordenadas: movía la ventana pero
        # la sacaba del mosaico para siempre, así que dejaba de recolocarse sola
        # y el escritorio había que recomponerlo a mano tras cada gesto. El modo
        # de la ventana lo decide la ventana; ver la cabecera de `Arrastre`.
        flotante = bool(v.get("floating"))
        # La geometría del monitor solo hace falta para acotar el camino
        # flotante. Con una ventana en mosaico no se consulta: son dos órdenes
        # al compositor por cada pellizco, y ahí no se usarían para nada.
        monitor = (0.0, 0.0, 1920.0, 1080.0)
        if flotante:
            monitor = self.hypr.geometria_monitor(v.get("monitor", 0)) or monitor
        self.arrastre = Arrastre(
            self.hypr, direccion, flotante,
            (int(v["at"][0]), int(v["at"][1])),
            (int(v["size"][0]), int(v["size"][1])),
            monitor,
        )

    def _aplicar(self, eventos) -> None:
        for ev in eventos:
            if ev.tipo == "swipe":
                delta = 1 if ev.direccion == "derecha" else -1
                self.hypr.cambiar_workspace(delta)
                self.ultimo_gesto = f"swipe-{ev.direccion}"
                self.cuando_gesto = time.time()
            elif ev.tipo == "flotar":
                # Llega ANTES del `arrastre-inicio` del mismo frame, así que el
                # arrastre que viene detrás ya leerá el modo nuevo y se moverá
                # como toca sin tener que rehacerse.
                self._alternar_flotante()
            elif ev.tipo == "arrastre-inicio":
                self._iniciar_arrastre()
                if self.arrastre:
                    self.ultimo_gesto = "pellizco"
                    self.cuando_gesto = time.time()
            elif ev.tipo == "arrastre" and self.arrastre:
                # Continuo: solo lo atiende una ventana ya flotante. `Arrastre`
                # descarta el evento por su cuenta si está en mosaico, así que
                # el reparto vive en un sitio y no repartido entre dos.
                self.arrastre.mover(ev.dx, ev.dy)
            elif ev.tipo == "arrastre-paso" and self.arrastre and ev.direccion:
                # Discreto: el camino de las ventanas en mosaico.
                self.arrastre.paso(ev.direccion)
            elif ev.tipo == "arrastre-fin":
                self.arrastre = None
            elif ev.tipo == "espera":
                # Aquí no hay nada que pedirle al compositor: entrar y salir de
                # la espera es un cambio de estado del propio modo. Lo único que
                # se hace es dejarlo apuntado para que se PUBLIQUE, porque si no
                # el usuario tendría un modo que ha dejado de responder sin nada
                # que lo explique — indistinguible de que se haya roto.
                self.arrastre = None
                self.ultimo_gesto = (
                    "espera" if ev.direccion == "entrar" else "espera-fin"
                )
                self.cuando_gesto = time.time()

    # ── Publicación ─────────────────────────────────────────────────────────

    def _estado(self, desde: float, hay_mano: bool) -> dict:
        return {
            "activo": True,
            "desde": int(desde),
            "estado": self.motor.estado.value,
            "mano": hay_mano,
            "camara": self.nodo,
            "nombre": self.nombre,
            "ultimoGesto": self.ultimo_gesto,
            "cuando": int(self.cuando_gesto) if self.cuando_gesto else None,
            "motivo": None,
            "pid": os.getpid(),
        }

    # ── Bucle ───────────────────────────────────────────────────────────────

    def correr(self) -> int:
        import mediapipe as mp
        from mediapipe.tasks import python as mpp
        from mediapipe.tasks.python import vision
        import cv2

        self.nombre = nombre_camara(self.nodo)
        detector = crear_detector(mpp, vision)
        self.camara = Camara(self.nodo, fps=self.otros["fps"])
        desde = time.time()
        self.publicador.publicar(self._estado(desde, False), forzar=True)

        fps_objetivo = self.otros["fps"]
        ultimo_sello = -1
        visto_mano = time.monotonic()
        #: Centro de palma del último frame con mano, para `elegir_mano`.
        ultimo_centro: tuple[float, float] | None = None
        # MediaPipe exige sellos de tiempo en ms ESTRICTAMENTE crecientes en
        # modo VIDEO: repetir uno hace que descarte el frame en silencio.
        marca = 0

        while not self.parar.is_set():
            if not self.camara.viva:
                notificar("gestos.detenido", "Modo gestos detenido",
                          "Se perdió la cámara.", "normal")
                return 1

            inicio = time.monotonic()
            frame, sello = self.camara.ultimo()
            if frame is None or sello == ultimo_sello:
                # Nada nuevo que mirar: no se gasta una inferencia en repetir el
                # frame anterior, que además rompería el seguimiento temporal.
                time.sleep(0.005)
                continue
            ultimo_sello = sello

            # Espejo: la cámara ve al usuario de frente, así que sin invertir, la
            # mano moviéndose a la DERECHA del usuario recorre la izquierda del
            # cuadro. Se voltea aquí, una sola vez, y todo lo de abajo (motor
            # incluido) puede razonar en las coordenadas del usuario.
            frame = cv2.flip(frame, 1)
            imagen = mp.Image(
                image_format=mp.ImageFormat.SRGB,
                data=cv2.cvtColor(frame, cv2.COLOR_BGR2RGB),
            )
            marca += 1
            resultado = detector.detect_for_video(imagen, marca * 33)

            # Con `num_hands=2` pueden llegar dos candidatas y una puede ser una
            # cara. `elegir_mano` se queda con la más cercana a donde estaba la
            # tuya; ver su docstring.
            puntos = elegir_mano(candidatas(resultado), ultimo_centro)
            if puntos is not None:
                ultimo_centro = centro_palma(puntos)
                visto_mano = time.monotonic()
            elif time.monotonic() - visto_mano > self.cfg.gracia_perdida:
                # Perdida de verdad: se olvida la referencia, o la próxima
                # elección se anclaría a una posición de hace un rato.
                ultimo_centro = None

            ahora = time.monotonic()
            try:
                self._aplicar(self.motor.frame(ahora, puntos))
            except SinHyprland:
                # El compositor puede estar recargando la config. Se pierde el
                # gesto y se sigue: morirse dejaría el modo apagado sin que el
                # usuario haya pedido apagarlo.
                pass

            self.publicador.publicar(self._estado(desde, puntos is not None))
            if self.verboso:
                print(f"{self.motor.estado.value:12} {self.motor.postura.value:9} "
                      f"{(time.monotonic()-inicio)*1000:5.1f} ms", flush=True)

            # Ritmo. Con la mano fuera del cuadro se baja a `FPS_DORMITANDO`:
            # buscar una mano que no está no merece el ritmo completo, y la
            # inferencia es TODO el consumo del modo. Un arrastre en curso no
            # dormita nunca, aunque el modelo pierda la mano un instante.
            dormita = (
                self.arrastre is None
                # También se dormita EN ESPERA sin mano delante: ahí el bucle
                # solo busca el doble cierre, y sin ninguna mano en el cuadro no
                # hay ninguno que encontrar. En cuanto aparece una mano,
                # `visto_mano` se actualiza y el ritmo vuelve al completo en el
                # frame siguiente, así que el gesto para salir no se pierde.
                and self.motor.estado in (Estado.BUSCANDO, Estado.ESPERA)
                and ahora - visto_mano > SEGUNDOS_PARA_DORMITAR
            )
            objetivo = FPS_DORMITANDO if dormita else fps_objetivo
            resto = (1.0 / objetivo) - (time.monotonic() - inicio)
            if resto > 0:
                self.parar.wait(resto)
        return 0

    # ── Apagado ─────────────────────────────────────────────────────────────

    def cerrar(self) -> None:
        if self.camara:
            self.camara.cerrar()
        self.publicador.publicar(Publicador.apagado(), forzar=True)


def diagnostico(demonio: "Demonio", segundos: float) -> int:
    """Mide qué ve la cámara DE VERDAD, sin actuar sobre el escritorio.

    Existe porque "a veces no me detecta" no es accionable y "el 38% de los
    frames pierden la mano, y sin levantarla detecta algo el 20% del tiempo" sí
    lo es.

    ── DOS FASES, Y LA PRIMERA ES LA IMPORTANTE ──────────────────────────────
    Primero se mide **sin ninguna mano delante**: todo lo que detecte ahí es un
    FALSO POSITIVO (típicamente una cara), y eso no se puede deducir de la fase
    con la mano — ahí un porcentaje alto de detección parece bueno aunque la
    mitad sean caras. Después se mide con la mano moviéndose, que es la tasa
    útil. Las dos cifras juntas dicen qué hay que tocar; por separado, ninguna.

    NO despacha nada a Hyprland: un swipe que cambie de escritorio en mitad de la
    prueba se lleva la ventana donde estás leyendo los números.
    """
    import mediapipe as mp
    from mediapipe.tasks import python as mpp
    from mediapipe.tasks.python import vision
    import cv2

    detector = crear_detector(mpp, vision)
    camara = Camara(demonio.nodo, fps=demonio.otros["fps"])
    demonio.camara = camara
    print(f"Cámara     : {nombre_camara(demonio.nodo)} ({demonio.nodo})")
    print(f"Resolución : {camara.resolucion[0]}x{camara.resolucion[1]}")
    print(f"Ritmo      : {demonio.otros['fps']} fps de proceso")
    print(f"Umbrales   : detección {CONFIANZA_DETECCION} · presencia "
          f"{CONFIANZA_PRESENCIA} · seguimiento {CONFIANZA_SEGUIMIENTO}")

    estado = {"marca": 0, "sello": -1}

    def fase(titulo, aviso, dur, seguir_gestos):
        print(f"\n── {titulo} ──")
        print(f"   {aviso}")
        for cuenta in (3, 2, 1):
            print(f"\r   empieza en {cuenta}…", end="", flush=True)
            time.sleep(1)
        print("\r" + " " * 30, end="\r")
        total = con_mano = dos_manos = 0
        confianzas, brillos, tam = [], [], []
        racha = peor = 0
        gestos_vistos = []
        centro = None
        t0 = time.monotonic()
        pintado = 0.0
        while time.monotonic() - t0 < dur and camara.viva:
            inicio = time.monotonic()
            frame, sello = camara.ultimo()
            if frame is None or sello == estado["sello"]:
                time.sleep(0.004)
                continue
            estado["sello"] = sello
            frame = cv2.flip(frame, 1)
            brillos.append(float(frame.mean()))
            estado["marca"] += 1
            r = detector.detect_for_video(
                mp.Image(image_format=mp.ImageFormat.SRGB,
                         data=cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)),
                estado["marca"] * 33)
            total += 1
            cands = candidatas(r)
            if len(cands) > 1:
                dos_manos += 1
            puntos = elegir_mano(cands, centro)
            if puntos is not None:
                con_mano += 1
                racha = 0
                centro = centro_palma(puntos)
                tam.append(escala_mano(puntos))
                confianzas.append(max(c[1] for c in cands))
            else:
                racha += 1
                peor = max(peor, racha)
                centro = None
            if seguir_gestos:
                for ev in demonio.motor.frame(time.monotonic(), puntos):
                    if ev.tipo in ("swipe", "arrastre-paso", "espera"):
                        gestos_vistos.append(f"{ev.tipo}:{ev.direccion}")
                    elif ev.tipo == "arrastre-inicio":
                        gestos_vistos.append("pellizco")
            ahora = time.monotonic()
            if ahora - pintado > 0.1:
                pintado = ahora
                print(f"\r   {'MANO' if puntos else ' -- '}  "
                      f"detecciones={len(cands)}  "
                      f"postura={demonio.motor.postura.value:9} "
                      f"gestos={len(gestos_vistos):2}   ", end="", flush=True)
            resto = (1.0 / demonio.otros["fps"]) - (time.monotonic() - inicio)
            if resto > 0:
                time.sleep(resto)
        dur_real = time.monotonic() - t0
        print()
        return {
            "total": total, "con_mano": con_mano, "dos": dos_manos,
            "fps": total / dur_real if dur_real else 0,
            "peor": peor, "gestos": gestos_vistos,
            "brillo": sum(brillos) / len(brillos) if brillos else 0,
            "conf": sum(confianzas) / len(confianzas) if confianzas else 0,
            "tam": sum(tam) / len(tam) if tam else 0,
        }

    quieto = fase("FASE 1 · sin manos", "APARTA las manos del encuadre y quédate quieto.",
                  max(5.0, segundos * 0.3), False)
    demonio.motor = Motor(demonio.cfg)  # estado limpio para la fase útil
    activo = fase("FASE 2 · con la mano", "Ahora MUEVE la mano: ábrela, ciérrala, deslízala, pellizca.",
                  segundos, True)
    camara.cerrar()

    def pct(d):
        return d["con_mano"] * 100 // d["total"] if d["total"] else 0

    print("\n── Resumen ─────────────────────────────────────────────")
    print(f"  Ritmo real            : {activo['fps']:.1f} fps")
    print(f"  Brillo del cuadro     : {activo['brillo']:.0f}/255")
    print(f"  SIN manos → detecta   : {quieto['con_mano']}/{quieto['total']} "
          f"({pct(quieto)}%)   ← todo esto son FALSOS POSITIVOS")
    print(f"  CON la mano → detecta : {activo['con_mano']}/{activo['total']} ({pct(activo)}%)")
    print(f"  Frames con DOS detecciones: {activo['dos']} "
          f"(la cara compitiendo con la mano)")
    print(f"  Confianza media       : {activo['conf']:.2f}")
    print(f"  Tamaño aparente mano  : {activo['tam']:.3f} (fracción de cuadro)")
    print(f"  Peor racha sin mano   : {activo['peor']} frames "
          f"({activo['peor'] / max(activo['fps'], 1):.2f} s; la tolerancia son "
          f"{demonio.cfg.gracia_perdida:.2f} s)")
    print(f"  Gestos que habrían disparado: {len(activo['gestos'])}"
          + (f" ({', '.join(activo['gestos'][:6])}…)" if activo["gestos"] else ""))

    print("\n── Lectura ─────────────────────────────────────────────")
    if pct(quieto) > 5:
        print(f"  ⚠ Detecta una mano el {pct(quieto)}% del tiempo SIN que haya ninguna.")
        print("    Es el detector creyéndose una cara u otra cosa.")
        # OJO: el consejo obvio —subir el umbral de confianza— NO sirve, y
        # decirlo aquí evita que el siguiente lo intente. Medido: los falsos
        # positivos puntúan 0.98, igual que una mano de verdad, así que la
        # confianza no los distingue por mucho que se suba.
        print("    Subir el umbral de confianza NO lo arregla: estos falsos")
        print("    positivos puntúan 0.98, lo mismo que una mano real.")
        print("    Lo que sí ayuda: que no te dé la luz por detrás, y mantener")
        print("    la cara fuera del encuadre o más lejos que la mano.")
    else:
        print("  ✓ Sin falsos positivos apreciables.")
    if pct(activo) < 60:
        print(f"  ⚠ Solo el {pct(activo)}% de los frames ven tu mano. Por orden de")
        print("    eficacia: más luz DE FRENTE, la palma mirando al objetivo, y")
        print("    la mano ENTERA dentro del cuadro (si está muy cerca se sale).")
    elif pct(activo) < 85:
        print(f"  Detección irregular ({pct(activo)}%). Suele ser luz justa: la webcam")
        print("    alarga la exposición y la mano en movimiento sale borrosa.")
    else:
        print(f"  ✓ Te ve bien ({pct(activo)}%). Si aun así falla algún gesto, el")
        print("    ajuste está en Ajustes > Cámara > Gestos.")
    if activo["brillo"] < 60:
        print(f"  ⚠ El cuadro está oscuro ({activo['brillo']:.0f}/255). Es la causa número uno.")
    if activo["tam"] and activo["tam"] > 0.25:
        print(f"  ⚠ La mano se ve MUY grande ({activo['tam']:.2f}). Aléjala: el detector")
        print("    necesita la mano entera y a media distancia acierta más.")
    return 0


def calibrar(demonio: "Demonio", segundos: float = 4.0) -> int:
    """Mide la geometría de TU mano en cada postura y dice qué umbrales poner.

    ── POR QUÉ HACE FALTA ────────────────────────────────────────────────────
    Los umbrales que separan un pellizco de un puño se sacaron de una mano
    SINTÉTICA (`deteccion_test.py`), y esa mano pellizca con el índice mucho más
    estirado de lo que pellizca nadie. Resultado real: «para que detecte pellizco
    tienes que colocar muy bien la mano, si no dice puño». Un puño y un pellizco
    cerrado son geométricamente casi lo mismo —en los dos el pulgar toca el
    índice— y el margen entre ambos es de centésimas, así que **no se puede
    acertar a ojo**: hay que medirlo con la mano de quien lo va a usar.

    No escribe nada. Imprime los números y los umbrales recomendados, y se
    aplican a mano en las constantes de `deteccion.py` — un ajuste que solo se
    hace una vez no merece otro fichero de configuración.
    """
    import mediapipe as mp
    from mediapipe.tasks import python as mpp
    from mediapipe.tasks.python import vision
    import cv2
    from deteccion import alcance_indice, dedos_extendidos, razon_pellizco

    detector = crear_detector(mpp, vision)
    camara = Camara(demonio.nodo, fps=demonio.otros["fps"])
    demonio.camara = camara
    print(f"Cámara: {camara.resolucion[0]}x{camara.resolucion[1]}  ·  "
          f"{demonio.otros['fps']} fps\n")
    print("Se van a medir tres posturas. Ponte a la distancia a la que vayas a")
    print("usar los gestos y mantén cada una hasta que termine la cuenta.\n")

    estado = {"marca": 0, "sello": -1}

    def medir(titulo, indicacion):
        print(f"── {titulo} ──")
        print(f"   {indicacion}")
        for c in (3, 2, 1):
            print(f"\r   empieza en {c}…   ", end="", flush=True)
            time.sleep(1)
        muestras = {"razon": [], "alcance": [], "dedos": []}
        t0 = time.monotonic()
        while time.monotonic() - t0 < segundos and camara.viva:
            frame, sello = camara.ultimo()
            if frame is None or sello == estado["sello"]:
                time.sleep(0.004)
                continue
            estado["sello"] = sello
            estado["marca"] += 1
            r = detector.detect_for_video(
                mp.Image(image_format=mp.ImageFormat.SRGB,
                         data=cv2.cvtColor(cv2.flip(frame, 1), cv2.COLOR_BGR2RGB)),
                estado["marca"] * 33)
            cands = candidatas(r)
            if not cands:
                print("\r   (no te veo la mano)          ", end="", flush=True)
                continue
            puntos = cands[0][0]
            muestras["razon"].append(razon_pellizco(puntos))
            muestras["alcance"].append(alcance_indice(puntos))
            muestras["dedos"].append(dedos_extendidos(puntos))
            print(f"\r   razón={muestras['razon'][-1]:.2f}  "
                  f"alcance={muestras['alcance'][-1]:.2f}  "
                  f"dedos={muestras['dedos'][-1]}  ({len(muestras['razon'])} muestras)   ",
                  end="", flush=True)
        print()
        return muestras

    abierta = medir("1/3 · MANO ABIERTA", "Palma abierta hacia la cámara, dedos separados.")
    puno = medir("2/3 · PUÑO CERRADO", "Cierra el puño como lo harías para pausar.")
    pellizco = medir("3/3 · PELLIZCO", "Junta pulgar e índice COMO LO HARÍAS DE VERDAD.")
    camara.cerrar()

    def resumen(nombre, m):
        if not m["razon"]:
            print(f"  {nombre:9} — sin muestras")
            return None
        n = len(m["razon"])
        orden = sorted(m["alcance"])
        p05, p50, p95 = orden[n // 20], orden[n // 2], orden[min(n - 1, n * 19 // 20)]
        print(f"  {nombre:9} {n:3} muestras · razón_pellizco mediana "
              f"{sorted(m['razon'])[n // 2]:.2f} · alcance_indice p05={p05:.2f} "
              f"mediana={p50:.2f} p95={p95:.2f} · dedos "
              f"{min(m['dedos'])}-{max(m['dedos'])}")
        return {"p05": p05, "p50": p50, "p95": p95}

    print("\n── Medido ──────────────────────────────────────────────")
    resumen("abierta", abierta)
    a_puno = resumen("puño", puno)
    a_pell = resumen("pellizco", pellizco)

    print("\n── Umbrales ────────────────────────────────────────────")
    print(f"  alcance_indice_min está en {demonio.cfg.alcance_indice_min:.2f}")
    if not a_puno or not a_pell:
        print("  Faltan muestras de alguna postura; repite la calibración.")
        return 1
    # ── EL CORTE NO VA EN EL PUNTO MEDIO ────────────────────────────────────
    # La primera versión recomendaba la mitad exacta, y con una medida real
    # (puño 0.80, pellizco 1.19) devolvía 0.99 — casi el mismo valor con el que
    # se había reportado «para que detecte pellizco hay que colocar muy bien la
    # mano». Dos motivos para sesgarlo:
    #
    #   1. Esto mide tu MEJOR pose, sostenida cuatro segundos. El gesto real se
    #      hace de pasada y con la mano moviéndose, y cae bastante más bajo.
    #   2. Los errores no cuestan lo mismo: un puño leído como pellizco agarra
    #      una ventana y se suelta abriendo la mano; un pellizco que no registra
    #      hace el gesto inutilizable.
    #
    # Así que el corte se pega al lado ESTABLE (el puño, que apenas varía) con
    # un cuarto del hueco de margen.
    SESGO = 0.25
    if a_pell["p05"] <= a_puno["p95"]:
        print(f"  ⚠ SE SOLAPAN: tu puño llega a {a_puno['p95']:.2f} y tu pellizco baja")
        print(f"    a {a_pell['p05']:.2f}. Con esta medida no hay corte que acierte siempre.")
        corte = (a_puno["p50"] + a_pell["p50"]) / 2
        print(f"    El menos malo es el punto medio de las medianas: {corte:.2f}")
        print("    Si falla mucho, prueba a pellizcar sacando algo más el índice")
        print("    hacia la cámara, o dime estos números y busco otro discriminante.")
    else:
        corte = a_puno["p95"] + SESGO * (a_pell["p05"] - a_puno["p95"])
        print(f"  ✓ Separan bien. Pon alcance_indice_min = {corte:.2f}")
        print(f"    (tu puño no pasa de {a_puno['p95']:.2f}; tu pellizco posado no baja de {a_pell['p05']:.2f})")
        print(f"    El corte NO va en medio ({(a_puno['p95'] + a_pell['p05']) / 2:.2f}) sino pegado al puño:")
        print("    esto mide tu mejor pose, y el pellizco de verdad cae más bajo.")
    print("\n  Se cambia en hypr/scripts/gestos/deteccion.py, en la clase Config.")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="Modo gestos por cámara para Hyprland")
    ap.add_argument("--nodo", help="/dev/videoN a usar (por defecto, la primera de captura)")
    ap.add_argument("-v", "--verboso", action="store_true",
                    help="imprime estado y coste por frame (para calibrar)")
    ap.add_argument("--diagnostico", nargs="?", type=float, const=15.0, metavar="SEGUNDOS",
                    help="mide qué ve la cámara sin tocar el escritorio (15 s por defecto)")
    ap.add_argument("--calibrar", action="store_true",
                    help="mide la geometría de tu mano y dice qué umbrales poner")
    args = ap.parse_args()

    cerrojo = tomar_cerrojo()
    if cerrojo is None:
        print("el modo gestos ya está en marcha", file=sys.stderr)
        return 3

    demonio = Demonio(args.nodo, args.verboso)
    try:
        demonio.preparar()
    except SystemExit as e:
        motivo = str(e)
        print(motivo, file=sys.stderr)
        # El motivo se PUBLICA además de notificarse: así Ajustes puede
        # explicar por qué el modo no está activo sin depender de que el
        # usuario llegara a ver la notificación.
        Publicador().publicar(Publicador.apagado(motivo), forzar=True)
        notificar("gestos.no-disponible", "No se puede activar el modo gestos",
                  motivo, "normal")
        return 2

    if args.calibrar:
        try:
            return calibrar(demonio)
        finally:
            demonio.cerrar()

    if args.diagnostico is not None:
        # El diagnóstico también toma el cerrojo (lo hizo arriba): la cámara es
        # de uno solo, y medirla mientras el modo está activo daría números de
        # dos consumidores peleándose por el mismo nodo.
        try:
            return diagnostico(demonio, args.diagnostico)
        finally:
            demonio.cerrar()

    # El apagado tiene que soltar la cámara SIEMPRE: si el proceso muriera con
    # el nodo abierto, el indicador de privacidad de la barra se quedaría
    # encendido y ninguna otra app podría usar la webcam.
    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(sig, lambda *_: demonio.parar.set())

    try:
        return demonio.correr()
    except Exception as e:  # noqa: BLE001
        print(f"error inesperado: {e}", file=sys.stderr)
        notificar("gestos.detenido", "Modo gestos detenido", str(e), "normal")
        return 1
    finally:
        demonio.cerrar()


if __name__ == "__main__":
    sys.exit(main())
