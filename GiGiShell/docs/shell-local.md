# Configuración de las shells: compartida y local

Bash, Zsh y Fish tienen su configuración partida en dos ficheros: uno
**compartido**, versionado en dotfiles, y otro **local** de cada equipo, sin
versionar. No se compila nada: el fichero local carga el compartido con
`source` y debajo añade lo suyo.

| Shell | Compartido (versionado)             | Local (NO versionado)       |
|-------|-------------------------------------|-----------------------------|
| Bash  | `~/.config/bash/bashrc`             | `~/.bashrc`                 |
| Zsh   | `~/.config/zsh/gigishell.zshenv`       | `~/.config/zsh/.zshenv`     |
| Zsh   | `~/.config/zsh/gigishell.zshrc`        | `~/.config/zsh/.zshrc`      |
| Fish  | `~/.config/fish/conf.d/gigishell.fish` | `~/.config/fish/config.fish`, `conf.d/rustup.fish`, `fish_variables` |

`~/.zshenv` (el que fija `ZDOTDIR`) y `~/.config/zsh/functions/*.zsh` siguen
versionados tal cual: no tienen nada propio de un equipo.

## Por qué así y no al revés

El fichero local es **el que la shell lee de verdad**, y eso es a propósito: los
instaladores de herramientas (rustup, bun, fnm, opam, el CLI de Antigravity…)
escriben siempre en `~/.bashrc`, `$ZDOTDIR/.zshrc` o `config.fish`, casi siempre
con rutas absolutas (`/home/<usuario>/…`). Si esos ficheros se versionaran, cada
instalación ensuciaría el repo con rutas que otro equipo no tiene, o tiene en
otro sitio. Un fichero «compilado» a partir de los dos tampoco sirve: el
instalador escribiría en el generado y la siguiente regeneración lo borraría.

## Qué va en cada uno

- **Compartido:** alias, funciones, prompt, historial, plugins, `~/.local/bin`
  (ruta XDG estándar) y todo lo que tenga que ser igual en cualquier máquina.
- **Local:** `PATH` y `source` de herramientas instaladas (`~/.cargo/env`,
  `~/.bun`, `fnm`, `opam`, `depot_tools`…), rutas con el nombre de usuario y
  cualquier ajuste de un solo equipo.

`bin/preflight.sh --installed` falla si el compartido contiene rutas de ese tipo
fuera de comentarios (`/home/`, `.cargo/`, `.bun`, `opam-init`, `fnm env`,
`depot_tools`).

## Crear y comprobar los ficheros locales

```sh
GiGiShell/bin/shell-local.sh            # crea los que falten
GiGiShell/bin/shell-local.sh --check    # solo informa
GiGiShell/bin/shell-local.sh --force    # respalda y reemplaza los que no cargan el compartido
```

Lo llama `bin/link.sh` con su mismo modo, y por tanto `install.sh`
(`link.sh --force`). Un fichero local que ya existe pero no carga el compartido
—el `.bashrc` de `/etc/skel` en una instalación nueva, o el antiguo versionado
entero— **no se toca** sin `--force`: añadirle la línea de `source` a ciegas
duplicaría la configuración si ya la llevaba dentro.

## Migrar otro equipo

Al traer el commit que dejó de versionar estos ficheros, git **borra** del
work-tree los que no tuvieran cambios locales (su contenido es el del commit
anterior, no se pierde nada). Si tenían cambios, el `pull`/`checkout` se niega
a seguir: copia antes las líneas propias del equipo aparte. Después:

```sh
GiGiShell/bin/shell-local.sh   # recrea los locales
# y vuelve a pegar debajo del `source` las líneas propias de ese equipo
```
