# Session sidebar

Find a session again: by its workspace, or by searching for words in it.

## Sub-features

- Workspaces as expandable groups, each listing its sessions by title.
- Opening a session from the list.
- Session search and its results.

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

## Gotchas

- A workspace group may already be expanded; its button then reads "Collapse
  workspace demo". The journey waits for either.
- Session rows deliberately take no row keys; pinning, renaming and deleting
  are behind a context menu and are not driven.
