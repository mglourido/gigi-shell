// gigishell-guardian: identidad de un proceso a partir de /proc, para atribuir
// eventos de fanotify/BPF a un ejecutable y a su línea de órdenes.
//
// Por qué por /proc y no por una syscall directa: fanotify con FAN_REPORT_TID
// entrega el TID del HILO que abrió el fichero, no el TGID del proceso — pero los
// permisos por ejecutable/proceso de los mapas BPF (Tarea 2) se conceden por TGID.
// `tgid_de` hace esa traducción leyendo `/proc/<tid>/status` (campo `Tgid:`): no
// hay una syscall que responda "tgid del hilo X" vista desde otro proceso, /proc
// es la única fuente.

use std::fs;
use std::io;
use std::path::PathBuf;

/// Identidad de un proceso resuelta desde `/proc`: su ejecutable (resolviendo el
/// symlink `/proc/<tgid>/exe`) y su línea de órdenes completa. `/proc/<tgid>/cmdline`
/// separa los argumentos con NUL en vez de espacios; aquí se reconstruye uniendo
/// con un espacio para que sea legible en una notificación al usuario.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InfoProceso {
    pub tgid: u32,
    pub exe: PathBuf,
    pub cmdline: String,
}

/// Lee la identidad del proceso `tgid` desde `/proc`. `Err` si el proceso ya no
/// existe (terminó entre el evento del kernel y esta lectura: una carrera normal,
/// no un fallo) o si `/proc/<tgid>/exe` no se puede resolver (p.ej. un hilo de
/// kernel, que no tiene ejecutable de usuario).
pub fn leer(tgid: u32) -> io::Result<InfoProceso> {
    let exe = fs::read_link(format!("/proc/{tgid}/exe"))?;
    let cmdline_bytes = fs::read(format!("/proc/{tgid}/cmdline"))?;
    let cmdline = cmdline_bytes
        .split(|&b| b == 0)
        .filter(|parte| !parte.is_empty())
        .map(|parte| String::from_utf8_lossy(parte).into_owned())
        .collect::<Vec<_>>()
        .join(" ");

    Ok(InfoProceso { tgid, exe, cmdline })
}

/// Traduce un TID (hilo) a su TGID (proceso), leyendo `/proc/<tid>/status`. Es la
/// operación que necesita el bucle de fanotify: el evento trae un TID (por
/// `FAN_REPORT_TID`) y los mapas de permisos de BPF están indexados por TGID.
pub fn tgid_de(tid: u32) -> io::Result<u32> {
    let contenido = fs::read_to_string(format!("/proc/{tid}/status"))?;
    for linea in contenido.lines() {
        if let Some(resto) = linea.strip_prefix("Tgid:") {
            return resto.trim().parse::<u32>().map_err(|_| {
                io::Error::new(io::ErrorKind::InvalidData, "Tgid: no es un número")
            });
        }
    }
    Err(io::Error::new(
        io::ErrorKind::InvalidData,
        "/proc/<tid>/status sin campo Tgid",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn leer_del_propio_proceso_de_test_tiene_exe_no_vacio() {
        let pid = std::process::id();
        let info = leer(pid).expect("el propio proceso de test siempre existe");
        assert!(!info.exe.as_os_str().is_empty());
        assert_eq!(info.tgid, pid);
    }

    #[test]
    fn tgid_de_del_propio_hilo_es_el_pid() {
        let pid = std::process::id();
        // El hilo principal del proceso de test tiene tid == pid: no hace falta
        // levantar un hilo aparte para comprobar la traducción tid -> tgid.
        assert_eq!(tgid_de(pid).expect("tgid_de sobre el propio proceso"), pid);
    }
}
