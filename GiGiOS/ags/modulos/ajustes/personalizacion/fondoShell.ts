/** Temas disponibles para las superficies principales del shell. */
export const FONDOS_SHELL = ["negro", "grafito", "gris"] as const

export type FondoShell = typeof FONDOS_SHELL[number]

export const FONDO_SHELL_PREDETERMINADO: FondoShell = "negro"

/** Evita que un preferences.json antiguo o editado cargue una clase inexistente. */
export function normalizarFondoShell(valor: unknown): FondoShell {
  return FONDOS_SHELL.includes(valor as FondoShell)
    ? valor as FondoShell
    : FONDO_SHELL_PREDETERMINADO
}
