-- ============================================================
--  GPU — SOBREMESA  (NVIDIA única, sin iGPU al mando)
--  Elegido por ~/.config/gigios/gpu-perfil (ver gigios/gpu.lua).
--
--  Aquí el compositor renderiza y escanea por la NVIDIA directamente.
--  Ver: https://wiki.hypr.land/Nvidia/
-- ============================================================

-- Backend GBM/GLX sobre NVIDIA (necesario cuando NVIDIA es la GPU principal)
hl.env("GBM_BACKEND", "nvidia-drm")
hl.env("__GLX_VENDOR_LIBRARY_NAME", "nvidia") -- desactívalo si falla el screensharing

-- Aceleración de vídeo por hardware (VA-API) con la NVIDIA.
-- Requiere el paquete 'libva-nvidia-driver'.
hl.env("LIBVA_DRIVER_NAME", "nvidia")
hl.env("NVD_BACKEND", "direct")

-- Optimización de hilos del driver NVIDIA
hl.env("__GL_THREADED_OPTIMIZATIONS", "1")

hl.config({
  cursor = {
    -- CURSORES POR HARDWARE ACTIVADOS (false = "no los desactives").
    --
    -- Aquí estuvo `true` heredado de la época de los drivers anteriores al 555,
    -- cuando los HW cursors sobre NVIDIA daban tirones. Con el 610 y explicit
    -- sync eso ya no aplica, y forzar el cursor por software tiene un coste que
    -- SÍ se nota: se recompone en cada frame, y el resultado eran tirones
    -- intermitentes del ratón — justo lo que la opción pretendía evitar.
    -- Medido en esta máquina (RTX 3060, driver 610.57.04, Hyprland 0.56.2).
    --
    -- No hace falta `use_cpu_buffer`: queda en auto (int 2) y los HW cursors
    -- funcionan igual. No se pone lo que no se necesita.
    no_hardware_cursors = false,
  },
})

-- Si tuvieras VARIAS tarjetas también en el sobremesa, aquí fijarías la primaria.
-- Por defecto NO se fija: aquamarine ya elige la GPU que maneja la pantalla, y
-- cualquier valor mal puesto deja a Hyprland sin GPU -> ABORTA al arrancar
-- (SIGABRT en initServer) y te devuelve a SDDM.
--
-- Si aun así necesitas fijarla, DOS trampas:
--   1. La lista se separa por DOS PUNTOS, y una ruta by-path lleva ':' dentro
--      (pci-0000:01:00.0-card): aquamarine la parte en dispositivos inventados,
--      no encuentra ninguna GPU y Hyprland aborta. NUNCA uses by-path aquí.
--   2. /dev/dri/cardN sí vale, pero la numeración puede bailar entre reinicios,
--      así que comprueba cuál es la tuya: ls -l /dev/dri/by-path/
-- hl.env("AQ_DRM_DEVICES", "/dev/dri/card1")
