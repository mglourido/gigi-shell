# audio/

Los sonidos que reproduce el sistema: las alertas del reloj (alarmas y temporizador) y las
notificaciones que piden sonido.

Se usa **directamente desde aquí** (`~/GiGiShell/audio/…`), sin symlink, igual que `Wallpapers/`:
es contenido del repositorio, no configuración XDG.

## Cómo se usa

Las alarmas y el temporizador no reproducen nada por su cuenta: emiten una notificación normal
con el hint `sound-name` del spec de freedesktop (`alarm-clock-elapsed` y `complete`), y el
subsistema de sonido de notificaciones decide si suena
(`ags/modulos/notificaciones/sonido/`). Al reproducir, un **nombre de tema se busca primero en
esta carpeta** (`<nombre>.oga|.ogg|.wav|.mp3`, en ese orden) y solo si no está se delega en
`canberra-gtk-play` contra el tema de sonidos instalado.

Ese orden es el motivo de que la carpeta exista: sin `sound-theme-freedesktop` instalado, canberra
no encuentra la entrada, **sale con éxito y no suena nada** — la alarma se queda muda sin un solo
error. Con los audios dentro del repo, suenan igual en cualquier máquina.

Un nombre de tema que no valga como nombre de fichero (con `/`, con `..`, con punto inicial) no se
busca aquí: el hint llega por D-Bus desde cualquier proceso de la sesión y acabaría concatenado a
esta ruta (`nombreTemaSeguro` en `sonido/decision.ts`, con test).

## Cambiar un sonido

- **Para todo el sistema**: sustituye el fichero por otro con el mismo nombre. No hay que tocar
  código ni reiniciar el shell — la existencia se comprueba en cada reproducción.
- **Para una alarma concreta**: campo «Sonido» del formulario de alarma, con la ruta
  (`~/GiGiShell/audio/bell.oga`).
- **Para una notificación concreta**: Ajustes > Notificaciones > «Sonido propio» de la regla.

Añadir un fichero nuevo aquí basta para poder referenciarlo; si además lo nombras como una entrada
del tema freedesktop (`dialog-warning.oga`, `device-added.oga`…), pasa a sonar automáticamente en
las notificaciones de las apps que pidan ese `sound-name`.

## Qué hay ahora y de dónde sale

Copiados de `sound-theme-freedesktop` 0.8 (`/usr/share/sounds/freedesktop/stereo/`), que es lo que
ya sonaba en esta máquina:

| Fichero                   | Se usa en                          | Autoría / licencia                                        |
|---------------------------|------------------------------------|-----------------------------------------------------------|
| `alarm-clock-elapsed.oga` | alarmas del reloj (`SONIDO_ALARMA`)| Tim/corsica_s — CC-BY-SA                                   |
| `complete.oga`            | fin del temporizador (`SONIDO_TEMPORIZADOR`) | Dr. Richard Boulanger et al — CC-BY 3.0          |
| `message.oga`             | notificaciones (`sound-name: message`) | Ivica Bukvic — CC-BY-SA                                |
| `bell.oga`                | notificaciones (`sound-name: bell`)| Dr. Richard Boulanger et al — CC-BY 3.0                    |

Créditos completos del tema: `/usr/share/licenses/sound-theme-freedesktop/CREDITS`.

Reproducirlos sigue necesitando un reproductor (`canberra-gtk-play`, `pw-play` o `paplay`);
`libcanberra` está declarado en `install.sh` y en `bin/preflight.sh`.
