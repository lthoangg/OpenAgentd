# Desktop Shell Guide

The Tauri desktop shell embeds the shared web UI, can supervise a bundled
native `agentd` backend sidecar (built from `appv3/`) or use a saved
external server, and owns native packaging,
updates, tray/window behavior, and desktop credentials.

## Development and packaging

Run the desktop Makefile from the repository root as shown below:

```bash
make -C desktop sidecar       # build appv3 (fat-LTO `dist`) into sidecar-bundle/
make -C desktop sidecar PROFILE=release  # quicker local build
make -C desktop dev           # Tauri dev shell; Vite :5173 must be running
make -C desktop dev-bundled   # regenerate/use bundled sidecar explicitly
make -C desktop build         # release desktop bundle
make -C desktop icons         # app + tray icons from documents/assets/brand/ masters
```

For frontend HMR, run `cd web && bun dev` separately. Root `make dev` is also
valid when both the standalone API and Vite are wanted, but the desktop shell
uses its configured bundled/saved-server connection model rather than an
implicit standalone backend.

`desktop/Makefile`, Tauri configs, packaging scripts, and release workflows
are authoritative for bundle matrix, signing, notarization, and update
artifacts.

## Ownership and constraints

- `src-tauri/` owns Rust commands, sidecar/process lifecycle, auth handshakes,
  window/tray/menu behavior, persisted server selection, access-key files, and
  updater behavior.
- The sidecar bundle is API-only; the UI comes from `web/dist`.
- Keep every dev/production Tauri config variant aligned when changing shared
  bundle, plugin, window, or permission behavior.
- Treat sidecar spawning/token exchange, stored access keys, CSP/capabilities,
  entitlements, updater endpoints/signatures, and release scripts as
  security-sensitive.
- Preserve macOS, Windows, and Linux process lifecycle differences. Do not
  collapse platform-specific updater restart or sidecar cleanup branches.
- `sidecar-bundle/` and `src-tauri/target/` are generated and ignored. Change
  source/config, then rebuild; do not patch bundled copies.

## Checks

```bash
make verify-desktop
```

This target matches CI's locked Cargo check, test, and clippy configuration;
native system libraries may be required.
