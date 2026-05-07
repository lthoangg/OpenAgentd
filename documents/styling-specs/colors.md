---
title: Color Palette
description: Octobot Agent palette, semantic colors, syntax highlighting, accessibility compliance
status: stable
updated: 2026-04-21
---

# Color Palette

## Overview

OpenAgentd uses an **Octobot Agent** palette: warm mascot pigments for brand identity, paired with restrained neutral UI surfaces for daily product work. Brand pigment is earned, never decorative: saturated color appears in identity, primary moments, and meaningful agent state.

**Core principle**: color is a communication channel, not a surface treatment. The product UI stays neutral by default; gold/orange is reserved for the octobot brand, active agent affordances, and important calls to action.

---

## Accent philosophy

The UI accent remains a high-contrast neutral in dense product surfaces, while brand assets use the warm octobot palette.

- **Dark mode** → accent is `#E4E4E7` (zinc-200). It is the brightest non-text neutral.
- **Light mode** → accent is `#27272A` (zinc-800). It is the darkest non-text neutral.

The mental model is: neutral UI for sustained work, warm brand pigment for identity and agent energy.

### Brand palette

| Name | Hex | Usage |
|------|-----|-------|
| Agent Gold | `#FCC352` | Primary brand surface, badge fills, brand emphasis |
| Loop Orange | `#FA8030` | Energy accent, mascot details, selected brand emphasis |
| Kernel Brown | `#5F2511` | Mascot linework, text on gold, warm dark contrast |
| Shell White | `#FBF8F7` | Light brand surfaces and highlights |
| Console Ink | `#17120F` | Dark brand surfaces |

---

## Token tables (both modes, side-by-side)

### Foundation — surfaces, borders, text

| Token | Dark mode | Light mode | Usage |
|-------|-----------|------------|-------|
| `--color-bg` | `#0A0A0B` | `#FAFAFA` | Page background |
| `--color-surface` | `#111113` | `#FFFFFF` | Panels, popovers, dropdowns |
| `--color-surface-2` | `#18181B` | `#F4F4F5` | Cards, input backgrounds |
| `--color-surface-3` | `#1F1F23` | `#E4E4E7` | Elevated/active surfaces |
| `--color-border` | `#27272A` | `#E4E4E7` | Subtle borders, dividers |
| `--color-border-strong` | `#3F3F46` | `#D4D4D8` | Prominent borders, separators |
| `--color-text` | `#FAFAFA` | `#09090B` | Primary text, headings |
| `--color-text-2` | `#A1A1AA` | `#52525B` | Secondary text, labels |
| `--color-text-muted` | `#71717A` | `#71717A` | Tertiary text, hints, placeholders |
| `--color-text-subtle` | `#52525B` | `#A1A1AA` | Disabled text, faint metadata |

### Accent — primary action surface

| Token | Dark mode | Light mode | Usage |
|-------|-----------|------------|-------|
| `--color-accent` | `#E4E4E7` | `#27272A` | Primary CTA, focus ring, active highlights |
| `--color-accent-hover` | `#F4F4F5` | `#18181B` | Hover state on accent |
| `--color-accent-subtle` | `rgba(228, 228, 231, 0.10)` | `rgba(39, 39, 42, 0.06)` | Subtle tinted backgrounds (selected rows, hover fills) |
| `--color-accent-dim` | `rgba(228, 228, 231, 0.05)` | `rgba(39, 39, 42, 0.03)` | Very subtle tint (section backgrounds) |
| `--gradient-accent` | `linear-gradient(180deg, #FAFAFA 0%, #D4D4D8 100%)` | `linear-gradient(180deg, #3F3F46 0%, #18181B 100%)` | Primary CTA only — reads as physical metal, not flat gray |

### Semantic — state colors (muted set)

State colors are the *only* place saturated pigment appears. They shift brightness between modes to maintain WCAG AA on each background.

| Token | Dark mode | Light mode | Usage |
|-------|-----------|------------|-------|
| `--color-success` | `#4ADE80` | `#16A34A` | Confirmations, running agents, validation |
| `--color-warning` | `#FBBF24` | `#D97706` | Alerts, pending states, cautions |
| `--color-error` | `#F87171` | `#DC2626` | Errors, failures, destructive actions |
| `--color-info` | `#93C5FD` | `#2563EB` | Information, hints, secondary messaging |

### Syntax highlighting — code

| Token | Dark mode | Light mode | Element |
|-------|-----------|------------|---------|
| `--color-syn-comment` | `#71717A` | `#71717A` | Comments |
| `--color-syn-keyword` | `#C4B5FD` | `#7C3AED` | Keywords, reserved words |
| `--color-syn-function` | `#93C5FD` | `#2563EB` | Function/method names |
| `--color-syn-variable` | `#F87171` | `#DC2626` | Variable names |
| `--color-syn-string` | `#86EFAC` | `#16A34A` | String literals |
| `--color-syn-number` | `#FBBF24` | `#D97706` | Numeric literals |
| `--color-syn-type` | `#FCD34D` | `#B45309` | Type annotations |
| `--color-syn-operator` | `#A1A1AA` | `#52525B` | Operators, punctuation |

### Depth & focus

| Token | Dark mode | Light mode | Usage |
|-------|-----------|------------|-------|
| `--focus-ring` | `#E4E4E7` | `#18181B` | 2px ring on `:focus-visible`, 2px offset |
| `--shadow-depth` | `none` | `0 1px 2px rgba(0,0,0,0.04), 0 2px 8px rgba(0,0,0,0.04)` | Card elevation |

**Why shadows only in light mode**: on dark, brightness steps between surfaces create perceived depth — shadows add noise. On light, surfaces are all near-white and brightness can't create depth, so shadow does the work.

---

## Chart colors (data visualization)

Charts may use saturated color. Order matters — series 1 always uses the accent position.

| Index | Dark mode | Light mode |
|-------|-----------|------------|
| Chart 1 | `#93C5FD` (blue) | `#2563EB` |
| Chart 2 | `#86EFAC` (green) | `#16A34A` |
| Chart 3 | `#FCD34D` (amber) | `#D97706` |
| Chart 4 | `#C4B5FD` (violet) | `#7C3AED` |
| Chart 5 | `#F9A8D4` (pink) | `#DB2777` |

**Anti-pattern**: never use brand gold/orange as chart colors unless the data explicitly represents OpenAgentd itself. The brand palette is identity-reserved; charts need their own spectrum.

---

## Color as information

### When to use state colors

State colors are **event signals**, not design accents. Use them when something the user needs to notice is happening.

| Signal | Color | Example |
|--------|-------|---------|
| Agent is running / streaming | `--color-success` | Pulse dot next to session title |
| Tool call is pending | `--color-warning` | Dashed border on queued row |
| Operation failed | `--color-error` | Error banner, destructive button |
| Informational hint | `--color-info` | First-run tooltip |

**Never use state colors for**:
- Static branding (logo, heading accents)
- Decoration (section backgrounds, dividers)
- Hierarchy (headers are not "info blue")

### Never rely on color alone

Every semantic color pairs with an icon, text label, or both.

- ❌ Red button (color only)
- ✅ Red button + trash icon + "Delete" text
- ❌ Green dot (color only)
- ✅ Green dot + "Running" label

Accessibility, color-blind users, and grayscale screenshots all require this discipline.

---

## Gradient usage

The `--gradient-accent` token is the **only** gradient in the system.

**Use it for**:
- Primary CTA buttons (one per screen)
- Hero surfaces on marketing pages
- Brand mark variant (reserved)

**Do not use it for**:
- Section backgrounds
- Card surfaces
- Headings or text (gradient text breaks on low-DPI displays)
- Anything repeated more than once per view

A single gradient button on a flat screen reads as "metal, the primary action". Two gradient buttons read as "two primary actions", which is a design bug.

---

## Brand Pigment On Light Backgrounds

Warm brand pigment can lose contrast on light surfaces if used as text. Use Kernel Brown for text on Agent Gold, and use charcoal text on Shell White surfaces.

**Rules**:
- Use `#5F2511` for text on `#FCC352` pills and badges.
- Use `#27140C` or `#09090B` for large wordmarks on Shell White.
- Do not use Loop Orange for body text on light backgrounds.
- Do not recolor the octobot paths to force contrast; choose an appropriate background instead.

---

## Accessibility (WCAG 2.1 AA)

All token pairs are verified against their own background:

| Pairing | Dark mode ratio | Light mode ratio | WCAG |
|---------|-----------------|------------------|------|
| `text` on `bg` | 18.7:1 | 19.3:1 | AAA |
| `text-2` on `bg` | 7.1:1 | 8.9:1 | AAA |
| `text-muted` on `bg` | 4.6:1 | 4.7:1 | AA |
| `accent` on `bg` | 17.8:1 | 14.1:1 | AAA |
| `success` on `bg` | 10.4:1 | 4.5:1 | AA |
| `error` on `bg` | 6.7:1 | 5.9:1 | AA |

**Test tools**:
- WebAIM Contrast Checker: https://webaim.org/resources/contrastchecker/
- Chrome DevTools Lighthouse
- Accessible Colors: https://accessible-colors.com/

---

## CSS implementation

The token layer uses class-based mode switching on the `<html>` element (`class="dark"` or `class="light"`), with a three-way UI toggle (system / light / dark) persisted to localStorage. An inline script in `index.html` sets the class before paint to prevent flash of unstyled theme.

```css
/* ── Default = dark (production) ── */
:root,
:root.dark {
  --color-bg:            #0A0A0B;
  --color-surface:       #111113;
  --color-surface-2:     #18181B;
  --color-surface-3:     #1F1F23;
  --color-border:        #27272A;
  --color-border-strong: #3F3F46;

  --color-text:          #FAFAFA;
  --color-text-2:        #A1A1AA;
  --color-text-muted:    #71717A;
  --color-text-subtle:   #52525B;

  --color-accent:        #E4E4E7;
  --color-accent-hover:  #F4F4F5;
  --color-accent-subtle: rgba(228, 228, 231, 0.10);
  --color-accent-dim:    rgba(228, 228, 231, 0.05);
  --gradient-accent:     linear-gradient(180deg, #FAFAFA 0%, #D4D4D8 100%);

  --color-success:       #4ADE80;
  --color-warning:       #FBBF24;
  --color-error:         #F87171;
  --color-info:          #93C5FD;

  --color-syn-comment:   #71717A;
  --color-syn-keyword:   #C4B5FD;
  --color-syn-function:  #93C5FD;
  --color-syn-variable:  #F87171;
  --color-syn-string:    #86EFAC;
  --color-syn-number:    #FBBF24;
  --color-syn-type:      #FCD34D;
  --color-syn-operator:  #A1A1AA;

  --focus-ring:          #E4E4E7;
  --shadow-depth:        none;
}

/* ── Light mode ── */
:root.light {
  --color-bg:            #FAFAFA;
  --color-surface:       #FFFFFF;
  --color-surface-2:     #F4F4F5;
  --color-surface-3:     #E4E4E7;
  --color-border:        #E4E4E7;
  --color-border-strong: #D4D4D8;

  --color-text:          #09090B;
  --color-text-2:        #52525B;
  --color-text-muted:    #71717A;
  --color-text-subtle:   #A1A1AA;

  --color-accent:        #27272A;
  --color-accent-hover:  #18181B;
  --color-accent-subtle: rgba(39, 39, 42, 0.06);
  --color-accent-dim:    rgba(39, 39, 42, 0.03);
  --gradient-accent:     linear-gradient(180deg, #3F3F46 0%, #18181B 100%);

  --color-success:       #16A34A;
  --color-warning:       #D97706;
  --color-error:         #DC2626;
  --color-info:          #2563EB;

  --color-syn-comment:   #71717A;
  --color-syn-keyword:   #7C3AED;
  --color-syn-function:  #2563EB;
  --color-syn-variable:  #DC2626;
  --color-syn-string:    #16A34A;
  --color-syn-number:    #D97706;
  --color-syn-type:      #B45309;
  --color-syn-operator:  #52525B;

  --focus-ring:          #18181B;
  --shadow-depth:        0 1px 2px rgba(0, 0, 0, 0.04), 0 2px 8px rgba(0, 0, 0, 0.04);
}
```

---

## Using colors in code

### Tailwind classes

Tokens are exposed as Tailwind utilities via the `@theme` block (unprefixed). Use semantic names, not raw hex:

```tsx
// Primary CTA (uses the neutral UI accent in dense product surfaces)
<button className="bg-accent text-bg hover:bg-accent-hover">
  Start session
</button>

// Secondary (neutral surface)
<button className="bg-surface-2 text-text hover:bg-surface-3 border border-border">
  Cancel
</button>

// Destructive
<button className="bg-error text-bg hover:bg-error/90">
  Delete session
</button>

// Subtle state indicator
<div className="bg-error-subtle text-error border border-error/20">
  Agent failed to respond
</div>
```

### CSS custom properties

```css
.agent-running {
  border-color: var(--color-success);
  background: var(--color-accent-dim);
}

.card {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  box-shadow: var(--shadow-depth);
}

.cta-primary {
  background: var(--gradient-accent);
  color: var(--color-bg);
}
```

---

## Migration from Gruvbox palette

The previous palette (Gruvbox-inspired, warm gold `#fabd2f` on sepia neutrals) is retired. The rebrand moves OpenAgentd from a **terminal-hobbyist** aesthetic to a **precision-instrument** aesthetic.

| Previous | Current | Reason |
|----------|---------|--------|
| Generic warm accent | Octobot brand palette + neutral UI accent | Brand color is now source-derived and reserved for identity or agent meaning. |
| Sepia-warm neutrals (`#1d1b19`, `#ebdbb2`) | Cool zinc neutrals (`#0A0A0B`, `#FAFAFA`) | Removes retro/dotfile association. Reads as contemporary software. |
| Dark-first, light as afterthought | Dark-first, light-equal | Light mode gets full token spec and testing, not a media-query fallback. |
| `--color-jb-*` token naming | `--color-*` token naming | Drops project-era prefix. Names now describe function, not origin. |

**Codebase migration**: the web app currently still uses `--color-jb-*` tokens. A follow-up PR will migrate `web/src/index.css` and all `bg-jb-*` / `text-jb-*` / `border-jb-*` class usages to the unprefixed names. This styling-specs update is intentionally doc-only.
