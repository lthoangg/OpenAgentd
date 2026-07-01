fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().commands(&[
                "app_backend_status",
                "app_save_backend_server",
                "app_use_external_backend",
                "app_remove_backend_server",
                "save_workspace_file",
            ]),
        ),
    )
    .expect("failed to build Tauri application");
}
