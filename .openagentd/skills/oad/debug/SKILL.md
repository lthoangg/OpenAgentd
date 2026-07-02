---
name: oad/debug
description: OpenAgentd workflow for investigating bugs, regressions, sessions, and runtime issues.
---

Debug the reported issue across any surface of the OpenAgentd stack.

## 1. Triage the report

Extract: symptom, expected behavior, reproduction steps, **affected surface** (backend / frontend / desktop / mobile / agent / provider), session id, workspace, model, logs, and timing clues.

If the report is ambiguous, inspect available evidence first; ask only when a missing decision blocks safe progress.

---

## 2. Route to the right reference

Read the surface-specific reference for deeper commands, file maps, and gotchas.
The skill directory is in the first line of this response — use it to build the path:

- **Backend / API / agent / provider** → `read("<skill_dir>/reference/backend.md")`
- **Frontend (web UI)** → `read("<skill_dir>/reference/frontend.md")`
- **Desktop or mobile (Tauri / Rust)** → `read("<skill_dir>/reference/tauri.md")`

When the issue spans multiple surfaces, read all relevant references.

---

## 3. Reproduce narrowly

- Recreate the smallest scenario that demonstrates the bug.
- Match the user's mode / workspace / model / message sequence when relevant.
- Capture durable evidence: raw HTTP response, persisted history, SSE events, logs, failing test output, or UI state snapshot.

---

## 4. Diagnose from code and evidence

- Search for existing patterns before editing.
- Identify the boundary that failed: route validation, persistence, queueing, stream emission, agent loop, hook, tool, provider, frontend store, renderer, or Rust process.
- Preserve unrelated work; do not reset or overwrite changes you did not make.

---

## 5. Fix surgically

Load `oad/test-driven-development` and follow the Prove-It pattern:

1. Write a failing test that reproduces the bug — confirm it fails for the right reason.
2. Make the smallest change that addresses the proven root cause.
3. Confirm the test passes; run the full suite for no regressions.

Do not edit the implementation before the reproduction test exists.

---

## 6. Verify and report

- Re-run the reproduction test and focused checks for the touched areas.
- If feasible, run the repository's standard lint / type / test commands for the changed surface (see `oad/testing` for commands).
- Report: root cause, changed files, checks run with results, and any remaining risk or unverified area.
- Load `oad/commit` to ship the fix.
