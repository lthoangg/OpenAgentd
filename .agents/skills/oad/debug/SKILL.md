---
name: oad/debug
description: OpenAgentd debugging workflow — triage, reproduce, and fix bugs across the Rust backend, web UI, and Tauri shells, and analyze logs and OTEL telemetry from dev or production installs. Use for bugs, regressions, session problems, slow or failing tools, and runtime issues.
---

Find the boundary that failed, prove it with a test, fix it there.

## 1. Triage

Extract the symptom, expected behavior, reproduction steps, affected surface
(backend, web, desktop, mobile, provider, tool), session id, workspace, model,
and timing. Inspect available evidence before asking; ask only when a missing
decision blocks progress.

## 2. Route to a reference

The skill directory is given when this skill loads; read what applies:

| Surface | Reference |
|---|---|
| API, persistence, SSE, agent loop, tools, providers (`appv3/`) | `references/backend.md` |
| Web UI (`web/`) | `references/frontend.md` |
| Desktop or mobile shell, sidecar, IPC, CSP | `references/tauri.md` |
| Logs, OTEL spans, tool usage, production installs | `references/production.md` |

## 3. Reproduce narrowly

- Recreate the smallest scenario, matching the user's mode, workspace, model, and message order.
- Capture durable evidence: HTTP response, persisted rows, SSE frames, log
  records, a failing test, or a UI snapshot.
- Dev state lives in `.openagentd/dev/` (`data/openagentd.db`, `state/logs`,
  `state/otel`); a production install uses `~/.local/share/openagentd` and
  `~/.local/state/openagentd`.

## 4. Diagnose

- Name the failing boundary: route validation, persistence, queueing, stream
  emission, agent loop, hook, tool, provider, web store, renderer, or native process.
- Check how the data looks on the wire and on disk, not only in memory (for
  example, multipart form fields arrive with CRLF line breaks).
- Search for the existing pattern before inventing a new one. Preserve unrelated work.

## 5. Fix with a test first

Load `oad/testing` and follow Prove-It: a failing reproduction test, the smallest
root-cause fix, then the surface's full gate. Do not edit the implementation before
the reproduction test exists.

## 6. Report

Root cause, changed files, checks run with results, and anything left unverified.
Load `oad/commit` to ship it.
