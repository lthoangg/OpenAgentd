---
title: Imagery & Graphics
description: Icons from lucide, charts with Recharts, data visualization, patterns, and screenshots
status: stable
updated: 2026-04-21
---

# Imagery & Graphics

## Iconography

## Mascot and brand imagery

OpenAgentd uses the octobot mascot from `documents/assets/brand/octobot-agentd-source.png` as the single source of truth. Do not redraw, simplify, or replace the mascot with a generic robot/octopus. Source-faithful lockups live in `documents/assets/brand/`; app-imported copies live in `web/src/assets/brand/`.

Use the full-color mascot for:

- README and social headers
- Empty states and onboarding moments
- App icon and avatar-style surfaces
- Launch or release graphics

Avoid using the mascot as decoration in dense product chrome. In the app UI, small repeated logo positions should use `openagentd-app-icon.png`; larger quiet empty states can use `octobot-agentd-source.png` at low opacity.

### Library: lucide-react

Single icon library, no mixing. `lucide-react` ships with the web stack and provides consistent 24px-native outlined icons with 1.5–2px strokes.

```tsx
import { Play, AlertCircle, CheckCircle } from 'lucide-react';
```

### Sizing

| Size | Use case |
|------|----------|
| **16px** | Status indicators, inline icons, table cells, small metadata |
| **20px** | Dense lists, secondary buttons |
| **24px** | Default UI icons, nav, primary buttons |
| **32px** | Feature tiles, section headers |
| **48px** | Empty-state illustrations, hero moments |

### Color

| Context | Color |
|---------|-------|
| Default | `currentColor` (inherits from text) |
| Interactive hover | `var(--color-accent)` |
| Status — success | `var(--color-success)` |
| Status — warning | `var(--color-warning)` |
| Status — error | `var(--color-error)` |
| Status — info | `var(--color-info)` |
| Disabled | `var(--color-text-subtle)` |

### Rules

- **Outlined only** — never mix outlined and filled icons in the same view
- **Stroke width**: default (stock lucide). Don't override unless the icon looks visually too thin at a specific size.
- **Icon + label pairing**: when an icon accompanies text, don't duplicate meaning (`<Delete />` + "Delete" is fine; `<Info />` + "Info" is redundant — use a visible text label or an icon-only button with `aria-label`)
- **Icon-only buttons**: require `aria-label` or a tooltip for accessibility

### Example

```tsx
// Default, inherits text color
<Play className="w-6 h-6" />

// Interactive — shifts to accent on hover
<Play className="w-6 h-6 text-text hover:text-accent transition-colors" />

// Status
<CheckCircle className="w-6 h-6 text-success" aria-label="Running" />
<AlertCircle className="w-6 h-6 text-error" aria-label="Error" />
```

---

## Patterns & textures

### No decorative patterns

Backgrounds are **solid** or use a single allowed gradient. No grid overlays, no dot patterns, no noise textures, no parallax layers.

| Context | Treatment |
|---------|-----------|
| Page background | `var(--color-bg)` solid |
| Panel / surface | `var(--color-surface)` solid |
| Elevated card | `var(--color-surface-2)` solid + `var(--shadow-depth)` (light mode only) |
| Accent tint | `var(--color-accent-dim)` or `var(--color-accent-subtle)` — for section differentiation, never as decoration |
| Hero / landing only | `var(--gradient-accent)` — one surface per page |

### Dividers & borders

- **Default divider**: 1px solid `var(--color-border)`
- **Strong divider**: 1px solid `var(--color-border-strong)` — for major section breaks
- **Never**: gradient borders, dashed borders for decoration (dashed is reserved for *drag-target* affordances)

### Drag-target highlight

```css
.drag-target {
  outline: 2px dashed color-mix(in srgb, var(--color-accent) 55%, transparent);
  outline-offset: 2px;
  background: var(--color-accent-dim);
}
```

---

## Data visualization

### Tools

- **Primary**: Recharts (already in the web stack)
- **Secondary**: Chart.js for advanced visualizations that Recharts can't handle well
- **Not used**: custom hand-rolled SVG charts without accessibility review

### Color palette

Use chart colors from [colors.md](./colors.md#chart-colors-data-visualization). Series 1 is always the most prominent data, series 5 the least.

```ts
// Dark mode
const chartColors = {
  1: '#93C5FD', // blue
  2: '#86EFAC', // green
  3: '#FCD34D', // amber
  4: '#C4B5FD', // violet
  5: '#F9A8D4', // pink
};
```

**Never** use the brand gold/orange as a chart color unless the data explicitly represents OpenAgentd itself. Brand pigment is identity-reserved.

### Design rules

- **Minimize non-data ink** — remove gridlines where possible, lighten axis labels to `text-muted`
- **No rainbow palettes** — stick to 3–5 series max; if you need more, stack or facet the chart
- **No pie charts** — bar or donut charts communicate proportion more accurately
- **Always provide a legend** for multi-series charts
- **Accessibility**: never rely on color alone. Pair series with patterns, symbols, or direct labels.
- **Responsive**: scale axis labels down at `< 640px`; hide secondary axes on mobile

### Example (Recharts area chart)

```tsx
<AreaChart data={data}>
  <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
  <XAxis dataKey="time" stroke="var(--color-text-muted)" fontSize={12} />
  <YAxis stroke="var(--color-text-muted)" fontSize={12} />
  <Tooltip
    contentStyle={{
      background: 'var(--color-surface)',
      border: '1px solid var(--color-border)',
      borderRadius: 8,
    }}
  />
  <Area
    type="monotone"
    dataKey="requests"
    stroke="var(--chart-1)"
    fill="var(--chart-1)"
    fillOpacity={0.2}
  />
</AreaChart>
```

---

## Markdown & prose

The app uses a custom `.prose` class (previously `.jb-prose`) for rendered markdown.

| Element | Style |
|---------|-------|
| `h1`–`h3` | `text` color, 600–700 weight, large top margin |
| Body | `text` color, 1.6 line-height, `max-width: 65ch` |
| `code` (inline) | `text` color, `surface-2` background, 4px radius, mono font, 0.9em |
| `pre code` (block) | `surface` background, `border`, scrollable overflow, mono font, syntax highlighted |
| Links | `text` color with underline; underline thickens on hover |
| Lists | 1.5em padding, disc (ul) / decimal (ol) |
| Blockquote | Left border 3px `border-strong`, `text-2` color, 1em padding |
| Tables | 1px borders, `surface-2` header background |
| `hr` | 1px `border` |

---

## Empty states

### Structure

1. Icon — 48px, `text-muted` color
2. Title — Heading 3, `text`
3. Description — Body, `text-muted`, `max-width: 40ch`
4. Primary CTA — uses the accent

```tsx
<div className="flex flex-col items-center justify-center py-12">
  <Inbox className="w-12 h-12 text-text-muted mb-4" aria-hidden="true" />
  <h2 className="text-h3 font-semibold text-text mb-2">
    No sessions yet
  </h2>
  <p className="text-text-muted text-center mb-6 max-w-[40ch]">
    Create a session to start working with agents.
  </p>
  <button className="bg-accent text-bg px-4 py-2 rounded hover:bg-accent-hover">
    Create session
  </button>
</div>
```

### Skeleton placeholders

For content that will load within a few hundred milliseconds:

- Background: `var(--color-surface-2)`
- Pulse animation: opacity `0.6 ↔ 1.0` over 1400ms (honors `prefers-reduced-motion`)
- Shape: match the final content's dimensions to prevent layout shift

```css
@keyframes skeleton-pulse {
  0%, 100% { opacity: 1; }
  50%      { opacity: 0.6; }
}

.skeleton {
  background: var(--color-surface-2);
  border-radius: 4px;
  animation: skeleton-pulse 1400ms ease-in-out infinite;
}
```

Skeletons longer than ~800ms should be replaced with progressive text (see [motion.md](./motion.md#principles)).

---

## Screenshots

### Mode choice

| Context | Mode |
|---------|------|
| Product marketing (hero, landing, social cards) | **Dark** |
| Documentation | **Light** |
| API reference screenshots | **Light** |
| README | **Dark** |
| Blog posts | Match the blog's theme (usually light for long-form reading) |
| Conference slides | **Dark** |

### Composition

- **Crop tight** — screenshots should show the feature, not the browser chrome (unless the chrome is part of the point)
- **Consistent chrome** — if multiple screenshots appear together, use the same window style across all of them
- **Real data** — never use "Lorem ipsum" placeholder text in screenshots. Use plausible session names, real file paths, believable agent output.
- **No annotations inside the screenshot** — if you need arrows or labels, add them as a layer *on top* of the screenshot at export time, not inside the UI

### Export

- **1× and 2×** PNG for web
- **SVG** when the screenshot is actually a vector mockup (rare)
- **Full-bleed** or framed with 24px padding on a `--color-bg` background — pick one convention per surface and stick to it
