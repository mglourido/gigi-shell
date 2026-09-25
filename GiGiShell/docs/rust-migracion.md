# Migración de scripts a Rust — plan y estado

Parte de la auditoría del 2026-09-06 (`~/Documentos/gigios-migracion-rust-scripts.md`). Su
conclusión sigue en pie: **ningún script tiene un problema de CPU que Rust resuelva** (los
monitores en reposo cuestan ~0 %). Lo que Rust sí mejora es el **número de procesos** y la
**mantenibilidad de `oom-monitor.sh`**: 1529 líneas de bash concurrente, 6 sub-monitores con
subshells, traps y una red para recoger huérfanos que hizo falta porque los `journalctl -f`
sobrevivían al script.

Regla: un `.sh` que cuesta ~0 y funciona se queda en shell. Los one-shot, los botones y los
wrappers de CLIs (`udisksctl`, `pacman`, `clamscan`, `rofi`) no se migran nunca: shell es el
lenguaje correcto para orquestar programas.

## Diseño: un solo daemon, `gigishell-eventd`

- Crate en `eventd/` (raíz de GiGiShell, sin symlink: no es config). Binario en
  `~/.local/bin/gigishell-eventd`, instalado con `eventd/instalar.sh` o con el paso del
  instalador `bash install.sh --solo eventd`. El paso **no instala Rust por su cuenta** (~500 MB
  de cadena para un binario de 500 KB): sin `cargo` avisa y el monitor sigue en bash.
- `bin/preflight.sh --installed` avisa si el binario falta y, sobre todo, si es **más viejo que
  `eventd/src`**: el script le cede todo, así que un binario sin recompilar tras cambiar una regla
  seguiría aplicando la vieja sin ningún síntoma.
- **Sin tokio: un hilo por fuente.** Journal en el principal (`sd_journal_wait`), inotify en otro
  (`poll(2)` con el plazo de su ventana de agrupación), unidades y SMART en otros dos (`sleep`
  entre pasadas). Los sondeos llaman a programas que pueden tardar segundos (`smartctl` despierta
  discos) y en un solo bucle retrasarían los avisos del journal. Cuatro hilos quietos no cuestan
  nada; tokio compensaría con decenas de fuentes, no con cuatro.
- **`--modulos`**: el binario declara qué sub-monitores cubre y `oom-monitor.sh` corre en bash el
  resto. Así cada fase se despliega sin coordinar versiones del script y del binario.
- **Dependencias mínimas**: `libc` y `serde_json`. sd-journal por FFI directa (ocho funciones,
  `build.rs` enlaza `libsystemd`).
- **Contrato intacto**: los mismos ids `x-gigishell-event`, `notify-send` con los mismos hints,
  las mismas claves de `security.json`. **No depende de AGS**: la vigilancia de seguridad tiene
  que sobrevivir a un crash del shell.
- **Lo lanza `oom-monitor.sh`**, que conserva las funciones bash como respaldo y, con el binario
  completo, le cede el proceso con `exec`. Retirar el binario devuelve al comportamiento
  anterior sin tocar nada más. El script no se borra: autostart lo sigue llamando, sirve en una
  máquina sin Rust y es la referencia de los porqués de cada regla.
- **Una sola instancia, y la nueva gana** (`flock` en `$XDG_RUNTIME_DIR/gigishell-eventd.pid`):
  relanzar es volver a ejecutar el script.

## Fases

| fase | qué | estado |
|---|---|---|
| 1 | `monitor_kernel` + `monitor_system` → `gigishell-eventd` (journal) | **hecho** (2026-09-25) |
| 2 | comparar en paralelo unos días (`GIGISHELL_EVENTD=0` + `gigishell-eventd --simular`) | pendiente |
| 3 | `monitor_files` (inotify nativo), `monitor_units`, `monitor_smart` | **hecho** (2026-09-25) |
| 4 | `monitor_downloads` (orquestación de ClamAV; el escaneo sigue siendo `clamscan`); `oom-monitor.sh` queda como lanzador + respaldo | **hecho** (2026-09-25) |
| 5 | opcional: `usb-monitor`, `camara-monitor`, `bt-monitor`, `wifi-monitor` como módulos del mismo daemon | solo si el mantenimiento lo pide |

Aparte y **sin Rust**: `screencast-monitor.sh` y `updates-monitor.sh` pueden pasar a servicios
Astal dentro de AGS (ya corre, ya pinta esos datos en la barra). Es la forma más barata de quitar
procesos. `battery-monitor.sh` NO: un aviso de batería baja tiene que sobrevivir a AGS.

No se tocan: ClamAV (el coste son los ~200 MB de firmas que recarga libclamav, igual desde Rust),
`gestos.py` (MediaPipe no tiene ecosistema Rust razonable), y todos los scripts on-demand.

## Fase 1: medido

- Procesos: `journalctl -kf` + `journalctl -f` + los subshells de `monitor_kernel` y
  `monitor_system` y el de su tubería → **1** proceso.
- Memoria: ~0,3 MB anónima. El RSS (~20 MB) es casi todo `Pss_File`: páginas de los ficheros
  del journal mapeadas por sd-journal, caché compartida y reclamable.
- Tamaño del binario: 454 KB (release, LTO, `opt-level = "s"`, strip); 485 KB tras la fase 3.
- CPU en reposo: 0 (bloqueado en `sd_journal_wait` sin plazo cuando no hay nada encolado).

Mejoras que llegan de paso: relectura en caliente de `security.json`, ventana de agrupación por
categoría, `sshd-session` vigilado, y sin huérfanos (`PR_SET_PDEATHSIG`). Detalle en la sección
del security monitor de [`hyprland-modulos.md`](hyprland-modulos.md).

## Fase 3: medido

- `oom-monitor.sh` pasa de ~9 bash + 2 `journalctl` + 1 `inotifywait` a: el bash principal, el
  de `monitor_downloads` y `gigishell-eventd` (4 hilos, ~0,4 MB anónimos).
- Probado en vivo con `--simular`: un `.desktop` creado y reescrito en `~/.config/autostart`
  da UN aviso de persistencia (create + close_write deduplicados) y su `.pacnew` ninguno; la
  primera pasada de unidades cae en t+25 s y no avisa (siembra); SMART en t+45 s.
- `monitor_units` sigue sondeando `systemctl --failed` en vez de escuchar D-Bus: cuesta dos forks
  cada dos minutos y es estado de nivel (lo que cae durante un juego se avisa al reanudar), que
  con señales de D-Bus habría que reconstruir a mano.

## Fase 4: medido

- `oom-monitor.sh` completo = **1 proceso** (5 hilos, ~0,4 MB anónimos), frente a ~12 bash +
  2 `journalctl` + 2 `inotifywait` de la auditoría. Ningún bash residente.
- Probado de extremo a extremo con un HOME de prueba y `--simular`: la primera pasada analiza lo
  existente y detecta EICAR en una subcarpeta (aviso de malware, sin avisos de ejecutables
  porque aún siembra); un `.sh` ejecutable creado después en esa subcarpeta despierta el
  barrido por inotify y da el aviso de ejecutable nuevo. Índice y hashes idénticos a lo que
  escribía el bash (`xxh64sum` da los mismos valores).
- Relanzar el script sustituye a la instancia vieja (comprobado: cambia el pid y queda una).

## Pendiente

- Los botones de los avisos («Lanzar aislado», «Escanear igualmente», «Actualizar firmas») no
  se han pulsado en vivo: en modo simulado solo se imprimen. El camino es el mismo `notify-send
  --wait -A` que usaba el bash.
- Fase 5 (opcional): `usb-monitor`, `camara-monitor`, `bt-monitor`, `wifi-monitor`.
- Las reglas de kernel se han probado con líneas sintéticas (`--stdin` y `cargo test`); las de
  sistema, además, en vivo con `logger -t sudo …`. Un evento real de kernel (OOM, E/S) solo se
  verá cuando ocurra; la fase 2 existe para eso.
