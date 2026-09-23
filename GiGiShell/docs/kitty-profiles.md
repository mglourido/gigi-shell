# Perfiles de rendimiento de Kitty

Kitty comparte tema, fuente, pestañas y atajos entre todas las máquinas. Solo
los ajustes que afectan al consumo y a la latencia se separan en dos perfiles:

```text
~/.config/kitty/
├── kitty.conf
├── base.conf
├── theme.conf
├── profiles/
│   ├── laptop.conf
│   └── desktop.conf
└── active-profile.conf -> profiles/desktop.conf
```

Los cinco archivos de configuración pertenecen al repositorio bare de dotfiles.
`active-profile.conf` es un symlink local ignorado por Git: permite
que dos equipos usen la misma rama sin cambiar de perfil mutuamente. Kitty no
se gestiona mediante `GiGiShell/bin/link.sh`; el checkout bare lo coloca directamente
en `~/.config/kitty/`.

## Elegir el perfil

Durante una instalación nueva, `KITTY_PROFILE` acepta `auto`, `laptop` o
`desktop`. El valor predeterminado es `auto`: si `/sys/class/power_supply`
contiene una batería del sistema elige `laptop`; en caso contrario elige
`desktop`. Las baterías de periféricos (`scope=Device`), como ratones o mandos,
se ignoran.

```sh
curl -fsSL https://raw.githubusercontent.com/mglourido/gigi-shell/main/GiGiShell/install.sh \
  | KITTY_PROFILE=desktop bash
```

Para cambiarlo después de instalar:

```sh
~/GiGiShell/bin/kitty-profile.sh desktop
~/GiGiShell/bin/kitty-profile.sh laptop
~/GiGiShell/bin/kitty-profile.sh auto
~/GiGiShell/bin/kitty-profile.sh status
```

Después del cambio, pulsa `Ctrl+Shift+F5` en Kitty para recargar la configuración
o abre una instancia nueva.

## Diferencias

| Opción | `laptop` | `desktop` |
| --- | ---: | ---: |
| `repaint_delay` | 16 ms | 2 ms |
| `input_delay` | 5 ms | 0 ms |
| `sync_to_monitor` | `yes` | `yes` |
| `cursor_trail` | 1 | 1 |
| `cursor_blink_interval` | 0 | 0 |
| `scrollback_lines` | 2000 | 2000 |
| `scrollback_pager_history_size` | 0 | 5 MB |

El perfil de portátil conserva los valores de bajo consumo originales. El de
sobremesa reduce las esperas internas y conserva el rastro animado del cursor.
Además, guarda hasta 5 MB de salida adicional para el visor del historial sin
aumentar las 2000 líneas usadas por el desplazamiento interactivo normal.
La sincronización con el monitor se mantiene para evitar tearing. Si todavía se
percibe latencia con un monitor de baja frecuencia, se puede probar temporalmente
`sync_to_monitor no`; debe conservarse solo si la mejora compensa el posible
tearing durante el desplazamiento.

## Mejoras comunes

- Kitty avisa cuando un comando tarda al menos 15 segundos y su ventana no está
  visible, usando el daemon de notificaciones de AGS.
- Al copiar texto se eliminan espacios finales, excepto en selecciones
  rectangulares, donde pueden ser significativos.
- Al agrandar una ventana, el espacio nuevo se rellena desde el scrollback.
- Un punto `●` identifica actividad nueva en pestañas sin foco.
- La integración con Zsh queda activada explícitamente y el control remoto sigue
  desactivado. Tampoco se habilita la copia automática por selección, para no
  exponer el portapapeles innecesariamente.

## Atajos útiles

| Atajo | Acción |
| --- | --- |
| `Ctrl+Shift+Enter` | abrir una división conservando el directorio actual |
| `Ctrl+Shift+T` | abrir una pestaña en el directorio actual |
| `Ctrl+Shift+N` | abrir otra ventana de Kitty en el directorio actual |
| `Ctrl+Alt+Z` / `Ctrl+Alt+X` | saltar al prompt anterior/siguiente |
| `Ctrl+Shift+G` | mostrar la salida del último comando en el pager |
| `Ctrl+Shift+H` | abrir todo el scrollback en el pager |
| `Ctrl+Shift+E` | seleccionar y abrir una URL usando el teclado |
| `Ctrl+Shift+P`, después `F` | seleccionar una ruta visible e insertarla en el prompt |
| `Ctrl+Alt+L` | borrar de la pantalla el último comando y su salida |
| `Ctrl+Shift+F5` | recargar la configuración de Kitty |

## Verificación y diagnóstico

```sh
~/GiGiShell/bin/kitty-profile.sh status
~/GiGiShell/bin/preflight.sh --installed
kitty --debug-gl
```

El preflight carga explícitamente `~/.config/kitty/kitty.conf`, valida los dos
perfiles, comprueba el symlink activo y confirma que siguen presentes los atajos
de `Ctrl+Enter`, `Alt+Enter` y `Ctrl+Shift+Z`. `kitty --debug-gl` debe ejecutarse
dentro de la sesión gráfica y sirve para revisar el renderizador si el perfil
`desktop` continúa sintiéndose lento.
