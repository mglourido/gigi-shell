import { Gtk } from "ags/gtk4"

type PropiedadesBotonAjustes = {
  variante?: "secundario" | "principal"
  activo?: any
  cssClasses?: string[]
  children?: any
  [propiedad: string]: any
}

/** Botón compacto que conserva su altura y alineación dentro de las filas. */
export default function BotonAjustes({
  variante = "secundario",
  activo,
  cssClasses = [],
  children,
  ...propiedades
}: PropiedadesBotonAjustes) {
  const claseVariante = variante === "principal" ? "account-save-btn" : "account-secondary-btn"
  const clasesBase = [claseVariante, ...cssClasses]
  const clases = activo === undefined
    ? clasesBase
    : activo((estaActivo: boolean) => estaActivo ? [...clasesBase, "open"] : clasesBase)

  return (
    <button
      {...propiedades}
      cssClasses={clases}
      heightRequest={30}
      valign={Gtk.Align.START}
    >
      {children}
    </button>
  )
}
