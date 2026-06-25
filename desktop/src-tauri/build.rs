fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().commands(&[
                "request_voice_permissions",
                "save_workspace_file",
                "backend_health",
                "backend_logs_path",
                "app_new_window",
                "app_stop_bundled_backend",
                "set_tray_session",
                "updater_check",
                "updater_download",
                "updater_install",
                "updater_release_notes",
            ]),
        ),
    )
    .expect("failed to build Tauri application");
}
