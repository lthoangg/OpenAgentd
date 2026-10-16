# Debug reference: web UI (`web/`)

Use for rendering, state, hooks, API calls, and live UI behavior. The same
code runs in the browser and both Tauri shells.

## Evidence commands

```bash
cd web
bun run typecheck                                  # tsc -b: app + tests
bun run lint                                       # oxlint --type-aware
bun test --parallel src/__tests__/<path>.test.tsx  # focused
bun run test                                       # full suite (parallel)
```

## Live UI

Run `make dev` (API :8000 + Vite :5173). Sessions open at
`http://localhost:5173/<session-id>` (dashed UUID); other routes are `/coding`,
`/telemetry`, and `/scheduler` (`src/router.ts`).

- **Preview tool** (in-app): `preview` with `action: 'open'` on the Vite URL, then
  `snapshot`, `click`, `fill`, `press`, `inspect`, and `logs` for console errors.
  It acts only while the user has the Preview tab open; a hidden tab reports a
  0×0 viewport, so layout values are not meaningful then.
- **browser-skill (`bsk`)**, when available, drives the user's own browser and can
  take screenshots: `bsk session start`, `bsk navigate`, `bsk observe`, `bsk click`,
  `bsk evaluate`, `bsk console`.
- Neither shows true iOS WKWebView rendering, frame rate, or soft-keyboard timing.

Hard-won rules: the floating composer starts minimized on desktop (press
**Expand input bar** first); fill controlled inputs through the tool, never by
setting `.value` in script; scope selectors to `#main`, because the sidebar and
chat both have scroll containers.

## File map

```
web/src/
  components/
    ui/                     primitives (button, dialog, popover, dropdown, tooltip, tabs, inline-title-input, …)
    AgentChatView/          chat screen: header, overlays (useOverlayState), session bootstrap
    AgentView/ AgentView.tsx   transcript; UserBubble.tsx renders mentions and design feedback cards
    InputComposer*.ts(x)    composer: mentions, suggestions, attachments, delivery menu
    FloatingInputComposer.tsx
    WorkspacePanel/         review dock: tab bar, drag reorder (useTabDrag), Git, commits
    Terminal/  Preview/     terminal tabs, Preview tab and design comments
  stores/                   Zustand (useAgentStore/ with sse-reducer.ts, terminal, UI, file reveal, …)
  queries/                  TanStack Query factories
  api/                      typed client and wire types (api/types.ts)
  lib/                      keyboard dispatcher, design-feedback, focus helpers, desktop-shell
  utils/                    markdown renderer, file-refs (path:line links), code highlight
  routes/ router.ts         TanStack Router
  __tests__/                bun test + Testing Library, mirroring src/
```

## Failure boundaries

| Boundary | Inspect |
|---|---|
| Render bug | the component and its `__tests__/` counterpart |
| State desync | the Zustand store, the TanStack Query key, `cache-invalidation-bridge.ts` |
| Wire shape | `api/types.ts`, the query or mutation, and what the backend actually stored |
| Streaming / SSE | `stores/useAgentStore/sse-reducer.ts`, `appv3/contract/sse_events.json` |
| Mentions and file refs | `InputComposer.mentions.ts`, `UserBubble.tsx`, `utils/file-refs.ts`, `useOverlayState.ts` |
| Keyboard and focus | `lib/keyboard/`, `hooks/use-dock-focus.ts`, `lib/desktop-shell.ts` |
| Primitive bug | `components/ui/*.tsx`: portal positioning, `useDeferredUnmount` called before early returns |
| CSS / layout | Tailwind classes, `index.css` tokens, dark-mode variants, `DESIGN.md` |

## Platform differences

- Desktop-only and mobile-only behavior goes through the platform hooks
  (`hooks/use-platform.ts`, `lib/desktop-shell.ts`); open external URLs with the
  Tauri opener in the shells, `window.open` in the browser.
- The desktop shell injects its token through the sidecar handshake; the browser
  talks to the API directly (an access key when one is configured).
