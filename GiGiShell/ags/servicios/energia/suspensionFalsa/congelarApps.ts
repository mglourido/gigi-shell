// servicios/energia/suspensionFalsa/congelarApps.ts
//
// Congelar las apps del allowlist. Es **lo último de `EFECTORES` a propósito**: lo único de
// toda la suspensión falsa que puede perder datos del usuario, y por tanto lo primero que se
// deshace al salir (el orquestador recorre la lista al revés — no hay que forzar ese orden
// desde aquí, y hacerlo sería duplicar la garantía en dos sitios que pueden divergir).
//
// ── LA PRIMITIVA ES EL FREEZER DE CGROUPS, NUNCA SIGSTOP ──────────────────────────────
// El primer instinto es `kill -STOP <pid>`. Está mal: los hijos se escapan (una app moderna
// es un árbol de procesos, y `SIGSTOP` para uno), el árbol no se detiene atómicamente y
// `SIGCONT` no garantiza el orden de reanudación. `systemctl --user freeze <scope>` congela
// el cgroup entero de una vez y `thaw` lo suelta limpio.
//
// ── NUNCA UNA SLICE ENTERA ────────────────────────────────────────────────────────────
// Solo se congelan unidades `*.scope` de app, y eso lo garantiza el parseo: `scopesACongelar`
// solo reconoce `app-<nombre>-<pid>.scope`, así que ni `app.slice` ni `init.scope` pueden
// salir de ahí. Congelar `app.slice` sería un deadlock del escritorio en cuanto algo pidiera
// un portal (`xdg-desktop-portal-gtk`, `dconf`, el registry de a11y viven ahí dentro), y el
// síntoma no se parece en nada a la causa.
//
// ── LA LISTA NEGRA DURA VA EN EL CÓDIGO, NO SOLO EN LA UI ─────────────────────────────
// `APPS_PROHIBIDAS` / `esAppProhibida` (en `scopesApps.ts`) se aplican dentro de
// `scopesACongelar`, o sea en el camino de ejecución. La comprobación de Ajustes es un aviso
// al escribir; el allowlist es un JSON editable a mano y puede venir de una instalación
// anterior a que la lista existiera. AGS, Hyprland, pipewire/wireplumber y NetworkManager
// congelados cuelgan la sesión sin un solo error.
//
// ── EL DESHIELO ES INCONDICIONAL Y TAMBIÉN AL ARRANCAR ────────────────────────────────
// `restaurar()` descongela TODO scope del allowlist, lo hubiera congelado este proceso o no.
// No es paranoia: el freezer es propiedad del CGROUP, no del proceso que lo pidió, así que un
// AGS que muera con apps congeladas las deja congeladas PARA SIEMPRE — la app se queda «sin
// responder» y no hay ni una línea en ningún log que lo explique. Por eso
// `initSuspensionFalsa()` llama a todos los efectores al arrancar el shell, y por eso este
// no puede limitarse a deshacer lo que tiene apuntado en RAM.
//
// `systemctl --user thaw` sobre una unidad que NO está congelada es un no-op limpio y sale
// con 0 (medido aquí sobre `app-code-18197.scope`, `FreezerState=running` antes y después),
// así que descongelar de más no cuesta nada.
import { execAsync } from "ags/process"
import type { EfectorSuspensionFalsa } from "./efectores"
import { sfAppsCongeladas } from "../powerState"
import { scopesACongelar } from "../../../modulos/ajustes/energia/scopesApps"

// El parseo, la resolución nombre→scope y la lista negra viven en
// `modulos/ajustes/energia/scopesApps.ts` (puro, con test) porque la UI de Ajustes las
// necesita para ofrecer candidatos y validar lo que se guarda. La dirección del import es
// inusual —un servicio tirando de un módulo de UI— y se acepta a cambio de lo que evita:
// dos resoluciones de nombre→scope que puedan divergir. Si divergieran, la app que el
// usuario metió en la lista sencillamente no se congelaría, sin un solo error en ninguna
// parte. Aquel fichero no importa nada, así que no arrastra GTK ni cierra ciclos.

const LISTAR = ["systemctl", "--user", "list-units", "--type=scope", "--no-legend", "--plain"]

/** Lo que congelamos NOSOTROS. Se usa como refuerzo del deshielo (unión con el allowlist
 *  vivo), no como su única fuente: una app que el usuario quite del allowlist mientras está
 *  congelada tiene que descongelarse igual, y una que congelara un AGS anterior no está
 *  aquí. */
const congelados = new Set<string>()

async function listarScopes(): Promise<string> {
  try {
    return await execAsync(LISTAR)
  } catch (error) {
    // Sin systemd de usuario no hay nada que congelar ni que descongelar: no-op limpio.
    console.error("[suspension-falsa] no se pudieron listar los scopes:", error)
    return ""
  }
}

/** Un `freeze`/`thaw` por unidad, cada uno aislado: una unidad que ya no existe (la app se
 *  cerró entre el listado y esto) no puede impedir que se traten las demás. */
async function accionSobre(verbo: "freeze" | "thaw", unidad: string): Promise<boolean> {
  try {
    await execAsync(["systemctl", "--user", verbo, unidad])
    return true
  } catch (error) {
    console.error(`[suspension-falsa] ${verbo} ${unidad}:`, error)
    return false
  }
}

export const efectorCongelarApps: EfectorSuspensionFalsa = {
  nombre: "congelar-apps",

  async aplicar() {
    const allowlist = sfAppsCongeladas.get()
    // La lista nace VACÍA y es explícita: sin nada dentro, ni se lanza el subproceso.
    if (!allowlist.length) return

    for (const unidad of scopesACongelar(await listarScopes(), allowlist)) {
      // Se apunta solo lo que se congeló de verdad. Apuntar un fallo haría que la salida
      // lanzara un `thaw` inútil — inofensivo, pero mentiría sobre lo que se hizo.
      if (await accionSobre("freeze", unidad)) congelados.add(unidad)
    }
  },

  async restaurar() {
    // Se vacía ANTES de esperar a nada: `restaurar()` debe ser idempotente y los `await` de
    // abajo ceden el bucle, así que una segunda llamada (atajo pulsado dos veces, salida
    // solapada con el `init`) no puede volver a recorrer la misma lista.
    const mios = [...congelados]
    congelados.clear()

    const allowlist = sfAppsCongeladas.get()
    // Con la lista vacía y nada apuntado, ni se lista: el caso normal del arranque.
    if (!mios.length && !allowlist.length) return

    // UNIÓN de las dos fuentes, y hacen falta las dos:
    //  · lo apuntado cubre a la app que el usuario ha quitado del allowlist mientras estaba
    //    congelada (sin esto se quedaría congelada para siempre, y quitarla de la lista es
    //    justo lo que haría alguien al ver que «no responde»);
    //  · el allowlist vivo cubre lo que congeló un AGS que ya no existe, que es el caso para
    //    el que `initSuspensionFalsa()` llama aquí al arrancar el shell.
    const unidades = new Set(mios)
    if (allowlist.length) {
      for (const unidad of scopesACongelar(await listarScopes(), allowlist)) unidades.add(unidad)
    }

    for (const unidad of unidades) await accionSobre("thaw", unidad)
  },
}
