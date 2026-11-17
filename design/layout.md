# Design: layout and the workbench

Part of the design system. [`DESIGN.md`](../DESIGN.md) holds the tokens and the map of chapters.

## Layout

The shell is a fixed-viewport application, not a scrolling document. `html` and
`body` are locked to 100% with `overflow: hidden` so that internal regions are
the only scrollers — this prevents the webview from rubber-banding the whole
document and exposing pixels outside the layout.

### Spacing rhythm

**Spacing rhythm** is a 4px base scale. The dominant intervals are 8px (`gutter`
— the default gap between related controls) and 12px (`card-padding` — standard
horizontal padding and card inset). Vertical padding runs tighter than
horizontal: a 12px-tall row typically pairs `py-1.5` with `px-3`.

Management surfaces use a roomier panel rhythm: 16px card insets, 8px from a
label to its control, 20px between fields, and 32px between sections.

**Sizes are steps of the scale.** A spacing or size is a quarter step of the
4px scale (`w-30` is 120px, `pr-4.75` is 19px, `-top-1` is −4px), never an
arbitrary `w-[120px]`. The scale is rem, so on iOS it follows Dynamic Type;
geometry the OS fixes in points (the phone switch, the 270pt alert) is a named
`--spacing-*` token in `index.css`, in px, with its reason beside it.
`design-lint` (`px-size`) fails on a px literal in a spacing or size class.

### Mobile-first authoring is mandatory

**Mobile-first authoring is mandatory.** Base (unprefixed) styles target the
phone; `md:` (768px) and up progressively add desktop affordances. Never author
desktop-first and walk styles back down.

### Fixed geometry

**Fixed geometry:**

- `app-header` (36px) — the shared top bar across every platform shell.
- `status-bar` (28px) — the desktop status footer; its items are 24px and
  every one is a Tab stop.
- `tab-bar` (36px) — the review dock's editor-tab strip.
- `toolbar` (32px) — the single view toolbar under a tab bar.
- `list-row` (28px) — sidebar and dock list rows (`ui/list-row.ts` holds the
  shared geometry and the hover / current washes). Touch has no hover, so a
  finger press shows the current-row wash (`pointer-coarse:active:`); a mouse
  press does not, because the click selects the row at once.
- `mac-traffic-inset` (70px) — left inset that clears the macOS traffic-light
  overlay (12px origin + ~58px button group).
- `content-max` (768px) — reading measure for transcripts and prose.
  The Plan tab's review footer (comments, feedback, Approve and Request
  changes) keeps the plan's text column (`oa-review-column`), not the dock's
  width: its band and top line run full width, its content lines up with
  the prose, 88ch in a maximized dock.
- `overlay-max` (860px) — default modal width cap; `palette-max` (600px) for the
  command palette.

### Safe areas are non-negotiable

**Safe areas are non-negotiable.** Every outermost shell and overlay applies
`env(safe-area-inset-*)`. Overlays additionally track the visual-viewport offset
so they follow the soft keyboard by translation rather than by resizing — a
height change mid-animation causes visible reflow.

### Workbench layout (desktop)

From `md:` up the coding view is a workbench: header, sidebar, a center region
holding the chat and the Review panel, and a status bar. There is no bottom
dock: two areas sit around the chat, the sidebar on the left (`Mod+B`) and the
Review panel on the right (`Mod+D`), full window height. Mobile keeps its
drawer and full-screen sheet.

```
┌─────────────┬── app-header 36 ────────────────┬──────────────────────────────┐
│ sidebar cap │ workspace · title              │ Review panel cap:  Tasks ▣   │
│ lights ⌘B   ├────────────────────────────────┼──────────────────────────────┤
│ sidebar 264 │ chat · bg-page (≥ 400)         │ Review panel (≥ 340)         │
│ page / rail │ transcript (prose ≤ 768,       │ pane: tab-bar 36 │ pane (⌘\) │
│ 28px rows   │   code/tables/tools = column)  │ toolbar 32 · one │            │
│             │                                ├─ split bar ──────┴───────────┤
│             │ composer + run deck (≤ 768)    │ pane (⌘⇧\)                   │
└────────────── status-bar 24 · bg-page (light) / bg-sidebar (dark) ─────────┘
```

- **Columns run to the top.** The desktop header has a sidebar cap (the
  traffic lights, ☰ and the sidebar toggle, 80px in on macOS so it keeps a
  native gap from the lights), the title, and a Review panel cap as wide as
  the panel (Tasks, the panel toggle; on Windows the caption buttons).
  Only the Review panel cap lines up with its panel: the sidebar cap is as
  wide as its buttons, so the title sits right after the sidebar toggle
  whatever the sidebar does (opening it does not move the title). The
  command palette has no button there: `Mod+K`, the View menu and the phone
  drawer footer's palette icon open it. The caps draw no edge of their own (the column lines
  start under the header), and the header's bottom line runs the full width
  of the window, over the sidebar too, so the header reads as one bar.
  The dock width comes from the panel itself (`ResizableAside`
  `publishWidthAs` → `--oa-dock-w`), so the cap follows a drag and a slide;
  a hidden panel, a drawer or an overlay publishes none, and the cap
  shrinks to its buttons. The width is written on the dock cap only, never
  on `<html>`: a custom property changed on the root restyles every
  element each frame of a slide. Phones keep one bar.
- **Zoning is tonal in dark mode.** There the header, sidebar and status bar
  sit on the recessed `bg-sidebar`; in light mode they share the chat's
  `bg-page`, so the app reads as one sheet of paper. The dock tab bar
  follows the same rule. Working surfaces (chat, dock content) sit on
  `bg-page`. The zones meet at hairline borders, never shadows.
- **One selection language.** The open dock tab is marked exactly like the
  sidebar's open session (`listRowSurface`: a keycap wash, medium weight,
  ink text), so the two side columns read as one design.
- **Geometry lives in one place.** `lib/workbench-layout.ts` owns the math and
  `useLayoutStore` (`oa.layout.v1`) persists the choices. The sidebar defaults
  to 264px (220–440px) and opens expanded on first run at ≥1280px. The dock is
  stored as a ratio of the center (default 45%), clamped so the dock keeps
  340px and the chat keeps 400px in a desktop window (520px on a touch
  tablet, where the run deck would stack).
  Open/closed and sizes are per window (`sessionStorage`); panes, their
  tabs and split sizes per session (`oa.dockTabs.v1`); terminals per
  workspace.
  Reset Layout puts the sizes back.
- **Narrow windows.** A desktop window behaves like a desktop app: the
  sidebar pushes the chat and the Review panel sits beside it while each keeps
  its minimum (the panel splits down to 740px of center). When the Review
  panel is open and the sidebar no longer fits beside the chat and the panel,
  the sidebar becomes a drawer over the content (scrim; a click outside or
  Escape closes it) and the column choice is left alone. The drawer takes no
  room: the chat and the panel keep their widths under it, and its scrim
  covers the panel too, even maximized. A touch tablet
  follows iPadOS instead: the sidebar is a drawer below 1180px and the panel
  covers the transcript below 860px of center (an 820px tablet in portrait).
  Covering, the panel stops above the composer (`--composer-h`), so a message
  can be written beside the diff; maximized (`Mod+Shift+D`) it covers both.
  What it covers stays mounted, `inert`. Maximize lasts until toggled or Escape;
  it grows the whole panel, every pane in it (never one pane alone).
- **Toggles slide, resizes do not.** Showing or hiding the sidebar or the
  Review panel slides its width (`base`, `ease-sheet`) with a CSS transition
  set only while the toggle runs (`useToggleTween`, `ResizableAside`
  `tweenWidth`); a drag or a window resize still moves the edge at once. The
  panel's body keeps its open width and rides the moving edge (clipped, not
  reflowed), so only the chat column relayouts, and the composer keeps focus
  and draft. CSS rather than a frame loop, so a hidden window still ends at
  the right width. The phone drawer and sheet slide as before. With the
  Review panel open, the sidebar's slide changes the center it is a ratio
  of: the sidebar announces the slide in the commit it starts
  (`onPanelSlideBeside`), so the panel re-measures and slides to its new
  width alongside, on the same curve, and the chat between them grows or
  shrinks in one motion instead of overshooting and snapping back.
- **Folds fold.** Workspace session lists, a session's subagents, the reader
  fold and the turn's file list open and close through `ui/collapsible`
  (height and opacity, `base`); rows leaving stay on screen until the fold
  has closed over them. A segmented control's fill slides to the new choice
  (`useSegmentIndicator`), and a switch's thumb ends on `ease-spring-soft`.
- **Search sessions** (`Mod+Shift+F`) focuses the sidebar's search field,
  showing the sidebar first if it was hidden; a focused terminal keeps the
  chord for its shell. (Focus mode, which held this key, went in v3.46.0:
  `Mod+B` and `Mod+D` hide the two sides.)
- **Find in session** (`Mod+F`, while focus is in the chat) searches the loaded
  turns and paints matches with the CSS Custom Highlight API.
- **F6 areas.** F6 / Shift+F6 move focus sidebar → transcript → composer →
  each Review panel pane (left to right, top to bottom) → status bar
  (`lib/focus-regions.ts`, `data-focus-region`, `data-focus-order`),
  returning to where focus was in each.
- **Separators are controls.** Resize handles are 6px, keyboard-focusable
  `role="separator"` elements (arrows ±16px, Shift ±64px, Home/End, Enter or
  double-click to reset) whose 1px line lights up in `focus-ring`.
- **One toolbar, one scroller per view.** A view gets at most one 32px toolbar
  under the tab bar and one scrolling region (the sidebar is the exception:
  its session list scrolls and Scheduled scrolls on its own). Lists are flat `divide-y` rows at
  `list-row` height; row actions swap in for trailing metadata on hover/focus
  instead of nesting controls inside the row button.
- **The Review panel holds views, not just files.** Besides Git, file, diff,
  commit, and terminal tabs, the agent's Tasks, Plan, Goal, Side questions and
  Scheduled tasks open as closable tabs. The header's Review panel button
  (`Mod+D`) is the one show/hide control; the panel never covers the header.
  Inline diff peeks never scroll their ancestors.
- **Panes, as in an editor.** The panel holds any number of panes, each
  with its own tab strip, laid out as rows and columns
  (`WorkspacePanel/dock-panes.ts`). `Mod+\` splits the focused pane right and
  `Mod+Shift+\` down, as often as there is room: a pane keeps 160 × 120px,
  and a split that would break that says so in a toast. A new pane is empty
  and shows its launcher (tabs are not cloned: each tab lives in one pane).
  Closing a pane's last tab closes the pane; its room goes to the pane before
  it (else after). Closing the open tab shows the tab used before it in that
  pane, else its right neighbour. A
  pane's strip offers Split right and Split down, and so does a double-click
  or right-click on the strip's free end (the "+" menu at the pointer); the tab menu
  splits to all
  four sides and adds Move to Next Pane.
- **Tabs drag between panes** (mouse and pen; touch scrolls the strip). Along
  its strip a tab slides and its neighbours make room. Carried out, it becomes
  a floating copy and the target lights up in `focus-ring`: a caret between
  another strip's tabs, a whole pane's body (its middle: move there), or the
  half a split would take (a band a fifth of the body's shorter side along an
  edge: split that pane, the tab in the new half). Its own pane's middle is no
  target, nor its own edges when it is that pane's only tab. Escape, a
  cancelled pointer or a release over nothing puts it back.
- **Panes never move in the DOM.** They render flat, absolutely placed from
  the layout, in the order they were made, so a split never re-parents one (a
  moved iframe reloads). Preview pages sit in one layer over the panes, so a
  page and its unsent comments survive a move between panes. The bars between
  panes drag, take the arrow keys, and even out on Enter or double-click.
- **Terminals are tabs like any other.** A shell opens in the focused pane,
  right after its open tab, and documents open beside it there; a split puts
  a diff and a shell side by side. There is no terminal pane and nothing
  hides one. Terminals have no key: Open Terminal (the palette, the View
  menu) and the strip's "+" menu or launcher start one, and a focused
  terminal keeps Control+backquote for its shell. A shell code block's
  header has Run in terminal before Copy (the same muted icon control, the
  terminal glyph): it runs the block in the last shell at its prompt, or a
  new one, never a busy one, and shows that tab. Keys (`Mod+W`, `Mod+1–9`, `Ctrl+Tab`, `Mod+Shift+[`/`]`) act on the focused
  pane; with several panes, the open tab of a pane without focus steps back
  (a lighter wash, `text-2`), so the focused pane reads at a glance; the
  labels never fade (a strip at 50% left them at 2.1–2.3:1). A click into a preview page focuses its pane too (the window's
  blur says so; the page's events stay in its frame). Phones have one strip:
  panes join there.
- **The terminal surface has one menu.** Right-click with a pointer and a
  long press on touch open the same items (`terminal-menu.ts`): the context
  menu with keys, the phone action sheet without. Touch adds **Select Text**
  first, because xterm selects only with a mouse: it shows the output as
  plain text for the system's own selection. The touch key bar is ordered
  by use (Esc, Ctrl, Alt, Tab, ^C, arrows on the first screen of a 390pt
  phone), with **Line** pinned at its start for the command field; it shows
  on a phone, and on a tablet while the soft keyboard is up for the
  terminal. Terminal text follows Text size.
