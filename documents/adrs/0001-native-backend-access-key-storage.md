# ADR-0001: Native backend access-key storage

## Status
Accepted

## Date
2026-07-09

## Context
Remote OpenAgentd backends may require a user-provided bearer access key. The
web UI previously persisted each key in browser `localStorage`, which is not an
appropriate long-term location in installed desktop or iOS shells. The product
must keep browser and development-server use working without a native bridge.

## Decision
The Tauri desktop and iOS shells store access keys with `keyring` 3.6.3 under a
fixed service name and the normalized backend origin as the account. Keyring
uses Apple Keychain through its `apple-native` backend on macOS/iOS and the
persistent native Linux credential store through `linux-native-sync-persistent`.
The frontend uses async helpers: in a native shell it reads, writes, and deletes
through narrow Tauri commands; browsers and development servers retain the
existing per-origin localStorage behavior. An installed shell does not silently
downgrade to localStorage when its credential store is unavailable.

A legacy scoped localStorage key is migrated only after the native write
succeeds. Commands validate that their input is a canonical HTTP(S) origin,
never log the key, and return a key only from the explicit get command.

## Alternatives Considered

### Keep localStorage everywhere
- Pros: no Rust dependency or bridge commands.
- Cons: installed-shell credentials remain readable to webview script storage.
- Rejected because: it does not use platform credential protection where it is
  available.

### Store encrypted credentials in application configuration
- Pros: a single cross-platform file implementation.
- Cons: key-management, rotation, and OS protection would be our responsibility.
- Rejected because: OS credential stores already solve this problem more safely.

### Add OAuth token storage now
- Pros: one credential API for all tokens.
- Cons: changes OAuth lifecycle and scope beyond backend access keys.
- Rejected because: OAuth changes are deliberately excluded from this decision.

## Consequences
- Installed macOS, Linux, and iOS shells use their OS credential facilities for
  backend access keys.
- Browser/dev operation continues via localStorage, trading security for
  compatibility there. Native credential-store failures surface as recovery
  errors instead of persisting secrets in webview storage.
- Credential APIs are asynchronous; connection call sites must await them.
- Keyring adds native platform dependency resolution and Linux availability
  depends on the host secure-store service being usable.
