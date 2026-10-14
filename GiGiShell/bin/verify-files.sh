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
  printf '  gigishell rm --cached -- %q\n' "${tests_versionados[@]}" >&2
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

# El push arranca un clamd temporal para poder repartir los archivos entre
# trabajadores sin dejar un daemon residente durante el resto de la sesión.
clamd_pid=""
clamd_dir=""

limpiar_clamd_temporal() {
  if [[ -n "$clamd_pid" ]]; then
    kill "$clamd_pid" 2>/dev/null || true
    wait "$clamd_pid" 2>/dev/null || true
    clamd_pid=""
  fi
  if [[ -n "$clamd_dir" ]]; then
    rm -rf -- "$clamd_dir"
    clamd_dir=""
  fi
}

trap limpiar_clamd_temporal EXIT

escanear_con_clamav() {
  local hilos rc runtime_dir config socket log
  local -a baja_prioridad=()

  # Para lotes pequeños, el coste de arrancar el daemon temporal no compensa.
  if (($# < 300)) && command -v clamscan >/dev/null 2>&1; then
    echo "verify-files: ClamAV usa el modo normal para este lote (<300 archivos)."
    clamscan --infected --no-summary -- "$@"
    return $?
  fi

  # clamdscan solo aporta paralelismo cuando el daemon está vivo. Si falta
  # alguna herramienta, conservamos el escaneo standalone anterior.
  if ! command -v clamd >/dev/null 2>&1 || ! command -v clamdscan >/dev/null 2>&1; then
    clamscan --infected --no-summary -- "$@"
    return $?
  fi

  hilos="$(nproc 2>/dev/null || printf '1')"
  [[ "$hilos" =~ ^[1-9][0-9]*$ ]] || hilos=1
  echo "verify-files: ClamAV usa el daemon temporal multihilo ($hilos hilos)."
  runtime_dir="${XDG_RUNTIME_DIR:-${TMPDIR:-/tmp}}"
  clamd_dir="$(mktemp -d "$runtime_dir/gigishell-clamav.XXXXXX")" || {
    echo "verify-files: no se pudo crear el espacio temporal de ClamAV; usando clamscan." >&2
    clamscan --infected --no-summary -- "$@"
    return $?
  }

  config="$clamd_dir/clamd.conf"
  socket="$clamd_dir/clamd.sock"
  log="$clamd_dir/clamd.log"
  cat > "$config" <<EOF
DatabaseDirectory /var/lib/clamav
LocalSocket $socket
LocalSocketMode 600
Foreground yes
MaxThreads $hilos
EOF

  command -v nice >/dev/null 2>&1 && baja_prioridad+=(nice -n 19)
  command -v ionice >/dev/null 2>&1 && baja_prioridad+=(ionice -c 3)
  "${baja_prioridad[@]}" clamd --foreground --config-file="$config" > "$log" 2>&1 &
  clamd_pid=$!

  # La carga de firmas ocurre al arrancar. Esperamos hasta 3 minutos y
  # verificamos que el daemon siga vivo antes de enviar el lote.
  for ((rc = 0; rc < 180; rc++)); do
    if ! kill -0 "$clamd_pid" 2>/dev/null; then
      break
    fi
    if clamdscan --config-file="$config" --ping=1 >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done

  if ! clamdscan --config-file="$config" --ping=1 >/dev/null 2>&1; then
    echo "verify-files: el clamd temporal no inició; usando clamscan." >&2
    cat "$log" >&2
    limpiar_clamd_temporal
    clamscan --infected --no-summary -- "$@"
    return $?
  fi

  if clamdscan --config-file="$config" --fdpass --multiscan \
      --infected --no-summary -- "$@"; then
    rc=0
  else
    rc=$?
  fi
  limpiar_clamd_temporal

  # Un fallo del daemon no debe convertir el lote en limpio: reintentamos con
  # el motor standalone, igual que antes de habilitar el modo multihilo.
  if ((rc >= 2)); then
    echo "verify-files: falló el clamd temporal; reintentando con clamscan." >&2
    clamscan --infected --no-summary -- "$@"
    return $?
  fi
  return "$rc"
}

# Si está disponible, ClamAV bloquea hallazgos, pero un motor sin firmas no
# convierte un problema de instalación en un push imposible.
if command -v clamscan >/dev/null 2>&1 || {
  command -v clamd >/dev/null 2>&1 && command -v clamdscan >/dev/null 2>&1;
}; then
  existentes=()
  for archivo in "${files[@]}"; do
    [[ -f "$archivo" ]] && existentes+=("$archivo")
  done

  if ((${#existentes[@]})); then
    # La caché solo es válida con la misma versión de ClamAV y firmas. Así,
    # una actualización de la base vuelve a analizar los archivos versionados.
    clam_version="$(clamscan --version 2>/dev/null || true)"
    repo_root="$(git rev-parse --show-toplevel)"
    repo_hash="$(printf '%s' "$repo_root" | sha256sum)"
    cache_dir="${XDG_CACHE_HOME:-$HOME/.cache}/gigishell"
    cache_archivo="$cache_dir/clamav-${repo_hash%% *}.sha256"
    clam_cache_valida=0
    declare -A hashes_analizados=()

    if [[ -n "$clam_version" && -r "$cache_archivo" ]]; then
      IFS= read -r cache_version < "$cache_archivo" || cache_version=""
      if [[ "$cache_version" == "$clam_version" ]]; then
        clam_cache_valida=1
        while IFS= read -r hash; do
          if [[ "$hash" =~ ^[[:xdigit:]]{64}$ ]]; then
            hashes_analizados["$hash"]=1
          else
            # Una caché incompleta o dañada nunca debe omitir un escaneo.
            clam_cache_valida=0
            hashes_analizados=()
            break
          fi
        done < <(tail -n +2 -- "$cache_archivo")
      fi
    fi

    hashes_temporal="$(mktemp)"
    if sha256sum --zero -- "${existentes[@]}" > "$hashes_temporal"; then
      archivos_nuevos=()
      declare -A hashes_actuales=()
      while IFS= read -r -d '' registro; do
        hash="${registro:0:64}"
        archivo="${registro:66}"
        hashes_actuales["$hash"]=1
        if ((!clam_cache_valida)) || [[ -z "${hashes_analizados[$hash]:-}" ]]; then
          archivos_nuevos+=("$archivo")
        fi
      done < "$hashes_temporal"
      rm -f -- "$hashes_temporal"

      if ((${#archivos_nuevos[@]} == 0)); then
        echo "verify-files: ClamAV: todos los archivos versionados ya están revisados."
      else
        echo "verify-files: escaneando con ClamAV (${#archivos_nuevos[@]} archivos nuevos o modificados)..."
        set +e
        escanear_con_clamav "${archivos_nuevos[@]}"
        clam_status=$?
        set -e

        if ((clam_status == 1)); then
          echo "verify-files: ClamAV encontró algo; revisa los archivos antes de continuar." >&2
          exit 1
        elif ((clam_status == 0)); then
          # Publica solo tras un escaneo limpio. El manifiesto contiene los
          # hashes actuales, por lo que también olvida versiones ya borradas.
          if mkdir -p -- "$cache_dir"; then
            if cache_temporal="$(mktemp "$cache_archivo.XXXXXX")"; then
              if {
                printf '%s\n' "$clam_version"
                for hash in "${!hashes_actuales[@]}"; do
                  printf '%s\n' "$hash"
                done
              } > "$cache_temporal" && mv -f -- "$cache_temporal" "$cache_archivo"; then
                :
              else
                rm -f -- "$cache_temporal"
                echo "verify-files: no se pudo guardar la caché de ClamAV; se volverán a revisar en el próximo push." >&2
              fi
            else
              echo "verify-files: no se pudo crear la caché de ClamAV; se volverán a revisar en el próximo push." >&2
            fi
          else
            echo "verify-files: no se pudo preparar la caché de ClamAV; se volverán a revisar en el próximo push." >&2
          fi
        else
          echo "verify-files: ClamAV no pudo escanear (código $clam_status); se omite el escaneo de firmas." >&2
        fi
      fi
    else
      rm -f -- "$hashes_temporal"
      echo "verify-files: no se pudieron calcular hashes; escaneando todos los archivos." >&2
      set +e
      escanear_con_clamav "${existentes[@]}"
      clam_status=$?
      set -e
      if ((clam_status == 1)); then
        echo "verify-files: ClamAV encontró algo; revisa los archivos antes de continuar." >&2
        exit 1
      elif ((clam_status != 0)); then
        echo "verify-files: ClamAV no pudo escanear (código $clam_status); se omite el escaneo de firmas." >&2
      fi
    fi
  fi
else
  echo "verify-files: ClamAV (clamscan) no está instalado; se omite el escaneo de firmas." >&2
fi
