//! El fichero de notificaciones pendientes: lo que llegó con AGS caído y AGS ingerirá al volver.
//!
//! Formato (`~/.config/gigishell/notif-pendientes.json`, lo lee
//! `ags/modulos/notificaciones/procesamiento/pendientes.ts`):
//! `{"version":1,"notificaciones":[{id, app, icono, titulo, cuerpo, urgencia, hora, expira, hints}]}`.
//! Si cambia un campo aquí, hay que cambiarlo allí.
//!
//! Se reescribe entero en cada notificación (temporal + `rename`): son 200 entradas como mucho y
//! solo se escriben mientras AGS está caído, así que no compensa un formato por líneas, y así un
//! `replaces_id` o un `CloseNotification` se aplican sin dejar entradas muertas.

use serde_json::{json, Map, Value};
use std::fs;
use std::io::{self, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

pub const VERSION: u64 = 1;
/// El mismo tope que la lista activa de AGS (`NOTIF_CAP`): más no cabría en el panel.
pub const TOPE: usize = 200;
pub const MAX_APP: usize = 128;
pub const MAX_TITULO: usize = 512;
pub const MAX_CUERPO: usize = 4096;
pub const MAX_HINTS: usize = 32;
pub const MAX_HINT: usize = 1024;

pub struct Entrada {
    pub id: u32,
    pub app: String,
    pub icono: String,
    pub titulo: String,
    pub cuerpo: String,
    pub urgencia: u8,
    pub hora_ms: u64,
    pub expira: i32,
    pub hints: Vec<(String, String)>,
}

/// Recorta por caracteres, no por bytes: cortar a mitad de un carácter UTF-8 no compila a `str`.
pub fn recortar(texto: &str, max: usize) -> String {
    texto.chars().take(max).collect()
}

impl Entrada {
    fn a_json(&self) -> Value {
        let mut hints = Map::new();
        for (clave, valor) in self.hints.iter().take(MAX_HINTS) {
            hints.insert(recortar(clave, 128), Value::String(recortar(valor, MAX_HINT)));
        }
        json!({
            "id": self.id,
            "app": recortar(&self.app, MAX_APP),
            "icono": recortar(&self.icono, MAX_HINT),
            "titulo": recortar(&self.titulo, MAX_TITULO),
            "cuerpo": recortar(&self.cuerpo, MAX_CUERPO),
            "urgencia": self.urgencia.min(2),
            "hora": self.hora_ms,
            "expira": self.expira,
            "hints": hints,
        })
    }
}

/// `$XDG_CONFIG_HOME/gigishell/notif-pendientes.json`, con `~/.config` por defecto, como
/// `GLib.get_user_config_dir()` en AGS.
pub fn ruta() -> Option<PathBuf> {
    let base = match std::env::var_os("XDG_CONFIG_HOME").filter(|v| !v.is_empty()) {
        Some(dir) => PathBuf::from(dir),
        None => PathBuf::from(std::env::var_os("HOME")?).join(".config"),
    };
    Some(base.join("gigishell").join("notif-pendientes.json"))
}

fn id_de(valor: &Value) -> Option<u32> {
    valor.get("id")?.as_u64().and_then(|n| u32::try_from(n).ok())
}

/// Lee la lista. Un fichero que no existe es una lista vacía. Uno ilegible se aparta a
/// `.corrupto` en vez de pisarse: lo que hubiera dentro se puede recuperar a mano.
pub fn leer(ruta: &Path) -> Vec<Value> {
    let texto = match fs::read_to_string(ruta) {
        Ok(t) => t,
        Err(_) => return Vec::new(),
    };
    match serde_json::from_str::<Value>(&texto) {
        Ok(Value::Object(mut raiz)) => match raiz.remove("notificaciones") {
            Some(Value::Array(lista)) => lista.into_iter().filter(|v| id_de(v).is_some()).collect(),
            _ => Vec::new(),
        },
        _ => {
            let _ = fs::rename(ruta, ruta.with_extension("json.corrupto"));
            Vec::new()
        }
    }
}

pub fn contiene(lista: &[Value], id: u32) -> bool {
    lista.iter().any(|v| id_de(v) == Some(id))
}

/// Siguiente id libre. Empieza en 1 (el 0 es «no reemplaza nada» en el spec).
pub fn siguiente_id(lista: &[Value]) -> u32 {
    let max = lista.iter().filter_map(id_de).max().unwrap_or(0);
    if max == u32::MAX { 1 } else { max + 1 }
}

/// Inserta, o sustituye en su sitio si el id ya estaba, y aplica el tope quitando lo más viejo.
pub fn anadir(lista: &mut Vec<Value>, entrada: &Entrada) {
    let nueva = entrada.a_json();
    match lista.iter().position(|v| id_de(v) == Some(entrada.id)) {
        Some(i) => lista[i] = nueva,
        None => lista.push(nueva),
    }
    if lista.len() > TOPE {
        let sobra = lista.len() - TOPE;
        lista.drain(..sobra);
    }
}

pub fn quitar(lista: &mut Vec<Value>, id: u32) -> bool {
    let antes = lista.len();
    lista.retain(|v| id_de(v) != Some(id));
    lista.len() != antes
}

/// Escritura atómica (temporal + `rename`) con modo 0600: el contenido de las notificaciones es
/// personal (mensajes, correos).
pub fn escribir(ruta: &Path, lista: &[Value]) -> io::Result<()> {
    let dir = ruta.parent().ok_or_else(|| io::Error::other("ruta sin directorio"))?;
    fs::create_dir_all(dir)?;
    let texto = serde_json::to_vec(&json!({ "version": VERSION, "notificaciones": lista }))?;
    let temporal = ruta.with_extension("json.tmp");
    {
        let mut f = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&temporal)?;
        f.set_permissions(fs::Permissions::from_mode(0o600))?;
        f.write_all(&texto)?;
        f.sync_all()?;
    }
    fs::rename(&temporal, ruta)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entrada(id: u32, titulo: &str) -> Entrada {
        Entrada {
            id,
            app: "app".into(),
            icono: String::new(),
            titulo: titulo.into(),
            cuerpo: String::new(),
            urgencia: 1,
            hora_ms: 1000,
            expira: -1,
            hints: vec![("x-gigishell-event".into(), "usb.conectado".into())],
        }
    }

    fn dir_prueba(nombre: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("notif-respaldo-{}-{nombre}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn sustituye_en_su_sitio() {
        let mut lista = Vec::new();
        anadir(&mut lista, &entrada(1, "a"));
        anadir(&mut lista, &entrada(2, "b"));
        anadir(&mut lista, &entrada(1, "c"));
        assert_eq!(lista.len(), 2);
        assert_eq!(lista[0]["titulo"], "c");
    }

    #[test]
    fn el_tope_quita_lo_mas_viejo() {
        let mut lista = Vec::new();
        for id in 1..=(TOPE as u32 + 5) {
            anadir(&mut lista, &entrada(id, "x"));
        }
        assert_eq!(lista.len(), TOPE);
        assert_eq!(id_de(&lista[0]), Some(6));
    }

    #[test]
    fn ids_y_quitar() {
        let mut lista = Vec::new();
        assert_eq!(siguiente_id(&lista), 1);
        anadir(&mut lista, &entrada(7, "x"));
        assert_eq!(siguiente_id(&lista), 8);
        assert!(contiene(&lista, 7));
        assert!(quitar(&mut lista, 7));
        assert!(!quitar(&mut lista, 7));
    }

    #[test]
    fn recorta_sin_partir_caracteres() {
        assert_eq!(recortar("ñañaña", 3), "ñañ");
        let mut e = entrada(1, &"á".repeat(MAX_TITULO + 50));
        e.cuerpo = "b".repeat(MAX_CUERPO * 2);
        let v = e.a_json();
        assert_eq!(v["titulo"].as_str().unwrap().chars().count(), MAX_TITULO);
        assert_eq!(v["cuerpo"].as_str().unwrap().len(), MAX_CUERPO);
    }

    #[test]
    fn ida_y_vuelta_por_disco_con_0600() {
        let dir = dir_prueba("disco");
        let ruta = dir.join("notif-pendientes.json");
        assert!(leer(&ruta).is_empty());
        let mut lista = Vec::new();
        anadir(&mut lista, &entrada(1, "hola"));
        escribir(&ruta, &lista).unwrap();
        let leida = leer(&ruta);
        assert_eq!(leida.len(), 1);
        assert_eq!(leida[0]["hints"]["x-gigishell-event"], "usb.conectado");
        let modo = fs::metadata(&ruta).unwrap().permissions().mode() & 0o777;
        assert_eq!(modo, 0o600);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn un_fichero_corrupto_se_aparta() {
        let dir = dir_prueba("corrupto");
        fs::create_dir_all(&dir).unwrap();
        let ruta = dir.join("notif-pendientes.json");
        fs::write(&ruta, "{no es json").unwrap();
        assert!(leer(&ruta).is_empty());
        assert!(!ruta.exists());
        assert!(dir.join("notif-pendientes.json.corrupto").exists());
        let _ = fs::remove_dir_all(&dir);
    }
}
