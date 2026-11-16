# Design: the rulebook and the primitives

Part of the design system. [`DESIGN.md`](../DESIGN.md) holds the tokens and the map of chapters.

## Components

Primitives are hand-rolled — plain elements plus variant maps and CSS custom
properties. No component framework, no `cva`. The shared language across all of
them is: **warm paper surface · fills, not borders · muted text · keycap hover.**

### Fewer borders, one frame at most

**Fewer borders, one frame at most.** Controls carry no border of their own:
a primary action is filled with Bark (`--color-accent`), a secondary one with
the keycap wash (`bg-key`), a ghost one is text only. In a small group (Code /
Plan, a question's options) the chosen item is
filled edge to edge with `fill-selected` (a sand in light, a raised warm
tone in dark; see Colors → Selection fills) and its text turns `on-selected`; the
highlighted menu item takes the softer `fill-highlight`; the track
has no border and no inset. In a long list (sidebar rows, the dock's tab strip)
the open row keeps a wash and gains medium weight and the main text colour,
never a coloured bar. Borders are left for three jobs only: the boundary
between large regions, text inputs, and one `border-subtle` hairline around a
container (card, menu, popover, dialog). Nothing inside a framed container
draws another frame. The lint (`design-lint.test.ts`) and
`ui/borderless.test.tsx` hold this.

### Native first

**Native first.** Whatever the host OS already draws (context menus in the
desktop app, the title bar, simple pickers, the Dock or taskbar badge,
gestures) is the OS's own; the one exception is the Windows caption buttons,
drawn to the system's own metrics so the header can be the title bar there as
it is on macOS (Desktop chrome). The app draws only what needs its own content: the
run picker, the "+" menu, the palette. Type is the OS's UI font, dialog
buttons follow the OS's order, and every system setting is followed: light or
dark, reduced motion, increased contrast, text size.

### Rulebook

Each kind of element has one look, so a screen reads by pattern rather than by
memory. The lint (`design-lint.test.ts`) holds the rules it can check.

#### Rulebook 1: Titles

1. **Titles.** An overlay, dialog or page title is `text-base font-semibold`.
   A heading above a card is `TEXT.title`. A group label in a dense card or the
   sidebar is `label-caps`.

#### Rulebook 2: Weight

2. **Weight.** A row has regular text and one emphasis: the open or selected
   row is `font-medium`. Semibold is for titles only.

#### Rulebook 3: Meta

3. **Meta.** `text-meta` in the muted colour. The subtle colour sits only on
   the page or sidebar background.

#### Rulebook 4: Icons

4. **Icons.** 12, 13, 14 or 16px (20 in the phone header), one size per role,
   and one stroke width.

#### Rulebook 5: Buttons

5. **Buttons.** Only the primitives (`Button`, `CloseButton`), never a
   hand-rolled icon `<button>`. Dialog footer buttons are 36px, toolbar icon
   buttons 32px (`icon-sm`), row buttons 24px (`icon-xs`) with the touch floor
   widening their target.

#### Rulebook 6: Close

6. **Close.** One × per surface, top right: `CloseButton`, a 14px glyph,
   named "Close", tooltip "Close (Esc)".

#### Rulebook 7: Dialogs

7. **Dialogs.** `DialogHeader` and `DialogFooter` as they are; never override
   their `flex`. A confirm has no ×; its dismiss button says "Cancel"; its
   action is a verb and a noun ("Delete task"); a destructive button is never
   the default one.

#### Rulebook 8: Destructive actions

8. **Destructive actions.** In a detail page, a Danger row at the bottom. In a
   list, inside the ⋯ or long-press menu. Never a bare Delete icon in a header.

#### Rulebook 9: Status

9. **Status.** Words and tones from `STATUS` (Components → Status).

#### Rulebook 10: Empty, loading, error

10. **Empty, loading, error.** Empty uses `EmptyState`: a sentence-case title
    with no full stop, and a create action when the user can create. Loading
    shows a skeleton. An error reads "Couldn't load X." with Retry.

#### Rulebook 11: Copy

11. **Copy.** One name per thing: Refresh, Copy response, main agent, Rename,
    Open in tab, Close (Esc). Sentence case. "…" when, and only when, the
    control opens a dialog or a picker. Straight quotes.

#### Rulebook 12: Toolbars

12. **Toolbars.** The same action keeps the same place in every view; Close
    and ⋯ come last. On a phone, secondary actions fold into ⋯.

#### Shortcuts in menus and tooltips

Menus show the shortcut of every item that has one, and a tooltip with a
shortcut reads `Name (⌘X)`. Dates follow Components → Dates.

#### Buttons

**Buttons** ship seven variants (`default`, `subtle`, `primary`, `ghost`,
`danger`, `danger-subtle`, `link`) across nine standard sizes (`xs`, `sm`, `default`,
`lg`, `trigger`, `icon`, `icon-sm`, `icon-dense`, `icon-xs`). No variant has a
border. `primary` is filled with Bark and `on-accent` text; `default` and
`subtle` sit on the keycap wash and step one tone along the ramp on hover
(`border-subtle` on paper, `border` on dark paper); `ghost` is text until
hovered; `danger` is the soft error fill.

#### Button Size Metrics Binding (Strict)

**Button Size Metrics Binding (Strict)**:

| Size Token | Control Height | Padding | Icon Size | Label Font | Radius | Primary Use |
|---|---|---|---|---|---|---|
| `xs` | **24px** (`h-6`) | `px-2` | 11px | `11px` (`label-sm`) | `rounded-xs` (4px) | Inline table actions, compact badges |
| `sm` | **32px** (`h-8`) | `px-2.5` | 13px | `12px` (`body-sm`) | `rounded-sm` (6px) | Toolbar actions, form secondary buttons |
| `default` | **36px** (`h-9`) | `px-3` | 14px | `12px` (`body-sm`) | `rounded-md` (8px) | Standard form buttons, dialog triggers |
| `lg` | **40px** (`h-10`) | `px-4` | 16px | `14px` (`body-md`) | `rounded-md` (8px) | Modal primary actions, main CTA |
| `trigger` | **auto** | `px-2 py-1` | 11px | `12px` (`body-sm`) | `rounded-md` (8px) | Dropdown & select trigger |
| `icon-xs` | **24×24px** | `p-0` | 11px | — | `rounded-xs` (4px) | Inline row utilities (copy, delete) |
| `icon-sm` | **32×32px** | `p-0` | 13px | — | `rounded-sm` (6px) | Toolbar icon buttons |
| `icon-dense` | **28×28px** | `p-0` | 14px | — | `rounded-sm` (6px) | Panel-header and detail-pane actions (close, back) |
| `icon` | **36×36px** | `p-0` | 14px | — | `rounded-md` (8px) | Standard standalone icon actions |

#### Phone scale

**Phone scale**: a phone (the `phone:` variant: touch, and narrow or a landscape phone, the same test as `useIsMobile`) reads at the composer's size. At Default: **15px** for row titles, buttons, menus, fields, chat and bar titles (`text-xs`, `text-sm`, `text-base`), **13px** for a row's second line, status words and code (`text-subhead`, `text-code`), **12px** for times and captions (`text-meta`). Rows and every `Button` are **40px** (4px more in the Android app); controls drawn outside `Button` (sheet rows, a sheet's bar buttons, ‹ Back) read the same step from `--phone-control`; the header stays **44px**; the large title is 28px. Bar buttons add `touch-hit`, so they and prose links keep a **44px** touch area; the switch is 51×31. **Text size picks the step** (the `--oa-phone-*` tokens in `index.css`): Compact 14px text and 36px rows and buttons (a 40px header, a 26px title), Large Apple's own 17px and 44px (a 34px title), with Dynamic Type on top. A narrow phone (under 390pt: iPhone 13 mini, SE) drops every step one notch: Default reads as Compact, Compact 13px and 34px, Large 15px and 40px. The composer keeps its size at Default: 15px message text (`phone:text-xs`), 13px deck labels (`phone:text-subhead`), 36px controls (Send a 36px circle) whose touch area grows to 44px (Composer and run deck). Tablets and narrow mouse windows keep the dense scale below.

#### Mobile Touch Parity Scaling

**Mobile Touch Parity Scaling**: On touch tablets (`pointer: coarse`), standalone icon actions scale up to one compact **36×36px touch target** (`size-9`), while on desktop (`md:`) they collapse to dense **28–32px** (`md:h-7 md:w-7` or `md:h-8 md:w-8`). A phone takes the 44px phone scale above instead.

- `Button` gets this automatically: a coarse-pointer rule sets `min-height`/`min-width: 36px` on `[data-slot="button"]` (40px in the Android app). Prefer `Button` over a bare `<button>` for icon actions.
- `--spacing-list-row` becomes 36px on coarse pointers, so sidebar and dock list rows (sessions, sub-sessions, group headers, workspaces) grow with it. Size such rows from the token (`pointer-coarse:h-(--spacing-list-row)`), not a fixed `h-9`. Inline row actions add `pointer-coarse:size-9` (36px) to fill the row. Every touch target is 36px on a tablet; a phone takes its own step (Phone scale above), with a 44px touch area on bar buttons and Send.
- `--spacing-tab-bar` (the review panel's tab strip) grows to 45px on coarse pointers, so each tab and its close control are 36px pills with 4px around them and a 1px hairline. On a phone the pills take the phone's step (`--phone-control` + 9px).
- `--spacing-status-bar` grows to 37px on coarse pointers, so the server, the branch, spend and Settings are 36px targets. With a mouse the bar stays 28px with 24px items, and the server's target runs to the bar's edges, so the pointer can rest on the window's bottom edge.
- **A phone reads one step everywhere.** Whatever is a row or a control on a phone takes `--phone-control` (40px, 44px in the Android app), not the tablet's 36px: menu and sheet rows (`MENU_ITEM_CLASS`), default segmented controls, search and filter fields, row actions and chips (`ROW_ACTION`, `rowChipClass`), the Git view's tabs (their toolbar grows around them). Put the phone height in the shared class with `phone:`, after its `pointer-coarse:` one: `cn` does not merge, so a caller's plain `min-h-*` loses to the shared class.
- **A target is what a finger can reach, not what is drawn.** Nothing may lie over a control's box: a sheet's bar buttons sit above its grabber strip (`z-20` over `z-10`), and two 28px icons side by side need 16px between them, or reach away from each other (Edit and Copy under a prompt), so their 44px targets do not overlap. A title that opens something takes the bar's whole title block as its target.
- **No name may depend on a tooltip on touch.** Settings' sidebar is an icon rail only in a narrow mouse window (`settings-rail:`); every touch screen keeps the labelled list (`settings-list:`).
- Line height tightens on coarse pointers: `leading-relaxed` is 1.5 (1.625 on desktop) and chat/plan prose (`.oa-prose`) is 1.6 (1.75 on desktop), so phone screens read denser. Text sizes do not change.
- On phones the header is 40px with 36px controls (`max-md:pointer-coarse:size-9`). On wider touch screens, controls inside the 36px header stay within that height (`pointer-coarse:size-9`), because overlays are positioned from `--spacing-app-header`.
- Tabs (`ui/tabs`) are 36px per trigger on touch: the list grows to 42px around them.
- A narrow mouse window keeps the drawer: its footer has Settings, Usage, the command palette and theme as icons, and the server as its dot plus name, and its header has the sidebar toggle, the title, Task list and Review panel. A phone has no drawer: its **Sessions** screen and navigation stack are under Mobile shell. Model, thinking, account and context live in the run deck under the composer on every screen, never in the header or status bar. The review panel's phone tab strip shows its actions as icons only (+, ⋯).
- Grow the control itself wherever the layout allows. Two exceptions extend an invisible hit area with a `::before` instead, because growing the element would reflow text or a dense strip: links and file references inside prose (`.oa-prose a`, `[data-file-ref]`, 36px tall) and small icon buttons in code-block and tool-detail headers and in the 32px view toolbar (`.touch-hit` on a positioned element, 36×36 around it; `DOCK_ACTION_BUTTON_CLASS` is 28px on touch, 36px in the tab bar). Keep such targets apart so neighbours do not steal each other's taps.
- Rows with a long-press action sheet set `-webkit-touch-callout: none` (`LongPressButton` does this while enabled).

#### Inputs

**Inputs** use `bg-input` (matching the page, not the card) with a 1px
`border` hairline (`border-subtle` all but vanished on a dark card, 1.15:1;
Increase contrast darkens it to 3:1 with every other border).
Focus steps the border to `on-surface-subtle` (4.7:1; `border-strong` was
2.25:1). Borders never change
width on hover — that causes a 1px layout jump.

#### Transcript folds

**Transcript folds** (`hooks/useStickyFold.ts`): anything in the transcript that
opens into a long body — the reader work row, the compaction divider, a long
prompt or subagent report, a tool call's details, the "N files changed" list —
pins its header (or its collapse control) to the top of the transcript while
open (`PINNED_HEADER` plus the surface fill), so it can close from anywhere.
A header inside an open fold pins just below the fold's row (`--fold-top`), not
over it. Closing leaves the header where the pressed control was, so the view
never jumps; the shift goes through the transcript (`shiftTranscriptView`), so
a fold closed at the live end keeps following it and never reads as the reader
scrolling up. A tool call's details have no bottom Collapse bar: the pinned row
and the section captions close them. Reasoning (`Thinking`) is not a fold and
has no label: it streams in place and stays open, inline in small upright mono
with semibold section headers (no quote bar). It always shows in full: no height
cap, no inner scroll box, no "Show full reasoning" toggle. Clip with `overflow-clip`, not `overflow-hidden`,
on a box that holds a pinned control: a hidden-overflow box stops it pinning.

#### Floating Menus & Context Menus

**Floating Menus & Context Menus** (`ui/menu-styles.ts` — dropdowns, context menus and hand-built listboxes all import it):
- **Panel**: `rounded-md`, one 1px `border-(--color-border-subtle)` hairline, `bg-(--bg-card)`, `p-1`, `shadow-depth`.
- **Items**: `rounded-xs`, 28px height (`px-2 py-1.5`), `text-xs`, text `on-surface-2`. The highlighted item (pointer or keyboard) is filled with the `fill-highlight` wash and its text and icons turn `on-highlight` (`.oa-menu-item` in `index.css`; hover only applies where a real pointer hovers).
- **Keyed lists** (`oa-menu-item-keyed`, the command palette): only the row the list marks active (`data-highlighted`) fills; a real mouse move makes a row active (`hoverIntent`), a pointer resting over the list lights nothing, so ↑/↓ never leave two rows lit. Palette rows have no border.
- **Destructive Items** (`MENU_ITEM_DANGER`): `text-(--color-error)`; highlighted, the fill turns `fill-danger` and the text turns `on-danger`.
- **Ours in every shell**: context menus, dropdowns and pickers are drawn by the page in the desktop and phone apps too, never handed to the OS menu, an iOS action sheet or an Android dialog. Native is the feel (a menu opens at the pointer, arrow keys move, Escape returns focus to the opener), not the OS widget, so every menu in the app looks alike. Only the window's menu bar (the macOS menu bar; ☰ on Windows and Linux) belongs to the shell.
- **Dividers**: `1px border-t border-(--color-border-subtle) my-1`.

#### Segmented Controls & Connected Tabs

**Segmented Controls & Connected Tabs**:
- **Track**: `rounded-sm`, `bg-(--bg-key)`, no border and no padding, `overflow-hidden`: the segments are the track.
- **Active Segment**: filled with `fill-selected` edge to edge (a sand in light, a raised warm tone in dark), `text-(--color-text-on-selected)`, `font-medium`. Nothing else marks it: no border, no inner card, no shadow.
- **Inactive Segment**: square inside the track, `text-(--color-text-muted)`, hover `text-(--color-text-2)` and a keycap step. Keyboard focus is an inset ring so it never spills past the track.
- **Sizes**: `TabsList size="sm"` is the 24px variant for dense panel toolbars (12px label, no shadow); on touch it is 28px so it still fits the 32px toolbar (the `default` list grows to 42px on touch).
- **Primitive**: pick-one controls use `SegmentedControl` (`ui/segmented-control.tsx`) — radio semantics with arrow-key roving, `default` (32px, 36px on touch), and `sm` (24px, 28px on touch so it fits the 32px toolbar, like `TabsList size="sm"`). The composer's Code / Plan is not one: it is a single toggle button (Composer and run deck). Controls that need toggle-button semantics reuse its `segmentedTrackClass` / `segmentedItemClass`. `TabsList` stays for real tab panels.

#### Editor Tabs

**Editor Tabs** (review dock tab bar):
- **Strip**: `tab-bar` height (37px, 45px on touch) on the chrome tone (`bg-page` in light, `bg-sidebar` in dark; `DOCK_TAB_STRIP_CLASS`) with one `border-subtle` hairline below; tabs are 28px pills (36px on touch) 4px from its edges, scroll horizontally, and the actions stay pinned right.
- **Order**: views (Git, Plan, Tasks…) first, a hairline, then documents (files, diffs, commits, terminals, previews). A tab moves only among its own kind.
- **Preview tab**: a file, diff or attachment opened from a list, a link or Quick Open opens as the focused pane's one preview tab, title in *italics*, and the next one replaces it. Double-click, Keep Open, a comment on it, or moving it keeps it. Its tooltip and `aria-description` say so; its name stays the file's.
- **Drag**: a tab slides along its strip; carried out, a floating copy follows the pointer and a `focus-ring` caret or tint shows where it lands (another strip, a pane's middle, or the half an edge split takes). See Layout → Tabs drag between panes.
- **Overflow**: when the strip cannot show every tab, a `N ⌄` button lists them all (`menuitemradio`, the open one checked).
- **Menu** (right-click, Shift+F10), in groups: Close, Close others, Close to the right | Close all | Keep open, Split right, Split down, Move to next pane | Copy path, Show in Changes. The close items act on the tab's own pane; Close all closes the pane with them. Left and up splits, and moving along the strip, are the drag's and the keys' (`⌃⌥←/↑`, `⌥⇧←/→`).
- **Stepping**: `Ctrl+Tab` / `Ctrl+Shift+Tab` everywhere, plus the platform's pair: `⌘⇧]` / `⌘⇧[` on macOS, `Ctrl+PageDown` / `Ctrl+PageUp` elsewhere.
- **Active Tab**: the sidebar's current-row wash (`listRowSurface(true)`, `bg-key` at 60%), `font-medium`, `text-(--color-text)`. No coloured edge, no border. In a pane without focus (with several on screen) it steps back to a 35% wash and `text-2`; nothing on the strip fades.
- **Inactive Tab**: no fill, `text-(--color-text-muted)`, the sidebar row's hover wash.
- **Close**: a sibling `<button>` (never nested in the tab button), always visible: full strength on the open tab, dimmed on the others; middle-click also closes.
- **Semantics**: tabs are buttons with `aria-current`, not an ARIA `tablist` — terminal tabs carry their own context menu and sheet.

#### Badges & Counters

**Badges & Counters**:
- **Agent / Status Chip**: `rounded-full`, 20px height, `px-2 py-0.5`, `label-sm` (11px).
- **Counter / Sync Badge**: `rounded-full`, `bg-(--bg-key)`, `text-(--color-text-muted)` (subtle text never sits on a wash), JetBrains Mono `text-meta`, `px-1.5 py-0.5`.
- **Kbd Shortcut Badge**: `rounded-xs`, `bg-(--bg-key)`, no border, JetBrains Mono `text-meta`, `px-1.5 py-0.5`.

#### Chips

**Chips** (`ui/chip.tsx`): the one small label for states, identifiers and
tags. 18px, `rounded-xs`, `text-meta`, tones `neutral | info | success |
warning | error`, soft fills only (there is no outlined chip). Mono for identifiers and numbers (`exit 1`,
`429 rate_limit`), sans for words (`not yet`, `Vision`). A status chip always
carries text, never colour alone; `spinner` marks a live state and `dot` one
waiting on someone.
Do not hand-roll pills; reach for `Chip` (agent identity chips keep their
full-radius triplet).

#### Status

**Status** (`lib/status.ts`, `StatusChip`): one vocabulary, so a state reads
with the same word and tone on every surface (sidebar, Scheduled tasks,
subagents, MCP, providers, servers, Usage). Colour is kept for what needs a
look:

| State | Word | Look |
|---|---|---|
| Needs you, Needs sign-in | `Needs you` | warning (orange) |
| Running, Starting | `Running`, `Starting…` | neutral chip with a spinner |
| Done, Stopped, Paused, Scheduled, Idle, Off | `Done`… | neutral: quiet text, never green |
| In use | `In use` | neutral |
| Failed, Error | `Failed`, `Error` | error (red) |
| Healthy | `Ready`, `Connected` | success (green), the only green state |

Words are sentence case. Add a state to `STATUS` before using it anywhere.

#### Dates

**Dates** (`utils/format.ts`): one rule set, in English like the rest of the
UI, whatever the system locale. Lists count `now · 5m · 3h · 3d`, then name
the date (`Oct 29`). Details and tooltips read `Today 14:32`,
`Yesterday 09:01`, `Oct 29, 14:32`. The year shows only when it is not this
one (`Oct 29, 2024`). Never `dd/MM`: day-first and month-first readers both
misread it.

#### Confirmations

**Confirmations** (`ui/confirm-dialog.tsx`): every action that cannot be
undone (stop a server, regenerate a key, delete, discard edits, revert a
commit, cut retention) asks first. The title says what happens, the
description what is lost, Cancel sits before the `danger` action, and its
menu item ends in "…". On an iOS-style phone it is an alert (Mobile shell).

#### Icons: as few as possible

**Icons: as few as possible.** Icons stay where they already are (icon
buttons such as copy, edit, close; chevrons that expand and collapse; the
header and composer). Do not add icons to transcript rows, meta lines,
dividers or card headers, and do not put an icon before a label that is
already clear. State is carried by words and chips.

#### Section cards

**Section cards** are the dominant grouping pattern and come in two variants:

- **Titled sections** (`ui/panel-section`) are the default for panels,
  overlays and forms. The title (`text-xs` semibold, 13px, sentence case), an optional
  one-line description and right-aligned actions sit *above* a bordered
  `bg-card` card, which holds padded content or flush `divide-y` rows.
- **Dense section cards** (`ui/section-card`) put a `bg-key` header strip in
  `label-caps` inside the card, then `divide-y` rows that lift toward
  `bg-page` on hover. They are for data surfaces where every row counts, such
  as Telemetry breakdowns.

The sidebar has its own section header (below).

#### Overlays & Dialogs

**Overlays & Dialogs** come in two `AppOverlay` geometries — `modal` (centered card,
capped at `overlay-max`) and `palette` (compact 600px search card) — plus `Dialog`
for confirmations. All are `position: fixed`, share `rounded-lg` (12px — the panel
ceiling) and a 1px border, and go edge-to-edge below 768px. Mobile drawers (the
session sidebar, chat actions, the dock sheet) slide from an edge over the same
scrim.

Modal panels open with an `OverlayHeader`: a 44px `bg-sidebar` strip with an
optional 14px icon, the title (`text-base`, semibold), an optional one-line
subtitle, actions, and a ghost `icon-sm` close button ("Close (Esc)").

`Dialog` width and padding are props (`size="xs|sm|md|lg|none"`,
`padding="default|compact|none"`), not className overrides: `cn` does not merge
classes, so a wider `sm:max-w-*` never beat the default. `DialogFooter` reads the
panel padding: it bleeds to the panel edges and sits the same distance below
the body (16px, or 12px when `compact`); `none` panels lay out their own. The
footer has no border and no fill of its own. Button order follows the host OS
(`data-button-order`): Cancel (`default`) then the confirm action (`primary`,
or `danger` when destructive) on macOS, iOS and Linux; the confirm action first
on Windows. Enter is the confirm action, Esc is Cancel, and a destructive
action is never the default button.

Inside a modal panel the scrolling body uses `OVERLAY_BODY` (`px-4 py-5`,
`md:px-6 md:py-6`) and stacks titled sections 32px apart. A form's commit
actions sit in a footer bar under the scroller (`bg-sidebar` with one
`border-subtle` hairline, right-aligned), in the same order as `DialogFooter`.

#### App-level overlays

**App-level overlays** (Settings, Usage) are the same `AppOverlay` card
(`appLevel`, `OVERLAY_MAX_WIDTH.wide`), mount at the root so any route can open them, and are mutually
exclusive with the palette and utility panels. Telemetry reads top-down: a
filter bar (range, workspace, model, session chip), a headline stat strip,
per-day activity, then dense section-card breakdowns whose rows double as
filters, then recent turns. Escape steps out of a trace before it closes the overlay.
