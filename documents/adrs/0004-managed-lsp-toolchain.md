# ADR-0004: Manage language-server toolchains on demand

## Status
Accepted

## Date
2026-07-14

## Context
OpenAgentd injects LSP diagnostics after coding-mode file edits, but the
integration currently works only when a compatible language-server executable
is already visible on the backend process's `PATH`. This is unreliable for the
desktop sidecar, headless CLI services, and remote backends, even though those
surfaces run the same agent code.

Python support can ship with OpenAgentd because `ty` and `ruff` are distributed
for the same platforms as the Python runtime. TypeScript support additionally
needs a JavaScript runtime, `typescript-language-server`, and TypeScript itself.
Bundling that second runtime into every base installation would penalise users
who never edit TypeScript. Downloading and executing it without consent would
also cross a supply-chain boundary invisibly.

## Decision
OpenAgentd will use one backend-owned managed LSP toolchain for CLI and desktop.
Pinned `ty` and `ruff` executables ship with the Python runtime. TypeScript
support is a separately consented, on-demand component containing a pinned Bun
runtime, `typescript-language-server`, and a fallback TypeScript version under
`{OPENAGENTD_CACHE_DIR}/lsp/`.

When a TypeScript file first needs diagnostics and no usable server exists, the
backend reports that the component is required. Connected app clients may ask
the user to install it; headless users can install it explicitly through the
CLI. Downloads are disabled when `OPENAGENTD_DISABLE_LSP_DOWNLOAD=true`.

Provisioning must:

- use fixed versions and verify the Bun archive against a release-pinned SHA-256;
- extract only validated relative archive members into the managed cache;
- invoke subprocesses with argument lists and no shell interpolation;
- install npm packages with lifecycle scripts disabled and exact versions;
- serialize concurrent installs and publish inspectable installation state;
- prefer project configuration and explicit runtime settings before managed
  defaults, while retaining user `PATH` discovery as a fallback;
- prefer a project's own TypeScript package and use the managed TypeScript copy
  only when the project does not provide one; and
- keep the managed cache regeneratable and removable without affecting user
  projects or OpenAgentd's database.

Language servers still start lazily per project and remain subject to the
existing idle-process reaper. Mobile and browser clients never run LSP locally;
the component belongs to the backend that owns the workspace.

## Alternatives Considered

### Require user-installed language servers
- Pros: smallest distribution and no download subsystem.
- Cons: repeats the current `PATH` failure, particularly for desktop and service
  users, and makes a documented coding feature environment-dependent.
- Rejected because: it does not provide a dependable cross-surface experience.

### Bundle every runtime and server in the base application
- Pros: fully offline diagnostics immediately after installation.
- Cons: materially increases every desktop and CLI installation, expands the
  patching surface, and ships a JavaScript runtime to users who may never need
  it.
- Rejected because: the cost is unconditional while TypeScript usage is not.

### Silently download latest language servers on first use
- Pros: minimal initial package and no permission UI.
- Cons: non-reproducible behavior, invisible network and execution side effects,
  and greater exposure to upstream supply-chain changes.
- Rejected because: managed executable downloads require consent and release-
  pinned verification.

### Use project package managers only
- Pros: respects project lockfiles and avoids a global tool cache.
- Cons: mutates projects, fails for read-only workspaces, and requires package
  managers that the desktop sidecar does not ship.
- Rejected because: diagnostics must not modify the user's project.

## Consequences
- Python diagnostics become available out of the box on supported packaged
  platforms.
- TypeScript diagnostics require one explicit component installation and work
  offline afterward.
- CLI, desktop, browser, and mobile connections observe the same backend LSP
  availability.
- Releases must maintain pinned tool versions and Bun archive checksums.
- The backend gains a security-sensitive downloader, archive extractor, and
  installer that require focused tests and security review.
- The desktop UI and CLI must expose missing, installing, ready, and failed
  states instead of silently omitting diagnostics.
