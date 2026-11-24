# Design: colour, type, shape and depth

Part of the design system. [`DESIGN.md`](../DESIGN.md) holds the tokens and the map of chapters.

## Colors

The palette is a warm neutral ramp — cream through sepia to ink — with color
reserved almost entirely for *meaning*. Nothing is decorative.

- **Primary (#3F3429) — "Bark."** The UI accent. Warm dark brown-grey used for
  emphasis, selected states, and the inverted send action. Deliberately near-ink
  rather than a saturated brand hue: the loudest thing on screen should be the
  user's content, not the chrome.
- **Secondary (#6E604F) — "Sepia."** Utility text: metadata, timestamps,
  placeholders, inactive labels. Passes AA on every paper surface.
- **Tertiary (#5AA8E2) — "Signal Blue."** The logo's dot (the agent) and
  keyboard focus, nothing else. Blue is used for the focus ring instead of
  Bark because a near-ink ring reads as a hard rectangle rather than an
  affordance. Links and file names are ink with a `border-strong` underline;
  info chips and callouts are ink on the keycap wash; checked boxes, radios
  and switches fill with the accent (Bark on paper, cream on dark); text
  selection takes `fill-selected`; hover, drag, drop and open states use the
  warm ramp. Data keeps its own hues (syntax, charts, terminal colours).
  Lint: `stray-blue`, `focus-colour-off-focus`.
- **Neutral (#FAF6EC) — "Paper."** The page foundation. Warmer and softer than
  white, which keeps long agent transcripts comfortable.

### Surface ramp

Surfaces step tonally, not by elevation. Cards sit *lighter* than the page:

`bg-sidebar (#F5EFDD)` → `bg-page (#FAF6EC)` → `bg-card (#FFFBF1)` → `surface (#FFFDF7)`

`bg-key (#F0E9D4)` is the "keycap" wash — hover and pressed states, the header
strips of dense section cards, and keyboard-shortcut badges. `bg-send (#2D241B)` is the one
inverted surface, reserved for the composer's send action.

### Selection fills

A chosen segment, tab or question option fills with `fill-selected` and sets
its text in `on-selected`; a tooltip is a
`bg-tooltip` chip. The fills read **at a glance** but stay calm: a tone
1.4–1.8:1 off the track and the menu, with the normal text colour on it, as a
native segmented control marks its choice (a 1.2:1 step left Light / Dark /
System looking unchosen). Paper stays light: a sand fill (`#D2C19B`, 1.46:1
on the keycap track) with ink, a pale rose for a destructive row, and a light
tooltip card with a hairline edge; no Bark blocks. Dark is **not** the
near-white accent (a cream block on a dark window glows brighter than the
words around it) but a raised warm tone (`#4A3C2E`, 1.47:1 on its track).
Text on a chosen fill is always `on-selected`: muted text falls under AA
there. Increase contrast lifts both fills to 3:1 against the track (Bark in
light). `token-pairs.test.ts` holds the range and keeps light
fills light and dark fills well below the text tone, and the lint
(`accent-selection-fill`) stops a selection reaching for the accent.

The menu row under the pointer or the keyboard takes `fill-highlight` with
`on-highlight`: a wash softer than a chosen segment (1.12–1.35:1 on the menu;
`#EFE7D3` on paper, `#372D22` on dark), as a native list's hover, because it
follows every pointer move and a sand block would darken each row it crosses.
The ✓ marks the chosen row, not the fill. Increase contrast lifts it to 3:1
like the other fills.

A control resting on the keycap wash (a default or subtle button, a chip, a
question's unchosen option, a copy button on a code block) hovers to
`fill-key-hover`, half way between `bg-key` and `fill-selected` (`#E9E0C8` on
paper, `#332A20` on dark), never to a border tone: the border sand is as dark
as the chosen fill, so a hovered option looked picked. A press steps on to the
border tone. Lint: `border-tone-hover`.

### Agent identity chips

Each concurrent agent gets a stable identity color from a six-hue set (blue,
green, orange, pink, purple, red). Every hue ships as a triplet: a **solid**
(dot, border), a **soft** container, and a **text** tone tuned for AA against
that container. Identity hues carry no semantic weight — blue does not mean
"info" when it appears on an agent chip.

### Semantic state

`success` / `warning` / `error` intentionally reuse the chip palette so the
total number of hues in the system stays small; `info` (running, starting,
notices) is quiet, `on-surface-2` on the keycap wash, so only real states
carry a hue. Diff and syntax colors are
separate scales tuned for dense monospace reading.

### Dark mode

Dark mode keeps the ramp's *ordering* — the sidebar below the page, cards above
it — shifted into brown-black rather than blue-black. It is not an inversion of
the tones: `bg-sidebar` stays the recessed rail on both sides, so cards inside
the sidebar and the dock remain distinguishable from their container.
Front-matter tokens carry the canonical light values; substitute these when
`color-scheme: dark`:

| Token | Light | Dark |
|---|---|---|
| `bg-page` / `bg-input` | `#FAF6EC` | `#15110D` |
| `bg-sidebar` | `#F5EFDD` | `#110D0A` |
| `bg-card` | `#FFFBF1` | `#1C1813` |
| `bg-key` | `#F0E9D4` | `#2A2219` |
| `bg-send` | `#2D241B` | `#F5EBD8` |
| `fill-selected` / `on-selected` | `#D2C19B` / `#1A1714` | `#4A3C2E` / `#F5EBD8` |
| `fill-highlight` / `on-highlight` (menu row under pointer or keyboard) | `#EFE7D3` / `#1A1714` | `#372D22` / `#F5EBD8` |
| `fill-key-hover` (keycap control, hovered) | `#E9E0C8` | `#332A20` |
| `fill-danger` / `on-danger` (highlighted destructive row) | `#F7DCD6` / `#991B1B` | `#6B2724` / `#F5EBD8` |
| `bg-tooltip` / `tooltip-text` / `tooltip-border` | `#FFFDF7` / `#1A1714` / `#D9CFA9` | `#2E251C` / `#F5EBD8` / `#4D3E2D` |
| `switch-on` | `#3F3429` (accent; white thumb) | `#F5EBD8` (accent; near-black thumb) |
| `surface` / `surface-2` | `#FFFDF7` / `#F5EBD8` | `#221C16` / `#2A2219` |
| `color-bg-elevated` | `#FFFDF7` | `#221C16` |
| `border-subtle` / `border` / `border-strong` | `#E7DCBF` / `#D9CFA9` / `#B8A47E` | `#2C231A` / `#3A2F23` / `#6A5640` |
| `on-surface` | `#1A1714` | `#F5EBD8` |
| `on-surface-2` | `#4B3E32` | `#D3C5AD` |
| `on-surface-muted` | `#6E604F` | `#AF9F85` |
| `on-surface-subtle` | `#7A6A54` | `#A4937B` |
| `primary` (accent) | `#3F3429` | `#F5EBD8` |
| `accent-blue` (solid / soft / text) | `#5AA8E2` / `#DCEEFB` / `#174A73` | `#7CC2F0` / `#1E3A52` / `#9DD0F5` |
| `focus-ring` | `#2569A0` | `#7CC2F0` |
| `accent-green` (solid / soft / text) | `#3DA66A` / `#E2F2E5` / `#15573D` | `#5DC487` / `#1F3A2A` / `#92E0B0` |
| `accent-orange` (solid / soft / text) | `#F59E3B` / `#FFF1D8` / `#873E05` | `#FDB75D` / `#3D2D14` / `#FCC780` |
| `diff-add` (bg / text) | `rgba(22, 163, 74, 0.16)` / `#166534` | `rgba(16, 185, 129, 0.10)` / `#86EFAC` |
| `diff-del` (bg / text) | `rgba(185, 28, 28, 0.14)` / `#991B1B` | `rgba(239, 68, 68, 0.10)` / `#FCA5A5` |
| `error` | `#B91C1C` | `#F87171` |
| `overlay` | `rgba(26,23,20,.40)` | `#00000099` |

Agent and syntax hues brighten and desaturate in dark mode (e.g. `accent-blue`
`#5AA8E2` → `#7CC2F0`); soft containers become deep tints of the same hue.

### Contrast with the palette we have

Every text-on-surface pair reaches WCAG AA, and every state a control shows
(chosen, on, checked, focused) reaches 3:1 (WCAG 1.4.11, 2.4.13). WCAG 2
overstates contrast near black, so dark text is also set by eye with APCA:
the ramp reads Lc 95 / 72 / 51 / 45 (text / text-2 / muted / subtle) on the
dark page, in line with GitHub, Material and macOS secondary text (Lc 45–50);
the old Lc 40 / 34 looked dim at 12px. `styles/token-pairs.test.ts` measures
each pair in both themes, and the lint enforces the rules below:

- **Subtle text sits on the page or the sidebar only.** On a wash (`bg-key`,
  soft chips, selected rows) or a card, use `on-surface-muted` (lint:
  `subtle-on-wash`).
- **Text in a hue uses its `-text` tone**, never the solid (`accent-green`
  is for dots and fills; `accent-green-text` for words). In light mode, status
  dots use the `-text` tone too, so a 6px dot still reads at 3:1 (lint:
  `solid-hue-text`, `solid-hue-dot`).
- **Never fade words with opacity.** A text tone at partial alpha or under
  `opacity-*` drops under AA (muted at 60% is 2.5:1): step down the text
  ramp instead. Disabled controls, decorative icons and a dragged ghost are
  the exceptions (lint: `dimmed-text`, `opacity-on-text`). Data graphics
  (Telemetry bars, chart markers) stay solid, 3:1 on the card.
- **Checkbox and radio** strokes are 1.5px `on-surface-subtle`.
- **Switch off** is a solid `border-strong` track without a border in both
  themes (2.25:1 on paper, 2.5:1 on a dark card; the lighter `border` tone
  left it at 1.5:1, its thumb lost in it); with the OS's Increase contrast
  setting it darkens to 5.6:1, and a switch always carries a text label.
- **Keyboard focus** is 3:1 on every surface, a chosen segment included: the
  light ring is Signal Blue a step deeper (`#2569A0`; `#5AA8E2` was 2.4:1 on
  paper). The logo keeps `#5AA8E2`.
- **Terminal** output is whatever programs print (ANSI black is the dark
  background), so xterm's `minimumContrastRatio` (4.5) lifts any colour under
  AA against its cell, as VS Code does.
- **Increase contrast** (`prefers-contrast: more`, `styles/tokens.css`)
  darkens every border and secondary text one step.

## Typography

Two faces, each with a non-overlapping job:

- **The system UI font** — all interface text and prose: SF Pro on macOS and
  iOS, Segoe UI Variable on Windows, Roboto on Android, the desktop's own face
  on Linux (`--font-ui` in `styles/tokens.css`). WebKitGTK does not give
  `system-ui` the desktop's face, so the Linux app reads GTK's and puts it
  first (`--font-desktop`, `public/theme-init.js`). The app reads like the
  other apps on the same machine; nothing is bundled.
- **JetBrains Mono Variable** — code, diffs, terminal output, file paths, token
  counts, IDs and `provider:model` names. Anything a user might copy, compare
  character-by-character, or scan as a column.

### The scale

Sizes are rem and follow the **Text size** setting (Settings → Appearance:
Compact · Default · Large), stored per device and applied before first paint
(`data-text-size` on `<html>`, `--oa-text-scale` in `index.css`). Text size
scales type only; spacing and hit areas stay put. On iOS, Dynamic Type
multiplies on top.

| Token | Compact | Default | Large | Used for |
|---|---|---|---|---|
| `text-xs` / `body-sm` | 12px | 13px | 14px | buttons, inputs, rows, menus |
| `text-meta` / `label-sm` | 11px | 12px | 13px | timestamps, counts, captions |
| `text-code` / `code-lg` | 13px | 14px | 15px | code blocks and code-editing fields |
| `text-sm` / `body-md` | 14px | 15px | 16px | reading passages, prose |

`body-sm` is the workhorse — the default for buttons, inputs, rows, and menus,
not a "small" variant. **11px exists only as Compact meta**; content never goes
below 12px at Default. Never write `text-[Npx]`: the lint (`px-text`) rejects it
because a pixel size ignores the Text size setting.

`label-caps` (11px, 600, +0.05em, uppercase) marks dense section-card headers
and group labels. Panel section titles are not caps: they use `text-xs` semibold (13px) in
sentence case (`TEXT.title` in `ui/panel-tokens.ts`). It is the only uppercase style in the system, and ships as the
`label-caps` utility (type only — pair it with `text-(--color-text-muted)` on
card headers, `text-(--color-text-subtle)` on nav and group labels). Use
`font-mono` with it only when the label is an identifier (a code language, a
tool name).

`text-code` (`code-lg`, 14px mono at Default, `leading-relaxed`) is the reading
step for chat code blocks and code-editing textareas, where `code-md` is too
dense for long passages. Tool output, diffs and file views stay on `code-md` / `code-sm`.

#### Icons

**Icons** (lucide) use a fixed scale: 12, 13, 14, 16px; 20px only in a
phone's bars and for empty-state illustration. 14px is the default inside
buttons (Rulebook 4; the `icon-off-scale` lint holds it).

## Shapes

The shape language is **flexible softness**. Radii are proportional to element
scale — small enough to feel precise and engineered, large enough to feel
contemporary and approachable. The system's baseline control radius is 6px,
buttons sit at 8px, and structural panels and modals scale up to 12px.

Radius maps to element scale, not to taste:

- `xs` (4px) — 24px controls, badges, keyboard shortcut caps, inline tags.
- `sm` (6px) — the default. Cards, inputs, list rows, 32px controls, code blocks.
- `md` (8px) — 36px+ buttons, icon buttons, dropdown triggers.
- `lg` (12px) — overlays, sheets, and modals. This is the ceiling for panels; every
  `AppOverlay` panel shares it so the whole overlay family reads as one system.
- `xl` (16px) — larger floating popovers and content previews.
- `2xl` (20px) — app icon and prominent media previews.
- `full` — pills only: agent chips, status chips, avatars, the send button.

`xl` through `4xl` exist for larger containers, media previews, illustration, and
marketing surfaces.

## Elevation & Depth

Depth is **tonal, not shadowed.** Hierarchy is expressed in this order:

1. **Surface step** — move one level along the surface ramp.
2. **Hairline border** — a crisp 1px `border` or `border-subtle`.
3. **Text tone** — demote content by stepping down the text ramp.
4. **Shadow** — last resort.

Only genuinely floating layers (modals, popovers, dropdowns, toasts, drawers,
tooltips) use `shadow-depth` — written `shadow-(--shadow-depth)`, never a
Tailwind `shadow-sm/md/lg` step — and it stays soft: `0 1px 2px rgba(0,0,0,.04),
0 2px 8px rgba(0,0,0,.05)` in light, roughly 6× stronger in dark where tonal
steps read weakly. In-flow cards (code blocks, tool calls, section cards) and
buttons never cast one, at rest or on hover.

Modal and drawer scrims are `bg-(--color-overlay)` with no blur; popovers do not
dim the page. The media lightbox is the one darker stage.

### Stacking

**Stacking** uses a short layer scale: 0 to 2 order inside one block (a sticky
line-number gutter, a sticky group header, the calendar's range ends), 10
in-block controls, 20 a panel's chrome over its content (find bars, anchored
comment boxes, the save bar, resize handles, the overlaid dock), 30 drawer
scrims and the desktop drawer, 40 drawers and overlay scrims, 50 overlays and
dialogs, 60 toasts and floating notices (and dialogs opened from them), 70
menus, dropdowns and popovers, 80 what stays above everything in the window (its
caption buttons, the QR scanner), 9999 tooltips. Menus render into
`document.body` (`ContextMenu`, `Dropdown`, `Popover`), never inside the panel
that opened them, whose own layer would cap theirs. Write numeric layers as
`z-60`, not `z-[60]`.

Three values sit between two layers on purpose, each for one element: 11 the
pinned fold header (over in-block controls, under a panel's chrome), 25 the
desktop drawer's backdrop (over a panel's chrome, under the drawer), 9998 the
dock's drop zone while a tab is carried (under tooltips). `design-lint`
refuses any other number, and these three outside their own files.

### One menu at a time

**One menu at a time**, as in a native app. Menus, dropdowns, popovers, the
Tasks popover and the desktop sidebar drawer are transient layers
(`lib/keyboard/layers.ts`): anything that opens over the app (another menu,
a dialog, Settings, the palette) closes them, unless it opened from inside one
(`KeyLayerScope` marks a layer's content, through portals); an app shortcut
closes them as a key equivalent closes a native menu; and so does a click
into a preview page or an MCP app's frame. Dialogs and overlays are never
closed this way.

### Focus

Keyboard focus uses a solid 2px outline (`#174A73` in light mode, `#9DD0F5`
in dark mode), with a 2px offset. Translucent `focus-ring` effects remain
decorative supplements, not the only focus indicator. A control drawn flush
in a parent that clips (a segment in its track, a tab in its strip, a menu,
palette or list row in a scroller, a status-bar item, the header's 32px
buttons) insets the outline 2px instead, so it is never cut to a stray bar:
`focus-visible:ring-inset` (or `data-focus-ring="inset"`) does both, and
`styles/focus-ring.test.ts` holds the rule. Tab in a modal stays in it,
wrapping at the last control Tab reaches. In the desktop app the
ring follows keyboard navigation only (Tab, F6; `lib/desktop-shell.ts`):
Escape, shortcuts and typing never draw it. Text fields mark focus with
their edge stepping to `on-surface-subtle` (3:1 or more), never a blue glow
(lint: `blue-field-focus`). Focus is never removed without an equally visible
replacement.
