---
title: Mobile app
description: Tauri mobile shell for connecting to remote OpenAgentd API servers.
status: draft
updated: 2026-07-09
---

# Mobile app

The mobile app is a Tauri shell that embeds the shared React Web UI and connects to a remote OpenAgentd API server. It is remote-backend-only: it does not bundle, start, or supervise the Python/FastAPI backend.

Use it as a companion client for an OpenAgentd server already running on your laptop, desktop, homelab, or another reachable machine. The mobile app shares the same sessions, tools, team model, and UI vocabulary as desktop, but adapts the experience for touch, safe areas, portrait-first navigation, and remote backend connection.

## Backend connection

Typical flow:

1. Start the server on your host machine with `openagentd start --lan --key`.
2. Note the LAN/mobile URL from the command output or later via `openagentd address`.
3. Open the mobile app, paste that server URL into **Backend connection**, then use **Check** and **Save**.
4. Reuse the saved server entry for future launches.


Mobile uses the shared **Backend connection** UI:

- **Check** probes `<server>/api/health/live` and uses that server for the current WebView session.
- **Save** persists or renames a server for future use.
- Saved servers can be removed and show live status indicators.
- Access keys are scoped by normalized server origin and stored in the iOS Keychain. Legacy per-origin localStorage is removed only after a successful Keychain write; native-store failures are shown instead of silently downgrading storage.
- The built-in desktop sidecar row is hidden because mobile has no bundled backend.
- Shared web UI mobile affordances include safe-area-aware fullscreen MCP apps, keyboard-avoiding composer padding, pull-to-refresh for recent sessions, and touch gestures in the image lightbox. Native iOS and Web UI are locked to portrait-only orientation to ensure optimal single-pane readability and avoid cramped horizontal layouts. See [`web/mobile.md`](./web/mobile.md) for responsive layout details.

For simulator development, `http://localhost:8000` usually reaches the Mac backend. Physical devices should use a LAN IP or HTTPS endpoint. The app keeps a lightweight global SSE feed for scheduled-session activation, title changes, and notifications in addition to the currently open chat stream. Both connections back off while offline. Whenever the global feed connects or reconnects, including foreground resume, the app reloads the current session from REST and reattaches its chat stream when the server reports it running. Global events are live-only, so this reconciliation is the recovery path after iOS suspends networking. It does not guarantee notification delivery while the app is terminated; that would require a separate APNs/FCM feature. Mobile does not initialize the desktop updater; releases are delivered through the platform distribution channel.

Production mobile builds allow `about:` in `frame-src` so sandboxed MCP Apps rendered through `iframe.srcdoc` stay interactive under the packaged Tauri CSP. The app HTML still receives its own MCP resource CSP from `_meta.ui.csp`; the shell-level rule only permits the `about:srcdoc` iframe document.

Production mobile builds also set `dangerousDisableAssetCspModification: ["script-src", "style-src"]` — Tauri's build-time hash/nonce injection would otherwise make browsers ignore `'unsafe-inline'`, blocking the inline scripts inside `srcdoc` MCP Apps (blank canvas in packaged builds, working in dev). The per-resource CSP `<meta>` from `_meta.ui.csp` and the iframe `sandbox` attribute still constrain the embedded app.

## Commands

```bash
cd mobile
make dev                    # Tauri shell against Vite :5173
make ios-init               # generate iOS project files
make ios-dev                # run on simulator/device with --host
make ios-dev-device <device-name> # run on a named physical iOS device
make ios-install-device <device-name> # archive/install production app with bundled Web UI
make ios-icons-force        # force-regenerate generated iOS AppIcon assets
make ios-clean              # remove generated iOS/Xcode state
make ios-build              # build iOS app
```

Run a backend separately, for example:

```bash
make run
```

Physical iPhone development needs LAN-reachable dev servers:

```bash
cd web && bun dev --host 0.0.0.0
uv run uvicorn app.server:app --host 0.0.0.0 --port 8000
```

Use `ios-install-device` for production device checks. It builds `web/dist`, archives the iOS app, and installs the signed app bundle directly instead of exporting an IPA or using Vite `devUrl`. Generated AppIcon assets are reused across builds unless missing, stale, or force-regenerated with `ios-icons-force`.

Before release, smoke-test a physical device against a keyed remote server: save and reconnect after relaunch, background and foreground an active stream through a brief network interruption, open a long PDF and scroll beyond page 2, confirm no desktop updater prompt appears, then delete the saved server/key. These native Keychain, WebView lifecycle, and distribution-channel behaviors cannot be fully proven by host unit tests.

If iOS blocks the first launch, trust the developer profile on the phone in **Settings → General → VPN & Device Management**.

Generated iOS projects are local artifacts. If signing, bundle identifiers, or Xcode settings become stale, put your Apple team ID in ignored `mobile/ios-team.txt`, then run `make ios-clean && make ios-init`. Local developer builds may temporarily use a unique identifier in `mobile/src-tauri/tauri.conf.json`; the source default is `com.openagentd.mobile`.
