
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
  utils/            Pure utility / helper tests
  routes/           Route-level tests
  api/              API client tests
  setup.ts          Global preload — Happy DOM + SVG stubs
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

// Suppress lucide SVG noise in Happy DOM (required in every component test file)
mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))
```

### Store test

```ts
import { describe, it, expect, beforeEach } from 'bun:test'
import { useTeamStore } from '@/stores/useTeamStore'

const INITIAL = { /* full initial state shape */ }

beforeEach(() => {
  useTeamStore.setState(INITIAL)
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
mock.module('@/utils/LazyMarkdownBlock', () => ({
  LazyMarkdownBlock: (props: Record<string, unknown>) => {
    lastProps = props
    return <div data-testid="lazy-markdown">{String(props.content ?? '')}</div>
  },
}))

// Stub an API module before importing the store that uses it
// MUST appear before any import that transitively requires it
const mockPostChat = mock(() => Promise.resolve({ session_id: 'sid' }))
mock.module('@/api/client', () => ({ postChat: mockPostChat }))
import { useTeamStore } from '@/stores/useTeamStore' // import AFTER mock
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
**Always run tests with `--parallel`** (the project default) so each file gets its own worker process.
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

### AgentStream factory (for `AgentPane` tests)

```ts
import type { AgentStream } from '@/stores/useTeamStore'

function makeStream(overrides: Partial<AgentStream> = {}): AgentStream {
  return {
    blocks: [], currentBlocks: [], currentText: '', currentThinking: '',
    status: 'idle',
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0 },
    _completionBase: 0, model: null, lastError: null,
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

### `AgentPane`

```ts
import { AgentPane } from '@/components/AgentPane'

// AgentPane takes `name`, `stream`, `isLead` — NOT blocks/isWorking directly.
// isWorking is derived from stream.status === 'working'
render(<AgentPane name="researcher" stream={makeStream({ status: 'working' })} isLead={false} />)
```

---

## Store seeding and SSE simulation

```ts
// Seed state
useTeamStore.setState({
  agentStreams: { lead: makeStream({ blocks: [...] }) },
  agentNames: ['lead'], leadName: 'lead',
})

// Fire SSE events through the real reducer
useTeamStore.getState()._handleSSEEvent('summarization_start', { agent: 'lead' })
useTeamStore.getState()._handleSSEEvent('summarization_content', { agent: 'lead', text: 'Hello ' })
useTeamStore.getState()._handleSSEEvent('summarization_end', { agent: 'lead', summary: 'Final' })

// Read resulting state
const blocks = useTeamStore.getState().agentStreams.lead.blocks
```

---

## `isStreaming` in block renderers

`isStreaming` is computed per-block in `AssistantTurnFooter`:

```
isStreaming = isWorking && absoluteBlockIndex >= finalizedCount
```

- A block in `currentBlocks` (not yet flushed) is streaming when `isWorking=true`.
- A block in `blocks` (finalized) is **never** streaming even if the agent is working on new content.
- Components that receive `isStreaming` (e.g. `Thinking`, `CompactionDivider`, `LazyMarkdownBlock`) **must** have it forwarded — omitting it silently disables smooth-stream animation.

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

# Full suite (always use --parallel — it's the project default and provides file isolation)
bun test --parallel src/__tests__

# Single file
bun test src/__tests__/components/MyComponent.test.tsx

# Two files (use --parallel to prevent mock.module cross-contamination)
bun test --parallel src/__tests__/components/A.test.tsx src/__tests__/components/B.test.tsx

# Type-check test files
bunx tsc -p tsconfig.test.json --noEmit
```

TypeScript IDE errors showing "Cannot find module 'bun:test'" in test files are **expected** — the test `tsconfig` excludes `src/__tests__/` from type checking by design. Run the `tsc` command above to catch real errors.

---

## Checklist before committing a test

- [ ] `afterEach(cleanup)` present in every component test file
- [ ] `lucide-react` mocked at the top of every component test file
- [ ] `mock.module()` for API clients placed **before** any store import in that file
- [ ] Store tests reset state in `beforeEach`
- [ ] `--parallel` used whenever running multiple files that use `mock.module()`
- [ ] No `screen.getByText` on text that is only in a tooltip / `title` attribute — use `getByTitle` or `querySelector('[title]')` scan
- [ ] New file added to the right subfolder matching its source counterpart
