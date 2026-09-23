// Sección "Inicio" de Orion: favoritos arrastrables + franja de métricas.
// Las dos mitades no comparten estado y viven en `home/`:
//   - `home/favoritosFlow.tsx`     — rejilla de apps favoritas (orden por drag)
//   - `home/estadisticasSistema.tsx` — CPU/RAM/GPU, montada aparte por Orion.tsx
//     (fuera del viewport desplazable, ver NavSections.tsx / Orion.tsx).
export { HomeSection } from "./home/favoritosFlow"
export { SystemStats, ALTURA_FRANJA_SISTEMA } from "./home/estadisticasSistema"
