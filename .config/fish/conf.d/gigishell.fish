# Configuración COMPARTIDA de Fish (versionada en dotfiles).
#
# Fish carga conf.d/*.fish ANTES que config.fish, que queda LOCAL de cada equipo
# y sin versionar: ahí escriben los instaladores (rustup deja además su propio
# conf.d/rustup.fish, también local). Nada de rutas de una máquina aquí.
# Ver GiGiShell/docs/shell-local.md.

if test -r /usr/share/cachyos-fish-config/cachyos-config.fish
    source /usr/share/cachyos-fish-config/cachyos-config.fish
end

# overwrite greeting
# potentially disabling fastfetch
#function fish_greeting
#    # smth smth
#end
alias dotfiles='git --git-dir=$HOME/.dotfiles/ --work-tree=$HOME'

# Fish 4 no siempre vuelve a ejecutar esta función después de que el perfil de
# CachyOS instala sus bindings; aplicarla aquí hace efectivos Alt+1..Alt+9.
if status is-interactive
    fish_user_key_bindings
end
