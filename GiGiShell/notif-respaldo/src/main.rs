//! gigishell-notif-respaldo: guarda las notificaciones que llegan con AGS caído.
//!
//! No lo lanza nadie: lo arranca el bus por activación D-Bus
//! (`~/.local/share/dbus-1/services/org.freedesktop.Notifications.service`, lo genera
//! `instalar.sh`) cuando llega un `Notify` y nadie tiene `org.freedesktop.Notifications`. Con AGS
//! vivo no existe. Cuando AGS vuelve (aparece `io.Astal.ags`), suelta el nombre y sale. Todo va por
//! señales: ni sondeos ni temporizadores. Ver `CLAUDE.md`.

mod pendientes;
mod servidor;

use std::sync::{Arc, Mutex};
use zbus::blocking::fdo::DBusProxy;
use zbus::blocking::Connection;
use zbus::fdo::{RequestNameFlags, RequestNameReply};

const NOMBRE: &str = "org.freedesktop.Notifications";
const RUTA_OBJETO: &str = "/org/freedesktop/Notifications";
/// El nombre que registra `app.start` de Astal para la instancia por defecto de AGS, antes de que
/// `main()` cree el AstalNotifd. Si la instancia cambia de nombre, hay que cambiarlo aquí.
const AGS: &str = "io.Astal.ags";

fn main() {
    if let Err(e) = ejecutar() {
        eprintln!("gigishell-notif-respaldo: {e}");
        std::process::exit(1);
    }
}

fn ags_presente(dbus: &DBusProxy) -> zbus::Result<bool> {
    Ok(dbus.name_has_owner(AGS.try_into()?)?)
}

fn ejecutar() -> zbus::Result<()> {
    let ruta = pendientes::ruta().ok_or_else(|| zbus::Error::Failure("sin HOME".into()))?;
    let conexion = Connection::session()?;
    let dbus = DBusProxy::new(&conexion)?;

    // Suscribirse ANTES de mirar si AGS está: si apareciera entre la comprobación y la suscripción,
    // la señal se perdería y el respaldo se quedaría con el nombre.
    let mut cambios = dbus.receive_name_owner_changed_with_args(&[(0, AGS)])?;

    // Activado en la ventana en que AGS ya arrancó pero aún no tiene el nombre: no se le estorba.
    // El mensaje que nos activó falla, igual que fallaría sin respaldo.
    if ags_presente(&dbus)? {
        return Ok(());
    }

    let cerrojo = Arc::new(Mutex::new(()));
    conexion
        .object_server()
        .at(RUTA_OBJETO, servidor::Servidor { ruta, cerrojo: Arc::clone(&cerrojo) })?;

    // DO_NOT_QUEUE: si alguien ya tiene el nombre (AGS, u otro daemon), este proceso sobra.
    match conexion.request_name_with_flags(NOMBRE, RequestNameFlags::DoNotQueue.into())? {
        RequestNameReply::PrimaryOwner | RequestNameReply::AlreadyOwner => {}
        _ => return Ok(()),
    }

    // Segunda mirada: AGS pudo aparecer mientras se pedía el nombre (la suscripción ya lo habría
    // recogido, pero así se cede sin esperar a ninguna señal).
    if !ags_presente(&dbus)? {
        for senal in &mut cambios {
            match senal.args() {
                Ok(args) if args.new_owner().is_some() => break,
                _ => {}
            }
        }
    }

    // Con el cerrojo tomado no hay ninguna escritura en vuelo: lo guardado está entero en disco
    // antes de que AGS, al tomar el nombre, lo lea.
    let _sin_escrituras = cerrojo.lock().unwrap_or_else(|e| e.into_inner());
    let _ = conexion.release_name(NOMBRE);
    Ok(())
}
