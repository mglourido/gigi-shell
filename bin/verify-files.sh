#!/usr/bin/env bash
# Verifica que los archivos trackeados no sean binarios/ejecutables disfrazados
# de algo inocuo (comprueba el tipo real por magic bytes, no por la extensión,
# que es lo que el .gitignore no puede ver) y, si hay ClamAV instalado, los
# pasa por un escaneo de firmas.
#
# Uso:
#   bin/verify-files.sh              revisa todos los archivos trackeados
#   bin/verify-files.sh f1 f2 ...    revisa solo esos archivos
#
# Lo invoca automáticamente .githooks/pre-push en cada `git push`.
set -euo pipefail

files=("$@")
if [ "${#files[@]}" -eq 0 ]; then
  mapfile -t files < <(git ls-files)
fi

# Los tests son de DESARROLLO MOMENTÁNEO: no se versionan ni viajan al
# instalador. `GiGiShell/.gitignore` ya los excluye, pero un `git add -f` (o un
# fichero que quedó rastreado de antes de existir la regla, que es lo que pasó
# con fondoShell.test.ts y monitores.test.ts) se salta el ignore sin avisar. El
# push es el último punto donde se puede parar, así que se para aquí.
#
# Por qué importa y no es sólo higiene: `bin/preflight.sh` llegó a exigir nueve
# `*.test.ts` en su lista `required`. En la máquina de desarrollo existen y
# pasaba; en un checkout limpio no existen NUNCA, así que el instalador
# terminaba con nueve errores y "la instalación NO está completa" en cada
# máquina nueva. Un test rastreado es la mitad de esa trampa.
test_regex='(\.test|\.spec)\.(ts|tsx|js|jsx|mts)$|_test\.(py|js)$|^(.*/)?test_[^/]+\.py$'
tests_versionados=()
for f in "${files[@]}"; do
  # Sin excepciones: NINGÚN test se versiona, tampoco el del motor de fondos.
  [[ "$f" =~ $test_regex ]] && tests_versionados+=("$f")
done
if [ "${#tests_versionados[@]}" -gt 0 ]; then
  echo "verify-files: hay tests rastreados; los tests no se versionan:" >&2
  printf '  %s\n' "${tests_versionados[@]}" >&2
  echo "Quitalos del índice sin borrarlos del disco:" >&2
  printf '  dotfiles rm --cached %s\n' "${tests_versionados[*]}" >&2
  exit 1
fi

# Formatos de ejecutable/binario que no tienen nada que hacer en un repo de
# dotfiles, sea cual sea la extensión del archivo.
denylist_regex='ELF|PE32|Mach-O|MS-DOS executable|Java archive|Microsoft Cabinet|Composite Document File'
suspicious=()

for f in "${files[@]}"; do
  [ -f "$f" ] || continue
  desc="$(file -b "$f")"
  if [[ "$desc" =~ $denylist_regex ]]; then
    suspicious+=("$f: $desc")
  fi
done

if [ "${#suspicious[@]}" -gt 0 ]; then
  echo "verify-files: archivos binarios/ejecutables sospechosos:" >&2
  printf '  %s\n' "${suspicious[@]}" >&2
  echo "Si es intencional: git add -f <archivo>" >&2
  exit 1
fi

if command -v clamscan >/dev/null 2>&1; then
  echo "verify-files: escaneando con ClamAV..."
  set +e
  clamscan --infected --no-summary "${files[@]}"
  clam_status=$?
  set -e
  # clamscan: 0 = limpio, 1 = infectado (bloquea de verdad), 2+ = error de
  # ejecución (p.ej. faltan firmas porque no se corrió `freshclam`) — eso no es
  # un hallazgo de seguridad, es una instalación a medio configurar, así que se
  # avisa y se deja pasar en vez de bloquear el push.
  if [ "$clam_status" -eq 1 ]; then
    echo "verify-files: ClamAV encontró algo, revisa antes de continuar." >&2
    exit 1
  elif [ "$clam_status" -ne 0 ]; then
    echo "verify-files: ClamAV no pudo escanear (código $clam_status) — ¿corriste 'sudo freshclam'? Se omite el escaneo de firmas." >&2
  fi
else
  echo "verify-files: ClamAV (clamscan) no está instalado, se omite el escaneo de firmas." >&2
fi

exit 0
