//! Sesión de captura: registro, búsqueda del escritorio por nombre y bucle de fotogramas.

use std::io::Write;
use std::os::fd::{AsFd, AsRawFd, FromRawFd, OwnedFd};
use std::time::{Duration, Instant};

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
use crate::reducir::{Recorte, Reductor};

pub struct Opciones {
    pub escritorio: String,
    pub ancho: usize,
    pub alto: usize,
    pub intervalo_ms: u64,
    pub recorte: Recorte,
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

#[derive(Default)]
struct Estado {
    escritorios: Vec<(ExtWorkspaceHandleV1, String)>,
    objetivo: Option<ExtWorkspaceHandleV1>,
    lista_recibida: bool,
    ancho_buffer: usize,
    alto_buffer: usize,
    formato_shm: Option<wl_shm::Format>,
    restricciones_listas: bool,
    sesion_detenida: bool,
    marco_listo: bool,
    marco_fallido: Option<WEnum<marco::FailureReason>>,
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
        Ok(Self { mapa, bytes, buffer })
    }

    fn contenido(&self) -> &[u8] {
        // SAFETY: mapeado de `bytes` de lectura durante toda la vida de `self`.
        unsafe { std::slice::from_raw_parts(self.mapa as *const u8, self.bytes) }
    }
}

/// Espera eventos de Wayland o de stdin hasta `limite`. Devuelve `true` si stdin se cerró.
fn esperar(conexion: &Connection, cola: &mut EventQueue<Estado>, estado: &mut Estado, limite: Option<Instant>) -> Result<bool, Fallo> {
    cola.dispatch_pending(estado)?;
    conexion.flush()?;
    let Some(lectura) = cola.prepare_read() else {
        return Ok(false);
    };
    let espera = limite.map_or(-1, |l| l.saturating_duration_since(Instant::now()).as_millis().min(i32::MAX as u128) as i32);
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
    if descriptores[1].revents != 0 {
        return Ok(true);
    }
    if descriptores[0].revents != 0 {
        lectura.read()?;
        cola.dispatch_pending(estado)?;
    }
    Ok(false)
}

pub fn ejecutar(opciones: &Opciones) -> Result<(), Fallo> {
    let (conexion, mut cola, qh, globales) = conectar()?;
    let mut estado = Estado::default();

    while !estado.lista_recibida {
        cola.blocking_dispatch(&mut estado)?;
    }
    let Some((asa, _)) = estado.escritorios.iter().find(|(_, nombre)| *nombre == opciones.escritorio) else {
        return Err(Fallo::Otro(format!("no existe el escritorio {}", opciones.escritorio)));
    };
    let asa = asa.clone();
    // Solo ventanas: `Everything` incluye las capas de AGS (barra, títulos flotantes y la propia
    // miniatura). El fondo de pantalla lo pone la barra debajo; ver fondoMiniatura.ts.
    let fuente = globales.fuentes.create_source(&asa, CaptureMode::WindowsOnly, &qh, ());
    estado.objetivo = Some(asa);
    let sesion = globales.copia.create_session(&fuente, OpcionesSesion::empty(), &qh, ());
    while !estado.restricciones_listas && !estado.sesion_detenida {
        cola.blocking_dispatch(&mut estado)?;
    }
    if estado.sesion_detenida {
        return Ok(());
    }
    let formato = estado.formato_shm.ok_or_else(|| Fallo::Otro("sin formato SHM de 32 bits".into()))?;
    let compartido = BufferCompartido::crear(&globales.shm, &qh, estado.ancho_buffer, estado.alto_buffer, formato)?;
    if !opciones.recorte.cabe_en(estado.ancho_buffer, estado.alto_buffer) {
        return Err(Fallo::Otro("el recorte no deja imagen".into()));
    }
    let reductor = Reductor::new(estado.ancho_buffer, estado.alto_buffer, estado.ancho_buffer * 4, opciones.recorte, opciones.ancho, opciones.alto);
    let mut miniatura = vec![0u8; reductor.bytes_destino()];
    let mut anterior = vec![0u8; reductor.bytes_destino()];
    let mut salida = std::io::stdout().lock();
    let intervalo = Duration::from_millis(opciones.intervalo_ms);
    let mut primero = true;

    loop {
        let inicio = Instant::now();
        estado.marco_listo = false;
        estado.marco_fallido = None;
        let fotograma = sesion.create_frame(&qh, ());
        fotograma.attach_buffer(&compartido.buffer);
        fotograma.damage_buffer(0, 0, estado.ancho_buffer as i32, estado.alto_buffer as i32);
        fotograma.capture();
        while !estado.marco_listo && estado.marco_fallido.is_none() && !estado.sesion_detenida {
            if esperar(&conexion, &mut cola, &mut estado, None)? {
                return Ok(());
            }
        }
        fotograma.destroy();
        if estado.sesion_detenida {
            return Ok(());
        }
        if let Some(motivo) = estado.marco_fallido {
            return Err(Fallo::Otro(format!("fotograma fallido: {motivo:?}")));
        }
        reductor.reducir(compartido.contenido(), &mut miniatura);
        // Hyprland declara daño completo en cada fotograma (`TODO` en ScreenshareFrame::share):
        // comparar es la única forma de no repintar la miniatura cuando no ha cambiado nada.
        if primero || miniatura != anterior {
            salida.write_all(&miniatura)?;
            salida.flush()?;
            std::mem::swap(&mut miniatura, &mut anterior);
            primero = false;
        }
        let siguiente = inicio + intervalo;
        while Instant::now() < siguiente {
            if esperar(&conexion, &mut cola, &mut estado, Some(siguiente))? {
                return Ok(());
            }
        }
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
            escritorio::Event::Removed if estado.objetivo.as_ref() == Some(asa) => {
                estado.sesion_detenida = true;
            }
            _ => {}
        }
    }
}

impl Dispatch<ExtImageCopyCaptureSessionV1, ()> for Estado {
    fn event(estado: &mut Self, _: &ExtImageCopyCaptureSessionV1, evento: sesion::Event, _: &(), _: &Connection, _: &QueueHandle<Self>) {
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
            sesion::Event::Done => estado.restricciones_listas = true,
            sesion::Event::Stopped => estado.sesion_detenida = true,
            _ => {}
        }
    }
}

impl Dispatch<ExtImageCopyCaptureFrameV1, ()> for Estado {
    fn event(estado: &mut Self, _: &ExtImageCopyCaptureFrameV1, evento: marco::Event, _: &(), _: &Connection, _: &QueueHandle<Self>) {
        match evento {
            marco::Event::Ready => estado.marco_listo = true,
            marco::Event::Failed { reason } => estado.marco_fallido = Some(reason),
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
