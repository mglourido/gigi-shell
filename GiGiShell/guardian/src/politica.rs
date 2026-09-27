// gigishell-guardian: la política — qué ficheros están protegidos y quién
// puede hacer qué con cada uno. Vive en /var/lib/gigishell-guardian/politica.json
// (root, 600) y NUNCA en ~/.config/gigishell/: ahí cualquier proceso del usuario
// podría añadirse a sí mismo como permitido. AGS no toca este fichero; todo pasa
// por el socket.
//
// Los programas se guardan por RUTA del ejecutable, no por inodo: el inodo
// cambia en cada actualización del paquete. El daemon traduce la ruta a
// (dev, ino) al cargar los permisos en el BPF (ver daemon.rs).
use std::collections::BTreeMap;
use std::fs;
use std::io::{self, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::tipos::{BORRAR, LEER, MODIFICAR};

pub const VERSION: u32 = 1;

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ModoCategoria {
    Permitir,
    Preguntar,
    Silencio,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Estado {
    Activo,
    /// El fichero no está porque su disco no está montado: se conserva con sus
    /// permisos y se reactiva cuando el disco vuelve.
    NoDisponible,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct Permiso {
    pub programa: String,
    pub leer: bool,
    pub modificar: bool,
    pub borrar: bool,
    /// Segundos desde epoch en que se concedió por primera vez.
    pub desde: u64,
}

impl Permiso {
    pub fn mascara(&self) -> u8 {
        let mut m = 0u32;
        if self.leer {
            m |= LEER;
        }
        if self.modificar {
            m |= MODIFICAR;
        }
        if self.borrar {
            m |= BORRAR;
        }
        m as u8
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct Fichero {
    pub id: u32,
    pub ruta: String,
    /// `dev`/`ino` de la última vez que se vio el fichero: el `dev` es el de
    /// `stat()` (ver `fanotify::clave_de_fd`).
    pub dev: u64,
    pub ino: u64,
    /// `f_fsid` de `statvfs` del sistema de ficheros donde vive: identifica el
    /// DISCO (en btrfs, el subvolumen) de forma estable entre arranques, cosa
    /// que `dev` no hace (los devs anónimos de btrfs se reparten al montar). Es
    /// lo que decide si un fichero ausente se borró o solo tiene el disco
    /// desmontado (ver arranque.rs). 0 = desconocido.
    #[serde(default)]
    pub fsid: u64,
    pub estado: Estado,
    pub anadido: u64,
    pub categorias: BTreeMap<String, ModoCategoria>,
    pub permisos: Vec<Permiso>,
}

impl Fichero {
    /// Modo de la categoría `nombre` para este fichero: el propio si lo tiene,
    /// si no el valor por defecto de la política, y si tampoco, preguntar.
    pub fn modo_categoria(
        &self,
        nombre: &str,
        defecto: &BTreeMap<String, ModoCategoria>,
    ) -> ModoCategoria {
        self.categorias
            .get(nombre)
            .or_else(|| defecto.get(nombre))
            .copied()
            .unwrap_or(ModoCategoria::Preguntar)
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct Politica {
    pub version: u32,
    pub categorias_por_defecto: BTreeMap<String, ModoCategoria>,
    pub ficheros: Vec<Fichero>,
}

/// Valores de fábrica de las cinco categorías (ver el spec, §4).
pub fn categorias_fabrica() -> BTreeMap<String, ModoCategoria> {
    use ModoCategoria::*;
    [
        ("antivirus", Permitir),
        ("busqueda", Preguntar),
        ("copias", Preguntar),
        ("indexadores", Silencio),
        ("miniaturas", Silencio),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_string(), v))
    .collect()
}

impl Politica {
    pub fn nueva() -> Self {
        Politica {
            version: VERSION,
            categorias_por_defecto: categorias_fabrica(),
            ficheros: Vec::new(),
        }
    }

    /// Fichero ausente ⇒ política vacía. Fichero corrupto ⇒ ERROR, nunca una
    /// política vacía: arrancar vacío dejaría todo desprotegido sin avisar,
    /// mientras que no arrancar deja al BPF anclado denegando lo de siempre.
    pub fn cargar(ruta: &Path) -> Result<Self, String> {
        let texto = match fs::read_to_string(ruta) {
            Ok(t) => t,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Self::nueva()),
            Err(e) => return Err(format!("leyendo {}: {e}", ruta.display())),
        };
        let politica: Politica = serde_json::from_str(&texto)
            .map_err(|e| format!("{} está corrupta: {e}", ruta.display()))?;
        if politica.version != VERSION {
            return Err(format!(
                "{}: versión {} desconocida (se esperaba {VERSION})",
                ruta.display(),
                politica.version
            ));
        }
        Ok(politica)
    }

    pub fn guardar(&self, ruta: &Path) -> io::Result<()> {
        let mut texto = serde_json::to_string_pretty(self).map_err(io::Error::other)?;
        texto.push('\n');
        escribir_atomico(ruta, texto.as_bytes())
    }

    pub fn por_id(&self, id: u32) -> Option<&Fichero> {
        self.ficheros.iter().find(|f| f.id == id)
    }

    pub fn por_id_mut(&mut self, id: u32) -> Option<&mut Fichero> {
        self.ficheros.iter_mut().find(|f| f.id == id)
    }

    pub fn por_ruta(&self, ruta: &str) -> Option<&Fichero> {
        self.ficheros.iter().find(|f| f.ruta == ruta)
    }

    pub fn por_clave(&self, dev: u64, ino: u64) -> Option<&Fichero> {
        self.ficheros.iter().find(|f| f.dev == dev && f.ino == ino)
    }

    /// Protege `ruta` y devuelve su id. Idempotente por ruta: proteger dos
    /// veces la misma devuelve el mismo id (y refresca dev/ino). Un fichero
    /// nuevo arranca con una copia de las categorías por defecto.
    pub fn proteger(&mut self, ruta: &str, dev: u64, ino: u64, ahora: u64) -> u32 {
        if let Some(f) = self.ficheros.iter_mut().find(|f| f.ruta == ruta) {
            f.dev = dev;
            f.ino = ino;
            return f.id;
        }
        let id = self.ficheros.iter().map(|f| f.id).max().unwrap_or(0) + 1;
        self.ficheros.push(Fichero {
            id,
            ruta: ruta.to_string(),
            dev,
            ino,
            fsid: 0,
            estado: Estado::Activo,
            anadido: ahora,
            categorias: self.categorias_por_defecto.clone(),
            permisos: Vec::new(),
        });
        id
    }

    pub fn desproteger(&mut self, ruta: &str) -> Option<Fichero> {
        let pos = self.ficheros.iter().position(|f| f.ruta == ruta)?;
        Some(self.ficheros.remove(pos))
    }

    /// Añade `mascara` a lo que `programa` ya tuviera sobre el fichero `id`
    /// (OR: conceder leer no quita un modificar anterior).
    pub fn conceder(&mut self, id: u32, programa: &str, mascara: u8, ahora: u64) {
        let Some(f) = self.por_id_mut(id) else { return };
        let m = mascara as u32;
        match f.permisos.iter_mut().find(|p| p.programa == programa) {
            Some(p) => {
                p.leer |= m & LEER != 0;
                p.modificar |= m & MODIFICAR != 0;
                p.borrar |= m & BORRAR != 0;
            }
            None => {
                if m & (LEER | MODIFICAR | BORRAR) != 0 {
                    f.permisos.push(Permiso {
                        programa: programa.to_string(),
                        leer: m & LEER != 0,
                        modificar: m & MODIFICAR != 0,
                        borrar: m & BORRAR != 0,
                        desde: ahora,
                    });
                }
            }
        }
    }

    /// Fija exactamente lo que `programa` puede hacer (lo que manda Ajustes con
    /// sus casillas). Todo a falso ⇒ se quita el programa.
    pub fn fijar_permiso(
        &mut self,
        id: u32,
        programa: &str,
        leer: bool,
        modificar: bool,
        borrar: bool,
        ahora: u64,
    ) {
        let Some(f) = self.por_id_mut(id) else { return };
        if !leer && !modificar && !borrar {
            f.permisos.retain(|p| p.programa != programa);
            return;
        }
        match f.permisos.iter_mut().find(|p| p.programa == programa) {
            Some(p) => {
                p.leer = leer;
                p.modificar = modificar;
                p.borrar = borrar;
            }
            None => f.permisos.push(Permiso {
                programa: programa.to_string(),
                leer,
                modificar,
                borrar,
                desde: ahora,
            }),
        }
    }

    pub fn permiso_de(&self, id: u32, programa: &str) -> u8 {
        self.por_id(id)
            .and_then(|f| f.permisos.iter().find(|p| p.programa == programa))
            .map(Permiso::mascara)
            .unwrap_or(0)
    }
}

/// Escribe `datos` en `ruta` de forma atómica: fichero temporal en la misma
/// carpeta (modo 600 desde su creación, no después), `fsync` y `rename`. Un
/// corte a mitad deja el fichero viejo entero, nunca uno a medias — que al
/// arrancar contaría como corrupto y el daemon no arrancaría.
pub fn escribir_atomico(ruta: &Path, datos: &[u8]) -> io::Result<()> {
    let nombre = ruta
        .file_name()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "ruta sin nombre"))?;
    let mut temporal = ruta.to_path_buf();
    temporal.set_file_name(format!(".{}.tmp", nombre.to_string_lossy()));
    {
        let mut f = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&temporal)?;
        // `mode` solo aplica al crear: un temporal que quedó de un corte
        // anterior conservaría sus permisos viejos.
        f.set_permissions(fs::Permissions::from_mode(0o600))?;
        f.write_all(datos)?;
        f.sync_all()?;
    }
    fs::rename(&temporal, ruta)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn proteger_da_ids_distintos_es_idempotente_y_copia_categorias() {
        let mut p = Politica::nueva();
        let a = p.proteger("/h/a", 1, 10, 100);
        let b = p.proteger("/h/b", 1, 11, 100);
        assert_ne!(a, b);
        assert_eq!(p.proteger("/h/a", 1, 12, 200), a);
        assert_eq!(p.ficheros.len(), 2);
        let fa = p.por_id(a).unwrap();
        assert_eq!(fa.ino, 12, "proteger de nuevo refresca el inodo");
        assert_eq!(fa.anadido, 100);
        assert_eq!(fa.categorias, categorias_fabrica());
    }

    #[test]
    fn por_clave_encuentra_por_dev_e_ino() {
        let mut p = Politica::nueva();
        let a = p.proteger("/h/a", 7, 10, 0);
        assert_eq!(p.por_clave(7, 10).map(|f| f.id), Some(a));
        assert!(p.por_clave(8, 10).is_none());
        assert!(p.por_ruta("/h/a").is_some());
    }

    #[test]
    fn conceder_acumula_fijar_sustituye_y_vacio_borra() {
        let mut p = Politica::nueva();
        let a = p.proteger("/h/a", 1, 10, 0);
        p.conceder(a, "/usr/bin/x", LEER as u8, 5);
        p.conceder(a, "/usr/bin/x", MODIFICAR as u8, 6);
        assert_eq!(p.permiso_de(a, "/usr/bin/x"), (LEER | MODIFICAR) as u8);
        assert_eq!(p.por_id(a).unwrap().permisos[0].desde, 5);

        p.fijar_permiso(a, "/usr/bin/x", false, false, true, 7);
        assert_eq!(p.permiso_de(a, "/usr/bin/x"), BORRAR as u8);

        p.fijar_permiso(a, "/usr/bin/x", false, false, false, 8);
        assert_eq!(p.permiso_de(a, "/usr/bin/x"), 0);
        assert!(p.por_id(a).unwrap().permisos.is_empty());
    }

    #[test]
    fn desproteger_devuelve_el_fichero() {
        let mut p = Politica::nueva();
        p.proteger("/h/a", 1, 10, 0);
        assert_eq!(p.desproteger("/h/a").map(|f| f.ino), Some(10));
        assert!(p.desproteger("/h/a").is_none());
    }

    #[test]
    fn guardar_y_cargar_ida_y_vuelta_con_modo_600() {
        let dir = tempfile::tempdir().unwrap();
        let ruta = dir.path().join("politica.json");
        let mut p = Politica::nueva();
        let a = p.proteger("/h/a", 1, 10, 0);
        p.conceder(a, "/usr/bin/x", LEER as u8, 5);
        p.guardar(&ruta).unwrap();

        let modo = fs::metadata(&ruta).unwrap().permissions().mode() & 0o777;
        assert_eq!(modo, 0o600);
        assert_eq!(Politica::cargar(&ruta).unwrap(), p);
    }

    #[test]
    fn ausente_es_nueva_y_corrupta_es_error() {
        let dir = tempfile::tempdir().unwrap();
        let ruta = dir.path().join("politica.json");
        assert_eq!(Politica::cargar(&ruta).unwrap(), Politica::nueva());
        fs::write(&ruta, "{ esto no es json").unwrap();
        assert!(Politica::cargar(&ruta).is_err());
    }

    #[test]
    fn modo_categoria_cae_al_defecto_y_luego_a_preguntar() {
        let mut p = Politica::nueva();
        let a = p.proteger("/h/a", 1, 10, 0);
        let f = p.por_id_mut(a).unwrap();
        f.categorias.remove("antivirus");
        f.categorias.insert("busqueda".into(), ModoCategoria::Silencio);
        let f = p.por_id(a).unwrap();
        let def = &p.categorias_por_defecto;
        assert_eq!(f.modo_categoria("busqueda", def), ModoCategoria::Silencio);
        assert_eq!(f.modo_categoria("antivirus", def), ModoCategoria::Permitir);
        assert_eq!(f.modo_categoria("inventada", def), ModoCategoria::Preguntar);
    }

    #[test]
    fn serializa_estado_en_kebab_case() {
        assert_eq!(
            serde_json::to_string(&Estado::NoDisponible).unwrap(),
            "\"no-disponible\""
        );
    }
}
