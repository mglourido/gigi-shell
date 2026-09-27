// gigishell-guardian: reconciliación de la política con el disco al arrancar
// (y cuando cambian los montajes). Por cada fichero de la política:
// - existe ⇒ se refresca su (dev, ino) — un editor pudo reemplazarlo con el
//   daemon apagado: manda la RUTA — y queda activo;
// - no existe y su disco no está montado ⇒ no-disponible, conserva permisos;
// - no existe con su disco montado ⇒ se borró de verdad: se retira.
//
// «Su disco está montado» se decide por el `f_fsid` de `statvfs`, NO por el
// `dev`: en btrfs cada subvolumen tiene un dev ANÓNIMO que se reparte al
// montar y no es estable entre arranques, y los majors/minors de mountinfo son
// los del superbloque (compartido por todos los subvolúmenes). El fsid de btrfs
// sale del UUID del sistema de ficheros y del id del subvolumen: estable y
// distinto por subvolumen (medido en esta máquina: /home y /usr dan fsid
// distintos). La carpeta existente más cercana del fichero ausente se compara
// con el fsid guardado: si coincide, el disco está ahí y el fichero se borró.
use std::ffi::CString;
use std::io;
use std::mem::MaybeUninit;
use std::path::Path;

use crate::fanotify;
use crate::historial::{Entrada, Resultado};
use crate::politica::{Estado, Fichero, Politica};
use crate::tipos::ClaveInodo;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Situacion {
    Existe { clave: ClaveInodo, fsid: u64 },
    Ausente { disco_montado: bool },
}

/// Aplica `sondear` a cada fichero y devuelve las entradas de historial de
/// los que se retiraron. `ahora` en segundos desde epoch.
pub fn reconciliar(
    politica: &mut Politica,
    mut sondear: impl FnMut(&Fichero) -> Situacion,
    ahora: u64,
) -> Vec<Entrada> {
    let mut retirados = Vec::new();
    politica.ficheros.retain_mut(|f| match sondear(f) {
        Situacion::Existe { clave, fsid } => {
            f.dev = clave.dev;
            f.ino = clave.ino;
            f.fsid = fsid;
            f.estado = Estado::Activo;
            true
        }
        Situacion::Ausente { disco_montado: false } => {
            f.estado = Estado::NoDisponible;
            true
        }
        Situacion::Ausente { disco_montado: true } => {
            retirados.push(Entrada {
                fecha: ahora,
                ruta: f.ruta.clone(),
                programa: String::new(),
                pid: 0,
                script: None,
                operacion: "retirar".to_string(),
                resultado: Resultado::Retirado,
            });
            false
        }
    });
    retirados
}

/// Sondeo de verdad contra el disco. Solo cuenta como «existe» un fichero
/// regular (no un symlink que alguien haya dejado en su sitio). Un error que no
/// sea «no existe» (p.ej. permisos) se trata como disco no disponible: ante la
/// duda se conserva, nunca se retira.
pub fn sondear_real(f: &Fichero) -> Situacion {
    let ruta = Path::new(&f.ruta);
    match std::fs::symlink_metadata(ruta) {
        Ok(m) if m.file_type().is_file() => match (fanotify::clave_de_ruta(ruta), fsid(ruta)) {
            (Ok(clave), Ok(fsid)) => Situacion::Existe { clave, fsid },
            _ => Situacion::Ausente { disco_montado: false },
        },
        Ok(_) => Situacion::Ausente { disco_montado: disco_montado(ruta, f.fsid) },
        Err(e) if matches!(e.raw_os_error(), Some(libc::ENOENT) | Some(libc::ENOTDIR)) => {
            Situacion::Ausente { disco_montado: disco_montado(ruta, f.fsid) }
        }
        Err(_) => Situacion::Ausente { disco_montado: false },
    }
}

/// ¿Está montado el disco donde vivía `ruta`? Sí si la carpeta existente más
/// cercana está en el mismo sistema de ficheros (`fsid`). Con fsid 0
/// (desconocido) se responde que no: sin saber cuál era su disco, retirar el
/// fichero podría ser un error; conservarlo como no-disponible nunca lo es.
pub fn disco_montado(ruta: &Path, fsid_guardado: u64) -> bool {
    if fsid_guardado == 0 {
        return false;
    }
    let mut actual = ruta.parent();
    while let Some(dir) = actual {
        if dir.is_dir() {
            return fsid(dir).is_ok_and(|f| f == fsid_guardado);
        }
        actual = dir.parent();
    }
    false
}

/// `f_fsid` de `statvfs(ruta)`.
pub fn fsid(ruta: &Path) -> io::Result<u64> {
    let c = CString::new(ruta.as_os_str().as_encoded_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "ruta con NUL incrustado"))?;
    let mut buf: MaybeUninit<libc::statvfs> = MaybeUninit::zeroed();
    if unsafe { libc::statvfs(c.as_ptr(), buf.as_mut_ptr()) } != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: statvfs devolvió éxito, la struct está rellena.
    Ok(unsafe { buf.assume_init() }.f_fsid as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reconciliar_los_tres_casos_en_una_politica() {
        let mut p = Politica::nueva();
        p.proteger("/existe", 1, 1, 0);
        p.proteger("/desmontado", 1, 2, 0);
        p.proteger("/borrado", 1, 3, 0);
        let retirados = reconciliar(
            &mut p,
            |f| match f.ruta.as_str() {
                "/existe" => Situacion::Existe { clave: ClaveInodo { dev: 9, ino: 99 }, fsid: 5 },
                "/desmontado" => Situacion::Ausente { disco_montado: false },
                _ => Situacion::Ausente { disco_montado: true },
            },
            42,
        );
        assert_eq!(retirados.len(), 1);
        assert_eq!(retirados[0].ruta, "/borrado");
        assert_eq!(retirados[0].resultado, Resultado::Retirado);
        let e = p.por_ruta("/existe").unwrap();
        assert_eq!((e.dev, e.ino, e.fsid, e.estado), (9, 99, 5, Estado::Activo));
        assert_eq!(p.por_ruta("/desmontado").unwrap().estado, Estado::NoDisponible);
        assert!(p.por_ruta("/borrado").is_none());
    }

    #[test]
    fn un_no_disponible_que_reaparece_vuelve_a_activo() {
        let mut p = Politica::nueva();
        p.proteger("/usb/a", 1, 1, 0);
        reconciliar(&mut p, |_| Situacion::Ausente { disco_montado: false }, 0);
        assert_eq!(p.ficheros[0].estado, Estado::NoDisponible);
        reconciliar(
            &mut p,
            |_| Situacion::Existe { clave: ClaveInodo { dev: 1, ino: 1 }, fsid: 1 },
            0,
        );
        assert_eq!(p.ficheros[0].estado, Estado::Activo);
    }

    #[test]
    fn sondeo_real_existe_borrado_y_disco_ajeno() {
        let dir = tempfile::tempdir().unwrap();
        let ruta = dir.path().join("f");
        std::fs::write(&ruta, "x").unwrap();
        let mut p = Politica::nueva();
        let id = p.proteger(ruta.to_str().unwrap(), 0, 0, 0);

        let Situacion::Existe { fsid: f, .. } = sondear_real(p.por_id(id).unwrap()) else {
            panic!("el fichero existe");
        };
        p.por_id_mut(id).unwrap().fsid = f;

        std::fs::remove_file(&ruta).unwrap();
        assert_eq!(
            sondear_real(p.por_id(id).unwrap()),
            Situacion::Ausente { disco_montado: true },
            "borrado con su disco presente"
        );

        p.por_id_mut(id).unwrap().fsid = f ^ 1;
        assert_eq!(
            sondear_real(p.por_id(id).unwrap()),
            Situacion::Ausente { disco_montado: false },
            "la carpeta más cercana está en otro disco"
        );

        p.por_id_mut(id).unwrap().fsid = 0;
        assert!(!disco_montado(&ruta, 0), "fsid desconocido nunca retira");
    }
}
