# CLAUDE.md — brillo

Parte de la guía de GiGiShell (mapa de zonas en el [`CLAUDE.md` raíz](../CLAUDE.md)).

`brillo/` es el binario Rust `gigishell-brillo up|down`: el **respaldo** de las teclas
`XF86MonBrightness*` cuando AGS no corre. El bind de `hypr/gigishell/keybinds.lua` hace
`pedir-ags.sh brightness-up >/dev/null || ~/.local/bin/gigishell-brillo up`; con AGS vivo no se
ejecuta nunca, así que nada cambia (OSD, gamma, estado). `pedir-ags.sh` y no `ags request … ||`:
un AGS congelado, `unknown request` o `error:` salen con código 0 y el `||` no los vería.

- **Solo mueve el tramo de HARDWARE.** Panel interno con `brightnessctl -c backlight`; monitor
  externo con `ddcutil setvcp 10`. No toca el gamma (`hyprsunset` es de AGS), no enseña OSD y no
  escribe `display.json`. Por eso **no baja del suelo** (`DIM_FLOOR` 0,35 de `atenuacion.ts`):
  por debajo solo trabaja el gamma. Constantes espejo: `DIM_FLOOR` y el salto 0,1 (`puentes.ts`);
  `bin/preflight.sh` las compara con `gigishell-brillo --constantes` y avisa si difieren.
- **No restaura el gamma, a propósito** (decisión del usuario): si AGS cae con el slider por debajo
  del suelo, `hyprsunset` sigue atenuando y subir con la tecla solo mueve el hardware. Se arregla
  al volver AGS o al reiniciar la sesión.
- **Sin AGS no hay desincronía que temer**: al volver, `detectDdc()` (DDC) o el watcher de udev
  (backlight) releen el hardware y el slider se pone al día.
- **Nunca `brightnessctl` sin `-c backlight`**: en un sobremesa cae a un LED (scroll-lock).
- **Caché en `$XDG_RUNTIME_DIR/gigishell-brillo`** (`bus max actual`): detectar el bus cuesta ~1 s
  y leer ~0,3 s. El bus/máximo valen toda la sesión; el valor actual solo 3 s (tecla mantenida) —
  pasado eso se relee, porque AGS u otro pueden haberlo movido. Si el bus guardado ya no contesta
  (monitor o dock cambiado, otro `i2c-N`), se vuelve a detectar en vez de fallar toda la sesión.
- **Una sola instancia** (`gigishell-brillo.lock`, `File::try_lock`): la tecla mantenida repite
  ~25 veces/s y una escritura DDC tarda ~0,3 s. Sin candado los procesos leían el mismo valor y
  escribían el mismo (pasos perdidos) y se peleaban por el bus. La pulsación que llega con otra en
  vuelo se descarta.
- **Límite conocido: con AGS congelado más de 2 s pueden aplicarse dos pasos.** El respaldo actúa y,
  al descongelarse, AGS atiende la petición que ya estaba en su socket (mismo límite que
  documenta `pedir-ags.sh`).
- Instalar: `brillo/instalar.sh` (pasa los tests). Opcional: sin binario y sin AGS, la tecla no hace nada.
