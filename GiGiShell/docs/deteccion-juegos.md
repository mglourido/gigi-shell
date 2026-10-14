# Detección de juegos y consultas del estado

El detector vive en `ags/servicios/juegos/`, no en los scripts ni en `eventd`:

- `registro.ts` mantiene las ventanas reconocidas y el juego con foco mediante
  señales de Hyprland, sin sondeo periódico. Comparte la detección entre barra,
  Orion, No molestar, Spotify y luz nocturna.
- `evidencia.ts` recoge categorías de `.desktop`, ejecutable y comando de `/proc`.
  La caché de procesos está limitada a 128 entradas y comprueba su fecha de inicio
  para no confundir PID reciclados.
- `deteccion.ts` aplica la heurística: descarta menús X11, lanzadores, aplicaciones
  conocidas e instaladores; reconoce Steam/Wine/Proton/Gamescope, rutas y categorías
  de juegos y, como último recurso, pantalla completa real. Esto último puede
  reconocer una aplicación desconocida como juego: es una heurística.

Al apagar `escanerJuegos`, se desconectan señales por ventana, se cancelan reintentos,
se descarta la evidencia de procesos y se publica lista vacía y foco `null`. El bus
de eventos de ventanas sigue activo para las apps manuales de No molestar.

## Trabajo mientras no hay juegos

El registro escucha `client-added` y `client-removed` de AstalHyprland. Al abrir una
ventana evalúa solo esa ventana; al cerrarla elimina sus señales y evidencia y la
retira del registro. Al iniciar se siembran las ventanas ya existentes una sola vez.
No hay un barrido periódico, consultas periódicas a `hyprctl` ni búsquedas de juegos
en la lista de procesos. Solo hay un reintento de 600 ms si una ventana nace sin clase.

Se mantienen `notify::title`, `notify::class` y `notify::fullscreen` por ventana:
algunos juegos publican sus datos tarde, y el título puede revelar un instalador.
Los cambios de foco y escritorio consultan el mapa de juegos ya reconocidos; no
recogen evidencia ni vuelven a clasificar ventanas. También notifican al bus usado
por No molestar y la pausa manual de luz nocturna, que tienen lógica independiente.

La evidencia se obtiene de forma diferida: menús X11, lanzadores, apps excluidas y
títulos de instalador se descartan antes de leer `/proc` o consultar el índice
`.desktop`. Esto evita E/S al cambiar títulos de Firefox, terminales o Steam. Los
candidatos restantes conservan las mismas reglas y la guarda de PID reciclados;
una clase fuerte de Proton sigue consultando el comando para descartar instaladores.
No se añaden cachés ni temporizadores. En reposo sin eventos no se ejecuta el detector.

## Registros en memoria y limpieza

El escáner no guarda historial de ventanas ni archivos por aplicación. Mantiene dos
mapas de estado vivo:

| Registro | Contenido y motivo |
| --- | --- |
| `registrosClientes` | Una entrada por ventana abierta: referencia al cliente de Astal, IDs numéricos de señales y, si existe, ID del reintento. Permite desconectar y cancelar todo al cerrar o apagar el escáner. |
| `juegos` | Solo ventanas reconocidas como juegos. Permite consultar pertenencia sin repetir la detección y conservar el reconocimiento al abandonar fullscreen. |

La gestión de clientes, conexiones y reintentos antes estaba repartida entre tres
mapas. Ahora comparte una entrada por ventana; las conexiones guardan solo sus IDs,
sin crear un objeto con otra referencia al cliente por cada señal. No son copias de
las ventanas: Astal ya posee esos objetos y el escáner conserva referencias.

`clientesJuego` es la lista reactiva que necesitan los widgets y contiene referencias
a esos mismos juegos. Mantener el mapa y esa lista evita buscar entre todas las
ventanas cada vez que cambia el foco o se actualiza la presentación de un juego.
Sustituirlos por un único booleano perdería los datos de ventanas que usan barra,
Orion, Rofi y la identificación de aplicaciones de audio.

Al cerrar una ventana se desconectan sus señales, se cancela el reintento y se elimina
la entrada y su evidencia de proceso. Al apagar el escáner se vacían los juegos y se
liberan señales y reintentos; se conservan las referencias de ventanas abiertas para
reactivarlo con el mismo orden. Con el escáner apagado no se crean arrays de conexiones.
El tamaño del registro depende de las ventanas abiertas, no del número de ventanas
que se hayan abierto durante toda la sesión.

La caché de evidencia conserva como máximo 128 procesos; evita releer ejecutable y
comando de candidatos y comprueba la encarnación del PID. El índice `.desktop` es
compartido por otros módulos del shell y se construye de forma diferida. El único
JSON que publica este sistema contiene el estado actual agregado, no un historial.

## Dentro de AGS

Consumir el registro reactivo evita leer disco o repetir la detección:

```ts
import { hayJuegosAbiertos, clienteJuegoEnFoco } from "./servicios/juegos/registro"

const hayJuego = hayJuegosAbiertos.get()
const tieneFoco = clienteJuegoEnFoco.get() !== null
const cancelar = hayJuegosAbiertos.subscribe(() => actualizar())
```

`clientesJuego` está disponible cuando se necesita la lista completa;
`esClienteRegistradoComoJuego(cliente)` permite consultar una ventana concreta.
Las suscripciones de widgets deben liberarse al destruirlos. Importar estos valores
no inicia el escáner: se conserva el arranque aplazado desde `app.ts`.
`isGaming` sigue disponible como alias de `hayJuegosAbiertos` en `gamingState.ts`.

## Scripts Bash

Sourcear la librería una vez y usar sus predicados evita procesos por consulta:

```bash
source "$HOME/.config/hypr/scripts/lib/gaming-gate.sh"
if hay_juegos_abiertos; then
    # Hay una ventana de juego, incluso sin foco.
    :
fi
```

| Función | Qué significa |
| --- | --- |
| `hay_juegos_abiertos` | Existe al menos una ventana reconocida como juego. |
| `juego_en_foco` | Hay un juego y tiene el foco ahora. |
| `gaming_active` | Hay un juego con foco o dentro de la gracia de cinco minutos. |
| `escaner_juegos_activo` | AGS está vivo y tiene la detección activada. |
| `gaming_gate_wait` | Espera según `gamingFreeze`, foco/gracia y ahorro; después deja ejecutar el trabajo. |

Los predicados devuelven salida **0 = sí, 1 = no**, sin imprimir. Consultar no espera
ni aplica `gamingFreeze`: ese ajuste solo gobierna la puerta de mantenimiento.
El ahorro tiene su propio ajuste y también lo respeta la puerta.

## Consulta desde cualquier programa

```bash
bash ~/.config/hypr/scripts/estado-juegos.sh abiertos
bash ~/.config/hypr/scripts/estado-juegos.sh foco
bash ~/.config/hypr/scripts/estado-juegos.sh reciente
bash ~/.config/hypr/scripts/estado-juegos.sh escaner
```

Imprime `true` o `false` y devuelve 0 o 1 respectivamente. Sin argumento consulta
`abiertos`; un argumento incorrecto devuelve 2. Para consultas repetidas en Bash,
usar las funciones evita iniciar otro Bash cada vez.

## Publicación, consumidores y fallos

`ags/servicios/energia/gamingState.ts` es el único escritor de
`${XDG_CONFIG_HOME:-$HOME/.config}/gigishell/runtime-state.json`:

| Clave | Valor |
| --- | --- |
| `gaming` | Hay juegos abiertos. |
| `gameFocused` | Un juego tiene el foco. |
| `lastGameFocus` | Epoch en segundos de la última transición del foco del juego. |
| `gameScanner` | Preferencia `escanerJuegos`. |
| `powerSaveFreeze` | Ahorro activo y reducción de procesos solicitada. |
| `pid` | Proceso AGS que publicó el estado. |

Solo publica cuando cambia el contenido y siempre al iniciar AGS. No añadir otro
escritor: sobrescribiría las claves del ahorro. Al cerrar el último juego se publica
también `gameFocused:false`, aunque el registro notifique la retirada del foco después.

`eventd/src/sistema.rs` comparte la lectura y la guarda del PID entre su puerta y
`hay_juegos_abiertos()`. Descargas en Rust y en el respaldo Bash usan **juego abierto**;
SMART, unidades y actualizaciones usan **foco con gracia**. No cambiar una consulta
por la otra: dejar un juego aparcado permite mantenimiento después de cinco minutos,
pero sigue pausando el escaneo automático de descargas si su ajuste está activado.

El lector Bash permite sobrescribir `GAMING_STATE_FILE` y `GAMING_PREFS_FILE` y ajustar
`GAMING_FOCUS_GRACE`. Rust conserva la gracia de 300 segundos. Ambos respetan
`XDG_CONFIG_HOME` para el estado y las preferencias de la puerta.

Sin estado legible, sin PID o con AGS muerto, las consultas responden «no». Se corrigió
la lectura directa de `gaming` en descargas porque dejaba el escáner pausado
indefinidamente si AGS moría durante una partida. La guarda comprueba la existencia
del PID; no identifica su encarnación, así que un PID reciclado aún puede validar un
archivo antiguo hasta el siguiente arranque de AGS. La lectura Bash usa expresiones
regulares sobre el JSON plano producido por AGS, no un parser JSON general.

No se trasladó el detector a `eventd`: duplicaría las señales y la evidencia que AGS
necesita para sus widgets. Tampoco se añadieron archivos de estado, demonios ni
temporizadores. Los consumidores de mantenimiento conservan su espera existente.

## Comprobaciones

```bash
python3 hypr/scripts/updates-monitor.test.py
cd eventd
cargo test --offline
```

Tras desplegar estos cambios, reiniciar AGS publica el puente actualizado; recompilar
con `eventd/instalar.sh` y relanzar `oom-monitor.sh` activa el cambio en el daemon.
