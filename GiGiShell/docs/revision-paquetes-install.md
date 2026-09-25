# Revisión de paquetes de `install.sh`

**Fecha:** 25-09-2026

**Alcance:** lista `official` de `install.sh`, comprobaciones de `bin/preflight.sh` y usos encontrados en AGS, Hyprland y scripts de `bin/`. Las propuestas aceptadas se aplicaron en `install.sh` y `bin/preflight.sh`; la detección opcional de npm sigue activa para instalaciones que ya lo tengan.

## Resumen

Los recortes aplicados son **`wget`, `bc` y `npm`**: no son necesarios para arrancar GiGiShell ni el código del repositorio invoca `wget` o `bc`. npm sí habilita la limpieza de su caché desde Ajustes > Almacenamiento; por eso se retiró de la instalación base, pero se mantiene como función opcional si ya está instalado.

No encontré una pareja de paquetes de uso activo que se pueda fusionar sin cambiar alguna función. Varias parejas que parecen redundantes cubren capas distintas o tienen llamadas directas independientes.

## Cambios aprobados y aplicados

| Paquete | Evidencia en el árbol | Propuesta | Efecto y trabajo necesario |
|---|---|---|---|
| `wget` | Solo aparecía en la lista de `install.sh` y en la comprobación de `bin/preflight.sh`; no encontré invocaciones del comando. Las descargas de Spotify, calendario, carátulas y fondos usan `curl`. | **Aplicado:** retirado de la instalación y del preflight. | Ningún cambio esperado en GiGiShell. Se pierde la comodidad de tener `wget` preinstalado para uso manual. |
| `bc` | Solo aparecía como paquete requerido en `bin/preflight.sh` y en la lista de `install.sh`; no encontré invocaciones ejecutables. `qalculate-gtk` se usa como calculadora gráfica, no como reemplazo CLI de `bc`. | **Aplicado:** retirado de la instalación y del preflight. | Ningún cambio esperado en GiGiShell. No se sustituye por Qalculate: el shell no llama a ninguno de los dos para hacer cálculos. |

## npm como dependencia opcional

| Paquete | Evidencia en el árbol | Propuesta | Efecto y trabajo necesario |
|---|---|---|---|
| `npm` | GiGiShell no arranca con npm. El uso de runtime localizado es `npm cache clean --force` en la limpieza de caché; el resto de menciones son detección/contabilidad del gestor. | **Aplicado:** retirado de la instalación base; se conserva la detección para mostrar/limpiar cachés cuando esté presente. | GiGiShell y AGS siguen arrancando. En instalaciones nuevas npm se instala aparte si se necesita; su caché no aparecerá ni podrá limpiarse desde Ajustes hasta entonces. |

## Paquetes que parecen duplicados, pero cubren usos diferentes

- **`grim`, `slurp` y `hyprshot`:** `hyprshot` simplifica capturas por atajo, pero el shell invoca `grim` directamente para vistas previas/capturas y `slurp` para seleccionar región al grabar pantalla. Quitarlos exigiría migrar esos usos y comprobar que la captura por monitor, selección y grabación conservan el mismo flujo.
- **`curl` y `wget`:** no son equivalentes en este árbol. `curl` sí se invoca desde autenticación e integraciones de AGS; `wget` no se invoca. El recorte posible es quitar `wget`, no sustituir `curl`.
- **`libcanberra` y `sound-theme-freedesktop`:** el primero aporta el reproductor que resuelve `sound-name`; el segundo aporta nombres de sonido del tema. Los cuatro sonidos incluidos cubren los valores actuales de alarma/temporizador y algunos habituales, pero se perdería el fallback para otros nombres de tema si se quita el tema freedesktop. Mantener ambos da compatibilidad más amplia.
- **`libpulse` y PipeWire:** la interfaz de audio principal va por AstalWp/`wpctl`, pero algunas funciones usan `pactl` para enumerar clientes y clasificar capturas/mover streams. `pipewire-pulse` no hace innecesario el cliente `pactl` (`libpulse`). Quitar cualquiera requiere migrar las llamadas indicadas y validar la clasificación de capturas y el audio por aplicación.
- **`imagemagick`:** sí se usa (`magick`) para reducir imágenes del portapapeles y generar miniaturas de fondos. GTK/GdkPixbuf ya puede procesar algunos formatos, pero sustituir ImageMagick cambia la cobertura de formatos y las rutas de error. Arch publica ImageMagick 7.1.2.31 en Extra al revisar esto; no hay evidencia de que el paquete esté obsoleto. El recorte de tamaño solo merece la pena si se acepta rediseñar esos dos flujos.
- **`libcanberra` y los sonidos propios:** incluso con los cuatro audios del repo, `libcanberra` sigue siendo un reproductor útil para nombres de tema y otros sonidos; no se sustituye solo por incluir los ficheros.
- **`expac` y `pacman-contrib`:** no se solapan. `expac` acelera el inventario de paquetes; `pacman-contrib` proporciona `checkupdates` y `paccache`, usados respectivamente por el indicador de actualizaciones y la limpieza de caché. El código ya tiene degradaciones si falta cada herramienta.

## Dependencias que no recortaría en esta revisión

- **`xcur2png` + `hyprcursor`:** son dos etapas distintas del generador de cursores; `hyprcursor-util --extract` llama a `xcur2png`. La documentación del script registra que no es una dependencia transitiva.
- **`qt6-svg`, `qt6-multimedia-ffmpeg` y `qt6-virtualkeyboard`:** soportan SVG, fondo de vídeo y teclado virtual del tema de SDDM. No son tres alternativas para una misma función.
- **`ffmpegthumbs` + `kdegraphics-thumbnailers`:** Dolphin usa generadores diferentes para tipos de archivo distintos; quitarlos reduce las miniaturas.
- **`procps-ng`, `glib2`, `fontconfig` y `gawk`:** se declaran por comandos concretos (`pgrep`/`pkill`, `gsettings`/`gio`, `fc-match` y extensiones GNU de awk), no solo por una dependencia transitiva accidental.
- **`base-devel`:** no lo usa el shell en sesión, pero hace falta para compilar paquetes AUR cuando `paru`/`yay` resuelven AGS/Astal desde AUR. Suprimirlo puede convertir una instalación Arch sin repositorio binario de esos paquetes en una instalación incompleta.

## Herramientas actuales frente a alternativas

En los paquetes activos examinados no aparece una sustitución que ofrezca el mismo comportamiento con menos dependencias y sin migrar código. En particular, el uso de `magick` es real y el paquete Arch está en la versión 7 actual; no lo marcaría como viejo solo por su tamaño. Las herramientas de Hyprland/Wayland, audio y GTK están llamadas de forma directa y sus alternativas implican cambios funcionales, no una actualización transparente.

## Resultado

Se quitaron `wget`, `bc` y `npm` de la lista de dependencias obligatorias y del preflight. npm sigue siendo una función opcional de la limpieza de caché cuando el usuario ya lo tenga instalado. Las parejas restantes requieren migrar o perder funciones; no se recortaron.

## Fuentes consultadas

- [Lista de paquetes del instalador](../install.sh)
- [Comprobaciones de instalación](../bin/preflight.sh)
- [Audio del shell y sonidos incluidos](../audio/README.md)
- [Paquete ImageMagick en Arch Linux](https://archlinux.org/packages/extra/x86_64/imagemagick/)
- [Seguridad del paquete ImageMagick en Arch Linux](https://security.archlinux.org/package/imagemagick)
- [Manual de qalculate-gtk en Arch Linux](https://man.archlinux.org/man/qalculate-gtk.1.en)
