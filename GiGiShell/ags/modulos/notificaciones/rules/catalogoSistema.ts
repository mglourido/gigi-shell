// modulos/notificaciones/rules/catalogoSistema.ts
// CATÁLOGO de las notificaciones del sistema: una entrada por aviso que puede emitir
// `hypr/scripts/` (y los pocos que manda AGS por `notify-send`). Módulo puro, sin GTK.
//
// POR QUÉ EXISTE. El hint `x-gigishell-event` (ver `hypr/scripts/lib/notif.sh`) da identidad a
// cada aviso, pero eso solo sirve para CASAR: sin una lista, Ajustes no podría enseñar un
// aviso que todavía no se ha disparado nunca — y ese es justo el que interesa configurar
// (nadie quiere esperar a que le falle un disco para poder decidir cómo avisa). El catálogo
// es esa lista: los ~100 avisos con su nombre legible, su categoría y sus efectos por
// defecto, y es lo que pinta la pestaña Sistema.
//
// NO es la configuración del usuario. Aquí van los DEFAULTS que vienen con GiGiShell; lo que el
// usuario cambia vive fuera del repo, en `~/.config/gigishell/notif-sistema.json`, y se
// superpone a esto (`sistemaStore.ts`). Un aviso sin entrada en ese fichero usa lo de aquí.
//
// AL AÑADIR UN AVISO NUEVO a un script, da de alta su id aquí. Si no, el aviso funciona
// igual (nada depende de estar catalogado: `match.event` casa contra el hint, no contra esta
// lista) pero no sale en Ajustes, que es lo único que se pierde — y todo lo que este trabajo
// pretendía ganar. `catalogo.test.ts` comprueba que no haya ids repetidos ni categorías
// huérfanas, no que la lista esté completa: eso no lo puede saber TypeScript.
import type { EffectSpec } from "./types.ts"
import textos from "../../../textos/ajustes/notificaciones-sistema.json" with { type: "json" }

/** Agrupación de la pestaña Sistema. El orden del array ES el orden en pantalla, de lo que
 *  más importa vigilar a lo más accesorio. */
export const CATEGORIAS_SISTEMA = [
  "energia",
  "hardware",
  "almacenamiento",
  "red",
  "seguridad",
  "antivirus",
  "apps",
  "arranque",
  "escritorio",
] as const

export type CategoriaSistema = (typeof CATEGORIAS_SISTEMA)[number]

export interface EventoSistema {
  /** El hint `x-gigishell-event` que manda el emisor. Clave primaria. */
  id: string
  nombre: string
  categoria: CategoriaSistema
  /** Fichero que lo emite, para poder ir a la fuente sin grepear. Se enseña en la UI. */
  origen: string
  /** Efectos por defecto. Vacío = comportamiento normal (popup + panel). Lo que se ponga aquí
   *  es exactamente lo que el usuario ve prerrellenado al abrir el aviso en Ajustes. */
  efectos?: EffectSpec
}

const t = textos.eventos as Record<string, string>

/** Azúcar para no repetir `nombre: textos.eventos["…"]` cien veces; si falta la traducción se
 *  cae al id, que es feo pero legible — nunca a una cadena vacía. */
const ev = (
  id: string,
  categoria: CategoriaSistema,
  origen: string,
  efectos?: EffectSpec,
): EventoSistema => ({ id, nombre: t[id] ?? id, categoria, origen, ...(efectos ? { efectos } : {}) })

/** Duración de popup de los avisos de PURA CONFIRMACIÓN: los que dicen que algo que el
 *  usuario acaba de hacer salió bien, o que un problema del que ya se avisó se resolvió solo
 *  ("USB conectado", "Wi-Fi reconectado", "Temperatura normal", "Grabación guardada"). No
 *  hay nada que leer entero ni nada que decidir, así que los 10 s que le corresponden por
 *  defecto a un aviso del sistema se hacen largos y tapan la pantalla sin motivo. Tres
 *  segundos bastan para verlos de reojo; el aviso sigue en el panel igualmente.
 *
 *  Es solo el valor DE FÁBRICA: cada aviso se puede cambiar en Ajustes > Notificaciones >
 *  Sistema, y los avisos que sí piden atención (errores, malware, disco lleno) no lo llevan. */
const BREVE_MS = 3000

export const CATALOGO_SISTEMA: EventoSistema[] = [
  // ── Energía ────────────────────────────────────────────────────────────────────────────
  // `bateria.baja` llega con `lifetime: flash` + condición: es el mismo trato que le daba la
  // builtin `builtin.low-battery` casando por el título "batería", que además pillaba de
  // rebote cualquier notificación de otra app que dijera esa palabra.
  ev("bateria.baja", "energia", "battery-monitor.sh", { lifetime: "flash", conditions: ["battery-resolved"] }),
  ev("bateria.cargando", "energia", "battery-monitor.sh", { clearOnBoot: true, popupMs: BREVE_MS }),
  ev("bateria.descargando", "energia", "battery-monitor.sh", { clearOnBoot: true, popupMs: BREVE_MS }),
  ev("bateria.completa", "energia", "battery-monitor.sh", { clearOnBoot: true, popupMs: BREVE_MS }),
  ev("bateria.modo-ahorro", "energia", "battery-monitor.sh", { clearOnBoot: true, popupMs: BREVE_MS }),
  ev("energia.perfil-tlp", "energia", "servicios/energia/tlp.ts", { clearOnBoot: true, popupMs: BREVE_MS }),
  ev("juegos.modo-juego", "energia", "servicios/energia/gamemode.ts", { clearOnBoot: true, popupMs: BREVE_MS }),
  ev("energia.wake-up-fin", "energia", "servicios/energia/mantenerDespierto.ts", { clearOnBoot: true, popupMs: BREVE_MS }),

  // ── Hardware ───────────────────────────────────────────────────────────────────────────
  ev("temperatura.cpu-alta", "hardware", "temp-monitor.sh"),
  ev("temperatura.cpu-normal", "hardware", "temp-monitor.sh", { clearOnBoot: true, popupMs: BREVE_MS }),
  ev("temperatura.gpu-alta", "hardware", "temp-monitor.sh"),
  ev("temperatura.gpu-normal", "hardware", "temp-monitor.sh", { clearOnBoot: true, popupMs: BREVE_MS }),
  ev("ram.baja", "hardware", "ram-monitor.sh"),
  ev("ram.normalizada", "hardware", "ram-monitor.sh", { clearOnBoot: true, popupMs: BREVE_MS }),
  ev("cpu.throttling", "hardware", "oom-monitor.sh"),
  ev("gpu.error", "hardware", "oom-monitor.sh"),
  ev("hardware.error", "hardware", "oom-monitor.sh"),
  ev("kernel.oom", "hardware", "oom-monitor.sh"),
  ev("kernel.panic", "hardware", "oom-monitor.sh"),
  ev("kernel.tarea-colgada", "hardware", "oom-monitor.sh"),
  ev("kernel.modulo-sin-firmar", "hardware", "oom-monitor.sh"),

  // ── Almacenamiento ─────────────────────────────────────────────────────────────────────
  // DOS emisores para el mismo aviso, y por eso el origen los nombra a los dos: `disk-monitor.sh`
  // al iniciar sesión, y `servicios/disco/alerta.ts` cada vez que Ajustes > Almacenamiento mide
  // (reaprovechando su `df`, sin sondeo propio — el espacio libre no tiene fuente de eventos en
  // Linux; ver la cabecera de `servicios/disco/vigilancia.ts`). Comparten umbrales, texto y una
  // marca en `~/.cache/gigishell/disco-avisos` para no avisar dos veces de lo mismo.
  ev("disco.casi-lleno", "almacenamiento", "disk-monitor.sh + servicios/disco/alerta.ts"),
  // `clearOnBoot`: informa de algo que ya pasó y no requiere ninguna acción; arrastrarlo al
  // siguiente arranque solo ensucia el panel.
  ev("limpieza.completada", "almacenamiento", "limpiar-almacenamiento.sh", { clearOnBoot: true, popupMs: BREVE_MS }),
  ev("disco.error-es", "almacenamiento", "oom-monitor.sh"),
  ev("disco.smart-fallo", "almacenamiento", "oom-monitor.sh"),
  ev("disco.smart-sin-permisos", "almacenamiento", "oom-monitor.sh"),
  ev("usb.conectado", "almacenamiento", "usb-monitor.sh", { clearOnBoot: true, popupMs: BREVE_MS }),
  ev("usb.desconectado", "almacenamiento", "usb-monitor.sh", { clearOnBoot: true, popupMs: BREVE_MS }),
  ev("usb.almacenamiento", "almacenamiento", "usb-monitor.sh", { clearOnBoot: true, popupMs: BREVE_MS }),
  ev("usb.volumen-con-errores", "almacenamiento", "usb-monitor.sh"),
  ev("usb.extraccion-insegura", "almacenamiento", "oom-monitor.sh"),
  ev("usb.extraccion-en-lectura", "almacenamiento", "oom-monitor.sh"),
  ev("usb.expulsado", "almacenamiento", "usb-eject.sh", { clearOnBoot: true, popupMs: BREVE_MS }),
  ev("usb.desmontado", "almacenamiento", "usb-eject.sh", { clearOnBoot: true, popupMs: BREVE_MS }),
  ev("usb.expulsar-fallo", "almacenamiento", "usb-eject.sh"),
  ev("usb.expulsar-falta-udisks", "almacenamiento", "usb-eject.sh"),
  ev("usb.expulsar-sin-dispositivo", "almacenamiento", "usb-eject.sh"),
  ev("usb.abrir-sin-dispositivo", "almacenamiento", "usb-open.sh"),
  ev("usb.abrir-sin-volumen", "almacenamiento", "usb-open.sh"),
  ev("usb.abrir-falta-udisks", "almacenamiento", "usb-open.sh"),
  ev("usb.abrir-fallo-montaje", "almacenamiento", "usb-open.sh"),
  ev("usb.abrir-sin-gestor", "almacenamiento", "usb-open.sh"),
  ev("usb.reparando", "almacenamiento", "usb-repair.sh", { clearOnBoot: true, popupMs: BREVE_MS }),
  ev("usb.reparado", "almacenamiento", "usb-repair.sh", { clearOnBoot: true }),
  ev("usb.reparacion-incompleta", "almacenamiento", "usb-repair.sh"),
  ev("usb.reparar-en-uso", "almacenamiento", "usb-repair.sh"),
  ev("usb.reparar-fallo", "almacenamiento", "usb-repair.sh"),
  ev("usb.reparar-sin-dispositivo", "almacenamiento", "usb-repair.sh"),

  // ── Red ────────────────────────────────────────────────────────────────────────────────
  ev("wifi.desconectado", "red", "wifi-monitor.sh", { clearOnBoot: true }),
  ev("wifi.reconectado", "red", "wifi-monitor.sh", { clearOnBoot: true, popupMs: BREVE_MS }),
  ev("wifi.portal-cautivo", "red", "wifi-monitor.sh", { clearOnBoot: true }),
  ev("wifi.sin-interfaz", "red", "wifi-monitor.sh", { clearOnBoot: true }),
  ev("bluetooth.conectado", "red", "bt-monitor.sh", { clearOnBoot: true, popupMs: BREVE_MS }),
  ev("bluetooth.perdido", "red", "bt-monitor.sh", { clearOnBoot: true }),

  // ── Seguridad ──────────────────────────────────────────────────────────────────────────
  ev("seguridad.escalada-privilegios", "seguridad", "oom-monitor.sh"),
  ev("sudo.fallo-autenticacion", "seguridad", "oom-monitor.sh"),
  ev("ssh.evento", "seguridad", "oom-monitor.sh"),
  ev("archivos.critico-modificado", "seguridad", "oom-monitor.sh"),
  ev("archivos.persistencia", "seguridad", "oom-monitor.sh"),
  ev("archivos.clave-ssh", "seguridad", "oom-monitor.sh"),
  ev("archivos.boot", "seguridad", "oom-monitor.sh"),
  ev("archivos.actualizacion", "seguridad", "oom-monitor.sh", { clearOnBoot: true }),
  ev("sistema.reinicio-pendiente", "seguridad", "oom-monitor.sh", { clearOnBoot: true }),
  ev("monitor.sin-inotify", "seguridad", "oom-monitor.sh", { clearOnBoot: true }),
  // Cámara en uso. Va en Seguridad y no en Hardware porque no informa de un
  // dispositivo sino de una PRIVACIDAD: alguien acaba de encender la cámara, y
  // eso es lo mismo que vigilan los avisos de esta categoría.
  //
  // Deliberadamente SIN `popupMs: BREVE_MS`: los 3 s son para confirmaciones de
  // algo que el usuario acaba de pedir ("USB conectado", "Wi-Fi reconectado").
  // Esto es lo contrario — puede saltar sin que el usuario haya hecho nada, y
  // ese es justo el caso en que hay que llegar a leerlo. El script ya lo emite
  // con `-u low` y `-t 4000`, que es todo el recorte de ruido que merece.
  //
  // `clearOnBoot` sí: describe un instante concreto de la sesión anterior, y
  // arrastrar "Cámara en uso" al arranque siguiente es exactamente el falso
  // positivo que más asusta de un aviso de este tipo.
  ev("camara.en-uso", "seguridad", "camara-monitor.sh", { clearOnBoot: true }),

  // Modo gestos (hypr/scripts/gestos/). Solo DOS avisos, y ninguno para el
  // encendido normal: al activarlo, `camara-monitor.sh` ya emite «Cámara en
  // uso», y un segundo aviso diciendo lo mismo con otras palabras sería ruido
  // cada vez que se pulsa SUPER+SHIFT+G.
  //
  // `gestos.no-disponible` es el que de verdad hace falta: sin él, un atajo que
  // no hace nada (la cámara bloqueada, ocupada por una videollamada, o el
  // entorno sin instalar) es indistinguible de un atajo roto. Lleva el motivo
  // en el cuerpo.
  //
  // `clearOnBoot` en los dos: hablan de un intento concreto de una sesión que ya
  // terminó, y arrastrarlos al arranque siguiente señalaría a un problema que
  // probablemente ya no existe.
  ev("gestos.no-disponible", "seguridad", "gestos.sh", { clearOnBoot: true }),
  ev("gestos.detenido", "seguridad", "gestos.py", { clearOnBoot: true }),

  // ── Antivirus y descargas ──────────────────────────────────────────────────────────────
  ev("descargas.malware", "antivirus", "oom-monitor.sh"),
  ev("descargas.ejecutable-nuevo", "antivirus", "oom-monitor.sh"),
  ev("descargas.archivo-grande", "antivirus", "oom-monitor.sh"),
  ev("antivirus.sin-firmas", "antivirus", "oom-monitor.sh"),
  ev("antivirus.actualizando", "antivirus", "actualizar-firmas.sh", { clearOnBoot: true, popupMs: BREVE_MS }),
  ev("antivirus.actualizacion-en-curso", "antivirus", "actualizar-firmas.sh", { clearOnBoot: true }),
  ev("antivirus.firmas-actualizadas", "antivirus", "actualizar-firmas.sh", { clearOnBoot: true, popupMs: BREVE_MS }),
  ev("antivirus.fallo-actualizacion", "antivirus", "actualizar-firmas.sh"),
  ev("antivirus.falta-ayudante", "antivirus", "actualizar-firmas.sh"),
  ev("antivirus.estado", "antivirus", "servicios/seguridad/clamav.ts", { clearOnBoot: true }),
  ev("analisis.analizando", "antivirus", "scan-file.sh", { clearOnBoot: true, popupMs: BREVE_MS }),
  ev("analisis.limpio", "antivirus", "scan-file.sh", { clearOnBoot: true, popupMs: BREVE_MS }),
  ev("analisis.malware", "antivirus", "scan-file.sh"),
  ev("analisis.sin-firmas", "antivirus", "scan-file.sh"),
  ev("analisis.sin-clamav", "antivirus", "scan-file.sh"),
  ev("analisis.sin-archivo", "antivirus", "scan-file.sh", { clearOnBoot: true }),
  ev("analisis.sin-carpeta", "antivirus", "scan-downloads.sh", { clearOnBoot: true }),
  ev("aislado.lanzando", "antivirus", "run-untrusted.sh", { clearOnBoot: true, popupMs: BREVE_MS }),
  ev("aislado.malware", "antivirus", "run-untrusted.sh"),
  ev("aislado.no-analizado", "antivirus", "run-untrusted.sh"),
  ev("aislado.sin-antivirus", "antivirus", "run-untrusted.sh"),
  ev("aislado.sin-archivo", "antivirus", "run-untrusted.sh", { clearOnBoot: true }),
  ev("aislado.falta-firejail", "antivirus", "run-untrusted.sh"),
  ev("aislado.falta-wine", "antivirus", "run-untrusted.sh"),

  // ── Apps y servicios ───────────────────────────────────────────────────────────────────
  // Los tres heredan el `clearOnBoot` que les daban las builtin `app-crash` / `coredump`,
  // que casaban por las palabras "crash" y "coredump" en cualquier notificación.
  ev("app.crash", "apps", "oom-monitor.sh", { clearOnBoot: true }),
  ev("app.tormenta-crashes", "apps", "oom-monitor.sh", { clearOnBoot: true }),
  ev("servicio.fallo-arranque", "apps", "oom-monitor.sh", { clearOnBoot: true }),
  ev("servicio.en-fallo", "apps", "oom-monitor.sh", { clearOnBoot: true }),

  // ── Arranque ───────────────────────────────────────────────────────────────────────────
  // Todo el healthcheck se limpia al reiniciar por definición: describe ESE arranque, y
  // conservarlo hasta el siguiente solo sirve para confundirlo con el nuevo.
  // `arranque.resumen` es el aviso único que sale cuando hay VARIOS problemas a la vez; es una
  // entrada propia y no un recuento de las de abajo, así que se cataloga aparte.
  ev("arranque.resumen", "arranque", "boot-healthcheck.sh", { clearOnBoot: true }),
  ev("arranque.servicios-fallidos", "arranque", "boot-healthcheck.sh", { clearOnBoot: true }),
  ev("arranque.errores-journal", "arranque", "boot-healthcheck.sh", { clearOnBoot: true }),
  ev("arranque.suspension-fallida", "arranque", "boot-healthcheck.sh", { clearOnBoot: true }),
  ev("arranque.disco-lleno", "arranque", "boot-healthcheck.sh", { clearOnBoot: true }),
  ev("arranque.lento", "arranque", "boot-healthcheck.sh", { clearOnBoot: true }),
  ev("arranque.red-inactiva", "arranque", "boot-healthcheck.sh", { clearOnBoot: true }),
  ev("arranque.sin-conectividad", "arranque", "boot-healthcheck.sh", { clearOnBoot: true }),
  ev("arranque.sin-interfaces", "arranque", "boot-healthcheck.sh", { clearOnBoot: true }),
  ev("arranque.nvidia-sin-driver", "arranque", "boot-healthcheck.sh", { clearOnBoot: true }),
  ev("arranque.nvidia-error", "arranque", "boot-healthcheck.sh", { clearOnBoot: true }),
  ev("arranque.nvme-smart", "arranque", "boot-healthcheck.sh", { clearOnBoot: true }),
  ev("arranque.sata-smart", "arranque", "boot-healthcheck.sh", { clearOnBoot: true }),
  ev("arranque.bateria-degradada", "arranque", "boot-healthcheck.sh", { clearOnBoot: true }),
  ev("arranque.ventilador-parado", "arranque", "boot-healthcheck.sh", { clearOnBoot: true }),
  ev("arranque.pipewire-inactivo", "arranque", "boot-healthcheck.sh", { clearOnBoot: true }),
  ev("arranque.bluetooth-inactivo", "arranque", "boot-healthcheck.sh", { clearOnBoot: true }),
  ev("arranque.bluetooth-bloqueado", "arranque", "boot-healthcheck.sh", { clearOnBoot: true }),
  ev("arranque.errores-usb", "arranque", "boot-healthcheck.sh", { clearOnBoot: true }),

  // ── Escritorio ─────────────────────────────────────────────────────────────────────────
  ev("desinstalar.ok", "escritorio", "desinstalar-app.sh", { clearOnBoot: true, popupMs: BREVE_MS }),
  ev("desinstalar.fallo", "escritorio", "desinstalar-app.sh", { clearOnBoot: true }),
  ev("desinstalar.steam", "escritorio", "desinstalar-app.sh", { clearOnBoot: true }),
  ev("desinstalar.no-soportado", "escritorio", "desinstalar-app.sh", { clearOnBoot: true }),
  ev("desinstalar.falta-script", "escritorio", "modulos/orion/data/uninstall.ts", { clearOnBoot: true }),
  ev("grabacion.guardada", "escritorio", "grabar-pantalla.sh", { clearOnBoot: true, popupMs: BREVE_MS }),
  ev("grabacion.error", "escritorio", "grabar-pantalla.sh", { clearOnBoot: true }),
  ev("emojis.no-disponible", "escritorio", "emoji-picker.sh", { clearOnBoot: true }),
]

const PORID = new Map(CATALOGO_SISTEMA.map(e => [e.id, e]))

export function eventoSistema(id: string): EventoSistema | undefined { return PORID.get(id) }

/** Catálogo agrupado y en el orden de `CATEGORIAS_SISTEMA`. Las categorías vacías no salen. */
export function catalogoPorCategoria(): { categoria: CategoriaSistema; nombre: string; eventos: EventoSistema[] }[] {
  const nombres = textos.categorias as Record<string, string>
  return CATEGORIAS_SISTEMA
    .map(categoria => ({
      categoria,
      nombre: nombres[categoria] ?? categoria,
      eventos: CATALOGO_SISTEMA.filter(e => e.categoria === categoria),
    }))
    .filter(g => g.eventos.length > 0)
}
