// modulos/ajustes/energia/SuspensionFalsa.tsx — Ajustes > Energía > «Suspensión falsa».
//
// Los ajustes que se leen aquí son los `sf*` de `servicios/energia/powerState.ts` (se
// persisten con el resto del modo ahorro, en `~/.config/power-save/config.json`); quien los
// APLICA es `servicios/energia/suspensionFalsa.ts` con sus efectores. Esta pantalla no
// entra ni sale de la suspensión falsa: eso son el menú del logo, el menú de energía y el
// atajo de teclado. El porqué de cada ajuste está en `docs/suspension-falsa.md`.
//
// Tres cosas que esta UI tiene que DECIR, y no son adorno:
//
//  1. **Sin «bloquear al entrar» la única salida es el atajo de teclado.** Con la pantalla
//     apagada por nuestra mano, hypridle no emite `on-resume` (solo lo hace de un timeout
//     que disparó él) y las ventanas de AGS están ocultas: no hay UI donde apagarlo. El
//     bloqueo es la puerta de salida normal; sin él queda solo la red de seguridad. Un
//     usuario que apaga ese interruptor sin saberlo se queda encerrado.
//  2. **Silenciar el reloj nace en NO a propósito.** Es el ajuste más fácil de
//     malinterpretar y un despertador mudo es el peor fallo posible de esta función, así
//     que la ayuda dice la consecuencia en los dos sentidos.
//  3. **Un plazo que no va a saltar es peor que no ofrecerlo.** Con un «Mantener despierto»
//     vivo, el plazo de suspensión real se ignora — el Wake up promete que el equipo no se
//     suspende y ese contrato gana. Se avisa en cuanto las dos condiciones coinciden, sin
//     esperar a que el plazo venza en silencio.
//
// El perfil TLP es un SELECTOR de tres valores y no un interruptor, y no duplica al
// automático del modo ahorro: aquel responde a «¿y cuando la batería esté baja?» y este a
// «¿y mientras estoy fuera?». Su fila se oculta ENTERA sin `tlpAvailable` (sin `tlp`, sin el
// helper root o sin batería real, o sea en el sobremesa), igual que la tarjeta del selector
// manual — ofrecer un ajuste que no puede aplicarse es peor que no ofrecerlo.
//
// HAY DOS SELECTORES DE PERFIL Y NO SON EL MISMO. Debajo del de TLP va el de
// `power-profiles-daemon`, y cada uno se enseña donde su subsistema existe:
//
//   · TLP (`tlpAvailable`) gobierna periféricos, disco y radios, escribe /etc y necesita
//     root. En un sobremesa no aparece nunca — no hay batería.
//   · PPD (`ppdDisponible`) gobierna el EPP/gobernador de la CPU, habla por D-Bus y no
//     necesita nada instalado. Es el ÚNICO control de energía de CPU que la suspensión
//     falsa tiene en un sobremesa, y el que más vatios mueve (ver `perfilEnergia.ts`).
//
// En un portátil con los dos se ven las dos filas, que es correcto: son controles de cosas
// distintas y no se pisan. Por eso el título del de TLP dice «TLP» explícitamente.

import { createComputed } from "ags"
import { Gtk } from "ags/gtk4"
import { InlineEditableValue } from "../../../componentes/InlineEditableValue"
import { AjusteInterruptor, TarjetaAjustes, TextoInformativo, TituloAjuste } from "../componentes"
import Segmentado from "./Segmentado"
import AppsCongeladas from "./AppsCongeladas"
import textos from "../../../textos/ajustes/energia.json" with { type: "json" }
import { formatearTexto } from "../../../textos/formatear"
import {
  sfBloquear, setSfBloquear,
  sfNoMolestar, setSfNoMolestar,
  sfSilenciarNotificaciones, setSfSilenciarNotificaciones,
  sfSilenciarReloj, setSfSilenciarReloj,
  sfApagarLeds, setSfApagarLeds,
  sfPerfilTlp, setSfPerfilTlp,
  sfPerfilEnergia, setSfPerfilEnergia,
  sfMinutosSuspensionReal, setSfMinutosSuspensionReal,
  sfApagarBluetooth, setSfApagarBluetooth,
  sfSilenciarAudio, setSfSilenciarAudio,
  sfSustituirReal, setSfSustituirReal,
  type SfTlp,
  type SfPpd,
} from "../../../servicios/energia/powerState.ts"
import { tlpAvailable } from "../../../servicios/energia/tlp.ts"
import { ppdDisponible } from "../../../servicios/energia/suspensionFalsa/perfilEnergia"
import { mantenerDespiertoActivo } from "../../../servicios/energia/mantenerDespierto"
import {
  suspensionFalsaActiva, segundosParaSuspensionReal,
} from "../../../servicios/energia/suspensionFalsa"

/** Cuenta atrás legible. Por debajo del minuto se enseñan segundos: redondear a «0 min»
 *  parecería que el plazo está parado justo cuando está a punto de saltar. */
function textoRestante(segundos: number): string {
  return segundos >= 60
    ? formatearTexto(textos.suspensionFalsa.restanteMinutos, { minutos: Math.ceil(segundos / 60) })
    : formatearTexto(textos.suspensionFalsa.restanteSegundos, { segundos })
}

export default function SuspensionFalsa() {
  // El aviso del Wake up se calcula sobre el AJUSTE y el Wake up, no sobre
  // `plazoSuprimidoPorWakeUp` (que solo existe con la suspensión falsa ya puesta): aquí
  // interesa avisar ANTES, mientras el usuario configura el plazo con el Wake up encendido.
  const plazoNoSaltara = createComputed(() =>
    sfMinutosSuspensionReal() > 0 && mantenerDespiertoActivo() && !sfSustituirReal()
  )

  // El sustituto no POSPONE el plazo como hace el Wake up: lo deja sin sentido. «Suspensión
  // falsa 40 min y luego suspender de verdad» se contradice con «en este equipo la
  // suspensión real no se usa», y cumplirlo dejaría colgado justo el equipo cuyo dueño
  // encendió el ajuste para que eso no pasara. Así que el control se DESHABILITA y se dice
  // por qué, en vez de dejarlo editable fingiendo que hará algo.
  const plazoSustituido = createComputed(() => sfMinutosSuspensionReal() > 0 && sfSustituirReal())

  // Línea de estado. En la práctica se ve poco —durante la suspensión falsa las ventanas de
  // AGS están ocultas— pero sigue mereciendo la pena para el caso en que se vuelva con el
  // panel abierto: la alternativa es una sección que habla en futuro de algo que está
  // pasando ahora mismo.
  const estado = createComputed(() => {
    if (!suspensionFalsaActiva()) return ""
    const restante = segundosParaSuspensionReal()
    if (restante === null) {
      if (sfSustituirReal() && sfMinutosSuspensionReal() > 0) {
        return `${textos.suspensionFalsa.activa} ${textos.suspensionFalsa.plazo.sustituido}`
      }
      if (mantenerDespiertoActivo() && sfMinutosSuspensionReal() > 0) {
        return `${textos.suspensionFalsa.activa} ${textos.suspensionFalsa.suprimido}`
      }
      return `${textos.suspensionFalsa.activa} ${textos.suspensionFalsa.sinPlazo}`
    }
    return `${textos.suspensionFalsa.activa} ${textoRestante(restante)}`
  })

  return (
    <>
      <TarjetaAjustes titulo={textos.grupos.suspensionFalsa} icono="󰒲">
        <box orientation={Gtk.Orientation.VERTICAL} spacing={6} cssClasses={["dev-row"]} hexpand>
          <TextoInformativo label={textos.suspensionFalsa.descripcion} maxWidthChars={62} />
          <TextoInformativo label={textos.suspensionFalsa.entrada} maxWidthChars={62} />
          <TextoInformativo
            label={estado}
            cssClasses={["sp-field-value"]}
            visible={estado((t: string) => t !== "")}
            maxWidthChars={62}
          />
        </box>

        <AjusteInterruptor
          titulo={textos.suspensionFalsa.bloquear.titulo}
          informacion={textos.suspensionFalsa.bloquear.descripcion}
          activo={sfBloquear}
          alAlternar={() => setSfBloquear(!sfBloquear.get())}
        />
        {/* El aviso solo aparece con el bloqueo APAGADO: es entonces cuando la frase
            «la única salida es el atajo» describe la realidad. Enseñarlo siempre lo
            convertiría en ruido que nadie lee el día que importa. */}
        <box orientation={Gtk.Orientation.VERTICAL} spacing={4} cssClasses={["dev-row"]} hexpand>
          <TextoInformativo
            label={textos.suspensionFalsa.bloquear.aviso}
            cssClasses={["sp-field-hint-warn"]}
            visible={sfBloquear((v: boolean) => !v)}
            maxWidthChars={62}
          />
          <TextoInformativo label={textos.suspensionFalsa.atajo} maxWidthChars={62} />
        </box>

        <AjusteInterruptor
          titulo={textos.suspensionFalsa.noMolestar.titulo}
          informacion={textos.suspensionFalsa.noMolestar.descripcion}
          activo={sfNoMolestar}
          alAlternar={() => setSfNoMolestar(!sfNoMolestar.get())}
        />
        <AjusteInterruptor
          titulo={textos.suspensionFalsa.silenciarNotificaciones.titulo}
          informacion={textos.suspensionFalsa.silenciarNotificaciones.descripcion}
          activo={sfSilenciarNotificaciones}
          alAlternar={() => setSfSilenciarNotificaciones(!sfSilenciarNotificaciones.get())}
        />

        <AjusteInterruptor
          titulo={textos.suspensionFalsa.silenciarReloj.titulo}
          informacion={textos.suspensionFalsa.silenciarReloj.descripcion}
          activo={sfSilenciarReloj}
          alAlternar={() => setSfSilenciarReloj(!sfSilenciarReloj.get())}
        />
        {/* Y aquí el aviso va con el interruptor ENCENDIDO, al revés que el del bloqueo:
            el estado peligroso de este ajuste es el activo (alarma muda), no el apagado. */}
        <box cssClasses={["dev-row"]} visible={sfSilenciarReloj}>
          <TextoInformativo
            label={textos.suspensionFalsa.silenciarReloj.aviso}
            cssClasses={["sp-field-hint-warn"]}
            maxWidthChars={62}
          />
        </box>

        <AjusteInterruptor
          titulo={textos.suspensionFalsa.leds.titulo}
          informacion={textos.suspensionFalsa.leds.descripcion}
          activo={sfApagarLeds}
          alAlternar={() => setSfApagarLeds(!sfApagarLeds.get())}
        />
        <AjusteInterruptor
          titulo={textos.suspensionFalsa.bluetooth.titulo}
          informacion={textos.suspensionFalsa.bluetooth.descripcion}
          activo={sfApagarBluetooth}
          alAlternar={() => setSfApagarBluetooth(!sfApagarBluetooth.get())}
        />
        <AjusteInterruptor
          titulo={textos.suspensionFalsa.audio.titulo}
          informacion={textos.suspensionFalsa.audio.descripcion}
          activo={sfSilenciarAudio}
          alAlternar={() => setSfSilenciarAudio(!sfSilenciarAudio.get())}
        />

        {/* Perfil TLP: la fila entera desaparece sin soporte (sobremesa). `tlpAvailable` es
            una constante, no un accessor — se resuelve una vez al cargar el servicio.

            ⚠️ El ternario con `<></>` NO es un tic de estilo: `{cond && (<box/>)}` mete el
            BOOLEANO `false` en el árbol cuando la condición no se cumple, y el runtime de
            gnim acaba llamando a `getType(false)` → `gtkType in false` →
            «TypeError: right-hand side of 'in' should be an object, got boolean», que se
            lleva por delante la sección ENTERA de Ajustes (no solo esta fila). Un Fragment
            vacío no aporta ningún hijo y es lo que hay que devolver para no pintar nada. */}
        {tlpAvailable ? (
          <box orientation={Gtk.Orientation.VERTICAL} spacing={6} cssClasses={["dev-row"]} hexpand>
            <box spacing={8} valign={Gtk.Align.CENTER}>
              <TituloAjuste label={textos.suspensionFalsa.tlp.titulo} hexpand halign={Gtk.Align.START} />
              <Segmentado
                current={sfPerfilTlp}
                onSelect={(v) => setSfPerfilTlp(v as SfTlp)}
                options={[
                  { value: "no-tocar", label: textos.suspensionFalsa.tlp.noTocar },
                  { value: "ahorro", label: textos.suspensionFalsa.tlp.ahorro },
                  { value: "normal", label: textos.suspensionFalsa.tlp.normal },
                ]}
              />
            </box>
            <TextoInformativo label={textos.suspensionFalsa.tlp.descripcion} maxWidthChars={62} />
            <TextoInformativo label={textos.suspensionFalsa.tlp.distincion} maxWidthChars={62} />
          </box>
        ) : <></>}

        {/* Perfil de energía del sistema (power-profiles-daemon). Mismo patrón que el de
            TLP —incluido el ternario con `<></>`, por el `getType(false)` que documenta el
            comentario de arriba— pero con otra condición: aquí basta con que exista
            `powerprofilesctl`, sin helper root ni batería.

            «Rendimiento» NO se ofrece a propósito, aunque el demonio lo tenga: este selector
            existe para gastar MENOS con el equipo desatendido, y una opción que gasta más no
            tiene ningún caso de uso que ponerle debajo. */}
        {ppdDisponible ? (
          <box orientation={Gtk.Orientation.VERTICAL} spacing={6} cssClasses={["dev-row"]} hexpand>
            <box spacing={8} valign={Gtk.Align.CENTER}>
              <TituloAjuste label={textos.suspensionFalsa.ppd.titulo} hexpand halign={Gtk.Align.START} />
              <Segmentado
                current={sfPerfilEnergia}
                onSelect={(v) => setSfPerfilEnergia(v as SfPpd)}
                options={[
                  { value: "no-tocar", label: textos.suspensionFalsa.ppd.noTocar },
                  { value: "power-saver", label: textos.suspensionFalsa.ppd.ahorro },
                  { value: "balanced", label: textos.suspensionFalsa.ppd.equilibrado },
                ]}
              />
            </box>
            <TextoInformativo label={textos.suspensionFalsa.ppd.descripcion} maxWidthChars={62} />
            <TextoInformativo label={textos.suspensionFalsa.ppd.medido} maxWidthChars={62} />
          </box>
        ) : <></>}

        {/* El sustituto va JUNTO AL PLAZO y no arriba con los demás interruptores: son los
            dos ajustes de esta tarjeta que hablan de la suspensión REAL, y uno anula al
            otro. Separarlos dejaría al usuario encendiendo un plazo tres filas más abajo sin
            ver por qué no hace nada. */}
        <AjusteInterruptor
          titulo={textos.suspensionFalsa.sustituir.titulo}
          informacion={textos.suspensionFalsa.sustituir.descripcion}
          activo={sfSustituirReal}
          alAlternar={() => setSfSustituirReal(!sfSustituirReal.get())}
        />
        <TextoInformativo
          label={textos.suspensionFalsa.sustituir.aviso}
          cssClasses={["sp-field-hint-warn"]}
          visible={sfSustituirReal}
          maxWidthChars={62}
        />

        {/* Plazo de suspensión REAL: un solo control, con 0 = desactivado. No lleva
            interruptor aparte a propósito — dos mandos para un valor y su ausencia se
            contradicen en cuanto uno de los dos se queda a medias (¿minutos guardados con
            el interruptor apagado: desactivado, o pendiente?). */}
        <box orientation={Gtk.Orientation.VERTICAL} spacing={6} cssClasses={["dev-row"]} hexpand>
          <box spacing={8} valign={Gtk.Align.CENTER} sensitive={sfSustituirReal((v: boolean) => !v)}>
            <TituloAjuste label={textos.suspensionFalsa.plazo.titulo} hexpand halign={Gtk.Align.START} />
            <InlineEditableValue
              display={sfMinutosSuspensionReal((v: number) => v > 0
                ? formatearTexto(textos.suspensionFalsa.plazo.valor, { minutos: v })
                : textos.suspensionFalsa.plazo.desactivado)}
              getValue={() => sfMinutosSuspensionReal.get()}
              onCommit={setSfMinutosSuspensionReal}
              min={0} max={1440}
              maxLength={4}
              widthRequest={72}
              labelClass="sp-field-value"
              tooltip={textos.suspensionFalsa.plazo.tooltip}
            />
          </box>
          <TextoInformativo label={textos.suspensionFalsa.plazo.descripcion} maxWidthChars={62} />
          <TextoInformativo
            label={textos.suspensionFalsa.suprimido}
            cssClasses={["sp-field-hint-warn"]}
            visible={plazoNoSaltara}
            maxWidthChars={62}
          />
          <TextoInformativo
            label={textos.suspensionFalsa.plazo.sustituido}
            cssClasses={["sp-field-hint-warn"]}
            visible={plazoSustituido}
            maxWidthChars={62}
          />
        </box>
      </TarjetaAjustes>

      <AppsCongeladas />
    </>
  )
}
