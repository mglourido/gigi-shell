// gigishell-guardian: el socket con AGS (/run/gigishell-guardian.sock).
//
// Medidas básicas, a propósito: el modelo de amenaza (spec §1) es software
// genérico que lee ficheros por ruta, no malware escrito contra este shell.
// - El socket es del UID del usuario y modo 600 (umask 177 durante el bind, no
//   un chmod después: entre bind y chmod habría un instante con otro modo).
// - Al aceptar se mira SO_PEERCRED: mismo UID, exe /usr/bin/gjs-console y un
//   argumento que termina en /ags.js. Si no, se cierra y se apunta en el log.
// - UN SOLO cliente: mientras AGS está conectado, cualquier otra conexión se
//   cierra en el acto (así otro proceso no puede colarse a contestar preguntas).
//
// Lecturas no bloqueantes (el daemon multiplexa con epoll); escrituras
// bloqueantes con un tope de 1 s: los avisos son pequeños y un AGS colgado
// no debe congelar el daemon — si no traga en 1 s, se le desconecta.
use std::fs;
use std::io::{self, Write};
use std::os::fd::{AsRawFd, RawFd};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::protocolo::{serializar, Aviso};

pub const RUTA: &str = "/run/gigishell-guardian.sock";
const EXE_AGS: &str = "/usr/bin/gjs-console";
/// Una línea sin terminar que pase de esto es basura o un abuso: se corta.
const MAX_BUFFER: usize = 1 << 20;

/// ¿Es este par el AGS del usuario?
pub fn peer_valido(uid_peer: u32, uid: u32, exe: &Path, args: &[String]) -> bool {
    uid_peer == uid && exe == Path::new(EXE_AGS) && args.iter().any(|a| a.ends_with("/ags.js"))
}

pub struct Servidor {
    ruta: PathBuf,
    escucha: UnixListener,
    cliente: Option<UnixStream>,
    buffer: Vec<u8>,
    /// `None` = no se valida el par (solo tests).
    uid: Option<u32>,
}

impl Servidor {
    pub fn nuevo(ruta: &Path, uid: u32) -> io::Result<Self> {
        let s = Self::crear(ruta, Some(uid))?;
        let c = std::ffi::CString::new(ruta.as_os_str().as_encoded_bytes())
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "ruta con NUL"))?;
        if unsafe { libc::chown(c.as_ptr(), uid, u32::MAX) } != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(s)
    }

    #[cfg(test)]
    pub fn nuevo_sin_validar(ruta: &Path) -> io::Result<Self> {
        Self::crear(ruta, None)
    }

    fn crear(ruta: &Path, uid: Option<u32>) -> io::Result<Self> {
        // Un socket que quedó de una ejecución anterior (caída) impide el bind.
        match fs::remove_file(ruta) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => return Err(e),
        }
        let viejo = unsafe { libc::umask(0o177) };
        let escucha = UnixListener::bind(ruta);
        unsafe { libc::umask(viejo) };
        let escucha = escucha?;
        // Por si el umask no se aplicó (p.ej. un sistema de ficheros raro).
        fs::set_permissions(ruta, fs::Permissions::from_mode(0o600))?;
        escucha.set_nonblocking(true)?;
        Ok(Servidor { ruta: ruta.to_path_buf(), escucha, cliente: None, buffer: Vec::new(), uid })
    }

    pub fn fd_escucha(&self) -> RawFd {
        self.escucha.as_raw_fd()
    }

    pub fn fd_cliente(&self) -> Option<RawFd> {
        self.cliente.as_ref().map(|c| c.as_raw_fd())
    }

    pub fn hay_cliente(&self) -> bool {
        self.cliente.is_some()
    }

    /// Acepta las conexiones en espera. `true` si ahora hay un cliente NUEVO
    /// válido. Las que sobran (ya había uno) o no son AGS se cierran.
    pub fn aceptar(&mut self) -> bool {
        let mut nuevo = false;
        loop {
            let stream = match self.escucha.accept() {
                Ok((s, _)) => s,
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => return nuevo,
                Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                Err(e) => {
                    eprintln!("gigishell-guardian: accept: {e}");
                    return nuevo;
                }
            };
            if self.cliente.is_some() {
                eprintln!("gigishell-guardian: conexión rechazada: ya hay un cliente");
                continue;
            }
            if let Some(uid) = self.uid {
                if let Err(motivo) = validar(&stream, uid) {
                    eprintln!("gigishell-guardian: conexión rechazada: {motivo}");
                    continue;
                }
            }
            if stream.set_write_timeout(Some(Duration::from_secs(1))).is_err() {
                continue;
            }
            self.cliente = Some(stream);
            self.buffer.clear();
            nuevo = true;
        }
    }

    /// Lee lo que haya. `Some(lineas completas)` (puede estar vacío) o `None`
    /// si el cliente se desconectó (o se le cortó por abuso).
    pub fn leer(&mut self) -> Option<Vec<String>> {
        let fd = self.cliente.as_ref()?.as_raw_fd();
        let mut trozo = [0u8; 8192];
        loop {
            let n = unsafe {
                libc::recv(fd, trozo.as_mut_ptr() as *mut libc::c_void, trozo.len(), libc::MSG_DONTWAIT)
            };
            if n == 0 {
                self.desconectar();
                return None;
            }
            if n < 0 {
                let e = io::Error::last_os_error();
                match e.kind() {
                    io::ErrorKind::WouldBlock => break,
                    io::ErrorKind::Interrupted => continue,
                    _ => {
                        self.desconectar();
                        return None;
                    }
                }
            }
            self.buffer.extend_from_slice(&trozo[..n as usize]);
            if self.buffer.len() > MAX_BUFFER {
                eprintln!("gigishell-guardian: cliente cortado: más de 1 MiB sin fin de línea");
                self.desconectar();
                return None;
            }
        }
        let mut lineas = Vec::new();
        while let Some(pos) = self.buffer.iter().position(|&b| b == b'\n') {
            let linea: Vec<u8> = self.buffer.drain(..=pos).collect();
            let texto = String::from_utf8_lossy(&linea[..linea.len() - 1]).trim().to_string();
            if !texto.is_empty() {
                lineas.push(texto);
            }
        }
        Some(lineas)
    }

    /// Manda un aviso al cliente. `false` si no hay cliente o si la escritura
    /// falló (en ese caso se le desconecta).
    pub fn enviar(&mut self, aviso: &Aviso) -> bool {
        let Some(c) = self.cliente.as_mut() else { return false };
        if c.write_all(serializar(aviso).as_bytes()).is_err() {
            self.desconectar();
            return false;
        }
        true
    }

    fn desconectar(&mut self) {
        self.cliente = None;
        self.buffer.clear();
    }
}

impl Drop for Servidor {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.ruta);
    }
}

fn validar(stream: &UnixStream, uid: u32) -> Result<(), String> {
    let mut cred = libc::ucred { pid: 0, uid: 0, gid: 0 };
    let mut len = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    let r = unsafe {
        libc::getsockopt(
            stream.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            &mut cred as *mut _ as *mut libc::c_void,
            &mut len,
        )
    };
    if r != 0 {
        return Err(format!("SO_PEERCRED: {}", io::Error::last_os_error()));
    }
    let pid = cred.pid as u32;
    let info = crate::proceso::leer(pid).map_err(|e| format!("pid {pid}: {e}"))?;
    if peer_valido(cred.uid, uid, &info.exe, &info.args) {
        Ok(())
    } else {
        Err(format!("pid {pid}, uid {}, {}", cred.uid, info.exe.display()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    fn v(xs: &[&str]) -> Vec<String> {
        xs.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn peer_valido_acepta_ags_y_rechaza_lo_demas() {
        let ags = v(&["gjs", "-m", "/run/user/1000/ags.js"]);
        let gjs = Path::new("/usr/bin/gjs-console");
        assert!(peer_valido(1000, 1000, gjs, &ags));
        assert!(!peer_valido(1001, 1000, gjs, &ags));
        assert!(!peer_valido(1000, 1000, Path::new("/usr/bin/socat"), &ags));
        assert!(!peer_valido(1000, 1000, gjs, &v(&["gjs", "-m", "/tmp/otro.js"])));
    }

    #[test]
    fn un_solo_cliente_lineas_partidas_y_desconexion() {
        let dir = tempfile::tempdir().unwrap();
        let ruta = dir.path().join("s.sock");
        let mut s = Servidor::nuevo_sin_validar(&ruta).unwrap();
        let modo = fs::metadata(&ruta).unwrap().permissions().mode() & 0o777;
        assert_eq!(modo, 0o600);

        let mut a = UnixStream::connect(&ruta).unwrap();
        assert!(s.aceptar());
        assert!(s.hay_cliente());

        let mut b = UnixStream::connect(&ruta).unwrap();
        assert!(!s.aceptar(), "el segundo cliente se rechaza");
        let mut resto = Vec::new();
        b.read_to_end(&mut resto).unwrap();
        assert!(resto.is_empty(), "al rechazado se le cierra la conexión");

        a.write_all(b"{\"op\":\"li").unwrap();
        assert_eq!(s.leer(), Some(vec![]));
        a.write_all(b"sta\"}\n{\"op\":\"estado\"}\n").unwrap();
        assert_eq!(
            s.leer(),
            Some(vec!["{\"op\":\"lista\"}".to_string(), "{\"op\":\"estado\"}".to_string()])
        );

        assert!(s.enviar(&Aviso::Cambio));
        let mut buf = [0u8; 64];
        let n = a.read(&mut buf).unwrap();
        assert_eq!(&buf[..n], b"{\"ev\":\"cambio\"}\n");

        drop(a);
        assert_eq!(s.leer(), None);
        assert!(!s.hay_cliente());

        drop(s);
        assert!(!ruta.exists(), "el socket se borra al soltar el servidor");
    }
}
