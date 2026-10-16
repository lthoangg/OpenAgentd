
Write focused, fast tests for the OpenAgentd web UI (`web/src/__tests__/`).

---

## Stack

| Layer | Tool |
|---|---|
| Runner | `bun test` (Bun's built-in Jest-compatible runner) |
| DOM | Happy DOM via `@happy-dom/global-registrator` (registered in `setup.ts`) |
| Components | `@testing-library/react` — `render`, `screen`, `cleanup`, `act`, `waitFor` |
| User interaction | `@testing-library/user-event` (`userEvent.setup()`) |
| API mocking | `msw` (available) or `mock.module()` for module-level stubs |
| Hooks | `renderHook` from `@testing-library/react` |
| Assertions | `expect()` from `bun:test`; `@testing-library/jest-dom` available |

---

## File layout

```
web/src/__tests__/
  components/       One file per component (or per concern slice)
  hooks/            Hook-only tests
  stores/           Zustand store tests
  lib/              lib/ modules (keyboard, design feedback, focus, …)
  utils/            Pure utility / helper tests
  routes/           Route-level tests
  queries/          TanStack Query factories
  api/              API client tests
  setup.ts          Global preload (bunfig.toml) — Happy DOM, SVG `?url` stubs, framer-motion stub
```

Mirror the source path: `components/Foo.tsx` → `__tests__/components/Foo.test.tsx`.
Split large files by concern: `AgentView.footer.test.tsx`, `AgentView.scroll.test.tsx`, `AgentView.compaction.test.tsx`.

---

## Imports

```ts
import { describe, it, expect, afterEach, beforeEach, mock, spyOn } from 'bun:test'
import { render, screen, cleanup, act, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderHook } from '@testing-library/react'
```

Always use `@/` aliases — never relative `../../` paths.

---

## Setup boilerplate

### Component test

```ts
import { describe, it, expect, afterEach, mock } from 'bun:test'
import { render, screen, cleanup } from '@testing-library/react'
import { MyComponent } from '@/components/MyComponent'

afterEach(cleanup)

// Optional: stub lucide icons when a heavy tree renders many of them. Files that
// need named icons list them instead: mock.module('lucide-react', () => ({ X: Icon }))
mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))
```

### Store test

```ts
import { describe, it, expect, beforeEach } from 'bun:test'
import { useAgentStore } from '@/stores/useAgentStore'

const INITIAL = { /* full initial state shape */ }

beforeEach(() => {
  useAgentStore.setState(INITIAL)
})
```

### Hook test (with rAF mocking)

```ts
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test'
import { renderHook, cleanup, act } from '@testing-library/react'

let pendingFrames: FrameRequestCallback[] = []

const mockRaf = mock((...args: any[]) => {
  pendingFrames.push(args[0])
  return pendingFrames.length
})
const mockCancelRaf = mock((...args: any[]) => {
  const id = args[0] as number
  if (id > 0 && id <= pendingFrames.length) pendingFrames[id - 1] = () => {}
})

function flushFrames(count = 1) {
  for (let i = 0; i < count; i++) {
    const frames = pendingFrames.slice(); pendingFrames = []
    frames.forEach(cb => cb(performance.now()))
  }
}

beforeEach(() => {
  pendingFrames = []
  globalThis.requestAnimationFrame = mockRaf as any
  globalThis.cancelAnimationFrame = mockCancelRaf as any
})
afterEach(() => { cleanup(); pendingFrames = [] })
```

---

## Module mocking

### `mock.module()` — module-level replacement

Use to stub an entire module before the component under test imports it.

```ts
// Stub a child component to capture forwarded props
let lastProps: Record<string, unknown> = {}
mock.module('@/utils/markdown', () => ({
  MarkdownBlock: (props: Record<string, unknown>) => {
    lastProps = props
    return <div data-testid="markdown">{String(props.content ?? '')}</div>
  },
}))

// Stub an API module before importing the store that uses it
// MUST appear before any import that transitively requires it
const mockPostChat = mock(() => Promise.resolve({ session_id: 'sid' }))
mock.module('@/api/client', () => ({ postChat: mockPostChat }))
import { useAgentStore } from '@/stores/useAgentStore' // import AFTER mock
```

### `spyOn()` — per-call observation without full replacement

```ts
import { spyOn } from 'bun:test'
const spy = spyOn(console, 'error')
// … run code …
expect(spy).toHaveBeenCalledWith(expect.stringContaining('oops'))
```

### ⚠️ Isolation rule

`mock.module()` patches the **global** Bun module registry. `mock.restore()` does NOT undo it.
**Always run tests with `--parallel`** (`bun run test` and `make verify-web` pass it) so each file gets its own worker process.
If a test file uses `mock.module()` for a module that another file also imports normally, they **must** be in separate files and rely on `--parallel` for isolation — never pass both to a single `bun test` invocation without `--parallel`.

---

## Helpers — block factories

Keep these in each test file that needs `ContentBlock` values:

```ts
import type { ContentBlock } from '@/api/types'

const makeTextBlock    = (id: string, content: string, timestamp?: Date): ContentBlock =>
  ({ id, type: 'text', content, timestamp })
const makeUserBlock    = (id: string, content: string): ContentBlock =>
  ({ id, type: 'user', content })
const makeThinkingBlock = (id: string, content: string): ContentBlock =>
  ({ id, type: 'thinking', content })
const makeToolBlock    = (id: string, toolName: string): ContentBlock =>
  ({ id, type: 'tool', content: '', toolName, toolDone: true })
const makeCompactionBlock = (id: string, content: string, state: 'compacting' | 'compacted' = 'compacted'): ContentBlock =>
  ({ id, type: 'compaction', content, extra: { state } })
```

### AgentStream factory (shape: `AgentStream` in `stores/useAgentStore/types.ts`)

```ts
import type { AgentStream } from '@/stores/useAgentStore'

function makeStream(overrides: Partial<AgentStream> = {}): AgentStream {
  return {
    blocks: [], currentBlocks: [], currentText: '', currentThinking: '',
    status: 'idle',
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0 },
    model: null, lastError: null,
    ...overrides,
  }
}
```

---

## Rendering components

### `AgentView`

```ts
import { AgentView } from '@/components/AgentView'

function renderView(props: Partial<React.ComponentProps<typeof AgentView>> = {}) {
  return render(
    <AgentView
      blocks={props.blocks ?? []}
      currentBlocks={props.currentBlocks ?? []}
      isWorking={props.isWorking ?? false}
      onContinue={props.onContinue}
      onMentionFileOpen={props.onMentionFileOpen}
    />
  )
}
```

---

## Store seeding and SSE simulation

```ts
// Seed state
useAgentStore.setState({
  agentStreams: { lead: makeStream({ blocks: [...] }) },
  agentNames: ['lead'], leadName: 'lead',
})

// Fire SSE events through the real reducer
useAgentStore.getState()._handleSSEEvent('summarization_start', { agent: 'lead' })
useAgentStore.getState()._handleSSEEvent('summarization_content', { agent: 'lead', text: 'Hello ' })
useAgentStore.getState()._handleSSEEvent('summarization_end', { agent: 'lead', summary: 'Final' })

// Read resulting state
const blocks = useAgentStore.getState().agentStreams.lead.blocks
```

---

## `isStreaming` in block renderers

`isStreaming` is computed per-block in `AssistantTurnFooter`:

```
isStreaming = isCompactionStreaming || (isWorking && absoluteBlockIndex >= finalizedCount && isLast)
```

- Only the last not-yet-finalized block streams while `isWorking=true` (a compaction block also streams while it compacts).
- A block in `blocks` (finalized) is **never** streaming even if the agent is working on new content.
- Components that receive `isStreaming` (e.g. `Thinking`, `CompactionDivider`, `MarkdownBlock`) **must** have it forwarded — omitting it silently disables smooth-stream animation.

---

## DOM limitations in Happy DOM

| Missing / broken | Workaround |
|---|---|
| `navigator.clipboard` | `Object.defineProperty(navigator, 'clipboard', { value: { writeText: () => Promise.resolve() }, configurable: true })` |
| `requestAnimationFrame` | Replace with deterministic mock (see hook boilerplate above) |
| SVG `?url` imports | Stubbed globally in `setup.ts` via `mock.module()` for `material-icon-theme` icons |
| Lucide SVG components | `mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))` |
| `window.location.origin` | Already set to `http://localhost:5173/` in `setup.ts` |
| CSS attribute selectors with special chars | Use `document.querySelectorAll('[attr]')` + manual filter instead |
| `scrollTo({ behavior: 'smooth' })` | Unreliable — set `el.scrollTop` directly and dispatch a `scroll` event |

---

## Asserting prop forwarding

When testing that a parent correctly forwards props to a child, mock the child:

```ts
let capturedProps: Record<string, unknown> = {}

mock.module('@/components/ChildComponent', () => ({
  ChildComponent: (props: Record<string, unknown>) => {
    capturedProps = { ...props }
    return <div data-testid="child" data-prop={String(props.someProp)} />
  },
}))

// After render:
expect(capturedProps.someProp).toBe(expectedValue)
```

---

## Running tests

```bash
cd web

# Full suite (same as `bun run test`)
bun run test

# Single file
bun test --parallel src/__tests__/components/MyComponent.test.tsx

# Two files (use --parallel to prevent mock.module cross-contamination)
bun test --parallel src/__tests__/components/A.test.tsx src/__tests__/components/B.test.tsx

# Type-check app and tests (tsc -b follows tsconfig.app.json + tsconfig.test.json)
bun run typecheck
```

`tsconfig.app.json` excludes `src/__tests__/`; `tsconfig.test.json` covers it, and
`bun run typecheck` builds both. CI also runs `bun exec tsc -p tsconfig.test.json --noEmit`.
An editor that only loads the app config may flag `bun:test` imports; trust `bun run typecheck`.

---

## Checklist before committing a test

- [ ] `afterEach(cleanup)` present in every component test file
- [ ] `mock.module()` for API clients placed **before** any store import in that file
- [ ] Store tests reset state in `beforeEach`
- [ ] `--parallel` used whenever running multiple files that use `mock.module()`
- [ ] No `screen.getByText` on text that is only in a tooltip / `title` attribute — use `getByTitle` or `querySelector('[title]')` scan
- [ ] New file added to the right subfolder matching its source counterpart
