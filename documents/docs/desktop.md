---
title: Desktop distribution
description: How OpenAgentd packages, ships, signs, and updates the native desktop app.
status: stable
updated: 2026-06-25
---

# Desktop distribution

The desktop app is a **Tauri v2 shell** wrapping the existing FastAPI
backend as a **Python sidecar**. Non-technical users download a single
installer (`.dmg` or `.AppImage`) and double-click to run —
no Python install, no `uv tool install`, no terminal.

> **Windows builds were removed in v1.23.0.** The Windows-specific details
> below are retained for historical context and to make it easier to
> restore Windows support later; they do **not** describe shipping behaviour
> today. See [`features.md`](./features.md#11-distribution-and-updates).

## Architecture

```
┌───────────────────────────── OpenAgentd.app / .exe / .AppImage ───┐
│                                                                    │
│  ┌─ Tauri Rust shell ─────────────────────────────────────────┐   │
│  │  • Native window + system tray                             │   │
│  │  • Process supervisor                                      │   │
│  │  • Auto-updater                                            │   │
│  └─────────────────────────────────────────────────────────────┘   │
│         │ spawns                              │ loads              │
│         ▼                                     ▼                    │
│  ┌─ Python sidecar ──────────────┐  ┌─ WebView (system) ─────┐   │
│  │  python-build-standalone 3.14 │  │  bundled web/dist      │   │
│  │  + site-packages/             │  │  injects               │   │
│  │  + app/ (FastAPI API only)    │  │    __OAD_API_BASE_URL__│   │
│  │  bound to 127.0.0.1:<port>    │  │    __OAD_TOKEN__       │   │
│  │  serves /api/* + /metrics     │  └────────────────────────┘   │
│  └───────────────────────────────┘                                 │
│                                                                    │
└─────────────────────────────────────────────────────────────────────┘
```

The Tauri shell opens the WebView immediately with the normal loading/backend-unreachable UI, then starts backend discovery and sidecar readiness asynchronously. It normally runs the bundled sidecar, but each desktop window can be pointed at an externally managed OpenAgentd server from the shared **Backend connection** UI: open Settings, click the sidebar health dot, or use the home-page server status. Connection options are intentionally limited to **Builtin sidecar** and user-saved servers. Saved servers can be named, renamed, removed, and show live status indicators. **Connect** probes `/api/health/live`, verifies `/api/auth/check` when the server supports it, and switches only the current window's runtime backend without reloading so the entry can still be named and saved. When **Save this server and reconnect to it after reload** is enabled, the external server is also saved as the startup backend; the next app launch tries that server first, but if it is unreachable the app still opens by falling back to the bundled sidecar so the user can choose another server or use builtin. The builtin row now shows **Stop** whenever the bundled sidecar process is already running, even if the current window is attached to an external backend; when the sidecar is stopped, the row shows **Use builtin**, which starts the bundled backend if needed and attaches the current window to it. **Use builtin** clears the remembered startup backend. **Save server** persists or renames an entry without switching. Secondary windows now inherit the active window's current backend selection when they are opened, external-window overrides are cleared when that window closes, and removing a saved external server clears matching window overrides without stopping the bundled sidecar. If no sidecar/server is reachable, the home page shows **Backend unreachable** and the dialog lets the user choose or save a server. Desktop startup no longer accepts `OPENAGENTD_DESKTOP_BASE_URL` or the legacy `OPENAGENTD_DEV_BACKEND_URL` as implicit backend defaults.

Coding workspaces are always selected on the machine running the backend. When the desktop app is using the bundled sidecar or a loopback backend (`localhost` / `127.0.0.1`), **Open folder…** can use the native desktop folder picker because the WebView and backend are on the same machine. When the desktop app is connected to a LAN/external backend such as `192.168.x.x` or `10.x.x.x`, **Open folder…** uses the web/server-local folder browser instead; the native picker would only select a folder on the client desktop, not on the backend host that will run file and shell tools.

The Tauri shell:

1. Locates the bundled CPython 3.14 inside the app bundle.
2. Spawns `python -m app.cli serve --handshake --generate-token --parent-pid <us>`.
3. Reads the JSON handshake line from stdout: `{"port":..., "token":..., "pid":..., "version":...}`.
4. Polls `http://127.0.0.1:<port>/api/health/live` for readiness.
5. Builds a WebView from Tauri's packaged `web/dist`, injecting `window.__OAD_API_BASE_URL__` and the token as `window.__OAD_TOKEN__` via `initialization_script` *before* any page JS runs.
6. The bundled React UI's `installDesktopAuth()` patches `window.fetch`
   to attach `Authorization: Bearer <token>` to requests targeting the
   injected API base URL.
7. Installs native app-menu and tray-menu actions for opening windows,
   navigating to common routes, hiding to tray, and quitting cleanly.

The Python sidecar:

- Binds 127.0.0.1 on an OS-ephemeral port (`--port 0`) — no fixed
  port, so multiple instances can coexist and stale-lock conflicts
  are impossible.
- Generates a URL-safe random token, exposes it on the handshake line,
  and writes it into `OPENAGENTD_DESKTOP_TOKEN` for its middleware.
- Polls `--parent-pid` every 500 ms; if Tauri dies the backend exits
  cleanly (with a 5 s SIGTERM grace period before hard kill).
- On Windows, Tauri additionally puts the sidecar in a Job Object with
  `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` — the OS guarantees cleanup even
  if our own watch never fires.

## Security model

Without a token, anything else running on the user's machine could
reach the local API (read chat history, exfiltrate provider keys, run
agent tools). The token mitigates that.

| Aspect                                       | Behavior                                                                                                   |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Token lifetime                               | One launch only. Regenerated next start. Never persisted.                                                  |
| Token transport                              | `Authorization: Bearer …` for `fetch`/SSE; `?_token=…` for image/video/download URLs the browser can't header-stamp. |
| Comparison                                   | `hmac.compare_digest` (constant-time).                                                                     |
| Bypassable routes                            | `/api/health/live`, `/api/health/ready`, `/metrics`.                                                       |
| Credential check                             | `/api/auth/check` is intentionally a no-op handler behind the same middleware; desktop clients use it to verify a LAN access key before switching servers. |
| Off-switch                                   | Unset `OPENAGENTD_DESKTOP_TOKEN` and any configured access key — the middleware becomes a no-op. CLI / Docker users keep open behaviour unless they enable a key. |

See `app/core/desktop_auth.py` for the implementation and
`tests/core/test_desktop_auth.py` for the contract. The web layer centralizes
this fallback in `resolveApiUrl()` and `workspaceMediaUrl()` so uploaded
attachments, workspace media, previews, and downloads keep working when the UI
origin differs from the backend origin. API responses use
`Cross-Origin-Resource-Policy: cross-origin`; authorization still comes from the
desktop token, not from CORP.

## Native menus and tray

The shell installs native app menus and a compact tray dropdown in `desktop/src-tauri/src/main.rs`.

| Surface | Purpose |
|---------|---------|
| App menu / menu bar | Full desktop command surface: navigation, panels, settings, updates, reload/zoom, config, logs, and quit. |
| System tray dropdown | Background quick actions only: status/session, show, Cockpit, Coding, Command Palette, Settings, config/logs, reload, quit. |

The **Edit** submenu is required on macOS for native `⌘A` / `⌘C` / `⌘V` / `⌘X` / `⌘Z` to reach the webview's input fields — without it those shortcuts have no handler at the application level and the corresponding actions silently no-op inside the textarea. `Undo`/`Redo` are macOS-only and not registered on Windows/Linux; the other edit items work on all platforms.

The **About OpenAgentd** item opens the native About panel populated with the app icon, name, version (from `Cargo.toml` / `tauri.conf.json`), copyright, and a link to the project repository.

**Home**, **Cockpit**, **Coding**, **Settings**, **Providers**, **Notifications**, and **Telemetry** are route shortcuts. **Show OpenAgentd** focuses the primary window state; **New Window** (`⌘/Ctrl+N`) opens another cockpit window backed by the same current backend as the active window (bundled sidecar + desktop token, or that window's selected external server). **Home** intentionally resets the active webview to the mode picker.

**Command Palette**, **Wiki**, **Scheduled Tasks**, and **Session Settings** are bridged from native menu/tray events into the same React/Zustand actions used by the in-app shortcuts. They summon the active desktop window first, then open the requested overlay or panel. Scheduled tasks are a panel inside the cockpit today; the `/scheduler` route remains a compatibility redirect rather than a standalone page.

The **View → Reload** action (`⌘/Ctrl+R`) calls `window.location.reload()` on the active webview, respecting the HTTP cache. The tray **Reload Window** action uses the same webview-only reload path for cases where the main window is hidden or wedged. **Force Reload** (`⌘/Ctrl+Shift+R`) is backend-mode-aware: windows using an external backend do a frontend-only reload and keep their current external server selection, while windows using the bundled backend take the bundled reload path. On macOS that bundled path restarts the app process for faster recovery; on other platforms it restarts the managed sidecar, waits for health, then reinjects the new backend port/token into open bundled windows. To keep hard reload responsive, the old sidecar gets a short graceful-shutdown window before Tauri force-kills it and starts the replacement; normal quit/update shutdown still uses the longer graceful shutdown path. Reload always brings a window to front before refreshing so the user sees the result.

The utility actions **View Config Folder** and **View Backend Log** are desktop diagnostics. Config opens the shared CLI/desktop config root (`$OPENAGENTD_CONFIG_DIR` or `~/.config/openagentd`). Backend log reveals the bundled sidecar's `backend.log` when the sidecar is running; it is unavailable when the app is connected only to an external backend.

Packaged desktop builds allow `about:` in `frame-src` so sandboxed MCP Apps rendered through `iframe.srcdoc` stay interactive under the production Tauri CSP. The app HTML still receives its own MCP resource CSP from `_meta.ui.csp`; the shell-level rule only permits the `about:srcdoc` document that WebKit/Chromium creates for the iframe.

Packaged builds also set `dangerousDisableAssetCspModification: ["script-src", "style-src"]`. Without it, Tauri injects per-asset script hashes/nonces into the configured CSP at build time, and the presence of any hash or nonce makes browsers ignore `'unsafe-inline'` in `script-src`/`style-src`. The `srcdoc` MCP App iframe inherits the parent document's CSP, so its inline `<script>` tags were silently blocked in production builds (blank canvas for apps like the Excalidraw MCP) while dev builds — which load an external URL and skip CSP injection — worked. Script execution inside the iframe is still constrained by the per-resource CSP `<meta>` tag injected from `_meta.ui.csp` and the iframe `sandbox` attribute.

**Zoom In** / **Zoom Out** / **Actual Size** (`⌘/Ctrl+=`, `⌘/Ctrl+-`, `⌘/Ctrl+0`) drive `Webview::set_zoom` on every open OpenAgentd window — the bare `=` key is bound so the user doesn't need Shift, matching Chrome and Safari. The zoom factor multiplies by 1.2 per press, clamped to `[0.5, 3.0]`, and resets to 1.0. State is session-only — not persisted across restarts — because the desktop shell has no other settings store.

Clicking the tray icon opens the tray menu (showing live status first) rather than summoning the main window. The window is summoned explicitly via the "Show OpenAgentd" entry. This matches macOS menu-bar app conventions where the icon is a status surface rather than a launcher.

When the application is already running in the background, clicking the Dock icon or launching the app again (e.g., via Spotlight) triggers a `RunEvent::Reopen` event, which automatically unminimizes, shows, and focuses the main window.

Closing the main window hides it to the tray instead of stopping the backend. Closing a secondary window destroys only that window. Selecting **Quit OpenAgentd** from the app menu or tray marks the app as quitting, exits Tauri, and lets the existing shutdown path terminate the Python sidecar cleanly.

The tray status starts at `Status: Starting`, changes to `Status: Running` once the bundled sidecar is healthy, and changes to `Status: Error` when no sidecar or saved server is reachable. During desktop frontend reloads, React now waits for bundled-backend readiness before treating the shell as bootstrapped, while external-backend windows skip that wait and restore their saved server immediately. In the error state the window still opens and the home page shows **Backend unreachable** so the user can choose the builtin sidecar or a saved server from the backend connection dialog.

The tray **Session** line below status mirrors the user's active context with liveness taking priority over identity:

- `Working: <workspace-or-title>` (or just `Working…` if the session has no title yet) — the team is currently generating a response.
- `Coding: <workspace-name>` — a coding workspace is open but idle.
- `Chat: <session-title>` — a chat session has a server-named title and is idle.
- `No active session` — fallback when nothing is open.

The frontend pushes the label via the `set_tray_session` Tauri command (see `web/src/lib/tray.ts`) whenever the active mode/workspace/session-title or the team's working flag changes; the command silently truncates labels longer than 60 characters so the tray menu width stays sane.

## Notifications

Native desktop notifications use `tauri-plugin-notification` and are controlled from **Settings → Notifications**. They are enabled by default, skipped while the desktop window is focused, and can be tested with a forced notification from that settings page. Notification sounds are controlled by the operating system; OpenAgentd does not play an extra in-app sound.

The backend emits `desktop_notification` SSE events for assistant completion and scheduled reminders, so completion notifications still fire even if the user has switched sessions. The frontend also emits a background-completion notification when a `bg` tool process exits or stops. Assistant completion text is session-centric: `Session completed` or `Session completed - <workspace>`, with the session title as the body when available.

## Updates

The desktop bundle checks the signed Tauri updater manifest at `https://github.com/lthoangg/openagentd/releases/download/latest-desktop/latest.json`.

- Users can check manually from **OpenAgentd → Check for Updates…** or **Settings → About → Updates**.
- The app also runs a silent check shortly after startup and every 6 hours while open.
- Update UI is rendered in React as a bottom-right card. Native OS dialogs are not used for this flow.
- Download and install are separate steps: the bundle downloads first, then the user chooses **Install and restart**.
- Download progress is still mirrored in tray status. Downloaded updates are cached in the app cache dir so repeated checks can show the ready-to-install state instead of downloading again.
- Release notes are fetched from the GitHub release and rendered in an in-app Markdown popup with a **View in GitHub** link.

On install, Rust verifies the updater signature, shuts down the Python sidecar, then calls `app.restart()`. CLI/server installs still upgrade via `openagentd upgrade` or the package manager that installed them; see [CLI reference](./cli.md).

## Window chrome

macOS uses the **Overlay** title-bar style (`tauri.conf.json` + `configure_window_chrome` in `main.rs`) — the OS keeps drawing the traffic-light buttons but the WebView extends edge-to-edge underneath. The React app reserves a 70 px left inset and provides the window-drag region itself.

Each desktop window also syncs its native macOS title from the active surface: coding windows use the workspace basename, while cockpit windows use the session title. That title is what macOS shows in the Dock's per-window list when multiple OpenAgentd windows are open.

The bundle includes `Info.plist` with `NSMicrophoneUsageDescription` and `NSSpeechRecognitionUsageDescription` so WebView voice input can show native permission prompts. `entitlements.plist` grants `com.apple.security.device.audio-input` for signed builds. macOS voice input also requires the system speech service: if **Siri & Dictation** / **Dictation** is disabled in System Settings, Screen Time, or device management policy, WebKit speech recognition can fail with `Siri and Dictation are disabled` or `Microphone permission check has failed`. Enable **System Settings → Keyboard → Dictation**, then retry.

Windows and Linux keep their native title bars (`decorations: true`).

Implementation details (header, drag hook, traffic-light position tuning) live in [`web/chrome.md`](web/chrome.md).

## Bundle layout

### macOS (`OpenAgentd.app`)

```
OpenAgentd.app/
  Contents/
    MacOS/
      OpenAgentd                          ← Tauri executable
    Resources/
      sidecar/
        python/
          bin/python3
          lib/python3.14/
        site-packages/
          app/                            ← FastAPI API server only
          fastapi/  pydantic/  …
      _up/                                ← Tauri updater artefacts
    Info.plist
```

User data (XDG-style, mapped to native dirs by Tauri at launch):

```
~/Library/Application Support/com.openagentd.desktop/   ← OPENAGENTD_DATA_DIR
~/Library/Application Support/com.openagentd.desktop/   ← OPENAGENTD_CONFIG_DIR (same root, but app/cli/paths.py keeps logical split)
~/Library/Caches/com.openagentd.desktop/                ← OPENAGENTD_CACHE_DIR
~/Library/Logs/com.openagentd.desktop/                  ← OPENAGENTD_STATE_DIR + sidecar stderr/stdout
```

### Linux (`OpenAgentd_<ver>_amd64.AppImage`, `.deb`)

```
/usr/lib/openagentd/sidecar/python/
/usr/lib/openagentd/sidecar/site-packages/
/usr/bin/OpenAgentd              ← Tauri executable, .deb only
```

AppImage is self-contained and the recommended Linux artefact.
`.deb` requires `libwebkit2gtk-4.1-0` and `libgtk-3-0` (declared in
the package manifest).

## Build pipeline

```bash
# Phase 1: web build + API-only sidecar bundle
cd web && bun install --frozen-lockfile && bun run build && cd ..

python3 scripts/build_sidecar.py \
  --root . \
  --out  desktop/sidecar-bundle \
  --python-version 3.14
```

The bundler:

1. Fetches python-build-standalone via `uv python install`.
2. `uv pip install --target` of `openagentd` (the local project) into
   `site-packages/`. Includes `markitdown[pdf,docx]` by default; HTML conversion
   uses markitdown core.
3. Strips `__pycache__`, `tests/`, `.pyc`, locale `.mo` files.
4. Runs a smoke test: starts `serve --handshake`, parses the handshake,
   SIGTERMs.

Current slim bundle size: **~470 MB** uncompressed (macOS arm64), including
client-side browser / WebView speech recognition for microphone voice input.
Optional `[audio,azure-doc-intel]` extras add ~80 MB.

```bash
# Phase 2: Tauri build
cd desktop && make build-dev-app  # local .app; rebuilds web assets + sidecar first
# or, for release artefacts:
cd desktop && make icons          # one-time / on icon change
cd src-tauri && cargo tauri build
```

Output artefacts land in
`desktop/src-tauri/target/release/bundle/{dmg,deb,appimage}/`.

## Release

A full release is **two workflows publishing into one GitHub tag** (`v<X.Y.Z>`):

| Workflow | Trigger | Cadence | Artefacts |
|---|---|---|---|
| `.github/workflows/release.yml` | `workflow_dispatch confirm=release` | ~90 s | `openagentd-<ver>-py3-none-any.whl`, `openagentd-<ver>.tar.gz`; publishes to PyPI. |
| `.github/workflows/release-desktop.yml` | `workflow_dispatch confirm=release-desktop` | ~20–25 min | `OpenAgentd_<ver>_aarch64.dmg`, `OpenAgentd_<ver>_amd64.deb`, `latest.json`. |

Both workflows use a **create-or-upload** publish step (`gh release view "$TAG"` → `upload --clobber` if present, else `create`), so order doesn't matter for correctness. The runbook orders them PyPI-first so the canonical auto-generated release notes come from `release.yml`; the desktop matrix then appends its installers ~20 min later. See [`.opencode/commands/release.md`](../../.opencode/commands/release.md) for the operator runbook.

History — pre-1.0.9 releases used a split-tag scheme (`v<X.Y.Z>` for PyPI, `v<X.Y.Z>-desktop` for installers). That produced fragmented compare-links, duplicate release notes, and a confusing release listing. 1.0.9 consolidated everything under one tag; older `v*-desktop` tags remain on GitHub for archival but aren't created by the workflows anymore.

`release-desktop.yml` matrix:

1. macOS arm64 on `macos-26` (Tahoe — the host SDK matters for the title-bar geometry; see "Window chrome" above).
2. Linux x64 on `ubuntu-22.04`.

Each runner: `scripts/build_sidecar.py` → `cargo tauri build` → `gh release upload`. The workflow pins current Node 24-compatible GitHub action majors for cache and artifact upload/download steps. The `latest.json` updater manifest is produced after all three matrix legs succeed and uploaded to a rolling `latest-desktop` release that mirrors only the manifest (artefact URLs *inside* `latest.json` still point at the immutable `v<X.Y.Z>` release).

Signing happens when secrets are present:

- **macOS**: `APPLE_SIGNING_IDENTITY` + `APPLE_ID` + `APPLE_PASSWORD` + `APPLE_TEAM_ID` → notarized + stapled.
- **Updater**: `TAURI_SIGNING_PRIVATE_KEY` + `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` → `.sig` files alongside artefacts.

When secrets are absent (today's default), the workflow conditionally **unsets** the Tauri signing env vars so `cargo tauri build` falls back to ad-hoc signing (`signingIdentity: "-"` in `tauri.conf.json`).

Tauri updater endpoint (in `tauri.conf.json`):

```
https://github.com/lthoangg/openagentd/releases/download/latest-desktop/latest.json
```

Companion publishers (run automatically off `workflow_run`):

- `.github/workflows/publish-homebrew.yml` — updates `lthoangg/homebrew-tap` `Formula/openagentd.rb` from the PyPI sdist after `release.yml` succeeds.
- `.github/workflows/publish-homebrew-cask.yml` — updates `lthoangg/homebrew-tap` `Casks/openagentd.rb` from the `.dmg` after `release-desktop.yml` succeeds. The resolver waits for a release with an `aarch64.dmg` asset attached, so the formula update and cask update don't race even though they're both triggered off the unified tag.

## Installation (unsigned builds)

Until paid code-signing certificates are wired into CI (Phase 3), the
release artefacts are **unsigned**. We ship a single installer entry
point per OS family:

| Platform        | Artefact                          | Install command                                  |
| --------------- | --------------------------------- | ------------------------------------------------ |
| macOS arm64     | `OpenAgentd-x.y.z.dmg`            | mount, then `/Volumes/OpenAgentd/install.sh --install` |
| Linux (any)     | `OpenAgentd-x.y.z.AppImage` (+ `.deb`) | `./install.sh --install ./OpenAgentd-x.y.z.AppImage` |

The unified script lives at `desktop/scripts/install.sh`. It does
platform-specific work via an `uname -s` switch:

- **macOS branch** — strips `com.apple.quarantine`, ad-hoc codesigns
  the `.app` (`codesign --sign -`) with the bundle's
  `entitlements.plist`, verifies, optionally copies to
  `/Applications/`. The ad-hoc signature is what allows Gatekeeper
  to launch the bundle without an Apple Developer ID — without it,
  macOS reports the bundle as "damaged".
- **Linux branch** — `chmod +x`, copies to `~/.local/bin/openagentd`,
  writes a `.desktop` entry to `~/.local/share/applications/`,
  registers icons under `~/.local/share/icons/hicolor/`, and runs
  `update-desktop-database` / `gtk-update-icon-cache` if present.
  Detects `.deb` / `.rpm` arguments and defers to `dpkg` / `rpm`.

User-facing copy lives in `desktop/scripts/INSTALL.md` and is
bundled inside every artefact via `tauri.conf.json` →
`bundle.resources`.

## Migration roadmap

| Phase  | Scope                                                                                       | Status         |
| ------ | ------------------------------------------------------------------------------------------- | -------------- |
| **0**  | Verify python-build-standalone 3.14 + heavy dep wheels on macOS / Windows / Linux           | ✅ done         |
| **1a** | Token auth middleware (`OPENAGENTD_DESKTOP_TOKEN`)                                          | ✅ done         |
| **1b** | Frontend `window.fetch` interceptor (`installDesktopAuth()`)                                | ✅ done         |
| **1c** | Slim core: `markitdown` heavy extras gated behind optional groups                           | ✅ done         |
| **1d** | Tauri v2 shell + sidecar supervisor + Job Object cleanup                                    | ✅ scaffolded   |
| **1e** | `scripts/build_sidecar.py` — python-build-standalone + `uv pip install --target` + smoke    | ✅ done         |
| **1f** | `.github/workflows/release-desktop.yml` — matrix build → signed artefacts → GitHub Release  | ✅ scaffolded   |
| **2**  | First-run provider setup inside the desktop shell (Settings → Providers, API keys + OAuth)  | ✅ done         |
| **2**  | Workspace picker / trust flow for coding mode                                               | ✅ done         |
| **2**  | `/api/diagnostics` endpoint + "Copy diagnostics" button                                     | ✅ done         |
| **3**  | macOS notarization, Windows Authenticode, Tauri updater public-key wiring                   | scaffold ready; needs certificates |
| **3**  | Update channels (stable / beta / nightly) → distinct `latest.json` URLs                     | partial         |

## What is intentionally NOT in scope

- **Intel macOS**: deferred. `macos-13` runners are deprecating;
  python-build-standalone arm64 builds are first-class. Intel users
  keep the `uv tool install openagentd` path until v2 ships universal2.
- **Removing `uv tool install`**: still supported, still recommended
  for developers and headless / server deployments. The desktop tier
  is **additional**, not a replacement.
- **Flatpak / Snap**: not for v1. AppImage covers ~90 % of Linux desktop
  installs without packaging complexity.
- **Frozen-Python compilation (Nuitka / PyInstaller)**: rejected.
  See `documents/techdebts/` for the analysis. Bundled CPython is
  more reliable for a fast-moving FastAPI/Pydantic codebase.

## Risk register

| Risk                                                                       | Mitigation                                                                                       |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Bundle size (~400 MB slim, ~750 MB with all extras)                        | Slim by default; on-demand feature packs in Phase 3.                                             |
| WebKitGTK version skew on Linux                                            | Officially support Ubuntu 22.04 LTS + 24.04 LTS; document fallback.                              |
| onnxruntime / pandas / lxml fail to build on Python 3.14                   | Wheels verified in Phase 0; CI re-checks on every release matrix run.                            |
| Backend process leaks after Tauri crash                                    | Parent-PID poll + Windows Job Object + 5 s SIGTERM grace.                                        |
| macOS Gatekeeper rejection of unsigned builds                              | Signing wired into CI; pre-release builds clearly marked "unsigned" in the GitHub release notes. |
| Tauri auto-update private key compromise                                   | Re-key script (`scripts/generate_updater_keys.sh`) regenerates pair; old installs require manual re-download. |
| Concurrent Tauri+CLI desktop runs on the same machine                      | Dynamic ephemeral ports; XDG state dirs are user-global so DB writes are serialised by SQLite WAL. |
| Frontend/backend drift between desktop and server                          | FastAPI is API-only; Tauri packages `web/dist` via `frontendDist` and injects the active API base URL before React boots. |
