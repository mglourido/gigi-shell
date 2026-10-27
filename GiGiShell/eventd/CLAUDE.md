# CLAUDE.md — eventd

Parte de la guía de GiGiShell (mapa de zonas en el [`CLAUDE.md` raíz](../CLAUDE.md)).

`eventd/` (daemon Rust `gigishell-eventd`: sustituye a los seis sub-monitores de
`oom-monitor.sh` cuando está instalado en `~/.local/bin` —el script le pregunta cuáles con
`--modulos` y, si son todos, le cede el proceso con `exec`; sin el binario corre el bash. Una
regla de seguridad cambiada en un sitio hay que cambiarla en el otro. Plan y estado en
[`docs/rust-migracion.md`](docs/rust-migracion.md), que explica también por qué eventd y guardian
compilan en `~/.cache/gigishell/cargo/<crate>` y no en `target/` — un crate nuevo necesita su
`.cargo/config.toml` o vuelve a llenar el repo de compilados sin avisar).
