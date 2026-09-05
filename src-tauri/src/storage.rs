use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    fs,
    hash::{Hash, Hasher},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

pub const MAX_FILE_BYTES: u64 = 8_000_000;
const MAX_DOCUMENTOS: usize = 20;
const NOME_PADRAO: &str = "curriculo.json";

#[derive(Serialize)]
pub struct LoadedCurriculum {
    pub data: Option<Value>,
    pub recovered: bool,
}

pub fn validate(data: &Value) -> Result<(), String> {
    fn text(v: &Value) -> bool {
        v.as_str().is_some_and(|s| s.len() <= 200_000)
    }
    fn texts(v: &Value, max: usize) -> bool {
        v.as_array()
            .is_some_and(|a| a.len() <= max && a.iter().all(text))
    }
    let photo_ok = data["foto"].as_str().is_some_and(|s| {
        s.is_empty()
            || (s.len() < 6_000_000
                && ["jpeg", "png", "webp"].iter().any(|ext| {
                    s.strip_prefix(&format!("data:image/{ext};base64,"))
                        .is_some_and(|b| {
                            !b.is_empty()
                                && b.bytes()
                                    .all(|c| c.is_ascii_alphanumeric() || b"+/=".contains(&c))
                        })
                }))
    });
    let sections_ok = data["secoes"].as_array().is_some_and(|sections| {
        sections.len() <= 40
            && sections.iter().all(|s| {
                text(&s["titulo"])
                    && match s["tipo"].as_str() {
                        Some("texto") => text(&s["corpo"]),
                        Some("entradas") => s["itens"].as_array().is_some_and(|items| {
                            items.len() <= 100
                                && items.iter().all(|i| {
                                    ["org", "local", "cargo", "periodo"]
                                        .iter()
                                        .all(|key| text(&i[key]))
                                        && texts(&i["topicos"], 100)
                                })
                        }),
                        _ => false,
                    }
            })
    });
    if text(&data["nome"])
        && text(&data["subtitulo"])
        && texts(&data["contato"], 30)
        && photo_ok
        && sections_ok
    {
        Ok(())
    } else {
        Err("Este arquivo não contém um currículo válido do Folium.".into())
    }
}

pub fn read_limited(path: &Path) -> Result<String, String> {
    let file = fs::File::open(path).map_err(|_| "Não foi possível abrir o arquivo.")?;
    let mut bytes = Vec::new();
    file.take(MAX_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Não foi possível ler o arquivo.")?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err("O arquivo é maior que 8 MB.".into());
    }
    String::from_utf8(bytes).map_err(|_| "O arquivo não é um backup de texto válido.".into())
}

fn read_curriculum(path: &Path) -> Result<Value, String> {
    let value = serde_json::from_str(&read_limited(path)?)
        .map_err(|_| "O arquivo de currículo está danificado.")?;
    validate(&value)?;
    Ok(value)
}

// A temp file in the same directory is flushed before atomically replacing the destination.
// A failed write leaves the old document in place, including on Windows.
pub fn atomic_write(path: &Path, content: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("Pasta de destino inválida.")?;
    let mut temp = tempfile::NamedTempFile::new_in(parent)
        .map_err(|_| "Não foi possível criar o arquivo. Verifique o espaço e as permissões.")?;
    temp.write_all(content)
        .and_then(|_| temp.as_file().sync_all())
        .map_err(|_| "Não foi possível salvar. O arquivo anterior foi preservado.")?;
    temp.persist(path)
        .map_err(|_| "Não foi possível substituir o arquivo. O arquivo anterior foi preservado.")?;
    Ok(())
}

// The first release was named Folio and used another application directory.
// On the first launch of Folium the existing document is copied over, and the
// old folder is left untouched as a fallback.
pub fn legacy_directory(directory: &Path) -> Option<PathBuf> {
    let text = directory.to_str()?;
    let legacy = text.replacen("com.folium.", "com.folio.", 1);
    (legacy != text).then(|| PathBuf::from(legacy))
}

pub fn migrate_legacy(from: &Path, to: &Path) {
    if to.join(NOME_PADRAO).exists() || !from.join(NOME_PADRAO).exists() {
        return;
    }
    if fs::create_dir_all(to).is_err() {
        return;
    }
    for name in [NOME_PADRAO, "curriculo.anterior.json"] {
        let origin = from.join(name);
        if origin.exists() {
            let _ = fs::copy(&origin, to.join(name));
        }
    }
}

// One entry per résumé the person keeps in the app, e.g. one for law jobs and another
// for marketing. `arquivo` is the JSON file's name inside the data directory; `nome` is
// what the person sees in the document switcher.
#[derive(Serialize, Deserialize, Clone, PartialEq, Eq, Debug)]
pub struct DocumentInfo {
    pub arquivo: String,
    pub nome: String,
}

// Persisted as estado.json. The MCP server reads this same file to know which document
// is active; it only ever looks at `ativo`, so adding `documentos` here never affects it.
#[derive(Serialize, Deserialize, Clone)]
struct Estado {
    ativo: String,
    documentos: Vec<DocumentInfo>,
}

impl Estado {
    fn inicial() -> Self {
        Estado {
            ativo: NOME_PADRAO.to_string(),
            documentos: vec![DocumentInfo {
                arquivo: NOME_PADRAO.to_string(),
                nome: "Currículo".to_string(),
            }],
        }
    }
}

#[derive(Serialize)]
pub struct ListaDocumentos {
    pub ativo: String,
    pub documentos: Vec<DocumentInfo>,
}

#[derive(Serialize)]
pub struct EstadoDocumentos {
    pub documentos: ListaDocumentos,
    pub carregado: LoadedCurriculum,
}

fn nome_anterior(arquivo: &str) -> String {
    format!(
        "{}.anterior.json",
        arquivo.strip_suffix(".json").unwrap_or(arquivo)
    )
}

// Short enough to stay readable in estado.json, unique enough that two documents never
// collide in practice. No crate needed: the clock plus a per-process counter is plenty
// of entropy for a filename nobody has to type.
fn sufixo_unico() -> String {
    static CONTADOR: AtomicU64 = AtomicU64::new(0);
    let contagem = CONTADOR.fetch_add(1, Ordering::Relaxed);
    let agora = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    agora.hash(&mut hasher);
    contagem.hash(&mut hasher);
    format!("{:016x}", hasher.finish())[..10].to_string()
}

pub struct CurriculumStore {
    directory: PathBuf,
}
impl CurriculumStore {
    pub fn new(directory: PathBuf) -> Self {
        Self { directory }
    }

    fn caminho(&self, arquivo: &str) -> PathBuf {
        self.directory.join(arquivo)
    }

    fn caminho_estado(&self) -> PathBuf {
        self.directory.join("estado.json")
    }

    // Most installs only ever have one document and never need estado.json on disk at
    // all — MCP already falls back to curriculo.json when it's absent. We only start
    // writing it once the person actually creates, renames, deletes or switches a
    // document, so a person who never touches this feature never gets a new file.
    fn ler_estado(&self) -> Estado {
        fs::read_to_string(self.caminho_estado())
            .ok()
            .and_then(|texto| serde_json::from_str::<Estado>(&texto).ok())
            .filter(|estado| !estado.ativo.is_empty() && !estado.documentos.is_empty())
            .unwrap_or_else(Estado::inicial)
    }

    fn gravar_estado(&self, estado: &Estado) -> Result<(), String> {
        let conteudo = serde_json::to_vec_pretty(estado)
            .map_err(|_| "Não foi possível salvar a lista de currículos.")?;
        fs::create_dir_all(&self.directory)
            .map_err(|_| "Não foi possível criar a pasta de dados do Folium.")?;
        atomic_write(&self.caminho_estado(), &conteudo)
    }

    fn carregar_arquivo(&self, arquivo: &str) -> Result<LoadedCurriculum, String> {
        let current = self.caminho(arquivo);
        let previous = self.caminho(&nome_anterior(arquivo));
        if !current.exists() && !previous.exists() {
            return Ok(LoadedCurriculum {
                data: None,
                recovered: false,
            });
        }
        if let Ok(data) = read_curriculum(&current) {
            return Ok(LoadedCurriculum {
                data: Some(data),
                recovered: false,
            });
        }
        if let Ok(data) = read_curriculum(&previous) {
            return Ok(LoadedCurriculum {
                data: Some(data),
                recovered: true,
            });
        }
        Err("Não foi possível ler o currículo nem a cópia de recuperação. Seus arquivos foram preservados. Restaure um backup antes de continuar.".into())
    }

    fn gravar_arquivo(&self, arquivo: &str, data: &Value) -> Result<(), String> {
        validate(data)?;
        let content = serde_json::to_vec_pretty(data)
            .map_err(|_| "Não foi possível preparar o currículo.")?;
        if content.len() as u64 > MAX_FILE_BYTES {
            return Err("O currículo excedeu o limite de 8 MB.".into());
        }
        fs::create_dir_all(&self.directory)
            .map_err(|_| "Não foi possível criar a pasta de dados do Folium.")?;
        let current = self.caminho(arquivo);
        if let Ok(old) = read_curriculum(&current) {
            let backup = serde_json::to_vec_pretty(&old)
                .map_err(|_| "Não foi possível preparar a cópia de recuperação.")?;
            atomic_write(&self.caminho(&nome_anterior(arquivo)), &backup)?;
        }
        atomic_write(&current, &content)
    }

    pub fn load(&self) -> Result<LoadedCurriculum, String> {
        self.carregar_arquivo(&self.ler_estado().ativo)
    }

    pub fn save(&self, data: &Value) -> Result<(), String> {
        self.gravar_arquivo(&self.ler_estado().ativo, data)
    }

    fn estado_documentos(&self, estado: Estado) -> Result<EstadoDocumentos, String> {
        let carregado = self.carregar_arquivo(&estado.ativo)?;
        Ok(EstadoDocumentos {
            documentos: ListaDocumentos {
                ativo: estado.ativo,
                documentos: estado.documentos,
            },
            carregado,
        })
    }

    pub fn documentos(&self) -> Result<EstadoDocumentos, String> {
        self.estado_documentos(self.ler_estado())
    }

    fn validar_nome(nome: &str) -> Result<String, String> {
        let nome = nome.trim();
        if nome.is_empty() {
            return Err("Escolha um nome para o currículo.".into());
        }
        if nome.chars().count() > 200 {
            return Err("Escolha um nome mais curto para o currículo.".into());
        }
        Ok(nome.to_string())
    }

    pub fn create_document(&self, nome: &str, data: &Value) -> Result<EstadoDocumentos, String> {
        let nome = Self::validar_nome(nome)?;
        let mut estado = self.ler_estado();
        if estado.documentos.len() >= MAX_DOCUMENTOS {
            return Err("O Folium guarda até 20 currículos por vez.".into());
        }
        let arquivo = loop {
            let candidato = format!("curriculo-{}.json", sufixo_unico());
            if !estado.documentos.iter().any(|d| d.arquivo == candidato) {
                break candidato;
            }
        };
        self.gravar_arquivo(&arquivo, data)?;
        estado.documentos.push(DocumentInfo {
            arquivo: arquivo.clone(),
            nome,
        });
        estado.ativo = arquivo;
        self.gravar_estado(&estado)?;
        self.estado_documentos(estado)
    }

    pub fn rename_document(&self, arquivo: &str, nome: &str) -> Result<ListaDocumentos, String> {
        let nome = Self::validar_nome(nome)?;
        let mut estado = self.ler_estado();
        let alvo = estado
            .documentos
            .iter_mut()
            .find(|d| d.arquivo == arquivo)
            .ok_or("Este currículo não existe mais.")?;
        alvo.nome = nome;
        self.gravar_estado(&estado)?;
        Ok(ListaDocumentos {
            ativo: estado.ativo,
            documentos: estado.documentos,
        })
    }

    pub fn delete_document(&self, arquivo: &str) -> Result<EstadoDocumentos, String> {
        let mut estado = self.ler_estado();
        if estado.documentos.len() <= 1 {
            return Err("Não é possível excluir o único currículo.".into());
        }
        let posicao = estado
            .documentos
            .iter()
            .position(|d| d.arquivo == arquivo)
            .ok_or("Este currículo não existe mais.")?;
        estado.documentos.remove(posicao);
        if estado.ativo == arquivo {
            estado.ativo = estado.documentos[0].arquivo.clone();
        }
        self.gravar_estado(&estado)?;
        let _ = fs::remove_file(self.caminho(arquivo));
        let _ = fs::remove_file(self.caminho(&nome_anterior(arquivo)));
        self.estado_documentos(estado)
    }

    pub fn switch_document(&self, arquivo: &str) -> Result<EstadoDocumentos, String> {
        let mut estado = self.ler_estado();
        if !estado.documentos.iter().any(|d| d.arquivo == arquivo) {
            return Err("Este currículo não existe mais.".into());
        }
        estado.ativo = arquivo.to_string();
        self.gravar_estado(&estado)?;
        self.estado_documentos(estado)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn example(name: &str) -> Value {
        serde_json::json!({"nome":name,"subtitulo":"Direito","contato":["Recife"],"foto":"","secoes":[{"tipo":"texto","titulo":"Perfil","corpo":"Estudante"}]})
    }
    #[test]
    fn saves_and_reopens_with_previous_copy() {
        let temp = tempfile::tempdir().unwrap();
        let store = CurriculumStore::new(temp.path().into());
        assert!(store.load().unwrap().data.is_none());
        store.save(&example("Primeira versão")).unwrap();
        store.save(&example("Segunda versão")).unwrap();
        assert_eq!(
            store.load().unwrap().data.unwrap()["nome"],
            "Segunda versão"
        );
        assert_eq!(
            read_curriculum(&temp.path().join("curriculo.anterior.json")).unwrap()["nome"],
            "Primeira versão"
        );
    }
    #[test]
    fn corrupted_current_recovers_previous_and_preserves_it_on_next_save() {
        let temp = tempfile::tempdir().unwrap();
        let store = CurriculumStore::new(temp.path().into());
        store.save(&example("Boa")).unwrap();
        store.save(&example("Mais nova")).unwrap();
        fs::write(temp.path().join("curriculo.json"), "broken").unwrap();
        let recovered = store.load().unwrap();
        assert!(recovered.recovered);
        store.save(&recovered.data.unwrap()).unwrap();
        assert_eq!(
            read_curriculum(&temp.path().join("curriculo.anterior.json")).unwrap()["nome"],
            "Boa"
        );
    }
    #[test]
    fn invalid_data_cannot_replace_a_good_document() {
        let temp = tempfile::tempdir().unwrap();
        let store = CurriculumStore::new(temp.path().into());
        store.save(&example("Preservada")).unwrap();
        assert!(store.save(&serde_json::json!({"secoes":[]})).is_err());
        assert_eq!(store.load().unwrap().data.unwrap()["nome"], "Preservada");
        let mut bad = example("Teste");
        bad["foto"] = Value::String("https://example.com/photo.jpg".into());
        assert!(validate(&bad).is_err());
    }
    #[test]
    fn document_from_the_previous_name_is_adopted_once() {
        let temp = tempfile::tempdir().unwrap();
        let legacy = temp.path().join("com.folio.curriculum");
        let current = temp.path().join("com.folium.curriculum");
        CurriculumStore::new(legacy.clone())
            .save(&example("Currículo antigo"))
            .unwrap();
        migrate_legacy(&legacy, &current);
        let store = CurriculumStore::new(current.clone());
        assert_eq!(store.load().unwrap().data.unwrap()["nome"], "Currículo antigo");
        store.save(&example("Currículo novo")).unwrap();
        migrate_legacy(&legacy, &current);
        assert_eq!(store.load().unwrap().data.unwrap()["nome"], "Currículo novo");
        assert!(legacy.join("curriculo.json").exists());
        assert_eq!(
            legacy_directory(&current).unwrap(),
            legacy
        );
    }
    #[test]
    fn corruption_is_reported_without_silently_resetting() {
        let temp = tempfile::tempdir().unwrap();
        let store = CurriculumStore::new(temp.path().into());
        fs::write(temp.path().join("curriculo.json"), "broken").unwrap();
        assert!(store.load().is_err());
        assert_eq!(
            fs::read_to_string(temp.path().join("curriculo.json")).unwrap(),
            "broken"
        );
    }

    #[test]
    fn a_lone_document_needs_no_estado_json_on_disk() {
        let temp = tempfile::tempdir().unwrap();
        let store = CurriculumStore::new(temp.path().into());
        store.save(&example("Só um currículo")).unwrap();
        assert!(
            !temp.path().join("estado.json").exists(),
            "single-document installs should never gain a new file"
        );
        let lista = store.documentos().unwrap();
        assert_eq!(lista.documentos.documentos.len(), 1);
        assert_eq!(lista.documentos.ativo, "curriculo.json");
    }

    #[test]
    fn creating_a_document_switches_to_it_and_keeps_the_first_one_untouched() {
        let temp = tempfile::tempdir().unwrap();
        let store = CurriculumStore::new(temp.path().into());
        store.save(&example("Currículo jurídico")).unwrap();
        let resultado = store
            .create_document("Currículo de marketing", &example("Currículo de marketing"))
            .unwrap();
        assert_eq!(resultado.documentos.documentos.len(), 2);
        assert_eq!(
            resultado.carregado.data.unwrap()["nome"],
            "Currículo de marketing"
        );
        // The active document changed; the file for the first one is exactly as it was.
        assert_eq!(store.load().unwrap().data.unwrap()["nome"], "Currículo de marketing");
        let primeiro = &resultado.documentos.documentos[0];
        assert_eq!(primeiro.nome, "Currículo");
        let carregado_primeiro = store.switch_document(&primeiro.arquivo).unwrap();
        assert_eq!(
            carregado_primeiro.carregado.data.unwrap()["nome"],
            "Currículo jurídico"
        );
    }

    #[test]
    fn renaming_a_document_does_not_touch_its_content_or_which_one_is_active() {
        let temp = tempfile::tempdir().unwrap();
        let store = CurriculumStore::new(temp.path().into());
        store.save(&example("Ana")).unwrap();
        let criado = store.create_document("Segundo", &example("Segundo")).unwrap();
        let primeiro = criado.documentos.documentos[0].arquivo.clone();
        let lista = store.rename_document(&primeiro, "  Currículo jurídico  ").unwrap();
        assert_eq!(
            lista.documentos.iter().find(|d| d.arquivo == primeiro).unwrap().nome,
            "Currículo jurídico"
        );
        assert_eq!(lista.ativo, criado.documentos.ativo, "renaming must not switch the active document");
        assert!(store.rename_document(&primeiro, "   ").is_err());
    }

    #[test]
    fn deleting_the_active_document_falls_back_to_another_one() {
        let temp = tempfile::tempdir().unwrap();
        let store = CurriculumStore::new(temp.path().into());
        store.save(&example("Primeiro")).unwrap();
        let criado = store.create_document("Segundo", &example("Segundo")).unwrap();
        assert_eq!(criado.documentos.ativo, "curriculo-".to_string() + &criado.documentos.ativo["curriculo-".len()..]);
        let resultado = store.delete_document(&criado.documentos.ativo).unwrap();
        assert_eq!(resultado.documentos.documentos.len(), 1);
        assert_eq!(resultado.carregado.data.unwrap()["nome"], "Primeiro");
        assert!(store.delete_document(&resultado.documentos.ativo).is_err());
    }

    #[test]
    fn a_deleted_document_leaves_no_files_behind() {
        let temp = tempfile::tempdir().unwrap();
        let store = CurriculumStore::new(temp.path().into());
        store.save(&example("Primeiro")).unwrap();
        let criado = store.create_document("Segundo", &example("Segundo")).unwrap();
        store.save(&example("Segundo, editado")).unwrap();
        let arquivo = criado.documentos.ativo.clone();
        store.delete_document(&arquivo).unwrap();
        assert!(!temp.path().join(&arquivo).exists());
        assert!(!temp.path().join(nome_anterior(&arquivo)).exists());
    }

    #[test]
    fn switching_to_a_document_that_no_longer_exists_fails_without_changing_state() {
        let temp = tempfile::tempdir().unwrap();
        let store = CurriculumStore::new(temp.path().into());
        store.save(&example("Único")).unwrap();
        assert!(store.switch_document("fantasma.json").is_err());
        assert_eq!(store.load().unwrap().data.unwrap()["nome"], "Único");
    }
}
