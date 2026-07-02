---
name: oad/test-driven-development
description: >
  OpenAgentd TDD workflow — write a failing test before the code that makes
  it pass, reproduce a bug with a test before fixing it. Use when
  implementing any logic, fixing any bug, or changing any existing
  behavior in backend (pytest) or frontend (Bun/RTL) code.
---

Write the test first. It must fail for the right reason before you write the
code that makes it pass. Tests are proof — "seems right" is not done.

**When NOT to use:** pure config, docs, or static content changes with no behavioral impact.

**Environment specifics** (run commands, placement, fixtures, mock rules) live in `oad/testing` — load it now.

---

## 1. RED — write a failing test

Before touching implementation code, write the test and confirm it fails for the *expected* reason, not a typo or import error.

Run it:

```bash
# backend — single test
uv run pytest --no-cov tests/path/to/test_file.py::test_new_behavior -q

# frontend — single file
cd web && bun test src/__tests__/components/Foo.test.tsx
```

## 2. GREEN — minimal implementation

Write the smallest change that makes the test pass. Don't add branches, config, or abstraction the test doesn't require yet.

## 3. REFACTOR — clean up

With the test green, improve naming/structure without changing behavior. Re-run after every refactor step.

```bash
uv run pytest -n auto --no-cov -q
cd web && bun test --parallel
```

---

## The Prove-It Pattern (bug fixes)

Do not start a bug fix by editing implementation. Start by writing a test that reproduces the bug:

```
Bug report → write a failing test → confirm it FAILS for the right reason
  → implement the fix → confirm it PASSES → run the full suite (no regressions)
```

Once the reproduction test is green after the fix, hand off to `oad/debug` step 6 (verify and report) if this was part of a debug session, or to `oad/commit` to ship the fix.

---

## Verification checklist

- [ ] New behavior has a test at the mirrored path (see `oad/testing` for placement rules)
- [ ] Bug fixes have a reproduction test that failed before the fix
- [ ] `uv run pytest -n auto --no-cov -q` passes (backend changes)
- [ ] `cd web && bun test --parallel` passes (frontend changes)
- [ ] Relevant `tests/manual/*.py` scenario script re-run if the touched subsystem has one (see `oad/testing`)
- [ ] No tests skipped/disabled to make the suite pass
- [ ] Ready to commit → load `oad/commit`
