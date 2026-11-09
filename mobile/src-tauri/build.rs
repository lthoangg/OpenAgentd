fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            // Must mirror `generate_handler!` in src/lib.rs exactly: a
            // command missing here (or from capabilities/) builds fine and
            // then fails at runtime with "not allowed by ACL".
            // scripts/check_tauri_commands.py enforces this in CI.
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
                "share_text",
                "pick_one",
                "push_status",
                "push_register",
                "cloud_status",
                "cloud_sign_in",
                "cloud_join_invite",
                "cloud_cancel",
                "cloud_confirm_recovery",
                "cloud_devices",
                "cloud_pending",
                "cloud_approve_begin",
                "cloud_approve_confirm",
                "cloud_approve_reject",
                "cloud_invite_start",
                "cloud_invite_poll",
                "cloud_invite_add",
                "cloud_invite_cancel",
                "cloud_remove_device",
                "cloud_sign_out",
                "cloud_open_computer",
                "cloud_push_register",
                "updater_check",
                "updater_download",
                "updater_install",
                "updater_release_notes",
            ]),
        ),
    )
    .expect("failed to build Tauri application");

    // iOS: `widgets.rs` and `push.rs` call `openagentd_widget_write` and
    // `openagentd_push_*`, which live in the Swift bridges compiled into
    // the Xcode app, not in this crate. The
    // staticlib is linked there, so the symbol resolves; the cdylib is only
    // for Android and would otherwise fail to link on iOS.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("ios") {
        println!("cargo:rustc-cdylib-link-arg=-Wl,-undefined,dynamic_lookup");
    }
}
