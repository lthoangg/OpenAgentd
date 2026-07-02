---
description: Sanity-check staged changes for debug/temp code, then commit with a conventional message.
---

Before committing anything:

1. Run `git status --porcelain` and `git diff --cached` to see exactly what is staged.
2. Scan the staged diff for any of the following — if found, stop and report what you found and where, do not commit:
   - TODO / FIXME / HACK markers
   - Commented-out blocks of code
   - Debug flags left enabled (`DEBUG=True`, `console.log` used for debugging, stray `print()` calls)
   - Hardcoded test data, mocked responses, or rigged logic
   - Clearly temporary code ("temp", "wip", "placeholder", "try this")
3. If the diff is clean, proceed with the full commit workflow: sync docs if needed, write a conventional commit message (type: subject, then Motivation / Technical Changes / Impact body), and commit.

$ARGUMENTS
