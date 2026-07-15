---
name: oad/plan
description: Research first, propose a step-by-step implementation plan, and wait for explicit approval before writing any code.
---

# oad/plan — Research-Then-Approve Workflow

Plan (do not write or edit any code yet).

## 1. Restate the request

In 2-4 sentences, restate what is being asked in your own words — the
observable outcome, not implementation detail. If the request is ambiguous
on a decision that would change the plan's shape, ask ONE targeted question
before researching; otherwise proceed on your best-supported reading.

## 2. Research (read-only)

Explore before proposing anything. Do not create, edit, or patch any file
in this phase — `read`, `grep`, `glob`, and `shell` (read-only commands
like `git log`, `git diff`, test runs for baseline) only.

- Check the nearest `AGENTS.md` files for this area's conventions and
  "where to look first" maps before searching blind.
- Find existing patterns to follow (similar feature, similar hook/route/
  component) — prefer extending an existing convention over inventing one.
- Identify every file that needs to change or be created.
- Identify risks: security-sensitive surfaces (auth, shell/subprocess,
  file paths from external input, MCP config), data/schema migrations,
  breaking API changes, cross-cutting refactors.
- Identify open decisions (library choice, data shape, API shape) — if one
  is expensive to reverse, flag it as an ADR candidate rather than quietly
  picking one.
- Note what test/verification path already exists for the touched area
  (unit tests, manual scenario scripts, lint/type-check commands).

## 3. Write the plan

Present it directly in the conversation — do not create a plan file unless
the user asked for one or the scope clearly spans multiple sessions.

```markdown
## Plan: <short title>

**Summary:** 2-3 sentences — what this implements and what it deliberately excludes.

**Files touched:**
- `path/to/file` — created | modified: <what changes>

**Steps:**
1. <name> — files: [...] — verify: <exact command or check>
2. <name> — files: [...] — verify: <exact command or check>
...

**Risks / open decisions:** <anything non-obvious, security-sensitive, or expensive to reverse>

**Out of scope:** <explicitly excluded so scope doesn't silently creep during implementation>
```

Rules for a good plan:

- **Steps are sequential and independently verifiable.** Each step names
  the exact files it touches and a concrete verification — a runnable test
  command or a precise manual check, never "make sure it works."
- **Small and testable beats comprehensive.** More than ~6-8 steps usually
  means the scope should be cut, not the steps made more granular — call
  that out instead of shipping a sprawling plan.
- **No implementation code in the plan itself.** Sketch shapes/signatures
  only if essential to convey the approach.
- **Match existing architecture.** No new pattern where the codebase
  already has one; no feature-specific logic leaking into shared/core code.

## 4. Stop and wait for approval

End the message with the plan and nothing else. Do not start implementing,
do not create/edit files, do not run `todo_manage` yet. Wait for the user
to respond with approval, a requested change, or a rejection.

- If they ask for changes, revise the plan and present it again — revising
  a plan is free; revising code after the fact is not.
- If they approve, move to step 5.

## 5. Track and implement (only after approval)

Break the approved steps into `todo_manage` tasks (one per step), then hand
off to the right skill for each step — don't re-implement their workflows
here:

- **Writing new behavior or fixing a bug** → load `oad/test-driven-development`
  (write a failing test first, then implement, then refactor).
- **Running or fixing existing tests** → load `oad/testing`.
- **Committing completed work** → load `oad/commit` (also syncs docs via `oad/docs`).

Cross-cutting rules that apply regardless of which skill runs:
- Implement only what the current step specifies.
- Run that step's verification before starting the next step. If it fails,
  stop and report — do not silently patch around it or skip ahead.
- Keep unrelated code untouched; don't opportunistically refactor outside
  the plan's stated scope.
- If a small, necessary implementation detail was not explicit in the plan but
  is required to complete the approved step safely (for example, repairing a
  newly orphaned reference or adjusting a validator that blocks the planned
  deletion), record an **Implementation note** in the final report: what was
  added, why it was necessary, and how it was verified.
- An implementation note does not authorize scope expansion. If the work
  changes user-visible behavior, architecture, security posture, data shape,
  or the plan's intended outcome, stop and ask for an updated plan instead.
- If something during implementation invalidates the plan (an assumption
  turns out false, a dependency doesn't work as research suggested), stop
  and report it rather than improvising a divergent approach.
