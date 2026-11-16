# Session sidebar

Find a session again: by its workspace, or by searching for words in it.

## Sub-features

- Workspaces as expandable groups, each listing its sessions by title.
- Opening a session from the list.
- Session search and its results.
- A session's menu: rename, and the name the server keeps.
- A workspace's menu: Create worktree… opens its dialog.

## How to get to it (user POV)

- **Desktop:** the sidebar is always on the left. "Expand workspace demo"
  shows its sessions. "Search sessions" opens the search box in the sidebar.
- **Phone:** the Sessions list is the home screen. From a chat, "Back to
  Sessions" returns to it. The search button is named "Search".

## Driving it with Playwright

- The list is the first `complementary` landmark at both widths.
- A session row is a button named exactly by its title; a search result's
  name starts with the title.
- Results are in the region "Search results".
- Two sessions are seeded through the API (`ctx.seedSession`), titled after
  their prompts.
- A row's menu: on desktop, hover the row and press "More actions for
  <title>" or "Actions for demo" (a `menu`). On a phone, `ctx.hold(row)`
  presses and holds for 0.7 s, which opens a sheet (a `dialog`) with the same
  actions as buttons.
- Rename edits in place, in the textbox "Session title"; Enter saves.

## Gotchas

- A workspace group may already be expanded; its button then reads "Collapse
  workspace demo". The journey waits for either.
- Session rows deliberately take no row keys; pinning and deleting are
  behind the same menu as renaming and are not driven.
- On a phone a reload collapses the workspace group again; expand it before
  looking for a row.
- The Create worktree dialog is opened and left; no worktree is created.
