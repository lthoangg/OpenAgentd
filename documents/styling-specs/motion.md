---
title: Motion
description: Duration tokens, easing functions, choreography patterns, and prefers-reduced-motion fallbacks
status: stable
updated: 2026-04-21
---

# Motion

> **Motion is information.** Every animation in OpenAgentd conveys state, progress, or causality. If an animation can be removed without the user losing information, remove it.

This page defines the motion language: tokens, spring presets, choreography patterns, and the semantic meaning of each common animation. For the hover/focus/active model that consumes these tokens, see [interaction.md](./interaction.md).

---

## Principles

### 1. Every animation has a meaning

Before adding motion, answer: *what does this motion tell the user?* Valid answers include:

- "The agent is currently generating output" (streaming cursor)
- "A tool was dispatched — expect a result in a moment" (row slide-in)
- "Your message was persisted — reload would show the same state" (fade confirmation)
- "Focus moved here" (focus ring appears)

Invalid answers: *"it looks nice"*, *"to fill time while loading"*, *"to celebrate success"*.

### 2. Motion replaces spinners

A spinner says "something is happening but I can't tell you what". OpenAgentd's product is transparency — the UI should name what's happening instead. Prefer progressive text updates (`Thinking…` → `Reading 4 files…` → `Writing patch…`) over indeterminate loaders. Spinners are a last resort.

### 3. Motion has direction

Every animation has a cause. A panel slides in from the side its trigger lives on. A message appears at the bottom because it arrived chronologically last. A focus ring appears *under* the cursor, not at an unrelated location. Motion without causal direction is decoration.

### 4. Motion respects the user

`prefers-reduced-motion: reduce` is honored system-wide. Every animation has a defined fallback — either instant, or a minimal opacity fade. No animation is so precious it can't degrade gracefully.

---

## Motion tokens

### Durations

| Token | Value | Use for |
|-------|-------|---------|
| `--motion-instant` | 80ms | Color shifts, background fills, very small feedback |
| `--motion-fast` | 150ms | Focus ring fade-in, hover weight shift, tooltip appearance |
| `--motion-base` | 240ms | Panel slides, modal fade, font-weight transitions on larger elements |
| `--motion-slow` | 400ms | Page transitions, multi-step reveals, emphasis moments |
| `--motion-glacial` | 800ms | Reserved for rare "heavy" transitions (e.g. session archive animation). Use sparingly. |

**Rule of thumb**: if the user has to wait for the animation to finish before they can act, it's too slow. Most UI motion should be `fast` or `base`.

### Easings

| Token | Value | Character |
|-------|-------|-----------|
| `--ease-out` | `cubic-bezier(0.16, 1, 0.3, 1)` | Default — quick start, soft landing. Use for most entries. |
| `--ease-in-out` | `cubic-bezier(0.4, 0, 0.2, 1)` | Symmetric — use for state toggles (on/off switches, tab indicators) |
| `--ease-spring-soft` | `cubic-bezier(0.34, 1.2, 0.64, 1)` | Slight overshoot — hover lifts, menu reveals |
| `--ease-spring-snappy` | `cubic-bezier(0.22, 1.4, 0.36, 1)` | Stronger overshoot — press-and-release, drag drops |
| `--ease-linear` | `linear` | Progress bars, streaming cursors — anywhere time is literal |

### Spring presets

Named springs matching the Fluid Functionalism vocabulary. Use these names in UI copy when the user can pick their own motion preference.

| Preset | Config (react-spring / framer-motion) | Feel |
|--------|---------------------------------------|------|
| **Fast spring** | `{ stiffness: 380, damping: 28 }` | Immediate, tight, minimal overshoot |
| **Moderate spring** | `{ stiffness: 220, damping: 26 }` | Balanced — the default |
| **Slow spring** | `{ stiffness: 140, damping: 24 }` | Languid, visible travel, small overshoot |
| **Comfortable** | `{ stiffness: 180, damping: 30 }` | No overshoot, gentle arrival |
| **No animation** | — | Honors `prefers-reduced-motion` or user override |

User motion preference is persisted per-session and defaults to **Moderate spring** in the UI, **No animation** when `prefers-reduced-motion` is set.

### CSS implementation

```css
:root {
  /* Durations */
  --motion-instant: 80ms;
  --motion-fast:    150ms;
  --motion-base:    240ms;
  --motion-slow:    400ms;
  --motion-glacial: 800ms;

  /* Easings */
  --ease-out:            cubic-bezier(0.16, 1, 0.3, 1);
  --ease-in-out:         cubic-bezier(0.4, 0, 0.2, 1);
  --ease-spring-soft:    cubic-bezier(0.34, 1.2, 0.64, 1);
  --ease-spring-snappy:  cubic-bezier(0.22, 1.4, 0.36, 1);
  --ease-linear:         linear;
}

/* Example usage */
.panel {
  transition:
    transform var(--motion-base) var(--ease-out),
    opacity   var(--motion-base) var(--ease-out);
}
```

---

## Choreography patterns

Each pattern below is tied to a specific product meaning. Reusing a pattern for a different meaning breaks the language.

### Streaming cursor (blink)

**Meaning**: the agent is actively generating this token.

**Spec**: 1.0 opacity ↔ 0.0 opacity, 1000ms cycle, `ease-in-out`, infinite until stream ends.

```css
@keyframes streaming-cursor {
  0%, 50%   { opacity: 1; }
  51%, 100% { opacity: 0; }
}

.cursor {
  animation: streaming-cursor 1000ms steps(2, end) infinite;
}
```

**When to remove it**: the moment the stream emits `[DONE]` or a tool call starts. A blinking cursor with no generation happening is a bug.

### Thinking indicator (pulse dots)

**Meaning**: the agent is reasoning but has not yet produced output. Distinct from streaming — there is no text to show yet.

**Spec**: three dots, 0.4 → 1.0 → 0.4 opacity, staggered by 200ms each, 1400ms cycle, `ease-in-out`.

```
●  ○  ○     →     ○  ●  ○     →     ○  ○  ●     →     ●  ○  ○
```

Text label accompanies dots: `Thinking`, `Reading`, `Searching`, etc. — progressive disclosure of what the agent is actually doing.

### Tool-call row slide-in

**Meaning**: a tool was dispatched; its result row just joined the transcript.

**Spec**: slide in from below (`translateY(8px) → 0`), opacity `0 → 1`, duration `var(--motion-base)`, easing `var(--ease-spring-soft)`.

```css
@keyframes tool-row-enter {
  from { transform: translateY(8px); opacity: 0; }
  to   { transform: translateY(0);   opacity: 1; }
}

.tool-row {
  animation: tool-row-enter var(--motion-base) var(--ease-spring-soft);
}
```

### Handoff (team mode)

**Meaning**: a message was routed from one team member to another — visible causality in multi-agent orchestration.

**Spec**: sender row briefly glows (accent-subtle background, 300ms fade-out), recipient row slides in as above. The glow is the *cause*, the slide is the *effect*. Order matters.

### Focus ring appear

**Meaning**: focus moved here. Keyboard navigation landed on this element, or a programmatic focus completed.

**Spec**: 2px ring using `var(--focus-ring)`, `outline-offset: 2px`, opacity `0 → 1` over `var(--motion-fast)`, easing `var(--ease-out)`.

Only appears on `:focus-visible` — never on mouse click. See [interaction.md](./interaction.md) for the full rationale.

### Font-weight shift

**Meaning**: this element is interactive, and you're engaging with it.

**Spec**: weight goes 400 → 500 on hover, 500 → 600 on active. Duration `var(--motion-fast)` for the hover shift, `var(--motion-instant)` for the active shift. Full spec in [typography.md](./typography.md#font-weight-transitions-signature-interaction).

### Done (persistence confirmed)

**Meaning**: the server confirmed the operation was persisted. DB is authoritative; a page reload would show the same state.

**Spec**: subtle opacity pulse on the affected row (0.6 → 1.0, once, `var(--motion-base)`). **No** color flash, **no** checkmark bounce, **no** celebration. The point is to signal reliability, not success-theater.

### Modal / panel entry

**Meaning**: a new surface appeared, demanding attention.

**Spec**:
- Backdrop: opacity `0 → 1`, duration `var(--motion-fast)`, `ease-out`
- Panel: `translateY(-8px) scale(0.98) → translateY(0) scale(1)`, opacity `0 → 1`, duration `var(--motion-base)`, `ease-spring-soft`
- Panel exit: reverse, duration `var(--motion-fast)`

### Sidebar / drawer slide

**Meaning**: navigation surface opened/closed.

**Spec**: `translateX(-100%) → 0` for left drawer, duration `var(--motion-base)`, `ease-out`. Mirrored for right drawer.

### Progress bar

**Meaning**: a known quantity of work is advancing toward a known endpoint.

**Spec**: `width` animated linearly — this is the one place `ease-linear` is correct, because time should be literal. Never animate an indeterminate progress bar with back-and-forth motion; prefer a thinking indicator instead.

---

## `prefers-reduced-motion` fallbacks

Every animation above has a reduced-motion fallback. Global rule:

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

Per-pattern fallbacks:

| Pattern | Reduced-motion fallback |
|---------|-------------------------|
| Streaming cursor | Static `▍` character at full opacity (no blink) |
| Thinking dots | Static `…` text (no pulse) |
| Tool-row slide-in | Snap to final position, opacity flash only |
| Focus ring appear | Snap to visible, no fade |
| Font-weight shift | Snap to final weight, no transition |
| Done pulse | Snap, no pulse |
| Modal entry | Snap to visible, backdrop opacity instant |
| Sidebar slide | Snap to open/closed |
| Progress bar | Still animates — literal progress, not decorative |

---

## Anti-patterns

Things that are **never** acceptable in the OpenAgentd motion system.

| Anti-pattern | Why it's wrong |
|-------------|----------------|
| **Bouncing on errors** | Errors need calm, readable presentation. Bouncing trivializes them. |
| **Parallax scrolling** | Decoration, no information value, breaks on reduced-motion. |
| **Shimmer loading longer than 800ms** | If you know the thing is slow, show actual progress text. Shimmer for 3 seconds is lying about speed. |
| **Hover tilts / 3D transforms** | We're not selling a product mockup — this is software, not a gallery piece. |
| **Success celebrations** (confetti, checkmark bounce, etc.) | Undercuts the "precise instrument" voice. A subtle fade is enough. |
| **Decorative entrance animations on page load** | Wastes time, delays interactivity, users hit it on every page revisit. |
| **Animating multiple properties on many elements simultaneously** | Causes jank. Pick 2 properties (usually opacity + transform) and stick to them. |
| **Motion that can't be interrupted** | If the user clicks during an animation, honor the click. Lock-out is hostile. |
| **Layout-shifting animations** | Animate `transform` and `opacity` (GPU-composited). Never animate `width`, `height`, `top`, `left` in hot paths. |

---

## Performance

- Animate only `transform` and `opacity` for 60fps on mid-range hardware
- Use `will-change` sparingly — overuse defeats its purpose
- Prefer CSS animations over JavaScript for declarative patterns
- Use `framer-motion` or `react-spring` for state-driven animations (drag, gesture, derived values)
- Test on a 4× CPU throttle in Chrome DevTools — if it still feels smooth, ship it

---

## Checklist

Before adding a new animation:

- [ ] It conveys a specific piece of information (state, progress, causality)
- [ ] It has a named meaning in this document or is added to this document
- [ ] It uses motion tokens (`var(--motion-*)`, `var(--ease-*)`) — no magic numbers
- [ ] It has a `prefers-reduced-motion` fallback
- [ ] It animates only `transform` and/or `opacity`
- [ ] It can be interrupted by user interaction
- [ ] It doesn't exceed 400ms (unless there's a documented reason)
- [ ] It has a clear cause and a clear direction
