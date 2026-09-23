import { With } from "ags"
import type { FuncionBarra } from "./registro"

export default function ChipEstadoFuncion({
  funcion,
  activa,
}: {
  funcion: FuncionBarra
  activa: boolean
}) {
  if (!funcion.estado) return <label label={activa ? "ON" : "OFF"} />
  return <With value={funcion.estado}>{(texto: string) => <label label={texto} />}</With>
}
