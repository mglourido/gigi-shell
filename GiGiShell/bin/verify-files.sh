#!/usr/bin/env bash
# Comprueba tests y ejecutables disfrazados entre los archivos versionados.
# También optimiza los PNG modificados de Wallpapers antes de permitir un push.
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
GIGISHELL="${GIGISHELL:-$(cd -- "$script_dir/.." && pwd -P)}"

files=("$@")
if ((${#files[@]} == 0)); then
  mapfile -d '' -t files < <(git ls-files -z)
fi

# Ningún test de desarrollo debe acabar rastreado, aunque alguien haya usado
# `git add -f` para saltarse las reglas de .gitignore.
test_regex='(\.test|\.spec)\.(ts|tsx|js|jsx|mts)$|_test\.(py|js)$|^(.*/)?test_[^/]+\.py$'
tests_versionados=()
for archivo in "${files[@]}"; do
  [[ "$archivo" =~ $test_regex ]] && tests_versionados+=("$archivo")
done
if ((${#tests_versionados[@]})); then
  echo "verify-files: hay tests rastreados; los tests no se versionan:" >&2
  printf '  %s\n' "${tests_versionados[@]}" >&2
  echo "Quitalos del índice sin borrarlos del disco:" >&2
  printf '  dotfiles rm --cached -- %q\n' "${tests_versionados[@]}" >&2
  exit 1
fi

# La optimización es sin pérdida. Si cambia un fondo, se detiene el push para
# que el cambio pueda entrar en un commit; los hooks no pueden alterar el commit
# que Git ya está enviando.
shopt -s nullglob
fondos=("$GIGISHELL"/Wallpapers/*.png)
if ((${#fondos[@]})); then
  cache_dir="${XDG_CACHE_HOME:-$HOME/.cache}/gigishell"
  ruta_hash="$(printf '%s' "$GIGISHELL/Wallpapers" | sha256sum)"
  cache_archivo="$cache_dir/wallpapers-${ruta_hash%% *}.sha256"
  declare -A hashes_cache=()
  if [[ -r "$cache_archivo" ]]; then
    while IFS=$'\t' read -r hash nombre; do
      [[ -n "$hash" && -n "$nombre" ]] && hashes_cache["$nombre"]="$hash"
    done < "$cache_archivo"
  fi

  fondos_cambiados=()
  declare -A nombres_actuales=()
  for archivo in "${fondos[@]}"; do
    nombre="${archivo##*/}"
    nombres_actuales["$nombre"]=1
    resultado_hash="$(sha256sum -- "$archivo")"
    hash="${resultado_hash%% *}"
    if [[ "${hashes_cache[$nombre]:-}" != "$hash" ]]; then
      fondos_cambiados+=("$archivo")
    fi
  done

  cache_desactualizada=0
  if ((${#nombres_actuales[@]} != ${#hashes_cache[@]})); then
    cache_desactualizada=1
  fi

  if ((${#fondos_cambiados[@]})); then
    if ! command -v oxipng >/dev/null 2>&1; then
      echo "verify-files: falta oxipng; en Arch/CachyOS instálalo con: sudo pacman -S --needed oxipng" >&2
      exit 1
    fi

    oxipng -o 6 "${fondos_cambiados[@]}"
  fi

  if ((${#fondos_cambiados[@]})) || ((cache_desactualizada)); then
    # Guarda hashes posteriores a la optimización para no repetirla en el push
    # que sigue al commit de los cambios. El renombrado publica el manifiesto
    # completo de una vez y elimina de la caché los fondos que se borraron.
    mkdir -p -- "$cache_dir"
    cache_temporal="$(mktemp "$cache_archivo.XXXXXX")"
    for archivo in "${fondos[@]}"; do
      nombre="${archivo##*/}"
      resultado_hash="$(sha256sum -- "$archivo")"
      printf '%s\t%s\n' "${resultado_hash%% *}" "$nombre" >> "$cache_temporal"
    done
    mv -f -- "$cache_temporal" "$cache_archivo"
  fi

  repo_root="$(git rev-parse --show-toplevel)"
  wallpapers_rel="$(realpath --relative-to="$repo_root" "$GIGISHELL/Wallpapers")"
  if ! git diff --quiet -- "$wallpapers_rel"; then
    echo "verify-files: oxipng optimizó fondos; crea un commit con esos cambios y vuelve a hacer push (la caché evitará repetir la optimización)." >&2
    exit 1
  fi
fi

# Comprueba el tipo real del archivo, no su extensión. Se omiten las rutas que
# no existen en el worktree (por ejemplo, eliminaciones ya preparadas).
denylist_regex='ELF|PE32|Mach-O|MS-DOS executable|Java archive|Microsoft Cabinet|Composite Document File'
sospechosos=()
for archivo in "${files[@]}"; do
  [[ -f "$archivo" ]] || continue
  descripcion="$(file -b -- "$archivo")"
  if [[ "$descripcion" =~ $denylist_regex ]]; then
    sospechosos+=("$archivo: $descripcion")
  fi
done
if ((${#sospechosos[@]})); then
  echo "verify-files: archivos binarios/ejecutables sospechosos:" >&2
  printf '  %s\n' "${sospechosos[@]}" >&2
  exit 1
fi

# Si está disponible, ClamAV bloquea hallazgos, pero un motor sin firmas no
# convierte un problema de instalación en un push imposible.
if command -v clamscan >/dev/null 2>&1; then
  echo "verify-files: escaneando con ClamAV..."
  set +e
  clamscan --infected --no-summary "${files[@]}"
  clam_status=$?
  set -e
  if ((clam_status == 1)); then
    echo "verify-files: ClamAV encontró algo; revisa los archivos antes de continuar." >&2
    exit 1
  elif ((clam_status != 0)); then
    echo "verify-files: ClamAV no pudo escanear (código $clam_status); se omite el escaneo de firmas." >&2
  fi
else
  echo "verify-files: ClamAV (clamscan) no está instalado; se omite el escaneo de firmas." >&2
fi
