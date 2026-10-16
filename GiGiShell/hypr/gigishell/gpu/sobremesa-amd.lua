-- GPU de sobremesa AMD Radeon (incluidas RX 9070 / RDNA 4).
-- Elegido por ~/.config/gigishell/gpu-perfil; ver docs/SETUP.md §9.
--
-- amdgpu gestiona la tarjeta en el kernel; Mesa aporta radeonsi (OpenGL y
-- VA-API) y RADV (Vulkan). libva ya asocia amdgpu con radeonsi: no hace falta
-- forzar LIBVA_DRIVER_NAME, GBM_BACKEND ni __GLX_VENDOR_LIBRARY_NAME.
-- Tampoco se fija AQ_DRM_DEVICES: aquamarine elige la GPU con la pantalla,
-- evitando depender de cardN o de rutas PCI con ':' (ver sobremesa-nvidia.lua).
--
-- Se conservan las optimizaciones predeterminadas de Mesa. No se añaden flags
-- RADV_PERFTEST, límites de FPS, frecuencias ni desactivación de V-Sync global:
-- dependen del juego y del monitor, no de que la tarjeta sea Radeon.
--
-- Al cambiar desde NVIDIA hay que volver a iniciar sesión: quitar sus hl.env
-- del config no retira las variables del compositor ni de las apps ya abiertas.
-- Fuentes:
-- https://docs.mesa3d.org/drivers/radv.html
-- https://github.com/intel/libva/blob/master/va/drm/va_drm_utils.c
-- https://wiki.hypr.land/Configuring/Basics/Variables/#cursor

hl.config({
  cursor = {
    -- amdgpu admite el cursor por hardware: evita recomponer por mover el ratón.
    no_hardware_cursors = false,
  },
})
