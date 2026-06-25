---
title: Applications & Templates
description: Component guidelines for OpenAgentd UI — agent chips, sidebar, input bar, tool calls, theme toggle
status: stable
updated: 2026-05-09
---

# Applications & Templates

How OpenAgentd's component language is built and combined. Each section states the role of the component, the surface and motion rules it must follow, the states it can express, and what to avoid. Pair this page with [colors.md](./colors.md), [interaction.md](./interaction.md), [motion.md](./motion.md), and [layout.md](./layout.md) — those define the underlying tokens and behaviors this page composes.

Every component below works in both light and dark modes without per-mode overrides; brand pigment is reserved for the Octobot mascot; agent identity is carried by chips and dots, never by chrome.

---

## Agent chips (signature component)

The agent chip identifies which agent is talking — in the topbar role toggle, in tool-call summaries, in queue rows, in handoff transcripts. It is the most-used custom component in the product.

**Shape**

- Soft-pastel rounded tag at the standard medium radius — *not* a full pill. Full pills are reserved for genuinely circular shapes (the edge dot itself, status indicators, avatars).
- Three colors per role from the chip palette: a soft fill, a saturated edge color, and a darker text color. See [colors.md § Agent chips](./colors.md#agent-chips).
- Mono label, small text scale, weight 500 at rest.
- Edge dot at the leading edge of the chip in the role's saturated edge color.

**Roles**

The four canonical roles each map to one chip color. The mapping is fixed; do not reuse a role's color for any other purpose.

| Role | Chip color |
|---|---|
| `openagentd` (router) | Mint / green |
| `executor` | Blue |
| `consultant` | Orange |
| `explorer` | Pink |

**States**

Selection is communicated by pigment depth and outline, not by container shape — the chip never changes radius, fill family, or layout between states.

| State | Treatment |
|---|---|
| Idle | Soft fill, edge dot at full saturation, label weight 500 |
| Hover | Label weight shifts 500 → 600. No fill change (pigment is already there) |
| Selected | Same soft fill, label weight 600, 1.5px ring in the role's edge color, subtle drop shadow |
| Streaming | Edge dot pulses; chip itself stays static |
| Idle/dim | Used in the topbar when an agent is registered but not the active one — reduce dot opacity, keep label readable |

**Don't**

- Reuse a chip color outside its role (no mint anywhere except `openagentd`).
- Replace the soft fill with the saturated edge color in selected state — the result loses readability.
- Drop the edge dot. The dot doubles as a status anchor (pulse on streaming, dim when idle).
- Use a chip as a generic button. If a control doesn't refer to an agent role, use the [Buttons](#buttons) family.

---

## Buttons

A small, rigid family of variants. Pick by role, never by visual preference.

| Variant | Role | Surface |
|---|---|---|
| Primary (default) | The single most important action in a region | Filled in `--color-accent`, text in `--color-text-on-accent`, no border |
| Outline | Neutral or secondary actions; cancel; "view more" | `--bg-page` fill, `--color-border` outline, hover deepens both |
| Secondary | Used inside cards/dialogs where outline would clash | `--bg-key` fill, `--color-border` outline |
| Ghost | Tertiary, mostly icons; "skip", "close", inline edit | Transparent fill, hover wash on `--bg-key` |
| Destructive | Removes data or breaks state (delete, revoke) | Soft `--color-error-subtle` fill, `--color-error` text and border at low alpha |
| Link | Inline navigation that visually reads as text | No fill, accent-blue text, underline on hover |

**Shared rules**

- One radius family across the variants — primary/outline/secondary at the standard small button radius, icon-only variants use the same family one step smaller.
- Sizes are token-driven: extra-small, small, default, large, plus icon-only equivalents at each size. Pick the smallest size that meets the 44×44 touch target on mobile.
- Font weight follows [interaction.md § Font-weight transitions](./interaction.md#font-weight-transitions-signature). Icon-only buttons skip the transition (there is no text to shift).
- Loading state: replace the label with progressive text ("Saving…", "Connecting…"); never show a spinner *and* keep the original label.
- Disabled state: 50% opacity, `cursor: not-allowed`, `aria-disabled`. Disabled is *unavailable*; loading is *busy*. They are not the same and must not look the same.

**Don't**

- Build a custom button by hand-stacking utilities. Reach for the `Button` primitive; if its variants don't fit, the variant set should grow rather than be bypassed.
- Pair two primary buttons in the same action cluster. There is one primary action per region; everything else is outline/ghost/destructive.
- Use destructive coloring for "discard draft" or other reversible actions. Reserve it for irreversible loss.

---

## Card

A card separates a self-contained unit of content from the surrounding page. The OpenAgentd card is a calm paper rectangle — warm fill, hairline border, generous corner radius — and that is it.

**Rules**

- Outer surface: `--bg-card` on `--color-border` with a generous corner radius (the larger end of the radius scale; compact cards trim down but keep the same family).
- The border alone carries elevation. No drop shadow, no ambient ring, no double outline.
- Internal padding is consistent across the card; compact variants reduce padding uniformly.
- A footer-style chrome region distinguishes itself with a subtle `--bg-key` wash and a top divider — never a different border color or a heavier surface.
- Reach for the shared `Card` family before rolling a hand-built surface; if the slots don't fit, repeat the same recipe inline rather than inventing new tokens.

**Don't**

- Layer shadows on flat cards. Only floating chrome (the queue banner, the input bar, popovers) earns a soft depth shadow.
- Mix `--border-card` with `--color-border` in the same surface — `--border-card` is deprecated; use `--color-border`.
- Use `ring-*` for separation; rings are reserved for focus and decorative chip outlines (see [interaction.md § Anti-patterns](./interaction.md#anti-patterns)).

---

## Status indicators

Every status pairs color with an icon or label — never color alone. See [colors.md § Status](./colors.md#semantic-status-colors) for the token set.

**Patterns**

- Running: pulsing dot in `--color-success` with a written label ("Running", "Streaming").
- Error: `lucide AlertCircle` in `--color-error` with a written label ("Failed").
- Success (static): `lucide CheckCircle` in `--color-success` with a written label ("Completed"). Static success uses no animation; only transient confirmations pulse.
- Pending / queued: `lucide Clock` in `--accent-orange-text` with a written label ("Queued").

**Don't**

- Rely on color alone (no plain red dot, no plain green checkmark without a label or accessible name).
- Wrap status in a chip with a role color (mint, blue, orange, pink). Status indicators are neutral; agent identity is conveyed elsewhere.

---

## Forms

Form layout, field anatomy, and validation behavior. Use the shared form primitives (`Input`, `Textarea`, `Select`, `RadioGroup`, `Switch`, `Checkbox`, `NumberInput`, `DateTimePicker`) — they share a single field shell so a form composed of mixed types still feels like one form.

**Field anatomy**

- Label above the field, weight 500, `--color-text`.
- Field surface: `--bg-input` fill, 1px `--color-border`, standard small radius. Focus replaces the bottom border with `--color-accent` and adds a 2px focus ring (see [interaction.md § Focus ring](./interaction.md#focus-ring-specification)).
- Help text below the field, small text scale, `--color-text-muted`.
- Error text replaces help text on validation failure: `--color-error`, with `lucide AlertCircle` glyph at the leading edge. The field gains `aria-invalid="true"` and `aria-describedby` pointing at the error.
- Required indicators are written ("Required") rather than starred. If a star is used it must repeat the meaning in an accessible name.

**Boolean toggles**

- Use `Switch` for on/off feature flags and reversible setting toggles. The switch reads as "this is the live state of a thing".
- Use `Checkbox` for multi-select selections in a list, or for compound consent ("I agree to…").
- Do not use a native `<input type="checkbox">` to mean a feature flag. Everything that toggles a runtime behavior is a `Switch`.

**Selects and pickers**

- Use the shared `Select` (built on base-ui) for any single-choice picker — its trigger inherits the same field shell as `Input`.
- For numeric ranges where stepping matters, use `NumberInput` rather than a `<select>` with hard-coded options.
- For dates and times, use `DateTimePicker`. Do not roll a bespoke pair of inputs.

**Don't**

- Place validation messages above the field — they belong below where the eye lands after typing.
- Use placeholder text as the only label. Placeholders disappear when the user starts typing and are inaccessible.
- Combine a busy state and a disabled state visually. A submitting form locks input and shows progress; a disabled form has reduced opacity. They are different intents.

---

## Code block

Code is rendered with JetBrains Mono and the syntax tokens from [colors.md § Syntax highlighting](./colors.md#syntax-highlighting--code).

**Rules**

- Block surface: `--color-surface` on 1px `--color-border`, standard small radius.
- Inline code: `--bg-key` wash on a tighter padding, no border. Same mono family as block code.
- Long blocks scroll horizontally; lines never wrap mid-token.
- Copy controls (when present) live in the top-right corner, ghost-button-sized, revealed on hover and persistent on focus. They do not occupy layout space.

For rendered markdown, use the `.prose` class — it is styled globally to consume the syntax tokens.

---

## Empty states (hand-drawn pattern)

Empty surfaces — no sessions, no tasks, no files, no agents matched a search — reuse the same hand-drawn idiom: a short Caveat callout in `--color-text-subtle`, sometimes paired with the Octobot mascot. The voice is conversational, not instructional.

**Rules**

- Caveat at the hand size from [typography.md § Hierarchy](./typography.md#type-hierarchy). Centered, with line breaks shaped to read like written speech.
- Color is `--color-text-subtle` so the callout sits one layer behind the surrounding chrome.
- Caveat is decorative; pair it with an accessible Inter equivalent in the DOM, or mark the Caveat `aria-hidden` and lift the meaning into a sibling element.
- The mascot is optional. Use it on full-page empty states (the "what's on your mind?" home screen). Skip it inside narrow popovers and inline empty rows where it would crowd the surface.

**The canonical empty room**

The home screen's empty state is the most prominent example: mascot at a moderate size, with the Caveat prompt "what's on your mind?" below it. This is the one place the prompt is allowed; do not reuse the exact phrase elsewhere.

**Don't**

- Use Caveat for instructional copy ("Click + to add a task"). Instructions belong in Inter.
- Wrap the empty state in a card. Empty states sit on the ambient page surface; the chrome is what is missing, not what is present.

---

## Error state page

Full-page error (session timeout, route not found, fatal config error). Composition: a single error glyph at large size, a heading at h1 scale, an explanatory paragraph at body scale, and one or two recovery actions.

**Rules**

- Glyph: `lucide AlertCircle` in `--color-error`, large icon size.
- Heading: Inter bold at h1.
- Paragraph: `--color-text-muted`, max measure ~50ch, may include inline `code` references to the relevant config keys.
- Actions: a primary button to retry or recover, plus an outlined or link-styled secondary path to documentation.
- Layout sits on the page surface — no card, no border. The error is the surface.

---

## Modal / dialog

A modal interrupts the user to demand a decision or surface critical information. It is the heaviest piece of chrome the UI uses; reach for a popover, drawer, or inline disclosure first.

**Surface**

- Same recipe as [Card](#card) — paper fill, hairline border, generous radius.
- A translucent backdrop tints the page so the modal reads as elevated *without* a drop shadow. The warm border carries the rest of the elevation.
- A header region holds the title (semibold, h3 scale) and an optional one-line description (`--color-text-muted`).
- A footer region (when present) inverts to the `--bg-key` wash, separates with a top divider, and right-aligns the action cluster on `≥ sm` viewports.

**Behavior**

- Focus is trapped inside the panel. The first focusable control receives focus on open.
- `Esc` always closes (except for explicit confirmation flows that require an action). Focus returns to the trigger.
- A close button is offered in the top-right by default; opt out only when the dialog is unconditionally dismissable.
- Animate in with fade + zoom over the standard motion duration; reverse on close. See [motion.md](./motion.md).
- Scrolling is scoped to the dialog body, never the page beneath.

**Composition**

- Action buttons follow the [Buttons](#buttons) hierarchy — one primary, one or two secondary/outline, destructive only when destructive.
- Forms inside the dialog use the standard field rules.

**Don't**

- Stack modals. If a confirmation is needed mid-flow, replace the current modal or use an inline confirmation step.
- Add a drop shadow or `ring-*` to the panel — the backdrop and border are sufficient.
- Use a modal for non-blocking information; toast or inline status patterns are better.

The same chrome is reused by drawers (sheets), popovers, dropdown menus, and command palettes — when a floating surface is needed, pick the primitive that matches the interaction model rather than hand-rolling another portal.

---

## Sidebar navigation

The left rail is the persistent home for: brand identity, primary nav actions, and the recent-session list. It collapses to an icon-only strip on desktop and slides in as a full-width drawer on mobile.

The sidebar composes two reusable primitives: a brand header and a sidebar item. Compose, do not bypass.

### Brand header

- A 16-unit-tall row containing the mascot, the wordmark, and a dock-toggle button.
- Mascot: app icon at 44×44, no decoration.
- Title: Caveat at 28px, bold, `--color-text`. The wordmark is decorative chrome — it is also conveyed by the document title and by the logo asset itself, so a screen reader will still encounter "OpenAgentd" elsewhere.
- Subtitle: mono 11px, `--color-text-muted`, reading "on-machine ai".
- Dock toggle: outlined icon button on the right; flips icon between collapse and expand based on the rail's current state.

### Sidebar item

- Icon + label + optional keyboard hint, in a single row.
- Two render modes:
  - Expanded: `[icon] [label …………] [kbd?]`. Padding sits at the standard nav scale; row height ~10 spacing units.
  - Collapsed: `[icon]` centered in a square cell of the row's height. Label is removed from the DOM (not just visually hidden) so the rail computes correctly.
- Active state uses `--bg-key` fill with `--color-text` and weight 500. Hover uses the same fill and bumps weight from 500 to 600 (see [typography.md § Font-weight transitions](./typography.md#font-weight-transitions-signature-interaction)).
- Keyboard hint pill renders as outlined `--color-border` on `--bg-page` with mono text — only visible in expanded mode. On collapsed rails the shortcut is surfaced via the row's `title` attribute instead.

### Recent sessions

- Grouped by relative date headers ("Today", "Yesterday", "Older"). Headers use mono uppercase 10px in `--color-text-muted`.
- Rows keep a flat background. Hover brightens the title from `--color-text-2` to `--color-text` and bumps its weight from 440 to 500 (see [typography.md § Font-weight transitions](./typography.md#font-weight-transitions-signature-interaction)); secondary lines lift one step from `--color-text-subtle` to `--color-text-muted`. The proximity-fade pattern that previously washed the row background has been retired in favor of this text-only affordance — heavy backgrounds in a dense list were strobing more than they were helping. Active row still uses a solid `--bg-key` fill.
- A delete affordance lives at the trailing edge of each row. On desktop it is hidden until hover; on mobile it is always visible (touch has no hover state).
- Scheduled sessions add a "sched" mono badge after the title and a second line with the schedule name in `--color-text-subtle`.

### Collapsed rail

- Width snaps to a single icon's worth of horizontal space; row height is preserved.
- Recent sessions degrade to a vertical column of small dots (one per recent session, capped). The active session's dot uses `--color-accent`.
- Footer keeps the theme toggle; the health dot is dropped in collapsed mode.

### Mobile drawer

- Slides in from the left over a translucent backdrop. The drawer is always at expanded width; there is no icon-only mode on mobile.
- Tapping the backdrop or selecting a session closes the drawer.
- Brand header's dock-toggle is repurposed to a close action; the chevron icon is the same.

### Don't

- Replace `bg-(--bg-sidebar)` with `bg-(--bg-page)`. The sidebar is one tonal step warmer than the page on purpose; the rail must read as part of the chrome.
- Use a different active-state color from the rest of the nav. Sidebar items, command palette rows, and topbar tabs share the `--bg-key` active wash for consistency.
- Hide the active session in collapsed mode. The dot column must always show the current session at full color.

---

## Theme toggle

A three-state segmented control (`system` / `light` / `dark`), persisted to `localStorage`, applied without a flash of the wrong theme on first paint (see [layout.md § Mode switching](./layout.md#mode-switching)).

**Rules**

- Three icon-only buttons in a single rounded outline (`--bg-card` fill, `--border-card` outline). Icons: `lucide Monitor` / `lucide Sun` / `lucide Moon`.
- Active button uses the inverted-paper recipe: `--bg-send` fill, `--color-text-on-accent` glyph. Inactive buttons stay transparent with `--color-text-muted` glyphs.
- The control is a `radiogroup` with `aria-checked` per button. Labels live on `aria-label` only; the icons are too dense for visible text.
- Reduced motion still applies to the cross-fade between themes — flashes longer than 80ms read as broken.

---

## Thinking indicator (streaming)

A paper card that records an assistant turn's reasoning. It collapses to a one-line header and expands to reveal the full trace. It is part of the assistant turn, not a free-floating ornament.

### Resting / collapsed

A single header row: chevron, label, sub-hint.

- Outer surface: small radius, 1px `--color-border`, no fill — the row sits on the ambient chat surface.
- Chevron points right at rest, rotates 90° when expanded; muted text color.
- Label: Inter 13px, medium weight, `--color-text-2`. Default text is "Reasoning".
- Sub-hint: mono 11px, `--color-text-muted`. Reads "tap to read" when collapsed, "tap to collapse" when expanded.

### Streaming

While reasoning tokens are still arriving, replace the sub-hint with the three-dot animation. The label stays as the visual anchor; the row never reflows mid-thought.

### Label derivation

The label may be promoted from the first non-empty line of the reasoning content, but only once that line has *finalised* — meaning a newline has arrived, or a leading bold heading has closed. Promoted labels are cleaned of common markdown decorations and capped to a short character budget; longer or still-streaming first lines stay on "Reasoning" rather than thrashing or truncating.

When the first line is promoted to the label, the expanded body omits it to avoid duplication.

### Expanded body

A divider separates the header from the body. The body uses the calm `--bg-key` reading wash, mono italic at the small text scale, in `--color-text-muted`. Whitespace is preserved.

The same divider + `--bg-key` wash is shared with the [tool-call row](#tool-call-row) expanded panel — these two surfaces are deliberately sibling-shaped so a turn's reasoning + tool calls + answer scan as a single unit.

### Don't

- Use three free-floating pulse dots inline with prose. That pattern is reserved for waiting/spinner contexts; reasoning always gets the paper card.
- Color the dot or border by agent role. Reasoning belongs to the assistant turn as a whole; agent identity is carried by chips and bubble flow, not by reasoning chrome.
- Mutate the label character-by-character while streaming. Only promote first lines that have finalised.

---

## Streaming cursor

A blinking caret trailing live-streamed text. Spec in [motion.md § Streaming cursor](./motion.md#streaming-cursor-blink).

- Half-character-width vertical bar in `--color-text`, full line-height tall.
- Two-step blink at 1s — fully on, fully off; no fade.
- Removed the moment streaming ends or a tool call starts. A blinking caret with no live generation is a bug.

---

## Tool-call row

A compact inline record of one tool invocation. Identity is carried by the humanized tool label plus a deterministic summary, not a tool icon, so the same chrome serves every tool the agent might call.

### Lifecycle

| State | When | Header treatment |
|---|---|---|
| Start | Tool name has arrived but arguments have not | Humanized tool label, or a pending-state summary for tools that opt in |
| Running | Arguments are streaming, no result yet | Header text pulses with the running color |
| Success | Result has landed and does not look like a failure | Header returns to normal text treatment |
| Failed | Result begins with a known failure prefix or a non-zero exit signal | Header returns to normal text treatment; failure is visible in result content |

The failure detection is conservative: prefer false negatives over false positives. A call is considered failed only when the result text matches one of the agreed failure shapes (e.g. `[failed`, `[error`, `exit code 1`, `exit 1`). Tool result formatters must use those prefixes consistently so the indicator stays trustworthy.

### Chrome

- Collapsed row: no enclosing card and no fill; it sits on the ambient chat surface so a stack of tool rows reads as lightweight inline telemetry.
- Header row: mono `text-sm`, bold humanized tool label, optional `: summary` in normal weight, chevron immediately after the phrase when expandable.
- Hover treatment changes text color only when the row is expandable. A row with no details is non-interactive and skips the chevron.
- Expanded body: one codeblock-style `surface-raised` container with `--bg-card`, 1px `--color-border`, and section header strips on `--bg-key`. Sections are captioned with mono uppercase 10px in `--color-text-muted`, with copy-to-clipboard affordance where content is visible.
- Result bodies cap at `max-h-80` with internal scrolling so long tool output does not stretch the chat transcript.

### Per-tool customisation

Tools may customise the header summary (e.g. `Read: Reading src/main.py` instead of a raw backend name) and the way arguments are rendered (e.g. shell commands prefixed with `$`, redundant query/path args hidden when already represented in the summary). That customisation is per-tool and lives next to the chrome, not inside it. The chrome rules do not change between tools.

### Don't

- Add a wrench (or any tool icon) to the header. The humanized tool label is the identity anchor; an icon adds noise without information.
- Tint the result body green or red to match status. The details container should stay neutral so long output remains readable regardless of outcome.
- Fill the collapsed row. Leave it transparent so the row blends into the chat surface; only the expanded body gets a fill.
- Use the deprecated `--border-card` token; use `--color-border`.

---

## Agent topbar

The chat surface's right cluster — the consistent bar of controls that follows the user across agent / split / unified views. It sits at the trailing edge of the topbar; the left side varies per view mode.

The topbar is composed from smaller primitives. Each primitive owns its appearance; the topbar owns the order and the visibility rules.

**Primitives in the right cluster (in order)**

1. **Token meter** — desktop only, hidden until totals exceed zero. Shows `input · output · cached` tokens in mono 11px on a transparent background; cached column appears only after the first cache hit. A pulsing dot may follow the numbers while values are still climbing.
2. **Split-pane controls** — desktop only, only meaningful in unified view. Two icon-only ghost buttons for "split down" and "split right".
4. **View toggle** — desktop only. Three-state segmented control for `agent` / `split` / `unified`. See [View toggle](#view-toggle).
5. **Topbar action triplet** — Todos, Files, Agents. Each is a small icon+label button (see [Topbar action](#topbar-action)).

**Visibility rules**

- Mobile collapses everything except the action triplet — token meter, split controls, and view toggle are all desktop-only.
- The topbar is a `shrink-0` flex row. The left side of the topbar must own its `min-w-0` so the topbar never pushes content off-screen.

**Don't**

- Mix the topbar action triplet with the view toggle order. The order is fixed; users learn the position of each control across sessions.
- Use a chip-colored indicator on a topbar action to signal an open panel state. Use the small accent dot on `TopbarAction` (`indicator`) — that affordance is reserved for that purpose.

---

## View toggle

Three-state icon-only segmented control for chat view modes — `agent` (single agent focus), `split` (default desktop view; automatic panes for live agents), `unified` (manual tiled view).

`split` view is automatic: when the live roster gains a spawned agent, that agent claims the next pane with a short enter animation; when a member goes `offline`, its pane exits before closing. The layout grows by square capacity — one pane fills the view, two panes sit side by side, three uses one full-height pane plus two stacked panes, and four becomes a 2×2 grid.

**Rules**

- Three equally-sized icon-only buttons inside a rounded outline. Outline uses `--color-border-subtle`; padding inside is half a unit.
- Active button: `--color-surface-2` fill, `--color-text` glyph. Inactive: transparent fill, `--color-text-muted` glyph that hovers to `--color-text-2` on `--bg-key`.
- Icons are mapped to the closest lucide equivalents of the design source's Material Symbols `person` / `view_column` / `view_quilt` (currently `User` / `Columns2` / `LayoutGrid`).
- Implemented as a `radiogroup`; per-button `aria-checked`. Labels live on `aria-label` and `title` only — the control is too dense to fit visible labels in the topbar; tooltips surface them on hover and on focus.

**Don't**

- Re-skin the active button as a primary-button surface (`--color-accent`). The toggle communicates a *view mode*, not a primary action; it must stay neutral.

---

## Topbar action

Small icon+label button used in the agent topbar (Todos, Files, Agents).

**Rules**

- Padding sits at the compact scale, gap between icon and label is a single spacing unit, radius at the small scale.
- Transparent fill at rest; hover wash on `--bg-key` with the label color shifting from `--color-text-2` to `--color-text`.
- Lucide icon at 13px, label at 12px weight 500. Both inherit the same color.
- Disabled state reduces opacity to 50% and removes the hover wash.
- Labels are hidden on narrow viewports by default but stay in the DOM as accessible names. Optional small accent dot at the trailing edge signals an active or in-progress state; an override color (e.g. `--color-error`) is allowed for error states.

---

## Todos popover

Task-list popover surfaced from the agent topbar. Trigger is a `TopbarAction`; content is a paper-card panel.

**Trigger**

- Uses the `TopbarAction` primitive directly so it sits inline with Files and Agents.
- The accent dot is shown when any task is in progress.
- Disabled (with a "No active session" tooltip) when there is no session.

**Panel chrome**

- Surface: medium-width panel, small radius, `--color-surface` fill, 1px `--color-border` outline (no shadow ring), shadow at the depth scale because the panel floats over chat.
- Header: mono uppercase 10px title ("Tasks"), mono completion counter ("3 / 8 done") aligned to the trailing edge.
- Empty state: each status column shows a hand-drawn Caveat `Nothing here` callout in `--color-text-subtle`.

**Item rules**

- Sort order: in-progress, then pending, then completed, then cancelled.
- Status glyph leads the row, sized small. Completed and cancelled rows use `line-through` and shift the text to `--color-text-subtle`.
- Priority badge trails the row in mono uppercase 9px on a soft fill: high uses `--color-error` at low alpha, medium uses `--color-warning` at low alpha, low uses `--bg-key` neutral.

**Don't**

- Color the status glyph by agent role. The popover represents the assistant's task list as a whole.
- Use the chip palette for priority. Priority is a status concept, not an identity concept.

---

## File preview strip

A horizontal row of file-preview chips below or above the input bar. Used by the input composer when files are attached or staged.

**Rules**

- Single row; horizontal scroll, never wrap.
- Image attachments render as compact thumbnails (capped at a moderate max edge); other files render as the shared `FileCard`.
- When the row content overflows the visible width, a thin scroll-position pill appears below the strip — a 3px-tall track with a thumb that mirrors current scroll position. The pill is hidden when content fits.
- Direction (above vs. below the input) is set by the parent based on docking position. The input bar's parent owns the rule and passes the direction to the strip; the strip never decides for itself.

---

## Input bar (floating composer)

The input bar is a paper capsule floating above the conversation. It is the most-touched surface in the product and follows two distinct mode rules.

### Surface

- `--bg-card` fill (slightly translucent to allow background blur), 1px `--color-border` outline, depth shadow because the bar floats. Radius at the largest scale in the system — the bar reads as a *physical writing instrument*, not a toolbar.
- Padding is compact; the bar grows vertically with the textarea up to a maximum height, then scrolls internally.

### States

| State | Cue |
|---|---|
| Empty | Placeholder text, send button at reduced opacity |
| Typing | Send button at full opacity; optional character counter on long messages |
| Streaming | Send button is replaced with a stop control; the bar's border picks up a thin accent in the active agent's chip color |
| Queue armed | A queue badge appears above the bar (`+1 message · enqueued`); see [Queue banner](#queue-banner) |
| With attachments | Attachment chips render adjacent to the bar via the [File preview strip](#file-preview-strip) |
| Minimized | Desktop only — collapses to a slim icon strip when the textarea blurs while empty |

### Desktop minimize / summon

A blurred composer should not dominate the chat surface, but the user must be able to summon it from anywhere. The bar collapses and expands by the same set of rules:

- Starts collapsed on first paint. The slim icon strip is the resting state on desktop.
- Expands on focus, on attaching a file, while streaming, while there is queued content, while disabled (waiting for a response), or while content is held inside the composer.
- Collapses again after a short delay following blur, but only when there is genuinely no content. The delay is short enough to feel snappy and long enough to avoid collapsing mid-action when the user clicks an adjacent control inside the bar.
- A global shortcut (`Ctrl/⌘+I`) summons the composer from any focus context. The textarea takes focus and the bar expands if needed.

Mobile keeps the full bar at all times — the soft keyboard already dictates focus cadence, and a collapse race there would feel broken.

### Drag (desktop)

- The bar is draggable from a top-edge grip handle; pointer events outside the grip do not initiate drag.
- Position persists across sessions; on resize the position is clamped so the bar stays inside the viewport.
- A double-click on the grip resets to the default docked position (bottom-center with a small gap).

### Mobile dock

- Static, full-width, pinned to the bottom of the viewport.
- A top border separates the dock from the chat above; bottom padding accounts for the home indicator (`pb-safe`).
- No drag, no position memory — the keyboard owns the bottom region and any motion would fight the system.

### Attachment direction

The parent (`FloatingInputBar`) computes whether previews render above or below the bar based on the bar's distance from the viewport bottom: previews default to *below*, and only flip to *above* when the bar is docked near the top of the chat region. The rule recomputes on mount, on window resize, on drag end, and on reset.

### Don't

- Replace the depth shadow with a heavier border. The bar floats; the shadow is what communicates that.
- Use the bar's radius scale anywhere else. The 24-ish-px corner is reserved for the composer.
- Show the slim minimized strip on mobile.

---

## Draggable panes

Side-by-side and tiled agent panes use the same handle-only drag pattern. Drag is gated to a visible grip; the rest of the pane remains a normal click/scroll target. The pane is a valid drop target via `onDragOver` / `onDrop` on its root.

- Grip: `lucide GripVertical` (or `GripHorizontal` for top-mounted handles), `--color-text-muted`, sized small.
- Cursor: `grab` at rest, `grabbing` while pressed.
- Use the framework's drag-controls pattern — start drag manually from the grip's pointer-down — so the handle is the only drag entry point.

---

## Queue banner

When messages are enqueued behind a streaming response, an aggregate banner sits above the input bar. It is the only place orange-marker pigment is reused outside the chip palette.

**Rules**

- Surface: `--color-surface` fill, 1px `--color-border` outline, depth shadow because the banner floats near the input bar. Small radius.
- Header text: mono 11px, weight 600, letter-spaced; reads `QUEUE · N messages awaiting`. The pluralization is computed from the count.
- Marker dot at the leading edge: `--color-marker-orange`. Optional collapse chevron at the trailing edge when the banner is interactive.
- Status semantics: when the banner is not interactive, it is a `role="status"` with `aria-live="polite"`. When interactive, it is a button with `aria-expanded`.

Per-message rows below the banner are owned by the pending-queue list, not by the banner itself.

**Don't**

- Use chip-soft / chip-edge / chip-text orange tokens for the banner. The marker tokens are deliberately more saturated; the banner is intentionally louder than a chip.
- Stack a queue banner inside a card. The banner is itself a floating chrome surface.

---

## Token meter

Compact pill that shows token totals in the agent topbar.

- Mono 11px, padding compact, radius at the small scale, no fill.
- Numbers in `--color-text`; `·` separators in `--color-text-muted`.
- Cached column appears only when its value exceeds zero — a fresh session shows two numbers, not three.
- Optional pulsing dot to signal that values are still climbing during a stream.

---

## Pre-ship checklist

Before shipping a new component or screen:

- Tokens used everywhere — no raw hex values anywhere in component CSS or inline style.
- Both modes verified by toggling `system → light → dark`. Nothing flickers, nothing inverts incorrectly.
- Body text is Inter; code text is JetBrains Mono; Caveat is opt-in only on hand callouts.
- Spacing aligns to the 4px base; radii come from the radius scale; no magic px values.
- Focus ring visible on `:focus-visible` for every interactive element. Tab through the surface to verify.
- Body text contrast ≥ 4.5:1 against its surface (Lighthouse / WebAIM).
- Icons come from `lucide-react`, sized to [imagery.md § Sizing](./imagery.md#sizing).
- Status colors are paired with an icon or label; no color-alone signals.
- Agent chips use the correct role triad — soft fill, edge dot, text. No reuse of role colors outside the role.
- Brand pigment (Octobot) is on the mascot and lockups only — never on UI chrome.
- Motion durations and easings come from [motion.md](./motion.md); `prefers-reduced-motion` is honored.
- Font-weight transitions are on interactive elements only; never on Caveat.
- Keyboard navigation works end-to-end with logical tab order and no traps.
- Touch targets ≥ 44×44 on mobile.
- Empty, error, and loading states are all designed and present.
