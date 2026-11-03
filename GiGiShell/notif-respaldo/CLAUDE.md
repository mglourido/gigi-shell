# CLAUDE.md — notif-respaldo

Parte de la guía de GiGiShell (mapa de zonas en el [`CLAUDE.md` raíz](../CLAUDE.md)). Diseño y
alternativas descartadas: [`docs/superpowers/specs/2026-11-03-notif-respaldo-design.md`](../docs/superpowers/specs/2026-11-03-notif-respaldo-design.md).

`notif-respaldo/` es el binario Rust `gigishell-notif-respaldo`: **guarda en disco las
notificaciones que llegan con AGS caído**, para que AGS las meta en el panel al volver. No enseña
nada y no suena: con AGS caído no hay pantalla donde verlas, así que tampoco deben oírse.

- **No lo lanza nadie: lo arranca el bus por activación D-Bus.** `instalar.sh` genera
  `~/.local/share/dbus-1/services/org.freedesktop.Notifications.service` (generado y no un symlink
  porque `Exec=` no expande `~`). Con AGS vivo, AGS tiene el nombre y el bus no arranca el
  respaldo nunca: cero procesos. Si AGS cae, el primer `Notify` lo arranca y ese mensaje le llega.
- **Se va solo cuando vuelve AGS, por señal.** Escucha `NameOwnerChanged` de `io.Astal.ags`, el
  nombre que registra `app.start` de Astal **antes** de que `main()` cree el AstalNotifd. Al verlo,
  toma el cerrojo (no queda ninguna escritura a medias), suelta `org.freedesktop.Notifications` y
  sale. Si AGS ya estaba en cola, D-Bus le da el nombre en el acto; si aún no lo había pedido, lo
  encuentra libre. **Sin sondeos ni temporizadores, a petición del usuario**: una versión anterior
  del diseño vivía en el autostart, en cola detrás de AGS, y miraba `ListQueuedOwners` cada 100 ms.
  Se descartó por eso.
- **Por qué no sirve un demonio siempre dueño del nombre con AGS de cliente:** AstalNotifd pide el
  nombre con `BusNameOwnerFlags.NONE` (se pone en cola y nunca lo quita) y solo sabe hacer de
  cliente de **otro AstalNotifd** (`GetServerInformation` = `notifd/astal/0.1` y métodos privados
  con su GVariant interno). Imitarlo ataría esto a una interfaz sin versionar de `libastal-git`.
- **Orden al arrancar, y por qué:** primero se suscribe a la señal, luego mira si `io.Astal.ags`
  existe (si sí, sale sin tomar nada: lo activó un `Notify` justo mientras AGS arrancaba), luego
  pide el nombre con `DO_NOT_QUEUE` y vuelve a mirar. Suscribirse después de mirar dejaría un hueco
  en el que AGS aparece y la señal se pierde, y el respaldo se quedaría con el nombre.
- **Límite aceptado:** un `Notify` en los milisegundos entre que el respaldo suelta el nombre y AGS
  lo toma arranca otro respaldo, que ve `io.Astal.ags` y sale; esa notificación falla como antes.
  Taparlo exigiría volver a un temporizador.
- **El fichero** es `~/.config/gigishell/notif-pendientes.json`, modo 0600 (texto de mensajes y
  correos), reescrito entero de forma atómica en cada `Notify` (temporal + `rename`). Tope de 200
  (el `NOTIF_CAP` de AGS) y textos recortados por caracteres. El formato lo comparte con
  `ags/modulos/notificaciones/procesamiento/pendientes.ts`: **un campo cambiado en un sitio hay que
  cambiarlo en el otro**. Un fichero ilegible se aparta a `.corrupto`, no se pisa.
- **Solo hints escalares, como texto.** `image-data` (los píxeles en crudo) no se guarda; la imagen
  llega a AGS solo si vino como `image-path`. `x-gigishell-source`/`x-gigishell-event` sí viajan,
  así que al volver AGS los avisos del sistema casan con su regla del catálogo como en vivo.
- **`GetCapabilities` = `["body"]`, sin `actions`, a propósito:** al volver AGS el emisor ya habla
  con otro servidor, así que ningún botón podría funcionar. Un `replaces_id` que no sea suyo (lo dio
  AGS antes de caer) se trata como notificación nueva.
- **`daemon/comprobacion.ts` de AGS lo reconoce por su `comm`** (`gigishell-notif`, el nombre del
  binario cortado a 15 caracteres) y no lo trata como intruso. **Si se renombra el binario, hay
  que cambiar `COMM_RESPALDO` allí.**
- **Tapa la autoactivación de dunst/mako.** El bus mira `~/.local/share/dbus-1/services` antes que
  `/usr/share`, así que con dos `.service` para el mismo nombre gana este. No se ha probado con
  dunst instalado; enmascarar el rival (`docs/SETUP.md` §2) sigue siendo lo correcto.
- Instalar: `notif-respaldo/instalar.sh` (pasa los tests y recarga el bus con `ReloadConfig`).
  `--quitar` borra binario y `.service`. Sin el binario, con AGS caído las notificaciones se pierden.
- Probar: `ags quit`, varios `notify-send` (`busctl --user status org.freedesktop.Notifications`
  debe dar `Comm=gigishell-notif`), mirar el fichero y luego `ags run ~/.config/ags/`: el respaldo
  sale en cuanto aparece AGS, y unos 4 s después las notificaciones están en el panel, sin popup.
