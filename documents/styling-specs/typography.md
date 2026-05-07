---
title: Typography
description: Geist Variable and JetBrains Mono, type hierarchy, font-weight transitions on interaction
status: stable
updated: 2026-04-21
---

# Typography

## Primary typeface: Geist Variable

- **Usage**: All text — headings, body copy, UI labels, marketing
- **Weight range**: 400 (Regular) through 700 (Bold) — variable axis
- **Source**: `@fontsource-variable/geist` (open source, Vercel)
- **Character**: Modern, geometric sans-serif. Sharp counters, tight tracking. Reads as precision software.
- **System fallback**: `-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`

### Font stack (copy/paste)

```css
font-family: 'Geist Variable', -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
```

## Secondary typeface: JetBrains Mono

- **Usage**: Code blocks, terminal output, file paths, configuration values, any monospace text
- **Weights**: 400 (Regular), 500 (Medium), 600 (SemiBold)
- **Character**: Humanist monospace designed for code. Distinguishes `0O`, `1lI`, `{}()` clearly.
- **Fallback**: `ui-monospace, "SF Mono", "Courier New", monospace`

### Code font stack (copy/paste)

```css
font-family: 'JetBrains Mono', ui-monospace, "SF Mono", "Courier New", monospace;
```

---

## Type hierarchy

| Level | Size | Weight | Line height | Letter spacing | Usage |
|-------|------|--------|-------------|----------------|-------|
| **Display** | 32px | 700 | 1.25 | -0.5px | Hero titles, main page headers |
| **Heading 1** | 28px | 700 | 1.30 | -0.3px | Page titles, section headers |
| **Heading 2** | 24px | 600 | 1.35 | -0.2px | Subsection headers |
| **Heading 3** | 20px | 600 | 1.40 | 0 | Component titles, subheadings |
| **Body** | 16px | 400 | 1.50 | 0 | Main content, UI text, paragraphs |
| **Small** | 14px | 400 | 1.50 | 0.1px | Secondary info, labels, captions |
| **Tiny** | 12px | 400 | 1.50 | 0.2px | Metadata, timestamps, footnotes |

**Line-height rule**: tighter for display, looser for body. Never go below 1.4 for body text.

---

## Font-weight transitions (signature interaction)

Weight shifts on hover and active states are a signature of the OpenAgentd interaction language. Text feels *alive* under the cursor without changing color or position.

### The rule

| State | Body/label | Interactive (button, link, nav item) |
|-------|-----------|--------------------------------------|
| Idle | 400 | 400 |
| Hover | 400 | 500 |
| Active / pressed | 400 | 600 |
| Selected / current | 500 | 500 |

### CSS implementation

Geist is a variable font, so weight transitions are smooth rather than stepped. Use `font-variation-settings` for sub-weight precision, or `font-weight` with a transition if you don't need in-between values.

```css
/* Smooth weight shift on interactive elements */
.interactive {
  font-weight: 400;
  transition: font-weight 200ms cubic-bezier(0.4, 0, 0.2, 1);
}

.interactive:hover {
  font-weight: 500;
}

.interactive:active {
  font-weight: 600;
}

/* Or with variation settings for finer control */
.interactive {
  font-variation-settings: 'wght' 400;
  transition: font-variation-settings 200ms cubic-bezier(0.4, 0, 0.2, 1);
}

.interactive:hover {
  font-variation-settings: 'wght' 500;
}
```

### Anti-patterns

- ❌ **Weight shift on idle/static text** — only interactive elements shift
- ❌ **Weight shift without transition** — produces a layout jump, feels broken
- ❌ **Shift beyond 600** — 700 Bold is reserved for permanent headings, not hover states
- ❌ **Different shift amounts within a group** — a nav where some items go 400→500 and others go 400→600 reads as inconsistent

### When NOT to use weight transitions

- Body paragraph links — too much motion in a reading flow
- Table rows with many cells — shifts the whole row, causes reflow
- Icon-only buttons — there's no text weight to shift

See [interaction.md](./interaction.md) for the full hover/focus/active state model.

---

## Implementation tokens

The web app exposes typography through the `@theme` inline block in `src/index.css`:

```css
@theme inline {
  /* Families */
  --font-sans:    'Geist Variable', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  --font-mono:    'JetBrains Mono', ui-monospace, 'SF Mono', 'Courier New', monospace;
  --font-heading: var(--font-sans);

  /* Sizes */
  --text-display: 32px;
  --text-h1:      28px;
  --text-h2:      24px;
  --text-h3:      20px;
  --text-body:    16px;
  --text-sm:      14px;
  --text-xs:      12px;

  /* Weights */
  --weight-regular:  400;
  --weight-medium:   500;
  --weight-semibold: 600;
  --weight-bold:     700;

  /* Motion — shared with interaction.md */
  --motion-weight-shift: 200ms cubic-bezier(0.4, 0, 0.2, 1);
}
```

---

## Web implementation notes

- Geist Variable loads from `@fontsource-variable/geist` — single variable font file, no per-weight imports needed
- JetBrains Mono is loaded via a separate CSS import or `@fontsource/jetbrains-mono`
- Code syntax highlighting uses `highlight.js` with the OpenAgentd theme (see [colors.md](./colors.md#syntax-highlighting--code))
- All UI text inherits `font-family: var(--font-sans)` from the root; code elements (`<code>`, `<pre>`, `.font-mono`) opt in to the mono stack
- Font-weight transitions are defined in a `.interactive` utility class or applied directly to `<button>`, `<a>`, and `[role="button"]` elements

---

## Accessibility

- **Minimum body size**: 16px. Never smaller for paragraph text.
- **Minimum small size**: 14px for secondary info; 12px only for non-essential metadata (timestamps, byte counts)
- **Line length**: aim for 60–75 characters per line in reading contexts. Use `max-width: 65ch` on prose containers.
- **Weight + contrast**: thin weights (300 or below) are not used; they fail WCAG on low-DPI screens even when contrast math passes
- **`prefers-reduced-motion`**: font-weight transitions honor reduced-motion (disable the 200ms transition, snap directly to final weight)

```css
@media (prefers-reduced-motion: reduce) {
  .interactive {
    transition: none;
  }
}
```
