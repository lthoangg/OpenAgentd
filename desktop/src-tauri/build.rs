fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().commands(&[
                "save_workspace_file",
                "backend_health",
                "backend_logs_path",
                "app_new_window",
                "reapply_window_chrome",
                "app_stop_bundled_backend",
                "set_tray_session",
                "updater_check",
                "updater_download",
                "updater_install",
                "updater_release_notes",
                "secure_get_access_key",
                "secure_set_access_key",
                "secure_delete_access_key",
            ]),
        ),
    )
    .expect("failed to build Tauri application");
}
