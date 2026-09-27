// gigishell-guardian: modo `--depurar <fichero>` — protege UN solo fichero
// (id interno `fichero = 1`, fijo: no hace falta un asignador de ids para
// depurar un caso a la vez) y saca por stdout, línea a línea y en un formato
// pensado para que `pruebas/riesgos.sh` lo parsee con `grep`, todo lo que pasa
// por el BPF y por fanotify. No es el daemon (eso es la Fase 2): es la
// herramienta con la que el DUEÑO de esta máquina, con sudo, comprueba a mano
// los cinco riesgos de diseño (orden LSM→fanotify, caída del proceso, guardado
// atómico, interbloqueos, coste) antes de construir el daemon de verdad encima.
//
// Bucle de eventos: un único `poll(2)` sobre tres fds —fanotify, el fd de
// epoll que expone el ring buffer de libbpf, y un `signalfd` con SIGINT/SIGTERM
// bloqueadas por `sigprocmask`— sin hilos. Igual que el resto del crate: un
// proceso más simple es un proceso con menos formas de dejar a medias el
// estado de los mapas BPF.
use std::cell::RefCell;
use std::io::{self, Write};
use std::os::fd::{AsFd, AsRawFd, RawFd};
use std::path::PathBuf;
use std::rc::Rc;
use std::time::Duration;

use crate::bpf;
use crate::fanotify;
use crate::proceso;
use crate::senales;
use crate::tipos;

/// Id interno fijo del único fichero que este modo protege. El daemon de
/// verdad (Fase 2) tendrá que asignar ids a varios ficheros; aquí no hace
/// falta: siempre hay como mucho uno.
const FICHERO: u32 = 1;

/// Punto de entrada de `--depurar`. `args` es todo lo que sigue a `--depurar`
/// en la línea de órdenes: `<fichero> [--auto permitir|denegar] [--conceder
/// <exe>:<mascara>]…`.
pub fn ejecutar(args: &[String]) -> Result<(), String> {
    let (ruta, auto, concesiones) = parsear_args(args)?;

    // Las señales se bloquean ANTES de cargar nada: si SIGTERM llega entre
    // cargar el BPF y montar el signalfd, con la máscara ya bloqueada el
    // kernel la deja pendiente en vez de matar el proceso con el manejador
    // por defecto — se recoge en la primera vuelta del `poll` de más abajo,
    // no se pierde.
    let mascara_senales = senales::bloquear()?;
    let fd_senales = senales::signalfd(&mascara_senales)?;

    // GUARDIAN_LIBBPF_DEBUG=1: volcar el log completo de libbpf (y del
    // verificador) a stderr; sin él, un fallo de carga solo dice el errno.
    if std::env::var_os("GUARDIAN_LIBBPF_DEBUG").is_some() {
        libbpf_rs::set_print(Some((libbpf_rs::PrintLevel::Debug, |_, msg| eprint!("{msg}"))));
    }

    let bpf = bpf::Bpf::cargar().map_err(|e| format!("cargando BPF: {e}"))?;
    let fan = fanotify::Fanotify::nuevo().map_err(|e| format!("fanotify: {e}"))?;

    let opath = fanotify::abrir_opath(&ruta)
        .map_err(|e| format!("abriendo {}: {e}", ruta.display()))?;
    let (clave, _nlink) =
        fanotify::clave_de_fd(opath.as_fd()).map_err(|e| format!("fstat {}: {e}", ruta.display()))?;
    fan.marcar(opath.as_fd())
        .map_err(|e| format!("marcando fanotify sobre {}: {e}", ruta.display()))?;
    bpf.proteger(clave, FICHERO, tipos::MARCADO)
        .map_err(|e| format!("protegiendo {}: {e}", ruta.display()))?;

    for (exe, mascara) in &concesiones {
        let clave_exe = fanotify::clave_de_ruta(exe)
            .map_err(|e| format!("resolviendo concesión {}: {e}", exe.display()))?;
        bpf.permiso(FICHERO, clave_exe, *mascara)
            .map_err(|e| format!("concediendo permiso a {}: {e}", exe.display()))?;
    }

    bpf.control(true)
        .map_err(|e| format!("activando el control BPF: {e}"))?;

    let cola: Rc<RefCell<Vec<tipos::Evento>>> = Rc::new(RefCell::new(Vec::new()));
    let cola_cb = Rc::clone(&cola);
    let anillo = bpf
        .anillo(move |bytes: &[u8]| {
            if let Some(ev) = tipos::desde_bytes::<tipos::Evento>(bytes) {
                cola_cb.borrow_mut().push(ev);
            }
            0
        })
        .map_err(|e| format!("montando el ring buffer: {e}"))?;

    println!(
        "LISTO fichero={} dev={} ino={}",
        ruta.display(),
        clave.dev,
        clave.ino
    );
    flush();

    let fd_fan = fan.fd().as_raw_fd();
    let fd_anillo = anillo.epoll_fd();

    // El resultado del bucle (señal recibida ⇒ Ok, cualquier error de E/S en
    // medio ⇒ Err) SIEMPRE pasa por la misma parada limpia de aquí abajo, en
    // vez de que cada `?` de dentro del bucle devuelva directamente: un `?`
    // temprano dejaría el BPF cargado y `Control.activo = 1` sin nadie ya
    // escuchando fanotify — el mismo "falla abierto" que un crash de verdad,
    // solo que disparado por un fallo de E/S en vez de una señal, y sin que
    // `pruebas/riesgos.sh` (ni el dueño de la máquina) tuviera forma de
    // distinguirlo de una parada limpia a partir del log.
    let resultado = bucle_eventos(&bpf, &fan, &anillo, &cola, &ruta, auto, fd_fan, fd_anillo, fd_senales);

    // `anillo` toma prestado `bpf` por referencia (vive mientras el ring
    // buffer exista): hay que soltarlo antes de poder mover `bpf` a
    // `parar_limpio`, que lo consume.
    drop(anillo);
    let parada = bpf.parar_limpio().map_err(|e| format!("parando limpio: {e}"));

    match resultado {
        Ok(()) => {
            parada?;
            println!("PARADO");
            flush();
            Ok(())
        }
        Err(e) => {
            if let Err(e2) = parada {
                eprintln!("gigishell-guardian: {e2} (tras el error original: {e})");
            }
            Err(e)
        }
    }
}

/// El bucle de eventos en sí: `poll(2)` sobre fanotify/ring-buffer/signalfd,
/// sin límite de vueltas. Devuelve `Ok(())` en cuanto llega SIGINT/SIGTERM
/// (ya leída del signalfd) y `Err` ante cualquier fallo de E/S real — ninguno
/// de los dos casos limpia el BPF aquí dentro, eso es cosa de la única
/// llamada a `parar_limpio` en `ejecutar`, después de esta función.
fn bucle_eventos(
    bpf: &bpf::Bpf,
    fan: &fanotify::Fanotify,
    anillo: &libbpf_rs::RingBuffer<'_>,
    cola: &Rc<RefCell<Vec<tipos::Evento>>>,
    ruta: &std::path::Path,
    auto: Option<bool>,
    fd_fan: RawFd,
    fd_anillo: i32,
    fd_senales: RawFd,
) -> Result<(), String> {
    loop {
        let mut fds = [
            libc::pollfd {
                fd: fd_fan,
                events: libc::POLLIN,
                revents: 0,
            },
            libc::pollfd {
                fd: fd_anillo,
                events: libc::POLLIN,
                revents: 0,
            },
            libc::pollfd {
                fd: fd_senales,
                events: libc::POLLIN,
                revents: 0,
            },
        ];

        let listos = unsafe { libc::poll(fds.as_mut_ptr(), fds.len() as libc::nfds_t, -1) };
        if listos < 0 {
            let err = io::Error::last_os_error();
            if err.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(format!("poll: {err}"));
        }

        // Señal (SIGINT/SIGTERM): fin del bucle, la parada limpia la hace
        // quien nos llama.
        if fds[2].revents & libc::POLLIN != 0 {
            let mut buf = [0u8; std::mem::size_of::<libc::signalfd_siginfo>()];
            unsafe {
                libc::read(fd_senales, buf.as_mut_ptr() as *mut libc::c_void, buf.len());
            }
            return Ok(());
        }

        // Eventos del ring buffer (denegados, movidos/borrados, herencia por
        // guardado atómico…).
        if fds[1].revents & libc::POLLIN != 0 {
            anillo
                .consume()
                .map_err(|e| format!("consumiendo el ring buffer: {e}"))?;
            let eventos: Vec<tipos::Evento> = cola.borrow_mut().drain(..).collect();
            for ev in eventos {
                println!(
                    "EVENTO tipo={} op={} tgid={} dev={} ino={}",
                    ev.tipo, ev.op, ev.tgid, ev.dev, ev.ino
                );
                flush();

                if ev.tipo == tipos::EV_HEREDADO {
                    procesar_heredado(bpf, fan, ruta);
                }
            }
        }

        // Apertura pendiente de respuesta (FAN_OPEN_PERM).
        if fds[0].revents & libc::POLLIN != 0 {
            let aperturas = fan.leer().map_err(|e| format!("leyendo fanotify: {e}"))?;
            for apertura in aperturas {
                let tid = apertura.tid;
                // La pendiente va por hilo, no por fichero: si este hilo dejó
                // antes una de OTRO fichero protegido sin consumir (p.ej. uno
                // que el BPF reconoce pero fanotify no tiene marcado), esa
                // pendiente —quizá con `permitido`— respondería por este. Solo
                // vale si su id de fichero es el del inodo que trae el evento.
                let fichero_evento = fanotify::clave_de_fd(apertura.fd.as_fd())
                    .ok()
                    .and_then(|(clave, _)| bpf.protegido(clave))
                    .map(|vp| vp.fichero);
                let pendiente = bpf
                    .pendiente(tid)
                    .filter(|p| Some(p.fichero) == fichero_evento);
                let exe = resolver_exe(tid);
                let pendiente_str = match pendiente {
                    Some(p) => format!("Some(({}, {}))", p.pedido, p.permitido),
                    None => "None".to_string(),
                };
                println!("APERTURA tid={tid} exe={exe} pendiente={pendiente_str}");
                flush();

                let permitir = match pendiente {
                    Some(p) if p.permitido != 0 => true,
                    _ => decidir(auto),
                };
                println!("RESPUESTA {}", if permitir { "permitir" } else { "denegar" });
                flush();

                if let Err(e) = fan.responder(apertura.fd, permitir) {
                    eprintln!("gigishell-guardian: fallo respondiendo a fanotify: {e}");
                }
            }
        }
    }
}

/// Reacciona a `EV_HEREDADO`: el BPF ya insertó por su cuenta una entrada en
/// `protegidos` para el inodo nuevo (con `marcado = 0`, "solo preguntar" —
/// falla cerrado mientras tanto), pero fanotify no sigue automáticamente esa
/// herencia: su marca (`FAN_MARK_ADD`) sigue puesta sobre el inodo VIEJO. Es
/// exactamente el trabajo que hará el daemon: esperar a que el reemplazo
/// atómico termine de asentarse (el `rename` ya se completó cuando llega el
/// evento, pero se da un margen por si el proceso que escribe sigue con el fd
/// nuevo abierto), volver a abrir la ruta que se venía vigilando —ahora
/// resuelve al inodo nuevo—, marcarla en fanotify y subir la categoría de
/// protección a la misma que tenía el fichero original.
fn procesar_heredado(bpf: &bpf::Bpf, fan: &fanotify::Fanotify, ruta: &std::path::Path) {
    std::thread::sleep(Duration::from_millis(100));

    let opath_nuevo = match fanotify::abrir_opath(ruta) {
        Ok(fd) => fd,
        Err(e) => {
            eprintln!("gigishell-guardian: fallo reabriendo {} tras heredar: {e}", ruta.display());
            return;
        }
    };
    let (clave_nueva, _nlink) = match fanotify::clave_de_fd(opath_nuevo.as_fd()) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("gigishell-guardian: fallo fstat tras heredar: {e}");
            return;
        }
    };
    if let Err(e) = fan.marcar(opath_nuevo.as_fd()) {
        eprintln!("gigishell-guardian: fallo marcando el fichero heredado: {e}");
        return;
    }
    if let Err(e) = bpf.proteger(clave_nueva, FICHERO, tipos::MARCADO) {
        eprintln!("gigishell-guardian: fallo protegiendo el fichero heredado: {e}");
        return;
    }

    println!(
        "HEREDADO_MARCADO fichero={} dev={} ino={}",
        ruta.display(),
        clave_nueva.dev,
        clave_nueva.ino
    );
    flush();
}

/// Resuelve `exe` de la manera más informativa posible a partir de un TID de
/// fanotify — `?` si el proceso ya terminó (carrera normal) o si `/proc` no
/// se pudo leer por cualquier otra razón: es un dato para el log, no algo de
/// lo que dependa una decisión.
fn resolver_exe(tid: u32) -> String {
    proceso::tgid_de(tid)
        .ok()
        .and_then(|tgid| proceso::leer(tgid).ok())
        .map(|info| info.exe.display().to_string())
        .unwrap_or_else(|| "?".to_string())
}

/// Decide permitir/denegar una apertura que no venía con `permitido != 0`:
/// `--auto` si se dio, si no, se pregunta por terminal. Un fallo leyendo
/// stdin (p.ej. lanzado en segundo plano con la entrada cerrada, como hace
/// `pruebas/riesgos.sh`) se trata como "denegar" — fallar cerrado, nunca
/// abierto, ante la ausencia de una respuesta real.
fn decidir(auto: Option<bool>) -> bool {
    if let Some(a) = auto {
        return a;
    }
    print!("¿Permitir esta apertura? [s/N] ");
    flush();
    let mut linea = String::new();
    if io::stdin().read_line(&mut linea).unwrap_or(0) == 0 {
        return false;
    }
    matches!(linea.trim().to_lowercase().as_str(), "s" | "si" | "sí" | "y" | "yes")
}

fn flush() {
    let _ = io::stdout().flush();
}

/// Parsea `<fichero> [--auto permitir|denegar] [--conceder <exe>:<mascara>]…`.
fn parsear_args(
    args: &[String],
) -> Result<(PathBuf, Option<bool>, Vec<(PathBuf, u32)>), String> {
    let ruta = args
        .first()
        .ok_or("uso: --depurar <fichero> [--auto permitir|denegar] [--conceder <exe>:<mascara>]…")?;
    let ruta = PathBuf::from(ruta);

    let mut auto: Option<bool> = None;
    let mut concesiones = Vec::new();

    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--auto" => {
                i += 1;
                let valor = args
                    .get(i)
                    .ok_or("--auto necesita un valor: permitir|denegar")?;
                auto = Some(match valor.as_str() {
                    "permitir" => true,
                    "denegar" => false,
                    otro => return Err(format!("--auto: valor inválido «{otro}» (permitir|denegar)")),
                });
            }
            "--conceder" => {
                i += 1;
                let valor = args
                    .get(i)
                    .ok_or("--conceder necesita un valor: <exe>:<mascara>")?;
                let (exe, mascara) = valor
                    .rsplit_once(':')
                    .ok_or_else(|| format!("--conceder: formato inválido «{valor}» (<exe>:<mascara>)"))?;
                let mascara: u32 = mascara
                    .parse()
                    .map_err(|_| format!("--conceder: máscara inválida «{mascara}»"))?;
                concesiones.push((PathBuf::from(exe), mascara));
            }
            otro => return Err(format!("opción desconocida: {otro}")),
        }
        i += 1;
    }

    Ok((ruta, auto, concesiones))
}
