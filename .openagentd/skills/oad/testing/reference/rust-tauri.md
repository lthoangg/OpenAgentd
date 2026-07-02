
Write focused, fast unit tests for the OpenAgentd desktop shell (`desktop/src-tauri/src/`).

---

## Stack

| Layer | Tool |
|---|---|
| Runner | `cargo test` (built-in libtest; **binary crate — no `[lib]`, no `--lib` flag**) |
| Test location | Inline `#[cfg(test)] mod tests` at the bottom of each source file |
| Assertions | `assert!`, `assert_eq!` with a context message on non-obvious checks |
| HTTP | Not mocked — network-touching fns are **not** unit-tested; extract and test the pure parts instead |
| Tauri APIs | Not mocked — `tauri::test` (`mock_builder`/`mock_app`) requires the `test` cargo feature which this project does **not** enable |

---

## Core convention: pure-function extraction

The single most important rule. `AppHandle`, `Menu`, `TrayIcon`, `WebviewWindow`, and
`reqwest` calls are **untestable** in this crate's unit tests. Structure code so the
logic worth testing never touches them:

```
┌─ untested shell (thin) ────────────────────────────────┐
│ async fn refresh_usage_now(app: &AppHandle) {          │
│     let body = fetch_usage_summary(...).await;  // IO  │
│     let rows = format_summary_rows(&body, now); // ←──── pure, tested
│     submenu.insert(...)                         // UI  │
│ }                                                      │
└────────────────────────────────────────────────────────┘
```

Existing exemplars to imitate:

- `src/usage.rs` — fetch fn is ~30 lines of IO; everything else
  (`format_summary_rows`, `format_footer`, `backoff_delay`, `has_critical_usage`,
  `status_glyph`, truncation) is pure and unit-tested. The module doc even says:
  *"Kept free of Tauri types so the formatting logic can run without a live app handle."*
- `src/updater.rs` + `src/main.rs::tests` — `validate_install_preconditions`,
  `format_update_prompt`, `format_download_progress`, `dialog_result_is_accept`
  are pure helpers extracted from the updater flow and tested in `main.rs`.
- `src/window.rs` — `new_window_init_script`, `inherited_external_base_url`,
  `frontend_init_script` return `String`/`Option` and are asserted on content.

When adding a feature: if you find yourself wanting an `AppHandle` in a test,
**refactor the production code** so the decision/formatting logic takes plain data
(`&str`, `i64`, structs) and returns plain data. Don't reach for mocks.

---

## File layout

Tests live in the same file as the code, at the bottom:

```rust
// ... production code ...

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_delay_is_flat_when_healthy_and_doubles_per_failure() {
        ...
    }
}
```

- One `mod tests` per file. `main.rs` hosts tests for helpers that live in other
  modules but are only `pub` for testing (see `#[cfg(test)] pub fn` below).
- Test names are full sentences in snake_case describing the behavior, not the fn:
  `rows_render_one_line_per_connected_provider`, not `test_format_rows_1`.
- Group sections inside a large `mod tests` with banner comments:
  `// ── format_download_progress ────────────────`.

### `#[cfg(test)] pub fn` — test-only visibility

A helper needed by tests in another module (e.g. `main.rs` testing an
`updater.rs` internal) is exported under `#[cfg(test)]` so release builds don't
grow public surface:

```rust
#[cfg(test)]
pub fn dialog_result_is_accept(result: &MessageDialogResult, ok_label: &str) -> bool { ... }
```

Same trick for test-only imports: `#[cfg(test)] use tauri_plugin_dialog::MessageDialogResult;`

---

## Fixture / builder helpers

Construct test data with small local factory fns at the top of `mod tests` —
mirror the frontend's block factories:

```rust
fn item_ok(provider: &str, label: &str, used_percent: f64, resets_at: Option<i64>) -> UsageSummaryItem {
    UsageSummaryItem {
        provider: provider.to_string(),
        label: label.to_string(),
        status: "ok".to_string(),
        error: None,
        usage: Some(UsageResponse { /* ... */ }),
    }
}
```

Derive `Debug, Clone, PartialEq` on data structs so `assert_eq!` works and
fixtures can be cloned/compared. Serde structs used in tests get `Deserialize`
(and only that — don't add `Serialize` unless production needs it).

---

## Time, filesystem, and async

### Time
Never call `SystemTime::now()` inside logic under test. Pass `now_unix: i64` as a
parameter (see `format_reset_in(resets_at, now_unix)`); the untested shell supplies
the real clock via a tiny `fn now_unix()` helper.

### Filesystem
- Tests that need a real file write to `std::env::temp_dir()` with a **unique**
  filename per test — include a nanosecond timestamp AND a per-test discriminator.
  ⚠️ Known trap: a shared fixed path races under parallel `cargo test`
  (the `preconditions_*` tests bit this). When two tests in the same file both
  create files, add the test name to the filename.
- Clean up with `let _ = std::fs::remove_file(&path);` **before** the assert, so
  a failing assert doesn't leak the file.

### Async
There is no async test infrastructure here (no `#[tokio::test]` in the codebase).
If logic inside an `async fn` needs testing, extract the sync decision logic into
a pure fn. Loop/timing behavior (`run_usage_poll_loop`) is validated by testing its
pure inputs (`backoff_delay`) — not by running the loop.

---

## What NOT to do

- **Never add `tauri = { features = ["test"] }` / `mock_builder`** just to test
  something — extract the logic instead. (Tauri's mock runtime is for crates
  structured as libs with heavy IPC surface; this crate deliberately isn't.)
- **Never unit-test `reqwest` calls** — no `mockito`/`wiremock` deps here. The
  HTTP fn should be a thin deserialize wrapper; test the deserialized-data handling.
- **Never depend on test execution order or shared mutable state** — `cargo test`
  runs multi-threaded by default.
- **Never assert on emoji/glyphs with literal emoji in source** — use escapes
  (`"\u{1F534}"` for 🔴) so the file stays greppable and editors don't mangle it.
- **Never `sleep()` in a test** — if you're waiting for something, the design is wrong.
- **Never leave `target/` around after CI-style verification** — builds balloon to
  5–8 GB; run `cargo clean` when done verifying (repo gotcha, `target/` is gitignored).

---

## Edge cases this codebase always covers

Copy this checklist when testing a new formatter/validator:

- [ ] Multi-byte UTF-8: truncation must use `chars()`, never byte slicing
      (`&s[..n]` panics mid-codepoint) — assert `is_char_boundary` / char counts
- [ ] Zero / missing values: `Some(0)` Content-Length, `checked_at <= 0`,
      empty vec inputs — must not render garbage like `"5/0 MB"`
- [ ] Overflow: counters that feed `1u32 << n` or multiplication must be tested
      with absurd inputs (`backoff_delay(base, 1_000, max)`) — no panic, clamped
- [ ] Idempotence: validation fns called twice with the same state pass twice
      (no consumed state on the success path)
- [ ] Boundary thresholds: test exactly at the threshold (70.0, 90.0), just below,
      and just above

---

## Run commands

```bash
cd desktop/src-tauri

# Type-check (fast, run first)
cargo check

# Full test suite
cargo test

# Single test / filter by substring
cargo test backoff_delay
cargo test tests::rows_render

# Single-threaded (diagnose test interference / shared-state races)
cargo test -- --test-threads=1

# Show println!/log output from passing tests
cargo test -- --nocapture

# After heavyweight verification (tauri build etc.)
cargo clean
```

---

## Checklist before committing a Rust test

- [ ] Test lives in `#[cfg(test)] mod tests` in the same file as the code
- [ ] No `AppHandle`, `Menu`, `TrayIcon`, or network types in any test
- [ ] Time passed as a parameter, not read from the clock inside tested logic
- [ ] Temp files use unique names and are removed before asserts
- [ ] Name reads as a behavior sentence; failure messages added where the assert
      alone wouldn't explain the intent (`"unexpected message: {err}"`)
- [ ] `cargo check` then `cargo test` green; `cargo clean` after any full build
