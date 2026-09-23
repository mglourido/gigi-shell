// Lógica pura de cuándo debe salir una mascota de la barra: "no hay nada que
// tapar". Se cumple con cualquiera de las dos condiciones —no hace falta que
// coincidan a la vez—, porque un escritorio con ventanas pero sin ninguna
// enfocada (p. ej. tras cerrar la que tenía el foco) es tan "vacío" a efectos
// visuales como uno sin clientes.
export function debeMostrarMascota(clientesEnWorkspaceActivo: number, hayClienteEnfocado: boolean): boolean {
  return clientesEnWorkspaceActivo <= 0 || !hayClienteEnfocado
}
