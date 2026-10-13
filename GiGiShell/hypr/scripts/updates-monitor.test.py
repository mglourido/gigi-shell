"""Regresiones del monitor de paquetes, con BD temporal y sin instalar ni usar red."""

import json
import os
import select
import shutil
import subprocess
import tempfile
import time
import unittest
from pathlib import Path


RUTA = Path(__file__).with_name("updates-monitor.sh")
LIBRERIA_JUEGO = RUTA.parent / "lib" / "gaming-gate.sh"
CODIGO = RUTA.read_text().split("# ¿El nombre de paquete", 1)[1]
CODIGO = "# ¿El nombre de paquete" + CODIGO.split("# ── Bucle principal", 1)[0]
INICIO = """
mgr=arch
has_nvidia=true
has_amd=false
update_cmd='sudo pacman -Syu'
declare -A watch_set=()
source "$1"
OUT="$2/updates.json"
db_path="$2/bd"
have_inotify=true
periodic=false
"""


@unittest.skipUnless(shutil.which("inotifywait") and shutil.which("jq"), "requiere inotifywait y jq")
class PruebasMonitorActualizaciones(unittest.TestCase):
    def setUp(self):
        self.temporal = tempfile.TemporaryDirectory(prefix="gigishell-actualizaciones-")
        self.addCleanup(self.temporal.cleanup)
        self.base = Path(self.temporal.name)
        self.bd = self.base / "bd"
        self.bd.mkdir()
        self.funciones = self.base / "funciones.sh"
        self.funciones.write_text(CODIGO)
        self.bin = self.base / "bin"
        self.bin.mkdir()
        self.entorno = dict(os.environ, PATH=f"{self.bin}:{os.environ['PATH']}")
        self.entorno["REGISTRO_GESTOR"] = str(self.base / "llamadas")
        self.entorno["PENDIENTES_PRUEBA"] = str(self.base / "pendientes")
        self.entorno["CHECKUPDATES_DB"] = str(self.base / "cache")
        self.entorno["GAMING_STATE_FILE"] = str(self.base / "estado-juego.json")
        self.entorno["GAMING_PREFS_FILE"] = str(self.base / "preferencias-juego.json")
        self.entorno["LIBRERIA_JUEGO"] = str(LIBRERIA_JUEGO.resolve())
        self.entorno["GAMING_GATE_POLL"] = "1"
        self.entorno["GAMING_GATE_RESUME_DELAY"] = "0"
        (self.base / "preferencias-juego.json").write_text('{"gamingFreeze":true}')
        (self.base / "cache" / "sync").mkdir(parents=True)
        (self.base / "pendientes").write_text("")

    def ejecutar(self, programa, *, asincrono=False):
        argumentos = ["bash", "-c", INICIO + programa, "prueba", str(self.funciones), str(self.base)]
        if not asincrono:
            return subprocess.run(argumentos, env=self.entorno, text=True, capture_output=True,
                                  check=True, timeout=15)
        proceso = subprocess.Popen(argumentos, env=self.entorno, text=True,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.addCleanup(self.detener, proceso)
        return proceso

    @staticmethod
    def detener(proceso):
        if proceso.poll() is None:
            proceso.terminate()
        proceso.communicate(timeout=3)

    def leer_linea(self, proceso, plazo=10):
        self.assertTrue(select.select([proceso.stdout], [], [], plazo)[0], "no llegó la respuesta")
        linea = proceso.stdout.readline().strip()
        self.assertTrue(linea, "el monitor terminó antes de responder")
        return linea

    def simular_gestor(self, nombre="checkupdates"):
        ruta = self.bin / nombre
        ruta.write_text("""#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$REGISTRO_GESTOR"
cat "$PENDIENTES_PRUEBA"
exit "${CODIGO_GESTOR:-0}"
""")
        ruta.chmod(0o755)

    def guardar_estado_juego(self, **cambios):
        estado = {"gaming": True, "gameFocused": True, "lastGameFocus": int(time.time()),
                  "powerSaveFreeze": False, "pid": os.getpid()}
        estado.update(cambios)
        temporal = self.base / "estado-juego.tmp"
        temporal.write_text(json.dumps(estado))
        temporal.replace(self.base / "estado-juego.json")

    def test_la_comprobacion_programada_se_aplaza_hasta_dejar_de_jugar(self):
        self.simular_gestor()
        self.guardar_estado_juego()
        proceso = self.ejecutar("""
GAMING_GATE_SLEEP=esperar_mantenimiento
source "$LIBRERIA_JUEGO"
have_inotify=false
printf 'listo\\n'
comprobar_pendientes red
printf 'comprobado\\n'
""", asincrono=True)
        self.assertEqual(self.leer_linea(proceso), "listo")
        time.sleep(0.2)
        self.assertFalse((self.base / "llamadas").exists())
        self.assertIsNone(proceso.poll())
        self.guardar_estado_juego(gaming=False, gameFocused=False)
        self.assertEqual(self.leer_linea(proceso), "comprobado")
        self.assertEqual((self.base / "llamadas").read_text().splitlines(), [""])

    def test_jugar_no_impide_retirar_los_avisos_locales(self):
        self.simular_gestor()
        self.guardar_estado_juego()
        self.ejecutar('source "$LIBRERIA_JUEGO"\ncomprobar_pendientes local')
        self.assertEqual((self.base / "llamadas").read_text().strip(), "--nosync")

    def test_un_juego_aparcado_fuera_de_la_gracia_no_aplaza_la_comprobacion(self):
        self.simular_gestor()
        self.guardar_estado_juego(gameFocused=False, lastGameFocus=int(time.time()) - 3600)
        self.ejecutar('source "$LIBRERIA_JUEGO"\ncomprobar_pendientes red')
        self.assertEqual((self.base / "llamadas").read_text().splitlines(), [""])

    def test_estado_ausente_invalido_o_de_un_shell_muerto_no_bloquea(self):
        self.simular_gestor()
        estados = [None, '{"gaming":true}', '{json inválido',
                   json.dumps({"gaming": True, "gameFocused": True, "pid": 2147483647})]
        for estado in estados:
            with self.subTest(estado=estado):
                if estado is not None:
                    (self.base / "estado-juego.json").write_text(estado)
                self.ejecutar('source "$LIBRERIA_JUEGO"\ncomprobar_pendientes red')
        self.assertEqual(len((self.base / "llamadas").read_text().splitlines()), len(estados))

    def test_un_solo_jq_conserva_versiones_clasificacion_y_muestra_de_veinte(self):
        self.simular_gestor()
        jq_real = shutil.which("jq")
        ruta = self.bin / "jq"
        ruta.write_text(f'#!/usr/bin/env bash\nprintf x >> "$REGISTRO_JQ"\nexec "{jq_real}" "$@"\n')
        ruta.chmod(0o755)
        self.entorno["REGISTRO_JQ"] = str(self.base / "jq-llamadas")
        (self.base / "pendientes").write_text(
            'linux 1:1.0-1 -> 1:2.0-1\nnvidia-utils 1 -> 2\nvigilado 1 -> 2\n'
            + ''.join(f'paquete-{i} 1 -> 2\n' for i in range(50)))
        self.ejecutar('watch_set[vigilado]=1\nrun_check red')
        datos = json.loads((self.base / "updates.json").read_text())
        self.assertEqual(datos["kernel"], [{"name": "linux", "from": "1:1.0-1", "to": "1:2.0-1"}])
        self.assertEqual(datos["gpu"], [{"name": "nvidia-utils", "from": "1", "to": "2"}])
        self.assertEqual(datos["watched"], [{"name": "vigilado", "from": "1", "to": "2"}])
        self.assertEqual(datos["system"], 50)
        self.assertEqual(datos["systemSample"], [f"paquete-{i}" for i in range(20)])
        self.assertIsInstance(datos["checkedAt"], int)
        self.assertEqual((self.base / "jq-llamadas").read_text(), "x")

    def test_conserva_el_evento_que_llega_durante_una_comprobacion(self):
        self.simular_gestor()
        (self.base / "pendientes").write_text("linux 1 -> 2\n")
        # El FIFO solo sincroniza la prueba: el monitor usa su pipe anónimo habitual.
        os.mkfifo(self.base / "continuar")
        proceso = self.ejecutar("""
iniciar_vigilancia
run_check red
printf 'comprobando\\n'
IFS= read -r continuar < "$2/continuar"
wait_next
run_check "$modo_comprobacion"
printf '%s\\n' "$modo_comprobacion"
""", asincrono=True)
        self.assertEqual(self.leer_linea(proceso), "comprobando")
        (self.base / "pendientes").write_text("")
        bloqueo = self.bd / "db.lck"
        bloqueo.touch()
        bloqueo.unlink()
        with (self.base / "continuar").open("w") as salida:
            salida.write("seguir\n")
        self.assertEqual(self.leer_linea(proceso), "local")
        self.assertEqual(proceso.wait(timeout=2), 0)
        self.assertEqual(json.loads((self.base / "updates.json").read_text())["kernel"], [])

    def test_no_confunde_cinco_segundos_de_calma_con_fin_de_transaccion(self):
        bloqueo = self.bd / "db.lck"
        bloqueo.touch()
        proceso = self.ejecutar("""
iniciar_vigilancia
printf 'listo\\n'
wait_next
printf '%s\\n' "$modo_comprobacion"
""", asincrono=True)
        self.assertEqual(self.leer_linea(proceso), "listo")
        (self.bd / "local").mkdir()
        time.sleep(5.2)
        self.assertIsNone(proceso.poll())
        self.assertFalse(select.select([proceso.stdout], [], [], 0)[0])
        bloqueo.unlink()
        self.assertEqual(self.leer_linea(proceso), "local")

    def test_espera_otra_transaccion_iniciada_durante_la_calma(self):
        proceso = self.ejecutar("""
iniciar_vigilancia
printf 'listo\\n'
wait_next
printf '%s\\n' "$modo_comprobacion"
""", asincrono=True)
        self.assertEqual(self.leer_linea(proceso), "listo")
        bloqueo = self.bd / "db.lck"
        bloqueo.touch()
        bloqueo.unlink()
        bloqueo.touch()
        time.sleep(5.2)
        self.assertIsNone(proceso.poll())
        self.assertFalse(select.select([proceso.stdout], [], [], 0)[0])
        bloqueo.unlink()
        self.assertEqual(self.leer_linea(proceso), "local")

    def test_sigterm_cierra_tambien_el_vigilante(self):
        proceso = self.ejecutar("""
iniciar_vigilancia
printf '%s\\n' "$vigilante_pid"
wait_next
printf 'no debe refrescar\\n'
""", asincrono=True)
        vigilante = int(self.leer_linea(proceso))
        proceso.terminate()
        salida, errores = proceso.communicate(timeout=2)
        self.assertEqual(salida, "")
        self.assertEqual(errores, "")
        with self.assertRaises(ProcessLookupError):
            os.kill(vigilante, 0)

    def test_la_espera_por_ahorro_refresca_avisos_sin_consumir_la_consulta_de_red(self):
        self.simular_gestor()
        proceso = self.ejecutar("""
iniciar_vigilancia
printf 'listo\\n'
esperar_mantenimiento 20
printf '%s\\n' "$modo_comprobacion"
""", asincrono=True)
        self.assertEqual(self.leer_linea(proceso), "listo")
        bloqueo = self.bd / "db.lck"
        bloqueo.touch()
        bloqueo.unlink()
        self.assertEqual(self.leer_linea(proceso), "red")
        self.assertEqual((self.base / "llamadas").read_text().strip(), "--nosync")
        self.assertEqual(json.loads((self.base / "updates.json").read_text())["kernel"], [])

    def test_sin_vigilante_y_sin_periodicas_sale_sin_bucle(self):
        ruta = self.bin / "inotifywait"
        ruta.write_text("#!/usr/bin/env bash\nexit 1\n")
        ruta.chmod(0o755)
        resultado = self.ejecutar("""
iniciar_vigilancia
wait_next
printf '%s:%s\\n' "$have_inotify" "$?"
""")
        self.assertEqual(resultado.stdout.strip(), "false:1")

    def test_refresco_local_retira_solo_los_paquetes_ya_instalados_sin_red(self):
        self.simular_gestor()
        (self.base / "pendientes").write_text("linux 1 -> 2\nnvidia-utils 1 -> 2\nmesa 1 -> 2\n")
        self.ejecutar("run_check red")
        datos = json.loads((self.base / "updates.json").read_text())
        self.assertEqual([p["name"] for p in datos["kernel"]], ["linux"])
        self.assertEqual([p["name"] for p in datos["gpu"]], ["nvidia-utils"])
        (self.base / "pendientes").write_text("mesa 1 -> 2\n")
        self.ejecutar("run_check local")
        datos = json.loads((self.base / "updates.json").read_text())
        self.assertEqual(datos["kernel"], [])
        self.assertEqual(datos["gpu"], [])
        self.assertEqual(datos["system"], 1)
        self.assertEqual(datos["systemSample"], ["mesa"])
        self.assertEqual((self.base / "llamadas").read_text().splitlines(), ["", "--nosync"])

    def test_un_error_no_borra_el_ultimo_estado_y_codigo_dos_si_lo_limpia(self):
        self.simular_gestor()
        salida = self.base / "updates.json"
        salida.write_text('{"kernel":[{"name":"linux"}]}')
        self.entorno["CODIGO_GESTOR"] = "1"
        self.ejecutar("run_check red || :")
        self.assertEqual(salida.read_text(), '{"kernel":[{"name":"linux"}]}')
        self.entorno["CODIGO_GESTOR"] = "2"
        self.ejecutar("run_check local")
        datos = json.loads(salida.read_text())
        self.assertEqual(datos["kernel"], [])
        self.assertEqual(datos["system"], 0)

    def test_sin_cache_temporal_consulta_la_bd_del_sistema(self):
        self.simular_gestor()
        self.simular_gestor("pacman")
        (self.base / "cache" / "sync").rmdir()
        (self.base / "pendientes").write_text("linux 1 -> 2\n")
        self.ejecutar("run_check local")
        datos = json.loads((self.base / "updates.json").read_text())
        self.assertEqual(datos["kernel"][0]["name"], "linux")
        self.assertEqual((self.base / "llamadas").read_text().strip(), "-Qu")

    def test_fedora_usa_cache_local_y_acepta_codigo_cien(self):
        self.simular_gestor("dnf")
        self.entorno["CODIGO_GESTOR"] = "100"
        (self.base / "pendientes").write_text("kernel.x86_64 2 fedora\n")
        self.ejecutar("mgr=fedora; run_check local")
        datos = json.loads((self.base / "updates.json").read_text())
        self.assertEqual(datos["kernel"][0]["name"], "kernel")
        self.assertEqual((self.base / "llamadas").read_text().strip(), "-q --cacheonly check-update")


if __name__ == "__main__":
    unittest.main()
