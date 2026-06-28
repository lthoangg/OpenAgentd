# Debug reference: Tauri / Rust (desktop & mobile)

Use when the symptom is in the Rust layer — sidecar lifecycle, window management, tray, IPC, permissions, CSP, or native plugin behavior.

---

## Surface overview

| Shell | Path | Role |
|---|---|---|
| Desktop | `desktop/src-tauri/` | Sidecar supervisor, tray, multi-window, auto-update |
| Mobile | `mobile/src-tauri/` | Minimal shell, no sidecar, remote API only |

---

## Evidence commands

### Fast Rust checks (no full Tauri build)

```bash
# Desktop
cd desktop/src-tauri && cargo check
cd desktop/src-tauri && cargo clippy -- -D warnings

# Mobile
cd mobile/src-tauri && cargo check
cd mobile/src-tauri && cargo clippy -- -D warnings
```

### Run in dev mode (see live logs)

```bash
# Desktop — requires root `make dev` already running
make -C desktop dev              # against external backend + Vite
make -C desktop dev-bundled      # against bundled sidecar

# Mobile
make -C mobile dev               # Android
make -C mobile ios-dev           # iOS simulator
```

Tauri dev mode prints Rust `log::` output to the terminal and writes to the platform log file. Filter with `RUST_LOG=debug` for verbose output.

---

## File map — desktop

```
desktop/src-tauri/
  src/
    main.rs              App entry, AppState, tray, window lifecycle, updater, IPC commands
    sidecar.rs           Sidecar process supervisor, auth-token handshake
  Cargo.toml             Deps: tauri 2, tokio, anyhow, serde, plugins
  tauri.conf.json        Production config (updater endpoint, asset-protocol scope, bundles)
  tauri.dev.conf.json    Dev against external backend + Vite
  tauri.dev-bundled.conf.json  Dev against bundled sidecar
  capabilities/          Tauri capability definitions (which commands/plugins frontend can call)
  permissions/           Fine-grained permission sets
  build.rs               Tauri build integration
```

## File map — mobile

```
mobile/src-tauri/
  src/
    main.rs              Minimal app entry — no sidecar, no tray
  Cargo.toml             Minimal deps (no updater, no sidecar plugins)
  tauri.conf.json        Window size (390×844 default), CSP, iOS/Android bundle config
  build.rs               Tauri build integration
```

---

## Common failure boundaries

| Symptom | Where to look |
|---|---|
| Sidecar won't start / crashes | `src/sidecar.rs` — spawn args, env vars, port detection |
| Auth token missing / rejected | `src/sidecar.rs` token generation, `core/desktop_auth.py` validation |
| Window not appearing / wrong size | `src/main.rs` `WebviewWindowBuilder` + all three Tauri configs |
| Tray icon / menu broken | `src/main.rs` `build_tray` / menu builders |
| URL not opening in browser | `OpenerExt::open_url` — check `tauri-plugin-opener` is registered and permission granted |
| IPC command not found | Missing `#[tauri::command]` + `invoke_handler` registration + capability entry |
| CSP blocking a resource | `tauri.conf.json` → `app.security.csp` (update all config variants) |
| Permission denied in webview | `capabilities/` — add the required permission set |
| Auto-update not triggering | Updater endpoint URL, `pubkey`, `createUpdaterArtifacts: true` in production config |
| iOS signing error | `mobile/ios-team.txt` (git-ignored) must contain valid Apple team ID |
| Process not cleaned up on quit | `src/main.rs` `RunEvent::ExitRequested` / `WindowEvent::CloseRequested` handlers |

---

## Config variants — keep all three consistent (desktop)

When changing window config, CSP, plugin config, or permissions, touch:
1. `tauri.conf.json` — production
2. `tauri.dev.conf.json` — external dev
3. `tauri.dev-bundled.conf.json` — bundled dev

---

## Tauri ↔ frontend IPC patterns

- **Rust → JS events**: `app_handle.emit("event-name", payload)` / `window.emit(...)`
- **JS → Rust commands**: `invoke("command_name", args)` — requires `#[tauri::command]`, `invoke_handler`, and a `capabilities/` entry.
- **Detect Tauri in frontend**: check `window.__TAURI_INTERNALS__` or use an `isTauri()` utility.

---

## Gotchas

- `#[cfg(test)]` dialog stubs in `main.rs` — keep in sync with plugin API signatures.
- Windows, macOS, and Linux have different process cleanup lifecycle events — test all three mentally before changing exit handlers.
- Never commit `target/`, generated sidecar bundles, or machine-local `.openagentd/` state.
- Mobile has **no sidecar** — always connects to an external API server.
- `cargo check` is fast; `cargo tauri build` is slow — always verify with `check` first.

---

## Verification

```bash
cd desktop/src-tauri && cargo check && cargo clippy -- -D warnings
cd mobile/src-tauri  && cargo check && cargo clippy -- -D warnings
```

For a full build smoke test:

```bash
make -C desktop build   # release bundle (slow — only when packaging)
```
