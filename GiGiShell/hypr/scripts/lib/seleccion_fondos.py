"""
seleccion_fondos.py — el motor que decide QUÉ fondo toca ahora mismo.

Módulo PURO: no lee ficheros, no mira el reloj y no llama a nadie. Todo entra
por parámetros (la config ya parseada, la hora en minutos del día, el conjunto de
rutas que existen en disco y el generador aleatorio). Quien hace la E/S es
`wallpaper-select.py`, que es su único usuario junto con las pruebas.

POR QUÉ ESTO NO VIVE NI EN BASH NI EN AGS
-----------------------------------------
Hay DOS disparadores para la misma decisión: el arranque de la sesión
(`wallpaper.sh` desde `gigios/autostart.lua`, en t=0, cuando AGS todavía no
existe) y el cambio de franja horaria (AGS, con el escritorio ya vivo). Si cada
uno eligiera por su cuenta acabarían discrepando en silencio — el escritorio
mostraría un fondo que el planificador cree que es otro — así que la elección
tiene un solo dueño y los dos lo invocan.

EL MODELO: DOS SISTEMAS DE FRANJAS, CADA UNO CON SU DOMINIO
-----------------------------------------------------------
No son dos formas de lo mismo, y mezclarlos fue la primera tentación:

  * Las FRANJAS GLOBALES (día/tarde/noche, N libres) gobiernan los fondos
    SUELTOS. Cada fondo declara en qué franjas es apto; sin declaración es apto
    siempre, así que estrenar la función no cambia el comportamiento de nadie.
    Existen para lo que motivó todo esto: que no salga un fondo claro de noche.

  * La LÍNEA DE 24 H propia de cada GRUPO gobierna sus variantes, y es
    independiente de las globales. Un grupo puede mudar a las 5:00 aunque la
    franja "día" empiece a las 7:00. Cada tramo lleva una LISTA de fondos, no
    uno: si hay varios se sortea entre ellos.

Un grupo es UNA sola entidad de cara al sorteo (es la definición de grupo: para
el sistema es un fondo, no N). Sus imágenes por tanto NO compiten además como
fondos sueltos; si lo hicieran, meter cuatro variantes en un grupo cuadruplicaría
sus posibilidades de salir frente a un fondo suelto.

UN TRAMO CON `paths` VACÍO ES LA FORMA DE DECIR "AQUÍ ESTE GRUPO NO SALE".
Es lo que implementa "un grupo sin imagen apta para la franja actual queda fuera
de la selección" sin necesitar una segunda marca de aptitud encima de la línea de
tiempo. Un grupo cuyas imágenes hayan desaparecido del disco queda fuera por la
misma vía.

AMBAS LISTAS SON CÍCLICAS: se define solo dónde EMPIEZA cada franja/tramo, y cada
una llega hasta el comienzo de la siguiente, envolviendo la medianoche. O sea que
la vigente es la del último `start` <= ahora, y antes del primer `start` del día
manda la ÚLTIMA de la lista (la que viene de ayer). Ese caso —00:30 con la
primera franja a las 07:00— es el que se olvida al escribir esto a mano.

FAIL-OPEN: si tras aplicar los filtros no queda ni un candidato (todos los fondos
marcados como no aptos de noche, por ejemplo), se ignoran los filtros y se sortea
entre todo lo que haya. Un escritorio con el fondo "equivocado" es infinitamente
mejor que un escritorio en negro, y el usuario ve el síntoma y puede arreglarlo.
"""

from __future__ import annotations

import random
from typing import Any, Iterable, Sequence

MINUTOS_DIA = 24 * 60


# ── Horas ─────────────────────────────────────────────────────────────────────

def a_minutos(hhmm: Any) -> int | None:
    """"HH:MM" -> minutos del día. Devuelve None ante cualquier cosa rara."""
    if not isinstance(hhmm, str):
        return None
    partes = hhmm.strip().split(":")
    if len(partes) != 2:
        return None
    try:
        h, m = int(partes[0]), int(partes[1])
    except ValueError:
        return None
    if not (0 <= h <= 23 and 0 <= m <= 59):
        return None
    return h * 60 + m


def _vigente(entradas: Sequence[tuple[int, Any]], ahora: int) -> Any | None:
    """
    De una lista cíclica de (inicio, valor), la vigente a `ahora`.

    Antes del primer inicio del día manda la última entrada: es la que viene de
    ayer. Sin esa vuelta, a las 00:30 con la primera franja a las 07:00 no
    regiría ninguna.
    """
    if not entradas:
        return None
    ordenadas = sorted(entradas, key=lambda e: e[0])
    elegida = ordenadas[-1][1]          # la de ayer, salvo que alguna la pise
    for inicio, valor in ordenadas:
        if inicio <= ahora:
            elegida = valor
        else:
            break
    return elegida


# ── Lectura defensiva de la config ────────────────────────────────────────────
# El JSON lo escribe Orion, pero también puede editarlo el usuario a mano o venir
# de otra máquina. Nada de lo que sigue debe lanzar ante una clave ausente o de
# tipo inesperado: la peor consecuencia aceptable es "esa entrada se ignora".

def _lista(cfg: Any, clave: str) -> list:
    valor = cfg.get(clave) if isinstance(cfg, dict) else None
    return valor if isinstance(valor, list) else []


def _dict(cfg: Any, clave: str) -> dict:
    valor = cfg.get(clave) if isinstance(cfg, dict) else None
    return valor if isinstance(valor, dict) else {}


def franjas_globales(cfg: dict) -> list[tuple[int, str]]:
    """[(minuto de inicio, id)] de las franjas globales bien formadas."""
    salida: list[tuple[int, str]] = []
    for franja in _lista(cfg, "franjas"):
        if not isinstance(franja, dict):
            continue
        inicio = a_minutos(franja.get("start"))
        fid = franja.get("id")
        if inicio is not None and isinstance(fid, str) and fid:
            salida.append((inicio, fid))
    return salida


def franja_actual(cfg: dict, ahora: int) -> str | None:
    """Id de la franja global vigente, o None si no hay franjas definidas."""
    return _vigente(franjas_globales(cfg), ahora)


def rutas_de_grupos(cfg: dict) -> set[str]:
    """Toda ruta que pertenece a algún grupo — no compite como fondo suelto."""
    dentro: set[str] = set()
    for grupo in _lista(cfg, "grupos"):
        for tramo in _lista(grupo, "tramos"):
            for ruta in _lista(tramo, "paths"):
                if isinstance(ruta, str):
                    dentro.add(ruta)
    return dentro


def es_apto(cfg: dict, ruta: str, ahora: int) -> bool:
    """
    ¿Es apto este fondo SUELTO a esta hora?

    Sin franjas globales definidas, o sin declaración para este fondo, o con la
    lista vacía: apto siempre. El default permisivo es deliberado — así estrenar
    la función (o añadir un fondo nuevo a la carpeta) no lo deja invisible sin
    que nadie lo haya pedido.
    """
    actual = franja_actual(cfg, ahora)
    if actual is None:
        return True
    entrada = _dict(cfg, "fondos").get(ruta)
    if not isinstance(entrada, dict):
        return True
    permitidas = entrada.get("franjas")
    if not isinstance(permitidas, list) or not permitidas:
        return True
    return actual in permitidas


def tramo_actual(grupo: dict, ahora: int, disponibles: Iterable[str]) -> list[str]:
    """
    Rutas que este grupo ofrece a esta hora (ya filtradas a las que existen).

    Lista vacía = el grupo no sale ahora, que es tanto el tramo declarado sin
    imágenes como el tramo cuyas imágenes ya no están en el disco.
    """
    existentes = set(disponibles)
    entradas: list[tuple[int, list[str]]] = []
    for tramo in _lista(grupo, "tramos"):
        if not isinstance(tramo, dict):
            continue
        inicio = a_minutos(tramo.get("start"))
        if inicio is None:
            continue
        rutas = [r for r in _lista(tramo, "paths")
                 if isinstance(r, str) and r in existentes]
        entradas.append((inicio, rutas))
    return _vigente(entradas, ahora) or []


def grupo_por_id(cfg: dict, gid: str) -> dict | None:
    for grupo in _lista(cfg, "grupos"):
        if isinstance(grupo, dict) and grupo.get("id") == gid:
            return grupo
    return None


# ── Candidatos y sorteo ───────────────────────────────────────────────────────

Eleccion = tuple[str | None, str]   # (id de grupo o None, ruta)


def candidatos(cfg: dict, ahora: int, disponibles: Iterable[str]) -> list[tuple[str | None, list[str]]]:
    """
    Entidades elegibles ahora: [(id de grupo o None, rutas entre las que sortear)].

    Cada grupo aporta UNA entrada, con las rutas de su tramo vigente. Cada fondo
    suelto apto aporta la suya, con una sola ruta.
    """
    existentes = set(disponibles)
    agrupadas = rutas_de_grupos(cfg)
    salida: list[tuple[str | None, list[str]]] = []

    for grupo in _lista(cfg, "grupos"):
        if not isinstance(grupo, dict):
            continue
        gid = grupo.get("id")
        if not isinstance(gid, str) or not gid:
            continue
        rutas = tramo_actual(grupo, ahora, existentes)
        if rutas:
            salida.append((gid, rutas))

    for ruta in sorted(existentes - agrupadas):
        if es_apto(cfg, ruta, ahora):
            salida.append((None, [ruta]))

    return salida


def elegir(
    cfg: dict,
    ahora: int,
    disponibles: Iterable[str],
    rng: random.Random | None = None,
    evitar: Eleccion | None = None,
) -> Eleccion | None:
    """
    Sortea una entidad elegible y, dentro de ella, una de sus rutas.

    `evitar` es la elección actual: se descarta si hay alternativa, porque pulsar
    "aleatorio" y que salga el mismo fondo se lee como que el botón no funciona.
    Con un solo candidato se devuelve ese, claro.

    Ante cero candidatos se ignoran TODOS los filtros y se sortea entre lo que
    haya (ver el fail-open de la cabecera). Solo devuelve None si no hay ni un
    fichero disponible, que es el único caso en el que no hay nada que aplicar.
    """
    rng = rng or random.Random()
    opciones = candidatos(cfg, ahora, disponibles)

    if not opciones:
        restantes = sorted(set(disponibles))
        if not restantes:
            return None
        opciones = [(None, [r]) for r in restantes]

    if evitar is not None and len(opciones) > 1:
        # La identidad de una entidad es su id de grupo; la de un fondo suelto,
        # su ruta (no tiene id).
        if evitar[0] is not None:
            filtradas = [o for o in opciones if o[0] != evitar[0]]
        else:
            filtradas = [o for o in opciones
                         if not (o[0] is None and o[1] == [evitar[1]])]
        if filtradas:
            opciones = filtradas

    gid, rutas = rng.choice(opciones)
    return gid, rng.choice(rutas)


def resolver_grupo(
    grupo: dict,
    ahora: int,
    disponibles: Iterable[str],
    rng: random.Random | None = None,
    preferir: str | None = None,
) -> str | None:
    """
    Qué variante de este grupo toca ahora, o None si el grupo no sale a esta hora.

    `preferir` conserva la variante que ya está puesta si sigue estando en el
    tramo vigente. Es lo que evita que el fondo se re-sortee en cada
    reevaluación cuando un tramo tiene varias imágenes: el planificador puede
    despertar más veces de las previstas (una suspensión larga, un arranque
    dentro del tramo) y sin esto el escritorio cambiaría de imagen sin que haya
    cruzado ningún límite.
    """
    rutas = tramo_actual(grupo, ahora, disponibles)
    if not rutas:
        return None
    if preferir in rutas:
        return preferir
    return (rng or random.Random()).choice(rutas)


def decidir(
    cfg: dict,
    estado: dict,
    ahora: int,
    disponibles: Iterable[str],
    rng: random.Random | None = None,
) -> Eleccion | None:
    """
    Qué debe verse AHORA partiendo de lo que ya está puesto (`--auto`).

    Las dos mitades del contrato que pidió el usuario:
      * un GRUPO conserva su identidad y solo muda de variante;
      * un fondo SUELTO que deja de ser apto se sustituye por otro al azar, y si
        sigue siendo apto no se toca.

    Un grupo que se queda sin tramo vigente (o que ya no existe en la config)
    cede el turno al sorteo normal, como cualquier fondo que deja de ser apto.
    """
    existentes = set(disponibles)
    actual = estado.get("current") if isinstance(estado, dict) else None
    gid = estado.get("currentGroup") if isinstance(estado, dict) else None
    actual = actual if isinstance(actual, str) else None
    gid = gid if isinstance(gid, str) and gid else None

    if gid:
        grupo = grupo_por_id(cfg, gid)
        if grupo is not None:
            ruta = resolver_grupo(grupo, ahora, existentes, rng, preferir=actual)
            if ruta is not None:
                return gid, ruta
        return elegir(cfg, ahora, existentes, rng, evitar=(gid, actual or ""))

    if actual and actual in existentes and es_apto(cfg, actual, ahora):
        return None, actual

    return elegir(cfg, ahora, existentes, rng,
                  evitar=(None, actual) if actual else None)


# ── Próximo límite ────────────────────────────────────────────────────────────

def limites(cfg: dict) -> list[int]:
    """Todos los instantes del día en que la decisión puede cambiar."""
    marcas = {inicio for inicio, _ in franjas_globales(cfg)}
    for grupo in _lista(cfg, "grupos"):
        for tramo in _lista(grupo, "tramos"):
            if isinstance(tramo, dict):
                inicio = a_minutos(tramo.get("start"))
                if inicio is not None:
                    marcas.add(inicio)
    return sorted(marcas)


def limites_relevantes(cfg: dict, estado: dict) -> list[int]:
    """
    Solo los límites que pueden cambiar lo que se ve AHORA, que es bastante menos
    que `limites()` y es lo que permite dormir de verdad hasta el siguiente.

    Con un GRUPO puesto mandan **solo los tramos de ESE grupo**: sus variantes no
    miran las franjas globales, así que un cambio de "día" a "tarde" no puede
    alterar nada mientras él esté en pantalla. Y los tramos de los DEMÁS grupos
    tampoco pintan nada: no hay ninguna decisión que dependa de ellos hasta que
    alguno salga elegido, y eso solo puede ocurrir en un límite de los que sí se
    vigilan.

    Con un fondo SUELTO puesto mandan solo las franjas globales, que son las que
    deciden si sigue siendo apto.

    Un grupo sin tramos utilizables cae al caso general: es un estado incoherente
    (`decidir` lo habría sustituido), y ahí es mejor vigilar de más que quedarse
    sin ningún despertador.
    """
    gid = estado.get("currentGroup") if isinstance(estado, dict) else None
    if isinstance(gid, str) and gid:
        grupo = grupo_por_id(cfg, gid)
        if grupo is not None:
            marcas = set()
            for tramo in _lista(grupo, "tramos"):
                if isinstance(tramo, dict):
                    inicio = a_minutos(tramo.get("start"))
                    if inicio is not None:
                        marcas.add(inicio)
            if marcas:
                return sorted(marcas)
        return limites(cfg)
    return sorted({inicio for inicio, _ in franjas_globales(cfg)})


def proximo_cambio(cfg: dict, ahora: int, estado: dict | None = None) -> int | None:
    """
    Minutos que faltan hasta el próximo límite (siempre > 0), o None si no hay
    ninguno — sin límites no hay nada que reprogramar y quien llama no debe armar
    ningún temporizador.

    Se devuelve un DELTA y no una hora del día a propósito: quien lo consume
    (`AGS`) tiene que armar un temporizador contra el reloj de pared, y darle una
    hora absoluta le obligaría a repetir aquí la aritmética de la medianoche.

    Sin `estado` se miran TODOS los límites. Es el modo conservador y solo debería
    usarlo quien no sepa qué hay puesto.
    """
    marcas = limites(cfg) if estado is None else limites_relevantes(cfg, estado)
    if not marcas:
        return None
    for marca in marcas:
        if marca > ahora:
            return marca - ahora
    return MINUTOS_DIA - ahora + marcas[0]
