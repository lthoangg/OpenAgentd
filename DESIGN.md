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
  overlay: "rgba(26, 23, 20, 0.40)"

typography:
  display-hand:
    fontFamily: Caveat
    fontSize: 48px
    fontWeight: 700
    lineHeight: 1
  title-hand:
    fontFamily: Caveat
    fontSize: 28px
    fontWeight: 700
    lineHeight: 1
  heading-hand:
    fontFamily: Caveat
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
  xs: 2px
  sm: 4px
  md: 6px
  lg: 8px
  xl: 10px
  2xl: 12px
  3xl: 16px
  4xl: 20px
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
  app-header: 40px
  mac-traffic-inset: 70px
  content-max: 768px
  overlay-max: 860px
  palette-max: 480px

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
    borderColor: "{colors.border-strong}"
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
    backgroundColor: "{colors.bg-card}"
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
- **Technical, with a human hand.** Every functional surface is Inter or
  JetBrains Mono. A single handwritten face (Caveat) appears *only* on brand and
  empty-state headings — the signature in the margin of an otherwise precise
  document.

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

Dark mode inverts the ramp while keeping the same warmth — it is brown-black, not
blue-black. Front-matter tokens carry the canonical light values; substitute
these when `color-scheme: dark`:

| Token | Light | Dark |
|---|---|---|
| `bg-page` / `bg-input` | `#FAF6EC` | `#15110D` |
| `bg-sidebar` / `bg-card` | `#F5EFDD` / `#FFFBF1` | `#1C1813` |
| `bg-key` | `#F0E9D4` | `#2A2219` |
| `bg-send` | `#2D241B` | `#F5EBD8` |
| `surface` / `surface-2` | `#FFFDF7` / `#F5EBD8` | `#221C16` / `#2A2219` |
| `color-bg-elevated` | `#FFFDF7` | `#1C1813` |
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

Three faces, each with a non-overlapping job:

- **Inter Variable** — all interface text and prose. Chosen for legibility at
  11–14px, where most of this UI lives.
- **JetBrains Mono Variable** — code, diffs, terminal output, file paths, token
  counts, IDs. Anything a user might copy, compare character-by-character, or
  scan as a column.
- **Caveat** — brand wordmark, hero headings, and empty states. Nothing else.
  Only the Latin subsets are bundled; the all-subset entrypoint shipped 16 extra
  font files per build for copy that is English-only.

### The scale

`body-sm` (12px) is the workhorse — it is the default for buttons, inputs, rows,
and menus, not a "small" variant. `body-md` (14px) is for comfortable reading
passages; `body-lg` (16px) for long-form prose only.

`meta` and `label-sm` (11px) carry timestamps, counts, and secondary metadata.
**11px is a hard floor.** Anything specified below it is clamped up, so the same
screen never renders differently between desktop and mobile.

`label-caps` (11px, 600, +0.05em, uppercase) marks section-card headers and
group labels. It is the only uppercase style in the system.

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

- `app-header` (40px) — the shared top bar across every platform shell.
- `mac-traffic-inset` (70px) — left inset that clears the macOS traffic-light
  overlay (12px origin + ~58px button group).
- `content-max` (768px) — reading measure for transcripts and prose.
- `overlay-max` (860px) — default modal width cap; `palette-max` (480px) for the
  command palette.

**Safe areas are non-negotiable.** Every outermost shell and overlay applies
`env(safe-area-inset-*)`. Overlays additionally track the visual-viewport offset
so they follow the soft keyboard by translation rather than by resizing — a
height change mid-animation causes visible reflow.

## Elevation & Depth

Depth is **tonal, not shadowed.** Hierarchy is expressed in this order:

1. **Surface step** — move one level along the surface ramp.
2. **Hairline border** — a crisp 1px `border` or `border-subtle`.
3. **Text tone** — demote content by stepping down the text ramp.
4. **Shadow** — last resort.

Only genuinely floating layers (modals, popovers, dropdowns, toasts) use
`shadow-depth`, and it stays soft: `0 1px 2px rgba(0,0,0,.04), 0 2px 8px
rgba(0,0,0,.05)` in light, roughly 6× stronger in dark where tonal steps read
weakly.

Focus is always a 2px `focus-ring` at 30–40% alpha, plus a border shift to full
`focus-ring` on inputs. It is never removed — only replaced.

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

The shape language is **restrained softness**. Radii are small enough to feel
engineered, large enough to avoid harshness — the system's most-used radius is
4px, and nothing structural exceeds 8px.

Radius maps to element scale, not to taste:

- `xs` (2px) — 24px controls, badges, inline tags.
- `sm` (4px) — the default. Cards, inputs, list rows, 32px controls.
- `md` (6px) — 36px+ buttons and icon buttons.
- `lg` (8px) — overlays and modals. This is the ceiling for panels; every
  `AppOverlay` panel shares it so the whole overlay family reads as one system.
- `full` — pills only: agent chips, status chips, avatars, the send button.

`xl` through `4xl` exist for illustration and marketing surfaces and should not
appear in application chrome.

## Components

Primitives are hand-rolled — plain elements plus variant maps and CSS custom
properties. No component framework, no `cva`. The shared language across all of
them is: **warm paper surface · crisp 1px border · muted text · keycap hover.**

**Buttons** ship seven variants (`default`, `subtle`, `primary`, `ghost`,
`danger`, `danger-subtle`, `link`) across eight standard sizes (`xs`, `sm`, `default`,
`lg`, `trigger`, `icon`, `icon-sm`, `icon-xs`). `primary` is a *tonal* emphasis —
`bg-key` with a `border-strong` — not a saturated fill. Hover darkens toward the
keycap wash; active goes one step further. Every variant keeps its border so
buttons never shift size between states.

**Button Size Metrics Binding (Strict)**:

| Size Token | Control Height | Padding | Icon Size | Label Font | Radius | Primary Use |
|---|---|---|---|---|---|---|
| `xs` | **24px** (`h-6`) | `px-2` | 11px | `11px` (`label-sm`) | `rounded-xs` (2px) | Inline table actions, compact badges |
| `sm` | **32px** (`h-8`) | `px-2.5` | 13px | `12px` (`body-sm`) | `rounded-sm` (4px) | Toolbar actions, form secondary buttons |
| `default` | **36px** (`h-9`) | `px-3` | 14px | `12px` (`body-sm`) | `rounded-md` (6px) | Standard form buttons, dialog triggers |
| `lg` | **40px** (`h-10`) | `px-4` | 16px | `14px` (`body-md`) | `rounded-md` (6px) | Modal primary actions, main CTA |
| `trigger` | **auto** | `px-2 py-1` | 11px | `12px` (`body-sm`) | `rounded-md` (6px) | Dropdown & select trigger |
| `icon-xs` | **24×24px** | `p-0` | 11px | — | `rounded-xs` (2px) | Inline row utilities (copy, delete) |
| `icon-sm` | **32×32px** | `p-0` | 13px | — | `rounded-sm` (4px) | Toolbar icon buttons |
| `icon` | **36×36px** | `p-0` | 14px | — | `rounded-md` (6px) | Standard standalone icon actions |

**Mobile Touch Parity Scaling**: On touch devices (`pointer: coarse` / mobile shell), standalone icon actions scale up to a **44×44px touch target** (`h-11 w-11`), while on desktop (`md:`) they collapse to dense **28–32px** (`md:h-7 md:w-7` or `md:h-8 md:w-8`).

**Inputs** use `bg-input` (matching the page, not the card) with a 1px border.
Focus shifts the border to `focus-ring` and adds a 30% ring. Borders never change
width on hover — that causes a 1px layout jump.

**Floating Menus & Context Menus**:
- **Panel**: `rounded-sm`, 1px `border-(--color-border)`, `bg-(--bg-card)`, `p-1`, `shadow-depth`.
- **Items**: `rounded-xs`, 28px height (`px-2 py-1.5`), `text-xs`, text `on-surface-2`, hover/focus `bg-(--bg-key)` and `on-surface`.
- **Destructive Items**: `text-(--color-error)`, hover `bg-(--color-error-subtle)`.
- **Dividers**: `1px border-t border-(--color-border-subtle) my-1`.

**Segmented Controls & Connected Tabs**:
- **Container**: `rounded-sm`, 1px `border-(--color-border)`, `bg-(--bg-key)` (or `bg-card`), `p-0.5`.
- **Active Segment**: `rounded-xs`, `bg-(--bg-card)` (or `bg-page`), 1px `border-(--color-border-strong)`, `text-(--color-text)`, `font-medium`.
- **Inactive Segment**: `rounded-xs`, 1px `border-transparent`, `text-(--color-text-muted)`, hover `text-(--color-text-2)`.

**Badges & Counters**:
- **Agent / Status Chip**: `rounded-full`, 20px height, `px-2 py-0.5`, `label-sm` (11px).
- **Counter / Sync Badge**: `rounded-full`, `bg-(--bg-key)`, `text-(--color-text-subtle)`, JetBrains Mono 11px, `px-1.5 py-0.5`.
- **Kbd Shortcut Badge**: `rounded-xs`, 1px `border-(--color-border)`, `bg-(--bg-card)` (or `bg-key`), JetBrains Mono 10–11px, `px-1.5 py-0.5`.

**Section cards** are the dominant grouping pattern: a bordered `bg-card`
container, a `bg-key` header strip in `label-caps`, then `divide-y` rows that
lift toward `bg-page` on hover.

**Agent chips** are `full`-radius pills using the identity triplet — soft
background, tuned text tone, solid dot.

**Overlays & Dialogs** come in three geometries — `modal` (centered card, capped at
`overlay-max`), `sheet` (edge drawer), and `palette` (compact 480px search card).
All three are `position: fixed`, share `rounded-lg` (8px — the panel ceiling) and a 1px border, and go
edge-to-edge below 768px. `rounded-xl` through `rounded-4xl` are strictly banned from application chrome.

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
| Browser / OS chrome | `index.html` `theme-color` | `#FAFAFA` / `#0A0A0B` | ✗ cool neutrals, not paper |
| Pre-paint CSS | `index.html` `<style>` | `#FAF6EC` / `#15110D` | ✓ correct |
| Theme class | `public/theme-init.js` | sets `.light`/`.dark` on `<html>` | ✓ correct |

The last two links are right; the first three are not. `theme-color` should be
`#FAF6EC` / `#15110D`, and `backgroundColor` should be set on both window configs.
The iOS launch screen is the hardest case — `mobile/src-tauri/gen/` is gitignored
and regenerated by `tauri ios init`, so it needs a template override or a
post-generate script rather than a direct edit. Dark mode is the worst offender:
pure-white launch → `#15110D` app.

Desktop partially hides this by shipping the window with `visible: false` and
revealing it once the webview is ready. Mobile launches `visible: true`, so the
flash is fully exposed there.

### Desktop chrome

The macOS window uses `titleBarStyle: "Overlay"` with `hiddenTitle: true`, so the
app's own 40px `app-header` *is* the title bar. `trafficLightPosition` is
`{x: 12, y: 22}`, which is exactly why `mac-traffic-inset` is 70px (12px origin +
~58px button group). Reference window is 1280×820, floor 820×640.

### Mobile shell

The Tauri webview sets `data-mobile-shell` on `<html>`, which switches the
document to `position: fixed` and disables text selection outside content
regions. Reference viewport is 390×844.

Keyboard handling is the subtle part: `--app-vh` and `--app-vt` track the visual
viewport, and overlays follow the keyboard by **translating** rather than
resizing. While the keyboard is up, `.pb-safe` drops from the home-indicator
inset to a flat 8px, because the indicator is hidden behind the keyboard and the
inset would only waste a strip of space.

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
- Don't use Caveat outside brand headings and empty states.
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
