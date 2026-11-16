# Design: Settings, panels, Scheduled tasks and Preview

Part of the design system. [`DESIGN.md`](../DESIGN.md) holds the tokens and the map of chapters.

## Panels and management surfaces

**Panels and management surfaces** (Settings, Scheduled tasks, Session
settings, Keyboard shortcuts, the Server dialog) are roomier than
the working surfaces. Text stays at the same sizes. They compose the shared
primitives in `components/ui/`:

- **Sections.** `PanelSection`: a titled section whose title and description
  sit above its card (see Section cards).
- **Rows.** `PanelRow` is a 56px row with the label and description on the
  left and the control on the right. It stacks below `sm`. Long reference
  lists (shortcuts, tools, connectors, detail facts) use the 44px
  `COMPACT_ROW` with the same layout.
- **Fields.** `Field` puts the label 8px above the control and a hint or
  error 8px below it; grids use 16px columns and 20px rows. Inputs are 36px
  tall. Actions that commit a form go in a footer row, not beside an input.
- **Notices.** States and warnings between sections (a failed server, a
  scanned link, a security caveat, lint results, a failed run) use `Callout`
  (neutral, info, success, warning or error tone). Field errors stay inline.
  A failed load offers Retry next to its message. An unreachable backend is
  the one app-wide notice: `ConnectionBanner`, a slim warning-tone row under
  the header with **Change server**. It shows only after the health check has
  failed its retries (~3s) and leaves without a "reconnected" message.
- **Tokens.** `ui/panel-tokens.ts` holds the type steps (`TEXT`), icon sizes,
  row padding and `OVERLAY_BODY`. Do not hand-roll caps strips, nested cards
  or ad-hoc notice boxes on these surfaces.
- **Copy.** Sentence case for titles, labels and buttons. One short
  description per page and per section; long explanations belong in the
  docs, not on the page. Command palette commands are the exception: they
  stay Title Case ("Scheduled Tasks", "Toggle Sidebar"), like editor
  commands.
- **Technical where the work is, plain where you set up.** The working
  surfaces (transcript, message box, Review panel, Usage) are a developer's
  tools, so industry terms stay there: p50/p95, TTFT, tok/s, cache hit, PID,
  exit code, cron, Git's words, tool names, model IDs and span names keep
  their real strings. What they need is a label, a unit and a definition:
  every number has a named label and a unit (`p95 35.2 s`,
  `in 55.8K · out 268`), every column a header, and every term a
  dotted-underline `Term` whose tooltip defines it.
  First run and Settings are the first screens a newcomer reads, so they use
  everyday words: Models (not providers), Connectors (not MCP servers),
  Blocked files (not denied paths), Computer (not server), "Sign in" (not
  OAuth or device code), a folder picker (not a glob), "How does it
  connect?" (not stdio / HTTP / SSE). Settings search and the palette still
  find each page by its earlier word.
  Words that only exist inside this codebase never reach the UI: say
  "this computer" not "builtin", "main agent / subagent" not
  "lead / member", "summarize" not "compact", `exit 0` not `[Succeeded]`.
  A model on its own shows as `provider:model` in mono
  (`anthropic:claude-sonnet-4-6`); when space runs out the `provider:` part
  gives way first (it ellipsizes), and the full ID is in the tooltip. In a
  list grouped by provider (the model pickers) the group header names the
  provider and each row shows only the model; typing `openai:` still finds
  them. The run chip is the one label: it names the model alone, in sans,
  with the ID in its tooltip (Composer → the run chip).
- **Plain words for Remote control.** Adding a device and using your
  computers from anywhere are first-run screens, so every word on that path
  is an everyday one. Shared strings live in
  `components/settings/pages/account-copy.tsx` (`FEATURE_NAME`,
  `CODE_TIMED_OUT`, `CAN_ADD_DEVICES`, `CANT_ADD_DEVICES`); the phone shell's
  own messages in `mobile/src-tauri/src/cloud.rs` match them.

  | Instead of | Say |
  |---|---|
  | OpenAgentd Cloud, the cloud | Remote control, or nothing at all |
  | signer, approves devices, Can approve other devices, Let it approve new devices | Can add devices (one wording everywhere) |
  | enrollment, pending, roster, joining | wants to join / adding / added |
  | fingerprint, key | Device ID, and only under a Details row or on the Sign in with Google step, where the account page shows it too |
  | relay, 6-digit code | nothing on the main path (a Details row, or the Google fallback) |
  | device | the actual thing: iPhone, iPad, computer. The account reports an iPhone and an iPad both as `ios`, so a device seen only through the account is an "iPhone or iPad" |
  | Request cancelled. If you didn't start it, someone may be trying to join your account. | Not added. Try again on the device you're adding. |
  | The sign-in code expired, The invitation ended | This code timed out. Show a new one. |
  | This phone cannot approve devices | This iPhone can't add devices. Use the phone you set up first. |

  "Your OpenAgentd account" stays the name of what a person signs in to. Code
  identifiers, hostnames, API paths and storage keys keep "cloud".
- **One name per thing.** Workspace (not project or repo), Worktree,
  Rename, Tasks, Scheduled tasks, Review panel, Changes (its Git view, with
  Uncommitted and History inside), Side questions, Find file, Session,
  Computer and This computer (not server; a browser page says "This
  server" of the one it was loaded from), Models, Connectors, Blocked files,
  Main agent / Subagent, Run now, Usage (the spend and trace overlay), Usage
  limits (a provider's quota), Detail: Simple / Full, Summarize, Comment (on
  a Preview page), Needs you / Running / Done / Failed / Can't reach
  (session states). Sending while the agent works is Steer, Queue until
  done or Stop and send, on every device. A failure starts "Couldn't …",
  the button that tries again is Retry, and what cannot come back "can't be
  undone".

Settings adds its own shell on top:

- **Layout.** From `md:` up a 240px sidebar of inset 32px rows sits beside
  the page. Each page has an `h1` header (`text-base`, a description, and
  right-aligned actions) and a `max-w-3xl` body column with `px-4 md:px-8`
  insets (`SettingsPage`), with a save bar for drafts.
- **No collapsibles.** A page that outgrows one screen of sections is split
  into more pages rather than folded into collapsible groups. (Session
  settings' Tools list is the one collapsible panel section: a long
  reference list at the bottom of an overlay.)
- **Phones.** Settings opens on a grouped list of sections. Each section
  opens full-screen, with Back in the overlay header. An editor (agent,
  skill, connector) brings its own Back, so the overlay's Back hides while
  one is open: one Back on screen.
- **Nav.** Three groups in sentence case (Basics, Agent, Advanced), 15
  sections, no icons at full width, counts in words ("4 skills",
  "1 needs sign-in"; nothing for none), a "Search settings" box on top.
- **One save rule.** A page of fields keeps a draft and saves from the save
  bar (`SaveBar`: Save, ⌘S, "Discard…" asks first); when Save is blocked the
  bar says why. Editors (agent, skill, MCP server, memory page) use the same
  bar under their form; their header keeps Back, the Form/Source toggle and
  errors, and Back with unsaved edits asks first. A switch applies at once
  and its own state is the confirmation, as in the OS's settings (no
  toast); a list action (add a group, hide a provider) saves at once and
  confirms with a toast. Saving a key checks it first and, if the check
  fails, offers Retry and Save anyway. Loading is a skeleton; a load error
  is a Callout with Retry.
- **Search.** "Search settings" finds single settings (`settings-index.ts`),
  not only pages; a hit opens the page, scrolls to the setting and focuses
  it. The phone section list has the same field. In a mouse window below
  900px the nav is an icon rail whose search opens in a dialog; a touch
  screen keeps the labelled list at every width.
- **Long lists are rows, not cards.** Models is one bordered list of
  rows (name, a subline such as "API key · 1 key · 13 models", a status
  chip); a row opens in place. Secondary row actions go in a "More" menu.
- **Server.** The same `AppBackendPanel` appears as Settings → Server and
  as the Server dialog. The dialog is used before
  the app is ready, from the footer health dot, and for scanned connect links.

## Scheduled tasks

**Scheduled tasks** use the same primitives in the overlay and the review
dock's Schedule tab. Spacing there keys off container queries (`@xl:`), not
the viewport, so the narrow dock stays usable. The task list is full-bleed
`divide-y` rows on the rail tone; a task's detail reads Status tiles, then
Runs in, Schedule, Prompt and Dates sections. The schedule is said in
words wherever a cron expression has them ("weekdays at 09:00"); the
expression itself shows in Full detail, or when it has no wording. The form
is two pages: three questions (What should it do?, When?, Where?) and where
the reply goes, then More options (Name, Stop after, Time zone, Session ID).

On phones (`useIsMobile`) the overlay header carries the title and Back, so
the detail and create panes drop their own title and close button. Run now
and Pause move to a bottom bar of labelled buttons, form footer buttons go
full width, and long detail values (workspace path, session ID) stack under
their label instead of truncating behind a hover tooltip. Task rows hide
their inline actions on coarse pointers, because the detail and the
long-press menu already offer them.

## Preview

**Preview** (the Review panel's web preview) keeps one bar: Back, Forward,
Refresh, the address, the size, Rotate (a fixed size only), Console, Comment
and Open in browser. On a phone the bar is at the bottom with the address
as a pill above the tools; Console and Open in browser share "⋯", and
Comment keeps a button of its own.

- **Address.** At rest it shows the address without `http://` (`https://`
  stays); focused, the whole address, selected, over a list of **Recent**
  addresses (five per workspace, on this device) and **Pages in this
  workspace** (its HTML files, shallowest first, eight at most). Typing
  filters both; ↑ ↓ and ↵ choose. On a phone the list opens upward in 44pt
  rows. The size's name and the agent's chip give way by the panel's width
  (`@lg`), not the window's.
- **Commenting says it is on.** While picking, a line in the notice slot
  reads "Click an element to comment" (Tap on a phone) with Esc and
  **Done**; on a phone it sits just above the bar.
- **Comments.** A click on a comment brings its pin into view. Clear and
  the × on one comment answer with a toast and **Undo** (10 seconds), not a
  dialog. Add comment shows its keys (`⌘↵`) where there is a keyboard. On a
  phone the list is one row ("3 comments ▴") that opens, with Clear inside,
  and Send to agent returns to the chat, where the comments are.
- **Console.** Errors, Warnings and All, each with its count; it opens on
  Errors when there are any (the badge counts those), keeps the newest line
  in view until the list is scrolled up, and closes from its own ×. A phone's
  "⋯" carries the same count, and its row reads **Hide console** while open.
- **Size.** A fixed size draws a caption under the page, "390 × 844 · 62%"
  (the scale is left out at 100%); in Responsive the size shows for a moment
  while the panel is resized. A phone's size button takes the pressed fill
  while a fixed size is chosen.
