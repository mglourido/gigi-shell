import { Gtk } from "ags/gtk4"
import {
  AjusteInterruptor,
  ListaClasesVentana,
  TarjetaAjustes,
  TextoInformativo,
  TituloSeccion,
} from "../componentes"
import { allowTearing, applyAllowTearing } from "../../../servicios/pantalla/service"
import {
  addPausaLuzNocturnaApp,
  escanerJuegos,
  gamingFreezeEnabled,
  pausaLuzNocturnaApps,
  pausaLuzNocturnaJuegos,
  removePausaLuzNocturnaApp,
  setEscanerJuegos,
  setGamingFreezeEnabled,
  setPausaLuzNocturnaJuegos,
} from "../preferences"
import textos from "../../../textos/ajustes/juegos.json" with { type: "json" }

/** Preferencias generales que cambian el comportamiento del sistema al jugar. */
export default function SeccionJuegos() {
  return (
    <box orientation={Gtk.Orientation.VERTICAL} spacing={14} cssClasses={["sp-section", "dev-section"]} hexpand>
      <TituloSeccion titulo={textos.seccion.titulo} />
      <TarjetaAjustes titulo={textos.grupos.deteccion} icono="󰺵">
        <AjusteInterruptor
          titulo={textos.deteccion.titulo}
          informacion={textos.deteccion.descripcion}
          activo={escanerJuegos}
          alAlternar={() => setEscanerJuegos(!escanerJuegos.get())}
        />
      </TarjetaAjustes>
      <TarjetaAjustes titulo={textos.grupos.graficosLatencia} icono="󰹑">
        <AjusteInterruptor
          titulo={textos.tearing.titulo}
          informacion={textos.tearing.descripcion}
          activo={allowTearing}
          alAlternar={() => applyAllowTearing(!allowTearing.get())}
        />
      </TarjetaAjustes>
      {/* Sin escáner no hay "estás jugando" que detectar, así que congelar tareas al
          jugar no puede dispararse nunca: la tarjeta se retira en vez de dejar un
          interruptor que no hace nada. El de tearing sí se queda — es una opción del
          compositor y no depende de que se reconozca la ventana. */}
      <TarjetaAjustes titulo={textos.grupos.rendimiento} icono="󰊴" visible={escanerJuegos}>
        <AjusteInterruptor
          titulo={textos.congelarTareas.titulo}
          informacion={textos.congelarTareas.descripcion}
          activo={gamingFreezeEnabled}
          alAlternar={() => setGamingFreezeEnabled(!gamingFreezeEnabled.get())}
        />
      </TarjetaAjustes>
      {/* Esta tarjeta NO se retira sin escáner, al contrario que la de congelar tareas, y
          su interruptor tampoco: la mitad manual compara clase contra clase y sigue
          funcionando con la detección apagada, así que el ajuste no queda sordo — solo se
          queda sin su mitad automática, y eso se dice en vez de esconderlo. El ajuste vive
          aquí y no en Pantalla porque es una de las cosas que cambian "al jugar"; el
          efecto se ve además en el resumen del horario de Ajustes > Pantallas. */}
      <TarjetaAjustes titulo={textos.grupos.pantalla} icono="󰃝">
        <AjusteInterruptor
          titulo={textos.pausaLuzNocturna.titulo}
          informacion={textos.pausaLuzNocturna.descripcion}
          activo={pausaLuzNocturnaJuegos}
          alAlternar={() => setPausaLuzNocturnaJuegos(!pausaLuzNocturnaJuegos.get())}
        />
        <TextoInformativo
          label={textos.pausaLuzNocturna.sinDeteccion}
          halign={Gtk.Align.START}
          wrap
          maxWidthChars={62}
          xalign={0}
          visible={escanerJuegos((activo: boolean) => !activo)}
        />
        <ListaClasesVentana
          clases={pausaLuzNocturnaApps}
          alAnadir={addPausaLuzNocturnaApp}
          alQuitar={removePausaLuzNocturnaApp}
          visible={pausaLuzNocturnaJuegos((activo: boolean) => activo)}
          textos={{
            titulo: textos.pausaLuzNocturna.lista.titulo,
            ayuda: textos.pausaLuzNocturna.lista.ayuda,
            vacia: textos.pausaLuzNocturna.lista.vacia,
            placeholder: textos.pausaLuzNocturna.lista.placeholder,
            anadir: textos.pausaLuzNocturna.lista.anadir,
            quitar: textos.pausaLuzNocturna.lista.quitar,
            ventana: textos.pausaLuzNocturna.lista.ventana,
            anadirVentana: textos.pausaLuzNocturna.lista.anadirVentana,
          }}
        />
      </TarjetaAjustes>
    </box>
  )
}
