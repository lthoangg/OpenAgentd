# Testing reference: native shells and shared crate

Covers `desktop/src-tauri/` (binary crate, no `[lib]`), `mobile/src-tauri/`
(lib + thin `main.rs`), and `native/shell-core/` (Tauri-free crate shared by both
shells). The backend sidecar is `appv3/` and is tested with `cargo test` there.

## Run commands

Desktop builds read the Tauri config at compile time, so pass it the way
`make verify-desktop` and CI do, and keep `--locked`:

```bash
cd desktop/src-tauri
TAURI_CONFIG="$(cat tauri.dev.conf.json)" cargo check --locked
TAURI_CONFIG="$(cat tauri.dev.conf.json)" cargo test --locked <filter>
TAURI_CONFIG="$(cat tauri.dev.conf.json)" cargo test --locked -- --test-threads=1 --nocapture  # diagnose races / see output
TAURI_CONFIG="$(cat tauri.dev.conf.json)" cargo clippy --locked --all-targets

cd native/shell-core && cargo test <filter>
```

Full gates: `make verify-desktop`, `make verify-mobile` (check only; the mobile
crate's tests live in `src/lib.rs`), `make verify-shell-core`, or all three with
`make verify-native`. Native builds grow `target/` to several GB; run
`cargo clean` in the crate when space matters.

## Core convention: pure-function extraction

Logic worth testing should not need a live window, tray, menu, or network.
Keep the IO shell thin and test the decision or formatting function it calls:

```
async fn refresh_usage_now(app: &AppHandle) {
    let body = fetch_usage_summary(...).await;   // IO, untested
    let rows = format_summary_rows(&body, now);  // pure, tested
    submenu.insert(...)                          // UI, untested
}
```

Exemplars: `src/usage.rs` (`format_summary_rows`, `backoff_delay`),
`src/updater.rs` (`validate_install_preconditions`, `format_update_prompt`,
`dialog_result_is_accept`), `src/window.rs` (`frontend_init_script`,
`new_window_init_script`). Shared, Tauri-free behavior (server config, URL
normalization, keyring access keys, download limits) belongs in
`native/shell-core`, where it is tested without Tauri at all.

## Tooling available in tests

- `tauri::test::mock_app()` (the `test` feature is a desktop dev-dependency):
  enough for state and window lookups (`main.rs`, `tray_popup.rs` tests). Prefer
  extraction over building larger mock apps.
- `#[tokio::test]` for async helpers (`commands.rs`, `usage.rs`).
- `tempfile::tempdir()` for filesystem tests (`sidecar.rs`); never share a fixed path.
- No HTTP mocking crate: keep `reqwest` calls as thin deserialize wrappers and test the data handling.

## Conventions

- Tests sit in `#[cfg(test)] mod tests` at the bottom of the file; names are
  behavior sentences (`backoff_delay_is_flat_when_healthy_and_doubles_per_failure`).
- A helper another module's tests need is `#[cfg(test)] pub fn`, so release builds keep their surface.
- Pass time in (`now_unix: i64`); never read the clock inside tested logic.
- `cargo test` is multi-threaded: no shared mutable state, no order dependence, no sleeps.
- Write emoji and glyphs as escapes (`"\u{1F534}"`), not literals.

## Edge cases to cover in formatters and validators

- [ ] Multi-byte UTF-8: truncate by `chars()`, never byte slices.
- [ ] Zero or missing values (`Some(0)` lengths, empty vectors, `<= 0` timestamps).
- [ ] Overflow on absurd inputs (`backoff_delay(base, 1_000, max)` clamps, no panic).
- [ ] Idempotence: a validation that passes once passes again.
- [ ] Thresholds: exactly at, just below, and just above.
