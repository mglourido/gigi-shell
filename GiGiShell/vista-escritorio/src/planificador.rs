//! Cuándo capturar cada escritorio y qué hacer con cada captura. Sin Wayland ni reloj real: el
//! bucle de `captura.rs` le pasa el instante, así que las transiciones se prueban aquí.

use std::time::{Duration, Instant};

const ARRANQUE: Duration = Duration::from_millis(300);
const CONGELAR_TRAS: Duration = Duration::from_secs(10);
const COMPROBAR: Duration = Duration::from_millis(300);
const COMPROBAR_RESPALDO: Duration = Duration::from_secs(1);
/// 1,5 veces el periodo previsto.
const COMPROBAR_LENTO: Duration = Duration::from_millis(450);
/// Por debajo de 50 fps la vista grande no merece su coste a 60.
const ACTIVO_LENTO: Duration = Duration::from_millis(20);
const VENTANA: Duration = Duration::from_secs(2);
/// Sin este mínimo, una o dos muestras sueltas tras un hueco fijarían un respaldo para siempre.
const MUESTRAS_MINIMAS: u32 = 4;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Modo {
    /// La miniatura de la barra: siempre al mismo ritmo, sin congelar.
    Fijo,
    Congelable,
    /// Pausa de miniaturas en modo ahorro: un fotograma y se acabó.
    UnaVez,
}

#[derive(Clone, Copy)]
pub struct Ajustes {
    pub activo: Duration,
    pub activo_respaldo: Option<Duration>,
    pub modo: Modo,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Accion {
    Nada,
    EnviarRapido,
    EnviarRefinado,
}

#[derive(Default)]
struct Media {
    desde: Option<Instant>,
    ultima: Option<Instant>,
    total: Duration,
    cuenta: u32,
}

impl Media {
    /// Anota un periodo y, al cumplirse la ventana con muestras suficientes, devuelve la media y
    /// empieza otra. Un hueco mayor que la ventana (otra fase sin muestras) reinicia la media antes
    /// de anotar, para que no cuente como ventana.
    fn anotar(&mut self, ahora: Instant, periodo: Duration) -> Option<Duration> {
        if self.ultima.is_some_and(|u| ahora.duration_since(u) > VENTANA) {
            *self = Media::default();
        }
        let desde = *self.desde.get_or_insert(ahora - periodo);
        self.ultima = Some(ahora);
        self.total += periodo;
        self.cuenta += 1;
        if self.cuenta < MUESTRAS_MINIMAS || ahora.duration_since(desde) < VENTANA {
            return None;
        }
        let media = self.total / self.cuenta;
        *self = Media::default();
        Some(media)
    }
}

/// Ritmos de toda la sesión. Un respaldo no se deshace hasta la siguiente apertura: con menos
/// capturas la medida mejora sola, y volver por ella haría oscilar el ritmo.
pub struct Ritmos {
    pub activo: Duration,
    pub comprobar: Duration,
    activo_respaldo: Option<Duration>,
    media_comprobar: Media,
    media_activo: Media,
}

impl Ritmos {
    pub fn new(ajustes: &Ajustes) -> Self {
        Self {
            activo: ajustes.activo,
            comprobar: COMPROBAR,
            activo_respaldo: ajustes.activo_respaldo,
            media_comprobar: Media::default(),
            media_activo: Media::default(),
        }
    }

    pub fn anotar_comprobacion(&mut self, ahora: Instant, periodo: Duration) {
        if self.comprobar == COMPROBAR_RESPALDO {
            return;
        }
        if self.media_comprobar.anotar(ahora, periodo).is_some_and(|m| m > COMPROBAR_LENTO) {
            self.comprobar = COMPROBAR_RESPALDO;
        }
    }

    pub fn anotar_activo(&mut self, ahora: Instant, periodo: Duration) {
        let Some(respaldo) = self.activo_respaldo else { return };
        if self.media_activo.anotar(ahora, periodo).is_some_and(|m| m > ACTIVO_LENTO) {
            self.activo = respaldo;
            self.activo_respaldo = None;
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Fase {
    Inicial,
    Arranque { hasta: Instant },
    Activa { ultimo_cambio: Instant },
    Congelada,
    Terminada,
}

pub struct Plan {
    fase: Fase,
    modo: Modo,
    proxima: Instant,
    anterior: Option<Instant>,
}

impl Plan {
    pub fn new(ahora: Instant, ajustes: &Ajustes) -> Self {
        Self { fase: Fase::Inicial, modo: ajustes.modo, proxima: ahora, anterior: None }
    }

    pub fn proxima(&self) -> Instant {
        self.proxima
    }

    /// Tras una captura abandonada, para que no vuelva a ser la más atrasada y acapare un hueco.
    pub fn aplazar(&mut self, hasta: Instant) {
        self.proxima = hasta;
    }

    pub fn terminado(&self) -> bool {
        self.fase == Fase::Terminada
    }

    pub fn tras_captura(&mut self, ahora: Instant, cambio: bool, ritmos: &mut Ritmos) -> Accion {
        let periodo = self.anterior.map(|a| ahora.duration_since(a));
        self.anterior = Some(ahora);
        let (fase, accion) = self.transicion(ahora, cambio);
        if let Some(periodo) = periodo {
            match self.fase {
                Fase::Congelada => ritmos.anotar_comprobacion(ahora, periodo),
                Fase::Activa { .. } if cambio => ritmos.anotar_activo(ahora, periodo),
                _ => {}
            }
        }
        self.fase = fase;
        self.proxima = ahora + if fase == Fase::Congelada { ritmos.comprobar } else { ritmos.activo };
        accion
    }

    fn transicion(&self, ahora: Instant, cambio: bool) -> (Fase, Accion) {
        match (self.fase, self.modo) {
            (Fase::Inicial, Modo::UnaVez) => (Fase::Terminada, Accion::EnviarRefinado),
            (Fase::Inicial, Modo::Fijo) => (Fase::Activa { ultimo_cambio: ahora }, Accion::EnviarRapido),
            (Fase::Inicial, Modo::Congelable) => (Fase::Arranque { hasta: ahora + ARRANQUE }, Accion::EnviarRapido),
            (Fase::Arranque { .. }, _) if cambio => (Fase::Activa { ultimo_cambio: ahora }, Accion::EnviarRapido),
            (Fase::Arranque { hasta }, _) if ahora >= hasta => (Fase::Congelada, Accion::EnviarRefinado),
            (f @ Fase::Arranque { .. }, _) => (f, Accion::Nada),
            (Fase::Activa { .. }, _) if cambio => (Fase::Activa { ultimo_cambio: ahora }, Accion::EnviarRapido),
            (Fase::Activa { ultimo_cambio }, Modo::Congelable) if ahora.duration_since(ultimo_cambio) >= CONGELAR_TRAS => {
                (Fase::Congelada, Accion::EnviarRefinado)
            }
            (f @ Fase::Activa { .. }, _) => (f, Accion::Nada),
            (Fase::Congelada, _) if cambio => (Fase::Activa { ultimo_cambio: ahora }, Accion::EnviarRapido),
            (Fase::Congelada, _) => (Fase::Congelada, Accion::Nada),
            (Fase::Terminada, _) => (Fase::Terminada, Accion::Nada),
        }
    }
}

#[cfg(test)]
mod pruebas {
    use super::*;

    const fn ms(n: u64) -> Duration { Duration::from_millis(n) }

    fn ajustes() -> Ajustes {
        Ajustes { activo: ms(33), activo_respaldo: None, modo: Modo::Congelable }
    }

    #[test]
    fn sin_cambios_al_abrir_se_congela_con_un_refinado() {
        let (t0, a) = (Instant::now(), ajustes());
        let mut ritmos = Ritmos::new(&a);
        let mut plan = Plan::new(t0, &a);
        assert_eq!(plan.tras_captura(t0, true, &mut ritmos), Accion::EnviarRapido);
        assert_eq!(plan.proxima(), t0 + ms(33));
        assert_eq!(plan.tras_captura(t0 + ms(100), false, &mut ritmos), Accion::Nada);
        assert_eq!(plan.tras_captura(t0 + ms(301), false, &mut ritmos), Accion::EnviarRefinado);
        assert_eq!(plan.proxima(), t0 + ms(601));
    }

    #[test]
    fn un_cambio_al_abrir_lo_deja_activo() {
        let (t0, a) = (Instant::now(), ajustes());
        let mut ritmos = Ritmos::new(&a);
        let mut plan = Plan::new(t0, &a);
        plan.tras_captura(t0, true, &mut ritmos);
        assert_eq!(plan.tras_captura(t0 + ms(66), true, &mut ritmos), Accion::EnviarRapido);
        assert_eq!(plan.tras_captura(t0 + ms(400), false, &mut ritmos), Accion::Nada);
        assert_eq!(plan.proxima(), t0 + ms(433));
    }

    #[test]
    fn activo_se_congela_tras_diez_segundos_sin_cambios() {
        let (t0, a) = (Instant::now(), ajustes());
        let mut ritmos = Ritmos::new(&a);
        let mut plan = Plan::new(t0, &a);
        plan.tras_captura(t0, true, &mut ritmos);
        plan.tras_captura(t0 + ms(50), true, &mut ritmos);
        assert_eq!(plan.tras_captura(t0 + ms(10_040), false, &mut ritmos), Accion::Nada);
        assert_eq!(plan.tras_captura(t0 + ms(10_060), false, &mut ritmos), Accion::EnviarRefinado);
    }

    #[test]
    fn congelado_se_descongela_con_un_cambio() {
        let (t0, a) = (Instant::now(), ajustes());
        let mut ritmos = Ritmos::new(&a);
        let mut plan = Plan::new(t0, &a);
        plan.tras_captura(t0, true, &mut ritmos);
        plan.tras_captura(t0 + ms(301), false, &mut ritmos);
        assert_eq!(plan.tras_captura(t0 + ms(601), true, &mut ritmos), Accion::EnviarRapido);
        assert_eq!(plan.proxima(), t0 + ms(634));
    }

    #[test]
    fn comprobaciones_lentas_activan_el_respaldo_y_no_vuelve() {
        let t0 = Instant::now();
        let mut ritmos = Ritmos::new(&ajustes());
        for i in 1..=5 {
            ritmos.anotar_comprobacion(t0 + ms(i * 500), ms(500));
        }
        assert_eq!(ritmos.comprobar, ms(1000));
        for i in 6..=30 {
            ritmos.anotar_comprobacion(t0 + ms(i * 300), ms(300));
        }
        assert_eq!(ritmos.comprobar, ms(1000));
    }

    #[test]
    fn comprobaciones_a_tiempo_no_activan_el_respaldo() {
        let t0 = Instant::now();
        let mut ritmos = Ritmos::new(&ajustes());
        for i in 1..=20 {
            ritmos.anotar_comprobacion(t0 + ms(i * 300), ms(300));
        }
        assert_eq!(ritmos.comprobar, ms(300));
    }

    #[test]
    fn la_vista_grande_baja_a_30_si_no_sostiene_50_fps() {
        let t0 = Instant::now();
        let a = Ajustes { activo: ms(16), activo_respaldo: Some(ms(33)), modo: Modo::Congelable };
        let mut ritmos = Ritmos::new(&a);
        for i in 1..=100 {
            ritmos.anotar_activo(t0 + ms(i * 25), ms(25));
        }
        assert_eq!(ritmos.activo, ms(33));
    }

    #[test]
    fn la_barra_nunca_se_congela() {
        let t0 = Instant::now();
        let a = Ajustes { activo: ms(33), activo_respaldo: None, modo: Modo::Fijo };
        let mut ritmos = Ritmos::new(&a);
        let mut plan = Plan::new(t0, &a);
        plan.tras_captura(t0, true, &mut ritmos);
        assert_eq!(plan.tras_captura(t0 + ms(60_000), false, &mut ritmos), Accion::Nada);
        assert_eq!(plan.proxima(), t0 + ms(60_033));
    }

    #[test]
    fn aplazar_no_cambia_la_fase() {
        let (t0, a) = (Instant::now(), ajustes());
        let mut ritmos = Ritmos::new(&a);
        let mut plan = Plan::new(t0, &a);
        plan.tras_captura(t0, true, &mut ritmos);
        plan.aplazar(t0 + ms(2_033));
        assert_eq!(plan.proxima(), t0 + ms(2_033));
        assert_eq!(plan.tras_captura(t0 + ms(2_040), true, &mut ritmos), Accion::EnviarRapido);
    }

    #[test]
    fn la_imagen_fija_termina_tras_el_primer_fotograma() {
        let t0 = Instant::now();
        let a = Ajustes { activo: ms(33), activo_respaldo: None, modo: Modo::UnaVez };
        let mut ritmos = Ritmos::new(&a);
        let mut plan = Plan::new(t0, &a);
        assert_eq!(plan.tras_captura(t0, true, &mut ritmos), Accion::EnviarRefinado);
        assert!(plan.terminado());
    }

    #[test]
    fn un_hueco_largo_no_activa_el_respaldo_de_comprobar() {
        let t0 = Instant::now();
        let mut ritmos = Ritmos::new(&ajustes());
        ritmos.anotar_comprobacion(t0, ms(300));
        // Un minuto sin muestras (otra fase) y una sola muestra lenta: no es una ventana.
        ritmos.anotar_comprobacion(t0 + ms(60_000), ms(1000));
        assert_eq!(ritmos.comprobar, ms(300));
    }

    #[test]
    fn un_hueco_largo_no_activa_el_respaldo_de_activo() {
        let t0 = Instant::now();
        let a = Ajustes { activo: ms(16), activo_respaldo: Some(ms(33)), modo: Modo::Congelable };
        let mut ritmos = Ritmos::new(&a);
        ritmos.anotar_activo(t0, ms(25));
        ritmos.anotar_activo(t0 + ms(60_000), ms(1000));
        assert_eq!(ritmos.activo, ms(16));
    }

    #[test]
    fn menos_de_cuatro_muestras_no_evaluan_la_ventana() {
        let t0 = Instant::now();
        let mut ritmos = Ritmos::new(&ajustes());
        ritmos.anotar_comprobacion(t0, ms(500));
        ritmos.anotar_comprobacion(t0 + ms(1000), ms(500));
        ritmos.anotar_comprobacion(t0 + ms(2000), ms(500));
        assert_eq!(ritmos.comprobar, ms(300));
    }

    #[test]
    fn cuatro_muestras_lentas_dentro_de_la_ventana_activan_el_respaldo() {
        let t0 = Instant::now();
        let mut ritmos = Ritmos::new(&ajustes());
        for i in 1..=4 {
            ritmos.anotar_comprobacion(t0 + ms(i * 500), ms(500));
        }
        assert_eq!(ritmos.comprobar, ms(1000));
    }

    #[test]
    fn rafaga_lenta_en_congelado_activa_el_respaldo_y_el_siguiente_intervalo_es_de_1s() {
        let t0 = Instant::now();
        let a = ajustes();
        let mut ritmos = Ritmos::new(&a);
        let mut plan = Plan::new(t0, &a);
        plan.tras_captura(t0, true, &mut ritmos);
        plan.tras_captura(t0 + ms(301), false, &mut ritmos); // Congelada
        let mut ultima = t0 + ms(301);
        for _ in 0..4 {
            ultima += ms(500);
            plan.tras_captura(ultima, false, &mut ritmos);
        }
        assert_eq!(ritmos.comprobar, ms(1000));
        assert_eq!(plan.proxima(), ultima + ms(1000));
    }
}
