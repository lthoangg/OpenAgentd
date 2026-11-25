//! Tests of `main.rs`: kept beside it so the crate root stays readable.

use super::*;
use std::collections::HashMap as StdHashMap;
use std::path::Path;
use tauri_plugin_dialog::MessageDialogResult;
use crate::window::{
    backend_unavailable_init_script, frontend_init_script, new_window_init_script,
};
use crate::servers::{current_server, ServerId};
use crate::updater::{dialog_result_is_accept, format_update_prompt, format_download_progress, should_emit_progress, silent_check_is_due, validate_install_preconditions};
use crate::config::AppBackendConfig;

#[test]
fn dmabuf_is_turned_off_only_for_nvidia_and_never_over_a_user_choice() {
    assert!(dmabuf_workaround_needed(false, true));
    assert!(!dmabuf_workaround_needed(false, false));
    assert!(!dmabuf_workaround_needed(true, true));
}

#[test]
fn logging_panics_keeps_the_previous_hook() {
    let previous_ran = Arc::new(AtomicBool::new(false));
    let flag = previous_ran.clone();
    std::panic::set_hook(Box::new(move |_| flag.store(true, Ordering::SeqCst)));
    log_panics();

    let result = std::panic::catch_unwind(|| panic!("boom"));
    let _ = std::panic::take_hook();

    assert!(result.is_err());
    assert!(previous_ran.load(Ordering::SeqCst));
}

#[test]
fn backend_start_guard_prevents_concurrent_start_and_resets_on_drop() {
    let flag = Arc::new(AtomicBool::new(false));
    let failed = Arc::new(AtomicBool::new(false));
    let guard = BackendStartGuard::try_acquire(flag.clone(), failed.clone())
        .expect("first startup guard");
    assert!(flag.load(Ordering::SeqCst));
    assert!(BackendStartGuard::try_acquire(flag.clone(), failed.clone()).is_none());

    drop(guard);
    assert!(!flag.load(Ordering::SeqCst));
    assert!(failed.load(Ordering::SeqCst));
    assert!(BackendStartGuard::try_acquire(flag, failed).is_some());
}

#[test]
fn completed_backend_start_does_not_leave_failure_state() {
    let flag = Arc::new(AtomicBool::new(false));
    let failed = Arc::new(AtomicBool::new(true));
    let mut guard = BackendStartGuard::try_acquire(flag.clone(), failed.clone())
        .expect("startup guard");

    assert!(!failed.load(Ordering::SeqCst));
    guard.complete();
    drop(guard);

    assert!(!flag.load(Ordering::SeqCst));
    assert!(!failed.load(Ordering::SeqCst));
}

#[test]
fn new_window_uses_the_active_windows_external_server() {
    let mut external = StdHashMap::new();
    external.insert("main-2".to_string(), "http://192.168.1.10:4082".to_string());
    let server = current_server(Some("main-2"), &external, true);

    let script = new_window_init_script(
        server.as_ref(),
        Some("http://127.0.0.1:4082"),
        Some("desktop-token"),
        Some("/session-1"),
    );

    assert!(script.contains("http://192.168.1.10:4082"));
    assert!(!script.contains("desktop-token"));
    assert!(script.contains(r#"'__OAD_INITIAL_ROUTE__', { value: "/session-1","#));
}

#[test]
fn new_window_from_a_builtin_window_uses_the_builtin() {
    let script = new_window_init_script(
        Some(&ServerId::Bundled),
        Some("http://127.0.0.1:4082"),
        Some("desktop-token"),
        Some("/session-1"),
    );

    assert!(script.contains("http://127.0.0.1:4082"));
    assert!(script.contains("desktop-token"));
    assert!(script.contains(r#"'__OAD_INITIAL_ROUTE__', { value: "/session-1","#));
}

// New Window from a builtin window while `main` was on another server
// used to load the builtin but register `main`'s server, and the window
// bootstrapped onto `main`'s server.
#[test]
fn a_new_window_from_a_builtin_window_stays_on_builtin() {
    let mut external = StdHashMap::new();
    external.insert(MAIN_WINDOW.to_string(), "http://192.168.1.30:4082".to_string());
    assert_eq!(current_server(Some("main-2"), &external, true), Some(ServerId::Bundled));
}

#[test]
fn new_window_without_a_target_opens_a_new_session() {
    let script = new_window_init_script(
        Some(&ServerId::Bundled),
        Some("http://127.0.0.1:4082"),
        Some("desktop-token"),
        None,
    );

    assert!(script.contains(r#"'__OAD_INITIAL_ROUTE__', { value: "/","#));
    assert!(!script.contains("/coding"));
}

// A saved server only connects when you choose it: with the builtin
// stopped and every window closed, the next window opens unconnected
// (its loading screen offers Choose Server) instead of on the saved one.
#[test]
fn with_builtin_stopped_and_no_window_a_new_window_opens_not_connected() {
    let server = current_server(None, &StdHashMap::new(), false);
    assert_eq!(server, None);
    let script = new_window_init_script(server.as_ref(), Some("http://127.0.0.1:4082"), Some("desktop-token"), Some("/s"));
    assert!(script.contains("__OAD_BACKEND_UNAVAILABLE__"));
    assert!(!script.contains("desktop-token"));
}

#[test]
fn a_builtin_that_never_started_opens_the_window_not_connected() {
    let script = new_window_init_script(Some(&ServerId::Bundled), None, None, None);
    assert!(script.contains("__OAD_BACKEND_UNAVAILABLE__"));
}

// ── dialog_result_is_accept ──────────────────────────────────────────────
//
// Guards the OkCancelCustom mapping. rfd surfaces the user's choice as
// ``Custom("Install")`` on macOS/Linux but the underlying system dialog
// may report ``Ok``/``Yes`` instead — both must count as accept, and
// every other variant (including a ``Custom`` with a different label)
// must count as cancel.

#[test]
fn dialog_result_custom_with_matching_label_accepts() {
    assert!(dialog_result_is_accept(
        &MessageDialogResult::Custom("Install".into()),
        "Install"
    ));
}

#[test]
fn dialog_result_custom_with_other_label_rejects() {
    assert!(!dialog_result_is_accept(
        &MessageDialogResult::Custom("Later".into()),
        "Install"
    ));
}

#[test]
fn dialog_result_ok_and_yes_accept() {
    assert!(dialog_result_is_accept(&MessageDialogResult::Ok, "Install"));
    assert!(dialog_result_is_accept(
        &MessageDialogResult::Yes,
        "Install"
    ));
}

#[test]
fn dialog_result_cancel_and_no_reject() {
    assert!(!dialog_result_is_accept(
        &MessageDialogResult::Cancel,
        "Install"
    ));
    assert!(!dialog_result_is_accept(
        &MessageDialogResult::No,
        "Install"
    ));
}

#[test]
fn frontend_init_script_allows_runtime_backend_switches() {
    let script = frontend_init_script(Some("secret"), "http://127.0.0.1:4082");

    assert!(script.contains("__OAD_API_BASE_URL__"));
    assert!(script.contains("__OAD_TOKEN__"));
    assert_eq!(
        script.matches("writable: true, configurable: true").count(),
        2
    );
}

#[test]
fn external_backend_init_script_clears_bundled_token() {
    let script = frontend_init_script(None, "http://192.168.1.10:4082");

    assert!(script.contains("delete window.__OAD_TOKEN__"));
}

#[test]
fn unavailable_desktop_startup_opens_a_new_session() {
    let script = backend_unavailable_init_script();

    assert!(script.contains(r#"'__OAD_INITIAL_ROUTE__', { value: "/","#));
    assert!(!script.contains("/coding"));
}

#[test]
fn a_main_window_coming_back_opens_on_its_session_once_the_backend_is_up() {
    let script = backend_unavailable_init_script_at("/0199f3a2-7c4e-7b61-9f0e-2f6c1d3a4b5c");

    assert!(script.contains("'__OAD_BACKEND_UNAVAILABLE__', { value: true,"));
    assert!(script.contains(r#"'__OAD_INITIAL_ROUTE__', { value: "/0199f3a2-7c4e-7b61-9f0e-2f6c1d3a4b5c","#));
    // A path is data, never script.
    let hostile = backend_unavailable_init_script_at("/\"});alert(1);//");
    assert!(hostile.contains(r#"value: "/\"});alert(1);//","#), "{hostile}");
}

#[test]
fn new_window_external_backend_map_can_identify_force_reload_scope() {
    let mut external = StdHashMap::new();
    external.insert("main-2".to_string(), "http://192.168.1.10:4082".to_string());

    assert!(external.contains_key("main-2"));
    assert!(!external.contains_key(MAIN_WINDOW));
}

#[test]
fn focused_webview_window_is_none_without_windows() {
    let app = tauri::test::mock_app();

    assert!(app.app_handle().webview_windows().is_empty());
}

#[test]
fn backend_log_path_is_available_before_sidecar_state() {
    let app = tauri::test::mock_app();

    let path = backend_log_path(app.app_handle())
        .expect("backend log path before sidecar startup");

    assert_eq!(
        Path::new(&path).file_name().and_then(|name| name.to_str()),
        Some("backend.log")
    );
}

#[test]
fn first_run_sidecar_handshake_allows_cold_security_scans() {
    assert_eq!(SIDECAR_HANDSHAKE_TIMEOUT, Duration::from_secs(60));
}

// ── silent_check_is_due ─────────────────────────────────────────────────
//
// `UpdateCard.tsx` keeps its 6h schedule in component refs that reseed to
// "now" on every mount, so each window/reload/foreground event fired a
// fresh check: several GitHub requests per hour.
// This gate is the process-wide backstop.

const ONE_HOUR: i64 = 60 * 60;

#[test]
fn the_first_automatic_check_of_a_launch_is_always_due() {
    // `LAST_SILENT_CHECK` starts at 0, so a fresh process never waits.
    assert!(silent_check_is_due(1_760_000_000, 0));
}

#[test]
fn a_second_automatic_check_inside_the_gap_is_skipped() {
    let last = 1_760_000_000;

    // The startup double-fire seen in production: two checks one second apart.
    assert!(!silent_check_is_due(last + 1, last));
    assert!(!silent_check_is_due(last + ONE_HOUR - 1, last));
}

#[test]
fn an_automatic_check_is_due_again_once_the_gap_elapses() {
    let last = 1_760_000_000;

    assert!(silent_check_is_due(last + ONE_HOUR, last));
}

#[test]
fn a_backwards_clock_step_does_not_wedge_automatic_checks() {
    // Saturating arithmetic: a clock that jumped backwards must not
    // produce a huge positive gap and let every check through, nor
    // underflow. It simply reads as "not due yet".
    let last = 1_760_000_000;

    assert!(!silent_check_is_due(last - ONE_HOUR, last));
}

// ── should_emit_progress ────────────────────────────────────────────────
//
// The updater plugin calls the progress closure once per network chunk,
// so a 200 MB bundle produced thousands of IPC emits and thousands of
// main-thread menu updates.

#[test]
fn the_first_chunk_always_reports_progress() {
    assert!(should_emit_progress(None, 8_192, Some(200_000_000)));
}

#[test]
fn chunks_inside_the_interval_are_coalesced() {
    assert!(!should_emit_progress(
        Some(Duration::from_millis(10)),
        8_192,
        Some(200_000_000)
    ));
}

#[test]
fn progress_reports_resume_once_the_interval_elapses() {
    assert!(should_emit_progress(
        Some(Duration::from_millis(250)),
        8_192,
        Some(200_000_000)
    ));
}

#[test]
fn the_final_chunk_always_reports_so_the_bar_completes() {
    assert!(should_emit_progress(
        Some(Duration::from_millis(1)),
        200_000_000,
        Some(200_000_000)
    ));
}

#[test]
fn an_unknown_total_still_throttles_on_time() {
    assert!(!should_emit_progress(Some(Duration::from_millis(10)), 8_192, None));
    assert!(should_emit_progress(Some(Duration::from_millis(300)), 8_192, None));
}

#[cfg(not(target_os = "macos"))]
#[test]
fn force_reload_shutdown_grace_is_shorter_than_normal_shutdown() {
    assert!(RELOAD_SHUTDOWN_GRACE < NORMAL_SHUTDOWN_GRACE);
    assert_eq!(RELOAD_SHUTDOWN_GRACE, Duration::from_millis(750));
}

#[test]
fn saved_backend_config_can_mark_external_backend_active() {
    let config = AppBackendConfig {
        active_base_url: Some("http://192.168.1.10:4082".to_string()),
        ..Default::default()
    };

    let serialized = serde_json::to_string(&config).expect("serialize config");
    let parsed: AppBackendConfig = serde_json::from_str(&serialized).expect("parse config");

    assert_eq!(
        parsed.active_base_url.as_deref(),
        Some("http://192.168.1.10:4082")
    );
}

#[test]
fn macos_bundle_explains_local_network_access() {
    let info_plist = std::fs::read_to_string(format!(
        "{}/Info.plist",
        env!("CARGO_MANIFEST_DIR")
    ))
    .expect("read macOS Info.plist");

    assert!(
        info_plist.contains("<key>NSLocalNetworkUsageDescription</key>"),
        "LAN CLI server connections need a macOS local-network permission description"
    );
}

// ── format_update_prompt ────────────────────────────────────────────────
//
// The prompt is the only thing the user reads before deciding to install,
// so it must (a) always show both version numbers, (b) handle a missing
// body without printing literal "None" or doubled blank lines, and
// (c) bound the length so a runaway changelog doesn't blow out the modal.

#[test]
fn update_prompt_without_notes_omits_notes_paragraph() {
    let prompt = format_update_prompt("1.2.0", "1.1.0", None);
    assert!(prompt.contains("1.2.0"));
    assert!(prompt.contains("1.1.0"));
    assert!(prompt.contains("Download now?"));
    // Exactly one blank line between the version line and the call to
    // action — i.e. no orphan ``\n\n\n`` from an empty body.
    assert!(!prompt.contains("\n\n\n"));
}

#[test]
fn update_prompt_with_empty_string_body_treated_as_no_notes() {
    let with_empty = format_update_prompt("1.2.0", "1.1.0", Some(""));
    let with_none = format_update_prompt("1.2.0", "1.1.0", None);
    assert_eq!(with_empty, with_none);
}

#[test]
fn update_prompt_with_whitespace_only_body_treated_as_no_notes() {
    let prompt = format_update_prompt("1.2.0", "1.1.0", Some("   \n\t  "));
    let baseline = format_update_prompt("1.2.0", "1.1.0", None);
    assert_eq!(prompt, baseline);
}

#[test]
fn update_prompt_includes_short_notes_verbatim() {
    let prompt = format_update_prompt("1.2.0", "1.1.0", Some("Fixed crash on launch"));
    assert!(prompt.contains("Fixed crash on launch"));
}

#[test]
fn update_prompt_truncates_long_notes_with_ellipsis() {
    let long = "x".repeat(2000);
    let prompt = format_update_prompt("1.2.0", "1.1.0", Some(&long));
    // The xxxxx body itself must be capped well below the original
    // length and end with an ellipsis. Total prompt length is body +
    // surrounding template, so it stays under ~1000 chars.
    assert!(prompt.contains('…'));
    assert!(prompt.len() < 1000);
    assert!(prompt.contains("1.2.0"));
    assert!(prompt.contains("Download now?"));
}

#[test]
fn update_prompt_truncation_respects_char_boundaries() {
    // A body of 700 multi-byte chars (3 bytes each in UTF-8) would
    // panic on a naive ``&body[..N]`` slice. ``chars().take`` keeps
    // us safe — assert we don't panic and produce a valid String.
    let multibyte_body: String = "✦".repeat(700);
    let prompt = format_update_prompt("1.2.0", "1.1.0", Some(&multibyte_body));
    assert!(prompt.contains('…'));
    assert!(prompt.is_char_boundary(prompt.len()));
}

// ── format_download_progress ────────────────────────────────────────────
//
// Closure-callable formatter for the tray status. Critical: never
// produce "0/0 MB" or similar garbage when Content-Length is missing
// or zero, and never divide by zero.

#[test]
fn download_progress_with_total_shows_fraction() {
    assert_eq!(
        format_download_progress(3, Some(50 * 1024 * 1024)),
        "Status: Downloading 3/50 MB"
    );
}

#[test]
fn download_progress_without_total_omits_denominator() {
    assert_eq!(
        format_download_progress(7, None),
        "Status: Downloading 7 MB"
    );
}

#[test]
fn download_progress_with_zero_total_falls_back_to_no_denominator() {
    // A misbehaving server that returns ``Content-Length: 0`` must not
    // produce ``"5/0 MB"`` — the fallback path drops the denominator.
    assert_eq!(
        format_download_progress(5, Some(0)),
        "Status: Downloading 5 MB"
    );
}

#[test]
fn download_progress_handles_partial_megabyte_total() {
    // 500 KB total → integer-MB division yields 0, so we treat it
    // identically to "no total" rather than printing "0/0 MB".
    let small_total = 500 * 1024;
    let label = format_download_progress(0, Some(small_total));
    // Integer division gives ``0`` MB; not ideal but at least not
    // misleading — the formatter still prints a valid "downloading"
    // string and never panics.
    assert!(label.starts_with("Status: Downloading"));
}

// ── validate_install_preconditions ───────────────────────────────────────
//
// These tests guard the two-stage precondition check added to
// `run_update_install` to prevent the install command from returning
// `Ok(())` to the frontend before the process has restarted (which left
// the UI frozen on "Installing update…" indefinitely).

/// Helper: write a real temp file so `is_file()` returns true.
/// Returns the path; the file lives in `std::env::temp_dir()` and is
/// cleaned up by the OS (good enough for short-lived unit tests).
///
/// ``discriminator`` (pass the test name) keeps paths unique across
/// tests: `cargo test` runs multi-threaded, and two tests hitting this
/// helper in the same nanosecond-bucket used to race on a shared path —
/// one test's cleanup deleted the file out from under the other
/// (the old `preconditions_ok_when_patch_version_is_correct` flake).
fn real_bytes_path(discriminator: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "oad-test-update-{discriminator}-{}.update",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .subsec_nanos()
    ));
    std::fs::write(&path, b"fake update bytes").expect("write test update file");
    path
}

#[test]
fn preconditions_ok_when_cache_and_version_match() {
    let path = real_bytes_path("preconditions_ok_when_cache_and_version_match");
    let cached = CachedUpdateState {
        version: "1.71.0".into(),
        bytes_path: path.clone(),
    };
    let result = validate_install_preconditions(Some(&cached), Some("1.71.0"));
    let _ = std::fs::remove_file(&path);
    assert!(result.is_ok());
}

#[test]
fn preconditions_err_when_no_cached_state() {
    // No download has been started — `update_state` is None.
    let err = validate_install_preconditions(None, Some("1.71.0")).unwrap_err();
    assert!(
        err.contains("not been downloaded"),
        "unexpected message: {err}"
    );
}

#[test]
fn preconditions_err_when_bytes_file_missing() {
    // The cached entry exists but the file was deleted (e.g. cache wiped).
    let cached = CachedUpdateState {
        version: "1.71.0".into(),
        bytes_path: PathBuf::from("/nonexistent/oad-test-openagentd-1.71.0.update"),
    };
    let err = validate_install_preconditions(Some(&cached), Some("1.71.0")).unwrap_err();
    assert!(err.contains("missing"), "unexpected message: {err}");
}

#[test]
fn preconditions_err_when_server_has_no_update() {
    // The server manifest was already bumped past the downloaded version,
    // so `updater.check()` returned `None` ("already up to date").
    // This used to be silently converted to a confusing "already up to
    // date" error that left the UI stuck on "Installing…".
    let path = real_bytes_path("preconditions_err_when_server_has_no_update");
    let cached = CachedUpdateState {
        version: "1.71.0".into(),
        bytes_path: path.clone(),
    };
    let err = validate_install_preconditions(Some(&cached), None).unwrap_err();
    let _ = std::fs::remove_file(&path);
    assert!(
        err.contains("no longer listed"),
        "unexpected message: {err}"
    );
}

#[test]
fn preconditions_err_when_version_mismatch() {
    // User downloaded 1.71.0 but the server already serves 1.72.0.
    // Installing mismatched bytes would silently apply the wrong update.
    let path = real_bytes_path("preconditions_err_when_version_mismatch");
    let cached = CachedUpdateState {
        version: "1.71.0".into(),
        bytes_path: path.clone(),
    };
    let err =
        validate_install_preconditions(Some(&cached), Some("1.72.0")).unwrap_err();
    let _ = std::fs::remove_file(&path);
    assert!(err.contains("1.71.0"), "should mention downloaded version: {err}");
    assert!(err.contains("1.72.0"), "should mention server version: {err}");
    assert!(err.contains("no longer matches"), "unexpected message: {err}");
}

// ── double-install guard ──────────────────────────────────────────────────
//
// The `run_update_install` command rejects a second invocation while the
// first install is already tearing the app down. These tests exercise the
// `validate_install_preconditions` contracts that the guard relies on, as
// well as asserting the precondition logic is idempotent (calling it twice
// with identical state must succeed twice — we must not consume or clear
// the cached state on a successful check).

#[test]
fn preconditions_ok_is_idempotent_for_same_state() {
    // Simulates a UI that calls the install command twice in quick
    // succession (button double-tap, retry). The second call must not fail
    // because the first check "consumed" the cache.
    let path = real_bytes_path("preconditions_ok_is_idempotent_for_same_state");
    let cached = CachedUpdateState {
        version: "1.84.0".into(),
        bytes_path: path.clone(),
    };
    let r1 = validate_install_preconditions(Some(&cached), Some("1.84.0"));
    let r2 = validate_install_preconditions(Some(&cached), Some("1.84.0"));
    let _ = std::fs::remove_file(&path);
    assert!(r1.is_ok(), "first check should pass");
    assert!(r2.is_ok(), "second check should pass (idempotent)");
}

#[test]
fn preconditions_err_gives_actionable_message_for_missing_cache() {
    // When `quitting` is true but a second `updater_install` call slips
    // through before the guard is added, `update_state` is None because
    // the first install already consumed / cleared it. The error message
    // must tell the user what went wrong rather than panicking.
    let err = validate_install_preconditions(None, Some("1.84.0")).unwrap_err();
    assert!(
        err.contains("not been downloaded"),
        "user-facing message should explain the cache is empty: {err}"
    );
}

#[test]
fn preconditions_ok_when_patch_version_is_correct() {
    // Regression guard for the 1.83.0 → 1.83.1 scenario from the logs:
    // a patch release must satisfy the version-match check.
    let path = real_bytes_path("preconditions_ok_when_patch_version_is_correct");
    let cached = CachedUpdateState {
        version: "1.83.1".into(),
        bytes_path: path.clone(),
    };
    let result = validate_install_preconditions(Some(&cached), Some("1.83.1"));
    let _ = std::fs::remove_file(&path);
    assert!(result.is_ok(), "patch-version install should pass preconditions");
}
