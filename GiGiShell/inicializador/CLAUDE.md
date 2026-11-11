# CLAUDE.md — inicializador

Parte de la guía de GiGiShell (mapa de zonas en el [`CLAUDE.md` raíz](../CLAUDE.md)).

`inicializador/init.sh` reads `~/.config/gigishell/{display,system_state}.json` and applies
brightness (`brightnessctl`), wifi (`nmcli`), bluetooth (`bluetoothctl`), and volume/mute
(`wpctl`), falling back to hardcoded defaults when a key is absent. It's the counterpart to the AGS
UI that *writes* those JSON files.

**La luz nocturna NO la restaura `init.sh`, a propósito.** Antes lanzaba `hyprsunset` con el
`nightLightActive` guardado al cerrar sesión, y eso chocaba con el horario de AGS, que al entrar
reaplica el último disparo: con «desde 08:00 → Apagar», AGS ponía la luz apagada (Quick Settings
la mostraba así) y `init.sh` la encendía igual. Que pasara o no dependía de una carrera: AGS guarda
`display.json` con un debounce de 2 s, y si `init.sh` lo leía antes, se quedaba con el `true`
viejo. El único dueño de `hyprsunset` es `ags/servicios/pantalla/service.ts`; ver su `CLAUDE.md`.

El brillo **no se restaura en un sobremesa** y no hace falta que se restaure: `apply_brightness` sale
si `/sys/class/backlight` está vacío (solo el panel interno de un portátil publica esa clase), porque
allí el brillo lo guarda el **propio monitor** en su firmware y AGS se lo lee por DDC/CI al arrancar.
Cuando sí aplica, la llamada fija `-c backlight`: sin dispositivos de esa clase `brightnessctl` **no
falla** — cae al primer dispositivo `leds` y encendía el **LED de scroll-lock del teclado** en cada
login. Ver la sección de brillo en [`docs/hyprland-modulos.md`](docs/hyprland-modulos.md).

El volumen espera antes (`wait_for_sink`, techo 10 s): init.sh sale de un `exec-once` de Hyprland
y puede ganarle la carrera al arranque de PipeWire/WirePlumber en la sesión de usuario. Hasta que
WirePlumber no publica un sink por defecto, `@DEFAULT_AUDIO_SINK@` no resuelve y los `wpctl`
fallan **en silencio** — el volumen/mute guardado simplemente no se aplicaba en los arranques que
perdían la carrera.
