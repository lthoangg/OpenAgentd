# Failure, loading and confirm states

What a screen says when a request fails or is still loading, and the shared
confirm and action sheet (DESIGN.md → Rulebook 7, and DESIGN.md → Rulebook 10).

## Sub-features

- The new-session folder picker when the folder list fails: "Couldn't load
  folders." with Retry; Open folder… still works.
- Opening a workspace from the sidebar when its sessions cannot be read: a
  toast "Couldn't open the last session" with Retry, not a blank draft.
- A folder missing TypeScript tools: one status line, "Install TypeScript
  tools for demo?" with Later and Install, not a dialog.
- Usage opened on one session: the filter chip shows a skeleton until the
  session's title loads, not a word. Once closed, Usage stays closed when
  the app opens again (the `/telemetry` link is not saved as the route to
  reopen).
- A Read row opened while its lines load: a skeleton in the header and in
  the body, not the word or an empty line 1.
- Deleting a workspace group: the shared confirm, with Cancel.
- The QR scanner: focus lands on Cancel, Escape cancels it, and focus goes
  back to the button that opened it.
- Phone: holding ✎ (New session) opens "New session in…" as an action sheet
  with a Cancel row.

## How to get to it (user POV)

- **Folder picker:** a new session (phone: ✎), the folder chip.
- **Workspace:** the workspace's row in the sidebar (phone: Sessions).
- **TypeScript line:** the server announces it when an edit in a folder
  needs the tools it does not have.
- **Usage on a session:** a turn's footer → its usage, or a
  `/telemetry?session=<id>` link (phone: Filters shows the chip).
- **Read row:** a turn that read a file, reopened; open the row (it may be
  folded into "1 read" first).
- **Groups:** Settings → Workspaces → New group, then the row's trash button.
- **QR scanner (phone app only):** Computers (Back from Sessions) → Scan QR code
  under the list.
- **✎ sheet (phone only):** press and hold ✎ on Sessions.

## Driving it with Playwright

- Failures are made with `page.route` answering 503 for
  `/agent/workspace/tree` and `/agent/sessions?…`; the route is removed
  before the next step.
- The confirm is "Delete <group>?" with "Cancel" and "Delete group".
- The TypeScript line comes from one faked `lsp_install_required` frame on
  `/events/stream` (the route then lets the real stream through).
- The Usage skeleton stays on screen because `/observability/summary` is
  held for 6 s.
- The Read row comes from the stub's `drive:read {"path": "README.md"}`;
  its result is fetched once the row opens, and that `tool-results` request
  is held for 6 s.
- The QR scanner is mounted beside an "Open the scanner" button by the
  journey, from the dev server's own `QrScanOverlay.tsx` and React.

## Gotchas

- A phone reopens on Sessions after a reload, so the draft's own "Couldn't
  load folders." is a desktop state; on a phone the Sessions list says
  "Couldn't load workspaces." with Retry. A phone also reopens the last
  session at `/`: the journey goes Back to Sessions first.
- The app retries a failed read a few times (about 7 s) before it says so.
- The lightbox skeleton is not driven: a text attachment comes with its
  text, so the gallery never waits. `FileLightbox.test.tsx` covers it.
- A whole-file read has no range, so its header shows no line count once
  loaded; the step checks the file's text instead.
- The server's own TypeScript announcement cannot fire in the drive: the
  machine's `/etc/paths.d` puts `typescript-language-server` on the
  backend's PATH, so the tools are never missing. Hence the faked frame.
- The QR scanner needs the native camera, which a browser lacks, so the
  journey mounts the overlay itself instead of going through Settings. The
  camera window shows the page behind it, where the phone shows the camera.
- `/telemetry` and `/scheduler` hand the address back to `/` at once. Until
  [v3.59.0] the root saved them as the route to reopen, so every later
  launch reopened Usage (this journey's QR step met it as a stolen focus).
