# Suspensión falsa

> **Estado: IMPLEMENTADO (las 8 fases).** Este documento sigue siendo el porqué largo: qué se
> reutiliza, qué es nuevo, qué se descartó y qué falla en silencio si se hace de otra forma. El
> mapa de ficheros está al final, en «Dónde vive cada cosa». Pendiente de probar en vivo la lista
> de «Cómo probar cada pieza», y de resumirlo en [`hyprland-modulos.md`](hyprland-modulos.md).

## El problema

La suspensión real (S3) **rompe cosas**. Una descarga a medias muere por timeout, una compilación
larga se congela con el reloj de pared corriendo, una sesión SSH se cae, un backup a medio subir
se queda a medias, y el dongle Bluetooth se reenumera al volver (ver la sección de BT en
`ags/CLAUDE.md`). Pero al dejar el equipo desatendido lo que se quiere es justo lo que la
suspensión da: pantalla apagada, ventiladores callados, batería que no se evapora.

La **suspensión falsa** es el punto medio: se apaga todo lo que se puede apagar **sin detener el
kernel**. La red sigue viva, los procesos siguen corriendo, el reloj no da un salto — y aun así el
escritorio queda tan quieto y tan barato como se pueda.

## Qué NO es

- **No reemplaza a la suspensión real, y no se acerca a su consumo.** Un S3 baja a ~0,3 W; esto
  deja la CPU en idle con la red viva, que en este portátil son varios vatios. Si no hay nada que
  proteger, la suspensión de verdad sigue siendo la respuesta correcta.
  - Cuánto es «varios vatios» ya no es una estimación: medido con RAPL en el sobremesa Intel
    (`/sys/class/powercap/intel-rapl:0/energy_uj`, ventanas de 12 s, escritorio en reposo), el
    paquete de CPU está entre **17 y 22 W** con el perfil `performance` y baja a **~10 W** con
    `power-saver`. De ahí el efector de perfil de energía; ver «El perfil de energía del
    sistema».
- **No es un "modo ahorro más agresivo"** aunque comparta casi toda la maquinaria. El modo ahorro
  reacciona a la batería y el usuario sigue delante; la suspensión falsa la pide el usuario
  explícitamente y **asume que se va**.
- **No congela nada por su cuenta.** La lista de apps a congelar nace vacía y la escribe el
  usuario, por el motivo del apartado «Congelar apps».

## Lo que ya existe y se reutiliza tal cual

La mayor parte de esta función **ya está escrita**: es un orquestador, no un subsistema. Antes de
añadir mecanismo nuevo, comprobar que no esté aquí.

| Necesidad | Pieza existente |
|---|---|
| Apagar la pantalla | `hypr/scripts/idle-action.sh dpms-off` (la TABLA `{action='off'}`, nunca el string) |
| Vetar la suspensión **real** de hypridle | contrato de `wakeup.json` + `blocked()` en `idle-action.sh` |
| Congelar el sondeo de fondo (updates, smartctl, unidades, clamscan) | `powerSaveFreeze` en `runtime-state.json` → `hypr/scripts/lib/gaming-gate.sh` |
| Apagar cava, preview de escritorios (grim), mascota, píldora de Spotify | `spectrumSuspended`, `wsPreviewSuspended`, `mascotaSuspended`, `spotifyBarSuspended` (`servicios/energia/powerState.ts`) |
| Opacar paneles y ventanas (mata blur y transparencias) | `transparenciaSuspendida`, `opacidadVentanasForzada` |
| Cambiar el perfil TLP | `servicios/energia/tlp.ts` → `/usr/local/bin/gigishell-tlp-apply` (root helper, sudoers fijo) |
| Bloquear la sesión — no cerrarla: solo pedir contraseña al volver, para que nadie de fuera entre | la guarda de instancia única, que hyprlock NO tiene: hoy `hayHyprlock()` (recorrido de `/proc`, sin forks) `\|\|` lanzarlo |
| Silenciar popups sin perder notificaciones | `notifd.dontDisturb` con la disciplina `autoOwned` de `modulos/notificaciones/autoDnd/watcher.ts` |
| Silenciar el **sonido** de notificaciones y alarmas | `decidirSonido()` en `modulos/notificaciones/sonido/decision.ts` — es el único punto por el que suena algo en todo el shell (ver «Alarmas y No molestar») |
| Parar los procesos de fondo de GiGiShell que no hacen falta mientras nadie mira | el sondeo caro lo congela el mismo `gaming-gate.sh` de la fila 3; los timers de los widgets **no se paran solos** al desmapear la ventana y hay que soltar `refrescar` a mano (ver «El lever más grande») |
| Punto de entrada scriptable (menú de energía, atajos, cron) | `requestHandler` de `ags/app.ts` → `ags request toggle-suspension-falsa`, como `toggle-bar` o `toggle-power-menu` |

### El lever más grande, y es gratis

Con **DPMS apagado el compositor deja de emitir frame callbacks** a ese output, y todo cliente
Wayland bien educado (Firefox, Discord, el propio AGS/GTK4) **deja de pintar solo**. No hay que
"parar el renderizado de AGS" a mano para conseguir el grueso del ahorro: lo consigue el `dpms
off` que ya está escrito.

Ocultar las ventanas de AGS (`visible={false}`) sigue mereciendo la pena, pero por otra razón: es
el ahorro de timers y de wakeups de CPU, no de GPU. **No lo vendas como lo que apaga el
renderizado.**

⚠️ **Y desmapear la ventana NO para los sondeos por sí solo.** Esto se dio por sentado y era
falso: GTK deja de dibujar la superficie, pero los `GLib.timeout_add` de los widgets siguen
corriendo porque cuelgan del proceso, no de la ventana. En esta barra quien los gobierna es
`refrescar` de `estado/visibilidadBarra.ts` —el lever que ya usaban `Recursos`, `Batería`, `Red`,
`Volumen` y el `Reloj` para soltar y readquirir sus fuentes— y hasta ahora **solo lo movían el
hover y el auto-ocultado**. Con la barra fija (`barAutoHide` en `false`, que es el caso de este
equipo) se quedaba en `true` toda la suspensión falsa y `Recursos.tsx` seguía leyendo
`/proc/stat` y `/proc/meminfo` **cada 4 s con la pantalla apagada**.

Arreglado en `Barra.tsx` metiendo la suspensión falsa **como primera rama de
`checkVisibility()`**, que es la única ruta que decide la visibilidad local de una salida.
Primera y no última a propósito: cualquier rama de más abajo puede llamar a
`showNow()`/`handleShow()` y volver a encender `refrescar` —basta con que algo mueva
`anyPanelVisible`— y el ahorro se perdería sin un solo síntoma, que con la pantalla apagada es
exactamente cuando nadie lo notaría. Al salir NO se fuerza `true`: se vuelve a pasar por
`checkVisibility()`, o la barra acabaría sondeando retraída.

Corolario para el diseño: **apagar la pantalla es lo PRIMERO de la secuencia de entrada**, no lo
último. Todo lo que venga después ya se ejecuta con el sistema medio dormido.

## Secuencia de entrada

En este orden, y el orden importa:

1. **Marcar el estado** (`suspensionFalsaActiva` en RAM + fichero de estado en disco, ver abajo).
   Primero, para que nadie corra un tick de mantenimiento durante los pasos siguientes.
2. **DPMS off** vía `idle-action.sh dpms-off`.
3. **Bloquear** (opcional, por defecto **sí**): `hayHyprlock() || hyprlock`. Es además la puerta
   de salida — ver «Cómo se sale».
4. **DND** encendido con la marca `autoOwned`, para no pisar una elección manual del usuario.
5. **Suspensiones del shell**: los flags de `powerState.ts` ya existentes se activan por OR con el
   estado de suspensión falsa (cava, preview, mascota, Spotify, opacidad, sondeo de fondo).
6. **Ocultar las ventanas de AGS.**
7. **Retroiluminación de teclado y LEDs a 0** (ver «Qué más se apaga»).
8. **Perfil TLP** al que diga el ajuste, si es distinto de «no tocar» (ver «Ajustes»).
9. **Perfil de energía del sistema** (`power-profiles-daemon`), igual: solo si el ajuste pide
   uno. Es el paso que más consumo quita y el único de energía de CPU que existe en un
   sobremesa, donde TLP no está — ver «El perfil de energía del sistema».
10. **Congelar las apps del allowlist**, si hay alguna. Lo último porque es lo único
    potencialmente destructivo.

**El brillo NO se toca**, y no por olvido: se implementó, se probó y se retiró. Ver «El brillo: lo
que se intentó y por qué se retiró».

## Secuencia de salida

Exactamente la inversa, y con una regla: **restaurar solo lo que impusimos nosotros.** Es la misma
disciplina que ya aplican `brilloAhorro.ts` (compara contra `ultimoAplicado`) y el watcher de
auto-DND (`autoOwned` / `userOptedOut`). Si el usuario tocó el DND o el perfil TLP durante la
suspensión falsa, **manda lo suyo y no se restaura nada de eso**.

El deshielo de las apps congeladas va **primero**, no último: una app congelada que recibe eventos
de entrada antes de descongelarse llega al escritorio con una cola de basura.

Y al final, **reiniciar hypridle** (`servicios/pantalla/reinicioHypridle.ts`): hypridle no repite
un `on-timeout` ya disparado, así que sin eso los contadores se quedan vencidos. Es exactamente lo
que ya hace el Wake up al apagarse.

## Contrato del estado en disco

El lado bash (`idle-action.sh`, `gaming-gate.sh`) necesita saber si hay una suspensión falsa
puesta. Contrato, calcado del de `wakeup.json`:

```json
{ "active": true, "until": 1756480000, "pid": 4231, "thenSuspend": false }
```

- `until`: epoch **absoluto** en segundos, o `null` sin límite. Absoluto y no un contador, por lo
  mismo que en `wakeup.json` y `lastGameFocus`: el lado bash lo resuelve contra el reloj de pared
  sin que nadie tenga que reescribir el fichero.
- `pid`: el de AGS. **Es una guarda, no información.** Sin ella, un AGS caído con la suspensión
  falsa puesta dejaría el mantenimiento congelado y la suspensión real vetada **para siempre, en
  silencio y sin UI donde apagarlo**. Mismo patrón y mismo motivo que `wakeup.json` y
  `runtime-state.json`.
- `thenSuspend`: qué hacer al vencer `until` (ver «Salir a suspensión real»).

Los **ajustes** no viajan aquí. Este fichero es estado vivo con guarda de pid; los ajustes son
persistencia de usuario y van con los demás (ver «Ajustes»).

### Dónde vive: cuidado con el fichero compartido

`runtime-state.json` lo reescribe **entero** `servicios/energia/gamingState.ts` en cada cambio.
**Dos escritores sobre el mismo JSON se pisan** (esto ya está documentado allí como el motivo de
que `powerSaveFreeze` viaje en ese fichero y no en uno propio). Así que hay dos opciones válidas y
una mala:

- ✅ Extender el escritor de `gamingState.ts` con las claves nuevas.
- ✅ Fichero propio, `~/.config/gigishell/suspension-falsa.json`, con su propio escritor único.
- ❌ Escribir en `runtime-state.json` desde un segundo módulo.

**Decidido: fichero propio.** El ciclo de vida no tiene nada que ver con el de las partidas y el
contrato con bash es el de `wakeup.json`, no el del gate. La única clave que sí se cuela en
`runtime-state.json` es la que ya existe: `powerSaveFreeze`, que pasa a calcularse
`backgroundJobsSuspended || suspensionFalsaActiva` — porque el gate ya está escrito para tener
varios motivos y ese es su tercero.

### ⚠️ NO reusar `forcePowerSave`

La tentación evidente es encender `forcePowerSave` y dejar que todo el modo ahorro se dispare
solo. **No.** `forcePowerSave` es un ajuste **persistido** en `~/.config/power-save/config.json`:
si AGS muere durante la suspensión falsa, el usuario se queda en ahorro forzado permanente, con el
brillo bajo y los paneles opacos, sin ninguna pista de por qué.

Lo correcto es un estado **en RAM** que se OR-ea con `powerSaveActive` en los computeds que ya
existen — igual que `backgroundJobsSuspended` combina hoy dos motivos. Un crash devuelve el
escritorio a su sitio, que es el modo de fallo que se quiere.

El residuo físico es la excepción: **el perfil TLP sí sobrevive al proceso** (escribe
`/etc/tlp.conf`), así que su efector apunta lo que impuso y solo restaura eso. El brillo sería el
otro caso —por DDC se graba en la firmware del monitor— pero esta función ya no lo toca; el
mecanismo de apunte y restauración diferida sigue existiendo en `brilloAhorro.ts` para el modo
ahorro, y es el que hay que reutilizar si alguna vez hace falta, no inventar otro.

## El veto de la suspensión real

Sin esto la función **no sirve para nada**: a los 20 min el listener de `hypridle.conf` dispara
`idle-action.sh suspend` y el equipo se suspende de verdad, con las descargas que se quería
proteger.

`blocked()` en `idle-action.sh` tiene que consultar también el estado de la suspensión falsa,
conservando literalmente sus dos reglas actuales:

- **REGLA DE ORO — fail-open.** Sin fichero, sin `jq`, con JSON corrupto, con `until` vencido o con
  el pid muerto → **se ejecuta la acción**. Un fallo aquí debe degradar a "la suspensión falsa no
  funciona" (visible y arreglable), nunca a "el PC no se suspende jamás" (silencioso, permanente y
  se come la batería).
- **La caducidad se resuelve contra `now`**, no fiándose de que alguien reescriba el fichero.

Alcance: veta `suspend`. **No veta `dpms-off` ni `lock`** — ya estamos apagados y bloqueados, y
dejarlos pasar no hace daño. `dpms-on` no se veta nunca, como hoy.

Implementación: dos ficheros, una función. `blocked()` pasa a consultar `wakeup.json` **y**
`suspension-falsa.json` con la misma rutina (leer → `jq` con `now` → guarda de pid) y veta si
cualquiera de los dos está vivo. No duplicar el bloque: sacarlo a un helper que reciba la ruta y el
alcance, porque si no la regla de fail-open acaba escrita dos veces y divergiendo.

## Wake up y suspensión falsa: cómo conviven

Son la misma familia (las dos vetan la suspensión real) y hay que tratarlas como un sistema, no
como dos interruptores sueltos. Tres reglas:

1. **Entrada manual**: la función de la barra (y `ags request toggle-suspension-falsa`, y el atajo)
   entra **al instante**, sin esperar a ninguna inactividad. Es lo que se pide al pulsarla: me voy.
2. **Entrada delegada desde Wake up**: opción nueva dentro del Wake up, *«al vencer la inactividad,
   entrar en suspensión falsa»*. Con ella el Wake up deja de limitarse a vetar: cuando hypridle
   quiere suspender, en vez de tragarse la acción y no hacer nada, se **entra en suspensión falsa**.
   El equipo queda apagado de cara al usuario y el Wake up sigue cumpliendo su promesa (nada se
   detiene). Mecánicamente: `idle-action.sh suspend` sigue vetando el `systemctl suspend`, y AGS —
   que es quien conoce la opción — es el que decide entrar; el script no aprende reglas nuevas.
3. **El plazo de suspensión REAL de la suspensión falsa queda suspendido mientras haya un Wake up
   vivo.** El ajuste «suspender de verdad tras N minutos» y el `thenSuspend` del fichero se ignoran
   con `wakeup.json` activo, se entrara como se entrara y en el orden que fuera (primero el Wake up
   y luego la suspensión falsa a mano, o al revés). Es la única lectura coherente: el Wake up
   promete que el equipo **no se suspende**, y dejar que un temporizador de otra función lo
   suspendiera sería exactamente el fallo que el Wake up existe para impedir.
   - En la UI tiene que **verse**, no adivinarse: con Wake up puesto, el chip de la suspensión falsa
     dice «sin suspender (Wake up)» en vez de la cuenta atrás. Un plazo que calladamente no va a
     saltar es peor que no ofrecerlo.
   - Al **apagarse el Wake up** con la suspensión falsa todavía puesta, el plazo se **rearma desde
     ese instante** (`until = now + N·60`), no se recupera el tiempo transcurrido. Suspender de
     golpe en cuanto se suelta el Wake up sorprende; empezar a contar es lo que el usuario espera.

## Congelar apps del usuario

El primer instinto es `SIGSTOP` a un PID. Está mal: los hijos se escapan, el árbol no se para
atómicamente y `SIGCONT` no garantiza el orden. La primitiva correcta es el **freezer de cgroups**,
que en esta máquina está disponible y es un one-liner, porque las apps salen en scopes propios:

```
app-discord-17743.scope
app-org.chromium.Chromium-4948.scope
```

```sh
systemctl --user freeze app-discord-17743.scope
systemctl --user thaw   app-discord-17743.scope
```

Congela el árbol entero, atómicamente, y descongela limpio.

### La lista es un allowlist explícito y nace VACÍA

Y esto no es prudencia decorativa:

- **Nunca congelar nada con red viva.** Un Firefox o un Chromium congelado cierra su ventana TCP y
  **la descarga muere por timeout exactamente igual que con la suspensión real** — o sea, el fallo
  que esta función existe para evitar, reintroducido por la puerta de atrás. Discord congelado se
  limita a reconectar al volver, que es tolerable.
- **Nunca congelar una slice entera.** Bajo `app.slice` conviven `xdg-desktop-portal-gtk`,
  `dconf.service` y el registry de a11y: congelar el conjunto es un deadlock del escritorio en
  cuanto algo pida un portal, y el síntoma no se parece en nada a la causa.
- **Nunca**: AGS, Hyprland, `pipewire`/`wireplumber`, NetworkManager, ni nada con un lock de D-Bus
  que otro proceso necesite mientras tanto.
- **Nada de congelar por clase o por heurística.** El usuario elige por nombre, una a una, en
  Ajustes. El coste de equivocarse aquí lo paga en datos perdidos, no en un tirón de framerate.

El scope lleva el PID en el nombre (`app-discord-17743.scope`), así que la lista se guarda por
**nombre de app** y el scope se resuelve en el momento con `systemctl --user list-units --type=scope`.

**Deshielo incondicional al arrancar el shell.** Junto a la reescritura del fichero de estado (ver
trampa 7), `initSuspensionFalsa()` descongela todo scope que figure en el allowlist. Un AGS que
muere con apps congeladas las deja congeladas para siempre: el freezer es del cgroup, no del
proceso que lo pidió, y la app simplemente "no responde" sin un solo error en ningún log.

## Cómo se sale — el punto de diseño que más fácil se rompe

Con la pantalla apagada **por nuestra mano**, el `on-resume` del listener de DPMS de
`hypridle.conf` **no se dispara**: hypridle solo emite `on-resume` de un timeout que disparó él.
Si el deshielo cuelga de ese evento, la sesión se queda congelada **sin forma de volver** — y con
las ventanas de AGS ocultas no hay ni UI donde apagarlo.

La salida robusta es **hyprlock como puerta**:

1. Una tecla enciende la pantalla. El ratón **no** (`mouse_move_enables_dpms = false` en
   `gigishell/ventanas.lua`), lo cual aquí es una ventaja: un roce en la mesa no despierta el equipo.
2. Aparece hyprlock. El usuario desbloquea.
3. El desbloqueo dispara la secuencia de salida.

Además, y sin excepción, **un atajo de escape directo** que salga de la suspensión falsa sin pasar
por nada. Es la red de seguridad: si el paso 3 falla, el atajo sigue estando ahí.

### El atajo tiene que ser `locked = true`, o no existe cuando más falta hace

Con hyprlock delante, la sesión está bloqueada y **un bind normal no llega a dispararse**. La red de
seguridad se caería justo en el escenario para el que se puso (bloqueo activo + paso 3 roto). El
flag `locked` de Hyprland es exactamente eso — «funciona también con un inhibidor de entrada
delante» — y en este repo ya se usa para las teclas de volumen, brillo y multimedia
(`gigishell/keybinds.lua`). Así que:

```lua
bind(mod .. " + SHIFT + D", hl.dsp.exec_cmd("ags request toggle-suspension-falsa"),
     { locked = true })
```

Registrarlo con el envoltorio `bind()` de `gigishell/keybinds.lua`, **nunca** con `hl.bind` directo —
si no, no da error, solo deja un bind sordo (ver `gigishell/nop-binds.lua`). `SUPER + SHIFT + D` está
libre hoy; comprobarlo con `hyprctl binds` antes de fijarlo, no de memoria.

Y que quede claro en la UI: **el atajo sale de la suspensión falsa, no desbloquea**. Restaura la
opacidad, el DND, el perfil TLP y descongela las apps; hyprlock sigue delante pidiendo la contraseña, que es
justo lo que se quiere de una función que asume que el usuario no está.

Con la opción de bloqueo desactivada, la salida es solo el atajo. Conviene decirlo en la UI.

## Salir a suspensión real

La adición que convierte esto de parche en **espera**: `thenSuspend`. Cuando la razón para no
suspender deja de existir, se suspende de verdad, sin que el usuario tenga que volver.

- **Por tiempo**: «suspensión falsa 40 min, luego suspender». El ajuste es un número de minutos con
  **0 = desactivado**, no un interruptor aparte.
- **Por condición**: «suspender de verdad cuando no queden descargas activas». La vigilancia de la
  carpeta de descargas ya existe en `oom-monitor.sh` (`monitor_downloads`, con la carpeta resuelta
  por `xdg-user-dir DOWNLOAD` — aquí es `~/Descargas`, no `~/Downloads`).

Ojo: al llegar el momento hay que **salir primero de la suspensión falsa** (deshelar apps,
restaurar TLP, quitar el veto) y solo entonces `systemctl suspend`. Suspender con apps congeladas
deja el freezer puesto al despertar.

### La cuenta atrás no puede ser un tick de un segundo

Lo era, y es el tipo de sondeo que esta función existe para quitar: con un plazo de 40 min son
**2 400 despertares del bucle principal** para refrescar un número que **nadie puede ver** —
durante la suspensión falsa la barra está desmapeada y los paneles cerrados, así que los tres
consumidores de `segundosParaSuspensionReal` (el chip de la barra, `OpcionesSuspensionFalsa` y la
tarjeta de Ajustes) no están en pantalla.

`programarTick()` reprograma en cada vuelta con la cadencia que la UI llega a ENSEÑAR
(`textoRestante`: minutos por encima del minuto, segundos por debajo):

- queda más de 90 s → se duerme hasta el siguiente **múltiplo de minuto**, que es cuando la cifra
  cambia. Se alinea con `restante % 60` y no con «60 s desde ahora», o la cifra saltaría a
  destiempo (mismo criterio que `msHastaSiguienteTick` del reloj de la barra);
- queda menos → un tick por segundo, porque ahí sí se cuentan segundos.

Los mismos 40 min pasan de 2 400 despertares a un centenar, sin perder una sola cifra. El instante
de disparo no depende de la cadencia: cada vuelta se recalcula contra `instanteSuspension`, que es
un epoch **absoluto**, así que no acumula deriva ni se pasa de largo si el bucle llega tarde.

Y recordar la regla 3 de «Wake up y suspensión falsa»: con un Wake up vivo, este plazo **no salta**.

## Alarmas, temporizador y No molestar — la inversión que hay que mirar

Aquí hay un choque real entre dos cosas que el diseño quiere a la vez, y no se ve hasta leer
`decidirSonido()`:

- Las alarmas, el temporizador y el cronómetro **no reproducen nada por su cuenta**: emiten una
  notificación normal con los hints de sonido y decide el subsistema de notificaciones. Está
  documentado como decisión de diseño en `modulos/notificaciones/sonido/decision.ts`.
- En ese mismo fichero, **No molestar silencia el sonido**, y una notificación crítica **no** se
  salta el No molestar (también deliberado: quien activa DND está pidiendo silencio).

Consecuencia: con el DND por defecto de la suspensión falsa, **las alarmas no suenan** — y el ajuste
«silenciar alarmas» no tendría nada que silenciar, porque ya estaban mudas. Un despertador que no
suena porque el equipo estaba en suspensión falsa es el peor fallo posible de esta función, y es
silencioso.

Resolución, que es también lo que hace que los dos ajustes del usuario sean distintos entre sí:

- El DND de la suspensión falsa entra como un motivo **propio**, distinguible del DND manual, en la
  entrada de `decidirSonido()` (p. ej. `dndSuspensionFalsa` junto a `noMolestar`). Sigue tapando los
  popups igual.
- Con ese motivo, el sonido lo gobiernan los dos ajustes nuevos, no el DND:
  - **Silenciar audio de notificaciones** (por defecto **sí**): calla las notificaciones normales.
  - **Silenciar alarmas, temporizador y cronómetro** (por defecto **no**): las alertas del reloj
    **suenan** durante la suspensión falsa salvo que se pida lo contrario. Es la única lectura que
    hace útil al ajuste.
- El DND **manual** del usuario no cambia de comportamiento en absoluto: si estaba puesto antes de
  entrar, sigue callando todo, alarmas incluidas. No lo tocamos y no lo levantamos.

Las alarmas se distinguen por lo que ya emiten: `x-gigishell-source` / los nombres de tema
`SONIDO_ALARMA` y `SONIDO_TEMPORIZADOR`. No inventar un canal nuevo.

## El brillo: lo que se intentó y por qué se retiró

El diseño original bajaba el brillo a 0 al entrar, por el camino de `brilloAhorro.ts` y su apunte en
disco, con el argumento de que así el panel no encendería a pleno brillo en una habitación a oscuras.
**Se implementó, se probó y se quitó.** Dos motivos independientes, y cualquiera de los dos basta:

1. **No ahorraba nada.** El paso 2 de la secuencia es `dpms off`: el panel ya está APAGADO cuando le
   tocaría el turno al brillo. Bajar el brillo de una pantalla apagada no ahorra un vatio.
2. **Se veía, y se veía mal.** La salida la dispara el DESBLOQUEO de hyprlock, pero la pantalla la
   enciende antes cualquier tecla. En esa ventana —de la primera tecla a la contraseña— el usuario se
   encontraba el panel al mínimo, y solo volvía a su brillo al desbloquear. Reportado en vivo.

Y en un equipo con el brillo por DDC dejaba además residuo FÍSICO en la firmware del monitor.

Para volver a intentarlo habría que restaurar el brillo **al encenderse la pantalla**, no al
desbloquear — y no hay ninguna señal fiable de eso: hypridle no emite `on-resume` de un DPMS que
apagamos nosotros, que es el mismo agujero que documenta «Cómo se sale». El aviso está también en la
cabecera de `brilloAhorro.ts`, que es donde lo leería quien fuera a reintroducirlo.

## Qué más se apaga

- **Retroiluminación del teclado y LEDs a 0.** Es el delator visual de que el equipo no está
  suspendido de verdad. Cuidado con el tropiezo ya documentado del brillo: `brightnessctl` **sin**
  `-c backlight` cae al primer dispositivo `leds` y enciende el LED de scroll-lock — aquí queremos
  justo la clase `leds`, así que el selector va explícito en la otra dirección
  (`brightnessctl -d <dispositivo> …`), nunca implícito.
- **Bluetooth off**, opcional y apagado por defecto: es lo que hace de facto la suspensión real, y
  el dongle RTL se reenumera igual al encender.
- **Silenciar el audio**, opcional y apagado por defecto: puede que la música sea justo lo que se
  quiere dejar sonando.

## Qué se descartó, y por qué

- **Modo juego / `gamemode`: no ayuda, hace lo contrario.** Sube el gobernador de CPU a
  `performance` y ajusta prioridades para dar MÁS recursos. Lo aprovechable de la infraestructura
  de juegos no es GameMode sino el **gate** (`lib/gaming-gate.sh`), que ya congela el sondeo caro y
  ya tiene un segundo motivo (modo ahorro) — la suspensión falsa es simplemente un tercero.
- **Congelar `hyprpaper` o apagar animaciones y blur por `hl.config`**: innecesario. Sin frame
  callbacks no pinta nadie. Añadirlo sería mecanismo que no se puede probar que haga algo.
- **Apagar la Wi-Fi**: contradice el motivo de existir de la función.
- **`systemctl --user stop` de servicios**: parar no es congelar. Un servicio parado pierde estado
  y puede no volver; el freezer conserva el proceso intacto.
- **Un servicio o script propio de fondo para GiGiShell**: no hay nada que parar que no pare ya el
  gate o el ocultar las ventanas (ver la última fila de la tabla de reutilización).

## Ajustes

En **Ajustes > Energía**, sección propia (`modulos/ajustes/energia/SeccionEnergia.tsx`), y
persistidos donde ya viven los del modo ahorro — `~/.config/power-save/config.json`, por el mismo
escritor único de `powerState.ts` — bajo claves con prefijo propio. **No** en
`suspension-falsa.json`, que es estado vivo con guarda de pid.

Regla heredada: todo lo que **se ve o puede perder datos** nace apagado, igual que `opaquePanels`,
`opaqueWindows`, `reduceBrightness` y `tlpAuto`.

| Ajuste | Clave | Por defecto |
|---|---|---|
| Bloquear al entrar | `sfLock` | **sí** (es la puerta de salida) |
| No molestar mientras dure | `sfDnd` | sí |
| Silenciar audio de notificaciones | `sfMuteNotis` | sí |
| Silenciar alarmas, temporizador y cronómetro | `sfMuteReloj` | **no** (ver «Alarmas y No molestar») |
| Apagar retroiluminación de teclado / LEDs | `sfLeds` | sí |
| Perfil TLP mientras dure | `sfTlp` | `"no-tocar"` |
| Perfil de energía del sistema (PPD) mientras dure | `sfPpd` | `"no-tocar"` |
| Apps a congelar | `sfFreezeApps` | **lista vacía** |
| Suspender de verdad tras N minutos (0 = nunca) | `sfSuspendMin` | 0 |
| **Usar la suspensión falsa en lugar de la real** | `sfSustituirReal` | **no** |
| Apagar Bluetooth | `sfBluetooth` | no |
| Silenciar audio del sistema | `sfMuteAudio` | no |

### El perfil TLP: un selector, no un segundo interruptor

`tlpAuto` ya existe y ya responde a la pregunta «¿quieres que el perfil TLP baje a ahorro *cuando
la batería esté baja*?». La suspensión falsa hace una pregunta distinta —«¿y mientras estoy
fuera?»— así que **no** se reutiliza aquel booleano ni se clona: el ajuste propio es un
**selector**, que es la salida que ya recomendaba la versión anterior de este documento cuando se
quisieran desacoplar los dos casos.

Valores, y son solo tres porque `servicios/energia/tlp.ts` solo conoce dos perfiles
(`TlpMode = "normal" | "ahorro"`):

- `"no-tocar"` (por defecto): la suspensión falsa no toca TLP. Lo que hubiera puesto el usuario o
  el modo ahorro sigue tal cual, y al salir no se restaura nada porque no se impuso nada.
- `"ahorro"` / `"normal"`: se aplica al entrar y se restaura al salir **solo si al salir sigue
  puesto el que pusimos nosotros** (misma disciplina de `ultimoAplicado` que el brillo).

La tarjeta se **oculta entera** donde `tlpAvailable` es falso —hace falta `tlp` instalado, el helper
`/usr/local/bin/gigishell-tlp-apply` y una batería real—, exactamente como hace ya el selector manual.
En el sobremesa no aparece.

### El perfil de energía del sistema: el efector que más vatios mueve

Y existe porque el párrafo anterior deja un agujero que no se ve hasta contar los efectores en un
sobremesa: **allí `tlpAvailable` es falso, así que la suspensión falsa se quedaba sin UN SOLO
control de energía de CPU.** Apagaba pantalla, DND y LEDs y dejaba el paquete corriendo al perfil
de siempre. Medido con RAPL en este equipo (escritorio en reposo, ventanas de 12 s):

| Perfil PPD | Paquete de CPU |
|---|---|
| `performance` | 22,10 W / 17,40 W |
| `power-saver` | 9,97 W / 9,91 W |

Entre **7 y 12 W**, o sea más que todo lo demás de la lista de efectores junto.

`power-profiles-daemon` es lo que lo resuelve, y su diferencia con TLP es la que decide todo el
diseño de la pieza:

- **No necesita root.** `powerprofilesctl` habla por D-Bus con un demonio de sistema que ya
  autoriza al usuario de la sesión activa. **No hay helper en `/usr/local/bin`, no hay regla en
  `sudoers.d`, no hay nada en `system/` ni paso en `install.sh`**: si el demonio está, funciona.
  Es la razón de que este efector no siga el patrón del de TLP aunque responda a la misma pregunta.
- **No deja residuo persistente.** TLP escribe `/etc/tlp.conf`; PPD es estado vivo del demonio,
  que vuelve a su perfil configurado al reiniciarse él o el equipo. Por eso el efector NO lleva
  apunte en disco: eso está reservado a lo que se pierde en silencio y para siempre (el brillo por
  DDC), y aquí lo peor que deja un AGS muerto es una máquina lenta hasta el siguiente arranque —
  residuo visible y de la misma familia que el mute de `audio.ts`.
- **Los dos conviven en un portátil, y es correcto.** Gobiernan cosas distintas (TLP: periféricos,
  disco y radios; PPD: el EPP/gobernador de la CPU) y no se leen entre sí, así que se aplican en
  cualquier orden. La UI enseña las dos filas y por eso el título del selector de TLP dice «TLP»
  explícitamente: antes las dos se llamaban «Perfil de energía».

Selector de tres valores con la misma disciplina que TLP —«no-tocar» no impone nada y por tanto no
restaura nada—, y **`performance` NO se ofrece a propósito**: este ajuste existe para gastar menos
con el equipo desatendido, y una opción que gasta más no tiene ningún caso de uso detrás.

La comparación de `restaurar()` («¿sigue puesto el que puse yo?») cubre de un golpe los tres modos
de fallo, sin una segunda bandera que pudiera mentir: el usuario lo cambió a mano, el `set` falló
al entrar (hay drivers de CPU que no publican `power-saver`), o algo tomó un **hold**
(`powerprofilesctl launch`, que es como un juego o un instalador fuerzan `performance` un rato) —
en los tres, `get` devuelve algo que no es lo nuestro y no se toca nada.

## Sustituir la suspensión real por la falsa

El ajuste `sfSustituirReal` no es «un ajuste más»: cambia lo que hace **todo el sistema** al
suspender. Existe para los equipos cuyo S3 no vuelve bien —el caso típico son los drivers de la
GPU—, donde una suspensión que gasta más pero siempre despierta le gana a una que a veces deja el
equipo colgado.

### Los cuatro caminos que suspendían de verdad

Un interruptor que solo cubriera uno sería peor que no tenerlo, porque el usuario creería que está
protegido. Son estos, y los cuatro están cubiertos:

| Camino | Cómo se sustituye |
|---|---|
| Inactividad (`hypridle` → `idle-action.sh suspend`) | `sustituye_suspension()` veta, y el aviso del veto hace que AGS entre en suspensión falsa |
| Menú de energía → «Suspender» | su `comando` pasa a `sh -c 'ags request suspend \|\| systemctl suspend'` |
| Botón físico de encendido (`gigishell/boton-apagado.lua`) | el mismo comando |
| El plazo de la propia suspensión falsa (`thenSuspend`) | deja de existir (ver abajo) |

**Lo que NO cubre, y hay que saberlo:** cerrar la tapa. Eso lo decide `logind`
(`HandleLidSwitch`), que no pasa por hypridle ni por este script. Para taparlo haría falta
cambiar `logind.conf`, que es configuración del sistema y no de este repo.

### El punto único, y por qué

El menú de energía y el botón de encendido no llaman ya a `systemctl suspend`: van a `ags request
suspend`, que es quien conoce el ajuste. Sin ese punto único, encender el sustituto arreglaría la
inactividad y dejaría el **botón de encendido** suspendiendo de verdad — el camino más fácil de
pulsar sin pensar y justo el que se quería evitar.

Los dos llevan `|| systemctl suspend` de reserva. No es cosmético: sin AGS no hay nadie capaz de
hacer una suspensión falsa, así que la real es la degradación correcta. Es la misma REGLA DE ORO
que el resto: `sustituye_suspension()` comprueba el pid y, con AGS caído, **deja pasar la
suspensión real**. Un equipo que no se suspende jamás y se come la batería en silencio es peor que
un S3 que quizá no vuelva, porque aquello se ve y esto no.

### `substitute` viaja con `active: false`

Es la única clave de `suspension-falsa.json` que se mira aunque no haya ninguna suspensión falsa
puesta, y tiene que ser así: el ajuste dice «en este equipo la suspensión real no se usa», luego
tiene que vetar ya la **primera** inactividad del día. Por eso `suspensionFalsa.ts` se suscribe al
ajuste y reescribe el fichero al cambiarlo, sin esperar a la próxima entrada — que podría no llegar
en horas.

### Lo que el sustituto ANULA, que es la parte que no es un interruptor

- **El plazo «suspender de verdad tras N minutos» deja de existir.** No se pospone como con el Wake
  up: se contradice de raíz. Cumplirlo dejaría colgado justo el equipo cuyo dueño encendió el
  ajuste para que eso no pasara. En la UI el control se **deshabilita** y se dice por qué; en
  `replanificarPlazo()` no se arma el temporizador, y `suspenderDeVerdad()` comprueba el ajuste otra
  vez antes de llamar a `systemctl suspend` — el ajuste puede encenderse DESPUÉS de armar el
  temporizador, y entre el `timeout_add` y su vencimiento pasan minutos.
- **La opción del Wake up «entrar en suspensión falsa al vencer» se vuelve redundante**, porque ya
  pasa siempre. La fila se deshabilita y el tooltip lo explica, en vez de dejar un interruptor que
  se puede apagar y no cambia nada. El valor guardado no se toca: al apagar el sustituto vuelve a
  mandar lo que el usuario tuviera ahí.
- **El puente atiende las dos razones.** `wakeUpSuspensionFalsa.ts` convierte el veto en suspensión
  falsa si el sustituto está puesto **o** si hay un Wake up con su opción. El aviso que llega de
  bash es el mismo; lo que cambia es quién lo reclama.

## Superficie de UI

- **Función conmutable en el menú de la barra**, junto a «Wake up»: `FUNCIONES_BARRA` en
  `modulos/barra/funciones/registro.ts`, con `estado` (chip: tiempo restante, o «sin suspender
  (Wake up)» según la regla 3) y `expandir` para el plazo y el destino final. Pulsarla entra **al
  instante**.
- **Opción dentro del Wake up** (`OpcionesMantenerDespierto.tsx`): «al vencer la inactividad, entrar
  en suspensión falsa». Ver «Wake up y suspensión falsa».
- **Atajo de teclado** para entrar y para salir, con `locked = true` (ver «Cómo se sale»).
- **Menú de energía**: encaja, y el obstáculo tiene salida barata. `ACCIONES_ENERGIA`
  (`modulos/menu-energia/acciones.ts`) es una lista de **comandos de shell** (`comando: string`)
  que se ejecutan con `execAsync`, y una acción interna del shell no cabe en ese tipo sin cambiarlo.
  Solución: exponer la entrada como comando —`ags request toggle-suspension-falsa`, registrado en el
  `requestHandler` de `app.ts` igual que `toggle-bar`, `toggle-orion` o `toggle-power-menu`—, que
  además da de regalo el punto de entrada scriptable para el atajo y para cualquier automatismo.
  Recordar que `claseCss` es la clave con la que se guarda en `preferences.json`: elegirla bien a la
  primera, renombrarla luego obliga a migrar la preferencia.

## Trampas conocidas, antes de escribir una línea

1. **`hl.dsp.dpms('off')` es un TOGGLE.** El argumento tiene que ser una TABLA. Con string,
   `tableToggleAction()` sale por `if (!lua_istable(...)) return TOGGLE_ACTION_TOGGLE`, tira el
   `'off'`, invierte el estado y responde `ok` — rc 0, stdout `ok`, acción invertida. Ver la
   sección «Salir de suspensión» de [`hyprland-modulos.md`](hyprland-modulos.md). **Usar
   `idle-action.sh`, que ya lo tiene bien**, en vez de escribir el dispatcher otra vez.
2. **No meter llaves `{}` en `hypr/hypridle.conf`.** El parser de Ajustes > Pantalla trocea los
   listeners con `listener\s*\{[^}]*\}` y una llave de tabla Lua corta el bloque antes de tiempo:
   el listener deja de ser editable desde la UI **en silencio**. Es el motivo de que
   `idle-action.sh` exista.
3. **hyprlock no tiene guarda de instancia única.** Lanzarlo con uno ya puesto arranca un segundo
   proceso de verdad. Siempre se comprueba antes de lanzarlo.

   La comprobación **NO lanza `pidof`**, y el cambio se pagó dos veces:

   - Era `GLib.spawn_command_line_sync("pidof hyprlock")`, o sea un fork + exec + enlazado
     dinámico **bloqueando el bucle de GTK**, y repetido cada 5 s durante toda la suspensión falsa
     por el sondeo del plan B. `pidof` hace exactamente el mismo recorrido de `/proc` que ahora
     hace `hayHyprlock()` en proceso: mismos datos, cero forks.
   - Y colgaba de que `pidof` estuviera instalado. Sin él la rama respondía «no bloqueado» y se
     lanzaba **un segundo hyprlock encima del que ya estaba**, que es justo lo que este punto
     existe para impedir.

   Se compara contra `comm` y no contra la línea de órdenes: así no lo confunde un `grep hyprlock`
   ni un editor con el fichero abierto. Los 5 s del sondeo **no se estiran** para ahorrar más — son
   la latencia con la que vuelve el escritorio por ese camino, y ahí sí hay una persona delante de
   una pantalla encendida.
4. **Un bind sin `locked = true` no existe con hyprlock delante.** Ver «El atajo tiene que ser
   `locked = true`». Y todo bind pasa por el envoltorio `bind()`, nunca por `hl.bind`.
5. **Editar un `*-monitor.sh` no afecta al que ya está corriendo.** Hace falta `pkill -f <script>`
   + relanzar, o `hyprctl reload full-reset` (un `hyprctl reload` normal **no** re-ejecuta el
   autostart).
6. **`jq '.clave // true'` trata un `false` literal como ausente** y siempre resuelve a `true`. Para
   los ajustes booleanos nuevos, la forma es `if has("clave") then … else … end` (mismo tropiezo ya
   documentado en `battery-monitor.sh`, `temp-monitor.sh` y `gaming-gate.sh`).
7. **Nada bloqueante en un callback de Hyprland**: `hl.on` y los binds con función tienen **timeout
   de 100 ms**.
8. **Los PID se reciclan.** La guarda de pid necesita su otra mitad: reescribir el fichero de
   estado al arrancar el shell, como hacen `initGamingState()` e `initWakeUp()`. En el mismo sitio
   va el deshielo incondicional de las apps del allowlist.
9. **Una crítica no se salta el No molestar** (`decidirSonido`, deliberado). De ahí la sección de
   alarmas: no basta con marcar la alarma como urgente.

## Plan de implementación

Por fases, cada una útil por sí sola y probable de forma aislada. **Las ocho están hechas**; el
orden se conserva porque explica por qué cada pieza depende de la anterior:

1. **Núcleo**: estado en RAM + `suspension-falsa.json` + entrada/salida con DPMS, bloqueo, DND,
   flags de `powerState`, ocultar ventanas de AGS. `ags request toggle-suspension-falsa` y atajo de
   escape `locked = true` **desde el primer commit**, más el `init…()` con reescritura de estado.
2. **Veto**: `blocked()` en `idle-action.sh` leyendo los dos ficheros con un helper común, +
   reinicio de hypridle al salir.
3. **UI**: función de la barra con chip de tiempo, sección de Ajustes > Energía, acción del menú de
   energía.
4. **Sonido**: motivo `dndSuspensionFalsa` en `decidirSonido` + los dos ajustes de silencio.
5. **LEDs y TLP**, reutilizando los caminos de apunte/restauración existentes. (El brillo entró en
   esta fase y se retiró después de probarlo; ver su sección.)
6. **Wake up**: opción de entrada delegada + supresión del plazo real mientras el Wake up viva.
7. **`thenSuspend`** por tiempo, y luego por condición (descargas).
8. **Congelar apps.** La última a propósito: es lo único que puede perder datos del usuario.

## Dónde vive cada cosa

| Pieza | Fichero |
|---|---|
| Orquestador: estado, secuencias, plazo, puerta de salida | `ags/servicios/energia/suspensionFalsa.ts` |
| Contrato de los efectores y su ORDEN (entrada; la salida lo recorre al revés) | `ags/servicios/energia/suspensionFalsa/efectores.ts` |
| Efectores | `suspensionFalsa/{dnd,leds,tlp,perfilEnergia,bluetooth,audio,congelarApps}.ts` |
| Los once ajustes `sf*` (carga, validación, persistencia) y el OR con las suspensiones del shell | `ags/servicios/energia/powerState.ts` |
| Puente «Wake up → suspensión falsa al vencer» | `ags/servicios/energia/wakeUpSuspensionFalsa.ts` |
| Veto + aviso del veto + sustituto | `hypr/scripts/idle-action.sh` (`alcance_vigente`, `sustituye_suspension`, `blocked`, `SIGNAL_VETO`) |
| «Suspender» del sistema, con el sustituto aplicado | `ags/app.ts` → `ags request suspend`; lo llaman `menu-energia/acciones.ts` y `hypr/gigishell/boton-apagado.lua` |
| Atajo `SUPER + SHIFT + D`, con `locked = true` | `hypr/gigishell/keybinds.lua` |
| UI: función de la barra y sus opciones | `ags/modulos/barra/funciones/{registro.ts,OpcionesSuspensionFalsa.tsx}` |
| UI: Ajustes > Energía | `ags/modulos/ajustes/energia/{SuspensionFalsa,AppsCongeladas}.tsx` |
| Resolución nombre de app → scope de systemd (UNA sola, la comparten UI y efector) | `ags/modulos/ajustes/energia/scopesApps.ts` |
| Sonido: el motivo distinguible del DND manual | `ags/modulos/notificaciones/sonido/decision.ts` |
| Punto de entrada scriptable | `ags/app.ts` → `ags request toggle-suspension-falsa` |

Ficheros de estado en `~/.config/gigishell/`: `suspension-falsa.json` (estado vivo con guarda de pid,
lo lee bash), `idle-suspend-vetado` (el epoch del último veto, lo lee el puente),
`wakeup-opciones.json` (la opción nueva del Wake up). Los ajustes van con los del modo ahorro, en
`~/.config/power-save/config.json`.

### Cómo probar cada pieza

- Que el veto funciona: entrar en suspensión falsa, bajar el timeout de suspensión de
  `hypridle.conf` a 60 s, esperar. Debe **no** suspenderse. Repetir matando AGS a mano: debe
  suspenderse (fail-open).
- Que la salida funciona con la pantalla apagada por nuestra mano y **sin** que ningún listener de
  hypridle haya vencido. Es el caso que rompe el diseño ingenuo.
- Que el atajo de escape funciona **con hyprlock delante** (sin él, la red de seguridad no existe).
- Que un crash de AGS a mitad devuelve el escritorio a su sitio: `pkill ags` con todo puesto y
  mirar opacidad, DND, TLP y apps congeladas (y que el arranque siguiente las descongela).
- Que una alarma programada para dentro de 2 min SUENA con la suspensión falsa puesta y los ajustes
  por defecto. Es la comprobación de la sección de alarmas y el fallo más caro de todos.
- Que con Wake up activo el plazo de suspensión real **no** salta, y que al apagar el Wake up el
  plazo empieza a contar desde ese momento.
- Con el **sustituto** puesto: que la inactividad entra en suspensión falsa en vez de suspender,
  que «Suspender» del menú de energía y el botón físico hacen lo mismo, y que el plazo aparece
  deshabilitado. Repetir matando AGS: los tres deben volver a suspender de verdad (fail-open).
- Que una descarga larga sobrevive a un ciclo completo de entrada y salida. Es el motivo de existir
  de la función y debería ser el primer test que se escribe.
