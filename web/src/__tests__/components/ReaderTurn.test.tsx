import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))

import { AssistantTurn } from '@/components/AssistantTurnFooter'
import { FileRefContext, type FileRefOpener } from '@/components/FileRefLink'
import { useAgentStore } from '@/stores/useAgentStore'
import type { ContentBlock } from '@/api/types'

beforeEach(() => {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: () => Promise.resolve() }, configurable: true, writable: true })
})
afterEach(() => {
  cleanup()
  useAgentStore.setState({ sessionId: null, pendingQuestion: null, resolvedQuestions: {} })
})

const patchArgs = (...lines: string[]) => JSON.stringify({ patch_text: ['*** Begin Patch', ...lines, '*** End Patch'].join('\n') })

const finished: ContentBlock[] = [
  { id: 'think', type: 'thinking', content: 'Where is it?' },
  { id: 'read', type: 'tool', content: '', toolName: 'read', toolArgs: '{"path":"src/a.ts"}', toolDone: true, toolResult: 'x' },
  { id: 'narrate', type: 'text', content: 'Fixing it now.' },
  { id: 'edit', type: 'tool', content: '', toolName: 'patch', toolArgs: patchArgs('*** Update File: src/a.ts', '@@', '-a', '+b', '+c'), toolDone: true, toolResult: 'ok' },
  { id: 'answer', type: 'text', content: 'Done.' },
]

function renderTurn(blocks: ContentBlock[], props: {
  isWorking?: boolean
  isTurnOpen?: boolean
  startedAt?: number
  opener?: FileRefOpener
} = {}) {
  const turn = (
    <AssistantTurn
      blocks={blocks}
      startIndex={0}
      finalizedCount={props.isWorking ? 0 : blocks.length}
      isWorking={props.isWorking ?? false}
      isTurnOpen={props.isTurnOpen}
      startedAt={props.startedAt}
      isTrailingTurn
      totalBlocks={blocks.length}
      reader
      renderBlock={({ block }) => <p data-testid={`block-${block.id}`}>{block.content || block.id}</p>}
    />
  )
  return render(props.opener ? <FileRefContext.Provider value={props.opener}>{turn}</FileRefContext.Provider> : turn)
}

const rendered = (id: string) => screen.queryByTestId(`block-${id}`)
const workRow = () => screen.getByRole('button', { name: /1 read, 1 edit/ })
const running: ContentBlock[] = [
  ...finished.slice(0, 4),
  { id: 'test', type: 'tool', content: '', toolName: 'shell', toolArgs: '{"command":"bun test","description":"Run web tests"}', toolDone: false },
]

/** Bun has no fake timers: drive ``setInterval`` and ``Date.now`` by hand. */
function fakeClock(start: number) {
  const realSetInterval = globalThis.setInterval
  const realClearInterval = globalThis.clearInterval
  const realNow = Date.now
  let now = start
  const timers = new Map<number, () => void>()
  let nextId = 0
  globalThis.setInterval = ((callback: () => void) => {
    timers.set(++nextId, callback)
    return nextId
  }) as unknown as typeof setInterval
  globalThis.clearInterval = ((id: number) => { timers.delete(id) }) as typeof clearInterval
  Date.now = () => now
  return {
    tick(ms: number) {
      now += ms
      act(() => { for (const callback of [...timers.values()]) callback() })
    },
    restore() {
      globalThis.setInterval = realSetInterval
      globalThis.clearInterval = realClearInterval
      Date.now = realNow
    },
  }
}

describe('AssistantTurn — reader mode', () => {
  it('shows the answer and folds the work behind one row that opens it', () => {
    renderTurn(finished)

    expect(rendered('answer')).not.toBeNull()
    for (const id of ['think', 'read', 'narrate', 'edit']) expect(rendered(id)).toBeNull()

    const row = screen.getByRole('button', { name: /1 read, 1 edit/ })
    expect(row.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(row)

    expect(row.getAttribute('aria-expanded')).toBe('true')
    for (const id of ['think', 'read', 'narrate', 'edit']) expect(rendered(id)).not.toBeNull()
  })

  it('lists the files the turn edited behind a closed row, and opens its diff from the list', () => {
    const open = mock((..._args: unknown[]) => {})
    const openDiff = mock((..._args: unknown[]) => {})
    renderTurn(finished, { opener: { canOpen: () => true, open, openDiff } })

    const files = screen.getByRole('button', { name: /1 file changed/ })
    expect(files.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('button', { name: /src\/a\.ts/ })).toBeNull()

    fireEvent.click(files)

    expect(files.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: /src\/a\.ts/ }))
    expect(openDiff).toHaveBeenCalledWith({ path: 'src/a.ts', status: 'M' })
    expect(open).not.toHaveBeenCalled()

    fireEvent.click(files)
    expect(screen.queryByRole('button', { name: /src\/a\.ts/ })).toBeNull()
  })

  it('opens a deleted file diff from the list when openDiff is provided', () => {
    const deletedBlock: ContentBlock = {
      id: 'delete-file',
      type: 'tool',
      content: '',
      toolName: 'patch',
      toolArgs: patchArgs('*** Delete File: src/old.ts'),
      toolDone: true,
      toolResult: 'ok',
    }
    const openDiff = mock((..._args: unknown[]) => {})
    renderTurn([deletedBlock, { id: 'answer', type: 'text', content: 'Deleted it.' }], {
      opener: { canOpen: () => true, open: () => {}, openDiff },
    })

    fireEvent.click(screen.getByRole('button', { name: /1 file changed/ }))
    const item = screen.getByRole('button', { name: /src\/old\.ts/ })
    fireEvent.click(item)
    expect(openDiff).toHaveBeenCalledWith({ path: 'src/old.ts', status: 'D' })
  })

  it('falls back to open when openDiff is not provided on opener', () => {
    const open = mock((..._args: unknown[]) => {})
    renderTurn(finished, { opener: { canOpen: () => true, open } })

    fireEvent.click(screen.getByRole('button', { name: /1 file changed/ }))
    fireEvent.click(screen.getByRole('button', { name: /src\/a\.ts/ }))
    expect(open).toHaveBeenCalledWith({ path: 'src/a.ts' })
  })

  it('names the step in progress while the turn runs, and lists no files yet', () => {
    renderTurn(running, { isWorking: true })

    expect(screen.getByRole('button', { name: /Working · Shell: Run web tests/ })).toBeTruthy()
    expect(screen.queryByText(/files? changed/)).toBeNull()
  })

  it('says how long the turn has been working, and keeps counting', () => {
    const clock = fakeClock(1_000_000)
    try {
      renderTurn(running, { isWorking: true, startedAt: 1_000_000 - 59_000 })
      expect(screen.getByRole('button', { name: /^Working · 59s · Shell: Run web tests/ })).toBeTruthy()

      clock.tick(1000)
      expect(screen.getByRole('button', { name: /^Working · 1m 0s · Shell: Run web tests/ })).toBeTruthy()

      clock.tick(3_600_000)
      expect(screen.getByRole('button', { name: /^Working · 1h 1m · Shell: Run web tests/ })).toBeTruthy()
    } finally {
      clock.restore()
    }
  })

  it('counts the work so far once no step is taking output', () => {
    renderTurn([...finished.slice(0, 4), { id: 'answer', type: 'text', content: 'Writing the answer' }], { isWorking: true, startedAt: Date.now() - 5000 })

    expect(screen.getByRole('button', { name: /^Working · 5s · 1 read, 1 edit/ })).toBeTruthy()
  })

  it('does not mention failures while working', () => {
    const failedRun: ContentBlock = { id: 'run', type: 'tool', content: '', toolName: 'shell', toolArgs: '{"command":"false"}', toolDone: true, toolResult: '[Failed — exit code 1]' }
    renderTurn([failedRun, running[4]], { isWorking: true, startedAt: Date.now() - 5000 })

    const row = screen.getByRole('button', { name: /^Working/ })
    expect(row.textContent).not.toMatch(/failed/)
  })

  it('does not count failures once the turn ends either; the opened step shows them', () => {
    renderTurn([
      { id: 'think', type: 'thinking', content: 'Hmm.' },
      { id: 'run', type: 'tool', content: '', toolName: 'shell', toolArgs: '{"command":"false"}', toolDone: true, toolResult: '[Failed — exit code 1]' },
      { id: 'answer', type: 'text', content: 'It failed.' },
    ])
    expect(screen.getByRole('button', { name: /^1 command$/ })).toBeTruthy()
  })

  it('says a thought-only trace thought', () => {
    renderTurn([{ id: 'think', type: 'thinking', content: 'Hmm.' }, { id: 'answer', type: 'text', content: 'Hi.' }])
    expect(screen.getByRole('button', { name: /^Thought/ })).toBeTruthy()
  })
})

describe('AssistantTurn — reader mode, across a compaction', () => {
  const compaction = (state: 'compacting' | 'compacted'): ContentBlock => ({
    id: 'compact', type: 'compaction', content: 'Summary so far', extra: { state },
  })
  const follows = (a: Node, b: Node) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)

  it('reads the work before a compaction as done, and works on after the divider', () => {
    renderTurn([finished[1], compaction('compacted'), running[4]], { isWorking: true, startedAt: Date.now() - 5000 })

    const done = screen.getByRole('button', { name: /^1 read$/ })
    const working = screen.getAllByRole('button', { name: /Working/ })
    expect(working).toHaveLength(1)
    expect(working[0].textContent).toMatch(/^Working · .*Shell: Run web tests/)
    const divider = screen.getByTestId('block-compact')
    expect(follows(done, divider)).toBe(true)
    expect(follows(divider, working[0])).toBe(true)
  })

  it('does not say it is working while the session compacts', () => {
    renderTurn([finished[1], compaction('compacting')], { isWorking: true, startedAt: Date.now() - 5000 })

    expect(screen.queryByRole('button', { name: /Working/ })).toBeNull()
    expect(screen.getByRole('button', { name: /^1 read$/ })).toBeTruthy()
    expect(screen.getByTestId('block-compact')).toBeTruthy()
  })
})

describe('AssistantTurn — reader mode, closing a long fold', () => {
  const originalRect = HTMLElement.prototype.getBoundingClientRect
  afterEach(() => {
    HTMLElement.prototype.getBoundingClientRect = originalRect
  })

  function rectAt(top: number): DOMRect {
    return { top, bottom: top + 24, left: 0, right: 600, width: 600, height: 24, x: 0, y: top, toJSON: () => ({}) } as DOMRect
  }

  /**
   * The fold opened in a transcript scrolled to ``scrollTop``. Closed, the
   * row sits 1000px into the transcript; open, it is pinned to the top of
   * the view, and the fold's end is 400px down it.
   */
  function renderScrolledTurn(scrollTop: number) {
    render(
      <div data-testid="transcript" style={{ overflowY: 'auto' }}>
        <AssistantTurn
          blocks={finished}
          startIndex={0}
          finalizedCount={finished.length}
          isWorking={false}
          isTrailingTurn
          totalBlocks={finished.length}
          reader
          renderBlock={({ block }) => <p data-testid={`block-${block.id}`}>{block.content || block.id}</p>}
        />
      </div>,
    )
    const transcript = screen.getByTestId('transcript')
    Object.defineProperty(transcript, 'scrollTop', { value: scrollTop, configurable: true, writable: true })
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      const expanded = this.getAttribute('aria-expanded')
      if (expanded !== null) return rectAt(expanded === 'true' ? 0 : 1000 - transcript.scrollTop)
      if (this.textContent === 'Collapse') return rectAt(400)
      return rectAt(0)
    }
    fireEvent.click(workRow())
    return transcript
  }

  it('pins the open row to the top of the transcript while its steps scroll under it', () => {
    renderTurn(finished)
    const header = workRow().parentElement as HTMLElement
    expect(header.className).not.toContain('sticky')

    fireEvent.click(workRow())

    expect(header.className).toContain('sticky')
    expect(header.className).toContain('top-(--fold-top,0px)')
  })

  it('pins an opened step just below the row, not over it', () => {
    renderTurn(finished)
    fireEvent.click(workRow())

    const body = document.getElementById(workRow().getAttribute('aria-controls') ?? '') as HTMLElement
    expect(body.className).toContain('[--fold-top:1.5rem]')
  })

  it('pins the open file list header so it can close from anywhere in a long list', () => {
    renderTurn(finished, { opener: { canOpen: () => true, open: () => {}, openDiff: () => {} } })
    const files = screen.getByRole('button', { name: /1 file changed/ })
    expect(files.className).not.toContain('sticky')

    fireEvent.click(files)

    expect(files.className).toContain('sticky')
    expect(files.closest('section')?.className).not.toContain('overflow-hidden')
  })

  it('closes from the end of the steps too, handing focus back to the row', () => {
    renderTurn(finished)
    expect(screen.queryByRole('button', { name: 'Collapse' })).toBeNull()
    fireEvent.click(workRow())

    fireEvent.click(screen.getByRole('button', { name: 'Collapse' }))

    expect(workRow().getAttribute('aria-expanded')).toBe('false')
    for (const id of ['think', 'read', 'narrate', 'edit']) expect(rendered(id)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Collapse' })).toBeNull()
    expect(document.activeElement).toBe(workRow())
  })

  it('puts the row where the reader clicked when the fold closes from its end', () => {
    const transcript = renderScrolledTurn(3000)

    fireEvent.click(screen.getByRole('button', { name: 'Collapse' }))

    // The row lands 400px down the view, where the button was.
    expect(transcript.scrollTop).toBe(600)
  })

  it('leaves the pinned row where it is when it closes the fold', () => {
    const transcript = renderScrolledTurn(3000)

    fireEvent.click(workRow())

    // The row stays at the top of the view instead of scrolling away with the steps.
    expect(transcript.scrollTop).toBe(1000)
  })

  it('does not move a row that closes where it already sits', () => {
    const transcript = renderScrolledTurn(700)
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      return rectAt(this.getAttribute('aria-expanded') !== null ? 1000 - transcript.scrollTop : 0)
    }

    fireEvent.click(workRow())

    expect(transcript.scrollTop).toBe(700)
  })
})

describe('AssistantTurn — reader mode, ask_user', () => {
  const PLACEHOLDER = 'Waiting for the user to answer. Do not continue until their reply arrives.'
  const ask = (toolResult: string): ContentBlock => ({
    id: 'ask', type: 'tool', content: '', toolName: 'ask_user', toolCallId: 'call-q', toolArgs: '{"questions":[]}', toolDone: true, toolResult,
  })
  const read = finished[1]
  const shell: ContentBlock = { id: 'run', type: 'tool', content: '', toolName: 'shell', toolArgs: '{"command":"ls"}', toolDone: true, toolResult: 'ok' }
  const answer = finished[4]

  it('folds an answered question with the rest of the work', () => {
    renderTurn([read, ask('User has answered your questions: "Which?"="A". Continue with the user\'s answers in mind.'), shell, answer])

    expect(rendered('ask')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /1 read/ }))
    expect(rendered('ask')).not.toBeNull()
  })

  it('folds a question answered here before the transcript catches up', () => {
    useAgentStore.setState({ sessionId: 's-1', pendingQuestion: null, resolvedQuestions: { 'call-q': { questions: [], answers: [['A']], reason: null } } })

    renderTurn([read, ask(PLACEHOLDER), shell, answer])

    expect(rendered('ask')).toBeNull()
  })

  it('keeps the open question out of the fold', () => {
    useAgentStore.setState({ sessionId: 's-1', pendingQuestion: { id: 'q-1', sessionId: 's-1', toolCallId: 'call-q', questions: [] }, resolvedQuestions: {} })

    renderTurn([read, ask(PLACEHOLDER)])

    expect(rendered('ask')).not.toBeNull()
  })

  it('does not say it is working while the turn waits on the answer', () => {
    useAgentStore.setState({ sessionId: 's-1', pendingQuestion: { id: 'q-1', sessionId: 's-1', toolCallId: 'call-q', questions: [] }, resolvedQuestions: {} })

    renderTurn([read, ask(PLACEHOLDER)], { isTurnOpen: true, startedAt: Date.now() - 5000 })

    expect(screen.queryByRole('button', { name: /Working/ })).toBeNull()
    expect(screen.getByRole('button', { name: /^1 read$/ })).toBeTruthy()
  })
})

describe('AssistantTurn — reader mode, submit_plan', () => {
  const PLACEHOLDER = 'Waiting for the user to answer. Do not continue until their reply arrives.'
  const submit = (toolResult: string): ContentBlock => ({
    id: 'submit', type: 'tool', content: '', toolName: 'submit_plan', toolCallId: 'call-p', toolArgs: '{}', toolDone: true, toolResult,
  })
  const read = finished[1]
  const shell: ContentBlock = { id: 'run', type: 'tool', content: '', toolName: 'shell', toolArgs: '{"command":"ls"}', toolDone: true, toolResult: 'ok' }
  const answer = finished[4]

  it('keeps a plan waiting for review out of the fold', () => {
    useAgentStore.setState({
      sessionId: 's-1',
      pendingQuestion: { id: 'q-1', sessionId: 's-1', toolCallId: 'call-p', kind: 'plan_review', planRevision: 1, questions: [] },
      resolvedQuestions: {},
    })

    renderTurn([read, submit(PLACEHOLDER)])

    expect(rendered('submit')).not.toBeNull()
  })

  it('folds a reviewed plan with the rest of the work', () => {
    useAgentStore.setState({ sessionId: 's-1', pendingQuestion: null, resolvedQuestions: {} })

    renderTurn([read, submit('The user approved plan revision 1. The session is now in Code mode with full tool access.'), shell, answer])

    expect(rendered('submit')).toBeNull()
  })

  it('keeps a plan call with submit waiting for review out of the fold', () => {
    useAgentStore.setState({
      sessionId: 's-1',
      pendingQuestion: { id: 'q-1', sessionId: 's-1', toolCallId: 'call-p', kind: 'plan_review', planRevision: 1, questions: [] },
      resolvedQuestions: {},
    })
    const planSubmit: ContentBlock = { ...submit(PLACEHOLDER), toolName: 'plan', toolArgs: '{"action":"write","content":"# P","submit":true}' }

    renderTurn([read, planSubmit])

    expect(rendered('submit')).not.toBeNull()
  })
})

describe('AssistantTurn — reader mode, /goal', () => {
  const read = finished[1]
  const achieved: ContentBlock = {
    id: 'claim', type: 'tool', content: '', toolName: 'update_goal', toolArgs: '{"status":"complete","evidence":"bun test: 0 failures"}',
    toolDone: true, toolResult: 'The check confirmed the goal is met: 0 failures.\nThe goal is achieved.',
  }
  const summary: ContentBlock = { id: 'summary', type: 'text', content: 'All green.' }

  it('shows that the goal was achieved without opening the work', () => {
    renderTurn([read, achieved, summary])

    expect(rendered('claim')).not.toBeNull()
    expect(rendered('summary')).not.toBeNull()
    expect(rendered('read')).toBeNull()
  })

  it('keeps the goal card out of the one work row while the agent works on', () => {
    renderTurn([read, achieved, running[4]], { isWorking: true, startedAt: Date.now() - 5000 })

    const rows = screen.getAllByRole('button')
    expect(rows).toHaveLength(1)
    expect(rows[0].textContent).toMatch(/^Working · .*Shell: Run web tests/)
    expect(rendered('claim')).not.toBeNull()
  })
})
