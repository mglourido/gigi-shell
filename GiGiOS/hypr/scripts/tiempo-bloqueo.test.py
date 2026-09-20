"""La tarjeta del tiempo solo aparece con ubicación permitida y válida."""

import importlib.util
import unittest
from pathlib import Path


RUTA = Path(__file__).with_name("tiempo-bloqueo.py")
ESPECIFICACION = importlib.util.spec_from_file_location("tiempo_bloqueo", RUTA)
modulo = importlib.util.module_from_spec(ESPECIFICACION)
ESPECIFICACION.loader.exec_module(modulo)


class PruebasPermisoTiempo(unittest.TestCase):
    def test_permiso_y_coordenadas_requeridos(self):
        coordenadas = {"latitude": 40.42, "longitude": -3.70}
        self.assertIsNone(modulo.ubicacion_permitida({"locationAllowed": False, "location": coordenadas}))
        self.assertIsNone(modulo.ubicacion_permitida({"locationAllowed": True, "location": {}}))
        self.assertIsNone(modulo.ubicacion_permitida({
            "locationAllowed": True, "location": {"latitude": 100, "longitude": -3.70},
        }))
        self.assertEqual(modulo.ubicacion_permitida({"locationAllowed": True, "location": coordenadas}),
                         (40.42, -3.70))


if __name__ == "__main__":
    unittest.main()
