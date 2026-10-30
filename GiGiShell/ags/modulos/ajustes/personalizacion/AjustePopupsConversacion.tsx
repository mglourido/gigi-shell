// modulos/ajustes/personalizacion/AjustePopupsConversacion.tsx
// Bloque de Notificaciones > General: apps cuyo popup de una misma conversación se sustituye por
// el último mensaje. Quien lo aplica es modulos/notificaciones/popup/pila.ts.
import { ListaClasesVentana } from "../componentes"
import textos from "../../../textos/ajustes/personalizacion.json" with { type: "json" }
import { addPopupConversacion, popupsConversacion, removePopupConversacion } from "../preferences"

export default function AjustePopupsConversacion() {
  return (
    <ListaClasesVentana
      clases={popupsConversacion}
      alAnadir={addPopupConversacion}
      alQuitar={removePopupConversacion}
      textos={textos.popupsConversacion}
    />
  )
}
