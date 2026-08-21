# Mobile Shell Guide

This subtree is the Tauri mobile shell. It embeds the shared `web/dist` UI and
connects to an existing OpenAgentd API; it never starts or bundles Python.

## Development and builds

From `mobile/`:

```bash
make dev                         # shell against Vite :5173
make ios-init                    # generate the local Xcode project
make ios-dev                     # simulator/device development
make ios-dev-device <name>       # named physical device
make ios-build                   # production iOS build
make build                       # generic Tauri bundle
```

`make ios-init` and physical-device targets require local Apple tooling and
signing. Put the Apple team ID only in ignored `mobile/ios-team.txt`; never add
signing credentials to tracked files. Use `make ios-install-device-fast
<name>` for a debug archive or `make ios-install-device <name>` for a
production archive/install.

`make ios-web` owns the frozen Bun install and shared web build used by native
packaging. Frontend changes still follow `web/AGENTS.md` and require web
validation.

## Constraints

- Keep remote-server connection behavior distinct from desktop's bundled
  sidecar flow.
- Treat remote-origin validation, access-key storage, Tauri capabilities/CSP,
  deep links, and iOS plist/privacy changes as security-sensitive.
- `src-tauri/gen/`, `src-tauri/target/`, generated icon variants, and
  `ios-team.txt` are local/generated state. Regenerate them with
  Make targets instead of editing or committing them.
- `src-tauri/icons/icon.png` is the source icon; use `make ios-icons` or
  `make ios-icons-force` for generated variants.

## Checks

```bash
make verify-mobile  # from repository root; locked cargo check used by CI
```

iOS builds and device behavior are not covered by CI. Run the smallest
relevant simulator/device flow for native iOS changes and report when the
required Apple tooling is unavailable.
