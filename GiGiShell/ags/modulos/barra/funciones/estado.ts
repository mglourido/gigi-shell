import { createState } from "ags"

// Estado por sesión de las funciones de la barra. Este módulo no conoce GTK ni
// componentes; el registro que compone la interfaz vive en registro.ts.
export const [cpuRamHabilitado, fijarCpuRamHabilitado] = createState(false)
