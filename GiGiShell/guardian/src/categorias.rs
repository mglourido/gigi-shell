// gigishell-guardian: categorías de accesos habituales (miniaturas, búsqueda,
// indexadores, antivirus, copias) — qué ejecutables forman cada una. La lista
// vive en guardian/categorias.json y se instala root-owned en
// /usr/local/share/gigishell-guardian/: ampliar una categoría es editar el repo
// y reinstalar. Las rutas son CANDIDATAS: el daemon ignora las que no existen
// en esta máquina (no se pueden traducir a un inodo).
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

pub const RUTA_INSTALADA: &str = "/usr/local/share/gigishell-guardian/categorias.json";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Categorias(BTreeMap<String, Vec<String>>);

impl Categorias {
    pub fn desde_json(texto: &str) -> Result<Self, String> {
        let mapa: BTreeMap<String, Vec<String>> =
            serde_json::from_str(texto).map_err(|e| format!("categorías corruptas: {e}"))?;
        Ok(Categorias(mapa))
    }

    /// Sin categorías: todo acceso se pregunta.
    pub fn vacias() -> Self {
        Categorias(BTreeMap::new())
    }

    pub fn cargar(ruta: &Path) -> Result<Self, String> {
        let texto =
            fs::read_to_string(ruta).map_err(|e| format!("leyendo {}: {e}", ruta.display()))?;
        Self::desde_json(&texto)
    }

    pub fn mapa(&self) -> &BTreeMap<String, Vec<String>> {
        &self.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::politica::categorias_fabrica;

    const DEL_REPO: &str = include_str!("../categorias.json");

    #[test]
    fn el_json_del_repo_tiene_las_claves_de_fabrica_y_rutas_absolutas() {
        let c = Categorias::desde_json(DEL_REPO).unwrap();
        let claves: Vec<&String> = c.mapa().keys().collect();
        let fabrica = categorias_fabrica();
        let esperadas: Vec<&String> = fabrica.keys().collect();
        assert_eq!(claves, esperadas);
        for rutas in c.mapa().values() {
            assert!(!rutas.is_empty());
            for r in rutas {
                assert!(r.starts_with('/'), "ruta no absoluta: {r}");
            }
        }
    }

    #[test]
    fn json_corrupto_es_error() {
        assert!(Categorias::desde_json("[1,2]").is_err());
    }
}
