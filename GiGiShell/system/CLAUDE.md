# CLAUDE.md — system

Parte de la guía de GiGiShell (mapa de zonas en el [`CLAUDE.md` raíz](../CLAUDE.md)).

`system/` (ficheros que van a `/etc` y `/usr/local/bin`, **no** se symlinkean: se instalan con `sudo` —
la regla udev de escritura en USB, la carga del módulo `i2c-dev`, los perfiles TLP, el helper de
firmas de ClamAV, el helper de limpieza de disco, el helper de bloqueo de la cámara, el helper y la
preparación de la **hibernación**, la cesión del
botón de encendido a Hyprland, la configuración de SDDM y la unidad systemd de la **protección de
archivos** (`system/guardian/`); ver las secciones de USB, de brillo, de TLP, de ClamAV, de almacenamiento, de
cámara, de hibernación, del botón de encendido y de protección de archivos).
