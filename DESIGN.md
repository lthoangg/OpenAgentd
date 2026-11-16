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

**Three rules decide what is on screen.** There is no separate simple mode;
each rule extends something every surface already does.

- **Where you are decides.** Chat, a folder without Git and a Git repository
  each offer only what they can use. A view, menu item or command that could
  only explain why it does not apply here (a Changes view outside Git,
  "Create worktree…" in a plain folder, `/init` in Chat) is not shown.
- **One Detail setting: Simple or Full** (Settings → Appearance → Detail). A
  new install starts in Simple. Full is the app as this document describes
  it. Simple folds each turn's work into one row and drops the numbers
  around the chat: the model chip names the model only, the context ring
  appears from 70% full, the status bar shows no spend, a retry reads as a
  sentence. Nothing else forks on it: the line under a reply, Turn details,
  the working row, cards and every control are the same in both.
- **Empty things take no room.** A heading with nothing under it, or a row
  that says "turn on X to change this", does not show until it can be used.
  The first of anything is created from the palette, a "+" or the agent.

## Map

The rules are in chapters under [`design/`](design/). Read this page, then the
chapter for what you change. Do not load every chapter.

| You are changing | Read |
|---|---|
| A colour, a type step, a radius, a shadow or a layer | [`design/foundations.md`](design/foundations.md) |
| Spacing, fixed sizes, safe areas, or the desktop workbench (sidebar, dock, panes) | [`design/layout.md`](design/layout.md) |
| Anything that moves, fades or resizes | [`design/motion.md`](design/motion.md) |
| A button, input, menu, tab, chip, badge, status, date, dialog or overlay, and the twelve numbered rules every screen follows | [`design/rulebook.md`](design/rulebook.md) |
| The transcript (tool rows, cards, the turn footer), the composer and its run controls, or a bottom sheet | [`design/chat.md`](design/chat.md) |
| The sidebar, the header, notices or the command palette | [`design/navigation.md`](design/navigation.md) |
| Settings, a management panel, Scheduled tasks or the web preview, and the wording rules | [`design/panels.md`](design/panels.md) |
| The phone layout, the iOS or Android app, or anything touched by a finger (the touch sizes are `Phone scale` in the rulebook) | [`design/phone.md`](design/phone.md) |
| The desktop app's window, title bar, tray, notch or notifications, and what each OS draws itself | [`design/desktop.md`](design/desktop.md) |
| Where keyboard focus goes | [`design/keyboard.md`](design/keyboard.md) |
| The logo or app icon | [`design/brand.md`](design/brand.md) |

A UI change that a phone can show also reads `design/phone.md`: the phone
rules apply to every screen.

**Citing a rule.** Code and tests cite a rule by name, as `DESIGN.md → Motion`
or `DESIGN.md → Rulebook 4`. The name is a heading in this file or a chapter,
or the bold name that opens a bullet. A citation may give only the first words
of the name. Find it with
`grep -rniE '^#+ .*motion' DESIGN.md design/`. `make verify-docs` fails on a
citation that names nothing, so rename a rule and its citations together.

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
