fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().commands(&[
                "app_backend_status",
                "app_save_backend_server",
                "app_use_external_backend",
                "app_remove_backend_server",
                "save_workspace_file",
                "secure_get_access_key",
                "secure_set_access_key",
                "secure_delete_access_key",
                "preview_relay_open",
                "preview_relay_close",
                "widget_update_snapshot",
                "app_move_to_background",
                "set_app_theme",
            ]),
        ),
    )
    .expect("failed to build Tauri application");

    // iOS: `widgets.rs` calls `openagentd_widget_write`, which lives in the
    // Swift bridge compiled into the Xcode app, not in this crate. The
    // staticlib is linked there, so the symbol resolves; the cdylib is only
    // for Android and would otherwise fail to link on iOS.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("ios") {
        println!("cargo:rustc-cdylib-link-arg=-Wl,-undefined,dynamic_lookup");
    }
}
