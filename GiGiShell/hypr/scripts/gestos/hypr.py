"""Puente con Hyprland: leer geometría y mover cosas, en la sintaxis Lua de 0.56.

── POR QUÉ ESTE FICHERO NO USA `hyprctl`, AL CONTRARIO QUE `anclaje.py` ───────
El resto de scripts del repo llama a `hyprctl` con `subprocess`, y está bien:
son de un solo disparo. Este demonio no. Durante un arrastre manda una orden por
frame, así que la diferencia entre las dos vías deja de ser un detalle. Medido en
esta máquina, 50 llamadas a `j/activewindow` por cada vía:

    socket unix directo : 0.05 ms/llamada
    hyprctl (subprocess): 7.38 ms/llamada      ← 148 veces más

A 15 fps eso son 0,75 ms/s contra 110 ms/s quemados solo en `fork`+`exec`, con el
demonio ya pagando 33 ms por frame de inferencia. Se habla con el socket.

El protocolo es el mismo que usa `hyprctl` por dentro: conectar a
`$XDG_RUNTIME_DIR/hypr/$HYPRLAND_INSTANCE_SIGNATURE/.socket.sock`, escribir la
orden y leer hasta EOF — el servidor cierra tras responder, así que es una
conexión por orden y no hay estado que mantener ni reconexión que gestionar.
El prefijo `j/` pide la respuesta en JSON.

── LA TRAMPA DE LAS COORDENADAS ──────────────────────────────────────────────
`hyprctl monitors` mezcla dos sistemas y no lo dice: **`width`/`height` vienen en
píxeles FÍSICOS, mientras que el `at`/`size` de una ventana viene en píxeles
LÓGICOS**. En este portátil (1920x1200 con escala 1.25) el monitor dice 1920x1200
pero el escritorio útil mide 1536x960, que es donde viven las ventanas. Acotar el
arrastre contra 1920x1200 dejaría meter la ventana 384 px fuera de la pantalla
por la derecha sin dar ningún error: simplemente desaparecería. Todo lo que sale
de `geometria_monitor` ya está dividido por la escala.
"""

from __future__ import annotations

import json
import os
import socket


class SinHyprland(RuntimeError):
    """No hay compositor con el que hablar (sin variables de sesión, o muerto)."""


def _ruta_socket() -> str:
    his = os.environ.get("HYPRLAND_INSTANCE_SIGNATURE")
    if not his:
        raise SinHyprland("HYPRLAND_INSTANCE_SIGNATURE no está definida")
    base = os.environ.get("XDG_RUNTIME_DIR") or f"/run/user/{os.getuid()}"
    return f"{base}/hypr/{his}/.socket.sock"


class Hypr:
    """Cliente del socket de control. Sin estado: cada orden abre y cierra."""

    def __init__(self):
        self.socket = _ruta_socket()

    # ── Transporte ──────────────────────────────────────────────────────────

    def _orden(self, texto: str) -> str:
        try:
            s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            s.settimeout(1.0)
            s.connect(self.socket)
            s.sendall(texto.encode("utf-8"))
            trozos = []
            while True:
                datos = s.recv(8192)
                if not datos:
                    break
                trozos.append(datos)
            s.close()
            return b"".join(trozos).decode("utf-8", "replace")
        except OSError as e:
            # Que el compositor no responda no puede tumbar el demonio: se ha
            # podido recargar la config justo ahora. Se devuelve vacío y el
            # llamante degrada — un gesto perdido es mejor que morirse.
            raise SinHyprland(str(e)) from e

    def json(self, que: str):
        crudo = self._orden(f"j/{que}")
        try:
            return json.loads(crudo)
        except (json.JSONDecodeError, ValueError):
            return None

    def dispatch(self, lua: str) -> bool:
        """Un dispatcher en forma Lua.

        ⚠️ Un dispatcher CONMUTABLE con argumento de CADENA es un toggle mudo
        (`hl.dsp.window.float('on')` alterna y responde `ok`). Todo lo de aquí
        usa la forma de TABLA con `action` explícito. Ver CLAUDE.md.

        El código de salida no distingue "hecho" de "error de Lua": se mira la
        respuesta, que es `ok` cuando ha ido bien.
        """
        try:
            return "ok" in self._orden(f"dispatch {lua}")
        except SinHyprland:
            return False

    # ── Consultas ───────────────────────────────────────────────────────────

    def ventana_activa(self) -> dict | None:
        v = self.json("activewindow")
        # Sin ventana enfocada, Hyprland responde `{}` (no `null`): sin la
        # comprobación del address se devolvería un dict vacío que parece una
        # ventana y revienta al primer acceso.
        if not isinstance(v, dict) or not v.get("address"):
            return None
        return v

    def geometria_monitor(self, indice: int) -> tuple[float, float, float, float] | None:
        """Rect utilizable del monitor en píxeles LÓGICOS: (x, y, ancho, alto).

        Descuenta `reserved` (la zona exclusiva de la barra y de cualquier otra
        superficie anclada) para que una ventana arrastrada al borde superior no
        quede debajo de la barra cuando el autoocultado está apagado.
        """
        monitores = self.json("monitors")
        if not isinstance(monitores, list):
            return None
        for m in monitores:
            if m.get("id") != indice:
                continue
            escala = float(m.get("scale") or 1.0) or 1.0
            # Ver la cabecera: width/height son FÍSICOS, x/y y las ventanas son
            # lógicos.
            ancho, alto = float(m["width"]) / escala, float(m["height"]) / escala
            izq, arriba, der, abajo = (m.get("reserved") or [0, 0, 0, 0])[:4]
            return (
                float(m["x"]) + izq,
                float(m["y"]) + arriba,
                max(ancho - izq - der, 1.0),
                max(alto - arriba - abajo, 1.0),
            )
        return None

    # ── Acciones ────────────────────────────────────────────────────────────

    def cambiar_workspace(self, delta: int) -> bool:
        """Al escritorio siguiente/anterior DE LOS QUE EXISTEN.

        `e+1`/`e-1` y no `+1`/`-1`: con el segundo, un swipe a la derecha desde
        el último escritorio crea uno vacío nuevo, y repetir el gesto va dejando
        escritorios vacíos detrás. Es la misma forma que ya usa la rueda del
        ratón en `gigios/keybinds.lua`, así que gesto y rueda se comportan
        igual.
        """
        return self.dispatch(f"hl.dsp.focus({{workspace='e{delta:+d}'}})")

    #: Direcciones del motor → las que entiende Hyprland.
    DIRECCIONES = {
        "izquierda": "left", "derecha": "right", "arriba": "up", "abajo": "down",
    }

    def recolocar(self, direccion: str, ventana: str) -> bool:
        """Recoloca una ventana EN MOSAICO hacia un lado, sin sacarla del mosaico.

        Es lo único correcto para una ventana tilada: su posición la decide el
        layout, así que no se le puede dar una coordenada — se le pide que se
        recoloque y Hyprland rehace el reparto.

        ── EL `preselect` DE DELANTE NO ES ADORNO ─────────────────────────────
        Es la misma secuencia de tres pasos que usa SUPER+SHIFT+flecha en
        `gigios/keybinds.lua`, y allí está medida: dwindle resuelve
        `movewindow <dir>` sacando la ventana del árbol y reinsertándola junto a
        un punto focal 1 px más allá del borde, y el lado del corte sale de en
        qué CUADRANTE del vecino cae ese punto — un ángulo, no la dirección que
        has pedido. Con dos ventanas coincide; con tres o más, no. `preselect`
        fija `m_overrideDirection`, que tiene prioridad sobre ese cálculo.

        El `preselect none` del final limpia el override. Hyprland lo consume al
        reinsertar, pero un `movewindow` que NO mueve nada (la ventana ya está
        en ese borde) sale antes de tocar el árbol y lo dejaría puesto: la
        siguiente ventana que abrieras nacería en esa dirección sin que nadie lo
        haya pedido. En un gesto esto pasa constantemente — llevas la mano al
        borde y sigues empujando —, así que aquí importa más que con el teclado.
        """
        d = self.DIRECCIONES.get(direccion)
        if not d:
            return False
        self.dispatch(f"hl.dsp.layout('preselect {d}')")
        ok = self.dispatch(
            f"hl.dsp.window.move({{direction='{d}', window='address:{ventana}'}})"
        )
        self.dispatch("hl.dsp.layout('preselect none')")
        return ok

    def alternar_flotante(self, ventana: str) -> bool:
        """Saca la ventana del mosaico, o la devuelve. Es un flip-flop.

        `action='toggle'` en TABLA. Aquí el toggle es lo que se QUIERE, pero la
        forma de tabla sigue siendo obligatoria por otro motivo: con la cadena
        `'toggle'` Hyprland tira el argumento **y también el selector `window`**,
        así que alternaría la ventana ACTIVA en vez de la que se le pide. Con la
        activa suele coincidir, y por eso el fallo pasaría desapercibido hasta el
        día en que el foco cambie a mitad de gesto.
        """
        return self.dispatch(
            f"hl.dsp.window.float({{action='toggle', window='address:{ventana}'}})"
        )

    def mover(self, direccion: str, x: float, y: float) -> bool:
        """Coloca la ventana en una posición ABSOLUTA (píxeles lógicos).

        ⚠️ SOLO para una ventana que YA esté flotando. Sobre una en mosaico
        responde `ok` y no hace nada (medido; ver el final de esta cadena), y el
        modo gestos **nunca la pone a flotar para poder moverla**: eso la sacaría
        del reparto y ya no volvería a recolocarse sola. Para una ventana tilada,
        `recolocar()`.

        La firma la da el propio compositor cuando se le pasa una clave que no
        conoce, y es la fuente que hay que creer:

            hl.window.move: unrecognized arguments.
            Expected one of: direction, x+y(+relative), workspace,
                             into_group, out_of_group

        O sea `x`+`y` sin `relative` = absoluto. Se usa el absoluto y no el
        relativo a propósito: en absoluto, un frame perdido no descoloca nada
        porque cada orden recoloca desde el ancla, mientras que sumando
        incrementos el error se acumula y la ventana se queda atrás de la mano.

        ── ⚠️ `w.at` NO VALE PARA ESTO, Y MIENTE AL COMPROBARLO ────────────────
        `HL.Window` tiene un campo `at`, y el camino evidente sería asignarlo.
        No funciona: el compositor responde «attempt to modify read-only hl
        object» y la ventana no se mueve.

        Lo peligroso es cómo se comporta al medirlo. Un `pcall` alrededor de la
        asignación devuelve **`ok=true, err=nil`** — comprobado— porque el
        rechazo no es un `error()` de Lua que pcall pueda atrapar: se anota en
        la respuesta del `eval` y la ejecución sigue como si nada. Así que la
        sonda "¿es escribible?" contesta que SÍ, la ventana no se mueve, y no
        hay ninguna excepción a la que agarrarse. Solo mirando la RESPUESTA
        cruda del socket (no el pcall, no el código de salida, no `hyprctl`,
        que se come el mensaje) aparece el error. Lo mismo vale para `w.size`.

        Se busca por dirección y no con `hl.get_active_window()`: el foco puede
        cambiar a mitad de arrastre (una notificación, un menú) y entonces se
        estaría moviendo una ventana distinta de la que se agarró.

        ── Y SOBRE UNA VENTANA EN MOSAICO NO HACE NADA, RESPONDIENDO `ok` ─────
        Medido: sobre una ventana tilada devuelve True y la deja exactamente
        donde estaba. Tiene sentido —la posición la decide el layout— pero
        significa que el valor de retorno NO se puede leer como "se ha movido":
        no sirve para descubrir si la ventana era flotante intentándolo. Por eso
        `gestos.py` mira `floating` al agarrar y elige el camino, en vez de
        probar este y ver si coló.
        """
        return self.dispatch(
            f"hl.dsp.window.move({{x={int(x)}, y={int(y)}, "
            f"window='address:{direccion}'}})"
        )
