# Worktree list

A repository's worktrees in the sidebar are the ones that exist: git and the
disk decide, not old records.

## Sub-features

- A worktree removed outside the app (`git worktree remove`, deleting the
  folder) drops off the repository's checkout menu on the next load.
- Its sessions stay listed under the repository.
- A worktree made with plain git is listed, marked external.

## How to get to it (user POV)

- **Desktop:** the chip on the demo row ("N worktrees") opens the checkout
  menu (`menu` "Worktrees for demo").
- **Phone:** the same chip opens a sheet (`dialog` "Worktrees for demo") whose
  rows say "External worktree · N sessions" under the name.

## Driving it with Playwright

- Worktrees are made through `POST /agent/workspace/worktrees` and plain
  `git worktree add`, and one is removed with `git worktree remove`, all as
  preconditions; the journey then only looks.
- Names carry `ctx.run`, so worktrees left by an earlier width or run cannot
  satisfy a check.

## Gotchas

- The sandbox keeps every worktree a run makes until the next `up`.
- The chip's name lists folders too ("1 worktree · 1 folder"); match its start.
