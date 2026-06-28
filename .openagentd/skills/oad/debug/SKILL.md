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

Load the surface-specific reference for deeper commands, file maps, and gotchas:

- **Backend / API / agent / provider** → `oad/debug/reference/backend`
- **Frontend (web UI)** → `oad/debug/reference/frontend`
- **Desktop or mobile (Tauri / Rust)** → `oad/debug/reference/tauri`

When the issue spans multiple surfaces, load all relevant references.

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

- Make the smallest change that addresses the proven root cause.
- Add or update focused regression coverage at the closest layer.
- Update related docs only when behavior, API contract, or operator workflow changed.

---

## 6. Verify and report

- Re-run the reproduction and focused tests / checks for the touched areas.
- If feasible, run the repository's standard lint / type / test commands for the changed surface.
- Report: root cause, changed files, checks run with results, and any remaining risk or unverified area.
