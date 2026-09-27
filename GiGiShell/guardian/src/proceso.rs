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
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};

/// Identidad de un proceso resuelta desde `/proc`: su ejecutable (resolviendo el
/// symlink `/proc/<tgid>/exe`) y sus argumentos tal cual (`/proc/<tgid>/cmdline`
/// los separa con NUL; se conservan separados porque `script()` necesita saber
/// dónde acaba cada uno — unidos por espacios, un argumento con espacios sería
/// indistinguible de dos).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InfoProceso {
    pub tgid: u32,
    pub exe: PathBuf,
    pub args: Vec<String>,
}

/// Lee la identidad del proceso `tgid` desde `/proc`. `Err` si el proceso ya no
/// existe (terminó entre el evento del kernel y esta lectura: una carrera normal,
/// no un fallo) o si `/proc/<tgid>/exe` no se puede resolver (p.ej. un hilo de
/// kernel, que no tiene ejecutable de usuario).
pub fn leer(tgid: u32) -> io::Result<InfoProceso> {
    let exe = fs::read_link(format!("/proc/{tgid}/exe"))?;
    let cmdline_bytes = fs::read(format!("/proc/{tgid}/cmdline"))?;
    let args = cmdline_bytes
        .split(|&b| b == 0)
        .filter(|parte| !parte.is_empty())
        .map(|parte| String::from_utf8_lossy(parte).into_owned())
        .collect();

    Ok(InfoProceso { tgid, exe, args })
}

/// Intérpretes: a estos NUNCA se les concede «siempre», porque el permiso iría
/// al binario del intérprete y valdría para cualquier script que ejecute.
const INTERPRETES: &[&str] = &[
    "python", "node", "nodejs", "bash", "sh", "dash", "zsh", "fish", "perl", "ruby", "lua",
    "luajit", "gjs", "gjs-console", "bun", "deno", "java", "php",
];

/// ¿Es `exe` un intérprete? Se compara el nombre sin los dígitos y puntos
/// finales de la versión (`python3.14` ⇒ `python`, `lua5.4` ⇒ `lua`).
pub fn es_interprete(exe: &Path) -> bool {
    let Some(nombre) = exe.file_name().and_then(|n| n.to_str()) else {
        return false;
    };
    let base = nombre.trim_end_matches(|c: char| c.is_ascii_digit() || c == '.');
    INTERPRETES.contains(&base)
}

/// Máximo de caracteres del script que se muestra al usuario.
const MAX_SCRIPT: usize = 160;

/// Qué está ejecutando un intérprete, sacado de sus argumentos (`args[0]` es
/// el propio intérprete y se salta): el primer argumento que no es una opción
/// (el fichero del script) o, si antes aparece `-c`/`-e`/`--eval`/`-m`, esa
/// opción junto con el argumento que la sigue (código en línea o módulo).
/// Es un dato para que el usuario decida, no una identidad: no se puede fiar.
pub fn script(args: &[String]) -> Option<String> {
    let mut resto = args.iter().skip(1);
    while let Some(a) = resto.next() {
        if matches!(a.as_str(), "-c" | "-e" | "--eval" | "-m") {
            let texto = match resto.next() {
                Some(sig) => format!("{a} {sig}"),
                None => a.clone(),
            };
            return Some(recortar(texto));
        }
        if !a.starts_with('-') {
            return Some(recortar(a.clone()));
        }
    }
    None
}

fn recortar(texto: String) -> String {
    if texto.chars().count() <= MAX_SCRIPT {
        return texto;
    }
    let mut corto: String = texto.chars().take(MAX_SCRIPT - 1).collect();
    corto.push('…');
    corto
}

/// ¿Se puede aceptar en silencio que el inodo de este ejecutable haya cambiado
/// (una actualización del paquete)? Solo si vive bajo `/usr/`, es de root y ni
/// él ni su carpeta son escribibles por grupo u otros: nadie más que root pudo
/// haberlo sustituido. Uno en `$HOME` hace que se vuelva a preguntar.
pub fn exe_confiable(exe: &Path) -> bool {
    if !exe.starts_with("/usr/") {
        return false;
    }
    let de_root_y_cerrado = |p: &Path| {
        fs::metadata(p)
            .map(|m| m.uid() == 0 && m.mode() & 0o022 == 0)
            .unwrap_or(false)
    };
    de_root_y_cerrado(exe) && exe.parent().is_some_and(de_root_y_cerrado)
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
    fn interpretes_con_version_si_y_otros_no() {
        assert!(es_interprete(Path::new("/usr/bin/python3.14")));
        assert!(es_interprete(Path::new("/usr/bin/lua5.4")));
        assert!(es_interprete(Path::new("/usr/bin/gjs-console")));
        assert!(!es_interprete(Path::new("/usr/bin/evince")));
        assert!(!es_interprete(Path::new("/usr/bin/shred")));
    }

    fn v(xs: &[&str]) -> Vec<String> {
        xs.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn script_en_sus_cuatro_casos() {
        assert_eq!(
            script(&v(&["python3", "-u", "/tmp/robar.py", "x"])).as_deref(),
            Some("/tmp/robar.py")
        );
        assert_eq!(
            script(&v(&["bash", "-c", "cat ~/.env"])).as_deref(),
            Some("-c cat ~/.env")
        );
        assert_eq!(
            script(&v(&["python3", "-m", "http.server"])).as_deref(),
            Some("-m http.server")
        );
        assert_eq!(script(&v(&["python3"])), None);
    }

    #[test]
    fn script_largo_se_recorta() {
        let largo = "x".repeat(500);
        let s = script(&v(&["bash", "-c", &largo])).unwrap();
        assert_eq!(s.chars().count(), MAX_SCRIPT);
    }

    #[test]
    fn exe_confiable_en_usr_si_y_en_tempdir_no() {
        assert!(exe_confiable(Path::new("/usr/bin/ls")));
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("prog");
        fs::write(&f, "").unwrap();
        assert!(!exe_confiable(&f));
    }

    #[test]
    fn tgid_de_del_propio_hilo_es_el_pid() {
        let pid = std::process::id();
        // El hilo principal del proceso de test tiene tid == pid: no hace falta
        // levantar un hilo aparte para comprobar la traducción tid -> tgid.
        assert_eq!(tgid_de(pid).expect("tgid_de sobre el propio proceso"), pid);
    }
}
