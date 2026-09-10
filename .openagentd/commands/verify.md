---
description: Run repository verification checks covering modified files and summarize any failures.
---

Inspect changed files via `git status --short` and `git diff --stat HEAD` to determine which verification targets apply:

- Backend changes (`app/`, `tests/`): run `make verify-backend`
- Frontend changes (`web/`): run `make verify-web`
- Documentation changes (`documents/`, `README.md`, `*.md`): run `make verify-docs`
- Shared native crate changes (`native/shell-core/`): run `make verify-shell-core`
- Full portable checks: run `make verify`

Run the applicable checks, report their status, and provide concise fix instructions if any fail.

$ARGUMENTS
