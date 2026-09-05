mod storage;
use serde_json::Value;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, SystemTime};
use storage::{CurriculumStore, EstadoDocumentos, ListaDocumentos, LoadedCurriculum, MAX_FILE_BYTES};
use tauri::{Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;

struct AppStorage(Mutex<CurriculumStore>);
struct Zoom(Mutex<f64>);
struct PastaDados(PathBuf);

// Watches the active document for changes made outside the window — by the MCP server, a
// sync folder or another copy of the app. The lock is held across our own writes, so a
// save made here can never be mistaken for an outside change. It re-resolves which file is
// active on every tick, so switching documents from the UI is never mistaken for an outside
// edit either.
struct Vigia {
    directory: PathBuf,
    conhecida: Mutex<(PathBuf, Option<SystemTime>)>,
}

fn modificado_em(caminho: &std::path::Path) -> Option<SystemTime> {
    std::fs::metadata(caminho).ok()?.modified().ok()
}

// Mirrors the same estado.json convention the storage module and the MCP server both
// follow, without taking the storage lock from the background polling thread.
fn caminho_ativo(directory: &std::path::Path) -> PathBuf {
    let arquivo = std::fs::read_to_string(directory.join("estado.json"))
        .ok()
        .and_then(|texto| serde_json::from_str::<Value>(&texto).ok())
        .and_then(|v| v.get("ativo")?.as_str().map(str::to_string))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "curriculo.json".to_string());
    directory.join(arquivo)
}

fn atualizar_vigia(vigia: &Vigia) {
    if let Ok(mut conhecida) = vigia.conhecida.lock() {
        let caminho = caminho_ativo(&vigia.directory);
        let atual = modificado_em(&caminho);
        *conhecida = (caminho, atual);
    }
}

const ZOOM_MIN: f64 = 0.7;
const ZOOM_MAX: f64 = 1.6;

// The menu owns the zoom level so the webview and the checkmarks never disagree.
fn ajustar_zoom(app: &tauri::AppHandle, acao: &str) {
    let (Some(window), Some(zoom)) = (app.get_webview_window("main"), app.try_state::<Zoom>()) else {
        return;
    };
    let Ok(mut nivel) = zoom.0.lock() else { return };
    *nivel = match acao {
        "zoom-mais" => (*nivel + 0.1).min(ZOOM_MAX),
        "zoom-menos" => (*nivel - 0.1).max(ZOOM_MIN),
        _ => 1.0,
    };
    let _ = window.set_zoom(*nivel);
}

#[tauri::command]
fn load_curriculum(storage: State<AppStorage>) -> Result<LoadedCurriculum, String> {
    storage
        .0
        .lock()
        .map_err(|_| "Armazenamento indisponível.")?
        .load()
}

#[tauri::command]
fn save_curriculum(data: Value, storage: State<AppStorage>, vigia: State<Vigia>) -> Result<(), String> {
    storage
        .0
        .lock()
        .map_err(|_| "Armazenamento indisponível.")?
        .save(&data)?;
    atualizar_vigia(&vigia);
    Ok(())
}

#[tauri::command]
fn document_state(storage: State<AppStorage>) -> Result<ListaDocumentos, String> {
    Ok(storage
        .0
        .lock()
        .map_err(|_| "Armazenamento indisponível.")?
        .documentos()?
        .documentos)
}

#[tauri::command]
fn create_document(
    nome: String,
    data: Value,
    storage: State<AppStorage>,
    vigia: State<Vigia>,
) -> Result<EstadoDocumentos, String> {
    let resultado = storage
        .0
        .lock()
        .map_err(|_| "Armazenamento indisponível.")?
        .create_document(&nome, &data)?;
    atualizar_vigia(&vigia);
    Ok(resultado)
}

#[tauri::command]
fn rename_document(
    arquivo: String,
    nome: String,
    storage: State<AppStorage>,
) -> Result<ListaDocumentos, String> {
    storage
        .0
        .lock()
        .map_err(|_| "Armazenamento indisponível.")?
        .rename_document(&arquivo, &nome)
}

#[tauri::command]
fn delete_document(
    arquivo: String,
    storage: State<AppStorage>,
    vigia: State<Vigia>,
) -> Result<EstadoDocumentos, String> {
    let resultado = storage
        .0
        .lock()
        .map_err(|_| "Armazenamento indisponível.")?
        .delete_document(&arquivo)?;
    atualizar_vigia(&vigia);
    Ok(resultado)
}

#[tauri::command]
fn switch_document(
    arquivo: String,
    storage: State<AppStorage>,
    vigia: State<Vigia>,
) -> Result<EstadoDocumentos, String> {
    let resultado = storage
        .0
        .lock()
        .map_err(|_| "Armazenamento indisponível.")?
        .switch_document(&arquivo)?;
    atualizar_vigia(&vigia);
    Ok(resultado)
}

// The renderer never supplies a filesystem path. Only a path explicitly chosen
// in the native dialog can be read or written by these commands.
#[tauri::command]
async fn export_file(
    app: tauri::AppHandle,
    file_name: String,
    content: String,
    kind: String,
) -> Result<bool, String> {
    if content.len() as u64 > MAX_FILE_BYTES {
        return Err("O arquivo excedeu o limite de 8 MB.".into());
    }
    let (label, extension) = match kind.as_str() {
        "json" => {
            let data: Value = serde_json::from_str(&content).map_err(|_| "Backup inválido.")?;
            storage::validate(&data)?;
            ("Backup do Folium", "json")
        }
        "html" => ("Currículo editável", "html"),
        _ => return Err("Formato de arquivo não permitido.".into()),
    };
    let safe_name: String = file_name
        .chars()
        .filter(|c| !c.is_control() && !"/\\:*?\"<>|".contains(*c))
        .take(180)
        .collect();
    tauri::async_runtime::spawn_blocking(move || {
        let file = app
            .dialog()
            .file()
            .set_title("Salvar arquivo")
            .set_file_name(&safe_name)
            .add_filter(label, &[extension])
            .blocking_save_file();
        let Some(file) = file else {
            return Ok(false);
        };
        let path = file.into_path().map_err(|_| "Destino inválido.")?;
        storage::atomic_write(&path, content.as_bytes())?;
        Ok(true)
    })
    .await
    .map_err(|_| "Não foi possível abrir a janela para salvar.")?
}

#[tauri::command]
async fn import_backup(app: tauri::AppHandle) -> Result<Option<Value>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let file = app
            .dialog()
            .file()
            .set_title("Abrir backup do currículo")
            .add_filter("Backup do Folium", &["json"])
            .blocking_pick_file();
        let Some(file) = file else {
            return Ok(None);
        };
        let path = file.into_path().map_err(|_| "Arquivo inválido.")?;
        let data = serde_json::from_str(&storage::read_limited(&path)?)
            .map_err(|_| "Este arquivo não é um backup válido.")?;
        storage::validate(&data)?;
        Ok(Some(data))
    })
    .await
    .map_err(|_| "Não foi possível abrir a janela de arquivos.")?
}

#[tauri::command]
fn print_curriculum(window: tauri::WebviewWindow) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        window
            .print()
            .map_err(|_| "Não foi possível abrir a impressão.".to_string())
    }
    #[cfg(not(target_os = "macos"))]
    {
        window
            .eval("window.print()")
            .map_err(|_| "Não foi possível abrir a impressão.".to_string())
    }
}

// The theme is a preference of this machine, so it lives beside the documents
// rather than inside one. Rust needs it before the window is shown: the window
// background is what the person sees while the WebView is still blank, and on
// macOS the appearance is what makes the traffic lights and menus match.
const TEMA_CLARO: tauri::window::Color = tauri::window::Color(250, 250, 250, 255);
const TEMA_ESCURO: tauri::window::Color = tauri::window::Color(13, 15, 14, 255);

fn tema_guardado(directory: &std::path::Path) -> String {
    std::fs::read_to_string(directory.join("tema.txt"))
        .map(|texto| texto.trim().to_string())
        .ok()
        .filter(|tema| tema == "claro" || tema == "escuro")
        .unwrap_or_else(|| "sistema".to_string())
}

fn aplicar_tema(window: &tauri::WebviewWindow, tema: &str) {
    let escolha = match tema {
        "claro" => Some(tauri::Theme::Light),
        "escuro" => Some(tauri::Theme::Dark),
        _ => None,
    };
    let _ = window.set_theme(escolha);
    let escuro = match escolha {
        Some(theme) => theme == tauri::Theme::Dark,
        // "Sistema": pergunta à janela qual aparência ela acabou de assumir.
        None => window.theme().map(|t| t == tauri::Theme::Dark).unwrap_or(false),
    };
    let _ = window.set_background_color(Some(if escuro { TEMA_ESCURO } else { TEMA_CLARO }));
}

#[tauri::command]
fn definir_tema(
    window: tauri::WebviewWindow,
    pasta: State<PastaDados>,
    tema: String,
) -> Result<(), String> {
    if !matches!(tema.as_str(), "claro" | "escuro" | "sistema") {
        return Err("Tema desconhecido.".to_string());
    }
    let _ = std::fs::create_dir_all(&pasta.0);
    let _ = std::fs::write(pasta.0.join("tema.txt"), &tema);
    aplicar_tema(&window, &tema);
    Ok(())
}

#[cfg(feature = "smoke-test")]
#[tauri::command]
fn smoke_result(app: tauri::AppHandle, result: Value) {
    let report = std::env::var("FOLIUM_SMOKE_REPORT").expect("FOLIUM_SMOKE_REPORT is required");
    std::fs::write(report, serde_json::to_vec_pretty(&result).unwrap()).unwrap();
    app.exit(if result["ok"] == true { 0 } else { 1 });
}

pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            #[cfg(feature = "smoke-test")]
            let data_dir = data_dir.join("integration-test");
            if let Some(legacy) = storage::legacy_directory(&data_dir) {
                storage::migrate_legacy(&legacy, &data_dir);
            }
            let caminho_inicial = caminho_ativo(&data_dir);
            app.manage(Vigia {
                directory: data_dir.clone(),
                conhecida: Mutex::new((caminho_inicial.clone(), modificado_em(&caminho_inicial))),
            });
            app.manage(PastaDados(data_dir.clone()));
            // A janela nasce escondida e só aparece já vestida com o tema certo,
            // senão o primeiro quadro entrega um retângulo claro no tema escuro.
            if let Some(window) = app.get_webview_window("main") {
                aplicar_tema(&window, &tema_guardado(&data_dir));
                let _ = window.show();
            }
            app.manage(AppStorage(Mutex::new(CurriculumStore::new(data_dir))));
            let vigia_handle = app.handle().clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(Duration::from_millis(1500));
                let Some(vigia) = vigia_handle.try_state::<Vigia>() else {
                    return;
                };
                let Ok(mut conhecida) = vigia.conhecida.lock() else {
                    return;
                };
                let caminho = caminho_ativo(&vigia.directory);
                let atual = modificado_em(&caminho);
                if conhecida.0 != caminho {
                    // Someone switched the active document: adopt its state silently. The
                    // switch itself already carries the fresh content to the window.
                    *conhecida = (caminho, atual);
                    continue;
                }
                if atual.is_some() && atual != conhecida.1 {
                    conhecida.1 = atual;
                    drop(conhecida);
                    if let Some(window) = vigia_handle.get_webview_window("main") {
                        let _ = window.emit("curriculo-mudou", ());
                    }
                }
            });
            app.manage(Zoom(Mutex::new(1.0)));
            // Route Quit through the window's close event so JS can flush pending writes.
            use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
            let item = |id: &str, rotulo: &str, atalho: Option<&str>| {
                MenuItem::with_id(app, id, rotulo, true, atalho)
            };
            let menu = Menu::with_items(
                app,
                &[
                    &Submenu::with_items(
                        app,
                        "Folium",
                        true,
                        &[
                            &item("sobre-app", "Sobre o Folium", None)?,
                            &PredefinedMenuItem::separator(app)?,
                            &PredefinedMenuItem::hide(app, Some("Ocultar o Folium"))?,
                            &PredefinedMenuItem::hide_others(app, Some("Ocultar outros"))?,
                            &PredefinedMenuItem::show_all(app, Some("Mostrar tudo"))?,
                            &PredefinedMenuItem::separator(app)?,
                            &item("quit-folium", "Sair do Folium", Some("CmdOrCtrl+Q"))?,
                        ],
                    )?,
                    &Submenu::with_items(
                        app,
                        "Arquivo",
                        true,
                        &[
                            &item("exportar-pdf", "Exportar PDF…", Some("CmdOrCtrl+P"))?,
                            &PredefinedMenuItem::separator(app)?,
                            &item("guardar-backup", "Guardar backup…", Some("CmdOrCtrl+S"))?,
                            &item("abrir-backup", "Abrir backup…", Some("CmdOrCtrl+O"))?,
                            &item(
                                "copia-editavel",
                                "Salvar cópia editável…",
                                Some("CmdOrCtrl+Shift+S"),
                            )?,
                        ],
                    )?,
                    &Submenu::with_items(
                        app,
                        "Editar",
                        true,
                        &[
                            &PredefinedMenuItem::undo(app, Some("Desfazer"))?,
                            &PredefinedMenuItem::redo(app, Some("Refazer"))?,
                            &PredefinedMenuItem::separator(app)?,
                            &PredefinedMenuItem::cut(app, Some("Recortar"))?,
                            &PredefinedMenuItem::copy(app, Some("Copiar"))?,
                            &PredefinedMenuItem::paste(app, Some("Colar"))?,
                            &PredefinedMenuItem::select_all(app, Some("Selecionar tudo"))?,
                        ],
                    )?,
                    &Submenu::with_items(
                        app,
                        "Visualizar",
                        true,
                        &[
                            &item("zoom-mais", "Aumentar", Some("CmdOrCtrl+="))?,
                            &item("zoom-menos", "Diminuir", Some("CmdOrCtrl+-"))?,
                            &item("zoom-original", "Tamanho original", Some("CmdOrCtrl+0"))?,
                            &PredefinedMenuItem::separator(app)?,
                            &item("ampliar-previa", "Ampliar prévia", Some("CmdOrCtrl+Shift+E"))?,
                            &PredefinedMenuItem::separator(app)?,
                            &PredefinedMenuItem::fullscreen(app, Some("Tela cheia"))?,
                        ],
                    )?,
                    &Submenu::with_items(
                        app,
                        "Janela",
                        true,
                        &[
                            &PredefinedMenuItem::minimize(app, Some("Minimizar"))?,
                            &PredefinedMenuItem::maximize(app, Some("Zoom"))?,
                        ],
                    )?,
                    &Submenu::with_items(
                        app,
                        "Ajuda",
                        true,
                        &[&item("como-usar", "Como usar o Folium", None)?],
                    )?,
                ],
            )?;
            app.set_menu(menu)?;
            app.on_menu_event(|app, event| {
                let id = event.id().as_ref();
                match id {
                    "quit-folium" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.close();
                        }
                    }
                    "zoom-mais" | "zoom-menos" | "zoom-original" => ajustar_zoom(app, id),
                    // The interface already knows how to do the rest; the menu just asks for it.
                    _ => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.emit("menu", id);
                        }
                    }
                }
            });
            Ok(())
        });
    #[cfg(feature = "smoke-test")]
    let builder = builder
        .on_page_load(|webview, payload| {
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                let _ = webview.eval(include_str!("../../tests/native-smoke.js"));
            }
        })
        .invoke_handler(tauri::generate_handler![
            load_curriculum,
            save_curriculum,
            document_state,
            create_document,
            rename_document,
            delete_document,
            switch_document,
            export_file,
            import_backup,
            print_curriculum,
            definir_tema,
            smoke_result
        ]);
    #[cfg(not(feature = "smoke-test"))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        load_curriculum,
        save_curriculum,
        document_state,
        create_document,
        rename_document,
        delete_document,
        switch_document,
        export_file,
        import_backup,
        print_curriculum,
        definir_tema
    ]);
    let app = builder
        .build(tauri::generate_context!())
        .expect("Não foi possível iniciar o Folium");
    app.run(|app, event| {
        if let tauri::RunEvent::ExitRequested {
            code: None, api, ..
        } = event
        {
            if let Some(window) = app.get_webview_window("main") {
                // OS-level Quit follows the same flush-before-close path as the window button.
                api.prevent_exit();
                let _ = window.close();
            }
        }
    });
}
