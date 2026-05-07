---
title: Layout & Spacing
description: 4px grid system, breakpoints, depth mechanism, focus rings, accessibility
status: stable
updated: 2026-04-29
---

# Layout & Spacing

## Grid system

### Base unit: 4px

All spacing is a multiple of 4px.

| Unit | Pixels |
|------|--------|
| 1 | 4px |
| 2 | 8px |
| 3 | 12px |
| 4 | 16px |
| 6 | 24px |
| 8 | 32px |
| 12 | 48px |
| 16 | 64px |

### Responsive grid: 12 columns

| Breakpoint | Range | Columns | Gutter | Container padding |
|-----------|-------|---------|--------|-------------------|
| Mobile | `< 640px` | 4 | 12px (`gap-3`) | 12px (`px-3`) |
| Tablet | `640–1023px` | 8 | 16px (`gap-4`) | 16px (`px-4`) |
| Desktop | `≥ 1024px` | 12 | 24px (`gap-6`) | 24px (`px-6`) |

### Breakpoints (Tailwind defaults)

| Name | Min width | Use |
|------|-----------|-----|
| (base) | `0px` | Mobile-first (360–430px primary target) |
| `sm` | `640px` | Landscape phones, small tablets |
| `md` | `768px` | **Mobile / desktop boundary** — `useIsMobile()` hook threshold |
| `lg` | `1024px` | Laptops |
| `xl` | `1280px` | Desktop |
| `2xl` | `1536px` | Wide screens |

**`md` is the mobile/desktop split.** `useIsMobile()` returns `true` when `window.innerWidth < 768px`. For JS-driven layout branches always use this hook rather than raw CSS breakpoints. CSS `md:` utilities are fine for purely visual changes; use the hook when the branch affects behaviour (panel mode, shortcut availability, etc.).

**Avoid `lg:` or larger inside panels and drawers.** A panel's own width is narrower than the viewport, so `lg:` (1024px viewport) will never fire when the panel is open on a mobile screen. Use `isMobile` branches instead — see [`docs/web/mobile.md`](../docs/web/mobile.md).

---

## Spacing scale (component level)

| Token | Pixels | Tailwind | Use |
|-------|--------|----------|-----|
| `xs` | 4px | `p-1` | Tight internal padding |
| `sm` | 8px | `p-2` | Small components, badges |
| `md` | 12px | `p-3` | Standard components |
| `lg` | 16px | `p-4` | Cards, panels |
| `xl` | 24px | `p-6` | Sections |
| `2xl` | 32px | `p-8` | Major section dividers |
| `3xl` | 48px | `p-12` | Page-level spacing |
| `4xl` | 64px | `p-16` | Hero spacing |

### Spacing application

```tsx
// Button — small component
<button className="px-3 py-2">Label</button>

// Card — medium component
<div className="p-4">…</div>

// Section — large component
<section className="p-6">…</section>

// Flex gap between siblings
<div className="flex gap-3">{items}</div>

// Grid gap
<div className="grid grid-cols-3 gap-4">{cards}</div>

// Vertical rhythm
<div className="space-y-4">{paragraphs}</div>
```

---

## Depth mechanism

Perceived depth works differently in each mode because the foundational colors are different.

| Mode | Mechanism | Reason |
|------|-----------|--------|
| **Dark** | Brightness steps between `bg` → `surface` → `surface-2` → `surface-3` | Shadows are invisible on near-black. Brightness creates the layer hierarchy. |
| **Light** | `box-shadow` via `var(--shadow-depth)` | Surfaces are all near-white, so brightness can't differentiate layers. Shadow does the work. |

```css
.card {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  /* Active only in light mode — empty string in dark */
  box-shadow: var(--shadow-depth);
}
```

### Elevation levels

| Level | Dark mode | Light mode |
|-------|-----------|------------|
| Ground | `bg` | `bg` |
| Raised | `surface` | `surface` + `shadow-depth` |
| Floating | `surface-2` | `surface` + stronger shadow (`0 4px 12px rgba(0,0,0,0.06)`) |
| Glass | `surface-2 / 20%` + `backdrop-blur-xl` + `shadow-xl` | `surface / 60%` + `backdrop-blur-xl` + `shadow-xl` |
| Modal | `surface-2` + backdrop | `surface` + heavy shadow (`0 16px 48px rgba(0,0,0,0.12)`) + backdrop |

**Glass tier** is reserved for overlay surfaces that hover *above live content* — the floating chat composer is the canonical example. Unlike `Floating`, it is deliberately translucent: the backdrop blur is load-bearing, and the surface tint is kept low so the content underneath reads as "behind glass". Use sparingly — one glass surface per view, maximum.

---

## Focus ring

Focus states are the single most important accessibility affordance. Every interactive element shows a ring on `:focus-visible`.

### Specification

- **Width**: 2px
- **Offset**: 2px (outside the element)
- **Color**: `var(--focus-ring)` — `#E4E4E7` on dark, `#18181B` on light
- **Transition**: fade in via `var(--motion-fast)` + `var(--ease-out)`
- **Radius**: matches the element's own `border-radius`

```css
:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 2px;
  transition: outline-color var(--motion-fast) var(--ease-out);
}

/* Hide focus ring on mouse click, keep on keyboard */
:focus:not(:focus-visible) {
  outline: none;
}
```

For the full interaction model, see [interaction.md](./interaction.md). For the motion tokens referenced here, see [motion.md](./motion.md).

---

## Proximity & list density

### When hover is binary

Single buttons, sparse navigation (fewer than 6 items), icons in toolbars — use the normal hover state from [interaction.md](./interaction.md).

### When hover fades with proximity

Dense lists (agent/session lists, command palette results, sidebars with 10+ items) — use a proximity fade so the cursor traveling through doesn't strobe every row. Full spec in [interaction.md](./interaction.md#proximity-effects).

### Row height targets

| List type | Row height | Rationale |
|-----------|-----------|-----------|
| Dense (session list, log rows) | 28–32px | Information density |
| Standard (nav, menus) | 36–40px | Comfortable scanning |
| Comfortable (settings rows, feature tiles) | 48–56px | Touch-friendly, two-line content |

**Touch targets** — if an element will be tapped, it needs at least a 44×44px hit area even if the visual is smaller. Use `padding` to expand the hit area without changing visual size.

---

## Accessibility

### Color contrast (WCAG 2.1 AA)

| Type | Minimum ratio |
|------|---------------|
| Body text | 4.5:1 |
| Large text (18px+ bold, 24px+ regular) | 3:1 |
| Graphics / UI components (borders, focus rings, icons conveying meaning) | 3:1 |

All OpenAgentd tokens are pre-verified — see [colors.md](./colors.md#accessibility-wcag-21-aa).

**Test tools:**
- WebAIM Contrast Checker: https://webaim.org/resources/contrastchecker/
- Chrome DevTools Lighthouse
- Accessible Colors: https://accessible-colors.com/

### Keyboard navigation

- Every interactive element is reachable via `Tab`
- Tab order follows visual reading order (top-to-bottom, left-to-right in LTR locales)
- No keyboard traps — `Esc` always provides an exit
- Arrow keys for grouped controls (tabs, menus, radio groups)
- Full shortcut reference in [interaction.md](./interaction.md#keyboard-model)

### Semantic HTML

Use the right element for the job. ARIA is a fallback, not a substitute.

- **Headings**: proper hierarchy (`h1 → h2 → h3`, no skips)
- **Landmarks**: `<header>`, `<nav>`, `<main>`, `<aside>`, `<footer>`
- **Forms**: label every input with `<label for="…">` or by wrapping
- **Lists**: `<ul>` / `<ol>` / `<li>`, not styled divs
- **Interactive**: `<button>` for actions, `<a href>` for navigation

```tsx
<header>
  <nav aria-label="Primary">
    <a href="/">Home</a>
    <a href="/docs">Docs</a>
  </nav>
</header>

<main>
  <h1>Page title</h1>
  <section aria-labelledby="config-heading">
    <h2 id="config-heading">Configuration</h2>
    <p>…</p>
  </section>
</main>

<footer>…</footer>
```

### Alt text

- **Meaningful images**: descriptive alt (`alt="Agent workflow diagram showing three agents coordinating"`)
- **Decorative images**: `alt=""` to skip in screen readers
- **Icons**: `aria-label` if standalone; empty/omitted if accompanied by readable text

### ARIA

Use only when semantic HTML isn't sufficient.

| Attribute | Purpose | Example |
|-----------|---------|---------|
| `aria-label` | Label elements without visible text | `<button aria-label="Close">×</button>` |
| `aria-describedby` | Associate supplementary description | `<input aria-describedby="help-id" />` |
| `aria-hidden="true"` | Hide decorative elements from AT | `<Icon aria-hidden="true" />` |
| `aria-live="polite"` | Announce dynamic content changes | `<div aria-live="polite">{status}</div>` |
| `role` | Define purpose when HTML doesn't fit | `<div role="tablist">` |

### Motion

Respect `prefers-reduced-motion`:

```css
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
```

Full motion guidance in [motion.md](./motion.md).

---

## Mode switching

Dark is the default; users can pick `system` / `light` / `dark` via a UI toggle.

### Implementation

- Class-based on `<html>`: `class="dark"` or `class="light"`
- Persisted to `localStorage`
- An inline script in `index.html` sets the class before first paint to prevent flash of unstyled theme

```html
<script>
  (function() {
    try {
      var stored = localStorage.getItem('theme'); // 'system' | 'light' | 'dark'
      var mode = stored || 'system';
      var resolved = mode === 'system'
        ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
        : mode;
      document.documentElement.classList.add(resolved);
    } catch (_) {
      document.documentElement.classList.add('dark');
    }
  })();
</script>
```

### Container queries

For components that adapt to their container rather than the viewport:

```css
@container (min-width: 400px) {
  .card { padding: 24px; }
}
```

Use container queries for reusable components (cards, panels) and media queries for page-level layout.

---

## Mobile layout rules

### Viewport height

Always use `h-dvh` instead of `h-screen`. iOS Safari's dynamic toolbar changes the viewport height as the user scrolls, making `h-screen` taller than the visible area.

### Safe-area insets

Apply `.pb-safe` to any element that sits flush at the bottom of the screen (sidebar footer, docked input bar). Defined in `index.css` as plain CSS classes — not Tailwind utilities.

| Class | Property |
|-------|----------|
| `.pb-safe` | `padding-bottom: max(env(safe-area-inset-bottom), 8px)` |
| `.pt-safe` | `padding-top: env(safe-area-inset-top)` |

The 8px minimum in `.pb-safe` prevents footers being flush with the edge on devices without a home indicator.

### Touch globals (`index.css`)

```css
body {
  touch-action: manipulation;          /* disables double-tap zoom */
  -webkit-tap-highlight-color: transparent;
  overscroll-behavior: none;           /* prevents pull-to-refresh on the root */
}
.scroll-region {
  overscroll-behavior: contain;        /* each scroll region contained */
}
```

### Multi-pane panels on mobile

Panels with a side-by-side list + detail layout (MemoryPanel, WorkspaceFilesPanel, SchedulerPanel) switch to **master/detail** on mobile — one pane fills the full width at a time, with an `ArrowLeft` icon button to go back. Desktop layout is unchanged. See [`docs/web/mobile.md`](../docs/web/mobile.md).

---

## Checklist

- [ ] Spacing uses 4px base unit
- [ ] Color contrast meets WCAG 2.1 AA (4.5:1 text)
- [ ] Focus ring visible on `:focus-visible`
- [ ] Tab navigation reaches every interactive element in logical order
- [ ] Semantic HTML (correct headings, landmarks, lists)
- [ ] Alt text for meaningful images; `alt=""` for decorative
- [ ] Responsive tested at 360px, 768px, 1440px
- [ ] `prefers-reduced-motion` honored
- [ ] No keyboard traps (`Esc` always exits modals/menus)
- [ ] Touch targets ≥ 44×44px
- [ ] Depth uses brightness on dark, shadow on light
