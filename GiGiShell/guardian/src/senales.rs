// gigishell-guardian: SIGINT/SIGTERM por `signalfd`, para recogerlas en el
// bucle de eventos (poll/epoll) en vez de en un manejador asíncrono — desde el
// que no se podría parar limpio (E/S, bpffs) con seguridad.
use std::io;
use std::os::fd::RawFd;

/// Bloquea SIGINT/SIGTERM en este hilo (proceso de un solo hilo: basta con
/// esto) para poder recogerlas por `signalfd` en el `poll` del bucle
/// principal en vez de por un manejador asíncrono, que no podría llamar con
/// seguridad a `parar_limpio` (E/S, bpffs) desde el contexto de la señal.
pub fn bloquear() -> Result<libc::sigset_t, String> {
    unsafe {
        let mut mascara: libc::sigset_t = std::mem::zeroed();
        libc::sigemptyset(&mut mascara);
        libc::sigaddset(&mut mascara, libc::SIGINT);
        libc::sigaddset(&mut mascara, libc::SIGTERM);
        if libc::sigprocmask(libc::SIG_BLOCK, &mascara, std::ptr::null_mut()) != 0 {
            return Err(format!("sigprocmask: {}", io::Error::last_os_error()));
        }
        Ok(mascara)
    }
}

pub fn signalfd(mascara: &libc::sigset_t) -> Result<RawFd, String> {
    let fd = unsafe { libc::signalfd(-1, mascara, libc::SFD_CLOEXEC) };
    if fd < 0 {
        return Err(format!("signalfd: {}", io::Error::last_os_error()));
    }
    Ok(fd)
}
