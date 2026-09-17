# Debug reference: Frontend (web UI)

Use when the symptom is in the React app — rendering, state, hooks, API calls, or live UI behavior.

---

## Evidence commands

```bash
cd web

bun run typecheck          # TypeScript errors across all source
bun run lint               # ESLint (catches unused vars, hook rules, a11y)
bun test --reporter=verbose  # full test suite
bun test <path/to/test>    # focused test file
```

For live UI issues (visual regression, interaction bugs, DOM/CSS state) use browser-skill (`bsk`) to drive the real UI — see the **Live UI verification** section below.

---

## File map

```
web/src/
  components/            UI components
    ui/                  Zero-dep primitives (button, dialog, sheet, popover,
                           dropdown, tooltip, switch, tabs — no shadcn/Base UI/CVA)
      _use-deferred-unmount.ts  Exit-animation hook; must be called before any return null
    AgentView/
      UserBubble.tsx     User message bubble (mention highlighting, collapse, copy)
    InboxBubble.tsx      Inter-agent inbox messages
    InputBar.tsx         Composer (file attach, mentions, submit)
    FloatingInputBar.tsx Floating variant
    ToolCall/            Tool call display components
    …
  hooks/                 React hooks (session, streaming, settings, …)
  stores/                Zustand stores (session, UI, pending messages, …)
  queries/               TanStack Query factories (sessions, agents, messages)
  api/                   Typed API client + generated types
  utils/
    LazyMarkdownBlock.tsx  Lazy markdown renderer (used in assistant + inbox bubbles)
  routes/                TanStack Router pages
  __tests__/             Vitest + RTL tests — mirror the component path
```

---

## Common failure boundaries

| Boundary | What to inspect |
|---|---|
| Render bug | Component file + its `__tests__/` counterpart |
| State desync | Zustand store (`stores/`) + TanStack Query key factory |
| API shape mismatch | `api/types.ts`, query/mutation in `queries/` |
| Hook misfire | Custom hook in `hooks/` + React rules (StrictMode double-invoke) |
| CSS / layout | Tailwind classes, `index.css` design tokens, dark-mode variants |
| UI primitive bug | `components/ui/*.tsx`; check portal positioning, `useDeferredUnmount` hook order, `tw-animate-css` classes |
| Streaming / SSE | `hooks/` streaming hook, `stores/` pending message queue |
| Mention / file ref | `InputBar.mentions.ts`, `UserBubble.tsx` → `renderMentionSegments` |

---

## Tauri-aware patterns in the frontend

Some behaviors differ between **web browser** and **Tauri webview**:

- **Opening URLs externally** — in a browser use `window.open(url, '_blank')`; in Tauri use `@tauri-apps/plugin-opener` → `openUrl`. Detect with `window.__TAURI_INTERNALS__` or the `isTauri()` helper.
- **File system access** — only available via Tauri commands, not the browser File API.
- **Auth token injection** — desktop injects `X-Desktop-Token` via the Tauri sidecar handshake; web relies on cookie/session.

---

## Verification

```bash
cd web
bun run typecheck
bun run lint
bun test --reporter=verbose
```

---

## Live UI verification (browser-skill / bsk)

Use when you need real rendered state: focus/keyboard behavior, layout, scroll position, component state transitions, console errors.

- **CAN verify:** rendered DOM, computed CSS, live JS state, click/type/key interactions, console errors, screenshots.
- **CANNOT verify:** true iOS WKWebView rendering, 60fps smoothness, real soft-keyboard timing (desktop Chromium only).

### Preconditions

```bash
lsof -ti:5173 >/dev/null 2>&1 && echo up || echo down
# if down:
cd web && bun dev   # background; wait for :5173
bsk doctor
```

### Core loop

```bash
bsk session start --json                                      # retain session_id <id>
bsk navigate "http://localhost:5173/cockpit" --session <id>   # /cockpit = real chat UI
bsk observe --session <id>                                    # discover @eN element refs
bsk click @e3 --session <id>
bsk fill @e3 --value "..." --session <id>
bsk evaluate "<expression returning string>" --session <id>
bsk screenshot --session <id> --out "$(pwd)/.openagentd/screenshots/<name>.png"
bsk session stop <id>
```

### Hard-won rules

- **Controlled React inputs:** use `click` then `fill` — do NOT set `textarea.value` via `evaluate`.
- **Composer starts minimized on desktop.** Click `Expand input bar` first.
- **`evaluate` must return a string/number.** Wrap objects with `JSON.stringify(...)`. Use an IIFE for multi-statement expressions.
- **Scope selectors** — `.overflow-y-auto` exists in sidebar AND chat. Use `document.getElementById('main').querySelector(...)`.
- **Screenshots need absolute paths.** Use `$(pwd)/...`.

### Diagnostics and console

Use `bsk console --session <id>` for console logs directly, or evaluate:

```
bsk console --session <id>
```

### Focus / keyboard / mobile spoofing

```bash
# Focus check after toggle:
bsk evaluate "document.querySelector('textarea').getAttribute('aria-label') + '|active=' + (document.activeElement && document.activeElement.getAttribute('aria-label'))" --session <id>

# Spoof mobile keyboard (viewport shrinks to 460px):
bsk evaluate "document.documentElement.setAttribute('data-mobile-shell','ios'); document.documentElement.style.setProperty('--app-vh','460px'); ''" --session <id>
bsk evaluate "const e=document.querySelector('.mobile-viewport'); e ? getComputedStyle(e).height : 'no .mobile-viewport'" --session <id>  # PASS: 460px
```
