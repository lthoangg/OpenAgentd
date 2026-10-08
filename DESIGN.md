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
  card-header:
    backgroundColor: "{colors.bg-key}"
    textColor: "{colors.on-surface-muted}"
    typography: "{typography.label-caps}"
    padding: 8px
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
  horizontal padding.
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
  affordance.
- **Neutral (#FAF6EC) — "Paper."** The page foundation. Warmer and softer than
  white, which keeps long agent transcripts comfortable.

### Surface ramp

Surfaces step tonally, not by elevation. Cards sit *lighter* than the page:

`bg-sidebar (#F5EFDD)` → `bg-page (#FAF6EC)` → `bg-card (#FFFBF1)` → `surface (#FFFDF7)`

`bg-key (#F0E9D4)` is the "keycap" wash — hover and pressed states, section-card
header strips, and keyboard-shortcut badges. `bg-send (#2D241B)` is the one
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

`label-caps` (11px, 600, +0.05em, uppercase) marks section-card headers and
group labels. It is the only uppercase style in the system, and ships as the
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

**Mobile-first authoring is mandatory.** Base (unprefixed) styles target the
phone; `md:` (768px) and up progressively add desktop affordances. Never author
desktop-first and walk styles back down.

**Fixed geometry:**

- `app-header` (36px) — the shared top bar across every platform shell.
- `status-bar` (24px) — the desktop status footer.
- `tab-bar` (36px) — the review dock's editor-tab strip.
- `toolbar` (32px) — the single view toolbar under a tab bar.
- `list-row` (28px) — sidebar and dock list rows (`ui/list-row.ts` holds the
  shared geometry and the hover / current washes).
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
| `glacial` | 800ms | Ambient/looping only |

Easings: `ease-out` `cubic-bezier(.16,1,.3,1)` for entrances, `ease-in-out`
`cubic-bezier(.4,0,.2,1)` for state changes, `ease-spring-soft`
`cubic-bezier(.34,1.2,.64,1)` and `ease-spring-snappy`
`cubic-bezier(.22,1.4,.36,1)` for gestural affordances.

The animation library owns the CSS `transform` property. Never use `transform`
for layout (no `translateX(-50%)` centering) — center fixed elements with
`margin: auto` against `left: 0; right: 0`.

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

- `Button` gets this automatically: a coarse-pointer rule sets `min-height`/`min-width: 44px` on `[data-slot="button"]`. Prefer `Button` over a bare `<button>` for icon actions.
- `--spacing-list-row` becomes 44px on coarse pointers, so sidebar and dock list rows grow with it. Inline row actions add `pointer-coarse:size-9` (36px) to fill the taller row.
- Controls inside the 36px app header and tab bar grow only to that height (`pointer-coarse:size-9`, tab close `pointer-coarse:size-8`), because overlays are positioned from `--spacing-app-header`.
- Grow the control itself. Do not stretch hit areas with pseudo-elements: adjacent actions would steal each other's taps.
- Rows with a long-press action sheet set `-webkit-touch-callout: none` (`LongPressButton` does this while enabled).

**Inputs** use `bg-input` (matching the page, not the card) with a 1px border.
Focus shifts the border to `focus-ring` and adds a 30% ring. Borders never change
width on hover — that causes a 1px layout jump.

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

**Section cards** are the dominant grouping pattern: a bordered `bg-card`
container, a `bg-key` header strip in `label-caps`, then `divide-y` rows that
lift toward `bg-page` on hover.

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

**App-level overlays** (Settings, Telemetry) share the `settings-modal-shell`
geometry, mount at the root so any route can open them, and are mutually
exclusive with the palette and utility panels. Telemetry reads top-down: a
filter bar (range, workspace, model, session chip), a headline stat strip,
per-day activity, then section-card breakdowns whose rows double as filters,
then recent turns. Escape steps out of a trace before it closes the overlay.

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
| iOS launch screen | `gen/apple/LaunchScreen.storyboard` | `systemBackground` | ✗ pure white, no dark variant |
| Window background | `tauri.conf.json` → `app.windows[]` | — | ✗ unset, inherits webview default |
| Browser / OS chrome | `index.html` `theme-color` + `lib/theme.ts` | `#FAF6EC` / `#15110D` | ✓ correct |
| Pre-paint CSS | `index.html` `<style>` | `#FAF6EC` / `#15110D` | ✓ correct |
| Theme class | `public/theme-init.js` | sets `.light`/`.dark` on `<html>` | ✓ correct |

The last three links are right; the first two are not. `backgroundColor` should
be set on both window configs.
The iOS launch screen is the hardest case — `mobile/src-tauri/gen/` is gitignored
and regenerated by `tauri ios init`, so it needs a template override or a
post-generate script rather than a direct edit. Dark mode is the worst offender:
pure-white launch → `#15110D` app.

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

### Keyboard focus model

Tab follows the DOM order: every control is its own Tab stop. Composite
widgets (tablists, menus, listboxes, comboboxes) keep their own arrow keys.

- **Hover-revealed row actions** also show on `focus-within`, and keep a
  keyboard shortcut: F2, Delete, Shift+F10 / the Menu key (`lib/focus/item-keys.ts`).
- **Quiet focus**: focus a script hands back without a key press (the
  composer pill on page load) goes through `focusQuietly`
  (`lib/focus/quiet.ts`), so it draws no ring until the keyboard moves on.
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

**Interaction**

- Do keep every interactive element reachable and visibly focused; replace the
  focus ring, never remove it.
- Do keep hover/press feedback on `instant` (80ms) so dense UI feels immediate.
- Don't animate layout with `transform` — the animation library owns that
  property.
- Don't drop below WCAG AA: 4.5:1 for text, 3:1 for large text and UI boundaries.
