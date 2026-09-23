// Registro de secciones montables por `NavSections.tsx`. Una `SectionId` sin
// entrada aquí (p. ej. una sección aún no implementada) no rompe nada: solo
// no tiene widget que mostrar cuando el índice navega a ella.
import { SectionId } from "../../state"
import { HomeSection } from "./HomeSection"
import { AppsSection } from "./AppsSection"
import { KeybindsSection } from "./KeybindsSection"
import { ReactiveSection } from "./ReactiveSection"
import { RiceSection } from "./RiceSection"
import type { NavegacionBusqueda } from "../shared/NavegacionBusqueda"

type FabricaSeccion = (navegacion: NavegacionBusqueda) => any

export const SECTION_COMPONENTS: Partial<Record<SectionId, FabricaSeccion>> = {
  inicio:   HomeSection,
  apps:     AppsSection,
  keybinds: KeybindsSection,
  reactivo: ReactiveSection,
  rice:     RiceSection,
}
