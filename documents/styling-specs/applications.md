---
title: Applications & Templates
description: Component examples using OpenAgentd tokens in both light and dark modes
status: stable
updated: 2026-04-21
---

# Applications & Templates

Component examples using OpenAgentd tokens. All examples work in both modes without modification; brand pigment is reserved for identity, agent state, and primary moments.

---

## Buttons

### Primary

Uses the accent. The gradient variant is reserved for hero/landing — regular UI uses the flat accent.

```tsx
// Regular primary
<button className="bg-accent text-bg px-4 py-2 rounded font-medium hover:bg-accent-hover transition-all duration-150">
  Start session
</button>

// Hero primary (gradient — one per surface)
<button className="bg-[image:var(--gradient-accent)] text-bg px-5 py-2.5 rounded font-medium shadow-sm hover:brightness-110 transition-all duration-150">
  Start session
</button>
```

### Secondary

```tsx
<button className="bg-surface-2 text-text border border-border px-4 py-2 rounded font-medium hover:bg-surface-3 hover:border-border-strong transition-all duration-150">
  Cancel
</button>
```

### Destructive

```tsx
<button className="bg-error text-bg px-4 py-2 rounded font-medium hover:brightness-110 transition-all duration-150">
  Delete session
</button>
```

### Ghost

```tsx
<button className="text-text px-4 py-2 rounded font-medium hover:bg-accent-subtle transition-all duration-150">
  Skip
</button>
```

### Loading

Label swaps to progressive text; pointer events lock. No spinner unless progress text isn't possible.

```tsx
<button disabled className="bg-accent/60 text-bg px-4 py-2 rounded font-medium cursor-not-allowed">
  Connecting…
</button>
```

### With font-weight transition (signature)

Interactive buttons shift weight on hover and active — see [typography.md](./typography.md#font-weight-transitions-signature-interaction).

```tsx
<button
  className="bg-accent text-bg px-4 py-2 rounded
             font-normal hover:font-medium active:font-semibold
             transition-all duration-150 ease-out"
>
  Start session
</button>
```

---

## Card

```tsx
<div className="bg-surface border border-border rounded-lg p-6 shadow-[var(--shadow-depth)]">
  <h3 className="text-h3 font-semibold text-text mb-2">Session title</h3>
  <p className="text-text-muted text-sm mb-4">Started 3 minutes ago · 2 agents active</p>
  <button className="text-accent hover:text-accent-hover font-normal hover:font-medium transition-all">
    View details →
  </button>
</div>
```

`var(--shadow-depth)` resolves to `none` on dark (brightness provides depth) and to a real shadow on light.

---

## Status indicators

Every status pairs color with an icon or label — never color alone.

```tsx
// Running — pulsing success dot
<div className="flex items-center gap-2 text-text-2">
  <span className="relative flex w-2 h-2">
    <span className="absolute inset-0 bg-success rounded-full animate-ping opacity-75" />
    <span className="relative w-2 h-2 bg-success rounded-full" />
  </span>
  <span>Running</span>
</div>

// Error
<div className="flex items-center gap-2 text-error">
  <AlertCircle className="w-4 h-4" />
  <span>Failed</span>
</div>

// Success (static, non-celebratory)
<div className="flex items-center gap-2 text-success">
  <CheckCircle className="w-4 h-4" />
  <span>Completed</span>
</div>

// Pending
<div className="flex items-center gap-2 text-warning">
  <Clock className="w-4 h-4" />
  <span>Queued</span>
</div>
```

---

## Forms

### Input field

```tsx
<div className="flex flex-col gap-2">
  <label htmlFor="max-wait" className="text-text font-medium text-sm">
    Max wait time (seconds)
  </label>
  <input
    id="max-wait"
    type="number"
    defaultValue={30}
    className="bg-surface-2 border border-border rounded px-3 py-2 text-text placeholder:text-text-muted
               focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)]
               focus:border-accent transition-colors"
    placeholder="30"
  />
  <p className="text-text-muted text-sm">
    Increase for longer-running tool calls.
  </p>
</div>
```

### Textarea (YAML / config)

```tsx
<textarea
  className="bg-surface-2 border border-border rounded px-3 py-2 text-text font-mono text-sm
             placeholder:text-text-muted
             focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)]
             focus:border-accent transition-colors resize-y min-h-[200px]"
  placeholder="mode: chat&#10;max_wait: 30"
/>
```

### Field with error

```tsx
<div className="flex flex-col gap-2">
  <label htmlFor="name" className="text-text font-medium text-sm">Session name</label>
  <input
    id="name"
    aria-invalid="true"
    aria-describedby="name-error"
    className="bg-surface-2 border border-error rounded px-3 py-2 text-text
               focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)]"
  />
  <p id="name-error" className="text-error text-sm flex items-center gap-1.5">
    <AlertCircle className="w-3.5 h-3.5" />
    Name is required.
  </p>
</div>
```

---

## Code block

Syntax colors resolve correctly in both modes via tokens from [colors.md](./colors.md#syntax-highlighting--code).

```tsx
<pre className="bg-surface border border-border rounded-lg p-4 overflow-x-auto">
  <code className="text-text font-mono text-sm leading-relaxed">
    <span className="text-syn-keyword">const</span>{' '}
    <span className="text-text">agent</span>{' '}
    <span className="text-syn-operator">=</span>{' '}
    <span className="text-syn-keyword">new</span>{' '}
    <span className="text-syn-type">Agent</span>()
    <span className="text-syn-operator">.</span>
    <span className="text-syn-function">init</span>()
  </code>
</pre>
```

For rendered markdown, use the `.prose` class — styled globally to consume the syntax tokens.

---

## Error state page

```tsx
<div className="flex flex-col items-center justify-center min-h-screen bg-bg px-4">
  <AlertCircle className="w-16 h-16 text-error mb-4" aria-hidden="true" />
  <h1 className="text-h1 font-bold text-text mb-2">
    Session failed
  </h1>
  <p className="text-text-muted text-center mb-6 max-w-[50ch]">
    Session timeout after 30 seconds. Increase <code className="bg-surface-2 px-1.5 py-0.5 rounded font-mono text-sm">max_wait</code> in <code className="bg-surface-2 px-1.5 py-0.5 rounded font-mono text-sm">chat.yaml</code> and try again.
  </p>
  <div className="flex gap-3">
    <button className="bg-accent text-bg px-4 py-2 rounded hover:bg-accent-hover transition-colors">
      Retry
    </button>
    <a href="/docs/troubleshoot" className="text-text-2 hover:text-text underline underline-offset-4 self-center">
      Troubleshooting guide →
    </a>
  </div>
</div>
```

---

## Empty state

```tsx
<div className="flex flex-col items-center justify-center py-12 bg-surface rounded-lg border border-border">
  <Inbox className="w-12 h-12 text-text-muted mb-4" aria-hidden="true" />
  <h2 className="text-h3 font-semibold text-text mb-2">
    No sessions yet
  </h2>
  <p className="text-text-muted text-center mb-6 max-w-[40ch]">
    Create a session to start working with agents.
  </p>
  <button className="bg-accent text-bg px-4 py-2 rounded hover:bg-accent-hover transition-colors">
    Create session
  </button>
</div>
```

---

## Modal / dialog

```tsx
{/* Backdrop */}
<div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 animate-in fade-in duration-150">
  {/* Panel */}
  <div
    role="dialog"
    aria-modal="true"
    aria-labelledby="dialog-title"
    className="bg-surface border border-border rounded-lg shadow-2xl w-96 max-w-[90vw]
               animate-in fade-in zoom-in-95 slide-in-from-bottom-2 duration-240"
  >
    <div className="border-b border-border px-6 py-4">
      <h2 id="dialog-title" className="text-h3 font-semibold text-text">
        Confirm deletion
      </h2>
    </div>

    <div className="px-6 py-4">
      <p className="text-text-2">
        This cannot be undone. Delete this session?
      </p>
    </div>

    <div className="border-t border-border px-6 py-4 flex justify-end gap-3">
      <button className="text-text-2 hover:text-text px-4 py-2 rounded transition-colors">
        Cancel
      </button>
      <button className="bg-error text-bg px-4 py-2 rounded hover:brightness-110 transition-all">
        Delete
      </button>
    </div>
  </div>
</div>
```

Focus is trapped inside the dialog; `Esc` closes it; focus returns to the trigger on close. See [interaction.md](./interaction.md#focus-trap-rules).

---

## Sidebar navigation

```tsx
<aside className="w-64 bg-surface border-r border-border h-screen overflow-y-auto flex flex-col">
  <div className="px-6 py-5 border-b border-border">
    <span className="font-bold text-lg text-text tracking-tight">OpenAgentd</span>
  </div>

  <nav aria-label="Primary" className="flex flex-col gap-0.5 p-3 flex-1">
    <a
      href="/chat"
      className="flex items-center gap-3 px-3 py-2 rounded text-text-2
                 hover:bg-accent-subtle hover:text-text
                 font-normal hover:font-medium
                 transition-all duration-150"
    >
      <MessageCircle className="w-4 h-4" aria-hidden="true" />
      <span>Chat</span>
    </a>
    <a
      href="/teams"
      aria-current="page"
      className="flex items-center gap-3 px-3 py-2 rounded bg-accent-subtle text-text font-medium"
    >
      <Users className="w-4 h-4" aria-hidden="true" />
      <span>Teams</span>
    </a>
    <a
      href="/docs"
      className="flex items-center gap-3 px-3 py-2 rounded text-text-2
                 hover:bg-accent-subtle hover:text-text
                 font-normal hover:font-medium
                 transition-all duration-150"
    >
      <BookOpen className="w-4 h-4" aria-hidden="true" />
      <span>Docs</span>
    </a>
  </nav>

  <div className="p-3 border-t border-border">
    <ThemeToggle />
  </div>
</aside>
```

Current page shows `aria-current="page"` + permanent selected styling. Hover shifts weight (see [typography.md](./typography.md#font-weight-transitions-signature-interaction)).

---

## Theme toggle (three-way)

`system` / `light` / `dark`. Persisted to `localStorage`. No flash of wrong theme on load (see [layout.md](./layout.md#mode-switching)).

```tsx
import { Monitor, Sun, Moon } from 'lucide-react';

type Theme = 'system' | 'light' | 'dark';

function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(
    () => (localStorage.getItem('theme') as Theme) ?? 'system'
  );

  useEffect(() => {
    localStorage.setItem('theme', theme);
    const resolved =
      theme === 'system'
        ? matchMedia('(prefers-color-scheme: light)').matches
          ? 'light'
          : 'dark'
        : theme;
    document.documentElement.classList.remove('light', 'dark');
    document.documentElement.classList.add(resolved);
  }, [theme]);

  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      className="inline-flex gap-0.5 bg-surface-2 border border-border rounded-full p-0.5"
    >
      {(['system', 'light', 'dark'] as const).map((mode) => {
        const Icon = mode === 'system' ? Monitor : mode === 'light' ? Sun : Moon;
        const selected = theme === mode;
        return (
          <button
            key={mode}
            role="radio"
            aria-checked={selected}
            aria-label={`${mode} theme`}
            onClick={() => setTheme(mode)}
            className={`
              flex items-center justify-center w-7 h-7 rounded-full transition-all duration-150
              ${selected ? 'bg-accent text-bg' : 'text-text-muted hover:text-text'}
            `}
          >
            <Icon className="w-3.5 h-3.5" />
          </button>
        );
      })}
    </div>
  );
}
```

---

## Thinking indicator (streaming)

Full motion spec in [motion.md](./motion.md#thinking-indicator-pulse-dots). Progressive label text named by the agent.

```tsx
function ThinkingIndicator({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 text-text-muted" role="status" aria-live="polite">
      <div className="flex gap-1">
        <span className="w-1.5 h-1.5 bg-text-muted rounded-full animate-pulse [animation-delay:0ms]" />
        <span className="w-1.5 h-1.5 bg-text-muted rounded-full animate-pulse [animation-delay:200ms]" />
        <span className="w-1.5 h-1.5 bg-text-muted rounded-full animate-pulse [animation-delay:400ms]" />
      </div>
      <span className="text-sm">{label}</span>
    </div>
  );
}

// Usage — label updates as the agent progresses
<ThinkingIndicator label="Thinking" />
<ThinkingIndicator label="Reading 4 files" />
<ThinkingIndicator label="Writing patch" />
```

---

## Streaming cursor

The blinking cursor that trails live-streamed text. Spec in [motion.md](./motion.md#streaming-cursor-blink).

```tsx
<span className="inline-block w-[0.5ch] h-[1em] bg-text align-text-bottom animate-[streaming-cursor_1s_steps(2,end)_infinite]" />
```

```css
@keyframes streaming-cursor {
  0%, 50%   { opacity: 1; }
  51%, 100% { opacity: 0; }
}
```

Remove the cursor the moment streaming ends or a tool call starts. A blinking cursor with no live generation is a bug.

---

## Floating composer

The chat input is a *glass* surface (see [layout.md](./layout.md#elevation-levels)) that floats over the conversation rather than docking to the bottom. It is draggable via a top-edge grip, position is persisted to `localStorage` (`oa-input-position`), and a double-click on the grip resets to bottom-center.

### Rules

- **Width**: `max-w-xl` (576px) — narrower than a docked strip so it feels like an instrument, not a toolbar
- **Default position**: bottom-center, 16px gap from the viewport edge
- **Drag affordance**: handle-only (`GripHorizontal` at top-center). The whole panel is *not* draggable — text selection and inner controls must work normally
- **Grip anchors to the input pill, not the outer panel**: the `GripHorizontal` is rendered via `InputBar`'s `renderDragHandle` render-prop inside a `relative` wrapper that scopes it to the pill. This keeps the grip pinned to the pill's top edge regardless of whether file previews are rendered above or below (see *Attachment previews* below). Older revisions anchored it to the outer panel, which made the grip drift to the top of the preview strip when files were attached.
- **Persistence**: `{x, y}` written to `oa-input-position`; clamped to viewport on mount and on `resize`
- **Reset**: double-click the grip returns to default position
- **No bottom padding underneath**: the content area flows behind the composer. Blur + low tint are what separate them — adding `pb-24` would re-create the docked strip we removed

### Attachment previews

File-attachment chips (images rendered as thumbnails, other files as `FileCard`) live in a row adjacent to the input pill. Three rules keep the composer usable even when users drag it around or attach many files:

1. **Direction is position-dependent** — `FloatingInputBar` computes a `filesBelow` boolean and passes it to `InputBar`:
   - **Default: `true`** — previews render *below* the input pill. This is the preferred direction because the pill hugs the bottom of the viewport by default and there is no room above for a preview strip that doesn't feel like a popover.
   - **Flips to `false` (previews above)** only when the panel is docked far from the bottom — specifically when `bounds.bottom - panel.bottom ≥ 140px`. This threshold is just enough clearance for a compact preview row without re-colliding with the viewport edge.
   - Recomputed on: mount, `window` resize, drag end, and double-click reset. There is no hysteresis — the decision is re-derived from current geometry every time the panel moves.
2. **Single row with horizontal scroll, never vertical wrap** — the row is `flex flex-nowrap w-max` inside an `overflow-x-auto` scroll container. Attaching more files scrolls sideways; it never pushes the pill vertically off screen. `-mx-2 -my-2` on the outer wrapper neutralizes `px-2 py-2` on the scroll container (the padding exists so `-top-2`/`-right-2` remove buttons on each chip are not clipped — `overflow-x` forces y-axis clipping, so vertical padding must be explicit).
3. **Image thumbnails render in *compact* mode** — `ImageAttachment` takes a `compact?: boolean` prop. When `true` (the mode used here), the `<img>` uses `max-h-[160px] max-w-[160px]` instead of the default `200×200`. The click-to-expand lightbox is unaffected — full-size preview remains available. This caps vertical intrusion from tall portrait images. `FileCard` is ~40px tall and needs no compact mode.

### Surface

```tsx
<div
  className="bg-(--color-surface-2)/20 backdrop-blur-xl shadow-xl
             border border-border rounded-2xl
             px-3 py-2"
>
  {/* grip + textarea + send */}
</div>
```

The outer positioning wrapper has no background of its own — all glass styling lives on the inner pill so the translucency reads correctly against whatever is scrolling underneath. Putting `bg-*` on the wrapper *and* the pill produces a double-layer that looks opaque; pick one (the pill) and keep the wrapper bare.

### Drag handle

The grip is passed to `InputBar` via the `renderDragHandle` render-prop so that `InputBar` can position it relative to the input pill (not the outer panel). `InputBar` renders the prop inside a `<div className="relative">` immediately wrapping the pill; the handle uses `absolute left-1/2 top-0 -translate-x-1/2 -translate-y-1/2` to sit straddling the pill's top edge.

```tsx
<InputBar
  floating
  filesBelow={filesBelow}
  renderDragHandle={() => (
    <button
      type="button"
      aria-label="Drag input bar (double-click to reset position)"
      title="Drag to move · Double-click to reset"
      onPointerDown={(e) => dragControls.start(e)}
      onDoubleClick={handleReset}
      className="absolute left-1/2 top-0 z-10 -translate-x-1/2 -translate-y-1/2 …"
    >
      <GripHorizontal size={12} aria-hidden="true" />
    </button>
  )}
  {...inputProps}
/>
```

Use framer-motion's `useDragControls` with `dragListener={false}` on the motion wrapper, then start drag manually from the handle's `onPointerDown`. This is the only reliable way to gate drag to a sub-region without breaking pointer events on the rest of the panel.

Why render-prop instead of an outer wrapper: when file previews flip to render above the input pill, an outer-panel-scoped handle drifts up with them. The render-prop puts the handle inside the `InputBar`'s input-pill-scoped `relative` wrapper, which never moves relative to the pill itself.

---

## Draggable panes

The same handle-only drag pattern applies to team view agent panes. Drag is gated to a visible `GripVertical`; the whole panel remains a valid drop target via `onDragOver` / `onDrop` on its root. Never make an entire panel draggable — it conflicts with text selection and with any floating controls layered on top.

```tsx
<div onDragOver={handleDragOver} onDrop={handleDrop} className="relative">
  <div
    draggable
    onDragStart={handleDragStart}
    className="absolute top-2 left-2 cursor-grab"
    aria-label="Reorder pane"
  >
    <GripVertical className="w-4 h-4 text-text-muted" />
  </div>
  {/* pane content — selectable, clickable, normal */}
</div>
```

---

## Tool-call row

Slides in from below with a spring ([motion.md](./motion.md#tool-call-row-slide-in)).

```tsx
<div
  className="bg-surface-2 border border-border rounded-md px-3 py-2
             flex items-center gap-3
             animate-in slide-in-from-bottom-1 fade-in duration-240 ease-out"
>
  <Wrench className="w-4 h-4 text-accent" aria-hidden="true" />
  <span className="text-sm font-mono text-text-2">read_file</span>
  <span className="text-sm text-text-muted truncate">app/agent/mode/chat.py</span>
  <span className="ml-auto text-xs text-text-muted">124ms</span>
</div>
```

---

## Design token export (JSON)

For Figma, Storybook, or other design tools:

```json
{
  "mode": {
    "dark": {
      "color": {
        "bg": "#0A0A0B",
        "surface": "#111113",
        "surface-2": "#18181B",
        "surface-3": "#1F1F23",
        "border": "#27272A",
        "border-strong": "#3F3F46",
        "text": "#FAFAFA",
        "text-2": "#A1A1AA",
        "text-muted": "#71717A",
        "text-subtle": "#52525B",
        "accent": "#E4E4E7",
        "accent-hover": "#F4F4F5",
        "success": "#4ADE80",
        "warning": "#FBBF24",
        "error": "#F87171",
        "info": "#93C5FD"
      },
      "gradient-accent": "linear-gradient(180deg, #FAFAFA 0%, #D4D4D8 100%)",
      "focus-ring": "#E4E4E7",
      "shadow-depth": "none"
    },
    "light": {
      "color": {
        "bg": "#FAFAFA",
        "surface": "#FFFFFF",
        "surface-2": "#F4F4F5",
        "surface-3": "#E4E4E7",
        "border": "#E4E4E7",
        "border-strong": "#D4D4D8",
        "text": "#09090B",
        "text-2": "#52525B",
        "text-muted": "#71717A",
        "text-subtle": "#A1A1AA",
        "accent": "#27272A",
        "accent-hover": "#18181B",
        "success": "#16A34A",
        "warning": "#D97706",
        "error": "#DC2626",
        "info": "#2563EB"
      },
      "gradient-accent": "linear-gradient(180deg, #3F3F46 0%, #18181B 100%)",
      "focus-ring": "#18181B",
      "shadow-depth": "0 1px 2px rgba(0,0,0,0.04), 0 2px 8px rgba(0,0,0,0.04)"
    }
  },
  "typography": {
    "font-sans": "'Geist Variable', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    "font-mono": "'JetBrains Mono', ui-monospace, 'SF Mono', 'Courier New', monospace",
    "size": {
      "display": "32px",
      "h1": "28px",
      "h2": "24px",
      "h3": "20px",
      "body": "16px",
      "sm": "14px",
      "xs": "12px"
    },
    "weight": {
      "regular": 400,
      "medium": 500,
      "semibold": 600,
      "bold": 700
    }
  },
  "spacing": {
    "base": "4px",
    "xs": "4px",
    "sm": "8px",
    "md": "12px",
    "lg": "16px",
    "xl": "24px",
    "2xl": "32px",
    "3xl": "48px",
    "4xl": "64px"
  },
  "motion": {
    "duration": {
      "instant": "80ms",
      "fast": "150ms",
      "base": "240ms",
      "slow": "400ms",
      "glacial": "800ms"
    },
    "ease": {
      "out": "cubic-bezier(0.16, 1, 0.3, 1)",
      "in-out": "cubic-bezier(0.4, 0, 0.2, 1)",
      "spring-soft": "cubic-bezier(0.34, 1.2, 0.64, 1)",
      "spring-snappy": "cubic-bezier(0.22, 1.4, 0.36, 1)"
    }
  }
}
```

---

## Pre-ship checklist

- [ ] Tokens used (`bg-*`, `text-*`, `border-*`) — no raw hex values
- [ ] Both modes verified (toggle between light/dark — nothing should look broken)
- [ ] Typography uses Geist Variable; code uses JetBrains Mono
- [ ] Spacing aligns to 4px base
- [ ] Focus ring visible on `:focus-visible` (tab through the UI to verify)
- [ ] Contrast ≥ 4.5:1 for body text (Lighthouse / WebAIM)
- [ ] Icons from lucide-react, sized to the [imagery.md](./imagery.md#sizing) scale
- [ ] Status colors paired with icon or label (never color alone)
- [ ] Motion uses tokens from [motion.md](./motion.md) — no magic ms values
- [ ] Font-weight transitions on interactive elements only
- [ ] `prefers-reduced-motion` tested
- [ ] Keyboard navigation works end-to-end (no traps, logical tab order)
- [ ] Touch targets ≥ 44×44 on mobile
- [ ] Empty/error/loading states all present
