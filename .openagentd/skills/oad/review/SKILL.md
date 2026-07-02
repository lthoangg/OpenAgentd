---
name: oad/review
description: OpenAgentd five-axis code review workflow — correctness, readability, architecture, security, performance. Use before merging any change, before opening a PR, or when asked to review a diff.
---

Review the diff (staged, branch-vs-main, or a named PR) across five axes. Don't rubber-stamp — every review must show evidence, not just a verdict.

## 1. Establish scope

```bash
git status --short
git diff --stat origin/main...HEAD   # or: git diff --stat --cached
```

If the diff is large (~300+ changed lines across unrelated concerns), say so and suggest splitting before reviewing line-by-line — reviewing a mixed refactor+feature diff hides real issues.

## 2. Read tests first

Tests reveal intent and coverage before you look at implementation.

- Do tests exist for the behavior change?
- Do they test behavior, not implementation details?
- Would they fail without the fix/feature and pass with it?
- Backend: check under `tests/` (mirrors `app/`) and whether `tests/manual/*` scenario scripts need re-running per `AGENTS.md`.
- Frontend: check colocated `*.test.tsx` under `web/src/`.

If tests are missing for non-trivial behavior, flag it as a **Required** finding and point at `oad/test-driven-development` as the fix path.

## 3. Review the five axes

**Correctness** — Does it match the task/spec? Edge cases (null, empty, boundary)? Error paths handled, not just happy path? Any state inconsistency across the team/session/mailbox model?

**Readability** — Names clear and consistent with the nearest `AGENTS.md` conventions? Control flow straightforward? Any dead code, backwards-compat shims, or unused imports left behind?

**Architecture** — Follows existing patterns in the touched module (check the nearest `AGENTS.md` "where to look first" map)? No feature-specific logic leaking into a shared hook/service? No duplicate helper when a canonical one exists (e.g. `_safe_join*` for path containment)?

**Security** — If the diff touches auth, file paths from external/model input, shell/subprocess execution, or MCP config: load `security-review` and run its full checklist before proceeding. Otherwise skip this axis (the other skills handle security-sensitive paths).

**Performance** — Any N+1 DB queries (SQLModel/SQLAlchemy), unbounded loops over session history, missing pagination, unnecessary React re-renders (missing Zustand selector, inline object props), heavy compute or SSE payloads?

## 4. Categorize findings

| Prefix | Meaning | Required? |
|---|---|---|
| **Critical:** | Security vuln, data loss, broken functionality | Blocks merge |
| *(no prefix)* | Required change | Must address before merge |
| **Optional:**/**Consider:** | Worth doing, not required | Author's call |
| **Nit:** | Style/formatting | Author may ignore |
| **FYI** | Informational | No action needed |

Lead with what matters — one structural/correctness finding beats ten nits. Order: correctness/security first, then architecture, then everything else.

## 5. Verify the verification story

- What test commands were run? (see `oad/testing` for the canonical commands per surface)
- Did lint/type-check pass? (see `Makefile` targets via `make help`)
- For UI changes: verified at both ≤768px and a wide viewport (mobile-first requirement in `AGENTS.md`)?
- For a PR: once review passes, push the branch and open the PR (`gh pr create` or equivalent).

## 6. Output

```markdown
## Review: <scope>

### Critical
- ...

### Required
- ...

### Optional / Nit / FYI
- ...

### What's done well
- ...

### Verdict
Approve | Request changes
```

Approve when the change definitely improves overall code health, even if imperfect — don't block on personal style preference if it follows project convention.
