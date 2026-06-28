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

For live UI issues (visual regression, interaction bugs, DOM/CSS state) load and follow the **`oad/frontend-debug`** skill — it drives the real UI via browser-use and can screenshot, inspect state, and simulate mobile keyboard.

---

## File map

```
web/src/
  components/            UI components
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

For visual sign-off after a component change, take a screenshot via `oad/frontend-debug`.
