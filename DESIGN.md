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
  tertiary: "#5AA8E2"         # Signal Blue — focus + interaction
  neutral: "#FAF6EC"          # Paper — page foundation

  # ── Surfaces ───────────────────────────────────────────────────────────────
  bg-page: "#FAF6EC"
  bg-sidebar: "#F5EFDD"
  bg-card: "#FFFBF1"
  bg-input: "#FAF6EC"
  bg-key: "#F0E9D4"           # "Keycap" — hover/press wash, header strips
  bg-send: "#2D241B"          # Inverted ink pill (composer send)
  surface: "#FFFDF7"
  surface-2: "#F5EBD8"

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
  info: "#5AA8E2"
  info-subtle: "#DCEEFB"
  diff-add-text: "#166534"
  diff-add-bg: "rgba(22, 163, 74, 0.16)"
  diff-del-text: "#991B1B"
  diff-del-bg: "rgba(185, 28, 28, 0.14)"

  # ── Syntax highlighting ────────────────────────────────────────────────────
  syn-comment: "#6E604F"
  syn-keyword: "#7C3AED"
  syn-function: "#026F9E"
  syn-variable: "#B91C1C"
  syn-string: "#15803D"
  syn-number: "#A16207"
  syn-type: "#B45309"
  syn-operator: "#4B3E32"

  # ── Chart markers ──────────────────────────────────────────────────────────
  marker-blue: "#0284C7"
  marker-mint: "#16A34A"
  marker-orange: "#FA8030"
  marker-pink: "#DB2777"
  marker-yellow: "#B77900"
  marker-violet: "#7C3AED"

  # ── Utility ────────────────────────────────────────────────────────────────
  focus-ring: "#5AA8E2"
  focus-outline: "#174A73"     # Solid keyboard-focus contrast on paper
  overlay: "rgba(26, 23, 20, 0.40)"

typography:
  display:
    fontFamily: Inter Variable
    fontSize: 48px
    fontWeight: 700
    lineHeight: 1
  title:
    fontFamily: Inter Variable
    fontSize: 28px
    fontWeight: 700
    lineHeight: 1
  heading:
    fontFamily: Inter Variable
    fontSize: 30px
    fontWeight: 700
    lineHeight: 1.1
  body-lg:
    fontFamily: Inter Variable
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.6
  body-md:
    fontFamily: Inter Variable
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.55
  body-sm:
    fontFamily: Inter Variable
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.5
  label-md:
    fontFamily: Inter Variable
    fontSize: 12px
    fontWeight: 500
    lineHeight: 1.4
  label-sm:
    fontFamily: Inter Variable
    fontSize: 11px
    fontWeight: 500
    lineHeight: 1.35
  label-caps:
    fontFamily: Inter Variable
    fontSize: 11px
    fontWeight: 600
    lineHeight: 1
    letterSpacing: 0.05em
  meta:
    fontFamily: Inter Variable
    fontSize: 11px
    fontWeight: 400
    lineHeight: 1.4
  code-md:
    fontFamily: JetBrains Mono Variable
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.6
  code-sm:
    fontFamily: JetBrains Mono Variable
    fontSize: 11px
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
  status-bar: 24px
  tab-bar: 36px
  toolbar: 32px
  list-row: 28px
  mac-traffic-inset: 70px
  content-max: 768px
  overlay-max: 860px
  palette-max: 600px

components:
  button-default:
    backgroundColor: "{colors.bg-card}"
    textColor: "{colors.on-surface}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.md}"
    height: 36px
    padding: 12px
  button-default-hover:
    backgroundColor: "{colors.bg-key}"
  button-subtle:
    backgroundColor: "{colors.bg-card}"
    textColor: "{colors.on-surface-muted}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.md}"
  button-primary:
    backgroundColor: "{colors.bg-key}"
    textColor: "{colors.on-surface}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.md}"
    height: 36px
    padding: 12px
  button-primary-hover:
    backgroundColor: "{colors.surface-2}"
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
    backgroundColor: "{colors.bg-card}"
    textColor: "{colors.error}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.md}"
  button-link:
    backgroundColor: "{colors.bg-card}"
    textColor: "{colors.accent-blue-text}"
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
  menu-panel:
    backgroundColor: "{colors.bg-card}"
    borderColor: "{colors.border}"
    rounded: "{rounded.sm}"
    padding: 4px
  menu-item:
    textColor: "{colors.on-surface-2}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.xs}"
    height: 28px
    padding: 8px
  menu-item-hover:
    backgroundColor: "{colors.bg-key}"
    textColor: "{colors.on-surface}"
  segmented-control:
    backgroundColor: "{colors.bg-key}"
    borderColor: "{colors.border}"
    rounded: "{rounded.sm}"
    padding: 2px
  segmented-item-active:
    backgroundColor: "{colors.bg-card}"
    textColor: "{colors.on-surface}"
    rounded: "{rounded.xs}"
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
    backgroundColor: "{colors.bg-send}"
    textColor: "{colors.on-accent}"
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

- **Dense, not cramped.** Default UI text is 12px and rows are 28–36px tall. The
  system earns that density with a strict 11px legibility floor and generous
  horizontal padding. Working surfaces (transcript, sidebar, review dock,
  Telemetry) stay dense; management surfaces (Settings, Scheduled tasks,
  Session settings, Keyboard shortcuts, Backend connection) keep the same type
  scale but trade height for room to breathe.
- **Flat, not sterile.** Hierarchy comes from tonal steps and hairline borders,
  never from drop shadows. Only true overlays cast a shadow.
- **Technical, not sterile.** Inter handles interface text and headings, while
  JetBrains Mono distinguishes code and terminal-adjacent content.

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
- **Tertiary (#5AA8E2) — "Signal Blue."** The sole interaction color. Focus
  rings, links, and informational state. Blue is used for the focus ring instead
  of Bark because a near-ink ring reads as a hard rectangle rather than an
  affordance. The logo's dot (the agent) is Signal Blue too.
- **Neutral (#FAF6EC) — "Paper."** The page foundation. Warmer and softer than
  white, which keeps long agent transcripts comfortable.

### Surface ramp

Surfaces step tonally, not by elevation. Cards sit *lighter* than the page:

`bg-sidebar (#F5EFDD)` → `bg-page (#FAF6EC)` → `bg-card (#FFFBF1)` → `surface (#FFFDF7)`

`bg-key (#F0E9D4)` is the "keycap" wash — hover and pressed states, the header
strips of dense section cards, and keyboard-shortcut badges. `bg-send (#2D241B)` is the one
inverted surface, reserved for the composer's send action.

### Agent identity chips

Each concurrent agent gets a stable identity color from a six-hue set (blue,
green, orange, pink, purple, red). Every hue ships as a triplet: a **solid**
(dot, border), a **soft** container, and a **text** tone tuned for AA against
that container. Identity hues carry no semantic weight — blue does not mean
"info" when it appears on an agent chip.

### Semantic state

`success` / `warning` / `error` / `info` intentionally reuse the chip palette so
the total number of hues in the system stays small. Diff and syntax colors are
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
| `surface` / `surface-2` | `#FFFDF7` / `#F5EBD8` | `#221C16` / `#2A2219` |
| `color-bg-elevated` | `#FFFDF7` | `#221C16` |
| `border-subtle` / `border` / `border-strong` | `#E7DCBF` / `#D9CFA9` / `#B8A47E` | `#2C231A` / `#3A2F23` / `#5C4B36` |
| `on-surface` | `#1A1714` | `#F5EBD8` |
| `on-surface-2` | `#4B3E32` | `#C5B59A` |
| `on-surface-muted` | `#6E604F` | `#9C8A72` |
| `on-surface-subtle` | `#7A6A54` | `#8E7D66` |
| `primary` (accent) | `#3F3429` | `#F5EBD8` |
| `accent-blue` (solid / soft / text) | `#5AA8E2` / `#DCEEFB` / `#174A73` | `#7CC2F0` / `#1E3A52` / `#9DD0F5` |
| `accent-green` (solid / soft / text) | `#3DA66A` / `#E2F2E5` / `#15573D` | `#5DC487` / `#1F3A2A` / `#92E0B0` |
| `accent-orange` (solid / soft / text) | `#F59E3B` / `#FFF1D8` / `#873E05` | `#FDB75D` / `#3D2D14` / `#FCC780` |
| `diff-add` (bg / text) | `rgba(22, 163, 74, 0.16)` / `#166534` | `rgba(16, 185, 129, 0.10)` / `#86EFAC` |
| `diff-del` (bg / text) | `rgba(185, 28, 28, 0.14)` / `#991B1B` | `rgba(239, 68, 68, 0.10)` / `#FCA5A5` |
| `error` | `#B91C1C` | `#F87171` |
| `overlay` | `rgba(26,23,20,.40)` | `#00000099` |

Agent and syntax hues brighten and desaturate in dark mode (e.g. `accent-blue`
`#5AA8E2` → `#7CC2F0`); soft containers become deep tints of the same hue.

## Typography

Two faces, each with a non-overlapping job:

- **Inter Variable** — all interface text and prose. Chosen for legibility at
  11–14px, where most of this UI lives.
- **JetBrains Mono Variable** — code, diffs, terminal output, file paths, token
  counts, IDs. Anything a user might copy, compare character-by-character, or
  scan as a column.

### The scale

`body-sm` (12px) is the workhorse — it is the default for buttons, inputs, rows,
and menus, not a "small" variant. `body-md` (14px) is for comfortable reading
passages; `body-lg` (16px) for long-form prose only.

`meta` and `label-sm` (11px) carry timestamps, counts, and secondary metadata.
**11px is a hard floor.** Anything specified below it is clamped up, so the same
screen never renders differently between desktop and mobile.

`label-caps` (11px, 600, +0.05em, uppercase) marks dense section-card headers
and group labels. Panel section titles are not caps: they use 12px semibold in
sentence case (`TEXT.title` in `ui/panel-tokens.ts`). It is the only uppercase style in the system, and ships as the
`label-caps` utility (type only — pair it with `text-(--color-text-muted)` on
card headers, `text-(--color-text-subtle)` on nav and group labels). Use
`font-mono` with it only when the label is an identifier (a code language, a
tool name).

`code-lg` (13px mono, `leading-relaxed`) is the reading step for chat code
blocks and code-editing textareas, where `code-md` is too dense for long
passages. Tool output, diffs and file views stay on `code-md` / `code-sm`.

**Icons** (lucide) use a fixed scale: 11, 12, 13, 14, 16px; 20px and up only
for empty-state illustration. 14px is the default inside buttons.

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
- `status-bar` (24px) — the desktop status footer.
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
holding the chat and the review dock, and a status bar. Mobile keeps its drawer
and full-screen dock sheet unchanged.

```
┌────────────── app-header 36 · bg-page (light) / bg-sidebar (dark) ─────────┐
│ sidebar 264 │ chat · bg-page (≥ 400)         │ review dock (≥ 340)          │
│ page / rail │                                │ tab-bar 36 · bg-sidebar      │
│ 28px rows   │                                │ toolbar 32 · bg-page         │
│             │                                │ one scroller                 │
└────────────── status-bar 24 · bg-page (light) / bg-sidebar (dark) ─────────┘
```

- **Zoning is tonal in dark mode.** There the header, sidebar and status bar
  sit on the recessed `bg-sidebar`; in light mode they share the chat's
  `bg-page`, so the app reads as one sheet of paper. The dock tab bar is
  `bg-sidebar` in both. Working surfaces (chat, dock content) sit on
  `bg-page`. The zones meet at hairline borders, never shadows.
- **Geometry lives in one place.** `lib/workbench-layout.ts` owns the math and
  `useLayoutStore` (`oa.layout.v1`) persists the choices. The sidebar defaults
  to 264px (220–440px) and opens expanded on first run at ≥1280px. The dock is
  stored as a ratio of the center (default 45%), clamped so the dock keeps
  340px and the chat keeps 400px.
- **Overlay instead of squeeze.** When the dock is maximized (`Mod+Shift+D`) or
  the center is narrower than 740px, the dock covers the chat instead of
  shrinking it. The chat stays mounted underneath (`inert`) so its scroll
  position and live stream survive. Maximize is session-only.
- **Separators are controls.** Resize handles are 6px, keyboard-focusable
  `role="separator"` elements (arrows ±16px, Shift ±64px, Home/End, Enter or
  double-click to reset) whose 1px line lights up in `focus-ring`.
- **One toolbar, one scroller per view.** A view gets at most one 32px toolbar
  under the tab bar and one scrolling region. Lists are flat `divide-y` rows at
  `list-row` height; row actions swap in for trailing metadata on hover/focus
  instead of nesting controls inside the row button.
- **The dock holds views, not just files.** Besides Git, file, diff, commit,
  and terminal tabs, the agent's Tasks and the Scheduled tasks list open as
  closable dock tabs (`Mod+T`, `Mod+S`); pressing the shortcut again while the
  tab is focused hides the dock. The header's review-dock button (`Mod+D`) is
  the one show/hide control. The dock never covers the header, so the tab bar
  carries no hide button. Inline diff peeks never scroll their ancestors.

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
notices (and dialogs opened from them), 70 a menu inside a nested dialog, 9999
tooltips. Write numeric layers as `z-60`, not `z-[60]`.

Keyboard focus uses a solid 2px outline (`#174A73` in light mode, `#9DD0F5`
in dark mode), with a 2px offset. Translucent `focus-ring` effects remain
decorative supplements, not the only focus indicator. Input borders also shift
to `focus-ring`. Focus is never removed without an equally visible replacement.

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
  never `transition-all`. Buttons change colour only, at `instant`.
- **Exit timers match their animation.** `useDeferredUnmount(open, DURATIONS_S.fast * 1000)`
  pairs with `duration-(--motion-fast)`. A bare number drifts.
- **Don't animate layout.** Width, height, inset, margin and padding re-lay-out
  every frame. Progress fills slide with `translate` inside a clipping track,
  and folds use `ui/collapsible` (grid rows at `base`, `inert` when closed).
  The one exception is the pill ↔ card morph of a fixed notice.
- **Everything that opens also closes.** Popovers, menus and suggestion lists
  grow in at `base` (`fast` for small lists) from their anchor. The context
  menu fades out at `fast` when dismissed by pointer, but closes instantly on
  Escape or Tab so the next key lands where focus went.
- **The transcript holds still.** While you read history, the scroller anchors
  to the first visible block, and images reserve their box before they load.
  Following the stream, it writes at most one scroll per frame.
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
  holds a Signal Blue wash for 40% of `linger`, then drains. Renames you make,
  list loads and session switches swap the text with no motion.
- **A live caret follows streaming text.** A 2px Signal Blue bar sits after the
  last paragraph, heading or list item an answer is writing, and blinks at
  `glacial` (`steps(1)`, on or off, never a fade). Code blocks and tables get
  none, and it goes the moment the answer ends. Under reduced motion it stands
  still.
- **Reduced motion snaps.** Every animation and transition drops to ~0ms.
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
them is: **warm paper surface · crisp 1px border · muted text · keycap hover.**

**Buttons** ship seven variants (`default`, `subtle`, `primary`, `ghost`,
`danger`, `danger-subtle`, `link`) across nine standard sizes (`xs`, `sm`, `default`,
`lg`, `trigger`, `icon`, `icon-sm`, `icon-dense`, `icon-xs`). `primary` is a *tonal* emphasis —
`bg-key` with a `border-strong` — not a saturated fill. Hover darkens toward the
keycap wash; active goes one step further. Every variant keeps its border so
buttons never shift size between states.

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

**Mobile Touch Parity Scaling**: On touch devices (`pointer: coarse` / mobile shell), standalone icon actions scale up to a **44×44px touch target** (`h-11 w-11`), while on desktop (`md:`) they collapse to dense **28–32px** (`md:h-7 md:w-7` or `md:h-8 md:w-8`).

- `Button` gets this automatically: a coarse-pointer rule sets `min-height`/`min-width: 44px` on `[data-slot="button"]` (48px in the Android app, Material's minimum). Prefer `Button` over a bare `<button>` for icon actions.
- `--spacing-list-row` becomes 44px on coarse pointers, so sidebar and dock list rows (sessions, sub-sessions, group headers, workspaces) grow with it. Size such rows from the token (`pointer-coarse:h-(--spacing-list-row)`), not a fixed `h-11`. Inline row actions add `pointer-coarse:size-11` (44px) to fill the row. Every touch target is 44px; the composer keeps its own sizes.
- `--spacing-tab-bar` (the review panel's tab strip) grows to 47px on coarse pointers, so each tab and its close control are 44px inside the strip's 2px top edge and 1px bottom border.
- Line height tightens on coarse pointers: `leading-relaxed` is 1.5 (1.625 on desktop) and chat/plan prose (`.oa-prose`) is 1.6 (1.75 on desktop), so phone screens read denser. Text sizes do not change.
- On phones the app header's controls are 44px (`max-md:pointer-coarse:size-11`) and the header grows with them. On wider touch screens, controls inside the 36px header stay within that height (`pointer-coarse:size-9`), because overlays are positioned from `--spacing-app-header`.
- Tabs (`ui/tabs`) are 44px per trigger on touch: the list grows to 50px around them.
- Grow the control itself wherever the layout allows. Two exceptions extend an invisible hit area with a `::before` instead, because growing the element would reflow text or a dense strip: links and file references inside prose (`.oa-prose a`, `[data-file-ref]`, 44px tall) and small icon buttons in code-block and tool-detail headers (`.touch-hit` on a positioned element, 44×44 around it). Keep such targets apart so neighbours do not steal each other's taps.
- Rows with a long-press action sheet set `-webkit-touch-callout: none` (`LongPressButton` does this while enabled).

**Inputs** use `bg-input` (matching the page, not the card) with a 1px border.
Focus shifts the border to `focus-ring` and adds a 30% ring. Borders never change
width on hover — that causes a 1px layout jump.

**Transcript folds** (`hooks/useStickyFold.ts`): anything in the transcript that
opens into a long body — the reader work row, the compaction divider, a long
prompt or subagent report, a tool call's details, the "N files changed" list —
pins its header (or its collapse control) to the top of the transcript while
open (`PINNED_HEADER` plus the surface fill), so it can close from anywhere.
A header inside an open fold pins just below the fold's row (`--fold-top`), not
over it. Closing leaves the header where the pressed control was, so the view
never jumps. A long body also ends in a Collapse row when its header is the
only other way to close it. Clip with `overflow-clip`, not `overflow-hidden`,
on a box that holds a pinned control: a hidden-overflow box stops it pinning.

**Floating Menus & Context Menus** (`ui/menu-styles.ts` — dropdowns, context menus and hand-built listboxes all import it):
- **Panel**: `rounded-sm`, 1px `border-(--color-border)`, `bg-(--bg-card)`, `p-1`, `shadow-depth`.
- **Items**: `rounded-xs`, 28px height (`px-2 py-1.5`), `text-xs`, text `on-surface-2`, hover/focus `bg-(--bg-key)` and `on-surface`.
- **Destructive Items**: `text-(--color-error)`, hover `bg-(--color-error-subtle)`.
- **Dividers**: `1px border-t border-(--color-border-subtle) my-1`.

**Segmented Controls & Connected Tabs**:
- **Container**: `rounded-sm`, 1px `border-(--color-border)`, `bg-(--bg-key)` (or `bg-card`), `p-0.5`.
- **Active Segment**: `rounded-xs`, `bg-(--bg-card)` (or `bg-page`), no border colour (the fill alone marks it), `text-(--color-text)`, `font-medium`.
- **Inactive Segment**: `rounded-xs`, 1px `border-transparent`, `text-(--color-text-muted)`, hover `text-(--color-text-2)`.
- **Sizes**: `TabsList size="sm"` is the 24px variant for dense panel toolbars (12px label, no shadow).
- **Primitive**: pick-one controls use `SegmentedControl` (`ui/segmented-control.tsx`) — radio semantics with arrow-key roving, `default` (32px, 44px on touch), `sm` (24px) and `composer` (32px, 28px from `md`, never grown on touch, so it matches the attach and send buttons beside it). Controls that need toggle-button semantics reuse its `segmentedTrackClass` / `segmentedItemClass`. `TabsList` stays for real tab panels.

**Editor Tabs** (review dock tab bar):
- **Strip**: `tab-bar` height on `bg-sidebar`; tabs scroll horizontally, actions stay pinned right.
- **Active Tab**: `bg-page` with a 2px Bark (`--color-accent`) top edge and no bottom border, so it opens onto the content below.
- **Inactive Tab**: transparent top edge, 1px bottom `border`, `text-(--color-text-muted)`, hover `bg-key` wash.
- **Close**: a sibling `<button>` (never nested in the tab button), always visible on the active tab and on touch, hover-revealed otherwise; middle-click also closes.
- **Semantics**: tabs are buttons with `aria-current`, not an ARIA `tablist` — terminal tabs carry their own context menu and sheet.

**Badges & Counters**:
- **Agent / Status Chip**: `rounded-full`, 20px height, `px-2 py-0.5`, `label-sm` (11px).
- **Counter / Sync Badge**: `rounded-full`, `bg-(--bg-key)`, `text-(--color-text-subtle)`, JetBrains Mono 11px, `px-1.5 py-0.5`.
- **Kbd Shortcut Badge**: `rounded-xs`, 1px `border-(--color-border)`, `bg-(--bg-card)` (or `bg-key`), JetBrains Mono 10–11px, `px-1.5 py-0.5`.

**Chips** (`ui/chip.tsx`): the one small label for states, identifiers and
tags. 18px, `rounded-xs`, 11px, tones `neutral | info | success | warning |
error`, styles `soft` (states) and `outline` (tags such as a provider `agy`
or a transport `stdio`). Mono for identifiers and numbers (`exit 1`,
`429 rate_limit`), sans for words (`not yet`, `Vision`). A status chip always
carries text, never colour alone; `dot` adds a leading dot for live states.
Do not hand-roll pills; reach for `Chip` (agent identity chips keep their
full-radius triplet).

**Transcript rows** (`ui/meta-row.tsx`): tool calls, reader steps and file
operations share one row: the content on the left and a right-aligned 96px
meta column of tabular mono numbers (`33 ms`, `2.4 s`, `exit 1`), so values
line up down the transcript. 28px, 36px on touch. No icon gutter: the real
tool name in mono leads (`shell`, `grep`, `team_spawn`), then the target in
mono, then a short result summary in muted sans. A running row has a 6px
blue dot before the name and a live timer in the meta column; text never
blinks. A failed row shows its summary in error colour and an `exit 1` or
`error` chip. Rows without details render as a `div`, not a button.

**Confirmations** (`ui/confirm-dialog.tsx`): every action that cannot be
undone (stop a server, regenerate a key, delete, discard edits, revert a
commit, cut retention) asks first. The title says what happens, the
description what is lost, Cancel sits before the `danger` action, and its
menu item ends in "…".

**Icons: as few as possible.** Icons stay where they already are (icon
buttons such as copy, edit, close; chevrons that expand and collapse; the
header and composer). Do not add icons to transcript rows, meta lines,
dividers or card headers, and do not put an icon before a label that is
already clear. State is carried by words and chips.

**Section cards** are the dominant grouping pattern and come in two variants:

- **Titled sections** (`ui/panel-section`) are the default for panels,
  overlays and forms. The title (12px semibold, sentence case), an optional
  one-line description and right-aligned actions sit *above* a bordered
  `bg-card` card, which holds padded content or flush `divide-y` rows.
- **Dense section cards** (`ui/section-card`) put a `bg-key` header strip in
  `label-caps` inside the card, then `divide-y` rows that lift toward
  `bg-page` on hover. They are for data surfaces where every row counts, such
  as Telemetry breakdowns.

The sidebar keeps its own caps section headers (below).

**Sidebar sections** stack Pinned, Needs you, the session list and Scheduled
in one scroller. Each section header is a `label-caps` label with a count; a
header (32px) or group header (24px) folds its list. The list's header row
holds the icon actions (`md:` 24px, 44px on touch): New session (only where
there is no per-folder **+**, i.e. the flat views, and always on phones),
Search, **View options**, Collapse all (folder tree only) and Open folder.
View options is a context menu of `menuitemradio` groups (Group by, Sort by)
and a `menuitemcheckbox` (Show details); it stays open while choices apply.
Rows in flat views and Pinned name their workspace in mono 11px subtle text,
which gives way first when the row is narrow.

**Sidebar row actions** share one style (`ROW_ACTION` in `ui/list-row.ts`):
24px, borderless, `rounded-xs`, subtle glyph, keycap wash on hover, the
global focus ring, 44px on touch. They take the place of the row's meta (age,
tags) on hover or keyboard focus and hold no room at rest, so titles and
folder names keep the row; touch shows them always, except Pin, which stays
in More on touch so the title keeps the room. Session rows offer **Pin**
and **More**, subagent rows **More**, folder rows **+** and **More**. More
opens the same menu as right-click, so destructive actions are never one
click from a row. Text actions in rows ("Show all") use `ROW_TEXT_ACTION`
(24px), and count chips (subagents, worktrees) one 20px mono pill
(`rowChipClass`) that inks when active. Long titles always truncate: a fold
must never take the width of its longest line.

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
the body (16px, or 12px when `compact`); `none` panels lay out their own. Dialog footers order
Cancel (`default`) before the confirm action (`primary`, or `danger` when
destructive), all at the `default` size.

Inside a modal panel the scrolling body uses `OVERLAY_BODY` (`px-4 py-5`,
`md:px-6 md:py-6`) and stacks titled sections 32px apart. A form's commit
actions sit in a footer bar under the scroller (`border-t`, `bg-sidebar`,
right-aligned), in the same order as `DialogFooter`: Cancel before the
primary action.

**App-level overlays** (Settings, Telemetry) share the `settings-modal-shell`
geometry, mount at the root so any route can open them, and are mutually
exclusive with the palette and utility panels. Telemetry reads top-down: a
filter bar (range, workspace, model, session chip), a headline stat strip,
per-day activity, then dense section-card breakdowns whose rows double as
filters, then recent turns. Escape steps out of a trace before it closes the overlay.

**Panels and management surfaces** (Settings, Scheduled tasks, Session
settings, Keyboard shortcuts, the Backend connection dialog) are roomier than
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
  Model IDs show short and mono (`claude-sonnet-4-6`) with a provider tag
  (`agy`); the full ID is in the tooltip.
- **One name per thing.** Workspace (not project or repo), Worktree,
  Rename, Tasks, Scheduled tasks, Review panel, Side questions, Find file,
  Session, Built-in server, Main agent / Subagent, Run now, Usage (the
  spend and trace overlay), Data retention (its Settings page).

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
  and media, Data and safety, About), no icons, counts in words ("4 skills",
  "1 needs sign-in"), a "Search settings" box on top.
- **One save rule.** A page of fields keeps a draft and saves from the save
  bar (Save, ⌘S, "Discard…" asks first); when Save is blocked the bar says
  why. A lone switch or a list action (add a group, hide a provider) saves at
  once and confirms with a toast. An editor (agent, skill, MCP server,
  memory page) saves from its header; Discard and Back with unsaved edits
  ask first. Loading is a skeleton; a load error is a Callout with Retry.
- **Long lists are rows, not cards.** Providers is one bordered list of
  rows (name, a subline such as "API key · 1 key · 13 models", a status
  chip); a row opens in place. Secondary row actions go in a "More" menu.
- **Backend connection.** The same `AppBackendPanel` appears as Settings →
  Connection and as the Backend connection dialog. The dialog is used before
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
from Rust (`desktop/src-tauri/src/window.rs`, `{x: 12, y: 20}`; the JSON config
value is ignored for builder-created windows), which centres them against the
36px header and is why `mac-traffic-inset` is 70px (12px origin + ~58px button
group). Reference window is 1280×820, floor 820×640.

Inside Tauri, `lib/desktop-shell.ts` sets `<html data-shell="desktop">`. Under
it, chrome is `user-select: none` with the arrow cursor on buttons (links keep
the pointer), and only content selects: inputs, `.selectable-text`,
`.oa-prose`, `pre`, `code` and `.xterm`. Images and links do not drag out. The
webview's own right-click menu is suppressed except in text fields, over
selected text, and in dev builds; transcript surfaces offer app menus instead.
While another app has focus, `data-window-inactive` hides focus rings, turns
text selection to `--bg-key` and mutes `aria-current` items, the way Finder
greys its selection. The browser build keeps the browser's behaviour.

The macOS tray popup (`web/tray.html`) is a separate, small entry with no
Tailwind. Its stylesheet `tray/tray.css` imports `styles/tokens.css`, the same
palette and motion tokens as the app; only its glass surface and shadows are
its own (`tray-css.test.ts` holds the rest to tokens). It follows the OS
appearance, not a window's theme, and the window is sized to the popup's
content, 360px wide and up to 600px tall.

### Keyboard focus model

Tab follows the DOM order: every control is its own Tab stop. Composite
widgets (tablists, menus, listboxes, comboboxes) keep their own arrow keys.

- **Hover-revealed row actions** also show on `focus-within`, and keep a
  keyboard shortcut: F2, Delete, Shift+F10 / the Menu key (`lib/focus/item-keys.ts`).
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
it came from the keyboard.

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
iOS's default of 17px. The scale never goes below 1, because the 11px floor
assumes the design size, and stops at 1.25. Everything in rem scales with it:
text, spacing, and touch targets. Px sizes do not.

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
- **Type**: the wordmark is outlines, so the app needs no extra font. Inter and
  JetBrains Mono stay the only UI faces; Schibsted Grotesk appears only inside
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
- Do use `tertiary` (Signal Blue) as the only interaction color, and `bg-send`
  as the only inverted surface.
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
