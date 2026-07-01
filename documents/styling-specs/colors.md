---
title: Color Palette
description: Paper-warm palette, agent-chip identity, semantic tokens, marker chart palette, accessibility compliance
status: stable
updated: 2026-05-09
---

# Color Palette

## Overview

OpenAgentd is rendered on **warm paper**: a cream `#FAF6EC` page tone in light mode, deep ink `#15110D` in dark. Surfaces, borders, and text all sit on a warm-neutral axis — slightly chromatic, never sterile gray. On top of that quiet base, **agent-chip pastels** (mint / blue / orange / pink) carry agent-role identity, and the **Octobot brand pigments** (Agent Gold, Loop Orange, Kernel Brown) appear in the mascot and brand surfaces.

**Core principle**: color is communication. Surfaces stay warm-neutral so prose and code can dominate; saturated color is reserved for agent identity, state signals, and meaningful action.

---

## Three palettes, three jobs

| Palette | Job | Where it appears |
|---|---|---|
| **Paper neutrals** | The page itself — surfaces, borders, body text | Sidebar, message canvas, input bar, every chrome surface |
| **Agent chips** | Identifies which agent is talking or selected | Topbar agent toggles, chip badges next to messages |
| **Octobot brand** | Brand identity — mascot, lockups, hero moments | Logo, splash, marketing, app icon |

The three palettes do **not** interchange. Brand gold is never used as a chip color. A chip color is never used for body text. Paper neutrals are never used as a chart color.

---

## Paper neutrals — surfaces, borders, text

The foundation tokens. Every chrome surface, every divider, every line of body text resolves to one of these.

### Surface & background

| Token | Light mode | Dark mode | Usage |
|---|---|---|---|
| `--bg-page` | `#FAF6EC` | `#15110D` | Page background, message canvas |
| `--bg-sidebar` | `#F5EFDD` | `#1C1813` | Sidebar background |
| `--bg-card` | `#FFFBF1` | `#1C1813` | Cards, popovers, dropdowns |
| `--bg-input` | `#FAF6EC` | `#1C1813` | Text input backgrounds |
| `--bg-key` | `#F0E9D4` | `#2A2219` | Keyboard cap surfaces, raised badge backgrounds |
| `--bg-send` | `#2D241B` | `#F5EBD8` | Primary CTA surface (inverted vs page) |
| `--color-surface` | `#FFFDF7` | `#221C16` | Generic elevated surface |
| `--color-surface-2` | `#F5EBD8` | `#2A2219` | Generic raised surface |
| `--color-bg-elevated` | `#FFFDF7` | `#1C1813` | Hover surface for elevated content |

### Borders

| Token | Light mode | Dark mode | Usage |
|---|---|---|---|
| `--border-soft` | `#E7DCBF` | `#2C231A` | Subtle dividers |
| `--border-card` | `#D9CFA9` | `#3A2F23` | Card and badge borders |
| `--color-border-subtle` | `#E7DCBF` | `#2C231A` | Decorative dividers |
| `--color-border` | `#D9CFA9` | `#3A2F23` | Default borders |
| `--color-border-strong` | `#B8A47E` | `#5C4B36` | Section breaks, prominent borders |

### Text & foreground

| Token | Light mode | Dark mode | Usage |
|---|---|---|---|
| `--color-text` | `#1A1714` | `#F5EBD8` | Primary text, headings |
| `--color-text-2` | `#4B3E32` | `#C5B59A` | Secondary text |
| `--color-text-muted` | `#6E604F` | `#9C8A72` | Hints, placeholders, timestamps |
| `--color-text-subtle` | `#8E7E68` | `#7A6B58` | Disabled text, faint metadata |
| `--color-text-on-accent` | `#FFFDF7` | `#15110D` | Text on filled accent surfaces |
| `--fg-primary` | `#1F1A14` | `#F5EBD8` | Strong foreground (mascot lines, hand text) |
| `--fg-secondary` | `#4B3E32` | `#C5B59A` | Secondary foreground |
| `--fg-muted` | `#6E604F` | `#9C8A72` | Muted iconography |

### Color accent (UI)

The non-chip accent is a high-contrast warm neutral, used for primary affordances when no agent identity is involved.

| Token | Light mode | Dark mode | Usage |
|---|---|---|---|
| `--color-accent` | `#3F3429` | `#F5EBD8` | Primary CTA, focus ring, active highlights |
| `--color-overlay` | `#1A171466` (40%) | `#00000099` (60%) | Modal backdrops |

---

## Agent chip palette

Each agent role gets a soft pastel chip with a saturated edge color and a darker text color for readability. Chips are used in topbar toggles, message author tags, and queue indicators.

| Role | Soft (fill) | Edge (icon, dot) | Text | Pencil token prefix |
|---|---|---|---|---|
| `openagentd` (router) | `#E2F2E5` / `#1F3A2A` | `#3DA66A` / `#5DC487` | `#15573D` / `#92E0B0` | `accent-green-*` |
| `executor` | `#DCEEFB` / `#1E3A52` | `#5AA8E2` / `#7CC2F0` | `#174A73` / `#9DD0F5` | `accent-blue-*` |
| `consultant` | `#FFF1D8` / `#3D2D14` | `#F59E3B` / `#FDB75D` | `#873E05` / `#FCC780` | `accent-orange-*` |
| `explorer` | `#FBE0EB` / `#3D1F2D` | `#A21D52` / `#F472B6` | — (use `--color-text` on soft) | `accent-pink-*` |
| Reserved (memory, scheduler) | `#E8DEF8` / `#2D2440` | `#5A34D1` / `#A78BFA` | — | `accent-purple-*` |
| Error / destructive | — | `#A71C24` / `#F87171` | — | `accent-red` |'}

**Format** for each token: `light-mode-value` / `dark-mode-value`.

**Usage rules:**

- **Soft fill + edge dot + text label** is the canonical chip composition. Color alone never identifies an agent.
- The same chip color set is used in the topbar role toggle (`OpenagentdChip`, `ExecutorChip`, `ConsultantChip`, `ExplorerChip`) and in the message author badge — same color, same role, no exceptions.
- Don't use chip colors as page accents, dividers, or chart series. They're identity-reserved.
- A chip's *edge* color (e.g. `#3DA66A`) is the only place that pigment appears outside the chip — use it for the leading dot in queue banners or status badges tied to that agent.

### CSS implementation

```css
:root.light {
  --accent-blue:        #5AA8E2;
  --accent-blue-soft:   #DCEEFB;
  --accent-blue-text:   #2D6FA8;

  --accent-green:       #3DA66A;
  --accent-green-soft:  #E2F2E5;
  --accent-green-text:  #2D7A4F;

  --accent-orange:      #F59E3B;
  --accent-orange-soft: #FFF1D8;
  --accent-orange-text: #C26A1E;

  --accent-pink:        #E63D7A;
  --accent-pink-soft:   #FBE0EB;

  --accent-purple:      #7C5BCF;
  --accent-purple-soft: #E8DEF8;

  --accent-red:         #C8333E;
}

:root.dark {
  --accent-blue:        #7CC2F0;
  --accent-blue-soft:   #1E3A52;
  --accent-blue-text:   #9DD0F5;

  --accent-green:       #5DC487;
  --accent-green-soft:  #1F3A2A;
  --accent-green-text:  #92E0B0;

  --accent-orange:      #FDB75D;
  --accent-orange-soft: #3D2D14;
  --accent-orange-text: #FCC780;

  --accent-pink:        #F472B6;
  --accent-pink-soft:   #3D1F2D;

  --accent-purple:      #A78BFA;
  --accent-purple-soft: #2D2440;

  --accent-red:         #F87171;
}
```

---

## Octobot brand pigments

Reserved for brand assets — the mascot, lockups, app icon, splash, hero marketing surfaces. Never used in product chrome.

| Name | Hex | Usage |
|---|---|---|
| Agent Gold | `#FCC352` | Primary brand surface, badge fills, brand emphasis |
| Loop Orange | `#FA8030` | Energy accent, mascot details, selected brand emphasis |
| Kernel Brown | `#5F2511` | Mascot linework, text on gold, warm dark contrast |
| Shell White | `#FBF8F7` | Light brand surfaces and highlights |
| Console Ink | `#17120F` | Dark brand surfaces |

The product UI's `--bg-page` (`#FAF6EC`) sits intentionally close to Shell White (`#FBF8F7`) — they're meant to feel continuous when the mascot lands on a product page.

---

## Semantic state colors

State colors are **event signals**, not design accents. They overlap deliberately with the agent chip palette: error reuses red, info reuses the blue chip edge, success reuses the green chip edge, warning reuses the orange chip edge. This keeps the system small.

| Token | Light mode | Dark mode | Usage |
|---|---|---|---|
| `--color-success` | `#3DA66A` (= `accent-green`) | `#5DC487` | Confirmations, running agents, validation |
| `--color-warning` | `#F59E3B` (= `accent-orange`) | `#FDB75D` | Alerts, pending states, cautions |
| `--color-error` | `#B91C1C` | `#F87171` | Errors, failures, destructive actions |
| `--color-info` | `#5AA8E2` (= `accent-blue`) | `#7CC2F0` | Information, hints, secondary messaging |

### When to use state colors

| Signal | Color | Example |
|---|---|---|
| Agent is running / streaming | `--color-success` | Pulse dot next to session title |
| Tool call is pending | `--color-warning` | Dashed border on queued row |
| Operation failed | `--color-error` | Error banner, destructive button |
| Informational hint | `--color-info` | First-run tooltip |

### Never use state colors for

- Static branding (logo, heading accents)
- Decoration (section backgrounds, dividers)
- Hierarchy (headers are not "info blue")

### Never rely on color alone

Every semantic color pairs with an icon, a text label, or both.

- A destructive button is colored red **and** carries a trash icon and a "Delete" label.
- A running indicator is a green dot **and** the word "Running".
- An error inline message uses error red **and** the alert glyph.

Colorblind users, low-vision users, and any user glancing at the screen in full sun all rely on the redundant signal.

---

## Marker palette — charts and tints

For data visualization. Marker pigments are slightly more saturated than chip pigments because they need to read against a busy chart background. There is also a low-alpha tint variant for area fills.

| Token | Light mode | Dark mode |
|---|---|---|
| `--color-marker-blue` | `#0284C7` | `#38BDF8` |
| `--color-marker-mint` | `#16A34A` | `#4ADE80` |
| `--color-marker-orange` | `#FA8030` | `#FCC352` |
| `--color-marker-pink` | `#DB2777` | `#F472B6` |
| `--color-marker-yellow` | `#B77900` | `#FBBF24` |
| `--color-violet` | `#7C3AED` | `#A78BFA` |
| `--color-tint-mint` | `#16A34A18` | `#4ADE8026` |
| `--color-tint-orange` | `#FA803018` | `#FCC35226` |
| `--color-tint-violet` | `#7C3AED18` | `#A78BFA26` |

**Series 1 = blue, Series 2 = mint, Series 3 = orange, Series 4 = pink, Series 5 = yellow.** Never use brand gold/orange or chip colors as chart series unless the series literally represents OpenAgentd or a specific named agent.

---

## Syntax highlighting — code

Syntax tokens use the marker palette plus a softened comment color so prose and code feel continuous.

| Token | Light mode | Dark mode | Element |
|---|---|---|---|
| `--color-syn-comment` | `#6E604F` | `#9C8A72` | Comments — `--color-text-muted` |
| `--color-syn-keyword` | `#7C3AED` | `#A78BFA` | Keywords, reserved words |
| `--color-syn-function` | `#026F9E` | `#38BDF8` | Function/method names |
| `--color-syn-variable` | `#B91C1C` | `#F87171` | Variable names |
| `--color-syn-string` | `#15803D` | `#4ADE80` | String literals |
| `--color-syn-number` | `#A16207` | `#FBBF24` | Numeric literals |
| `--color-syn-type` | `#B45309` | `#FCC780` | Type annotations |
| `--color-syn-operator` | `#4B3E32` | `#C5B59A` | Operators, punctuation — `--color-text-2` |

---

## Depth & focus

| Token | Light mode | Dark mode | Usage |
|---|---|---|---|
| `--focus-ring` | `--color-accent` (`#3F3429`) | `--color-accent` (`#F5EBD8`) | 2px ring on `:focus-visible`, 2px offset |
| `--shadow-depth` | `0 1px 2px rgba(0,0,0,0.04), 0 2px 8px rgba(0,0,0,0.05)` | `0 1px 2px rgba(0,0,0,0.3), 0 2px 8px rgba(0,0,0,0.25)` | Card elevation |

**Why both modes get a shadow.** Unlike a cool dark theme where brightness steps create depth, the warm dark mode (`#15110D` page, `#1C1813` card) has very compressed surface differences. A subtle outer shadow restores hierarchy on dark just as it does on light. Keep them small — paper isn't supposed to feel glossy.

---

## Radius scale

The paper aesthetic is generous with radius. Cards and the input bar sit at `radius-lg` or larger. **Full pills (`rounded-full`) are reserved for shapes whose visual job is *to be circular* — dots, avatars, progress-bar endcaps.** Agent chips, role toggles, and status badges use `--radius-md` so they read as soft-cornered tags, not pharmacy capsules.

| Token | Value | Usage |
|---|---|---|
| `--radius-xs` | 6px | Tiny chips, code-inline backgrounds |
| `--radius-sm` | 8px | Small components, table cells |
| `--radius-md` | 10px | Standard buttons, inputs, **agent chips, role toggles, status badges** |
| `--radius-lg` | 14px | Cards, popovers, message bubbles |
| `--radius-2xl` | 24px | Input bar, hero CTAs |

---

## Gradient usage

The paper aesthetic intentionally avoids gradients in chrome. The only sanctioned gradient is on the **mascot itself** (the source PNG already contains warm gradient lighting). Do not apply gradients to:

- Buttons or CTAs
- Card backgrounds
- Text
- Headings
- Any UI surface

If a surface needs differentiation from `--bg-page`, use `--bg-card` or `--color-surface` — flat warm neutrals, not gradients.

---

## Brand pigment on light backgrounds

When brand pigment lands on the warm page (`#FAF6EC`), use these contrast pairings:

- **Agent Gold chip text** — use `#5F2511` (Kernel Brown), not pure black
- **Wordmark on Shell White** — use `#1A1714` (`--color-text`)
- **Loop Orange** — never as body text on light; only as accent strokes or icon fills
- **Octobot mascot lines** — Kernel Brown is canonical; do not recolor

---

## Accessibility (WCAG 2.1 AA)

All token pairs verified against their own background. Spot-check ratios for the most common pairings:

| Pairing | Light mode | Dark mode | WCAG |
|---|---|---|---|
| `text` on `bg-page` | 16.5:1 | 15.9:1 | AAA |
| `text-2` on `bg-page` | 9.6:1 | 9.4:1 | AAA |
| `text-muted` on `bg-page` | 5.6:1 | 5.6:1 | AA |
| `text-subtle` on `bg-page` | 3.7:1 | 3.6:1 | AA (for UI / non-body text) |
| `accent` on `bg-page` | 11.2:1 | 15.9:1 | AAA |
| `accent-blue-text` on `accent-blue-soft` | 8.1:1 | 8.4:1 | AAA / AA |
| `accent-green-text` on `accent-green-soft` | 7.9:1 | 7.9:1 | AAA / AA |
| `accent-orange-text` on `accent-orange-soft` | 7.1:1 | 7.2:1 | AAA / AA |
| `error` on `bg-page` | 6.0:1 | 5.7:1 | AAA / AA |

**Test tools**:
- WebAIM Contrast Checker: https://webaim.org/resources/contrastchecker/
- Chrome DevTools Lighthouse
- Accessible Colors: https://accessible-colors.com/

---

## CSS implementation

Tokens are emitted from a single `@theme` block. Mode is class-based on `<html>` (`class="light"` / `class="dark"`); a three-way toggle (system / light / dark) persists choice to `localStorage`. An inline script in `index.html` sets the class before paint to prevent flash of unstyled theme.

```css
/* ── Light mode (default) ── */
:root,
:root.light {
  /* Surfaces */
  --bg-page:        #FAF6EC;
  --bg-sidebar:     #F5EFDD;
  --bg-card:        #FFFBF1;
  --bg-input:       #FAF6EC;
  --bg-key:         #F0E9D4;
  --bg-send:        #2D241B;
  --color-surface:  #FFFDF7;
  --color-surface-2:#F5EBD8;
  --color-bg-elevated:#FFFDF7;

  /* Borders */
  --border-soft:        #E7DCBF;
  --border-card:        #D9CFA9;
  --color-border-subtle:#E7DCBF;
  --color-border:       #D9CFA9;
  --color-border-strong:#B8A47E;

  /* Text */
  --color-text:           #1A1714;
  --color-text-2:         #4B3E32;
  --color-text-muted:     #6E604F;
  --color-text-subtle:    #8E7E68;
  --color-text-on-accent: #FFFDF7;
  --fg-primary:           #1F1A14;
  --fg-secondary:         #4B3E32;
  --fg-muted:             #6E604F;

  /* Accent (UI) */
  --color-accent:  #3F3429;
  --color-overlay: #1A171466;

  /* Agent chips */
  --accent-blue:   #5AA8E2;  --accent-blue-soft:   #DCEEFB;  --accent-blue-text:   #174A73;
  --accent-green:  #3DA66A;  --accent-green-soft:  #E2F2E5;  --accent-green-text:  #15573D;
  --accent-orange: #F59E3B;  --accent-orange-soft: #FFF1D8;  --accent-orange-text: #873E05;
  --accent-pink:   #A21D52;  --accent-pink-soft:   #FBE0EB;
  --accent-purple: #5A34D1;  --accent-purple-soft: #E8DEF8;
  --accent-red:    #A71C24;

  /* Markers (charts) */
  --color-marker-blue:   #0284C7;
  --color-marker-mint:   #16A34A;
  --color-marker-orange: #FA8030;
  --color-marker-pink:   #DB2777;
  --color-marker-yellow: #B77900;
  --color-violet:        #7C3AED;
  --color-tint-mint:     #16A34A18;
  --color-tint-orange:   #FA803018;
  --color-tint-violet:   #7C3AED18;

  /* Semantic */
  --color-success: var(--accent-green);
  --color-warning: var(--accent-orange);
  --color-error:   #B91C1C;
  --color-info:    var(--accent-blue);

  /* Syntax */
  --color-syn-comment:  #6E604F;
  --color-syn-keyword:  #7C3AED;
  --color-syn-function: #026F9E;
  --color-syn-variable: #B91C1C;
  --color-syn-string:   #15803D;
  --color-syn-number:   #A16207;
  --color-syn-type:     #B45309;
  --color-syn-operator: #4B3E32;

  /* Focus + depth */
  --focus-ring:    var(--color-accent);
  --shadow-depth:  0 1px 2px rgba(0,0,0,0.04), 0 2px 8px rgba(0,0,0,0.05);
}

/* ── Dark mode ── */
:root.dark {
  --bg-page:        #15110D;
  --bg-sidebar:     #1C1813;
  --bg-card:        #1C1813;
  --bg-input:       #1C1813;
  --bg-key:         #2A2219;
  --bg-send:        #F5EBD8;
  --color-surface:  #221C16;
  --color-surface-2:#2A2219;
  --color-bg-elevated:#1C1813;

  --border-soft:        #2C231A;
  --border-card:        #3A2F23;
  --color-border-subtle:#2C231A;
  --color-border:       #3A2F23;
  --color-border-strong:#5C4B36;

  --color-text:           #F5EBD8;
  --color-text-2:         #C5B59A;
  --color-text-muted:     #9C8A72;
  --color-text-subtle:    #7A6B58;
  --color-text-on-accent: #15110D;
  --fg-primary:           #F5EBD8;
  --fg-secondary:         #C5B59A;
  --fg-muted:             #9C8A72;

  --color-accent:  #F5EBD8;
  --color-overlay: #00000099;

  --accent-blue:   #7CC2F0;  --accent-blue-soft:   #1E3A52;  --accent-blue-text:   #9DD0F5;
  --accent-green:  #5DC487;  --accent-green-soft:  #1F3A2A;  --accent-green-text:  #92E0B0;
  --accent-orange: #FDB75D;  --accent-orange-soft: #3D2D14;  --accent-orange-text: #FCC780;
  --accent-pink:   #F472B6;  --accent-pink-soft:   #3D1F2D;
  --accent-purple: #A78BFA;  --accent-purple-soft: #2D2440;
  --accent-red:    #F87171;

  --color-marker-blue:   #38BDF8;
  --color-marker-mint:   #4ADE80;
  --color-marker-orange: #FCC352;
  --color-marker-pink:   #F472B6;
  --color-marker-yellow: #FBBF24;
  --color-violet:        #A78BFA;
  --color-tint-mint:     #4ADE8026;
  --color-tint-orange:   #FCC35226;
  --color-tint-violet:   #A78BFA26;

  --color-success: var(--accent-green);
  --color-warning: var(--accent-orange);
  --color-error:   #F87171;
  --color-info:    var(--accent-blue);

  --color-syn-comment:  #9C8A72;
  --color-syn-keyword:  #A78BFA;
  --color-syn-function: #38BDF8;
  --color-syn-variable: #F87171;
  --color-syn-string:   #4ADE80;
  --color-syn-number:   #FBBF24;
  --color-syn-type:     #FCC780;
  --color-syn-operator: #C5B59A;

  --focus-ring:    var(--color-accent);
  --shadow-depth:  0 1px 2px rgba(0,0,0,0.3), 0 2px 8px rgba(0,0,0,0.25);
}
```

---

## Using colors in code

Tokens are exposed as Tailwind utilities via `@theme`. Always reach for a semantic token name, never a raw hex value.

- Page surfaces use `--bg-page` and `--color-text`. The page never uses `--bg-card` directly — that token is for elevated surfaces inside the page.
- The primary CTA is the *paper-inverted* recipe: `--bg-send` fill with `--color-text-on-accent` text. This is the only place the paper aesthetic flips contrast.
- Agent chips compose three tokens at once: `--accent-{role}-soft` (fill), `--accent-{role}` (edge dot), `--accent-{role}-text` (label). Never compose them with anything else.
- Destructive controls use `--color-error` text on a soft `--color-error-subtle` (or `--accent-red` at low alpha) wash; the rest of the chrome stays neutral.
- State badges (queued, in-progress, info) reuse the chip soft/edge/text triad of the matching role color, but pair the color with an icon or label so the meaning never lives in pigment alone.

When writing custom CSS or component styles, reference the token via `var(--token)` rather than redeclaring the value. The token map is the single source of truth; component CSS that hard-codes hex is a bug.

---

## Migration notes

| Previous | Current | Reason |
|---|---|---|
| Cool zinc neutrals (`#0A0A0B`, `#FAFAFA`) | Warm paper neutrals (`#FAF6EC`, `#15110D`) | Matches the pencil "notebook" aesthetic. Reads as a calm working surface, not a terminal. |
| Octobot brand pigment used as UI accent | Octobot pigment reserved for brand assets only | UI accent is now a neutral warm dark; brand pigment stays in mascot/lockup territory. |
| Single neutral accent for all primary actions | Neutral accent **plus** four agent chips for role identity | Multi-agent product needs a way to identify which role is talking; chips solve it without polluting the chrome. |
| `--color-jb-*` token naming | `--bg-*`, `--color-*`, `--accent-*`, `--fg-*` named by role | Names describe function (background, text, accent), not project era. |
| Dark-first defaults | Light-first defaults (paper is the canonical surface) | The product is composed against `#FAF6EC`; dark is a 1:1 themed counterpart. |

The web app's existing `--color-jb-*` tokens are tracked for migration in a separate task. This styling-spec rewrite is intentionally doc-only.
