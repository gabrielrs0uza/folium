fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "load_curriculum",
            "save_curriculum",
            "document_state",
            "create_document",
            "rename_document",
            "delete_document",
            "switch_document",
            "export_file",
            "import_backup",
            "print_curriculum",
            "smoke_result",
        ]),
    ))
    .expect("Não foi possível preparar o aplicativo");
}
