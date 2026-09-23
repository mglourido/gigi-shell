// Indicador del MODO GESTOS: mientras el escritorio se maneja con la mano,
// aparece un icono en la pastilla del sistema, al lado del de cámara.
//
// ── POR QUÉ NO ES ROJO NI PULSA, Y POR QUÉ NO SOBRA JUNTO AL DE CÁMARA ───────
// Con el modo encendido se ven DOS iconos, porque son dos hechos distintos y el
// usuario necesita los dos:
//
//   󰄀 (rojo, pulsante)  algo está mirando por la cámara  → aviso de PRIVACIDAD
//   󱄄 (violeta, fijo)   el escritorio obedece a tus manos → aviso de MODO
//
// Fundirlos en uno los estropea en los dos sentidos: un icono de modo que pulsa
// en rojo alarma sin motivo cada vez que se usa una función normal del
// escritorio, y un icono de privacidad que deja de aparecer porque "ya lo dice
// el de gestos" mentiría en cuanto una videollamada abriera la cámara sin
// gestos. El de privacidad lo pone `Camara.tsx` y no se toca desde aquí.
//
// El icono se ILUMINA cuando hay una mano en el cuadro. Es la única realimentación
// que existe de que el modo te está viendo: sin ella, "no me hace caso" y "no me
// ve" son indistinguibles, que es el problema número uno de cualquier control por
// cámara.
//
// ── Y CAMBIA DE GLIFO EN LA ESPERA, QUE ES CUANDO MÁS FALTA HACE ────────────
// Con el modo pausado por gesto (abrir y cerrar la mano dos veces) NADA responde,
// y eso es exactamente igual que si se hubiera roto. El icono pasa a 󱐵 («sensor
// de movimiento apagado») y se apaga de color; el tooltip dice cómo volver. Sin
// esa señal, el gesto de pausa sería una función que solo se nota cuando falla.
//
// ── ES UNA CAJA, NO UN BOTÓN, Y NO ES UN DESCUIDO ───────────────────────────
// Lo natural sería que un clic apagara el modo. No puede: toda la pastilla del
// sistema ES YA un `<button>` (el que abre quick settings) y GTK4 no admite un
// botón dentro de otro. El apagado con el ratón vive en el interruptor de
// Ajustes > Cámara > Gestos; con el teclado, en SUPER+SHIFT+G. Es exactamente el mismo
// trato que tienen aquí el micrófono, la cámara y la captura de pantalla.
import { createComputed, createState } from "ags"
import { Gtk } from "ags/gtk4"
import { crearCicloVida } from "../../../../utilidades/cicloVida"
import { descripcionGestos, gestos } from "../../../../servicios/gestos/estado"
import { tituloBarra } from "../../componentes/tituloBarra"

/** Glifos del indicador: normal y en espera. */
const ICONO = "󱄄"
const ICONO_ESPERA = "󱐵"

export default function Gestos() {
  const cicloVida = crearCicloVida()

  // Mismo patrón que `Camara.tsx`: estado propio alimentado por UNA suscripción
  // dada de baja al desmontar. Este widget lo monta y lo DESMONTA
  // `RanuraCondicionalBarra` en cada encendido del modo, así que una suscripción
  // sin baja se acumularía una por uso, no una por sesión.
  const [descripcion, setDescripcion] = createState(descripcionGestos(gestos.get()))
  const [viendo, setViendo] = createState(gestos.get().mano)
  const [enEspera, setEnEspera] = createState(gestos.get().estado === "espera")
  // Los valores iniciales se siembran a mano arriba: `subscribe` no dispara al
  // registrarse, y el widget nace justo cuando el modo se enciende.
  cicloVida.suscribir(gestos, (g) => {
    setDescripcion(descripcionGestos(g))
    // En espera el icono no se ilumina aunque el modelo siga viendo la mano:
    // ahí «te veo» sería engañoso, porque verte no lleva a hacer nada.
    setViendo(g.mano && g.estado !== "espera")
    setEnEspera(g.estado === "espera")
  })

  return (
    <box
      valign={Gtk.Align.CENTER}
      $={(self: Gtk.Widget) => tituloBarra(self, descripcion)}
      cssClasses={["gestos-indicador"]}
    >
      <label
        cssClasses={createComputed([viendo, enEspera], (v, espera) => {
          const clases = ["icon", "gestos-icono"]
          if (espera) clases.push("en-espera")
          else if (v) clases.push("viendo")
          return clases
        })}
        label={enEspera((e) => (e ? ICONO_ESPERA : ICONO))}
      />
    </box>
  )
}
