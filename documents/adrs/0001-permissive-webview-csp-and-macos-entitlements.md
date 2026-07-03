# ADR-0001: Permissive webview CSP and broad macOS entitlements in the Tauri shells

## Status
Accepted

## Date
2026-07-03

## Context

A code review of the desktop and mobile Tauri shells flagged two security-posture
items that look alarming without context:

1. **The webview CSP is close to disabled.** Both
   `desktop/src-tauri/tauri.conf.json` and `mobile/src-tauri/tauri.conf.json`
   ship `script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: data: http: https:`
   (plus similarly broad `style-src`, `connect-src`, `frame-src`) and set
   `dangerousDisableAssetCspModification` for `script-src`/`style-src` so Tauri
   does not rewrite them with hashes.
2. **The macOS entitlements are broad.** `desktop/src-tauri/entitlements.plist`
   grants `allow-jit`, `allow-unsigned-executable-memory`,
   `disable-library-validation`, and network client+server.

These are deliberate consequences of three product constraints:

- **The shell must connect to arbitrary user-chosen backends.** The mobile app
  is a thin client for a remote OpenAgentd API server on the user's LAN or a
  personal HTTPS host; the desktop app supports external servers alongside the
  bundled sidecar. `connect-src`/`default-src` therefore cannot be pinned to a
  fixed origin — the origin is user configuration, entered at runtime.
- **MCP apps render model/tool-supplied HTML in sandboxed iframes.**
  `web/src/components/MCPAppResult.tsx` renders MCP app resources (inline HTML
  documents with their own scripts) inside `<iframe sandbox="allow-scripts
  allow-same-origin allow-forms">`. The outer document's CSP is inherited into
  `blob:`/`srcdoc` frames, so a strict outer `script-src` breaks every MCP app
  (see commit `973ae707` "fix: allow MCP app resources in production Tauri
  CSP"). The per-iframe `sandbox` attribute plus a per-app `frame-src` built in
  `MCPAppResult.tsx:104` is the actual isolation boundary for that content.
- **The bundled Python sidecar requires the entitlements.** The desktop app
  ships a relocatable CPython (python-build-standalone) plus native-extension
  wheels signed by neither our Team ID nor Apple. Under the hardened runtime,
  the sidecar cannot start without `disable-library-validation` (loads
  third-party `.so`/`.dylib` extensions) and `allow-unsigned-executable-memory`
  / `allow-jit` (CPython + ctypes/ffi). Network client+server is the product:
  the sidecar binds 127.0.0.1 and the webview connects to it.

Given the weak CSP, the real XSS defenses in the web UI are the code-level
invariants, which are documented and tested:

- All markdown from models renders through `react-markdown` (no raw HTML pass-through).
- The only `dangerouslySetInnerHTML` sites (`CodingFileViewerPanel.tsx`,
  `ToolCall/index.tsx`) render highlight.js output, which HTML-entity-escapes
  its input.
- Desktop auth tokens are attached only to same-origin `/api/*` requests
  (`web/src/api/auth.ts`), so an injected script cannot exfiltrate the token
  via a cross-origin fetch that we sign.
- Tauri IPC is gated by the capability files, not the CSP; commands are a
  small allowlisted set.

## Decision

Keep the permissive CSP and broad macOS entitlements, and treat the following
as the recorded trust model:

1. The webview CSP is **not** an XSS boundary in OpenAgentd. The XSS boundary
   is (a) `react-markdown` for model output, (b) highlight.js escaping for the
   two `dangerouslySetInnerHTML` sites, and (c) iframe `sandbox` attributes for
   MCP app content. Changes to any of these require the `security-review`
   skill and regression tests.
2. The Tauri capability files (`capabilities/default.json`) and the
   same-origin token-injection rule in `web/src/api/auth.ts` are the boundary
   for IPC and credentials respectively.
3. The macOS entitlements exist solely for the bundled CPython sidecar and
   must not grow beyond what the sidecar needs.

## Alternatives Considered

### Strict CSP with per-build hashes/nonces
- Pros: real defense-in-depth against XSS in the webview.
- Cons: breaks MCP app iframes (inherited CSP), breaks connecting to
  user-configured backends (`connect-src` unknowable at build time), and Vite
  runtime chunks + `tw-animate-css` inline styles need `unsafe-inline` unless
  the whole asset pipeline moves to nonce injection.
- Rejected because: it disables two shipped features (MCP apps, external
  servers) to harden a boundary that other controls already cover.

### Split CSP: strict outer document, permissive only inside MCP iframes
- Pros: narrows `unsafe-eval`/`unsafe-inline` to the frames that need them.
- Cons: CSP inheritance for `blob:`/`srcdoc` frames comes *from the embedding
  document* — there is no per-iframe CSP loosening mechanism; a strict outer
  policy is inherited by exactly the frames that need it loose.
- Rejected because: not technically possible with today's CSP inheritance rules.

### Hardened-runtime without `disable-library-validation` (sign every dylib)
- Pros: restores library validation.
- Cons: requires re-signing the entire python-build-standalone tree and every
  wheel's native extensions with our Team ID on each sidecar build; fragile
  across dependency updates, and `allow-jit`/`allow-unsigned-executable-memory`
  are still required for CPython itself.
- Rejected because: high recurring release cost for a partial win; may be
  revisited if notarization requirements tighten.

## Consequences

- MCP apps, arbitrary external backends, and the bundled sidecar keep working
  on all platforms.
- The webview has no CSP backstop, so the code-level XSS invariants above are
  load-bearing. New `dangerouslySetInnerHTML` usage, raw-HTML markdown
  plugins, or changes to iframe sandboxing must be treated as
  security-sensitive changes (load `security-review`).
- Anyone re-auditing the shells should read this ADR before flagging the CSP
  or entitlements again.
- Follow-up (optional): drop `http: https:` from desktop `script-src` if a
  future test pass confirms MCP apps and the updater flow don't need remote
  script origins — the iframes mainly rely on `blob:`/`unsafe-inline`.
