-- gigios/reglas.lua — reglas de ventana y de capa.
--
-- Los nombres de campo vienen verificados contra los stubs
-- (/usr/share/hypr/stubs/hl.meta.lua: HL.LayerRuleSpec) y la documentación de
-- la API Lua; el ejemplo oficial /usr/share/hypr/hyprland.lua confirma
-- suppress_event / no_focus / float / move. Una regla con un campo mal escrito
-- NO da error: simplemente no casa — de ahí tanta verificación.
--
-- Los regex con backslash van en [[...]]: en un string con comillas, Lua
-- rechaza escapes desconocidos como `\.` en tiempo de compilación.

-- Tearing en juegos (requiere general.allow_tearing = true, en gaming.lua).
-- Ajusta el match a tus juegos; steam_app_* cubre casi todo lo de Steam.
hl.window_rule({
    name  = "tearing-games",
    match = { class = [[^(steam_app_.*|gamescope|.*\.exe)$]] },
    immediate = true,
})

-- Firefox & Kitty: opacidad forzada a 1.0 (activa e inactiva).
hl.window_rule({
    name  = "firefox-opacity",
    match = { class = "firefox" },
    opacity = "1.0 override 1.0 override",
})

hl.window_rule({
    name  = "kitty-opacity",
    match = { class = "kitty" },
    opacity = "1.0 override 1.0 override",
})

-- Calculadora
hl.window_rule({
    name  = "qalculate",
    match = { class = "qalculate-gtk" },
    float = true,
})

-- Selector de archivos del portal (Abrir/Guardar de navegadores y apps GTK).
-- Nace tiled y por tanto reordena el tiling del workspace entero para un
-- diálogo que cierras en dos segundos. Clase verificada en el socket de
-- eventos: `openwindow>>…,xdg-desktop-portal-gtk,…`.
--
-- OJO: aquí NO vale un `size = "60% 60%"`. Bajo Lua, size/move
-- van al motor de expresiones (muParser: Window.cpp calculateSingleExpr), que
-- NO tiene operador `%`: la expresión falla y el tamaño simplemente no se
-- aplica, sin error en el log (medido en anidada: la ventana quedaba con su
-- tamaño propio). El equivalente es multiplicar las variables monitor_w/h.
hl.window_rule({
    name  = "portal-file-chooser",
    match = { class = "xdg-desktop-portal-gtk" },
    float  = true,
    size   = "monitor_w*0.6 monitor_h*0.6",
    center = true,
})

-- --- Utilidades de sistema: ventanas de usar y tirar ---
-- Abres el control de volumen, tocas un slider y cierras. Naciendo tiled te
-- reordenan el workspace entero para eso. Clases verificadas lanzando cada app
-- y leyendo `initialClass` de hyprctl clients, no supuestas: varias NO
-- coinciden con el nombre del binario (pavucontrol -> org.pulseaudio.pavucontrol,
-- gnome-disks -> org.gnome.DiskUtility), y adivinarlas deja reglas que no disparan.

hl.window_rule({
    name  = "pavucontrol",
    match = { class = "org.pulseaudio.pavucontrol" },
    float  = true,
    center = true,
})

hl.window_rule({
    name  = "blueman",
    match = { class = "blueman-manager" },
    float  = true,
    center = true,
})

hl.window_rule({
    name  = "nm-connection-editor",
    match = { class = "nm-connection-editor" },
    float  = true,
    center = true,
})

hl.window_rule({
    name  = "gnome-disks",
    match = { class = "org.gnome.DiskUtility" },
    float  = true,
    center = true,
})

-- Vista previa de la cámara ("Probar cámara" en Ajustes / Quick Settings). Es un
-- `mpv` lanzado por `ags/servicios/camara/vistaPrevia.ts` con una clase propia,
-- justo para NO atrapar el mpv con el que el usuario esté viendo una película:
-- la clase la fija ese fichero en `CLASE_VISTA_PREVIA` y las dos deben coincidir
-- literalmente — si se cambia allí y no aquí, la regla no falla, simplemente
-- deja de casar y la vista previa nace tiled reordenando el escritorio entero.
--
-- UNA SOLA REGLA, y la clase propia está MEDIDA, no supuesta. `--x11-name` solo
-- fija la clase bajo XWayland; en una sesión Wayland nativa —la nuestra— mpv se
-- anuncia con el `app_id` de `--wayland-app-id`, que por defecto es "mpv" a
-- secas. `servicios/camara/vistaPrevia.ts` pasa las DOS opciones, y con la
-- ventana abierta `hyprctl clients` devuelve `class: gigios-camara-preview`, así
-- que esta regla casa por sí sola. Se descartó una segunda de reserva por
-- título (`class ^mpv$` + "vista previa"): sin nada que hacer, y capaz de sacar
-- flotante a 640x480 una película que el usuario tuviera abierta con ese texto
-- en el nombre del archivo.
--
-- 640x480 es el tamaño típico de una webcam y evita la interpolación; `center`
-- la deja donde se está mirando. Sin `size` mpv la abriría al tamaño del stream
-- y una cámara 1080p ocuparía media pantalla para encuadrarse la cara.
hl.window_rule({
    name  = "camara-vista-previa",
    match = { class = "gigios-camara-preview" },
    float  = true,
    center = true,
    size   = "640 480",
})

-- Diálogo de extracción de Dolphin (KIO). Título fijo "Extraer — Dolphin", sin
-- el nombre del archivo, así que el match por título no varía entre usos.
-- Solo class hubiera flotado también la ventana principal de Dolphin.
hl.window_rule({
    name  = "dolphin-extraer",
    match = { class = "org.kde.dolphin", title = "^Extraer" },
    float  = true,
    center = true,
})

-- Ventanas secundarias de Steam (lista de amigos, chats — el título de un
-- chat es el nombre del amigo, distinto cada vez, así que no se puede fijar
-- uno por uno): todo lo que sea class=steam salvo la ventana principal
-- ("Steam" a secas) nace flotante.
--
-- Deliberadamente SIN `size`: Steam pide su propia geometría por ventana (la
-- que usa fuera de Hyprland) y la regla, al aplicarse en el map, deja que la
-- conserve. Cuidado con el falso negativo que llevó aquí: flotar a mano una
-- ventana YA mapeada tiled (hl.dsp.window.float sobre una existente) le deja
-- la geometría del tiling, que en este monitor es casi media pantalla — se ve
-- como si la regla forzara "tamaño máximo" cuando en realidad no había regla
-- actuando. Hay que juzgar la regla con una ventana recién abierta.
--
-- `persistent_size` guarda el tamaño al que TÚ la dejes y lo restaura en la
-- siguiente apertura, que es lo que hace Steam por su cuenta en otros WMs.
hl.window_rule({
    name  = "steam-ventanas-secundarias",
    match = { class = "steam" },
    float  = true,
    center = true,
    persistent_size = true,
})

-- La regla anterior también atraparía la ventana principal de Steam; esta
-- va después y la vuelve a fijar tiled (las reglas se aplican en orden y la
-- última que casa gana para cada propiedad).
hl.window_rule({
    name  = "steam-principal-tiled",
    match = { class = "steam", title = "^Steam$" },
    float = false,
})

-- Picture-in-Picture de Firefox: flotante y SIEMPRE encima, que es su razón de
-- ser (la ves mientras haces otra cosa). `pin` la mantiene además al cambiar de
-- workspace. Ojo: título sin verificar aquí — si Firefox lo traduce en tu
-- idioma, esta regla no dispara y hay que ajustar el match.
hl.window_rule({
    name  = "firefox-pip",
    match = { class = "firefox", title = "Picture-in-Picture" },
    float = true,
    pin   = true,
})

-- Panel de wifi
hl.window_rule({
    name  = "wifi-panel",
    match = { class = "wifi-panel" },
    float = true,
    move  = "1540 44",
    size  = "340 600",
    pin   = true,
})

hl.layer_rule({
    name  = "waybar-layer",
    match = { namespace = "waybar" },
    blur  = true,
})

hl.layer_rule({
    name  = "orion-acrilico",
    match = { namespace = "orion" },
    blur  = true,
    ignore_alpha = 0.1,
})

hl.layer_rule({
    name  = "quick-settings-acrilico",
    match = { namespace = "quick-settings" },
    blur  = true,
    ignore_alpha = 0.1,
})

hl.layer_rule({
    name  = "notificaciones-acrilico",
    match = { namespace = "notification-panel" },
    blur  = true,
    ignore_alpha = 0.1,
})

hl.layer_rule({
    name  = "calendario-acrilico",
    match = { namespace = "calendar-panel" },
    blur  = true,
    ignore_alpha = 0.1,
})

-- La pila de popups es UNA sola superficie que crece al apilar avisos, y
-- Hyprland anima ese cambio de tamaño: mientras dura, el buffer nuevo (más
-- alto) se escala dentro de la caja que aún está creciendo, así que los popups
-- que YA estaban en pantalla se encogen y vuelven — se ve como un pestañeo en
-- el que desaparecen y se vuelven a dibujar. Medido con grim: con la animación
-- activa el rectángulo del popup de arriba cambia durante ~150 ms al llegar el
-- siguiente; sin ella es constante bit a bit. No se anima nada que el usuario
-- quiera ver: la entrada y la salida de cada aviso las hace GTK con sus
-- keyframes (notif-slide-in / notif-slide-out en estilos/style.scss), no el
-- compositor.
hl.layer_rule({
    name  = "notificaciones-popup-sin-anim",
    match = { namespace = "notification-popups" },
    animation = "none",
    -- La misma pila de AGS se ve sobre hyprlock, con título y cuerpo completos.
    -- El valor 1 solo permite verla: los clics, botones y acciones del popup
    -- no deben funcionar sin desbloquear.
    above_lock = 1,
})

hl.layer_rule({
    name  = "osd-acrilico",
    match = { namespace = "osd" },
    blur  = true,
    ignore_alpha = 0.1,
})

-- Ref https://wiki.hypr.land/Configuring/Workspace-Rules/
-- "Smart gaps" / "No gaps when only" — descomenta todo si lo quieres usar.
-- hl.workspace_rule({ workspace = "w[tv1]", gaps_out = 0, gaps_in = 0 })
-- hl.workspace_rule({ workspace = "f[1]",   gaps_out = 0, gaps_in = 0 })
-- hl.window_rule({
--     name  = "no-gaps-wtv1",
--     match = { float = false, workspace = "w[tv1]" },
--     border_size = 0,
--     rounding    = 0,
-- })
-- hl.window_rule({
--     name  = "no-gaps-f1",
--     match = { float = false, workspace = "f[1]" },
--     border_size = 0,
--     rounding    = 0,
-- })

--------------------------------
---- WINDOWS AND WORKSPACES ----
--------------------------------

-- See https://wiki.hypr.land/Configuring/Window-Rules/ for more
-- See https://wiki.hypr.land/Configuring/Workspace-Rules/ for workspace rules

hl.window_rule({
    -- Ignore maximize requests from all apps. You'll probably like this.
    name  = "suppress-maximize-events",
    match = { class = ".*" },
    suppress_event = "maximize",
})

hl.window_rule({
    -- Fix some dragging issues with XWayland
    name  = "fix-xwayland-drags",
    match = {
        class      = "^$",
        title      = "^$",
        xwayland   = true,
        float      = true,
        fullscreen = false,
        pin        = false,
    },
    no_focus = true,
})

-- Hyprland-run windowrule
hl.window_rule({
    name  = "move-hyprland-run",
    match = { class = "hyprland-run" },
    move  = "20 monitor_h-120",
    float = true,
})
