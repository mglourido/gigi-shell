-- Gaming: ajustes de rendimiento (válidos en AMBAS máquinas).

hl.config({
  render = {
    -- Deja que un juego a pantalla completa se salte el compositor
    -- (menos latencia y overhead).  1 = auto, 2 = siempre.
    direct_scanout = 1,
  },

  general = {
    -- Habilita "tearing" (imagen sin V-Sync) para los juegos que lo pidan.
    -- Solo surte efecto en ventanas con la regla 'immediate = true'
    -- (ver la windowrule 'tearing-games' en reglas.lua).
    allow_tearing = true,
  },
})

-- Nota VRR: el panel de la laptop (BOE 60Hz) NO soporta VRR/G-Sync, así que
-- 'misc:vrr' se deja apagado. Si el monitor del sobremesa SÍ lo soporta,
-- puedes añadir aquí:  hl.config({ misc = { vrr = 1 } })  (1 = solo en
-- fullscreen, 2 = siempre)
