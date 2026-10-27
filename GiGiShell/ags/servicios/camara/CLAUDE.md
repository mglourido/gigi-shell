# CLAUDE.md — Cámara

Parte de la guía de `ags/` (mapa de áreas en [`ags/CLAUDE.md`](../../CLAUDE.md)). Aquí: controles V4L2, uso de la cámara y bloqueo.

- `servicios/camara/` + `modulos/ajustes-rapidos` (tile y `QsCamaraMenu`), `modulos/ajustes/camara/` y
  `modulos/barra/indicadores/sistema/Camara.tsx` — **la cámara**. Toda la parte de sistema vive en el
  servicio y ninguna de las tres vistas enumera, parsea o persiste por su cuenta. Lo que hay que saber
  antes de tocar cualquiera de ellas está en la sección «Cámara» de
  [`../docs/hyprland-modulos.md`](../docs/hyprland-modulos.md); en corto:
  - **La UI se GENERA de lo que publique el firmware**, nunca sliders fijos. Los rangos cambian por
    modelo (`brightness` es 0..255 en unas cámaras y -64..64 en otras) y `v4l2-ctl --set-ctrl`
    **acota en silencio**: un slider 0..100 mandando el valor tal cual movería la imagen en el primer
    tramo y no haría nada en el resto, sin un solo error.
  - **`flags=inactive`** (un control encadenado a un automático encendido) acepta la escritura,
    devuelve 0 y no cambia nada. El mando se deshabilita, y **toda escritura se relee**: encender un
    automático cambia el `inactivo` de OTROS controles.
  - **Una webcam registra 2-3 `/dev/videoN`**; el de metadatos contesta a `--list-ctrls` con la lista
    vacía y sin error. El filtro es `ID_V4L_CAPABILITIES` de udev, no el nombre.
  - **El uso de la cámara NO se detecta desde aquí.** Las apps abren V4L2 directamente, sin pasar por
    PipeWire, así que no hay señal a la que suscribirse como con el micro; y barrer `/proc/*/fd` se
    midió en **28 ms con 435 procesos**. Lo detecta `hypr/scripts/camara-monitor.sh` con inotify
    (`IN_OPEN`/`IN_CLOSE` funcionan sobre nodos de dispositivo) y `uso.ts` solo lee su JSON.
  - **No existe «cámara por defecto» en Linux**: la preferida vale dentro de GiGiShell y la UI lo dice.
    La resolución la negocia la app al abrir el stream, así que los formatos son una ficha
    informativa, nunca un desplegable que se aplique.
  - **El killswitch («Cámara bloqueada») lo aplica un helper root**, no AGS: `servicios/camara/
    bloqueo.ts` solo llama a `/usr/local/bin/gigishell-camara` por una regla sudoers acotada a sus dos
    verbos, y sin helper instalado el interruptor **no se pinta** en vez de fallar al pulsarlo. Lo
    que sostiene todo es el número de la regla udev que instala —`71-`, entre el `70-uaccess` que
    etiqueta y el `73-seat-late` que concede la ACL—: en `99-` no bloquearía nada y no daría ningún
    error. Bloquear impide ABRIR la cámara, no corta una captura en marcha, y las dos vistas lo
    dicen. Ojo al efecto lateral: bloqueada, `v4l2-ctl` falla por permisos y la lista de controles
    sale vacía — hay que distinguir eso de «no expone controles» y releer al desbloquear.
