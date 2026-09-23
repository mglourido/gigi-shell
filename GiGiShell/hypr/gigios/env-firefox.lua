-- Variables portables para Firefox + Wayland (sin forzar driver de GPU).

-- Forzar modo Wayland nativo en Firefox (desde v121 es el default,
-- pero conviene fijarlo explícitamente).
hl.env("MOZ_ENABLE_WAYLAND", "1")

-- Usar EGL sobre Wayland.
hl.env("EGL_PLATFORM", "wayland")

-- No se fuerza LIBVA_DRIVER_NAME ni se desactiva el sandbox RDD. Si la máquina
-- usa NVIDIA como GPU principal, esos ajustes pertenecen al perfil específico
-- (gigios/gpu/).
