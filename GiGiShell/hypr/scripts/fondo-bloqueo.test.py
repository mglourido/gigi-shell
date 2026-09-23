"""Pruebas de la cola de fondos del bloqueo."""

import importlib.util
import io
import json
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch


RUTA = Path(__file__).with_name("fondo-bloqueo.py")
ESPECIFICACION = importlib.util.spec_from_file_location("fondo_bloqueo", RUTA)
modulo = importlib.util.module_from_spec(ESPECIFICACION)
ESPECIFICACION.loader.exec_module(modulo)


class PruebasColaFondos(unittest.TestCase):
    def test_agota_la_vuelta_sin_repetir_y_evita_repeticion_entre_vueltas(self):
        archivos = ["a.jpg", "b.png", "c.webp"]
        estado = {}
        primera_vuelta = []
        for _ in range(len(archivos)):
            fondo, estado = modulo.elegir_fondo(archivos, estado)
            primera_vuelta.append(fondo)
        self.assertEqual(set(primera_vuelta), set(archivos))

        fondo, estado = modulo.elegir_fondo(archivos, estado)
        self.assertNotEqual(fondo, primera_vuelta[-1])
        segunda_vuelta = [fondo]
        for _ in range(len(archivos) - 1):
            fondo, estado = modulo.elegir_fondo(archivos, estado)
            segunda_vuelta.append(fondo)
        self.assertEqual(set(segunda_vuelta), set(archivos))

    def test_descarta_fondos_eliminados_y_admite_un_solo_fondo(self):
        actual, estado = modulo.elegir_fondo(["a.jpg", "b.png"], {})
        restante = (set(["a.jpg", "b.png"]) - {actual}).pop()
        nuevo, estado = modulo.elegir_fondo([actual], estado)
        self.assertEqual(nuevo, actual)
        self.assertNotIn(restante, estado["pendientes"])

    def test_recargas_simultaneas_comparten_el_mismo_fondo(self):
        with tempfile.TemporaryDirectory() as temporal:
            base = Path(temporal)
            fondos = base / "Wallpapers"
            cache = base / "cache"
            fondos.mkdir()
            for nombre in ("a.jpg", "b.png", "c.webp"):
                (fondos / nombre).touch()
            with patch.multiple(modulo, DIRECTORIO=fondos, CACHE=cache,
                                ESTADO=cache / "hyprlock-fondos.json",
                                ENLACE=cache / "hyprlock-fondo"):
                with patch.object(sys, "argv", [str(RUTA), "iniciar"]), redirect_stdout(io.StringIO()):
                    modulo.main()
                inicial = json.loads(modulo.ESTADO.read_text())["actual"]
                estado = json.loads(modulo.ESTADO.read_text())
                estado["instante"] = -100
                modulo.ESTADO.write_text(json.dumps(estado))
                salida = io.StringIO()
                with patch.object(sys, "argv", [str(RUTA), "siguiente"]), redirect_stdout(salida):
                    modulo.main()
                primero = salida.getvalue()
                self.assertNotEqual(primero.strip(), inicial)
                pendientes = json.loads(modulo.ESTADO.read_text())["pendientes"]
                salida = io.StringIO()
                with patch.object(sys, "argv", [str(RUTA), "siguiente"]), redirect_stdout(salida):
                    modulo.main()
                self.assertEqual(salida.getvalue(), primero)
                self.assertEqual(json.loads(modulo.ESTADO.read_text())["pendientes"], pendientes)

                # Un contador monotónico de un arranque previo puede estar por
                # delante del actual; la recarga debe avanzar igualmente.
                estado = json.loads(modulo.ESTADO.read_text())
                estado["instante"] = 10**12
                modulo.ESTADO.write_text(json.dumps(estado))
                salida = io.StringIO()
                with patch.object(sys, "argv", [str(RUTA), "siguiente"]), redirect_stdout(salida):
                    modulo.main()
                self.assertNotEqual(salida.getvalue(), primero)
                ultimo = salida.getvalue().strip()

                # Un bloqueo nuevo conserva los fondos que quedan en la vuelta.
                salida = io.StringIO()
                with patch.object(sys, "argv", [str(RUTA), "iniciar"]), redirect_stdout(salida):
                    modulo.main()
                self.assertNotEqual(salida.getvalue().strip(), ultimo)


if __name__ == "__main__":
    unittest.main()
