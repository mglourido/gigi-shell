//! Lectura del journal por FFI directa a libsystemd (sd-journal(3)).
//!
//! Sustituye a los DOS `journalctl -f` de oom-monitor.sh por un único descriptor:
//! las dos suscripciones (kernel y los identificadores de auth/systemd) se expresan
//! como una disyunción de matches, así que es un solo proceso y un solo inotify
//! sobre /var/log/journal en vez de dos pipes con su subshell cada uno.

use std::ffi::{c_char, c_int, c_void, CString};
use std::ptr;

#[repr(C)]
struct SdJournal {
    _private: [u8; 0],
}

extern "C" {
    fn sd_journal_open(ret: *mut *mut SdJournal, flags: c_int) -> c_int;
    fn sd_journal_close(j: *mut SdJournal);
    fn sd_journal_add_match(j: *mut SdJournal, data: *const c_void, size: usize) -> c_int;
    fn sd_journal_add_disjunction(j: *mut SdJournal) -> c_int;
    fn sd_journal_seek_tail(j: *mut SdJournal) -> c_int;
    fn sd_journal_previous(j: *mut SdJournal) -> c_int;
    fn sd_journal_next(j: *mut SdJournal) -> c_int;
    fn sd_journal_wait(j: *mut SdJournal, timeout_usec: u64) -> c_int;
    fn sd_journal_get_data(
        j: *mut SdJournal,
        field: *const c_char,
        data: *mut *const c_void,
        length: *mut usize,
    ) -> c_int;
}

const SD_JOURNAL_LOCAL_ONLY: c_int = 1;

/// Identificadores que seguía `journalctl -t …` en monitor_system. `sshd-session` es
/// nuevo: desde OpenSSH 9.8 los "Failed password" los emite ese binario y no `sshd`,
/// así que con `-t sshd` a secas esos eventos no llegaban nunca.
pub const IDENTIFICADORES: &[&str] = &[
    "sudo",
    "sshd",
    "sshd-session",
    "su",
    "pkexec",
    "polkitd",
    "systemd",
    "systemd-coredump",
];

/// Una entrada ya reducida a lo que usan las reglas.
pub struct Entrada {
    pub kernel: bool,
    /// La línea reconstruida con el mismo prefijo que imprimía `journalctl` en formato
    /// `short` (sin fecha ni host): `kernel: <msg>` o `<ident>[<pid>]: <msg>`. Las reglas
    /// heredadas del bash casan contra ese prefijo (p. ej. "sudo" o "sshd" en la línea),
    /// así que quitarlo cambiaría qué se detecta.
    pub linea: String,
}

pub struct Journal {
    j: *mut SdJournal,
}

impl Journal {
    pub fn abrir() -> Result<Self, String> {
        let mut j = ptr::null_mut();
        let r = unsafe { sd_journal_open(&mut j, SD_JOURNAL_LOCAL_ONLY) };
        if r < 0 {
            return Err(format!("sd_journal_open: {}", errno(r)));
        }
        let mut jr = Journal { j };
        jr.anadir_match("_TRANSPORT=kernel")?;
        let r = unsafe { sd_journal_add_disjunction(jr.j) };
        if r < 0 {
            return Err(format!("sd_journal_add_disjunction: {}", errno(r)));
        }
        // Mismo campo repetido = OR dentro del grupo.
        for id in IDENTIFICADORES {
            jr.anadir_match(&format!("SYSLOG_IDENTIFIER={id}"))?;
        }
        // Equivalente a `-n 0`: colocarse en la ÚLTIMA entrada existente para que
        // `next()` solo devuelva lo que llegue a partir de ahora. Reprocesar el backlog
        // reenviaría avisos viejos en cada inicio de sesión.
        unsafe {
            sd_journal_seek_tail(jr.j);
            sd_journal_previous(jr.j);
        }
        Ok(jr)
    }

    fn anadir_match(&mut self, m: &str) -> Result<(), String> {
        let r = unsafe { sd_journal_add_match(self.j, m.as_ptr().cast(), m.len()) };
        if r < 0 {
            return Err(format!("sd_journal_add_match({m}): {}", errno(r)));
        }
        Ok(())
    }

    /// Siguiente entrada disponible, o `None` si no hay nada nuevo todavía.
    pub fn siguiente(&mut self) -> Result<Option<Entrada>, String> {
        let r = unsafe { sd_journal_next(self.j) };
        if r < 0 {
            return Err(format!("sd_journal_next: {}", errno(r)));
        }
        if r == 0 {
            return Ok(None);
        }
        let msg = self.campo("MESSAGE").unwrap_or_default();
        let kernel = self.campo("_TRANSPORT").as_deref() == Some("kernel");
        let linea = if kernel {
            format!("kernel: {msg}")
        } else {
            let ident = self.campo("SYSLOG_IDENTIFIER").unwrap_or_else(|| "?".into());
            match self.campo("_PID").or_else(|| self.campo("SYSLOG_PID")) {
                Some(pid) => format!("{ident}[{pid}]: {msg}"),
                None => format!("{ident}: {msg}"),
            }
        };
        Ok(Some(Entrada { kernel, linea }))
    }

    /// Bloquea hasta que el journal cambie o venza el plazo. `None` = sin plazo, que
    /// es el estado de reposo: sin nada encolado no hay ningún temporizador vivo.
    pub fn esperar(&mut self, plazo_us: Option<u64>) -> Result<(), String> {
        let r = unsafe { sd_journal_wait(self.j, plazo_us.unwrap_or(u64::MAX)) };
        if r < 0 && r != -libc::EINTR {
            return Err(format!("sd_journal_wait: {}", errno(r)));
        }
        Ok(())
    }

    fn campo(&self, nombre: &str) -> Option<String> {
        let c = CString::new(nombre).ok()?;
        let mut data: *const c_void = ptr::null();
        let mut len: usize = 0;
        let r = unsafe { sd_journal_get_data(self.j, c.as_ptr(), &mut data, &mut len) };
        if r < 0 || data.is_null() {
            return None;
        }
        // sd-journal devuelve "CAMPO=valor"; el valor puede no ser UTF-8 válido.
        let bytes = unsafe { std::slice::from_raw_parts(data.cast::<u8>(), len) };
        let valor = bytes.get(nombre.len() + 1..)?;
        Some(String::from_utf8_lossy(valor).into_owned())
    }
}

impl Drop for Journal {
    fn drop(&mut self) {
        unsafe { sd_journal_close(self.j) }
    }
}

fn errno(r: c_int) -> String {
    std::io::Error::from_raw_os_error(-r).to_string()
}
