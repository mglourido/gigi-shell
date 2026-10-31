//! Sesión de captura: registro, búsqueda del escritorio por nombre y bucle de fotogramas.

use std::collections::HashMap;
use std::io::Write;
use std::os::fd::{AsFd, AsRawFd, FromRawFd, OwnedFd};
use std::time::{Duration, Instant};

use wayland_client::backend::WaylandError;
use wayland_client::protocol::{wl_buffer, wl_registry, wl_shm, wl_shm_pool};
use wayland_client::{
    event_created_child, globals::{registry_queue_init, GlobalListContents},
    Connection, Dispatch, EventQueue, Proxy, QueueHandle, WEnum,
};
use wayland_protocols::ext::image_capture_source::v1::client::ext_image_capture_source_v1::ExtImageCaptureSourceV1;
use wayland_protocols::ext::image_copy_capture::v1::client::{
    ext_image_copy_capture_frame_v1::{self as marco, ExtImageCopyCaptureFrameV1},
    ext_image_copy_capture_manager_v1::{ExtImageCopyCaptureManagerV1, Options as OpcionesSesion},
    ext_image_copy_capture_session_v1::{self as sesion, ExtImageCopyCaptureSessionV1},
};
use wayland_protocols::ext::workspace::v1::client::{
    ext_workspace_group_handle_v1::ExtWorkspaceGroupHandleV1,
    ext_workspace_handle_v1::{self as escritorio, ExtWorkspaceHandleV1},
    ext_workspace_manager_v1::{self as gestor_escritorios, ExtWorkspaceManagerV1},
};

use crate::protocolo::hyprland_workspace_image_capture_source_manager_v1::{
    CaptureMode, HyprlandWorkspaceImageCaptureSourceManagerV1,
};
use crate::filtro::{Filtro, Firma};
use crate::planificador::{Accion, Ajustes, Modo, Plan, Ritmos};
use crate::reducir::{Recorte, Reductor};

const MEDIDA_MAX_FIRMA: usize = 1280;
const HILOS_FILTRO: usize = 2;
/// Una captura sin respuesta en este tiempo se abandona: el conjunto de búferes es limitado y un
/// hueco que no vuelve dejaría sin imagen a los demás escritorios. Lo normal son milisegundos.
const ESPERA_MAX_CAPTURA: Duration = Duration::from_secs(2);

pub struct Opciones {
    /// `None` en `--sesiones`: los escritorios llegan por stdin.
    pub escritorio: Option<String>,
    pub ancho: usize,
    pub alto: usize,
    pub intervalo_ms: u64,
    pub intervalo_respaldo_ms: Option<u64>,
    pub recorte: Recorte,
    pub buferes: usize,
    pub imagen_fija: bool,
    pub solo_refinado: bool,
}

pub enum Fallo {
    SinProtocolo(&'static str),
    Otro(String),
}

impl<E: std::fmt::Display> From<E> for Fallo {
    fn from(error: E) -> Self {
        Fallo::Otro(error.to_string())
    }
}

struct Sesion {
    objeto: ExtImageCopyCaptureSessionV1,
    fuente: ExtImageCaptureSourceV1,
    asa: ExtWorkspaceHandleV1,
    lista: bool,
    detenida: bool,
    plan: Option<Plan>,
    firma: Vec<u8>,
    capturando: bool,
}

#[derive(Default)]
struct Estado {
    escritorios: Vec<(ExtWorkspaceHandleV1, String)>,
    lista_recibida: bool,
    sesiones: HashMap<u32, Sesion>,
    ancho_buffer: usize,
    alto_buffer: usize,
    formato_shm: Option<wl_shm::Format>,
    /// Huecos del conjunto con el resultado de su captura, que recoge el bucle.
    terminados: Vec<(usize, Result<(), WEnum<marco::FailureReason>>)>,
}

struct Globales {
    shm: wl_shm::WlShm,
    fuentes: HyprlandWorkspaceImageCaptureSourceManagerV1,
    copia: ExtImageCopyCaptureManagerV1,
}

fn conectar() -> Result<(Connection, EventQueue<Estado>, QueueHandle<Estado>, Globales), Fallo> {
    let conexion = Connection::connect_to_env()?;
    let (globales, cola) = registry_queue_init::<Estado>(&conexion)?;
    let qh = cola.handle();
    let fuentes = globales
        .bind(&qh, 1..=1, ())
        .map_err(|_| Fallo::SinProtocolo(HyprlandWorkspaceImageCaptureSourceManagerV1::interface().name))?;
    let copia = globales
        .bind(&qh, 1..=1, ())
        .map_err(|_| Fallo::SinProtocolo(ExtImageCopyCaptureManagerV1::interface().name))?;
    // Sin campo en `Globales`: basta con enlazarlo para que anuncie los escritorios.
    let _: ExtWorkspaceManagerV1 = globales
        .bind(&qh, 1..=1, ())
        .map_err(|_| Fallo::SinProtocolo(ExtWorkspaceManagerV1::interface().name))?;
    let shm = globales
        .bind(&qh, 1..=1, ())
        .map_err(|_| Fallo::SinProtocolo(wl_shm::WlShm::interface().name))?;
    Ok((conexion, cola, qh, Globales { shm, fuentes, copia }))
}

/// `--comprobar`: el compositor ofrece todo lo necesario. Lo usa `bin/preflight.sh`.
pub fn comprobar() -> Result<(), Fallo> {
    conectar().map(|_| ())
}

/// Bloque compartido con el compositor donde deposita cada fotograma a tamaño de salida.
struct BufferCompartido {
    mapa: *mut libc::c_void,
    bytes: usize,
    ancho: usize,
    alto: usize,
    buffer: wl_buffer::WlBuffer,
}

impl BufferCompartido {
    fn crear(shm: &wl_shm::WlShm, qh: &QueueHandle<Estado>, ancho: usize, alto: usize, formato: wl_shm::Format) -> Result<Self, Fallo> {
        let stride = ancho * 4;
        let bytes = stride * alto;
        // SAFETY: nombre con NUL; el descriptor devuelto pasa a ser propiedad de `fd`.
        let fd = unsafe {
            let crudo = libc::memfd_create(c"gigishell-vista-escritorio".as_ptr(), libc::MFD_CLOEXEC);
            if crudo < 0 {
                return Err(Fallo::Otro(format!("memfd_create: {}", std::io::Error::last_os_error())));
            }
            OwnedFd::from_raw_fd(crudo)
        };
        // SAFETY: `fd` es un memfd válido que vive durante ambas llamadas; se comprueba el mmap.
        let mapa = unsafe {
            if libc::ftruncate(fd.as_raw_fd(), bytes as libc::off_t) != 0 {
                return Err(Fallo::Otro(format!("ftruncate: {}", std::io::Error::last_os_error())));
            }
            libc::mmap(std::ptr::null_mut(), bytes, libc::PROT_READ, libc::MAP_SHARED, fd.as_raw_fd(), 0)
        };
        if mapa == libc::MAP_FAILED {
            return Err(Fallo::Otro(format!("mmap: {}", std::io::Error::last_os_error())));
        }
        let pool = shm.create_pool(fd.as_fd(), bytes as i32, qh, ());
        let buffer = pool.create_buffer(0, ancho as i32, alto as i32, stride as i32, formato, qh, ());
        pool.destroy();
        Ok(Self { mapa, bytes, ancho, alto, buffer })
    }

    fn contenido(&self) -> &[u8] {
        // SAFETY: mapeado de `bytes` de lectura durante toda la vida de `self`.
        unsafe { std::slice::from_raw_parts(self.mapa as *const u8, self.bytes) }
    }
}

/// Espera eventos de Wayland o de stdin hasta `limite`. Devuelve si hay algo que leer en stdin.
fn esperar(conexion: &Connection, cola: &mut EventQueue<Estado>, estado: &mut Estado, limite: Option<Instant>) -> Result<bool, Fallo> {
    cola.dispatch_pending(estado)?;
    // Socket lleno: lo no enviado sigue en el búfer y se reintenta en la siguiente vuelta.
    tolerar_bloqueo(conexion.flush())?;
    if !estado.terminados.is_empty() {
        return Ok(false);
    }
    let Some(lectura) = cola.prepare_read() else {
        return Ok(false);
    };
    // Redondeo al alza: a la baja, el último milisegundo se gasta dando vueltas con espera 0.
    let espera = limite.map_or(-1, |l| l.saturating_duration_since(Instant::now()).as_micros().div_ceil(1000).min(i32::MAX as u128) as i32);
    let mut descriptores = [
        libc::pollfd { fd: conexion.as_fd().as_raw_fd(), events: libc::POLLIN, revents: 0 },
        libc::pollfd { fd: libc::STDIN_FILENO, events: libc::POLLIN, revents: 0 },
    ];
    // SAFETY: array válido del tamaño indicado durante la llamada.
    let listos = unsafe { libc::poll(descriptores.as_mut_ptr(), 2, espera) };
    if listos < 0 {
        let error = std::io::Error::last_os_error();
        if error.kind() == std::io::ErrorKind::Interrupted {
            return Ok(false);
        }
        return Err(error.into());
    }
    if descriptores[0].revents != 0 {
        // También da `WouldBlock` si todo lo leído era para objetos ya destruidos, como la respuesta
        // a una captura abandonada al cerrar su sesión. No es un error.
        tolerar_bloqueo(lectura.read().map(|_| ()))?;
        cola.dispatch_pending(estado)?;
    }
    Ok(descriptores[1].revents != 0)
}

fn tolerar_bloqueo(resultado: Result<(), WaylandError>) -> Result<(), Fallo> {
    match resultado {
        Err(WaylandError::Io(error)) if error.kind() == std::io::ErrorKind::WouldBlock => Ok(()),
        otro => otro.map_err(Fallo::from),
    }
}

/// Lectura no bloqueante de stdin. Devuelve `false` al cerrarse.
fn leer_ordenes(pendiente: &mut Vec<u8>, ordenes: &mut Vec<Orden>) -> Result<bool, Fallo> {
    let mut trozo = [0u8; 1024];
    // SAFETY: búfer válido del tamaño indicado.
    let leidos = unsafe { libc::read(libc::STDIN_FILENO, trozo.as_mut_ptr().cast(), trozo.len()) };
    if leidos == 0 {
        return Ok(false);
    }
    if leidos < 0 {
        let error = std::io::Error::last_os_error();
        return match error.kind() {
            std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Interrupted => Ok(true),
            _ => Err(error.into()),
        };
    }
    pendiente.extend_from_slice(&trozo[..leidos as usize]);
    while let Some(fin) = pendiente.iter().position(|&b| b == b'\n') {
        let linea: Vec<u8> = pendiente.drain(..=fin).collect();
        if let Some(orden) = Orden::desde_texto(String::from_utf8_lossy(&linea[..fin]).trim()) {
            ordenes.push(orden);
        }
    }
    Ok(true)
}

#[derive(Debug, PartialEq, Eq)]
enum Orden {
    Anadir(u32, String),
    Quitar(u32),
}

impl Orden {
    fn desde_texto(texto: &str) -> Option<Self> {
        if let Some(resto) = texto.strip_prefix('+') {
            let (clave, nombre) = resto.split_once(' ')?;
            if nombre.is_empty() {
                return None;
            }
            return Some(Orden::Anadir(clave.parse().ok()?, nombre.to_string()));
        }
        Some(Orden::Quitar(texto.strip_prefix('-')?.parse().ok()?))
    }
}

/// Captura en curso en un hueco.
struct Captura {
    clave: u32,
    marco: ExtImageCopyCaptureFrameV1,
    inicio: Instant,
}

struct Hueco {
    compartido: BufferCompartido,
    ocupado: Option<Captura>,
}

fn abrir_sesion(estado: &mut Estado, globales: &Globales, qh: &QueueHandle<Estado>, clave: u32, nombre: &str) -> bool {
    let Some((asa, _)) = estado.escritorios.iter().find(|(_, n)| n == nombre) else {
        return false;
    };
    let asa = asa.clone();
    // Solo ventanas: `Everything` incluye las capas de AGS (barra, títulos flotantes y la propia
    // miniatura). El fondo de pantalla lo pone la barra debajo; ver fondoMiniatura.ts.
    let fuente = globales.fuentes.create_source(&asa, CaptureMode::WindowsOnly, qh, ());
    let objeto = globales.copia.create_session(&fuente, OpcionesSesion::empty(), qh, clave);
    estado.sesiones.insert(clave, Sesion { objeto, fuente, asa, lista: false, detenida: false, plan: None, firma: Vec::new(), capturando: false });
    true
}

/// Cierra una sesión aunque tenga una captura en curso. No espera su respuesta: una sesión detenida
/// no tiene por qué contestar, y el hueco se quedaría ocupado.
fn cerrar_sesion(estado: &mut Estado, huecos: &mut [Hueco], clave: u32) {
    if let Some(captura) = huecos.iter_mut().find(|h| h.ocupado.as_ref().is_some_and(|c| c.clave == clave)).and_then(|h| h.ocupado.take()) {
        captura.marco.destroy();
    }
    if let Some(s) = estado.sesiones.remove(&clave) {
        s.objeto.destroy();
        s.fuente.destroy();
    }
}

pub fn ejecutar(opciones: &Opciones) -> Result<(), Fallo> {
    let (conexion, mut cola, qh, globales) = conectar()?;
    let mut estado = Estado::default();
    while !estado.lista_recibida {
        cola.blocking_dispatch(&mut estado)?;
    }

    let multi = opciones.escritorio.is_none();
    let ajustes = Ajustes {
        activo: Duration::from_millis(opciones.intervalo_ms),
        activo_respaldo: opciones.intervalo_respaldo_ms.map(Duration::from_millis),
        modo: if opciones.imagen_fija {
            Modo::UnaVez
        } else if multi {
            Modo::Congelable
        } else {
            Modo::Fijo
        },
        solo_refinado: opciones.solo_refinado,
    };
    let mut ritmos = Ritmos::new(&ajustes);

    if let Some(nombre) = &opciones.escritorio {
        if !abrir_sesion(&mut estado, &globales, &qh, 0, nombre) {
            return Err(Fallo::Otro(format!("no existe el escritorio {nombre}")));
        }
    }
    // SAFETY: fcntl sobre un descriptor abierto; solo añade O_NONBLOCK.
    unsafe {
        let banderas = libc::fcntl(libc::STDIN_FILENO, libc::F_GETFL);
        libc::fcntl(libc::STDIN_FILENO, libc::F_SETFL, banderas | libc::O_NONBLOCK);
    }

    let mut por_abrir: Vec<(u32, String)> = Vec::new();
    let mut pendiente_stdin = Vec::new();
    let mut huecos: Vec<Hueco> = Vec::new();
    let mut herramientas: Option<Herramientas> = None;
    let mut salida = std::io::stdout().lock();

    loop {
        // Recoger capturas terminadas.
        for (indice, resultado) in std::mem::take(&mut estado.terminados) {
            let hueco = &mut huecos[indice];
            let Some(captura) = hueco.ocupado.take() else { continue };
            captura.marco.destroy();
            let Some(s) = estado.sesiones.get_mut(&captura.clave) else { continue };
            s.capturando = false;
            // Un escritorio retirado sirve imágenes vacías y transparentes: nunca se envían.
            if s.detenida {
                continue;
            }
            match resultado {
                Err(motivo) if multi => {
                    eprintln!("fotograma fallido en {}: {motivo:?}", captura.clave);
                    s.detenida = true;
                }
                Err(motivo) => return Err(Fallo::Otro(format!("fotograma fallido: {motivo:?}"))),
                Ok(()) => {
                    let h = herramientas.as_mut().expect("hay huecos, así que hay herramientas");
                    h.procesar(captura.clave, s, captura.inicio, hueco.compartido.contenido(), &mut ritmos, &mut salida)?;
                }
            }
        }

        // Capturas sin respuesta: liberan el hueco y ceden el turno a los demás escritorios.
        let ahora = Instant::now();
        for hueco in &mut huecos {
            if hueco.ocupado.as_ref().is_some_and(|c| ahora.duration_since(c.inicio) >= ESPERA_MAX_CAPTURA) {
                let Some(captura) = hueco.ocupado.take() else { continue };
                captura.marco.destroy();
                eprintln!("captura sin respuesta en {}", captura.clave);
                if let Some(s) = estado.sesiones.get_mut(&captura.clave) {
                    s.capturando = false;
                    if let Some(plan) = s.plan.as_mut() {
                        plan.aplazar(ahora + ritmos.activo);
                    }
                }
            }
        }

        // Sesiones detenidas o terminadas.
        let caducadas: Vec<u32> = estado
            .sesiones
            .iter()
            .filter(|(_, s)| s.detenida || s.plan.as_ref().is_some_and(Plan::terminado))
            .map(|(clave, _)| *clave)
            .collect();
        for clave in caducadas {
            cerrar_sesion(&mut estado, &mut huecos, clave);
        }
        if !multi && estado.sesiones.is_empty() {
            return Ok(());
        }

        // Altas pendientes, después de cerrar: `-3` y `+3` seguidos reabren la clave. Con la clave
        // ya abierta es un duplicado, y abrirla perdería la sesión y su captura en curso. Un nombre
        // puede anunciarse después de pedirlo, y entonces la orden espera aquí.
        por_abrir.retain(|(clave, nombre)| !estado.sesiones.contains_key(clave) && !abrir_sesion(&mut estado, &globales, &qh, *clave, nombre));

        // Primera sesión lista: ya se conoce el tamaño del búfer.
        if huecos.is_empty() && estado.sesiones.values().any(|s| s.lista) {
            let formato = estado.formato_shm.ok_or_else(|| Fallo::Otro("sin formato SHM de 32 bits".into()))?;
            if !opciones.recorte.cabe_en(estado.ancho_buffer, estado.alto_buffer) {
                return Err(Fallo::Otro("el recorte no deja imagen".into()));
            }
            for _ in 0..opciones.buferes.max(1) {
                huecos.push(Hueco {
                    compartido: BufferCompartido::crear(&globales.shm, &qh, estado.ancho_buffer, estado.alto_buffer, formato)?,
                    ocupado: None,
                });
            }
            herramientas = Some(Herramientas::new(&estado, opciones, multi));
        }

        // Repartir huecos libres: primero el más atrasado.
        let ahora = Instant::now();
        for s in estado.sesiones.values_mut() {
            if s.lista && s.plan.is_none() {
                s.plan = Some(Plan::new(ahora, &ajustes));
            }
        }
        let mut proxima_cita = None::<Instant>;
        for (indice, hueco) in huecos.iter_mut().enumerate() {
            if hueco.ocupado.is_some() {
                continue;
            }
            let candidata = estado
                .sesiones
                .iter_mut()
                .filter(|(_, s)| !s.capturando && s.plan.is_some())
                .min_by_key(|(_, s)| s.plan.as_ref().map(Plan::proxima));
            let Some((&clave, s)) = candidata else { break };
            let cita = s.plan.as_ref().expect("filtrado arriba").proxima();
            if cita > ahora {
                proxima_cita = Some(cita);
                break;
            }
            let marco = s.objeto.create_frame(&qh, indice);
            marco.attach_buffer(&hueco.compartido.buffer);
            // La medida del búfer, no la de `estado`: esa la pisa cualquier sesión que la anuncie.
            marco.damage_buffer(0, 0, hueco.compartido.ancho as i32, hueco.compartido.alto as i32);
            marco.capture();
            s.capturando = true;
            hueco.ocupado = Some(Captura { clave, marco, inicio: ahora });
        }

        let limite_captura = huecos.iter().filter_map(|h| h.ocupado.as_ref().map(|c| c.inicio + ESPERA_MAX_CAPTURA)).min();
        let limite = [proxima_cita, limite_captura].into_iter().flatten().min();
        if esperar(&conexion, &mut cola, &mut estado, limite)? {
            let mut ordenes = Vec::new();
            if !leer_ordenes(&mut pendiente_stdin, &mut ordenes)? {
                return Ok(());
            }
            for orden in ordenes {
                match orden {
                    Orden::Anadir(clave, nombre) if multi => por_abrir.push((clave, nombre)),
                    Orden::Quitar(clave) if multi => {
                        por_abrir.retain(|(c, _)| *c != clave);
                        if let Some(s) = estado.sesiones.get_mut(&clave) {
                            s.detenida = true;
                        }
                    }
                    _ => {}
                }
            }
        }
    }
}

struct Herramientas {
    reductor: Option<Reductor>,
    filtro: Option<Filtro>,
    firma: Option<Firma>,
    miniatura: Vec<u8>,
    anterior: Vec<u8>,
    firma_nueva: Vec<u8>,
    intermedio: Vec<u8>,
    primero: bool,
}

impl Herramientas {
    fn new(estado: &Estado, o: &Opciones, multi: bool) -> Self {
        let (ao, ho, stride) = (estado.ancho_buffer, estado.alto_buffer, estado.ancho_buffer * 4);
        if multi {
            let filtro = Filtro::new(ao, ho, stride, o.recorte, o.ancho, o.alto, HILOS_FILTRO);
            let ancho_firma = o.ancho.min(MEDIDA_MAX_FIRMA);
            let alto_firma = (o.alto * ancho_firma / o.ancho).max(1);
            let firma = Firma::new(ao, ho, stride, o.recorte, ancho_firma, alto_firma);
            Self {
                reductor: None,
                miniatura: vec![0; filtro.bytes_destino()],
                anterior: Vec::new(),
                firma_nueva: vec![0; firma.bytes()],
                intermedio: Vec::new(),
                filtro: Some(filtro),
                firma: Some(firma),
                primero: true,
            }
        } else {
            let reductor = Reductor::new(ao, ho, stride, o.recorte, o.ancho, o.alto);
            Self {
                miniatura: vec![0; reductor.bytes_destino()],
                anterior: vec![0; reductor.bytes_destino()],
                reductor: Some(reductor),
                filtro: None,
                firma: None,
                firma_nueva: Vec::new(),
                intermedio: Vec::new(),
                primero: true,
            }
        }
    }

    /// `inicio` es cuándo se pidió la captura, no cuándo llegó: el periodo no debe incluir lo que
    /// tarda Hyprland, o el ritmo sería `intervalo + latencia` y la vista grande a 16 ms caería
    /// siempre a su respaldo.
    fn procesar(&mut self, clave: u32, s: &mut Sesion, inicio: Instant, origen: &[u8], ritmos: &mut Ritmos, salida: &mut impl Write) -> Result<(), Fallo> {
        let plan = s.plan.as_mut().expect("solo se captura con plan");
        if let Some(reductor) = &self.reductor {
            reductor.reducir(origen, &mut self.miniatura);
            // Hyprland declara daño completo en cada fotograma (`TODO` en ScreenshareFrame::share):
            // comparar es la única forma de no repintar la miniatura cuando no ha cambiado nada.
            let cambio = self.primero || self.miniatura != self.anterior;
            plan.tras_captura(inicio, cambio, ritmos);
            if cambio {
                salida.write_all(&self.miniatura)?;
                salida.flush()?;
                std::mem::swap(&mut self.miniatura, &mut self.anterior);
                self.primero = false;
            }
            return Ok(());
        }
        let firma = self.firma.as_ref().expect("modo de sesiones");
        let filtro = self.filtro.as_ref().expect("modo de sesiones");
        firma.calcular(origen, &mut self.firma_nueva);
        let cambio = s.firma != self.firma_nueva;
        if cambio {
            s.firma.clear();
            s.firma.extend_from_slice(&self.firma_nueva);
        }
        match plan.tras_captura(inicio, cambio, ritmos) {
            Accion::Nada => return Ok(()),
            Accion::EnviarRapido => filtro.caja(origen, &mut self.miniatura, &mut self.intermedio),
            Accion::EnviarRefinado => filtro.lanczos(origen, &mut self.miniatura, &mut self.intermedio),
        }
        salida.write_all(&clave.to_le_bytes())?;
        salida.write_all(&self.miniatura)?;
        salida.flush()?;
        Ok(())
    }
}

impl Dispatch<wl_registry::WlRegistry, GlobalListContents> for Estado {
    fn event(_: &mut Self, _: &wl_registry::WlRegistry, _: wl_registry::Event, _: &GlobalListContents, _: &Connection, _: &QueueHandle<Self>) {}
}

impl Dispatch<ExtWorkspaceManagerV1, ()> for Estado {
    fn event(estado: &mut Self, _: &ExtWorkspaceManagerV1, evento: gestor_escritorios::Event, _: &(), _: &Connection, _: &QueueHandle<Self>) {
        match evento {
            gestor_escritorios::Event::Workspace { workspace } => estado.escritorios.push((workspace, String::new())),
            gestor_escritorios::Event::Done => estado.lista_recibida = true,
            _ => {}
        }
    }

    event_created_child!(Estado, ExtWorkspaceManagerV1, [
        gestor_escritorios::EVT_WORKSPACE_GROUP_OPCODE => (ExtWorkspaceGroupHandleV1, ()),
        gestor_escritorios::EVT_WORKSPACE_OPCODE => (ExtWorkspaceHandleV1, ()),
    ]);
}

impl Dispatch<ExtWorkspaceHandleV1, ()> for Estado {
    fn event(estado: &mut Self, asa: &ExtWorkspaceHandleV1, evento: escritorio::Event, _: &(), _: &Connection, _: &QueueHandle<Self>) {
        match evento {
            escritorio::Event::Name { name } => {
                if let Some(entrada) = estado.escritorios.iter_mut().find(|(propio, _)| propio == asa) {
                    entrada.1 = name;
                }
            }
            // Sin esto seguiría capturando: el protocolo sirve imágenes vacías y transparentes
            // de un escritorio que ya no existe, en vez de detener la sesión.
            escritorio::Event::Removed => {
                for s in estado.sesiones.values_mut() {
                    if s.asa == *asa {
                        s.detenida = true;
                    }
                }
                estado.escritorios.retain(|(propio, _)| propio != asa);
            }
            _ => {}
        }
    }
}

impl Dispatch<ExtImageCopyCaptureSessionV1, u32> for Estado {
    fn event(estado: &mut Self, _: &ExtImageCopyCaptureSessionV1, evento: sesion::Event, clave: &u32, _: &Connection, _: &QueueHandle<Self>) {
        match evento {
            sesion::Event::BufferSize { width, height } => {
                estado.ancho_buffer = width as usize;
                estado.alto_buffer = height as usize;
            }
            sesion::Event::ShmFormat { format: WEnum::Value(formato) } => {
                if matches!(formato, wl_shm::Format::Argb8888 | wl_shm::Format::Xrgb8888) && estado.formato_shm != Some(wl_shm::Format::Argb8888) {
                    estado.formato_shm = Some(formato);
                }
            }
            sesion::Event::Done => {
                if let Some(s) = estado.sesiones.get_mut(clave) {
                    s.lista = true;
                }
            }
            sesion::Event::Stopped => {
                if let Some(s) = estado.sesiones.get_mut(clave) {
                    s.detenida = true;
                }
            }
            _ => {}
        }
    }
}

impl Dispatch<ExtImageCopyCaptureFrameV1, usize> for Estado {
    fn event(estado: &mut Self, _: &ExtImageCopyCaptureFrameV1, evento: marco::Event, hueco: &usize, _: &Connection, _: &QueueHandle<Self>) {
        match evento {
            marco::Event::Ready => estado.terminados.push((*hueco, Ok(()))),
            marco::Event::Failed { reason } => estado.terminados.push((*hueco, Err(reason))),
            _ => {}
        }
    }
}

wayland_client::delegate_noop!(Estado: ignore wl_shm::WlShm);
wayland_client::delegate_noop!(Estado: ignore wl_shm_pool::WlShmPool);
wayland_client::delegate_noop!(Estado: ignore wl_buffer::WlBuffer);
wayland_client::delegate_noop!(Estado: ignore ExtWorkspaceGroupHandleV1);
wayland_client::delegate_noop!(Estado: ignore ExtImageCaptureSourceV1);
wayland_client::delegate_noop!(Estado: ignore HyprlandWorkspaceImageCaptureSourceManagerV1);
wayland_client::delegate_noop!(Estado: ignore ExtImageCopyCaptureManagerV1);

#[cfg(test)]
mod pruebas {
    use super::*;

    #[test]
    fn lee_las_ordenes_y_rechaza_las_mal_formadas() {
        assert_eq!(Orden::desde_texto("+3 3"), Some(Orden::Anadir(3, "3".into())));
        assert_eq!(Orden::desde_texto("+3 con espacio"), Some(Orden::Anadir(3, "con espacio".into())));
        assert_eq!(Orden::desde_texto("-3"), Some(Orden::Quitar(3)));
        for mala in ["", "+3", "+a b", "-a", "3"] {
            assert_eq!(Orden::desde_texto(mala), None, "{mala}");
        }
    }
}
