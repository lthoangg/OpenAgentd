# Failure, loading and confirm states

What a screen says when a request fails or is still loading, and the shared
confirm and action sheet (DESIGN.md → Rulebook 7, and DESIGN.md → Rulebook 10).

## Sub-features

- The new-session folder picker when the folder list fails: "Couldn't load
  folders." with Retry; Open folder… still works.
- Opening a workspace from the sidebar when its sessions cannot be read: a
  toast "Couldn't open the last session" with Retry, not a blank draft.
- Deleting a workspace group: the shared confirm, with Cancel.
- Phone: holding ✎ (New session) opens "New session in…" as an action sheet
  with a Cancel row.

## How to get to it (user POV)

- **Folder picker:** a new session (phone: ✎), the folder chip.
- **Workspace:** the workspace's row in the sidebar (phone: Sessions).
- **Groups:** Settings → Workspaces → New group, then the row's trash button.
- **✎ sheet (phone only):** press and hold ✎ on Sessions.

## Driving it with Playwright

- Failures are made with `page.route` answering 503 for
  `/agent/workspace/tree` and `/agent/sessions?…`; the route is removed
  before the next step.
- The confirm is "Delete <group>?" with "Cancel" and "Delete group".

## Gotchas

- A phone reopens on Sessions after a reload, so the draft's own "Couldn't
  load folders." is a desktop state; on a phone the Sessions list says
  "Couldn't load workspaces." with Retry. A phone also reopens the last
  session at `/`: the journey goes Back to Sessions first.
- The app retries a failed read a few times (about 7 s) before it says so.
- The loading skeletons (a text file in the gallery, a Read row's line
  count, the Usage session filter) are not driven: a text attachment comes
  with its text, so the gallery never waits, and the others last a moment.
  `FileLightbox.test.tsx` and `ToolCall/ReadView.test.tsx` cover them.

- The QR scanner (Scan QR code) needs the native camera, so it is not
  reachable in a browser; its focus and Escape are covered by
  `web/src/__tests__/components/phone/QrScanOverlay.test.tsx`.
- The LSP install line appears only when the server reports missing
  TypeScript tools; its status role is covered by `LspInstallPrompt.test.tsx`.
