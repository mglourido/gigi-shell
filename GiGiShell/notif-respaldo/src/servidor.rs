//! La interfaz `org.freedesktop.Notifications` mínima: guarda y no enseña nada.

use crate::pendientes::{self, Entrada};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use zbus::fdo;
use zbus::object_server::SignalEmitter;
use zbus::zvariant::{OwnedValue, Value};

/// Motivo 3 del spec: «cerrada con CloseNotification».
const CERRADA_POR_LLAMADA: u32 = 3;

pub struct Servidor {
    pub ruta: PathBuf,
    /// Lo toma cada escritura y también `main` antes de soltar el nombre: así nunca se cede a AGS
    /// con una notificación a medio escribir.
    pub cerrojo: Arc<Mutex<()>>,
}

/// Los hints escalares, como texto. `image-data` (una estructura con los píxeles) y cualquier
/// otro valor compuesto se descartan: no se escriben imágenes en crudo a disco.
fn hint_texto(valor: &Value) -> Option<String> {
    Some(match valor {
        Value::Str(s) => s.to_string(),
        Value::ObjectPath(p) => p.to_string(),
        Value::Bool(b) => b.to_string(),
        Value::U8(n) => n.to_string(),
        Value::I16(n) => n.to_string(),
        Value::U16(n) => n.to_string(),
        Value::I32(n) => n.to_string(),
        Value::U32(n) => n.to_string(),
        Value::I64(n) => n.to_string(),
        Value::U64(n) => n.to_string(),
        Value::F64(n) => n.to_string(),
        Value::Value(dentro) => return hint_texto(dentro),
        _ => return None,
    })
}

fn urgencia(hints: &HashMap<String, OwnedValue>) -> u8 {
    match hints.get("urgency").map(|v| &**v) {
        Some(Value::U8(n)) => (*n).min(2),
        Some(Value::Value(dentro)) => match &**dentro {
            Value::U8(n) => (*n).min(2),
            _ => 1,
        },
        _ => 1,
    }
}

fn ahora_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn fallo(e: std::io::Error) -> fdo::Error {
    fdo::Error::Failed(format!("no se pudo guardar la notificación: {e}"))
}

#[zbus::interface(name = "org.freedesktop.Notifications")]
impl Servidor {
    #[allow(clippy::too_many_arguments)]
    fn notify(
        &self,
        app_name: String,
        replaces_id: u32,
        app_icon: String,
        summary: String,
        body: String,
        _actions: Vec<String>,
        hints: HashMap<String, OwnedValue>,
        expire_timeout: i32,
    ) -> fdo::Result<u32> {
        let _escribiendo = self.cerrojo.lock().unwrap_or_else(|e| e.into_inner());
        let mut lista = pendientes::leer(&self.ruta);
        // Un `replaces_id` que no es nuestro (lo dio AGS antes de caer) se trata como nueva: el spec
        // pide no reutilizar un id que no existe.
        let id = if replaces_id != 0 && pendientes::contiene(&lista, replaces_id) {
            replaces_id
        } else {
            pendientes::siguiente_id(&lista)
        };
        let mut textos: Vec<(String, String)> = hints
            .iter()
            .filter_map(|(clave, valor)| Some((clave.clone(), hint_texto(valor)?)))
            .collect();
        textos.sort();
        let entrada = Entrada {
            id,
            app: app_name,
            icono: app_icon,
            titulo: summary,
            cuerpo: body,
            urgencia: urgencia(&hints),
            hora_ms: ahora_ms(),
            expira: expire_timeout,
            hints: textos,
        };
        pendientes::anadir(&mut lista, &entrada);
        pendientes::escribir(&self.ruta, &lista).map_err(fallo)?;
        Ok(id)
    }

    async fn close_notification(
        &self,
        id: u32,
        #[zbus(signal_emitter)] emisor: SignalEmitter<'_>,
    ) -> fdo::Result<()> {
        let quitada = {
            let _escribiendo = self.cerrojo.lock().unwrap_or_else(|e| e.into_inner());
            let mut lista = pendientes::leer(&self.ruta);
            let quitada = pendientes::quitar(&mut lista, id);
            if quitada {
                pendientes::escribir(&self.ruta, &lista).map_err(fallo)?;
            }
            quitada
        };
        if quitada {
            let _ = Self::notification_closed(&emisor, id, CERRADA_POR_LLAMADA).await;
        }
        Ok(())
    }

    /// Sin `actions`: al volver AGS el emisor ya no habla con quien le dio el id, así que ningún
    /// botón podría funcionar. Anunciándolo, las apps que lo miran no mandan acciones.
    fn get_capabilities(&self) -> Vec<String> {
        vec!["body".into()]
    }

    /// `daemon/comprobacion.ts` reconoce el respaldo por su `comm`, no por esto, pero el nombre
    /// sirve a quien lo mire con `busctl` o `notify-send --print-id`.
    fn get_server_information(&self) -> (String, String, String, String) {
        ("gigishell-notif-respaldo".into(), "GiGiShell".into(), env!("CARGO_PKG_VERSION").into(), "1.2".into())
    }

    #[zbus(signal)]
    async fn notification_closed(emisor: &SignalEmitter<'_>, id: u32, reason: u32) -> zbus::Result<()>;

    #[zbus(signal)]
    async fn action_invoked(emisor: &SignalEmitter<'_>, id: u32, action_key: String) -> zbus::Result<()>;
}
