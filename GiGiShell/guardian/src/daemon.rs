// gigishell-guardian: el daemon — cablea el kernel (BPF + fanotify), el disco
// (política, historial) y el socket con AGS en un único bucle `epoll`, sin
// hilos. Las decisiones las toma `motor.rs` (puro); aquí solo se ejecutan sus
// efectos.
//
// REGLA ANTI-INTERBLOQUEO: este proceso NUNCA abre un fichero protegido más que
// con `O_PATH` (que no pasa por `file_open` del LSM ni genera eventos de
// fanotify). Si lo abriera de verdad, fanotify le pediría permiso a él mismo y
// se quedaría esperando su propia respuesta. Lo mismo vale para lo que se lee
// para decidir: `/proc`, `statvfs`, `lstat` — nada de eso abre el contenido.
//
// Parada limpia (SIGTERM/SIGINT, p.ej. `systemctl stop`): se deniega lo que
// estaba esperando, se borra el socket y `parar_limpio()` desengancha el BPF —
// los ficheros quedan accesibles con coste cero. Un ERROR, en cambio, sale sin
// desenganchar: el BPF anclado sigue denegando todo lo protegido (ExecStopPost
// pone `activo = 0`) hasta que systemd lo reinicia. Nunca falla abierto.
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{self, Read, Seek};
use std::os::fd::{AsFd, AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::rc::Rc;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::arranque::{self, Situacion};
use crate::bpf::Bpf;
use crate::categorias::{self, Categorias};
use crate::fanotify::{self, Fanotify};
use crate::historial::{self, Entrada, Historial, Resultado};
use crate::ipc::{self, Servidor};
use crate::motor::{Apertura, Efecto, Motor};
use crate::politica::{Estado, ModoCategoria, Politica};
use crate::proceso;
use crate::protocolo::{self, Aviso, Orden};
use crate::senales;
use crate::tipos::{self, ClaveInodo, Evento};

const DIR: &str = "/var/lib/gigishell-guardian";
const POLITICA: &str = "/var/lib/gigishell-guardian/politica.json";
const HISTORIAL: &str = "/var/lib/gigishell-guardian/historial.jsonl";

/// El evento BPF de un rename/unlink llega ANTES de que la operación termine:
/// se revisa con este retraso.
const RETRASO_REVISION_MS: u64 = 200;
/// Cuánto se reintenta asentar una herencia (guardado atómico) antes de darla
/// por fallida. Fallida = el inodo nuevo sigue con `marcado = 0`: denegado.
const PLAZO_HERENCIA_MS: u64 = 2_000;
const SEMANA_S: u64 = 7 * 86_400;
const MAX_HISTORIAL_ORDEN: usize = 500;

const T_FANOTIFY: u64 = 1;
const T_ANILLO: u64 = 2;
const T_ESCUCHA: u64 = 3;
const T_CLIENTE: u64 = 4;
const T_MONTAJES: u64 = 5;
const T_SENAL: u64 = 6;
/// Los pidfd van con token `T_PIDFD + fd`.
const T_PIDFD: u64 = 1 << 32;

fn ahora_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn ahora_s() -> u64 {
    ahora_ms() / 1000
}

struct Herencia {
    fichero: u32,
    clave: ClaveInodo,
    desde: u64,
}

/// Un permiso «a este proceso» vivo: se retira cuando su pidfd avisa de que
/// el proceso terminó.
struct PermisoProceso {
    /// Solo se guarda para que el fd siga abierto (y vigilado) mientras tanto.
    _pidfd: OwnedFd,
    fichero: u32,
    tgid: u32,
    mascara: u8,
}

struct Daemon {
    /// El usuario dueño de la máquina: el del socket y el único cuyos ficheros
    /// se pueden proteger.
    uid: u32,
    politica: Politica,
    historial: Historial,
    categorias: Categorias,
    motor: Motor,
    fan: Fanotify,
    servidor: Servidor,
    epoll: OwnedFd,
    /// `O_PATH` de cada fichero activo, por id: mantiene viva la marca de
    /// fanotify y permite seguir al fichero si se mueve.
    opaths: HashMap<u32, OwnedFd>,
    /// Descriptores de fanotify esperando respuesta, por su número.
    fds_fan: HashMap<RawFd, OwnedFd>,
    procesos: HashMap<RawFd, PermisoProceso>,
    herencias: Vec<Herencia>,
    revision_en: Option<u64>,
    /// Lo que el MOTOR cree: si difiere de `servidor.hay_cliente()`, el
    /// cliente se cayó en una escritura y hay que avisar al motor.
    conectado: bool,
}

pub fn ejecutar(uid: u32) -> Result<(), String> {
    let mascara = senales::bloquear()?;
    // SAFETY: `signalfd` devuelve un fd nuevo que pasa a ser nuestro.
    let senal = unsafe { OwnedFd::from_raw_fd(senales::signalfd(&mascara)?) };

    fs::create_dir_all(DIR).map_err(|e| format!("creando {DIR}: {e}"))?;
    fs::set_permissions(DIR, fs::Permissions::from_mode(0o700))
        .map_err(|e| format!("permisos de {DIR}: {e}"))?;

    let mut politica = Politica::cargar(Path::new(POLITICA))?;
    let historial = Historial::new(HISTORIAL.into());
    if let Err(e) = historial.recortar(historial::MAX_POR_FICHERO) {
        eprintln!("gigishell-guardian: recortando el historial: {e}");
    }
    let categorias = Categorias::cargar(Path::new(categorias::RUTA_INSTALADA)).unwrap_or_else(|e| {
        // Sin categorías todo se pregunta: falla del lado seguro.
        eprintln!("gigishell-guardian: {e}; sin categorías");
        Categorias::vacias()
    });

    for e in arranque::reconciliar(&mut politica, arranque::sondear_real, ahora_s()) {
        eprintln!("gigishell-guardian: {} ya no existe; se retira", e.ruta);
        let _ = historial.anadir(&e);
    }
    politica.guardar(Path::new(POLITICA)).map_err(|e| format!("guardando la política: {e}"))?;

    let bpf = Bpf::cargar().map_err(|e| format!("cargando BPF: {e}"))?;
    // Mientras se prepara, todo lo protegido se deniega.
    bpf.control(false).map_err(|e| format!("control BPF: {e}"))?;
    let fan = Fanotify::nuevo().map_err(|e| format!("fanotify: {e}"))?;
    let servidor = Servidor::nuevo(Path::new(ipc::RUTA), uid)
        .map_err(|e| format!("socket {}: {e}", ipc::RUTA))?;
    let epoll = unsafe { libc::epoll_create1(libc::EPOLL_CLOEXEC) };
    if epoll < 0 {
        return Err(format!("epoll: {}", io::Error::last_os_error()));
    }

    let mut d = Daemon {
        uid,
        politica,
        historial,
        categorias,
        motor: Motor::new(),
        fan,
        servidor,
        // SAFETY: fd recién creado y comprobado.
        epoll: unsafe { OwnedFd::from_raw_fd(epoll) },
        opaths: HashMap::new(),
        fds_fan: HashMap::new(),
        procesos: HashMap::new(),
        herencias: Vec::new(),
        revision_en: None,
        conectado: false,
    };

    let activos: Vec<u32> = d
        .politica
        .ficheros
        .iter()
        .filter(|f| f.estado == Estado::Activo)
        .map(|f| f.id)
        .collect();
    for id in activos {
        if let Err(e) = d.aplicar(&bpf, id) {
            eprintln!("gigishell-guardian: fichero {id}: {e} (queda denegado)");
        }
    }
    bpf.retener(&d.claves_vivas()).map_err(|e| format!("retener: {e}"))?;
    d.guardar();
    bpf.control(true).map_err(|e| format!("control BPF: {e}"))?;

    let cola: Rc<RefCell<Vec<Evento>>> = Rc::new(RefCell::new(Vec::new()));
    let cola_cb = Rc::clone(&cola);
    let anillo = bpf
        .anillo(move |bytes: &[u8]| {
            if let Some(ev) = tipos::desde_bytes::<Evento>(bytes) {
                cola_cb.borrow_mut().push(ev);
            }
            0
        })
        .map_err(|e| format!("ring buffer: {e}"))?;

    let mut montajes =
        fs::File::open("/proc/self/mountinfo").map_err(|e| format!("mountinfo: {e}"))?;
    let _ = io::copy(&mut montajes, &mut io::sink());

    d.vigilar(d.fan.fd().as_raw_fd(), T_FANOTIFY, libc::EPOLLIN)?;
    d.vigilar(anillo.epoll_fd(), T_ANILLO, libc::EPOLLIN)?;
    d.vigilar(d.servidor.fd_escucha(), T_ESCUCHA, libc::EPOLLIN)?;
    d.vigilar(montajes.as_raw_fd(), T_MONTAJES, libc::EPOLLPRI | libc::EPOLLERR)?;
    d.vigilar(senal.as_raw_fd(), T_SENAL, libc::EPOLLIN)?;
    eprintln!(
        "gigishell-guardian: activo ({} ficheros protegidos)",
        d.politica.ficheros.len()
    );

    d.bucle(&bpf, &anillo, &cola, &mut montajes, &senal)?;

    // Parada limpia.
    let efectos = d.motor.cliente_conectado(false, ahora_ms());
    d.ejecutar(&bpf, efectos);
    for (_, fd) in d.fds_fan.drain() {
        let _ = d.fan.responder(fd, false);
    }
    drop(d); // cierra fanotify y borra el socket
    drop(anillo);
    bpf.parar_limpio().map_err(|e| format!("parando limpio: {e}"))?;
    eprintln!("gigishell-guardian: parado");
    Ok(())
}

impl Daemon {
    fn vigilar(&self, fd: RawFd, token: u64, eventos: i32) -> Result<(), String> {
        let mut ev = libc::epoll_event { events: eventos as u32, u64: token };
        if unsafe { libc::epoll_ctl(self.epoll.as_raw_fd(), libc::EPOLL_CTL_ADD, fd, &mut ev) } != 0 {
            return Err(format!("epoll_ctl: {}", io::Error::last_os_error()));
        }
        Ok(())
    }

    fn dejar_de_vigilar(&self, fd: RawFd) {
        unsafe {
            libc::epoll_ctl(self.epoll.as_raw_fd(), libc::EPOLL_CTL_DEL, fd, std::ptr::null_mut());
        }
    }

    fn guardar(&self) {
        if let Err(e) = self.politica.guardar(Path::new(POLITICA)) {
            eprintln!("gigishell-guardian: guardando la política: {e}");
        }
    }

    fn anotar(&self, e: &Entrada) {
        if let Err(err) = self.historial.anadir(e) {
            eprintln!("gigishell-guardian: historial: {err}");
        }
    }

    fn enviar(&mut self, aviso: &Aviso) {
        self.servidor.enviar(aviso);
    }

    fn cambio(&mut self) {
        self.guardar();
        self.enviar(&Aviso::Cambio);
    }

    fn programar_revision(&mut self, en: u64) {
        self.revision_en = Some(self.revision_en.map_or(en, |r| r.min(en)));
    }

    fn claves_vivas(&self) -> HashSet<ClaveInodo> {
        self.politica
            .ficheros
            .iter()
            .filter(|f| f.estado == Estado::Activo)
            .map(|f| ClaveInodo { dev: f.dev, ino: f.ino })
            .collect()
    }

    /// Pone bajo guardia el fichero `id`: primero en el BPF SIN marcar (se
    /// deniega todo), luego la marca de fanotify y solo entonces `marcado = 1`
    /// (a partir de ahí las aperturas se preguntan). Ningún instante sin guardia.
    fn aplicar(&mut self, bpf: &Bpf, id: u32) -> Result<(), String> {
        let ruta = self.politica.por_id(id).ok_or("id desconocido")?.ruta.clone();
        let opath = fanotify::abrir_opath(Path::new(&ruta)).map_err(|e| format!("{ruta}: {e}"))?;
        let (clave, _) = fanotify::clave_de_fd(opath.as_fd()).map_err(|e| format!("{ruta}: {e}"))?;
        bpf.proteger(clave, id, 0).map_err(|e| e.to_string())?;
        if let Some(f) = self.politica.por_id_mut(id) {
            f.dev = clave.dev;
            f.ino = clave.ino;
        }
        self.recargar_bpf(bpf, id);
        self.fan.marcar(opath.as_fd()).map_err(|e| format!("marcando {ruta}: {e}"))?;
        bpf.proteger(clave, id, tipos::MARCADO).map_err(|e| e.to_string())?;
        if let Some(viejo) = self.opaths.insert(id, opath) {
            let _ = self.fan.desmarcar(viejo.as_fd());
        }
        Ok(())
    }

    /// Rehace en el BPF los permisos, categorías y permisos de proceso del
    /// fichero `id` a partir de la política. Rehacer entero (en vez de tocar
    /// una clave) también barre las claves de inodos viejos de un programa que
    /// se actualizó.
    fn recargar_bpf(&self, bpf: &Bpf, id: u32) {
        let Some(f) = self.politica.por_id(id) else { return };
        if let Err(e) = bpf.limpiar_fichero(id) {
            eprintln!("gigishell-guardian: limpiando el fichero {id}: {e}");
        }
        for p in &f.permisos {
            if let Ok(k) = fanotify::clave_de_ruta(Path::new(&p.programa)) {
                let _ = bpf.permiso(id, k, p.mascara() as u32);
            }
        }
        for (nombre, rutas) in self.categorias.mapa() {
            let cat = match f.modo_categoria(nombre, &self.politica.categorias_por_defecto) {
                ModoCategoria::Permitir => tipos::CAT_PERMITIR,
                ModoCategoria::Silencio => tipos::CAT_SILENCIO,
                ModoCategoria::Preguntar => continue,
            };
            for r in rutas {
                // Las rutas de categorias.json son candidatas: las que no
                // existen en esta máquina se ignoran.
                if let Ok(k) = fanotify::clave_de_ruta(Path::new(r)) {
                    let _ = bpf.categoria(id, k, cat);
                }
            }
        }
        for p in self.procesos.values().filter(|p| p.fichero == id) {
            let _ = bpf.permiso_proceso(id, p.tgid, p.mascara as u32);
        }
    }

    /// Quita el fichero `id` de todas partes (política, BPF, fanotify).
    fn quitar(&mut self, bpf: &Bpf, id: u32) -> Option<crate::politica::Fichero> {
        let ruta = self.politica.por_id(id)?.ruta.clone();
        let f = self.politica.desproteger(&ruta)?;
        if let Some(opath) = self.opaths.remove(&id) {
            let _ = self.fan.desmarcar(opath.as_fd());
        }
        let _ = bpf.desproteger(ClaveInodo { dev: f.dev, ino: f.ino });
        let _ = bpf.limpiar_fichero(id);
        self.herencias.retain(|h| h.fichero != id);
        Some(f)
    }

    fn bucle(
        &mut self,
        bpf: &Bpf,
        anillo: &libbpf_rs::RingBuffer<'_>,
        cola: &Rc<RefCell<Vec<Evento>>>,
        montajes: &mut fs::File,
        senal: &OwnedFd,
    ) -> Result<(), String> {
        let mut eventos = [libc::epoll_event { events: 0, u64: 0 }; 32];
        loop {
            let ahora = ahora_ms();
            let limite = [self.motor.proximo_vencimiento(), self.revision_en].into_iter().flatten().min();
            let espera = limite.map_or(-1, |t| t.saturating_sub(ahora).min(60_000) as i32);
            let n = unsafe {
                libc::epoll_wait(self.epoll.as_raw_fd(), eventos.as_mut_ptr(), eventos.len() as i32, espera)
            };
            if n < 0 {
                let e = io::Error::last_os_error();
                if e.kind() == io::ErrorKind::Interrupted {
                    continue;
                }
                return Err(format!("epoll_wait: {e}"));
            }

            for ev in &eventos[..n as usize] {
                let token = ev.u64;
                match token {
                    T_SENAL => {
                        let mut buf = [0u8; std::mem::size_of::<libc::signalfd_siginfo>()];
                        unsafe {
                            libc::read(senal.as_raw_fd(), buf.as_mut_ptr() as *mut libc::c_void, buf.len())
                        };
                        return Ok(());
                    }
                    T_FANOTIFY => self.en_fanotify(bpf)?,
                    T_ANILLO => {
                        anillo.consume().map_err(|e| format!("ring buffer: {e}"))?;
                        let evs: Vec<Evento> = cola.borrow_mut().drain(..).collect();
                        for e in evs {
                            self.en_evento_bpf(bpf, e);
                        }
                    }
                    T_ESCUCHA => {
                        if self.servidor.aceptar() {
                            if let Some(fd) = self.servidor.fd_cliente() {
                                self.vigilar(fd, T_CLIENTE, libc::EPOLLIN)?;
                            }
                            self.conectado = true;
                            let efectos = self.motor.cliente_conectado(true, ahora_ms());
                            self.ejecutar(bpf, efectos);
                            let denegados = self.motor.tomar_resumen();
                            if !denegados.is_empty() {
                                self.enviar(&Aviso::Resumen { denegados });
                            }
                        }
                    }
                    T_CLIENTE => match self.servidor.leer() {
                        Some(lineas) => {
                            for l in lineas {
                                self.en_linea(bpf, &l);
                            }
                        }
                        None => {} // se detecta abajo, junto a las escrituras fallidas
                    },
                    T_MONTAJES => {
                        // Hay que releer el fichero para rearmar la notificación.
                        let _ = montajes.rewind();
                        let _ = montajes.read_to_end(&mut Vec::new());
                        self.en_montajes(bpf);
                    }
                    t if t >= T_PIDFD => self.en_pidfd(bpf, (t - T_PIDFD) as RawFd),
                    _ => {}
                }
            }

            let ahora = ahora_ms();
            if self.revision_en.is_some_and(|r| r <= ahora) {
                self.revisar(bpf);
            }
            let efectos = self.motor.vencer(ahora);
            self.ejecutar(bpf, efectos);
            if self.conectado && !self.servidor.hay_cliente() {
                self.conectado = false;
                let efectos = self.motor.cliente_conectado(false, ahora);
                self.ejecutar(bpf, efectos);
            }
        }
    }

    fn en_fanotify(&mut self, bpf: &Bpf) -> Result<(), String> {
        let aperturas = self.fan.leer().map_err(|e| format!("leyendo fanotify: {e}"))?;
        for a in aperturas {
            let fichero = fanotify::clave_de_fd(a.fd.as_fd())
                .ok()
                .and_then(|(k, _)| self.politica.por_clave(k.dev, k.ino))
                .filter(|f| f.estado == Estado::Activo)
                .map(|f| (f.id, f.ruta.clone()));
            let info = proceso::tgid_de(a.tid).and_then(proceso::leer);
            let (Some((id, ruta)), Ok(info)) = (fichero, info) else {
                // Un inodo marcado que la política no reconoce (p.ej. recién
                // desprotegido) o un proceso que ya no existe: denegar.
                let _ = self.fan.responder(a.fd, false);
                continue;
            };
            let pendiente = bpf.pendiente(a.tid).filter(|p| p.fichero == id);
            let programa = info.exe.display().to_string();
            let permiso_ruta = self.politica.permiso_de(id, &programa);
            let confiable = proceso::exe_confiable(&info.exe);
            let raw = a.fd.as_raw_fd();
            self.fds_fan.insert(raw, a.fd);
            let efectos = self.motor.apertura(
                Apertura { fd: raw, fichero: id, ruta, proceso: info, pendiente, confiable },
                permiso_ruta,
                ahora_ms(),
            );
            self.ejecutar(bpf, efectos);
        }
        Ok(())
    }

    fn en_evento_bpf(&mut self, bpf: &Bpf, ev: Evento) {
        let ahora = ahora_ms();
        match ev.tipo {
            tipos::EV_DENEGADO | tipos::EV_SILENCIO => {
                let Some(ruta) = self.politica.por_id(ev.fichero).map(|f| f.ruta.clone()) else {
                    return;
                };
                let info = proceso::leer(ev.tgid).ok();
                let efectos = self.motor.denegacion(
                    ev.fichero,
                    &ruta,
                    info.as_ref(),
                    ev.op as u8,
                    ev.tipo == tipos::EV_SILENCIO,
                    ahora,
                );
                self.ejecutar(bpf, efectos);
            }
            tipos::EV_HEREDADO => {
                self.herencias.push(Herencia {
                    fichero: ev.fichero,
                    clave: ClaveInodo { dev: ev.dev, ino: ev.ino },
                    desde: ahora,
                });
                self.programar_revision(ahora + RETRASO_REVISION_MS);
            }
            tipos::EV_MOVIDO | tipos::EV_BORRADO => {
                self.programar_revision(ahora + RETRASO_REVISION_MS);
            }
            _ => {}
        }
    }

    /// Asienta las herencias pendientes y sigue a los ficheros que se movieron
    /// o se borraron.
    fn revisar(&mut self, bpf: &Bpf) {
        self.revision_en = None;
        let ahora = ahora_ms();
        let mut cambios = false;

        for h in std::mem::take(&mut self.herencias) {
            let Some(f) = self.politica.por_id(h.fichero).cloned() else { continue };
            let nuevo = fanotify::abrir_opath(Path::new(&f.ruta))
                .ok()
                .and_then(|o| fanotify::clave_de_fd(o.as_fd()).ok().map(|(k, _)| (o, k)));
            match nuevo {
                Some((opath, k)) if k == h.clave => {
                    if let Err(e) = self.fan.marcar(opath.as_fd()) {
                        eprintln!("gigishell-guardian: marcando {} tras heredar: {e}", f.ruta);
                        continue;
                    }
                    let _ = bpf.proteger(k, f.id, tipos::MARCADO);
                    if let Some(viejo) = self.opaths.insert(f.id, opath) {
                        let _ = self.fan.desmarcar(viejo.as_fd());
                    }
                    let vieja = ClaveInodo { dev: f.dev, ino: f.ino };
                    if vieja != k {
                        let _ = bpf.desproteger(vieja);
                    }
                    if let Some(g) = self.politica.por_id_mut(f.id) {
                        g.dev = k.dev;
                        g.ino = k.ino;
                        g.fsid = arranque::fsid(Path::new(&f.ruta)).unwrap_or(g.fsid);
                    }
                    cambios = true;
                }
                _ if ahora.saturating_sub(h.desde) < PLAZO_HERENCIA_MS => self.herencias.push(h),
                _ => eprintln!(
                    "gigishell-guardian: la herencia de {} no se asentó en 2 s; el inodo nuevo queda denegado",
                    f.ruta
                ),
            }
        }
        if !self.herencias.is_empty() {
            self.programar_revision(ahora + RETRASO_REVISION_MS);
        }

        // Un fichero con una herencia a medias tiene su inodo viejo con nlink 0:
        // no se confunde con uno borrado.
        let en_herencia: HashSet<u32> = self.herencias.iter().map(|h| h.fichero).collect();
        let ids: Vec<u32> = self.opaths.keys().copied().collect();
        for id in ids {
            if en_herencia.contains(&id) {
                continue;
            }
            let Some(opath) = self.opaths.get(&id) else { continue };
            let Ok((k, nlink)) = fanotify::clave_de_fd(opath.as_fd()) else { continue };
            let nueva_ruta = fanotify::ruta_de_fd(opath.as_fd()).ok();
            let Some(f) = self.politica.por_id(id) else { continue };
            if nlink == 0 {
                if k == (ClaveInodo { dev: f.dev, ino: f.ino }) {
                    if let Some(f) = self.quitar(bpf, id) {
                        self.anotar(&Entrada {
                            fecha: ahora / 1000,
                            ruta: f.ruta,
                            programa: String::new(),
                            pid: 0,
                            script: None,
                            operacion: "retirar".into(),
                            resultado: Resultado::Retirado,
                        });
                        cambios = true;
                    }
                }
                continue;
            }
            if let Some(r) = nueva_ruta.map(|r| r.to_string_lossy().into_owned()) {
                if r != f.ruta {
                    if let Some(g) = self.politica.por_id_mut(id) {
                        g.ruta = r;
                        cambios = true;
                    }
                }
            }
        }
        if cambios {
            self.cambio();
        }
    }

    /// Cambió algún montaje: los ficheros no disponibles cuyo disco ha vuelto
    /// se activan (y los que resultan borrados, se retiran).
    fn en_montajes(&mut self, bpf: &Bpf) {
        let antes: HashSet<u32> = self
            .politica
            .ficheros
            .iter()
            .filter(|f| f.estado == Estado::NoDisponible)
            .map(|f| f.id)
            .collect();
        if antes.is_empty() {
            return;
        }
        let retirados = arranque::reconciliar(
            &mut self.politica,
            |f| {
                if antes.contains(&f.id) {
                    arranque::sondear_real(f)
                } else {
                    Situacion::Existe { clave: ClaveInodo { dev: f.dev, ino: f.ino }, fsid: f.fsid }
                }
            },
            ahora_s(),
        );
        let mut cambios = !retirados.is_empty();
        for e in &retirados {
            self.anotar(e);
        }
        let vueltos: Vec<u32> = self
            .politica
            .ficheros
            .iter()
            .filter(|f| antes.contains(&f.id) && f.estado == Estado::Activo)
            .map(|f| f.id)
            .collect();
        for id in vueltos {
            cambios = true;
            if let Err(e) = self.aplicar(bpf, id) {
                eprintln!("gigishell-guardian: reactivando el fichero {id}: {e}");
            }
        }
        if cambios {
            self.cambio();
        }
    }

    fn en_pidfd(&mut self, bpf: &Bpf, fd: RawFd) {
        self.dejar_de_vigilar(fd);
        if let Some(p) = self.procesos.remove(&fd) {
            // Otro permiso vivo sobre el mismo (fichero, tgid) no puede existir
            // de un proceso distinto: el tgid acaba de morir.
            let _ = bpf.permiso_proceso(p.fichero, p.tgid, 0);
        }
    }

    fn en_linea(&mut self, bpf: &Bpf, linea: &str) {
        match protocolo::parsear(linea) {
            Ok(orden) => self.orden(bpf, orden),
            Err(motivo) => self.enviar(&Aviso::Error { op: "?".into(), motivo }),
        }
    }

    fn orden(&mut self, bpf: &Bpf, orden: Orden) {
        let op = nombre_orden(&orden);
        if let Err(motivo) = self.orden_o_error(bpf, orden) {
            self.enviar(&Aviso::Error { op: op.to_string(), motivo });
        }
    }

    fn orden_o_error(&mut self, bpf: &Bpf, orden: Orden) -> Result<(), String> {
        match orden {
            Orden::Estado => {
                let denegados = self
                    .historial
                    .contar_denegados_desde(ahora_s().saturating_sub(SEMANA_S))
                    .unwrap_or(0);
                let ficheros = self.politica.ficheros.len();
                self.enviar(&Aviso::Estado { ficheros, denegados_semana: denegados });
            }
            Orden::Lista => {
                let aviso = Aviso::Lista {
                    ficheros: self.politica.ficheros.clone(),
                    categorias_por_defecto: self.politica.categorias_por_defecto.clone(),
                    categorias: self.categorias.mapa().clone(),
                };
                self.enviar(&aviso);
            }
            Orden::Historial { ruta, limite } => {
                let entradas = self
                    .historial
                    .leer(&ruta, limite.min(MAX_HISTORIAL_ORDEN))
                    .map_err(|e| e.to_string())?;
                self.enviar(&Aviso::Historial { ruta, entradas });
            }
            Orden::Proteger { ruta } => {
                self.proteger(bpf, &ruta)?;
                self.cambio();
            }
            Orden::Desproteger { ruta } => {
                let id = self.politica.por_ruta(&ruta).ok_or("no está protegido")?.id;
                self.quitar(bpf, id);
                self.cambio();
            }
            Orden::Permiso { ruta, programa, leer, modificar, borrar } => {
                let id = self.politica.por_ruta(&ruta).ok_or("no está protegido")?.id;
                if !Path::new(&programa).is_absolute() {
                    return Err("el programa tiene que ser una ruta absoluta".into());
                }
                self.politica.fijar_permiso(id, &programa, leer, modificar, borrar, ahora_s());
                self.recargar_bpf(bpf, id);
                self.cambio();
            }
            Orden::Conceder { ruta, programa, operacion } => {
                let id = self.politica.por_ruta(&ruta).ok_or("no está protegido")?.id;
                if proceso::es_interprete(Path::new(&programa)) {
                    return Err("a un intérprete no se le concede «siempre»".into());
                }
                let mascara = protocolo::mascara_de(&operacion);
                if mascara == 0 {
                    return Err(format!("operación desconocida: {operacion}"));
                }
                self.conceder(bpf, id, &programa, mascara);
                self.cambio();
            }
            Orden::Categoria { ruta, nombre, valor } => {
                if !self.politica.categorias_por_defecto.contains_key(&nombre)
                    && !self.categorias.mapa().contains_key(&nombre)
                {
                    return Err(format!("categoría desconocida: {nombre}"));
                }
                match ruta {
                    None => {
                        self.politica.categorias_por_defecto.insert(nombre, valor);
                    }
                    Some(ruta) => {
                        let id = self.politica.por_ruta(&ruta).ok_or("no está protegido")?.id;
                        if let Some(f) = self.politica.por_id_mut(id) {
                            f.categorias.insert(nombre, valor);
                        }
                        self.recargar_bpf(bpf, id);
                    }
                }
                self.cambio();
            }
            Orden::Responder { id, decision } => {
                let efectos = self.motor.responder(id, decision, ahora_ms());
                self.ejecutar(bpf, efectos);
            }
        }
        Ok(())
    }

    /// Solo ficheros regulares (no symlinks) cuyo dueño sea el usuario. La
    /// comprobación se hace sobre el `O_PATH` ya abierto, no sobre la ruta:
    /// entre mirar y marcar, la ruta podría pasar a ser otra cosa.
    fn proteger(&mut self, bpf: &Bpf, ruta: &str) -> Result<(), String> {
        if !Path::new(ruta).is_absolute() {
            return Err("la ruta tiene que ser absoluta".into());
        }
        if self.politica.por_ruta(ruta).is_some() {
            return Err("ya está protegido".into());
        }
        let opath = fanotify::abrir_opath(Path::new(ruta)).map_err(|e| e.to_string())?;
        let st = fstat(opath.as_raw_fd()).map_err(|e| e.to_string())?;
        if st.st_mode & libc::S_IFMT != libc::S_IFREG {
            return Err("solo se pueden proteger ficheros normales".into());
        }
        if st.st_uid != self.uid {
            return Err("el fichero no es tuyo".into());
        }
        let (clave, _) = fanotify::clave_de_fd(opath.as_fd()).map_err(|e| e.to_string())?;
        if self.politica.por_clave(clave.dev, clave.ino).is_some() {
            return Err("ese fichero ya está protegido con otro nombre".into());
        }
        let id = self.politica.proteger(ruta, clave.dev, clave.ino, ahora_s());
        if let Some(f) = self.politica.por_id_mut(id) {
            f.fsid = arranque::fsid(Path::new(ruta)).unwrap_or(0);
        }
        drop(opath);
        if let Err(e) = self.aplicar(bpf, id) {
            // Si no se pudo marcar, se deshace: mejor un error visible que un
            // fichero en la lista que en realidad no se pregunta.
            self.quitar(bpf, id);
            return Err(e);
        }
        Ok(())
    }

    fn conceder(&mut self, bpf: &Bpf, id: u32, programa: &str, mascara: u8) {
        self.politica.conceder(id, programa, mascara, ahora_s());
        match fanotify::clave_de_ruta(Path::new(programa)) {
            Ok(k) => {
                let _ = bpf.permiso(id, k, self.politica.permiso_de(id, programa) as u32);
            }
            Err(e) => eprintln!("gigishell-guardian: {programa}: {e}"),
        }
    }

    fn ejecutar(&mut self, bpf: &Bpf, efectos: Vec<Efecto>) {
        for ef in efectos {
            match ef {
                Efecto::Responder { fd, permitir } => {
                    if let Some(owned) = self.fds_fan.remove(&fd) {
                        let _ = self.fan.responder(owned, permitir);
                    }
                }
                Efecto::EnviarPregunta(p) => self.enviar(&Aviso::Pregunta(p)),
                Efecto::CerrarPregunta { id } => self.enviar(&Aviso::Cerrar { id }),
                Efecto::EnviarDenegado { ruta, programa, operacion, interprete } => {
                    self.enviar(&Aviso::Denegado { ruta, programa, operacion, interprete })
                }
                Efecto::Conceder { fichero, programa, mascara } => {
                    self.conceder(bpf, fichero, &programa, mascara);
                    self.cambio();
                }
                Efecto::ConcederProceso { fichero, tgid, mascara } => {
                    self.conceder_proceso(bpf, fichero, tgid, mascara)
                }
                Efecto::RefrescarPrograma { fichero, .. } => self.recargar_bpf(bpf, fichero),
                Efecto::Historial(e) => self.anotar(&e),
            }
        }
    }

    fn conceder_proceso(&mut self, bpf: &Bpf, fichero: u32, tgid: u32, mascara: u8) {
        let _ = bpf.permiso_proceso(fichero, tgid, mascara as u32);
        let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, tgid as libc::c_int, 0) } as RawFd;
        if fd < 0 {
            // El proceso ya murió: el permiso no le sirve a nadie.
            let _ = bpf.permiso_proceso(fichero, tgid, 0);
            return;
        }
        // SAFETY: pidfd_open devolvió un fd nuevo.
        let pidfd = unsafe { OwnedFd::from_raw_fd(fd) };
        if self.vigilar(fd, T_PIDFD + fd as u64, libc::EPOLLIN).is_err() {
            let _ = bpf.permiso_proceso(fichero, tgid, 0);
            return;
        }
        self.procesos.insert(fd, PermisoProceso { _pidfd: pidfd, fichero, tgid, mascara });
    }
}

fn nombre_orden(o: &Orden) -> &'static str {
    match o {
        Orden::Estado => "estado",
        Orden::Lista => "lista",
        Orden::Historial { .. } => "historial",
        Orden::Proteger { .. } => "proteger",
        Orden::Desproteger { .. } => "desproteger",
        Orden::Permiso { .. } => "permiso",
        Orden::Conceder { .. } => "conceder",
        Orden::Categoria { .. } => "categoria",
        Orden::Responder { .. } => "responder",
    }
}

fn fstat(fd: RawFd) -> io::Result<libc::stat> {
    let mut st = std::mem::MaybeUninit::<libc::stat>::zeroed();
    if unsafe { libc::fstat(fd, st.as_mut_ptr()) } != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: fstat devolvió éxito.
    Ok(unsafe { st.assume_init() })
}
