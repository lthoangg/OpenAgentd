---
description: Run repository verification checks covering modified files and summarize any failures.
---

Inspect changed files via `git status --short` and `git diff --stat HEAD` to determine which verification targets apply:

- Backend changes (`appv3/`): run `make verify-v3`
- Script, installer, or workflow changes (`scripts/`, `install.*`, `.github/workflows/`): run `make verify-scripts`
- Frontend changes (`web/`): run `make verify-web`
- Documentation changes (`documents/`, `README.md`, `*.md`): run `make verify-docs`
- Version files (`appv3/Cargo.toml`, `web/package.json`, Tauri configs): run `make verify-version`
- Shared native crate changes (`native/shell-core/`): run `make verify-shell-core`
- Desktop or mobile shell changes (`desktop/src-tauri/`, `mobile/src-tauri/`): run `make verify-desktop` or `make verify-mobile`
- Full portable checks: run `make verify`

Run the applicable checks, report their status, and provide concise fix instructions if any fail.

$ARGUMENTS
