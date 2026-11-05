---
version: alpha
name: OpenAgentd Paper
description: >-
  Warm-paper design system for a local-first agent workspace. Light mode is
  canonical; dark mode is a tonal inversion. Dense, keyboard-driven, terminal-
  adjacent — an engineer's notebook rather than a SaaS dashboard.

colors:
  # ── Semantic roles (spec convention) ───────────────────────────────────────
  primary: "#3F3429"          # Bark — UI accent / ink
  secondary: "#6E604F"        # Sepia — muted utility text
  tertiary: "#5AA8E2"         # Signal Blue — the logo dot and keyboard focus only
  neutral: "#FAF6EC"          # Paper — page foundation

  # ── Surfaces ───────────────────────────────────────────────────────────────
  bg-page: "#FAF6EC"
  bg-sidebar: "#F5EFDD"
  bg-card: "#FFFBF1"
  bg-input: "#FAF6EC"
  bg-key: "#F0E9D4"           # "Keycap" — hover/press wash, header strips
  bg-send: "#2D241B"          # Inverted ink pill (composer send)
  bg-tooltip: "#FFFDF7"       # Tooltip chip: a light card on paper, a raised warm tone in dark
  surface: "#FFFDF7"
  surface-2: "#F5EBD8"

  # ── Selection fills ────────────────────────────────────────────────────────
  fill-selected: "#D2C19B"    # Chosen segment, tab or option (a sand, 1.46:1 on the track)
  on-selected: "#1A1714"
  fill-highlight: "#EFE7D3"   # Menu row under the pointer or keyboard (a lighter wash)
  on-highlight: "#1A1714"
  fill-key-hover: "#E9E0C8"   # A control on the keycap wash, hovered: half way to fill-selected
  fill-danger: "#F7DCD6"      # Highlighted destructive menu row
  on-danger: "#991B1B"
  switch-on: "#3F3429"        # A switch that is on: the accent, as a checked box

  # ── Borders ────────────────────────────────────────────────────────────────
  border-subtle: "#E7DCBF"
  border: "#D9CFA9"
  border-strong: "#B8A47E"

  # ── Text ───────────────────────────────────────────────────────────────────
  on-surface: "#1A1714"       # Ink
  on-surface-2: "#4B3E32"
  on-surface-muted: "#6E604F"
  on-surface-subtle: "#7A6A54" # AA floor against bg-page
  on-accent: "#FFFDF7"
  tooltip-text: "#1A1714"
  tooltip-border: "#D9CFA9"   # A hairline edge in both themes

  # ── Agent identity chips ───────────────────────────────────────────────────
  accent-blue: "#5AA8E2"
  accent-blue-soft: "#DCEEFB"
  accent-blue-text: "#174A73"
  accent-green: "#3DA66A"
  accent-green-soft: "#E2F2E5"
  accent-green-text: "#15573D"
  accent-orange: "#F59E3B"
  accent-orange-soft: "#FFF1D8"
  accent-orange-text: "#873E05"
  accent-pink: "#A21D52"
  accent-pink-soft: "#FBE0EB"
  accent-purple: "#5A34D1"
  accent-purple-soft: "#E8DEF8"
  accent-red: "#A71C24"

  # ── Semantic state ─────────────────────────────────────────────────────────
  success: "#3DA66A"
  success-subtle: "#E2F2E5"
  warning: "#F59E3B"
  warning-subtle: "#FFF1D8"
  error: "#B91C1C"
  error-subtle: "rgba(185, 28, 28, 0.08)"
  error-container: "#F5E5DB"  # error-subtle flattened over bg-page
  info: "#4B3E32"             # quiet: ink-2 on the keycap wash (not blue)
  info-subtle: "#F0E9D4"
  diff-add-text: "#166534"
  diff-add-bg: "rgba(22, 163, 74, 0.16)"
  diff-del-text: "#991B1B"
  diff-del-bg: "rgba(185, 28, 28, 0.14)"

  # ── Syntax highlighting ────────────────────────────────────────────────────
  syn-comment: "#6E604F"
  syn-keyword: "#7C3AED"
  syn-function: "#026F9E"
  syn-variable: "#B91C1C"
  syn-string: "#15702F"
  syn-number: "#8A5A00"
  syn-type: "#A04A07"
  syn-operator: "#4B3E32"

  # ── Chart markers ──────────────────────────────────────────────────────────
  marker-blue: "#0284C7"
  marker-mint: "#16A34A"
  marker-orange: "#D06519"
  marker-pink: "#DB2777"
  marker-yellow: "#B77900"
  marker-violet: "#7C3AED"

  # ── Utility ────────────────────────────────────────────────────────────────
  focus-ring: "#2569A0"         # Signal Blue, a step deeper: 3:1 on every paper surface
  focus-outline: "#174A73"     # Solid keyboard-focus contrast on paper
  overlay: "rgba(26, 23, 20, 0.40)"

typography:
  display:
    fontFamily: System UI
    fontSize: 48px
    fontWeight: 700
    lineHeight: 1
  title:
    fontFamily: System UI
    fontSize: 28px
    fontWeight: 700
    lineHeight: 1
  heading:
    fontFamily: System UI
    fontSize: 30px
    fontWeight: 700
    lineHeight: 1.1
  body-lg:
    fontFamily: System UI
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.6
  body-md:
    fontFamily: System UI
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.55
  body-sm:                    # 13px at Default, 12px Compact, 14px Large
    fontFamily: System UI
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.5
  label-md:
    fontFamily: System UI
    fontSize: 13px
    fontWeight: 500
    lineHeight: 1.4
  label-sm:
    fontFamily: System UI
    fontSize: 12px
    fontWeight: 500
    lineHeight: 1.35
  label-caps:
    fontFamily: System UI
    fontSize: 11px
    fontWeight: 600
    lineHeight: 1
    letterSpacing: 0.05em
  meta:                       # 12px at Default/Large, 11px at Compact
    fontFamily: System UI
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.4
  code-md:
    fontFamily: JetBrains Mono Variable
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.6
  code-sm:
    fontFamily: JetBrains Mono Variable
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.5

rounded:
  none: 0px
  xs: 4px
  sm: 6px
  md: 8px
  lg: 12px
  xl: 16px
  2xl: 20px
  3xl: 24px
  4xl: 28px
  full: 9999px

spacing:
  base: 4px
  xs: 4px
  sm: 8px
  md: 12px
  lg: 16px
  xl: 24px
  2xl: 32px
  gutter: 8px
  card-padding: 12px
  app-header: 36px
  status-bar: 28px
  tab-bar: 36px
  toolbar: 32px
  list-row: 28px
  mac-traffic-inset: 70px
  content-max: 768px
  overlay-max: 860px
  palette-max: 600px

components:
  # Controls carry no border: fills tell them apart.
  button-default:
    backgroundColor: "{colors.bg-key}"
    textColor: "{colors.on-surface}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.md}"
    height: 36px
    padding: 12px
  button-default-hover:       # Half way to a chosen fill; a press steps on to border-subtle
    backgroundColor: "{colors.fill-key-hover}"
  button-subtle:
    backgroundColor: "{colors.bg-key}"
    textColor: "{colors.on-surface-muted}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.md}"
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-accent}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.md}"
    height: 36px
    padding: 12px
  button-ghost:
    backgroundColor: "{colors.bg-page}"
    textColor: "{colors.on-surface-muted}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.md}"
  button-ghost-hover:
    backgroundColor: "{colors.bg-key}"
    textColor: "{colors.on-surface}"
  button-danger:
    backgroundColor: "{colors.error-container}"
    textColor: "{colors.error}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.md}"
  button-danger-subtle:
    backgroundColor: "{colors.bg-page}"
    textColor: "{colors.error}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.md}"
  button-link:
    backgroundColor: "{colors.bg-card}"
    textColor: "{colors.on-surface}"   # ink, underlined in border-strong
    typography: "{typography.body-sm}"
  button-xs:
    typography: "{typography.label-sm}"
    rounded: "{rounded.xs}"
    height: 24px
    padding: 8px
  button-sm:
    typography: "{typography.body-sm}"
    rounded: "{rounded.sm}"
    height: 32px
    padding: 10px
  button-icon:
    rounded: "{rounded.md}"
    size: 36px
  button-icon-sm:
    rounded: "{rounded.sm}"
    size: 32px
  button-icon-xs:
    rounded: "{rounded.xs}"
    size: 24px
  button-send:
    backgroundColor: "{colors.bg-send}"
    textColor: "{colors.on-accent}"
    rounded: "{rounded.full}"
    size: 32px
  menu-panel:                 # One hairline frame; nothing inside has a border
    backgroundColor: "{colors.bg-card}"
    borderColor: "{colors.border-subtle}"
    rounded: "{rounded.md}"
    padding: 4px
  menu-item:
    textColor: "{colors.on-surface-2}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.xs}"
    height: 28px
    padding: 8px
  menu-item-highlighted:      # Pointer or keyboard: filled edge to edge with the highlight wash
    backgroundColor: "{colors.fill-highlight}"
    textColor: "{colors.on-highlight}"
  segmented-control:          # No border, no inset: the track is the segments
    backgroundColor: "{colors.bg-key}"
    rounded: "{rounded.sm}"
    padding: 0px
  segmented-item-active:
    backgroundColor: "{colors.fill-selected}"
    textColor: "{colors.on-selected}"
    rounded: "{rounded.none}"
  switch-off:                 # border-strong in both themes
    backgroundColor: "{colors.border-strong}"
    rounded: "{rounded.full}"
  switch-on:
    backgroundColor: "{colors.switch-on}"
    rounded: "{rounded.full}"
  input:
    backgroundColor: "{colors.bg-input}"
    textColor: "{colors.on-surface}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.sm}"
    padding: 10px
  input-focus:
    backgroundColor: "{colors.bg-input}"
    textColor: "{colors.on-surface}"
  card:
    backgroundColor: "{colors.bg-card}"
    textColor: "{colors.on-surface}"
    rounded: "{rounded.sm}"
    padding: 12px
  card-header:                # Dense variant only (data surfaces such as Telemetry)
    backgroundColor: "{colors.bg-key}"
    textColor: "{colors.on-surface-muted}"
    typography: "{typography.label-caps}"
    padding: 8px
  panel-section-title:        # Heading above a panel card (PanelSection), set semibold
    textColor: "{colors.on-surface}"
    typography: "{typography.label-md}"
  panel-card:
    backgroundColor: "{colors.bg-card}"
    textColor: "{colors.on-surface}"
    rounded: "{rounded.sm}"
    padding: 16px
  panel-row:                  # Label left, control right (PanelRow)
    textColor: "{colors.on-surface}"
    typography: "{typography.body-sm}"
    height: 56px
    padding: 16px
  field-label:
    textColor: "{colors.on-surface}"
    typography: "{typography.label-md}"
  sidebar-item:
    backgroundColor: "{colors.bg-sidebar}"
    textColor: "{colors.on-surface-2}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.sm}"
    height: 28px
  chip-agent:
    backgroundColor: "{colors.accent-blue-soft}"
    textColor: "{colors.accent-blue-text}"
    typography: "{typography.label-sm}"
    rounded: "{rounded.full}"
    padding: 8px
  chip-success:
    backgroundColor: "{colors.success-subtle}"
    textColor: "{colors.accent-green-text}"
    typography: "{typography.label-sm}"
    rounded: "{rounded.full}"
  chip-warning:
    backgroundColor: "{colors.warning-subtle}"
    textColor: "{colors.accent-orange-text}"
    typography: "{typography.label-sm}"
    rounded: "{rounded.full}"
  callout-warning:            # Callout; other tones swap the semantic pair
    backgroundColor: "{colors.warning-subtle}"
    textColor: "{colors.accent-orange-text}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.sm}"
    padding: 12px
  code-block:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.on-surface}"
    typography: "{typography.code-md}"
    rounded: "{rounded.sm}"
    padding: 12px
  overlay-modal:
    backgroundColor: "{colors.bg-page}"
    textColor: "{colors.on-surface}"
    rounded: "{rounded.lg}"
    width: 860px
  tooltip:
    backgroundColor: "{colors.bg-tooltip}"
    textColor: "{colors.tooltip-text}"
    borderColor: "{colors.tooltip-border}"
    typography: "{typography.label-sm}"
    rounded: "{rounded.sm}"
    padding: 8px
---

# OpenAgentd Paper

## Overview

OpenAgentd is a local-first workspace where developers run, watch, and steer
coding agents. The UI competes for attention with a terminal and an editor, so
it is built to be **read quickly and operated by keyboard** — dense, quiet, and
mostly out of the way.

The visual metaphor is **warm paper**. Surfaces are unbleached cream rather than
white; ink is warm near-black rather than pure black; borders are visible hairlines
rather than shadows. The result reads like an engineer's notebook or a well-set
technical manual — calm enough to sit behind long-running work without fatigue,
and distinctly *not* a generic SaaS dashboard.

Three deliberate tensions define the personality:

- **Dense, not cramped.** Default UI text is 13px and rows are 28–36px tall. The
  system earns that density with a strict 11px legibility floor and generous
  horizontal padding. Working surfaces (transcript, sidebar, review dock,
  Telemetry) stay dense; management surfaces (Settings, Scheduled tasks,
  Keyboard shortcuts, the Server dialog) keep the same type
  scale but trade height for room to breathe.
- **Flat, not sterile.** Hierarchy comes from tonal steps and hairline borders,
  never from drop shadows. Only true overlays cast a shadow.
- **Technical, not sterile.** The host OS's UI font handles interface text and
  headings, while JetBrains Mono distinguishes code and terminal-adjacent content.

Light mode is canonical. Dark mode is a tonal inversion of the same paper, not a
separate identity.

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

**Icons** (lucide) use a fixed scale: 12, 13, 14, 16px; 20px only in a
phone's bars and for empty-state illustration. 14px is the default inside
buttons (Rulebook 4; the `icon-off-scale` lint holds it).

## Layout

The shell is a fixed-viewport application, not a scrolling document. `html` and
`body` are locked to 100% with `overflow: hidden` so that internal regions are
the only scrollers — this prevents the webview from rubber-banding the whole
document and exposing pixels outside the layout.

**Spacing rhythm** is a 4px base scale. The dominant intervals are 8px (`gutter`
— the default gap between related controls) and 12px (`card-padding` — standard
horizontal padding and card inset). Vertical padding runs tighter than
horizontal: a 12px-tall row typically pairs `py-1.5` with `px-3`.

Management surfaces use a roomier panel rhythm: 16px card insets, 8px from a
label to its control, 20px between fields, and 32px between sections.

**Mobile-first authoring is mandatory.** Base (unprefixed) styles target the
phone; `md:` (768px) and up progressively add desktop affordances. Never author
desktop-first and walk styles back down.

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
- `overlay-max` (860px) — default modal width cap; `palette-max` (600px) for the
  command palette.

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
- **Focus mode** (`Mod+Shift+F`) hides the sidebar and the Review panel and
  puts both back on the second press; showing either one ends it as is.
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
  terminal keeps Control+backquote for its shell. Keys (`Mod+W`, `Mod+1–9`, `Ctrl+Tab`, `Mod+Shift+[`/`]`) act on the focused
  pane; with several panes, the open tab of a pane without focus steps back
  (a lighter wash, `text-2`), so the focused pane reads at a glance; the
  labels never fade (a strip at 50% left them at 2.1–2.3:1). A click into a preview page focuses its pane too (the window's
  blur says so; the page's events stay in its frame). Phones have one strip:
  panes join there.

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

**Stacking** uses a short layer scale: 10 in-block controls, 30 drawer scrims,
40 drawers and overlay scrims, 50 overlays and dialogs, 60 toasts and floating
notices (and dialogs opened from them), 70 menus, dropdowns and popovers, 9999
tooltips. Menus render into `document.body` (`ContextMenu`, `Dropdown`,
`Popover`), never inside the panel that opened them, whose own layer would cap
theirs. Write numeric layers as `z-60`, not `z-[60]`.

**One menu at a time**, as in a native app. Menus, dropdowns, popovers, the
Tasks popover and the desktop sidebar drawer are transient layers
(`lib/keyboard/layers.ts`): anything that opens over the app (another menu,
a dialog, Settings, the palette) closes them, unless it opened from inside one
(`KeyLayerScope` marks a layer's content, through portals); an app shortcut
closes them as a key equivalent closes a native menu; and so does a click
into a preview page or an MCP app's frame. Dialogs and overlays are never
closed this way.

Keyboard focus uses a solid 2px outline (`#174A73` in light mode, `#9DD0F5`
in dark mode), with a 2px offset. Translucent `focus-ring` effects remain
decorative supplements, not the only focus indicator. In the desktop app the
ring follows keyboard navigation only (Tab, F6; `lib/desktop-shell.ts`):
Escape, shortcuts and typing never draw it. Text fields mark focus with
their edge stepping to `on-surface-subtle` (3:1 or more), never a blue glow
(lint: `blue-field-focus`). Focus is never removed without an equally visible
replacement.

### Motion

Motion is functional: it explains where something came from, then gets out of
the way.

| Token | Duration | Use |
|---|---|---|
| `instant` | 80ms | Hover, press, color change |
| `fast` | 150ms | Tooltips, chips, small reveals |
| `base` | 240ms | Panels, dropdowns, most transitions |
| `slow` | 400ms | Full-screen overlays, route changes |
| `glacial` | 800ms | Ambient/looping, and the one-time reveal of text the agent wrote (an automated session title) |
| `linger` | 2000ms | Attention washes: a tint that holds, then drains (the sidebar row of a freshly titled session) |

Easings: `ease-out` `cubic-bezier(.16,1,.3,1)` for entrances, `ease-in-out`
`cubic-bezier(.4,0,.2,1)` for state changes, `ease-spring-soft`
`cubic-bezier(.34,1.2,.64,1)` and `ease-spring-snappy`
`cubic-bezier(.22,1.4,.36,1)` for gestural affordances, `ease-sheet`
`cubic-bezier(.32,.72,0,1)` for sheets and anything settling after a drag.
TypeScript reads the same values from `lib/motion.ts` (`DURATIONS_S`,
`EASINGS`); `motion.test.ts` keeps the two in step.

The animation library owns the CSS `transform` property. Never use `transform`
for layout (no `translateX(-50%)` centering) — center fixed elements with
`margin: auto` against `left: 0; right: 0`.

**Rules.** `design-lint.test.ts` enforces the first four.

- **Tokens only.** Write `duration-(--motion-*)` and `ease-(--ease-*)`, never
  `duration-200`, Tailwind's `ease-out`, a literal `cubic-bezier(`, or a bare
  `duration: 0.2`.
- **Name the properties.** Use `transition-colors`, `-opacity` or `-transform`,
  never `transition-all`. Buttons change colour only, at `instant`: the theme
  pins Tailwind's default transition to `instant` / `ease-in-out`, so a bare
  `transition-colors` is already right. A fold, slide or fade names its own
  `duration-(--motion-*)`.
- **Exit timers match their animation.** `useDeferredUnmount(open, DURATIONS_S.fast * 1000)`
  pairs with `duration-(--motion-fast)`. A bare number drifts.
- **Don't animate layout.** Width, height, inset, margin and padding re-lay-out
  every frame. Progress fills slide with `translate` inside a clipping track,
  and folds use `ui/collapsible` (grid rows at `base`, `inert` when closed).
  The exceptions: the pill ↔ card morph of a fixed notice; the command
  palette's and a dialog's height following their content at `fast`
  (`hooks/useHeightGlide`, one clipped box, so the card's edge never jumps
  per key); a switch thumb widening while pressed (a 16px box); and the
  palette's one highlight pill gliding between rows.
- **Everything that opens also closes, and can change its mind.** Popovers,
  menus and suggestion lists grow in at `base` (`fast` for small lists) from
  their anchor (`origin-*`), on the Web Animations API
  (`ui/_use-presence-motion`): reopening one mid-close turns back from where
  it is, never restarting from 0. The context menu fades out at `fast` when
  dismissed by pointer, but closes instantly on Escape or Tab so the next key
  lands where focus went. A chosen row blinks once (~60ms) before the menu
  acts (`ui/_menu-blink`).
- **Things come from where they started.** The lightbox grows out of the
  thumbnail that opened it and shrinks back into it (`lib/lightbox-zoom`);
  desktop overlays settle in at `base` (`ease-out`, from scale .96). On a
  phone a full-screen overlay is a sheet: it rises from the bottom on
  `ease-sheet` and drags down to close.
- **Gestures keep the hand's speed.** A phone drawer follows the finger by
  direct DOM writes (`lib/drawer-motion`, no React state per move) and, on
  release, settles on a critically damped spring seeded with the release
  velocity. It stops hard at both edges: no rubber band, no overshoot. Sheets
  close the same way. A long-pressed row lifts (`scale-[0.98]`) while held.
- **Lists move, not cut.** Reordered rows and dock tabs slide with FLIP
  (`hooks/useFlipReorder`, vertical or horizontal) from where they are drawn;
  a new tab fades in; a dragged tab lifts (scale 1.02 and a shadow) and lands
  on a spring. Session rows fold one by one (`ui/collapsible`). New panes fade
  in; panes never animate their size (terminals and previews would relayout
  each frame).
- **Replacing in place.** An icon that changes with state (Copy → ✓, Send ↔
  Stop, a session's status mark) swaps the SF Symbols way: the old one shrinks
  and fades as the new one springs up (`IconSwap`, `oa-icon-in`). A number
  that changes rolls only its changed digits (`RollingNumber`, tabular
  figures); a badge whose count grows bumps once (`useBadgeBump`). A view
  that replaces another in place crossfades at `fast` (`oa-fade-in-fast`).
  A new message rises in at `base` (`oa-rise-in`).
- **Controls answer the press.** On touch, a pressed button sinks slightly
  (`pointer-coarse:active:scale-*`); on desktop it only darkens. A switch
  thumb stretches toward where it will go and can be dragged; a checkbox
  draws its check; a segmented selection sinks and can be slid; a rejected
  field shakes (`lib/shake`); the focus ring settles in from outside
  (`oa-focus-ring-in`). Snapping a resize onto its default width ticks the
  trackpad on macOS.
- **Live words shimmer, never pulse.** A label the agent is still working on
  ("Thinking…", "running…") carries a light sweep (`oa-shimmer`) over a
  muted base that keeps AA contrast; a dot, mark or skeleton breathes
  (`oa-breathe`); text never fades in and out. A finished task's strike draws
  left to right (`oa-strike`).
- **Whole-window changes crossfade.** Light ↔ dark and a text-size change run
  through the View Transitions API at `base` (`lib/view-transition`); an
  engine without it changes at once.
- **Images appear decoded.** An image fades in at `fast` once decoded
  (`hooks/useImageReveal`) into the box it already reserved, never painting
  in from the top.
- **The transcript holds still.** While you read history, the scroller anchors
  to the first visible block, and images reserve their box before they load.
  Following the stream, it writes at most one scroll per frame. A send or
  Jump to latest within two screens glides to the end (further back it
  jumps), and no instant write cuts a glide short. When a stream ends, the
  text still to show keeps flowing to the end rather than landing in one
  frame. On a phone the header's bottom line shows only once the transcript
  scrolls under it.
- **Loading placeholders wait a beat.** Skeletons match the geometry of what
  replaces them, and fade in after `fast` (`oa-fade-in-late`), so a fast load
  never flashes one. A saved session shows a transcript skeleton, not the
  empty state, until its history lands.
- **Session switches crossfade.** The transcript being left stays, `inert` and
  dimmed to 70% at `fast`, for up to `fast` while the next one loads (a
  session viewed recently shows its last transcript instead). The next one is
  scrolled into place before paint and fades in over `fast` (`ease-out`).
  Loading states never take the whole pane while a chat is on screen.
- **Automated titles are revealed, manual ones are not.** A `title_update` from
  the agent lifts the old title out over `base` and wipes the new one in left
  to right over `glacial` (`ease-out`, after an `instant` beat). Its sidebar row
  holds a `fill-selected` wash for 40% of `linger`, then drains. Renames you make,
  list loads and session switches swap the text with no motion.
- **A live caret follows streaming text.** A 2px `on-surface-2` bar sits after the
  last paragraph, heading or list item an answer is writing, and blinks at
  `glacial` (`steps(1)`, on or off, never a fade). Code blocks and tables get
  none, and it goes the moment the answer ends. Under reduced motion it stands
  still.
- **Reduced motion snaps.** Every animation drops to ~0ms and transitions are
  off (`0s`, not a tiny duration: an element that declares no transition has
  `transition-property: all`, so any duration turned every change, inherited
  visibility included, into a transition, and a popover's field could not
  take focus as it appeared).
  Progress bars keep moving because time is literal, and spinners keep turning,
  slowly, because a frozen spinner reads as a hang.

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

## Components

Primitives are hand-rolled — plain elements plus variant maps and CSS custom
properties. No component framework, no `cva`. The shared language across all of
them is: **warm paper surface · fills, not borders · muted text · keycap hover.**

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

1. **Titles.** An overlay, dialog or page title is `text-base font-semibold`.
   A heading above a card is `TEXT.title`. A group label in a dense card or the
   sidebar is `label-caps`.
2. **Weight.** A row has regular text and one emphasis: the open or selected
   row is `font-medium`. Semibold is for titles only.
3. **Meta.** `text-meta` in the muted colour. The subtle colour sits only on
   the page or sidebar background.
4. **Icons.** 12, 13, 14 or 16px (20 in the phone header), one size per role,
   and one stroke width.
5. **Buttons.** Only the primitives (`Button`, `CloseButton`), never a
   hand-rolled icon `<button>`. Dialog footer buttons are 36px, toolbar icon
   buttons 32px (`icon-sm`), row buttons 24px (`icon-xs`) with the touch floor
   widening their target.
6. **Close.** One × per surface, top right: `CloseButton`, a 14px glyph,
   named "Close", tooltip "Close (Esc)".
7. **Dialogs.** `DialogHeader` and `DialogFooter` as they are; never override
   their `flex`. A confirm has no ×; its dismiss button says "Cancel"; its
   action is a verb and a noun ("Delete task"); a destructive button is never
   the default one.
8. **Destructive actions.** In a detail page, a Danger row at the bottom. In a
   list, inside the ⋯ or long-press menu. Never a bare Delete icon in a header.
9. **Status.** Words and tones from `STATUS` (Components → Status).
10. **Empty, loading, error.** Empty uses `EmptyState`: a sentence-case title
    with no full stop, and a create action when the user can create. Loading
    shows a skeleton. An error reads "Couldn't load X." with Retry.
11. **Copy.** One name per thing: Refresh, Copy response, main agent, Rename,
    Open in tab, Close (Esc). Sentence case. "…" when, and only when, the
    control opens a dialog or a picker. Straight quotes.
12. **Toolbars.** The same action keeps the same place in every view; Close
    and ⋯ come last. On a phone, secondary actions fold into ⋯.

Menus show the shortcut of every item that has one, and a tooltip with a
shortcut reads `Name (⌘X)`. Dates follow Components → Dates.

**Buttons** ship seven variants (`default`, `subtle`, `primary`, `ghost`,
`danger`, `danger-subtle`, `link`) across nine standard sizes (`xs`, `sm`, `default`,
`lg`, `trigger`, `icon`, `icon-sm`, `icon-dense`, `icon-xs`). No variant has a
border. `primary` is filled with Bark and `on-accent` text; `default` and
`subtle` sit on the keycap wash and step one tone along the ramp on hover
(`border-subtle` on paper, `border` on dark paper); `ghost` is text until
hovered; `danger` is the soft error fill.

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

**Phone scale**: a phone (the `phone:` variant: touch, and narrow or a landscape phone, the same test as `useIsMobile`) uses Apple's sizes, as a phone app reads: **17px** for row titles, buttons, menus, fields, chat and bar titles (`text-xs`, `text-sm`, `text-base`), **15px** for a row's second line, status words and code (`text-subhead`, `text-code`), **13px** for times and captions (`text-meta`). Rows, the header and every `Button` are **44px** (48px rows and buttons in the Android app); `.touch-hit` and prose links grow to 44px; the switch is 51×31 and Send a 44px circle. Text size scales the phone too: Compact 15px, Large 19px, with Dynamic Type on top. Tablets and narrow mouse windows keep the dense scale below.

**Mobile Touch Parity Scaling**: On touch tablets (`pointer: coarse`), standalone icon actions scale up to one compact **36×36px touch target** (`size-9`), while on desktop (`md:`) they collapse to dense **28–32px** (`md:h-7 md:w-7` or `md:h-8 md:w-8`). A phone takes the 44px phone scale above instead.

- `Button` gets this automatically: a coarse-pointer rule sets `min-height`/`min-width: 36px` on `[data-slot="button"]` (40px in the Android app). Prefer `Button` over a bare `<button>` for icon actions.
- `--spacing-list-row` becomes 36px on coarse pointers, so sidebar and dock list rows (sessions, sub-sessions, group headers, workspaces) grow with it. Size such rows from the token (`pointer-coarse:h-(--spacing-list-row)`), not a fixed `h-9`. Inline row actions add `pointer-coarse:size-9` (36px) to fill the row. Every touch target is 36px on a tablet; a phone takes 44px everywhere (Phone scale above), Send and Steer included (`phone:size-11`).
- `--spacing-tab-bar` (the review panel's tab strip) grows to 45px on coarse pointers, so each tab and its close control are 36px pills with 4px around them and a 1px hairline.
- Line height tightens on coarse pointers: `leading-relaxed` is 1.5 (1.625 on desktop) and chat/plan prose (`.oa-prose`) is 1.6 (1.75 on desktop), so phone screens read denser. Text sizes do not change.
- On phones the header is 40px with 36px controls (`max-md:pointer-coarse:size-9`). On wider touch screens, controls inside the 36px header stay within that height (`pointer-coarse:size-9`), because overlays are positioned from `--spacing-app-header`.
- Tabs (`ui/tabs`) are 36px per trigger on touch: the list grows to 42px around them.
- A narrow mouse window keeps the drawer: its footer has Settings, Usage, the command palette and theme as icons, and the server as its dot plus name, and its header has the sidebar toggle, the title, Task list and Review panel. A phone has no drawer: its **Sessions** screen and navigation stack are under Mobile shell. Model, thinking, account and context live in the run deck under the composer on every screen, never in the header or status bar. The review panel's phone tab strip shows its actions as icons only (+, ⋯).
- Grow the control itself wherever the layout allows. Two exceptions extend an invisible hit area with a `::before` instead, because growing the element would reflow text or a dense strip: links and file references inside prose (`.oa-prose a`, `[data-file-ref]`, 36px tall) and small icon buttons in code-block and tool-detail headers and in the 32px view toolbar (`.touch-hit` on a positioned element, 36×36 around it; `DOCK_ACTION_BUTTON_CLASS` is 28px on touch, 36px in the tab bar). Keep such targets apart so neighbours do not steal each other's taps.
- Rows with a long-press action sheet set `-webkit-touch-callout: none` (`LongPressButton` does this while enabled).

**Inputs** use `bg-input` (matching the page, not the card) with a 1px
`border` hairline (`border-subtle` all but vanished on a dark card, 1.15:1;
Increase contrast darkens it to 3:1 with every other border).
Focus steps the border to `on-surface-subtle` (4.7:1; `border-strong` was
2.25:1). Borders never change
width on hover — that causes a 1px layout jump.

**Transcript folds** (`hooks/useStickyFold.ts`): anything in the transcript that
opens into a long body — the reader work row, the compaction divider, a long
prompt or subagent report, a tool call's details, the "N files changed" list —
pins its header (or its collapse control) to the top of the transcript while
open (`PINNED_HEADER` plus the surface fill), so it can close from anywhere.
A header inside an open fold pins just below the fold's row (`--fold-top`), not
over it. Closing leaves the header where the pressed control was, so the view
never jumps. A tool call's details have no bottom Collapse bar: the pinned row
and the section captions close them. Reasoning (`Thinking`) is not a fold and
has no label: it streams in place and stays open, inline in small upright mono
with semibold section headers (no quote bar). It always shows in full: no height
cap, no inner scroll box, no "Show full reasoning" toggle. Clip with `overflow-clip`, not `overflow-hidden`,
on a box that holds a pinned control: a hidden-overflow box stops it pinning.

**Floating Menus & Context Menus** (`ui/menu-styles.ts` — dropdowns, context menus and hand-built listboxes all import it):
- **Panel**: `rounded-md`, one 1px `border-(--color-border-subtle)` hairline, `bg-(--bg-card)`, `p-1`, `shadow-depth`.
- **Items**: `rounded-xs`, 28px height (`px-2 py-1.5`), `text-xs`, text `on-surface-2`. The highlighted item (pointer or keyboard) is filled with the `fill-highlight` wash and its text and icons turn `on-highlight` (`.oa-menu-item` in `index.css`; hover only applies where a real pointer hovers).
- **Keyed lists** (`oa-menu-item-keyed`, the command palette): only the row the list marks active (`data-highlighted`) fills; a real mouse move makes a row active (`hoverIntent`), a pointer resting over the list lights nothing, so ↑/↓ never leave two rows lit. Palette rows have no border.
- **Destructive Items** (`MENU_ITEM_DANGER`): `text-(--color-error)`; highlighted, the fill turns `fill-danger` and the text turns `on-danger`.
- **Ours in every shell**: context menus, dropdowns and pickers are drawn by the page in the desktop and phone apps too, never handed to the OS menu, an iOS action sheet or an Android dialog. Native is the feel (a menu opens at the pointer, arrow keys move, Escape returns focus to the opener), not the OS widget, so every menu in the app looks alike. Only the window's menu bar (the macOS menu bar; ☰ on Windows and Linux) belongs to the shell.
- **Dividers**: `1px border-t border-(--color-border-subtle) my-1`.

**Segmented Controls & Connected Tabs**:
- **Track**: `rounded-sm`, `bg-(--bg-key)`, no border and no padding, `overflow-hidden`: the segments are the track.
- **Active Segment**: filled with `fill-selected` edge to edge (a sand in light, a raised warm tone in dark), `text-(--color-text-on-selected)`, `font-medium`. Nothing else marks it: no border, no inner card, no shadow.
- **Inactive Segment**: square inside the track, `text-(--color-text-muted)`, hover `text-(--color-text-2)` and a keycap step. Keyboard focus is an inset ring so it never spills past the track.
- **Sizes**: `TabsList size="sm"` is the 24px variant for dense panel toolbars (12px label, no shadow); on touch it is 28px so it still fits the 32px toolbar (the `default` list grows to 42px on touch).
- **Primitive**: pick-one controls use `SegmentedControl` (`ui/segmented-control.tsx`) — radio semantics with arrow-key roving, `default` (32px, 36px on touch), `sm` (24px, 28px on touch so it fits the 32px toolbar, like `TabsList size="sm"`) and `composer` (32px, 28px from `md`, 36px on a touch phone, so it matches the attach and send buttons beside it). Controls that need toggle-button semantics reuse its `segmentedTrackClass` / `segmentedItemClass`. `TabsList` stays for real tab panels.

**Editor Tabs** (review dock tab bar):
- **Strip**: `tab-bar` height (37px, 45px on touch) on the chrome tone (`bg-page` in light, `bg-sidebar` in dark; `DOCK_TAB_STRIP_CLASS`) with one `border-subtle` hairline below; tabs are 28px pills (36px on touch) 4px from its edges, scroll horizontally, and the actions stay pinned right.
- **Order**: views (Git, Plan, Tasks…) first, a hairline, then documents (files, diffs, commits, terminals, previews). A tab moves only among its own kind.
- **Preview tab**: a file, diff or attachment opened from a list, a link or Quick Open opens as the focused pane's one preview tab, title in *italics*, and the next one replaces it. Double-click, Keep Open, a comment on it, or moving it keeps it. Its tooltip and `aria-description` say so; its name stays the file's.
- **Drag**: a tab slides along its strip; carried out, a floating copy follows the pointer and a `focus-ring` caret or tint shows where it lands (another strip, a pane's middle, or the half an edge split takes). See Layout → Tabs drag between panes.
- **Overflow**: when the strip cannot show every tab, a `N ⌄` button lists them all (`menuitemradio`, the open one checked).
- **Menu** (right-click, Shift+F10), in groups: Close, Close others, Close to the left, Close to the right, Close all | Keep open, Split right, Split left, Split up, Split down, Move to next pane, Move left, Move right | Copy path, Reveal in Git. The close items act on the tab's own pane; Close all closes the pane with them.
- **Stepping**: `Ctrl+Tab` / `Ctrl+Shift+Tab` everywhere, plus the platform's pair: `⌘⇧]` / `⌘⇧[` on macOS, `Ctrl+PageDown` / `Ctrl+PageUp` elsewhere.
- **Active Tab**: the sidebar's current-row wash (`listRowSurface(true)`, `bg-key` at 60%), `font-medium`, `text-(--color-text)`. No coloured edge, no border. In a pane without focus (with several on screen) it steps back to a 35% wash and `text-2`; nothing on the strip fades.
- **Inactive Tab**: no fill, `text-(--color-text-muted)`, the sidebar row's hover wash.
- **Close**: a sibling `<button>` (never nested in the tab button), always visible: full strength on the open tab, dimmed on the others; middle-click also closes.
- **Semantics**: tabs are buttons with `aria-current`, not an ARIA `tablist` — terminal tabs carry their own context menu and sheet.

**Badges & Counters**:
- **Agent / Status Chip**: `rounded-full`, 20px height, `px-2 py-0.5`, `label-sm` (11px).
- **Counter / Sync Badge**: `rounded-full`, `bg-(--bg-key)`, `text-(--color-text-muted)` (subtle text never sits on a wash), JetBrains Mono `text-meta`, `px-1.5 py-0.5`.
- **Kbd Shortcut Badge**: `rounded-xs`, `bg-(--bg-key)`, no border, JetBrains Mono `text-meta`, `px-1.5 py-0.5`.

**Chips** (`ui/chip.tsx`): the one small label for states, identifiers and
tags. 18px, `rounded-xs`, `text-meta`, tones `neutral | info | success |
warning | error`, soft fills only (there is no outlined chip). Mono for identifiers and numbers (`exit 1`,
`429 rate_limit`), sans for words (`not yet`, `Vision`). A status chip always
carries text, never colour alone; `spinner` marks a live state and `dot` one
waiting on someone.
Do not hand-roll pills; reach for `Chip` (agent identity chips keep their
full-radius triplet).

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

**Dates** (`utils/format.ts`): one rule set, in English like the rest of the
UI, whatever the system locale. Lists count `now · 5m · 3h · 3d`, then name
the date (`Oct 29`). Details and tooltips read `Today 14:32`,
`Yesterday 09:01`, `Oct 29, 14:32`. The year shows only when it is not this
one (`Oct 29, 2024`). Never `dd/MM`: day-first and month-first readers both
misread it.

**Transcript rows** (`ui/meta-row.tsx`): tool calls, reader steps and file
operations share one row: the content on the left and a right-aligned 96px
meta column of tabular mono numbers (`33 ms`, `2.4 s`, `exit 1`), so values
line up down the transcript. 28px, 36px on touch. No icon gutter: the real
tool name in mono leads (`shell`, `grep`, `team_spawn`), then the target in
mono, then a short result summary in muted sans. A running row has a 6px
dot before the name and a live timer in the meta column; text never
blinks. A failed row shows its summary in error colour and an `exit 1` or
`error` chip. Rows without details render as a `div`, not a button.
A subagent row is a button to its session, with its state in words
(Running, Done, Failed, Needs you, Stopped) and a live clock. A tool section
header (arguments, command, output) is a `button` with `aria-expanded`; its
Copy is a sibling, always visible, and says "Copied" for a moment.

**Turn footer** (`AssistantTurnFooter.tsx`): under the last finished answer
the actions show at rest as muted 24px icon buttons (13px lucide icons, the
same size as the prompt's Edit and Copy): Copy · Edit prompt,
then the files pill (`FileDiff`, count, `+a -d`). Their words are the
names and tooltips. On a phone the footer and the prompt's actions are drawn
28px and close together, so the row fits an iPhone mini; `touch-hit` keeps
each a 36px target. Older answers keep Copy and the meta line. An
action that cannot run now stays visible, dimmed (`aria-disabled`, so it
keeps focus), and its tooltip says when it can. The meta line names the
model and the account the turn ran on. The files pill opens the
files the turn edited (both transcript styles), each opening its diff.

**Cards in the transcript** (a question, a plan review, a goal claim, a
waiting or stopped turn, the undo notice): one `border-subtle` frame, no
icon before the title, nothing framed inside. The decision sits on the card:
a question has only **Back** and **Next**, with **Send** in Next's place on
the last (or only) question (unanswered questions go out as skipped, the
caption says how many) and keys 1–9 for its options; a plan review has **Approve** (or **Approve
and keep going (N turns)** while a goal would start), **Request changes**,
which opens a focused comment box at once, and **Open plan**. A waiting or
stopped turn says why and since when, lists its ways forward and has
**Copy details**. Content text in cards is at least 12px (`text-xs`);
`text-meta` is for chips and meta lines.

**Touch menus.** A long press on a link or a tool row (Copy arguments,
Copy result) opens the same items as right-click, as a bottom sheet with a
light haptic, the app's own sheet in the iOS and Android apps alike, and so
is a session row's menu. Messages (yours and the agent's) and code blocks have no
app menu, on desktop or touch: they keep the system menu and native text
selection, and their Copy / Edit buttons.

**Confirmations** (`ui/confirm-dialog.tsx`): every action that cannot be
undone (stop a server, regenerate a key, delete, discard edits, revert a
commit, cut retention) asks first. The title says what happens, the
description what is lost, Cancel sits before the `danger` action, and its
menu item ends in "…". On an iOS-style phone it is an alert (Mobile shell).

**Icons: as few as possible.** Icons stay where they already are (icon
buttons such as copy, edit, close; chevrons that expand and collapse; the
header and composer). Do not add icons to transcript rows, meta lines,
dividers or card headers, and do not put an icon before a label that is
already clear. State is carried by words and chips.

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

**Sidebar sections.** **New session** (⌘N) sits atop the sidebar, outside the
scroller, so starting is always one click. Below it the session list scrolls
(Pinned, Needs you and the sessions), and its header sticks to the top so its
actions stay in reach. Scheduled sits pinned at the bottom, outside that
scroller, with no rule above it, and scrolls on its own past 224px
(`max-h-56`). Every section uses one header (`Sidebar/SidebarHeading.tsx`): the
name in sentence case, `text-xs` medium muted, a count, and a chevron that is
always visible when the section folds. Needs you counts in a warning chip
with words ("2 waiting"), so colour is never the only signal. Sections are
separated by their headers, not by rules. Scheduled is always there, with a
**+** for a new task and an empty row when nothing is due. The list's header
holds the icon actions (`md:` 24px, 36px on touch): Search and **View
options** (which holds Collapse all and Open workspace…). The workspace tree
shows placeholder rows while it first loads and an error with **Retry** when
it fails; "No workspaces yet" means the tree loaded empty.

**Workspace rows** split in two: the chevron folds the list, the name opens
the workspace's latest session (a draft when it has none). The workspace on
screen just unfolds. From the keyboard ←/→ on the name fold, so the chevron
is not a Tab stop. The active workspace's name is medium weight in ink.

**Session menu.** ⋯, right-click and the phone's long-press sheet show one
list in one order: Open in new window (desktop app), Rename (F2), Pin, then a
separator and Delete session… (⌫). A key a row answers to is shown beside
its item, in every menu (`MenuShortcut`).

**Header.** Desktop: the sidebar button on the left, then workspace · session
title; Tasks and Review panel on the right. The command palette has no
button: ⌘K and the View menu open it. The session title renames in place: double-click it, or press F2
or Enter on it; a single click does nothing, so a stray click keeps the
title. A subagent's title is read-only, like its sidebar row, and its header
leads with ↰ **Open the main agent** (before the title on desktop, first
among the bar's actions on a phone). A narrow mouse window keeps the sidebar toggle,
the title over its workspace, Tasks and Review panel; a phone's bar is
‹ Sessions, the title, Tasks and Review panel (Mobile shell). Every header
control is 36px on touch and 44px on a phone.

**Notices** (toasts, the update card, the LSP prompt) stack at the top right
under the header, newest first, so the run deck and Send stay clear. Phones
span the width between the safe-area insets.

**Command palette** (⌘K) is one overlay. Empty, it lists commands; typed, it
shows up to three headed groups in order: Commands, Sessions (by title) and
Files, which the arrow keys walk as one list. ⌘P opens it on Files
("Find file…"); Backspace in the empty field, or a click on the Files label,
widens it to every group, and a leading ">" keeps to commands. A page that is
still loading shows a Loading… row, never "Nothing here yet". The field is
16px on phones, so iOS does not zoom on focus.
View options is a context menu of `menuitemradio` groups (Group by, Sort by)
and a `menuitemcheckbox` (Show details); it stays open while choices apply.
Rows in flat views and Pinned name their workspace in mono 11px subtle text,
which gives way first when the row is narrow.

**Sidebar row actions** share one style (`ROW_ACTION` in `ui/list-row.ts`):
24px, borderless, `rounded-xs`, subtle glyph, keycap wash on hover, the
global focus ring, 36px on touch. They take the place of the row's meta (age,
tags) on hover or keyboard focus and hold no room at rest, so titles and
folder names keep the row; touch shows them always, except Pin, which stays
in More on touch so the title keeps the room; the pin mark itself stays on
touch. Session rows offer **Pin**
and **More**, subagent rows **More**, folder rows **+** and **More**. More
opens the same menu as right-click, so destructive actions are never one
click from a row. Text actions in rows ("Show all") use `ROW_TEXT_ACTION`
(24px), and count chips (subagents, worktrees) one 20px mono pill
(`rowChipClass`) that inks when active. Long titles always truncate: a fold
must never take the width of its longest line.

**Composer and run deck** (`components/composer/`): the composer is docked at
the foot of the chat column on every screen, in the column's flow (never
floating over the transcript), up to the 768px prose measure, always open:
no drag, no collapse, no saved position. It is one framed field (one
`border-subtle` hairline, no shadow); nothing inside it has a border. Under
the text sits the run deck, which says how the next message runs:

```
[+•] [Code|Plan] [provider:model · Level · Account ▾]   (ring 42%) [Send]
```

- **"+"** opens the add menu: Attach, Mention a file, Snippet, Side question
  and MCP servers (state in words, Sign in, on/off). The deck has no MCP
  button: while a server needs the user, "+" carries a 6px dot in the
  orange text tone (its description names the server) and opens at that
  section.
- **Code/Plan** is the segmented control (selection fill, no border). Plan mode
  changes the placeholder to say the agent reads and proposes without editing.
- **The run chip** reads `provider:model` in mono, then the thinking level and
  a pinned account in words. The `provider:` part gives way first; a long
  model name then gives up its middle (`antigravit…sonnet-4-6`, then
  `sonnet-4-6` alone), since models differ at the end, everywhere a model is
  named. Under 520px
  of composer width (container query) the chip stacks into two lines and the
  context ring drops its percentage. The chip has no tooltip: its accessible
  name carries the shortcut.
- **The run picker** (⌘., `/model`, `/think`, the palette's "Model and
  Thinking…") is one surface for all three: a model search with Recent first,
  thinking as a segmented control (←/→ step it from the empty search; Extra
  high reads XHigh there and on the chip, and the phone sheet puts the
  Thinking label above it so every level fits), the
  provider's accounts with state and quota left ("Auto" first), then Reset to
  default and Make default. A popover on desktop and tablet, a bottom sheet
  on phones. Every pick saves on the session at once; a refused save puts the
  previous choice back and says so. The search is borderless over a hairline
  like the other pickers, matches with fuzzysort and ranks in one list; the
  list keeps its height while a search narrows it, so the field never moves
  under the typing. A popover placed above its trigger is held by its bottom
  edge (`ui/popover`), so a change of height never leaves it hanging.
- **The context ring** opens the numbers and "Summarize now".
- **Send** is a keycap fill until there is something to send, then Bark. It is
  36px on touch like the controls beside it, so splitting into Steer and the
  delivery chevron mid-turn changes no height.
- **The tray** above the text holds what waits on the composer: the side
  question, the Undo notice and the "↓ N new" chip. Queued messages (each
  with Remove) wait at the bottom of the transcript, under the running turn,
  faded. The transcript never shows the tray's items a second time.

Bottom sheets (`ui/bottom-sheet.tsx`) are the phone form of any picker or
menu: a grab handle, drag or Esc to dismiss, safe-area padding, 44px rows.
As on iOS, a pull down anywhere on the content drags the sheet once nothing
under the finger is scrolled down; until then the pull scrolls back up.

**New-session hero** (the draft screen): a `text-lg` semibold question with
the folder in mono, a 24px `rounded-full` folder chip opening a filterable
listbox (the only `shadow-depth` here), then, on desktop, the full composer
inline at ≤ 640px, sitting a little above the
optical middle. Recent folders are 24px `rounded-full` chips; recent sessions
reuse the list rows. A one-line `meta` hint row lists `/`, `@`, ⌘K and ⌘N on
desktop only. Phones keep the composer docked at the bottom and never
collapse it. No starter prompts: the composer is the call to action. The
first message hands off to the chat in one motion: the composer box glides
to its docked slot (`slow`, a translate and a width tween, never a scale),
the hero fades out (`fast`) and the transcript fades in (`base`).

**Agent chips** are `full`-radius pills using the identity triplet — soft
background, tuned text tone, solid dot.

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

**App-level overlays** (Settings, Usage) are the same `AppOverlay` card
(`appLevel`, `OVERLAY_MAX_WIDTH.wide`), mount at the root so any route can open them, and are mutually
exclusive with the palette and utility panels. Telemetry reads top-down: a
filter bar (range, workspace, model, session chip), a headline stat strip,
per-day activity, then dense section-card breakdowns whose rows double as
filters, then recent turns. Escape steps out of a trace before it closes the overlay.

**Panels and management surfaces** (Settings, Scheduled tasks, Session
settings, Keyboard shortcuts, the Server dialog) are roomier than
the working surfaces. Text stays at the same sizes. They compose the shared
primitives in `components/ui/`:

- **Sections.** `PanelSection`: a titled section whose title and description
  sit above its card (see Section cards).
- **Rows.** `PanelRow` is a 56px row with the label and description on the
  left and the control on the right. It stacks below `sm`. Long reference
  lists (shortcuts, tools, MCP servers, detail facts) use the 44px
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
- **Technical but legible.** Users are developers, so industry terms stay:
  p50/p95, TTFT, tok/s, cache hit, stdio, OAuth, PID, exit code, cron, glob,
  tool names, model IDs and span names keep their real strings. What they
  need is a label, a unit and a definition: every number has a named label
  and a unit (`p95 35.2 s`, `in 55.8K · out 268`), every column a header,
  and every term a dotted-underline `Term` whose tooltip defines it.
  Words that only exist inside this codebase never reach the UI: say
  "built-in server" not "builtin", "main agent / subagent" not
  "lead / member", "summarize" not "compact", `exit 0` not `[Succeeded]`.
  A model on its own shows as `provider:model` in mono
  (`anthropic:claude-sonnet-4-6`); when space runs out the `provider:` part
  gives way first (it ellipsizes), and the full ID is in the tooltip. In a
  list grouped by provider (the model pickers) the group header names the
  provider and each row shows only the model; typing `openai:` still finds
  them.
- **One name per thing.** Workspace (not project or repo), Worktree,
  Rename, Tasks, Scheduled tasks, Review panel, Side questions, Find file,
  Session, Built-in server, Main agent / Subagent, Run now, Usage (the
  spend and trace overlay), Provider limits (a provider's quota), Retention
  (its Settings page), Comment (on a Preview page), Needs you / Running /
  Done / Failed / Can't reach (session states).

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
  skill, MCP server) brings its own Back, so the overlay's Back hides while
  one is open: one Back on screen.
- **Nav.** Groups in sentence case (App, Agents and tools, Sessions, Models
  and media, Data and safety, About), no icons at full width, counts in words ("4 skills",
  "1 needs sign-in"), a "Search settings" box on top.
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
  it. The phone section list has the same field. Below 900px the nav is an
  icon rail whose search opens in a dialog.
- **Long lists are rows, not cards.** Providers is one bordered list of
  rows (name, a subline such as "API key · 1 key · 13 models", a status
  chip); a row opens in place. Secondary row actions go in a "More" menu.
- **Server.** The same `AppBackendPanel` appears as Settings → Server and
  as the Server dialog. The dialog is used before
  the app is ready, from the footer health dot, and for scanned connect links.

**Scheduled tasks** use the same primitives in the overlay and the review
dock's Schedule tab. Spacing there keys off container queries (`@xl:`), not
the viewport, so the narrow dock stays usable. The task list is full-bleed
`divide-y` rows on the rail tone; a task's detail reads Status tiles, then
Delivery, Schedule, Prompt and Runs sections.

On phones (`useIsMobile`) the overlay header carries the title and Back, so
the detail and create panes drop their own title and close button. Run now
and Pause move to a bottom bar of labelled buttons, form footer buttons go
full width, and long detail values (workspace path, session ID) stack under
their label instead of truncating behind a hover tooltip. Task rows hide
their inline actions on coarse pointers, because the detail and the
long-press menu already offer them.

## Platform Shell

Three targets, one UI. The desktop app (macOS/Windows/Linux) and mobile app (iOS)
are Tauri shells around the **same web build** — there is no native UI layer, no
`colors.xml`, no Swift views. Every token above therefore applies verbatim on all
three platforms. The design system's platform work is not parallel styling; it is
**boot surface** and **safe geometry**.

### Boot surface

Paper must be painted before React mounts, or the user sees a flash of the wrong
color. Four layers sit in front of the app, and each one must be paper:

| Layer | Owner | Light / Dark | Status |
|---|---|---|---|
| iOS launch screen | `gen/apple/LaunchScreen.storyboard`, pointed at a `LaunchBackground` named colour by `mobile/scripts/patch-launch-screen.sh` | `#FAF6EC` / `#15110D` | ✓ correct |
| Android window + splash | `gen/android` `themes.xml`, pointed at an `openagentd_launch_background` colour by `mobile/scripts/patch-android-theme.sh` | `#FAF6EC` / `#15110D` | ✓ correct |
| Window background | `tauri.conf.json` → `app.windows[]` `backgroundColor`, repainted by desktop `window.rs`, iOS `theme.rs`, and Android `ShellPlugin.kt` (saved pick or system theme) | `#FAF6EC` / `#15110D` | ✓ correct |
| Browser / OS chrome | `index.html` `theme-color` + `lib/theme.ts` | `#FAF6EC` / `#15110D` | ✓ correct |
| Pre-paint CSS | `index.html` `<style>` | `#FAF6EC` / `#15110D` | ✓ correct |
| Theme class | `public/theme-init.js` | sets `.light`/`.dark` on `<html>` | ✓ correct |
| Boot loader | `index.html` inline Seal (generated) | ink + Signal Blue under `html.dark` | ✓ correct |

Every layer has both tones. The config's `backgroundColor` is a single static
value, so the shells repaint it before the page paints: from the theme pick the
page last reported (`set_window_theme` on desktop, `set_app_theme` on mobile),
or the system theme without one. On mobile `set_app_theme` also sets the status
bar to the pick.

The launch screens are patched after generation, because `mobile/src-tauri/gen/`
is gitignored and regenerated by `tauri ios init` and `tauri android init`. A storyboard colour is
static, so the script writes a `LaunchBackground.colorset` with a dark
appearance into the asset catalog and points the storyboard at it; iOS picks
the tone at launch. iOS caches launch screens, so an installed build may need
a reinstall to show the change. Android picks the `values-night/` colour in
dark mode, for both the window and the Android 12+ splash screen.

Desktop partially hides this by shipping the window with `visible: false` and
revealing it once the webview is ready. Mobile launches `visible: true`, so the
flash is fully exposed there.

### Desktop chrome

The macOS window uses `titleBarStyle: "Overlay"` with `hiddenTitle: true`, so the
app's own 36px `app-header` *is* the title bar. The traffic lights are placed
in the header's sidebar cap, over the sidebar column as in Finder or Mail; they are placed
from Rust (`desktop/src-tauri/src/window.rs`, `{x: 12, y: 20}`; the JSON config
value is ignored for builder-created windows), which centres them against the
36px header and is why `mac-traffic-inset` is 70px (12px origin + ~58px button
group); the sidebar toggle after them starts at 80px, the gap native Mac apps
leave. Reference window is 1280×820, floor 820×640.

The Windows window has no system frame (`decorations: false`, shadow kept,
`window.rs`): the header is the title bar there too. `WindowCaptionButtons`
draws Minimize, Maximize (Restore Down when maximized) and Close at its right
end the way Windows 11 does: 46px wide, the header's height, Segoe Fluent
Icons glyphs, a `bg-key` hover and an `error` fill on Close, dimmed while the
window is in the background, not tab stops. Resting the mouse on Maximize for
500ms opens Snap Layouts (`show_snap_layouts`, `caption.rs`), since Windows
only asks a frame it draws. The header leaves the buttons' 138px empty, and
`html[data-window-caption]` starts full-window viewers (`.below-window-caption`)
and phone-width modal cards below the header, so nothing of theirs sits under
the window's Close. Full screen hides the buttons, as Windows hides its title
bar. Linux keeps the system frame.

Inside Tauri, `lib/desktop-shell.ts` sets `<html data-shell="desktop">`. Under
it, chrome is `user-select: none` with the arrow cursor on buttons (links keep
the pointer), and only content selects: inputs, `.selectable-text`,
`.oa-prose`, `pre`, `code` and `.xterm`. Images and links do not drag out. The
webview's own right-click menu is suppressed except in text fields, over
selected text, on answer text and code outside a link (Copy, Look Up), and in
dev builds; links and tool rows offer app menus instead. Your messages and
code blocks keep the system's menu and selection (`ChatContextMenu.tsx`).
While another app has focus, `data-window-inactive` hides focus rings, turns
text selection to `--bg-key` and mutes `aria-current` items, the way Finder
greys its selection. The browser build keeps the browser's behaviour.

The desktop shell hands the OS what belongs to the window; menus, dropdowns
and pickers inside the page stay the app's own (see Floating Menus & Context
Menus):

- **App menu**: macOS keeps the menu bar. On Windows and Linux the menu bar
  is hidden and the header's ☰ (or a bare Alt tap outside a text field)
  pops the same menu up (`show_app_menu`). The View menu carries every
  layout command (Sidebar, Review Panel, Split Review Panel Right and Down,
  Open Terminal, Maximize Review Panel, Model and Thinking…, Text
  Size, Reset Layout). Its shortcuts work with the bar hidden; on Linux each item
  answers GTK's `can-activate-accel` itself, since GTK only fires the
  shortcuts of a menu on screen.
- **Dialogs**: button order follows the OS (`DialogFooter`): Cancel before
  the action on macOS, iOS and Linux, the action first on Windows, a row of
  text buttons on Android. The footer has no border or fill. A safe confirm
  is the default button (Enter); a destructive one never is, Cancel is.
- **Attention badge**: the Needs you count on the Dock (macOS), the launcher
  (Linux) and as a taskbar overlay (Windows); `(n)` in a browser tab's title.
- **Zoom** is saved, and a new window opens at the zoom of the window it
  came from.
- **macOS**: two-finger swipes go back and forward through the window's
  sessions, and scroll bars are the system's (they follow "Show scroll
  bars"); the app's thin bars are for the other platforms.
- **Global shortcuts** (Show OpenAgentd, Next session that needs you) are
  off until "Global Shortcuts" is ticked in the OpenAgentd menu.

**Companions** (the notch island, the pet, OS notifications) read one Needs
you feed and use one vocabulary: Needs you, Running, Done, Failed, Can't
reach. The island's pill and list show a running session with the spinner,
not the word Running. A question with a few choices is
answered in place (island, pet, notification buttons); anything else says
**Open to answer**. × means Later: the question stays until answered. Every
way of opening a session goes through one router, which focuses the window
that already shows it.

The macOS tray popup (`web/tray.html`) lists no sessions, only provider limits
and actions. The Windows and Linux tray menu lists none either, and shows its
status row only while the backend is not running normally. The popup is a
separate, small entry with no
Tailwind. Its stylesheet `tray/tray.css` imports `styles/tokens.css`, the same
palette and motion tokens as the app; only its glass surface and shadows are
its own (`tray-css.test.ts` holds the rest to tokens). It follows the OS
appearance, not a window's theme, and the window is sized to the popup's
content, 360px wide and up to 600px tall.

### Keyboard focus model

Tab follows the DOM order: every control is its own Tab stop. Composite
widgets (tablists, menus, listboxes, comboboxes) keep their own arrow keys.

- **Row actions** are never hover-only. Transcript and Review panel rows
  show theirs at rest (dimmed until the row is hovered or holds focus).
  Dense list rows (sidebar sessions and folders, commit history) swap their
  icon actions in for the row's meta on hover or keyboard focus, and every
  one of those is also in the row's right-click / long-press menu, which
  touch shows at all times. All keep a keyboard shortcut: F2, Delete,
  Shift+F10 / the Menu key (`lib/focus/item-keys.ts`).
- **Quiet focus**: focus a script hands back without a key press (the
  composer pill on page load) goes through `focusQuietly`
  (`lib/focus/quiet.ts`), so it draws no ring until the keyboard moves on.
  Focus fills use the `focus-key:` variant (keyboard focus that was not
  handed over quietly), not `focus-visible:`, so quiet focus draws no fill,
  and a tooltip does not open on it either.
- **Ring follows input** (desktop): focus rings show only after a key press
  and hide again on the next pointer press. Focus a script gives — the
  composer at launch, a fold after its Collapse click — draws none until the
  keyboard is used. Text fields keep their focus styles.
- Focus never rests on `<body>` or in an `inert` panel; it returns to the
  composer.

Tooltips follow native timing: 500 ms on hover, then instant for 300 ms after
one closes; a press, key or scroll closes them, and focus opens them only when
it came from the keyboard. A tooltip is a raised `bg-tooltip` chip with a
`tooltip-border` hairline (its arrow carries the hairline on its outer sides).

### Mobile shell

The Tauri webview sets `data-mobile-shell` on `<html>`, which switches the
document to `position: fixed` and disables text selection outside content
regions. Reference viewport is 390×844.

A phone turned sideways (Android; iPhone is portrait-only) is wider than `md`
but still mobile: `useIsMobile` also matches a height under 580px. Gate
mobile-only surfaces on `useIsMobile`, not on `md:` classes, which would apply
desktop layout to them. Drawers fixed to a screen edge sit outside the shell's
side padding, so they add `pl-safe` / `pr-safe` to clear a camera cutout.

Keyboard handling is the subtle part: `--app-vh` and `--app-vt` track the visual
viewport, and overlays follow the keyboard by **translating** rather than
resizing. While the keyboard is up, `.pb-safe` drops from the home-indicator
inset to a flat 8px, because the indicator is hidden behind the keyboard and the
inset would only waste a strip of space.

The shell blocks pinch zoom, so the iOS app follows **Dynamic Type** instead
(`lib/dynamic-type.ts`). A hidden probe set in `font: -apple-system-body` reads
the user's text size, and the root font size scales from 16px by that size over
iOS's default of 17px. The scale never goes below 1, because the type scale
assumes the design size, and stops at 1.25. Everything in rem scales with it:
text, spacing, and touch targets. Px sizes do not. The app's own Text size
setting multiplies on top (type only).
Android scales text in the shell instead: `ShellPlugin` sets the WebView's
`textZoom` from the system font scale, between 100% and 125%.

The phone apps keep the app's own controls: a choice of a few values (theme,
text size) is the same segmented control as on desktop, and a long press
opens the item's menu as the app's bottom sheet on iOS and Android alike.
Haptics mark a send, an arriving question, a mode change and a sheet
dismissed by drag.

**A phone is a navigation stack** (`useIsPhone`: `useIsMobile` on a
touch-first device; a narrow mouse window and a tablet keep the drawer
layout). `components/phone/PhoneStack` holds two levels, both mounted:

- **Sessions** (`/sessions`, the sidebar's `page` mode) is the first screen:
  the server chip and ✎ New session in the bar, a 34px **Sessions** title
  (`text-large-title`) that hands over to the bar's 17px title as it scrolls
  away, a search field, then Needs you, Pinned and the workspaces. Pull down
  to refresh. Swipe a row left for Pin and Delete (Delete confirms); a long
  press still opens its menu. A toolbar at the bottom holds Settings,
  Scheduled, Usage and Commands, each an icon over its name.
- **A chat or a draft is pushed** over it from the right; Sessions drifts a
  third of the way left under a scrim. The chat's bar is `PhoneNavBar`:
  ‹ Sessions in the accent, the title centred over its workspace, Tasks and
  Review panel on the right (20px glyphs in the accent).
- **Back is by level, not by history**: ‹, a swipe from the left edge (it
  follows the finger and springs on with its speed) and Android Back all go
  to the parent. A link, a notification or a widget opens the chat with
  Sessions under it; Android Back on Sessions sends the app to the
  background.
- **Review** is a page pushed over the chat (‹ Chat, full screen). **Tasks**,
  the "+" menu and the model picker are sheets with two detents (half and
  nearly full height; `BottomSheet` `detents`). Settings, Scheduled tasks and
  Usage are sheets: the full width, 12px top corners, a grabber, the bar's
  ‹ parent on the left, the title centred and **Done** on the right; a
  Settings section is pushed over the list and swipes back. Android puts a
  bare ← and a left-aligned title in the same bars.
- **Confirms are alerts** on an iOS-style phone: a centred 270px card, Cancel
  and the action full width under a hairline, a destructive action in red
  and never the default. Android keeps Material's text buttons.

### Native per platform

| | macOS | Windows | Linux | iOS / iPadOS | Android |
|---|---|---|---|---|---|
| UI font | SF Pro | Segoe UI Variable | desktop font | SF Pro | Roboto |
| Bar title | — | — | — | centred, ‹ parent | left-aligned, ← |
| Shortcut modifier | ⌘ | Ctrl | Ctrl | ⌘ (hardware keyboard) | Ctrl |
| Context menu | app menu | app menu | app menu | long-press sheet (app's) | long-press sheet (app's) |
| App menu | menu bar | ☰ / Alt | ☰ / Alt | — | — |
| Dialog buttons | Cancel · Action | Action · Cancel | Cancel · Action | alert (phone), Cancel · Action (iPad) | text buttons |
| Badge | Dock | taskbar overlay | launcher | — | — |
| System text size | — | — | — | Dynamic Type | font scale |
| Back | ⌘[ · two-finger swipe | Alt+← | Alt+← | ‹ or edge swipe, one level up | Back, one level up; leaves from Sessions |

## Brand mark

The OpenAgentd logo is built by
`scripts/brand/brand.ts` from Schibsted Grotesk 600 and drawn inline by
`components/brand/Logo.tsx` from the generated `lib/brand/logo-data.ts`.
Never redraw it by hand; change the generator. openagentd.dev copies it from
this repository. Files and regeneration: `documents/assets/brand/README.md`.

- **The Seal**: an ink disc with an open A (no crossbar) cut out of it, and a
  Signal Blue dot as the crossbar. The dot is the agent. On a 64-unit grid:
  disc radius 27, A from y 20 to 47, 11.5 wide each side, stroke 6, dot radius
  3.75 at y 39. Used wherever the app shows its mark: the boot and loading
  screens, the crash screen, the empty session, and Settings → About.
- **The wordmark**: "OpenAgentd" with the font's A replaced by the same open A
  and dot. Used in Settings → About and the tray popup.
- **Color**: the ink is `currentColor`, set to `--color-text`; the dot is
  `--logo-signal`, which is `--accent-blue`. Both follow the theme. No tile,
  rounding, or shadow around the Seal in the app.
- **Type**: the wordmark is outlines, so the app needs no extra font. The OS's UI
  font and JetBrains Mono stay the only UI faces; Schibsted Grotesk appears only inside
  the wordmark (and in marketing headlines outside the app).
- **Motion**: the 3.3s Seal-to-wordmark intro is for the website and media,
  never the app. In the app only the dot moves: on loading screens it pulses
  (`oa-seal-pulse`, opacity only, `glacial` 800ms alternating). With reduced
  motion it stays still. Everywhere else the Seal is static.
- **Platform icons** (masters in `documents/assets/brand/icons/`, built by
  `scripts/generate_icons.py`): the ink Seal on a Paper tile. macOS uses an
  824px tile on Apple's 1024 grid with a hairline border; Windows a
  full-bleed tile so 16–32px sizes stay legible; iOS a full-bleed opaque Paper
  square without an alpha channel; Android an adaptive foreground whose disc
  sits inside the 66dp safe zone on a `#FAF6EC` background. The macOS menu bar
  icon is a monochrome template of the open A and the dot without the disc,
  which is too heavy at 18pt.

## Do's and Don'ts

**Color**

- Do let content carry the color; keep chrome in the neutral ramp.
- Do keep `tertiary` (Signal Blue) for the logo and keyboard focus only, and
  `bg-send` as the only inverted surface. Selections fill with `fill-selected`, never the
  accent: in dark mode the accent is near-white.
- Don't introduce a new hue for emphasis — step the surface ramp or the text
  ramp instead.
- Don't reuse agent identity hues to mean semantic state, or vice versa.
- Don't use pure `#FFFFFF` or `#000000` anywhere. Every neutral is warm.

**Typography**

- Do treat `body-sm` (12px) as the default UI size, not an exception.
- Do use `code-md` / `code-sm` for anything copyable or column-scannable — paths,
  IDs, token counts, diffs.
- Don't render UI text below 11px; the floor is enforced in CSS, so specifying
  9–10px only creates a mismatch between the class name and the result.
- Do size reading text (messages, labels, controls) with the rem scale so it
  follows Dynamic Type on iOS; keep px sizes for dense metadata only.
- Don't stack more than two font weights in one view.

**Layout & depth**

- Do author mobile-first, then add `md:` and up.
- Do apply safe-area insets on every outermost shell and overlay.
- Don't add a drop shadow to a non-floating element — step the surface or add a
  hairline border.
- Don't mix radius families in one view: a `rounded-full` pill inside a
  `rounded-lg` card is correct; `rounded-2xl` next to `rounded-sm` is not.
- Don't let the document scroll. Internal regions own scrolling.
- Do put a section's title above its card on management surfaces; keep caps
  header strips for dense data surfaces.
- Don't nest a bordered card inside another card. Use rows or a hairline.

**Interaction**

- Do keep every interactive element reachable and visibly focused; replace the
  focus ring, never remove it.
- Do keep hover/press feedback on `instant` (80ms) so dense UI feels immediate.
- Don't animate layout with `transform` — the animation library owns that
  property.
- Don't drop below WCAG AA: 4.5:1 for text, 3:1 for large text and UI boundaries.
