---
name: oad/review
description: OpenAgentd five-axis code review — correctness, readability, architecture, security, performance — with evidence for every finding. Use before merging, before opening a PR, or when asked to review a diff.
---

Review the diff (staged, branch vs `main`, or a named PR). Every finding cites a
file and line; a verdict without evidence is not a review.

## 1. Scope

```bash
git status --short
git diff --stat origin/main...HEAD    # or: git diff --cached --stat, or gh pr diff <n>
```

If the diff mixes unrelated concerns or runs past ~300 lines of mixed refactor and
behavior change, say so and suggest a split before reviewing line by line.

## 2. Tests first

Tests show intent. For each behavior change: is there a test, does it assert
behavior rather than internals, and would it fail without the change?

- Rust: `#[cfg(test)]` modules beside the change and `appv3/crates/<crate>/tests/`.
- Web: `web/src/__tests__/` at the mirrored path (`components/Foo.tsx` → `__tests__/components/Foo.test.tsx`).
- Scripts and workflows: `scripts/tests/`.

Missing tests for non-trivial behavior is a required finding; point at `oad/testing`.

## 3. The five axes

**Correctness** — Does it do what was asked? Empty, null, boundary, and error
paths? State that can drift between the web stores, SSE stream, and DB? Data as it
really arrives (CRLF from multipart forms, rows written by v2 installs)?

**Readability** — Names and patterns match the nearest `AGENTS.md`? Dead code,
leftover shims, unused imports, comments that restate the code?

**Architecture** — Route handlers stay thin (behavior in the owning crate)?
TanStack Query for server state, Zustand for client state? Platform-specific
behavior gated through the platform hooks? No second helper where a canonical one
exists (`safe_resolve` / `safe_join`, `validate_workspace`, `focusQuietly`, `utils/file-refs`)?

**Security** — Treat as sensitive: auth and the desktop token, the Host/Origin
network guard, workspace paths from external or model input, shell and file tools,
MCP launch config, Tauri CSP and capabilities, keyring, updater signing. Secrets
compare in constant time (`auth::constant_time_eq`); subprocesses take argument
lists. When the diff touches any of these, run the `security-review` skill if it is available.

**Performance** — N+1 or unbounded DB queries, loops over whole session history,
missing pagination, large SSE payloads, React re-renders from unselected store
reads or inline object props, work on every streamed token.

**Contracts** — An SSE or wire change matches `appv3/contract/sse_events.json`,
updates the web client in the same change, and is recorded in `appv3/REPORT.md`.
Release versions move only through `scripts/bump_version.sh`.

## 4. Classify findings

| Prefix | Meaning |
|---|---|
| **Critical:** | security hole, data loss, broken behavior; blocks merge |
| *(none)* | required before merge |
| **Consider:** | worth doing, author's call |
| **Nit:** | style; may be ignored |
| **FYI** | context, no action |

Lead with correctness and security, then architecture, then the rest.

## 5. Check the verification story

- Which gates ran: `make verify-v3`, `make verify-web`, `make verify-docs`, native targets (`oad/testing`)?
- UI changes: checked at a narrow (≤768 px) and a wide viewport, touch and pointer, against `DESIGN.md`?
- User-visible change: entry in `documents/docs/features.md`?

## 6. Output

```markdown
## Review: <scope>

### Critical
### Required
### Consider / Nit / FYI
### Done well
### Verdict: Approve | Request changes
```

Approve when the change improves the code base overall, even if imperfect; do not
block on taste when it follows project convention.
