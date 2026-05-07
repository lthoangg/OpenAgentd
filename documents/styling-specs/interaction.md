---
title: Interaction
description: Hover, focus, active states, keyboard model, touch adaptation, and state choreography
status: stable
updated: 2026-04-29
---

# Interaction

The interaction language defines how the OpenAgentd UI responds to pointer, keyboard, and touch input. It consumes tokens from [motion.md](./motion.md) and [typography.md](./typography.md) and applies them consistently across every component.

---

## Core rules

### 1. Hover is a promise

Hover previews what will happen if the user acts — it never *reveals* new functionality. An element that only exists on hover is hidden UI, which breaks discoverability on touch devices and for keyboard users.

**Allowed hover effects:**
- Brightness/contrast shift on the element itself
- Font-weight shift (400 → 500)
- Underline on links
- Tooltip appearance (after 500ms delay)
- Cursor change

**Not allowed:**
- Revealing buttons that weren't visible before
- Showing actions in a table row that are hidden otherwise (use persistent visibility or an explicit "…" menu instead)
- Expanding content that isn't already indicated as expandable

**Exception — secondary destructive/utility actions on desktop only.** Some actions (session delete, code-block copy) are hidden until hover on desktop for density reasons (`opacity-0 group-hover:opacity-100`). These must be **always visible on mobile** because touch has no hover state. Use `opacity-100 md:opacity-0 md:group-hover:opacity-100` so the button is visible by default and hidden-until-hover only on `md+` screens.

### 2. Focus is a right, not a privilege

Every interactive element is reachable by keyboard, in a logical order, with a visible focus ring. Removing focus rings (`outline: none` without a replacement) is never acceptable.

Focus appears only on `:focus-visible` — meaning keyboard navigation or programmatic focus. Mouse clicks don't produce a ring, because the user already knows what they clicked.

### 3. Active is a receipt

When the user presses an interactive element, the UI acknowledges receipt before the action completes. For buttons, this is the pressed state (font-weight 600, slight background darkening). For forms, this is the disabled state plus a progress indicator.

The gap between "user pressed" and "result appeared" is where perceived responsiveness lives. Acknowledge within 80ms, even if the real work takes longer.

### 4. One interaction per input

A click is a click. A hover is a hover. A keypress is a keypress. Don't combine — e.g. long-press-to-reveal, or double-click-for-secondary-action — unless the platform already establishes the convention.

---

## State choreography

Every interactive element moves through a subset of these states. The transitions between them are where the OpenAgentd product identity lives.

```
idle  →  hover  →  focus  →  active  →  loading  →  (success | error)  →  idle
```

### State specifications

| State | Visual change | Motion token |
|-------|---------------|--------------|
| **Idle** | Default — border, text, and background at their resting values | — |
| **Hover** | Font-weight 400 → 500; background → `accent-subtle`; cursor changes to `pointer` | `var(--motion-fast)` + `var(--ease-out)` |
| **Focus** | 2px `--focus-ring` outline with 2px offset, fades in from opacity 0 → 1 | `var(--motion-fast)` + `var(--ease-out)` |
| **Active** | Font-weight 500 → 600; background → `accent-hover`; slight scale 1 → 0.98 (buttons only) | `var(--motion-instant)` + `var(--ease-in-out)` |
| **Loading** | Label replaced with progressive text (`Thinking…`, `Saving…`); input locked; keyboard Escape cancels | — |
| **Success** | Brief opacity pulse (0.6 → 1.0), no color flash, returns to idle | `var(--motion-base)` + `var(--ease-out)` |
| **Error** | Label updates to error message; border → `--color-error`; no shake, no bounce | `var(--motion-fast)` + `var(--ease-out)` |

### Direction reverses in light mode

In dark mode, hover "brightens" (moves toward white). In light mode, hover "darkens" (moves toward black). The perceptual rule is the same ("hover increases contrast with the surrounding surface"), but the direction of the color change reverses.

```css
/* Dark mode: hover brightens */
.button:hover {
  background: var(--color-accent-subtle);  /* subtle neutral tint */
}

/* Light mode: hover darkens */
:root.light .button:hover {
  background: var(--color-accent-subtle);  /* subtle neutral tint */
}
```

Because tokens are mode-aware, the same CSS rule produces the correct direction in both modes. Don't write mode-specific rules unless the *behavior* genuinely differs.

---

## Font-weight transitions (signature)

A signature of the OpenAgentd interaction language. Text shifts weight under the cursor — subtly, without moving. See [typography.md](./typography.md#font-weight-transitions-signature-interaction) for the full rule.

```css
.interactive {
  font-weight: 400;
  transition: font-weight var(--motion-fast) var(--ease-in-out);
}

.interactive:hover  { font-weight: 500; }
.interactive:active { font-weight: 600; }
```

**Where it applies**: buttons, nav items, tabs, menu items, links in controls (not in prose).

**Where it doesn't**: body text, headings, disabled elements, elements inside a scrolling list where the weight shift would cause reflow.

---

## Focus ring specification

### Visual

- **Width**: 2px
- **Offset**: 2px (outside the element)
- **Color**: `var(--focus-ring)` — `#E4E4E7` on dark, `#18181B` on light
- **Radius**: matches element's `border-radius`
- **Fade-in**: opacity 0 → 1, `var(--motion-fast)`, `var(--ease-out)`

### CSS

```css
:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 2px;
  transition: outline-color var(--motion-fast) var(--ease-out);
}

/* Remove the default :focus ring only for mouse users */
:focus:not(:focus-visible) {
  outline: none;
}
```

### Never do

- ❌ `outline: none` without a replacement
- ❌ Custom ring that fails 3:1 contrast against the element's background
- ❌ Ring on `:focus` (shows on mouse click — produces a ring the user didn't ask for)
- ❌ Ring that's part of the element border (breaks focus visibility for non-rectangular shapes)

---

## Proximity effects

Proximity — where hover state fades in based on cursor distance rather than binary "hovered or not" — is used sparingly for **dense lists** where binary hover would cause too much visual noise as the cursor travels.

### When to use

- Agent/session lists with many rows
- Command palette results
- Sidebar navigation with 10+ items

### When not to use

- Single buttons
- Sparse navigation (fewer than 6 items — binary hover is clearer)
- Anything outside a scrollable list

### Implementation sketch

```tsx
function ProximityRow({ mouseY, rowY }: Props) {
  const distance = Math.abs(mouseY - rowY);
  const intensity = Math.max(0, 1 - distance / 120); // fade over 120px radius
  return (
    <div
      style={{
        backgroundColor: `color-mix(in srgb, var(--color-accent-subtle) ${intensity * 100}%, transparent)`,
      }}
    />
  );
}
```

Proximity should never *replace* the binary hover state — it should coexist. A directly-hovered row still gets the full `hover` treatment; adjacent rows get the fade.

---

## Keyboard model

### Global shortcuts

| Keys | Action | Mobile |
|------|--------|--------|
| `⌘P` / `Ctrl+P` | Open command palette | disabled |
| `⌘N` / `Ctrl+N` | Start new chat | active |
| `⌘K` / `Ctrl+K` | Split active pane to the right (team view, unified mode) | disabled |
| `Ctrl+A` | Toggle Agent Capabilities panel (team view) | active |
| `Ctrl+T` | Toggle Todos popover (team view, requires active session) | active |
| `Ctrl+I` | Focus chat input (team view) | active |
| `Esc` | Close top-most modal/panel; cancel in-flight action; blur focused input | active |
| `Tab` / `Shift+Tab` | Move focus forward / backward | active |
| `/` | Focus primary search input (when present) | active |
| `?` | Open keyboard shortcuts cheat sheet | active |
| `⌘\` / `Ctrl+\` | Toggle sidebar | active |
| `⌘,` / `Ctrl+,` | Open settings | active |
| `v` | Cycle view mode (agent / split / unified) | disabled |

> **Note**: Command palette moved from `Ctrl+K` to `Ctrl+P` so that `Ctrl+K` can remain available for context-local actions like "split pane right" inside the team view. Keep both labels accurate anywhere a shortcut is surfaced (tooltip, keycap, status bar, palette header).

### Within controls

| Control | Keys |
|---------|------|
| **Button** | `Space` or `Enter` to activate |
| **Link** | `Enter` to follow |
| **Checkbox** | `Space` to toggle |
| **Radio group** | Arrow keys to navigate, `Space` to select |
| **Tabs** | `←` `→` to navigate, `Home` / `End` for first/last |
| **Listbox / Select** | `↑` `↓` to navigate, `Enter` to confirm, type-to-search |
| **Modal** | `Esc` to close; focus trapped inside |
| **Drawer** | `Esc` to close; focus moves to trigger on close |
| **Menu** | `↑` `↓` to navigate items, `Esc` to close, `Enter` to activate |

### Skip links

Every page has a "Skip to main content" link that appears on the first `Tab` press. It moves focus past navigation to the main content area.

```html
<a href="#main" class="skip-link">Skip to main content</a>
```

```css
.skip-link {
  position: absolute;
  top: -40px;
  left: 0;
  padding: 8px 16px;
  background: var(--color-accent);
  color: var(--color-bg);
  transition: top var(--motion-fast) var(--ease-out);
  z-index: 100;
}

.skip-link:focus-visible {
  top: 0;
}
```

### Focus trap rules

- Modals and drawers trap focus — `Tab` cycles within the panel
- Trap is released on close; focus returns to the element that opened the panel
- Trap is never permanent — `Esc` always escapes (except in explicit confirmation dialogs where an action is required)

---

## Touch adaptation

### Minimum target sizes

- **Touch targets**: 44×44 CSS pixels minimum (iOS/Android HIG)
- **Spacing between targets**: 8px minimum to prevent mistaps
- **Inline links in text**: `padding: 2px 0` to increase tap area without disrupting layout

### Hover → press

On touch devices, the `hover` state does not exist. It's replaced by the `active` (pressed) state.

```css
@media (hover: hover) {
  /* Pointer device — hover is valid */
  .button:hover { /* … */ }
}

@media (hover: none) {
  /* Touch device — skip hover, use active */
  .button:active { /* … */ }
}
```

### Gestures

OpenAgentd does not rely on custom gestures (swipe, pinch, etc.) for core functionality. Platform-standard gestures work — back-swipe on iOS, pull-to-refresh on Android — and they are respected, not overridden.

---

## Loading & disabled states

### Loading

- Label changes to progressive text: `Start session` → `Starting…` → `Connecting…` → result
- Input is disabled (pointer-events: none, reduced opacity)
- Spinner only if the operation is truly opaque and text progress isn't possible
- `Esc` cancels the loading action when the underlying operation supports cancellation

### Disabled

- Opacity reduced to 0.5
- `cursor: not-allowed`
- `pointer-events: none`
- Still focusable via `Tab` if the disabled state can change (so users can discover why it's disabled via tooltip)
- `aria-disabled="true"` on the element
- Explanatory tooltip on hover/focus: "Disabled — sign in to start a session"

Never combine loading + disabled visually — the two states look the same but mean different things. A loading button is *busy*; a disabled button is *unavailable*. Use distinct affordances (loading = progressive text, disabled = reduced opacity).

---

## Anti-patterns

| Anti-pattern | Why it's wrong |
|-------------|----------------|
| **Hover-only buttons in tables** | Inaccessible on touch and for keyboard users. Use persistent or menu-based reveal. Exception: secondary desktop-only actions may use `md:opacity-0 md:group-hover:opacity-100` provided they are always visible (`opacity-100`) below `md`. |
| **Focus ring removed without replacement** | Breaks keyboard accessibility entirely. |
| **Different focus ring styles per component** | Fragments the visual language. One ring style, system-wide. |
| **Custom gestures for core functions** | Undiscoverable. Use platform-standard gestures only. |
| **Double-click for primary actions** | Non-standard on web. Keep single-click primary. |
| **Hover content that isn't also reachable by focus** | Screen reader and keyboard users are locked out. |
| **Weight shift on static text** | Only interactive elements shift weight. |
| **Sub-44px touch targets** | Fails touch usability guidelines. |
| **Proximity effects on sparse lists** | Adds complexity without payoff. |

---

## Checklist

Before shipping an interactive component:

- [ ] Hover, focus, active, loading, disabled states all defined
- [ ] Focus ring visible on `:focus-visible`, 2px, 2px offset
- [ ] Keyboard-accessible (Tab reaches it, Enter/Space activates)
- [ ] Escape key behavior defined (if in a modal/drawer/menu)
- [ ] Font-weight transition applied (if it's a text-based control)
- [ ] Touch target ≥ 44×44 CSS pixels
- [ ] `prefers-reduced-motion` honored
- [ ] No hover-only functionality
- [ ] Hover direction reverses correctly in light mode
- [ ] ARIA roles and labels where semantic HTML isn't sufficient
