# CLAUDE.md — Hibernación

Parte de la guía de GiGiShell (mapa de zonas en el [`CLAUDE.md` raíz](../../CLAUDE.md)).

Ajustes > Pantalla > Suspensión tiene **un solo** tiempo de hibernación (inactividad total), pero
por dentro hay dos caminos y elegir mal es un fallo mudo. La razón, en una frase: **durante una
suspensión el userspace está congelado**, así que un listener de hypridle posterior a la suspensión
NO SE DISPARA NUNCA. Cuando se puede, quien cuenta es systemd (`suspend-then-hibernate` + alarma
RTC, con `HibernateDelaySec` = total − suspensión, que es una **resta**); el listener `hibernate`
de `hypridle.conf` queda solo para cuando hibernar no llega a pasar por la suspensión.

La autoridad es `~/.config/gigishell/hibernacion.json`; el listener de `hypridle.conf` es su espejo.
Habilitarla en una máquina nueva se prepara desde Ajustes o ejecutando
`sudo bash ~/GiGiShell/system/hibernacion/gigishell-hibernacion-setup.sh`: swapfile
persistente, `resume=` en el kernel, VRAM de NVIDIA) y **no surte efecto hasta reiniciar**. Nada se
asume: `gigishell-hibernacion estado` pregunta a logind y, si dice que no, la fila de Ajustes sale
apagada con el motivo escrito **y un botón «Preparar hibernación…»** que lanza ese paso en una
terminal (con «Quitar hibernación…» a la inversa) — ninguno de los dos por NOPASSWD, a propósito.
**Detalle completo, trampas y por qué de cada pieza en la sección de
hibernación de [`docs/hyprland-modulos.md`](docs/hyprland-modulos.md) — léela antes de tocar
`servicios/energia/hibernacion.ts`, `system/hibernacion/` o el listener `hibernate`.**
