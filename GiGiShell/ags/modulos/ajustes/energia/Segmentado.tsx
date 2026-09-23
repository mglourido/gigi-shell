// modulos/ajustes/energia/Segmentado.tsx
// Grupo de botones excluyentes (dl-seg) de la sección de Energía. Vivía dentro de
// `SeccionEnergia.tsx`, y salió de allí al llegar la suspensión falsa: su perfil TLP es
// otro selector de la misma familia y, dejándolo donde estaba, el único camino para
// reutilizarlo era que `SuspensionFalsa.tsx` importara de `SeccionEnergia.tsx` — que a su
// vez lo importa a él. Un ciclo de módulos aquí no da error al arrancar (las funciones se
// izan), pero deja una bomba de relojería para el día que alguno de los dos ejecute algo
// en el cuerpo del módulo. Duplicar el componente tampoco valía: son el MISMO control y
// tienen que verse igual.
//
// No lleva estado propio a propósito: `current` es un accessor y el llamante decide qué
// hace `onSelect`. Sirve igual para dos opciones (el perfil TLP manual, el modo de brillo)
// que para tres (el perfil TLP de la suspensión falsa).
import { Gtk } from "ags/gtk4"

export default function Segmentado({ options, current, onSelect, disabled }: {
  options: { value: string, label: string }[]
  current: any
  onSelect: (v: string) => void
  disabled?: any
}) {
  return (
    <box cssClasses={["dl-seg"]} valign={Gtk.Align.CENTER}>
      {options.map((o) => (
        <button
          sensitive={disabled ? disabled((d: boolean) => !d) : true}
          cssClasses={current((c: string) => c === o.value ? ["dl-seg-btn", "active"] : ["dl-seg-btn"])}
          onClicked={() => onSelect(o.value)}
        ><label label={o.label} /></button>
      ))}
    </box>
  )
}
