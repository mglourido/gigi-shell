#!/usr/bin/env python3
"""
anclaje.py — anclar al escritorio de lanzamiento las ventanas de una app.

Es el motor de `lanzar-anclado.py`, por el que pasan los DOS lanzadores (Orion
directamente; rofi con `-run-command`, ver `rofi-launch.py`): aquí vive TODA la
lógica (identidad de la app, observación del socket de eventos, anclaje y rama
single-instance). Antes esto vivía dentro de rofi-launch.py y las apps abiertas
desde Orion no tenían anclaje ninguno: aparecían en el escritorio donde
estuvieras al terminar de cargar, no en el que las lanzaste.

Tras lanzar una app, si resulta ser single-instance (no se crea ninguna ventana
nueva pero la app pide atención sobre una ya existente), trae esa ventana al
workspace actual y la enfoca. Si la app abre ventanas nuevas, las ancla al
workspace donde la lancé — aunque me haya cambiado de workspace mientras cargaba.

Detección: se escucha el socket de eventos de Hyprland (.socket2.sock).
  - openwindow de una dirección NUEVA  -> multi-instancia / primer arranque -> anclar.
  - urgent de una dirección que YA existía -> relanzamiento single-instance -> mover.

Por qué el evento `urgent` y no el foco: con misc:focus_on_activate = false
(por defecto), al relanzar una app single-instance Hyprland NO cambia el foco
ni el workspace; solo marca la ventana existente como "urgent". Ese es el único
evento fiable de que "intentaste abrir algo que ya estaba abierto".

EL ANCLAJE SE LIMITA A LA APP QUE LANZASTE, y esa restricción es el núcleo del
diseño. Antes se anclaba *cualquier* ventana nacida en la ventana de observación,
porque se asumía que la única ventana nueva tras elegir en el lanzador sería la
de la app elegida. Es falso: un diálogo que abre otra app al pulsar un botón, un
popup de Steam/Heroic o un splash ajeno también emiten `openwindow`, y se los
llevaba al workspace de lanzamiento — el síntoma era "ventanas que aparecen de
repente y se van solas al workspace 1". La identidad se deduce de la PRIMERA
ventana nueva: su `initialClass` y su pid. A partir de ahí solo se ancla lo que
coincida en clase o cuelgue de ese mismo árbol de procesos. Aunque se conoce el
comando lanzado, no sirve de identidad: el pid del `sh -c` no siempre es el de
la ventana (wrappers, `gtk-launch`, apps que se re-exec, y el `exec` lo hace
Hyprland, que no devuelve pid), así que la primera ventana nueva sigue siendo la
señal más fiable.

LA OBSERVACIÓN NO TERMINA EN LA PRIMERA VENTANA, y eso es lo que arregla los
multiventana. Con el `return` de antes, una app con splash + ventana principal
solo anclaba una de las dos y la otra quedaba donde naciera: la app acababa
PARTIDA entre dos workspaces, que es peor que no anclar nada. Ahora se siguen
anclando todas las de esa identidad hasta agotar el timeout.

EL TIMEOUT SALE DE UNA MEDICIÓN, no de una corazonada. Medido en esta máquina el
retardo entre el exec y cada `openwindow`: kitty 0,1 s, firefox 0,5 s y **Steam
3,1 / 6,8 / 10,0 s — tres ventanas**. Steam manda porque es lo más lento que se
lanza desde el lanzador (los juegos NO se lanzan desde aquí: no hay
`steam_app_*.desktop`).

Los 5 s originales cortaban a Steam por la mitad: se anclaba su primera ventana
—el splash, que además llega con la clase vacía— y las otras dos quedaban donde
nacieran. 15 s cubre el peor caso real con 50 % de margen.

No se deja más alto porque el único coste del número es de CORRECCIÓN, no de
consumo: cuanto más dura la observación, más rato hay para que una ventana ajena
fije la identidad. En consumo es gratis — medido, el proceso hace **0 wakeups y
0 ms de CPU** con el escritorio quieto, porque está bloqueado en `recv()` y no
sondea. Acortarlo por batería no ahorraría nada.

Ver diseño: docs/superpowers/specs/2026-06-13-rofi-single-instance-move-design.md
"""

import json
import os
import socket
import subprocess
import time

# --- Configuración ---
TIMEOUT = 15.0      # segundos máximos de observación tras lanzar
PID_MAX_DEPTH = 12  # niveles de ancestros a recorrer al emparentar ventanas

# Clases que NUNCA pueden ser la app que lanzaste: diálogos del portal
# (Abrir/Guardar archivo). No se lanzan desde el lanzador — los abre una app que
# ya estaba corriendo, al pulsar un botón. Se ignoran por completo: ni fijan
# identidad ni se anclan.
#
# Hacen falta aparte de la guarda de "flotante y de clase ya vista" porque no la
# activan: el portal no deja ninguna ventana abierta entre usos, así que su clase
# nunca está en `before_classes`. Sin esta lista, abrir un selector de archivos
# dentro de la ventana de observación lo convertía en la identidad de la app
# lanzada — se anclaba el diálogo y la app de verdad quedaba suelta.
NEVER_APP = {
    "xdg-desktop-portal-gtk",
    "xdg-desktop-portal-gnome",
    "xdg-desktop-portal-kde",
    "org.freedesktop.impl.portal.desktop.gtk",
    "org.freedesktop.impl.portal.desktop.gnome",
    "org.freedesktop.impl.portal.desktop.kde",
}

# Apps de UNA sola ventana que además nace al instante (kitty: 0,1 s medido). En
# cuanto su ventana queda anclada no hay nada más que esperar, así que el
# observador termina ahí en vez de agotar los 15 s: menos rato vivo es menos
# rato compitiendo con otros lanzamientos por ventanas que no son suyas. Solo
# entra lo que no abre splash ni ventanas auxiliares — si una de estas trajera
# una segunda ventana, quedaría sin anclar.
UNA_VENTANA = {
    "kitty",
    "foot",
    "Alacritty",
    "org.wezfurlong.wezterm",
}


def _literal_lua(texto):
    """`texto` como literal de cadena Lua entre comillas simples.

    El comando de un `.desktop` puede traer comillas de los dos tipos y
    barras invertidas; se escapa lo que rompería el literal en vez de usar
    corchetes largos `[[…]]`, que fallarían con un `]]` dentro del comando.
    Verificado en anidada: el escapado entrega el comando byte a byte al shell
    que exec_cmd lanza por debajo (redirecciones incluidas).
    """
    return "'" + (texto.replace("\\", "\\\\").replace("'", "\\'")
                  .replace("\n", "\\n").replace("\r", "\\r")) + "'"


def hypr_j(*args):
    out = subprocess.run(["hyprctl", "-j", *args],
                         capture_output=True, text=True).stdout
    return json.loads(out)


def dispatch(lua):
    """Manda un dispatcher en la forma Lua de Hyprland 0.56.

    Firmas verificadas en instancia anidada con config Lua, no supuestas:
      mover en silencio -> hl.dsp.window.move({workspace=N, window='address:0x…',
          follow=false})  (sin follow SÍ cambia el foco y el workspace activo —
          `follow=false` es lo que hace el "silent"; un `silent=true` se ignora)
      mover siguiendo    -> igual con follow=true
      enfocar            -> hl.dsp.focus({window='address:0x…'})
    El selector por string necesita el prefijo `address:`; un '0x…' a secas no
    casa y el dispatcher mueve la VENTANA ACTIVA. Las direcciones son hex puro,
    así que van en el literal sin escapado.

    Aquí hubo un fallback a la sintaxis legacy, porque durante la migración la
    sesión viva podía seguir en config hyprlang mientras el script en disco ya
    era el nuevo. Los `.conf` del compositor ya no existen en el repo, así que
    esa rama era código muerto que solo servía para tragarse errores.
    """
    subprocess.run(["hyprctl", "dispatch", lua],
                   capture_output=True, text=True)


def mover_a_workspace(addr, ws, follow):
    """Mueve una ventana a otro escritorio SIN que dwindle desordene el destino.

    Mover es reinsertar en el árbol del destino: dwindle parte allí la última
    enfocada, y con `dwindle:smart_split` el eje de ese corte sale del cuadrante
    del CURSOR sobre ella. Aquí el cursor no señala el destino —está donde lo
    dejaste al lanzar la app— así que el eje salía a suertes y el escritorio de
    llegada acababa en tiras. El envoltorio `GiGiShell.sin_smart_split` de
    gigishell/ventanas.lua apaga el ajuste mientras dura la inserción y lo
    restaura; allí está la medición y por qué `preselect` NO vale para esto.

    Va por `hyprctl eval` y no por `dispatch` porque hace falta ejecutar una
    CLOSURE en el estado Lua del config, que es donde vive el global GiGiShell
    (verificado: `eval` acepta varias sentencias y ejecuta funciones anónimas;
    lo que no hace es devolver su valor — siempre responde "ok").

    Si el envoltorio no existiera —config a medio recargar, ventanas.lua roto—
    se mueve igual, sin él: llegar desordenada es mejor que no llegar.
    """
    lua = (f"hl.dsp.window.move({{workspace={ws}, window='address:{addr}', "
           f"follow={'true' if follow else 'false'}}})")
    r = subprocess.run(
        ["hyprctl", "eval",
         "if GiGiShell and GiGiShell.sin_smart_split then "
         f"GiGiShell.sin_smart_split(function() hl.dispatch({lua}) end) "
         f"else hl.dispatch({lua}) end"],
        capture_output=True, text=True)
    # El rc de hyprctl no distingue "ejecutado" de "error de Lua" (la misma
    # trampa que documenta el CLAUDE.md raíz («El config es LUA») para dispatch): se mira el stdout.
    if "ok" not in r.stdout:
        dispatch(lua)


def anclaje_activado():
    """Lee `anclarVentanasRofi` de preferences.json (Ajustes > Personalización).

    Se lee en CADA invocación y no hace falta reiniciar nada: ninguno de los dos
    lanzadores es un daemon — rofi y Orion lanzan lanzar-anclado.py de cero por
    cada app abierta.
    Por eso su setter en AGS no necesita el pkill + re-exec de los monitores.

    La clave es UNA para los dos lanzadores aunque su nombre diga "Rofi": para
    quien la usa es una sola función ("las apps se abren donde las lancé") y
    partirla en dos interruptores solo permitiría dejarla a medias. El nombre se
    conserva porque ya está escrito en el `preferences.json` de la máquina y
    renombrarlo apagaría el anclaje en silencio al primer arranque.

    Ausente o ilegible = activado, que es la convención del repo y además el
    fallo seguro: degradar a "el ajuste no se aplica" es visible y arreglable;
    degradar a "el anclaje se apagó solo" sería mudo.
    """
    ruta = os.path.join(
        os.environ.get("XDG_CONFIG_HOME", os.path.expanduser("~/.config")),
        "gigishell", "preferences.json")
    try:
        with open(ruta, "rb") as f:
            return json.load(f).get("anclarVentanasRofi", True) is not False
    except (OSError, ValueError):
        return True


def limite_mosaico():
    """Lee `maxVentanasEscritorio` (el tope de gigishell/limite-ventanas.lua).

    Ausente = 8, igual que el módulo Lua; <= 0 significa "sin tope". Ver la
    sección de `_hueco_en` para por qué el anclaje tiene que consultarlo.
    """
    ruta = os.path.join(
        os.environ.get("XDG_CONFIG_HOME", os.path.expanduser("~/.config")),
        "gigishell", "preferences.json")
    try:
        with open(ruta, "rb") as f:
            valor = json.load(f).get("maxVentanasEscritorio", 8)
        return int(valor)
    except (OSError, ValueError, TypeError):
        return 8


def _hueco_en(clientes, ws_id, addr, limite):
    """¿Cabe `addr` en el escritorio `ws_id` sin rebasar el tope?

    EL ANCLAJE Y EL TOPE TIRABAN EN DIRECCIONES CONTRARIAS, y ganaba el anclaje
    porque llega el último. Al lanzar sobre un escritorio lleno,
    `gigishell/limite-ventanas.lua` mueve la ventana nueva al siguiente con sitio y
    te lleva con ella; acto seguido el `openwindow` llegaba aquí, se veía una
    ventana "descolocada" respecto al escritorio de lanzamiento y se la devolvía
    en silencio. Resultado: tú en el escritorio nuevo y la ventana en el viejo —
    peor que cualquiera de las dos funciones por separado, y sin ningún error.
    Deshacía además justo lo que el tope existe para evitar: la novena ventana
    volvía a apretujarse con las otras ocho.

    Manda el tope, que es la misma jerarquía que documenta docs/hyprland-modulos.md (tope de ventanas): el
    lanzador decide DÓNDE nace la ventana, el tope decide SI ahí cabe — y es el
    único de los dos que sabe algo que el lanzador no podía saber al lanzar.

    El recuento replica el del módulo Lua y tiene que seguir haciéndolo: solo
    mosaico (ni flotantes ni ocultas por `swallow`, que no ocupan hueco del
    layout) y sin contar la propia ventana, que aún no está allí. Con `limite`
    ventanas ya puestas no cabe: al volver serían limite+1, exactamente lo que
    el módulo acaba de deshacer, y se entraría en un tira y afloja.
    """
    if limite <= 0:
        return True
    n = 0
    for c in clientes:
        if c["address"] == addr:
            continue
        if c.get("floating") or c.get("hidden"):
            continue
        ws = c.get("workspace") or {}
        if ws.get("id") == ws_id:
            n += 1
    return n < limite


def event_socket_path():
    xdg = os.environ.get("XDG_RUNTIME_DIR", f"/run/user/{os.getuid()}")
    sig = os.environ["HYPRLAND_INSTANCE_SIGNATURE"]
    return f"{xdg}/hypr/{sig}/.socket2.sock"


def client_of(addr):
    """Datos de la ventana recién abierta, o None si aún no está publicada.

    Se pide el cliente entero (workspace + clase + pid) en UNA llamada: son los
    tres datos que hacen falta por ventana y `hyprctl clients` no es barato.
    """
    for c in hypr_j("clients"):
        if c["address"] == addr:
            return c
    return None


def ppid_of(pid):
    """Padre de un pid leyendo /proc, o None.

    Se usa el campo 4 de `stat` partiendo por el ÚLTIMO ")": el nombre del
    proceso va entre paréntesis y puede contener espacios y paréntesis, así que
    un split() a secas desalinea los campos en procesos con nombres raros.
    """
    try:
        with open(f"/proc/{pid}/stat", "rb") as f:
            data = f.read().decode(errors="replace")
        return int(data[data.rindex(")") + 1:].split()[1])
    except (OSError, ValueError):
        return None


def is_descendant(pid, ancestor):
    """¿`pid` cuelga de `ancestor` (o es él mismo)?

    Cubre los splashes con clase DISTINTA a la ventana principal (lanzadores
    Java, instaladores, Electron con proceso aparte): comparten árbol de
    procesos aunque no compartan clase. El tope de profundidad evita quedarse
    dando vueltas si /proc devuelve algo incoherente a mitad del recorrido.
    """
    if not pid or not ancestor:
        return False
    for _ in range(PID_MAX_DEPTH):
        if pid == ancestor:
            return True
        pid = ppid_of(pid)
        if not pid or pid <= 1:
            return False
    return False


def foto_previa():
    """Direcciones, clases y workspace activo, en UNA consulta de clientes.

    `observe` necesita las dos primeras y pedirlas por separado eran dos forks de
    hyprctl por lanzamiento. Además es más fiel: si una ventana se cierra
    mientras el lanzador está abierto, su clase sigue contando como "ya existía
    al lanzar", que es lo que se quiere saber.
    """
    clientes = hypr_j("clients")
    before = {c["address"] for c in clientes}
    before_classes = {c.get("initialClass", "") for c in clientes}
    return before, before_classes, hypr_j("activeworkspace")["id"]


def conectar_eventos():
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.connect(event_socket_path())
    return sock


# Opciones de `env` que consumen el argumento siguiente.
_ENV_CON_ARG = {"-u", "--unset", "-C", "--chdir", "-S", "--split-string"}


def pista_de_comando(tokens):
    """Nombre del programa que lanza un argv, en minúsculas, o None.

    Es la PISTA con la que un lanzamiento reconoce su ventana antes de tener
    identidad: `/usr/lib/firefox/firefox %u` -> "firefox". Se saltan `env`, sus
    opciones y las asignaciones `VAR=x`, que son lo habitual en un `Exec`.
    Un envoltorio genérico (`sh -c …`, `flatpak run …`) da una pista que no
    casará con ninguna ventana, y entonces todo funciona como sin pista.
    """
    i = 0
    if tokens and os.path.basename(tokens[0]) == "env":
        i = 1
        while i < len(tokens):
            t = tokens[i]
            if t in _ENV_CON_ARG:
                i += 2
            elif t.startswith("-") or "=" in t:
                i += 1
            else:
                break
    while i < len(tokens) and "=" in tokens[i] and not tokens[i].startswith("/"):
        i += 1
    if i >= len(tokens):
        return None
    return os.path.basename(tokens[i]).lower() or None


def comm_de(pid):
    """`comm` del proceso (nombre corto, 15 caracteres como mucho), o ""."""
    try:
        with open(f"/proc/{pid}/comm", "rb") as f:
            return f.read().decode(errors="replace").strip().lower()
    except OSError:
        return ""


def casa_pista(pista, cls, comm):
    """¿La ventana (clase `cls`, proceso `comm`) es del programa `pista`?

    `comm` lo trunca el kernel a 15 caracteres, así que la pista se compara
    truncada igual. La clase sirve cuando el proceso de la ventana no se llama
    como el ejecutable (wrappers que hacen exec de otro binario).
    """
    if not pista:
        return False
    return pista[:15] == comm or pista == (cls or "").lower()


class Registro:
    """Lo que cada observador vivo ha reclamado, para que no se pisen entre sí.

    CADA LANZAMIENTO TIENE SU OBSERVADOR y vive sus 15 s por su cuenta, así que
    dos lanzamientos seguidos dejan dos observadores escuchando el mismo socket.
    Sin coordinarse, el VIEJO se llevaba la ventana del NUEVO a su escritorio de
    lanzamiento — el síntoma era "me cambio de escritorio, abro una app y aparece
    en el anterior", raro porque exige lanzar dos cosas en menos de 15 s. Pasaba
    en dos casos: el viejo aún no había fijado identidad (su app no abrió ventana
    nueva) y adoptaba la primera que naciera, o las dos apps tenían la misma
    clase (dos kitty) y el viejo la daba por suya.

    Cada observador publica aquí su identidad en un fichero de
    $XDG_RUNTIME_DIR/gigishell-anclaje/ (tmpfs). La clave del nombre ordena los
    lanzamientos (monotonic_ns, luego el pid). Ante una ventana nueva, cada uno
    decide con `cede()` si es suya; las reglas están allí.

    Fallo seguro: si el directorio no se puede usar, el observador trabaja solo,
    como antes de esto — anclar de más es mejor que dejar de anclar.

    El mismo reparto se replica en el compositor (`gigishell/anclaje-temprano
    .lua`), que actúa ANTES que este proceso: allí se registran la pista del
    lanzamiento mientras espera su primera ventana (`ws`, solo si el anclaje
    está activo) y, al fijar la identidad, el pid de la app. Las llamadas a
    `hyprctl eval` van guardadas con `if GiGiShell and …`: si el config está a
    medio recargar no hacen nada y sigue valiendo el anclaje de aquí, con
    parpadeo pero sin perder la ventana.
    """

    def __init__(self, pista=None, ws=None):
        xdg = os.environ.get("XDG_RUNTIME_DIR", f"/run/user/{os.getuid()}")
        self.dir = os.path.join(xdg, "gigishell-anclaje")
        self.clave = f"{time.monotonic_ns():020d}-{os.getpid()}"
        self.ruta = os.path.join(self.dir, self.clave + ".json")
        self.pista = pista
        self.espera_lua = False   # ¿hay una espera registrada en el compositor?
        self.pid_lua = None       # ¿y un pid anclado?
        try:
            os.makedirs(self.dir, exist_ok=True)
            self.publicar(None, None)
        except OSError:
            self.ruta = None
        if pista and isinstance(ws, int) and ws >= 1:
            self._eval(f"GiGiShell.esperar_lanzamiento('{self.clave}', "
                       f"{_literal_lua(pista)}, {ws})")
            self.espera_lua = True

    @staticmethod
    def _eval(lua):
        subprocess.run(["hyprctl", "eval",
                        f"if GiGiShell and GiGiShell.anclar_pid then {lua} end"],
                       capture_output=True, text=True)

    def publicar(self, app_class, app_pid):
        if self.ruta is None:
            return
        tmp = self.ruta + ".tmp"
        try:
            with open(tmp, "w") as f:
                json.dump({"clase": app_class, "pid": app_pid,
                           "pista": self.pista}, f)
            os.replace(tmp, self.ruta)
        except OSError:
            pass

    def fijar_identidad(self, app_class, app_pid, ws_temprano):
        """Publica la identidad y la pasa al compositor en UN solo `eval`.

        Con identidad ya no hay espera que mantener; y si `ws_temprano` vale,
        el compositor ancla él las ventanas POSTERIORES del pid: la regla del
        exec solo cubre la primera, y las siguientes (Writer tras la splash de
        LibreOffice, las tardías de Steam) nacerían en el escritorio activo y
        este observador las movería tarde, con parpadeo.
        """
        self.publicar(app_class, app_pid)
        lua = []
        if self.espera_lua:
            lua.append(f"GiGiShell.fin_espera('{self.clave}')")
            self.espera_lua = False
        if app_pid and isinstance(ws_temprano, int) and ws_temprano >= 1:
            lua.append(f"GiGiShell.anclar_pid({int(app_pid)}, {ws_temprano})")
            self.pid_lua = int(app_pid)
        if lua:
            self._eval("; ".join(lua))

    def cerrar(self):
        lua = []
        if self.espera_lua:
            lua.append(f"GiGiShell.fin_espera('{self.clave}')")
            self.espera_lua = False
        if self.pid_lua:
            lua.append(f"GiGiShell.soltar_pid({self.pid_lua})")
            self.pid_lua = None
        if lua:
            self._eval("; ".join(lua))
        if self.ruta is not None:
            try:
                os.remove(self.ruta)
            except OSError:
                pass

    def otros(self):
        """[(clave, clase, pid, pista)] de los demás observadores VIVOS.

        Un fichero cuyo dueño ya no existe (observador matado sin `finally`) se
        borra al verlo: si no, un fantasma "sin identidad" se quedaría para
        siempre reclamando ventanas ajenas.
        """
        if self.ruta is None:
            return []
        res = []
        try:
            nombres = os.listdir(self.dir)
        except OSError:
            return []
        for n in nombres:
            if not n.endswith(".json") or n == self.clave + ".json":
                continue
            clave = n[:-5]
            try:
                dueño = int(clave.rsplit("-", 1)[1])
            except (IndexError, ValueError):
                continue
            ruta = os.path.join(self.dir, n)
            if not os.path.exists(f"/proc/{dueño}"):
                try:
                    os.remove(ruta)
                except OSError:
                    pass
                continue
            try:
                with open(ruta, "rb") as f:
                    d = json.load(f)
            except (OSError, ValueError):
                continue
            res.append((clave, d.get("clase"), d.get("pid"), d.get("pista")))
        return res

    def hay_posterior(self):
        return any(o[0] > self.clave for o in self.otros())


def cede(mi_clave, mi_desc, cls, pid, otros, mi_pista=None, comm=""):
    """¿Debe este observador dejar la ventana (clase `cls`, pid `pid`) a otro?

    Se llama solo cuando este observador la reclamaría. Reglas, por orden:
      0. Un lanzamiento que aún ESPERA su primera ventana y cuyo programa casa
         con ella (pista contra `comm` o clase) se la queda; el más reciente si
         son varios. Es lo que separa dos lanzamientos de Firefox seguidos: la
         ventana del segundo la crea el proceso del PRIMERO (cuelga de su pid),
         pero es la que acabas de pedir. Sin esta regla se iba al escritorio
         del primer lanzamiento.
      1. Si no, si la ventana cuelga del árbol de procesos de algún lanzamiento,
         es de ese (del más reciente si cuelga de varios). Así las ventanas
         tardías de Steam siguen yendo con Steam aunque mientras tanto hayas
         lanzado otra cosa — su pista no casa con Steam.
      2. Si no, se la queda el lanzamiento MÁS RECIENTE que la reclame (por clase
         o porque aún no tiene identidad y la adoptaría). Es la que acabas de
         pedir, y la que tiene que nacer donde estás ahora.

    `mi_desc`: si la ventana cuelga de MI árbol. `mi_pista`: la mía, solo si aún
    no tengo identidad (con identidad ya no espero nada). Pura y sin E/S salvo
    /proc, para poder probarla sin Hyprland.
    """
    esperan = [c for c, k, _, ps in otros
               if k is None and casa_pista(ps, cls, comm)]
    if casa_pista(mi_pista, cls, comm):
        return any(c > mi_clave for c in esperan)
    if esperan:
        return True
    desc = [c for c, _, p, _ in otros if p and is_descendant(pid, p)]
    if mi_desc:
        return any(c > mi_clave for c in desc)
    if desc:
        return True
    return any(c > mi_clave and (k is None or k == cls) for c, k, _, _ in otros)


def observe(sock, before, target_ws, timeout=TIMEOUT, anclar=True,
            before_classes=None, registro=None):
    """Bucle de eventos: ancla las ventanas de la app lanzada a `target_ws`.

    Está separado del main() de cada lanzador para poder ejercitarlo contra
    eventos reales sin pasar por rofi ni por Orion, que son interactivos y no se
    pueden guionizar.

    `registro`: el lanzador debe crearlo ANTES de lanzar (`lanzar-anclado.py`),
    para que un observador anterior ya lo vea cuando nazca la ventana; si no se
    pasa, se crea aquí (las pruebas). Se borra siempre al salir.
    """
    if registro is None:
        registro = Registro()
    try:
        _observe(sock, before, target_ws, timeout, anclar, before_classes,
                 registro)
    finally:
        registro.cerrar()


def _observe(sock, before, target_ws, timeout, anclar, before_classes,
             registro):
    # Identidad de la app lanzada, fijada por la primera ventana nueva.
    app_class = None   # initialClass: no cambia aunque la app se renombre en marcha
    app_pid = None

    # Clases que ya existían al lanzar, para reconocer diálogos de apps vivas.
    # Normalmente las pasa el lanzador desde su foto previa; se recalculan solo
    # si se llama a observe() suelto (las pruebas).
    if before_classes is None:
        before_classes = {c.get("initialClass", "") for c in hypr_j("clients")
                          if c["address"] in before}

    # Tope de mosaico: se lee UNA vez por lanzamiento (el proceso vive 15 s).
    limite = limite_mosaico()

    fin = time.monotonic() + timeout
    buf = b""
    while True:
        restante = fin - time.monotonic()
        if restante <= 0:
            return
        sock.settimeout(restante)
        try:
            data = sock.recv(4096)
        except socket.timeout:
            return
        if not data:
            break
        buf += data
        *lines, buf = buf.split(b"\n")
        for raw in lines:
            event, _, payload = raw.decode(errors="replace").partition(">>")

            if event == "openwindow":
                # openwindow>>ADDR,WORKSPACE,CLASS,TITLE  (ADDR sin "0x")
                addr = "0x" + payload.split(",", 1)[0]
                if addr in before:
                    continue

                # Una sola consulta de clientes por ventana nueva: de ella salen
                # el cliente (clase, pid, workspace) y el recuento de mosaico
                # del escritorio destino. Pedirlas por separado serían dos forks
                # de hyprctl, y encima de dos instantes distintos.
                clientes = hypr_j("clients")
                cli = next((c for c in clientes if c["address"] == addr), None)
                if cli is None:
                    # El evento llegó antes de que Hyprland publicara el cliente.
                    # Sin clase ni pid no se puede decidir de quién es: se ignora
                    # en vez de anclar a ciegas, que es el fallo que se arregla.
                    continue

                cls, pid = cli.get("initialClass", ""), cli.get("pid", 0)

                if cls in NEVER_APP:
                    continue

                mi_desc = app_pid is not None and is_descendant(pid, app_pid)
                if app_class is None:
                    # Primera ventana nueva: ella define qué es "la app lanzada".
                    # Salvo que sea un diálogo de algo que YA estaba corriendo:
                    # flotante y de una clase presente antes de lanzar. Eso no
                    # puede ser lo que acaba de abrir el lanzador (relanzar algo
                    # ya abierto va por la rama `urgent`, no por `openwindow`), y
                    # dejar que fije la identidad es el fallo peor posible: se
                    # ancla el diálogo ajeno y la app de verdad se queda suelta.
                    # Importa sobre todo con apps lentas, donde la espera deja
                    # 30 s para que se cuele algo por delante.
                    if cli.get("floating") and cls in before_classes:
                        continue
                elif not (cls == app_class or mi_desc):
                    # Ventana de otra app abierta por casualidad durante la
                    # observación (un diálogo, un popup): no es nuestra.
                    continue

                # La reclamaría, pero puede ser de OTRO lanzamiento que siga
                # observando: cada uno se queda solo con lo suyo (Registro).
                # Cediendo tampoco se adopta como identidad.
                otros = registro.otros()
                if cede(registro.clave, mi_desc, cls, pid, otros,
                        mi_pista=registro.pista if app_class is None else None,
                        comm=comm_de(pid) if otros or app_class is None else ""):
                    continue

                if app_class is None:
                    app_class, app_pid = cls, pid
                    # Las apps de una sola ventana terminan aquí mismo: no
                    # habrá ventanas posteriores que anclar en el compositor.
                    registro.fijar_identidad(
                        app_class, app_pid,
                        target_ws if anclar and app_class not in UNA_VENTANA
                        else None)

                # Anclar al workspace donde lancé. Si me cambié mientras cargaba,
                # la traigo en silencio (silent = no me arrastra de vuelta).
                #
                # El ajuste apaga SOLO esto. La rama `urgent` de abajo (traerte una
                # app ya abierta al relanzarla) es otra función, no da problemas y
                # el interruptor no la nombra, así que sigue activa.
                #
                # Salvo que el escritorio de lanzamiento esté LLENO: entonces la
                # ventana ya la apartó gigishell/limite-ventanas.lua y traerla de
                # vuelta sería deshacer el tope y dejarte además mirando otro
                # escritorio. Ver _hueco_en().
                if (anclar and cli["workspace"]["id"] != target_ws
                        and _hueco_en(clientes, target_ws, addr, limite)):
                    mover_a_workspace(addr, target_ws, follow=False)

                if app_class in UNA_VENTANA:
                    return

            elif event == "urgent":
                # urgent>>ADDR  (ADDR sin "0x")
                addr = "0x" + payload.strip()
                # Solo si NO se ha abierto ya una ventana nueva: una vez que sabemos
                # que la app arrancó de verdad, un `urgent` posterior es de otra cosa
                # (una notificación entrante) y moverla sería robar una ventana ajena.
                # Y solo el lanzamiento más reciente: el relanzamiento que acaba
                # de pedir atención es el último que hiciste, no uno de antes.
                if (addr in before and app_class is None
                        and not registro.hay_posterior()):
                    # Relanzamiento single-instance: traer al workspace actual.
                    cli = client_of(addr)
                    if cli and cli["workspace"]["id"] != target_ws:
                        mover_a_workspace(addr, target_ws, follow=True)
                    dispatch(f"hl.dsp.focus({{window='address:{addr}'}})")
                    return
