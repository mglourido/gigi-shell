// gigishell-guardian: historial de decisiones, una línea JSON por acceso en
// /var/lib/gigishell-guardian/historial.jsonl (root, 600). Va aparte de la
// política para no reescribir politica.json en cada apertura: aquí solo se
// añade al final, y el recorte (500 entradas por fichero) se hace al arrancar.
use std::collections::HashMap;
use std::fs;
use std::io::{self, BufRead, BufReader, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::politica::escribir_atomico;

pub const MAX_POR_FICHERO: usize = 500;

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Resultado {
    Permitido,
    Automatico,
    Categoria,
    Denegado,
    Silencioso,
    TiempoAgotado,
    SinAgs,
    /// El fichero desapareció con su disco montado y se quitó de la política.
    Retirado,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct Entrada {
    /// Segundos desde epoch.
    pub fecha: u64,
    pub ruta: String,
    pub programa: String,
    pub pid: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub script: Option<String>,
    pub operacion: String,
    pub resultado: Resultado,
}

pub struct Historial {
    ruta: PathBuf,
}

impl Historial {
    pub fn new(ruta: PathBuf) -> Self {
        Historial { ruta }
    }

    pub fn anadir(&self, entrada: &Entrada) -> io::Result<()> {
        let mut linea = serde_json::to_string(entrada).map_err(io::Error::other)?;
        linea.push('\n');
        let mut f = fs::OpenOptions::new()
            .append(true)
            .create(true)
            .mode(0o600)
            .open(&self.ruta)?;
        // Una sola escritura por línea: con O_APPEND, dos no se entrelazan.
        f.write_all(linea.as_bytes())
    }

    /// Todas las entradas legibles, en el orden en que se escribieron. Una
    /// línea que no se entiende (p.ej. cortada por un apagón) se salta: el
    /// historial es informativo, no merece tumbar el daemon.
    fn todas(&self) -> io::Result<Vec<Entrada>> {
        let f = match fs::File::open(&self.ruta) {
            Ok(f) => f,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(e),
        };
        let mut v = Vec::new();
        for linea in BufReader::new(f).lines() {
            if let Ok(e) = serde_json::from_str::<Entrada>(&linea?) {
                v.push(e);
            }
        }
        Ok(v)
    }

    /// Las `limite` entradas más recientes de `ruta`, la más reciente primero.
    pub fn leer(&self, ruta: &str, limite: usize) -> io::Result<Vec<Entrada>> {
        Ok(self
            .todas()?
            .into_iter()
            .rev()
            .filter(|e| e.ruta == ruta)
            .take(limite)
            .collect())
    }

    /// Deja como mucho `max` entradas por fichero (las más recientes).
    pub fn recortar(&self, max: usize) -> io::Result<()> {
        let todas = self.todas()?;
        let antes = todas.len();
        let quedan = recortar_entradas(todas, max);
        if quedan.len() == antes {
            return Ok(());
        }
        let mut texto = String::new();
        for e in &quedan {
            texto.push_str(&serde_json::to_string(e).map_err(io::Error::other)?);
            texto.push('\n');
        }
        escribir_atomico(&self.ruta, texto.as_bytes())
    }

    /// Accesos bloqueados desde `desde` (para «M accesos denegados esta
    /// semana»): cuentan los denegados, los que agotaron el tiempo y los que
    /// se denegaron sin AGS. Los silenciosos no: el usuario pidió no oírlos.
    pub fn contar_denegados_desde(&self, desde: u64) -> io::Result<usize> {
        Ok(self
            .todas()?
            .iter()
            .filter(|e| e.fecha >= desde)
            .filter(|e| {
                matches!(
                    e.resultado,
                    Resultado::Denegado | Resultado::TiempoAgotado | Resultado::SinAgs
                )
            })
            .count())
    }
}

/// Conserva, para cada ruta, solo sus `max` entradas más recientes, sin
/// cambiar el orden relativo de las que quedan.
pub fn recortar_entradas(entradas: Vec<Entrada>, max: usize) -> Vec<Entrada> {
    let mut total: HashMap<String, usize> = HashMap::new();
    for e in &entradas {
        *total.entry(e.ruta.clone()).or_default() += 1;
    }
    let mut vistas: HashMap<String, usize> = HashMap::new();
    entradas
        .into_iter()
        .filter(|e| {
            let visto = vistas.entry(e.ruta.clone()).or_default();
            *visto += 1;
            // Las primeras (total - max) de cada ruta son las más viejas.
            *visto > total[&e.ruta].saturating_sub(max)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entrada(fecha: u64, ruta: &str, resultado: Resultado) -> Entrada {
        Entrada {
            fecha,
            ruta: ruta.to_string(),
            programa: "/usr/bin/cat".to_string(),
            pid: 1,
            script: None,
            operacion: "leer".to_string(),
            resultado,
        }
    }

    #[test]
    fn recortar_entradas_conserva_lo_reciente_por_fichero() {
        let v = vec![
            entrada(1, "/a", Resultado::Denegado),
            entrada(2, "/b", Resultado::Denegado),
            entrada(3, "/a", Resultado::Denegado),
            entrada(4, "/a", Resultado::Denegado),
        ];
        let r = recortar_entradas(v, 2);
        let fechas: Vec<u64> = r.iter().map(|e| e.fecha).collect();
        assert_eq!(fechas, vec![2, 3, 4]);
    }

    #[test]
    fn en_disco_anadir_leer_contar_y_recortar() {
        let dir = tempfile::tempdir().unwrap();
        let h = Historial::new(dir.path().join("historial.jsonl"));
        h.anadir(&entrada(10, "/a", Resultado::Denegado)).unwrap();
        h.anadir(&entrada(20, "/a", Resultado::Permitido)).unwrap();
        h.anadir(&entrada(30, "/a", Resultado::TiempoAgotado)).unwrap();
        h.anadir(&entrada(40, "/b", Resultado::SinAgs)).unwrap();
        h.anadir(&entrada(50, "/b", Resultado::Silencioso)).unwrap();

        let leidas = h.leer("/a", 2).unwrap();
        assert_eq!(leidas.iter().map(|e| e.fecha).collect::<Vec<_>>(), vec![30, 20]);

        assert_eq!(h.contar_denegados_desde(0).unwrap(), 3);
        assert_eq!(h.contar_denegados_desde(25).unwrap(), 2);

        h.recortar(1).unwrap();
        assert_eq!(h.leer("/a", 10).unwrap().len(), 1);
        assert_eq!(h.leer("/a", 10).unwrap()[0].fecha, 30);
        assert_eq!(h.leer("/b", 10).unwrap()[0].fecha, 50);
    }

    #[test]
    fn serializa_en_snake_case_y_sin_script_si_es_none() {
        let texto = serde_json::to_string(&entrada(1, "/a", Resultado::TiempoAgotado)).unwrap();
        assert!(texto.contains("\"tiempo_agotado\""));
        assert!(!texto.contains("script"));
        let mut con = entrada(1, "/a", Resultado::SinAgs);
        con.script = Some("x.py".into());
        assert!(serde_json::to_string(&con).unwrap().contains("\"script\":\"x.py\""));
    }
}
