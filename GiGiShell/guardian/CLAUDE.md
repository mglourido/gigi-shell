# CLAUDE.md — guardian

Parte de la guía de GiGiShell (mapa de zonas en el [`CLAUDE.md` raíz](../CLAUDE.md)).

`guardian/` (daemon Rust root `gigishell-guardian`, la **protección de archivos**: BPF LSM +
fanotify, gobernado desde Ajustes > Seguridad > Protección de archivos. Se instala **apagado**; su
política vive en `/var/lib/gigishell-guardian/`, no en `~/.config`, a propósito. Ver su sección en
[`docs/hyprland-modulos.md`](docs/hyprland-modulos.md) antes de tocarlo).
