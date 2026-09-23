import { Gtk } from "ags/gtk4"
import { onCleanup, type Accessor } from "ags"

/** Entrada numérica reactiva que valida y acota el valor al confirmar o perder el foco. */
export default function CampoNumerico({
  valor,
  minimo,
  maximo,
  caracteres = 2,
  relleno = 2,
  alConfirmar,
}: {
  valor: Accessor<number>
  minimo: number
  maximo: number
  caracteres?: number
  relleno?: number
  alConfirmar: (valor: number) => void
}) {
  let entrada: Gtk.Entry
  const representar = (numero: number) => String(numero).padStart(relleno, "0")
  const confirmar = () => {
    if (!entrada) return
    const numeroLeido = parseInt(entrada.get_text().trim(), 10)
    const numero = Number.isNaN(numeroLeido)
      ? minimo
      : Math.max(minimo, Math.min(maximo, numeroLeido))
    entrada.set_text(representar(numero))
    alConfirmar(numero)
  }

  return (
    <entry
      cssClasses={["sp-num-input"]}
      maxLength={caracteres}
      widthChars={caracteres}
      xalign={0.5}
      $={(self: Gtk.Entry) => {
        entrada = self
        self.set_text(representar(valor.get()))
        onCleanup(valor.subscribe(() => {
          if (!self.has_focus) self.set_text(representar(valor.get()))
        }))
      }}
      onActivate={confirmar}
    >
      <Gtk.EventControllerFocus onLeave={confirmar} />
    </entry>
  )
}
