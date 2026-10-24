import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))

import { AgentView } from '@/components/AgentView'
import { PROMPT_JUMP_MARGIN } from '@/components/AgentView/prompt-nav'
import { useAgentStore } from '@/stores/useAgentStore'
import { useDisplayPrefsStore } from '@/stores/useDisplayPrefsStore'
import { useTranscriptFollowStore } from '@/stores/useTranscriptFollowStore'
import type { ContentBlock } from '@/api/types'

beforeEach(() => {
  useAgentStore.setState({ sessionId: 'session-1' })
})

afterEach(() => {
  cleanup()
  useAgentStore.setState({ sessionId: null, _pendingMessages: [] })
})

const BLOCKS: ContentBlock[] = [
  { id: 'u1', type: 'user', content: 'first prompt' },
  { id: 'a1', type: 'text', content: 'first answer' },
  { id: 'r1', type: 'user', content: 'a report', extra: { from_agent: 'explorer' } },
  { id: 'u2', type: 'user', content: 'second prompt\nwith a second line' },
  { id: 'a2', type: 'text', content: 'second answer' },
  { id: 'u3', type: 'user', content: 'third prompt' },
  { id: 'a3', type: 'text', content: 'third answer' },
]

/** Lays the transcript out: the scroller at the top, prompts at the given tops. */
function layOut(container: HTMLElement, tops: Record<string, number>) {
  const scroller = container.querySelector<HTMLElement>('.oa-chat-scroll')!
  scroller.getBoundingClientRect = () => ({ top: 0, bottom: 600, left: 0, right: 800, width: 800, height: 600, x: 0, y: 0, toJSON: () => ({}) })
  scroller.scrollTop = 1000
  const scrollTo = mock((..._args: unknown[]) => {})
  scroller.scrollTo = scrollTo as unknown as typeof scroller.scrollTo
  for (const el of container.querySelectorAll<HTMLElement>('[data-prompt-id]')) {
    const top = tops[el.dataset.promptId!]
    el.getBoundingClientRect = () => ({ top, bottom: top + 40, left: 0, right: 800, width: 800, height: 40, x: 0, y: top, toJSON: () => ({}) })
  }
  act(() => {
    fireEvent.scroll(scroller)
  })
  return scrollTo
}

function lastTop(scrollTo: ReturnType<typeof layOut>): number | undefined {
  return (scrollTo.mock.calls.at(-1)?.[0] as ScrollToOptions | undefined)?.top
}

/** Where a jump scrolls to so the prompt now at ``top`` lands on the margin. */
function landing(top: number): number {
  return 1000 + top - PROMPT_JUMP_MARGIN
}

describe('AgentView — prompt navigation', () => {
  it('marks only prompts the user wrote', () => {
    const { container } = render(<AgentView blocks={BLOCKS} currentBlocks={[]} isWorking={false} />)

    const ids = [...container.querySelectorAll<HTMLElement>('[data-prompt-id]')].map((el) => el.dataset.promptId)
    expect(ids).toEqual(['u1', 'u2', 'u3'])
  })

  it('pins no prompt bar over the transcript, even inside a turn', () => {
    const { container } = render(<AgentView blocks={BLOCKS} currentBlocks={[]} isWorking={false} />)

    layOut(container, { u1: -900, u2: -300, u3: 500 })

    expect(screen.queryByRole('navigation', { name: 'Prompts' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Previous prompt' })).toBeNull()
  })

  it('jumps to the previous prompt from the keyboard, stepping on during a smooth jump', () => {
    const { container } = render(<AgentView blocks={BLOCKS} currentBlocks={[]} isWorking={false} />)
    const scrollTo = layOut(container, { u1: -900, u2: -300, u3: 500 })

    fireEvent.keyDown(document, { key: 'ArrowUp', ctrlKey: true, altKey: true })
    expect(lastTop(scrollTo)).toBe(landing(-300))

    // A second press while the first jump is still scrolling steps on from it.
    fireEvent.keyDown(document, { key: 'ArrowUp', ctrlKey: true, altKey: true })
    expect(lastTop(scrollTo)).toBe(landing(-900))
  })

  it('jumps down to the next prompt from the keyboard', () => {
    const { container } = render(<AgentView blocks={BLOCKS} currentBlocks={[]} isWorking={false} />)
    const scrollTo = layOut(container, { u1: -900, u2: -300, u3: 500 })

    fireEvent.keyDown(document, { key: 'ArrowDown', ctrlKey: true, altKey: true })
    expect(lastTop(scrollTo)).toBe(landing(500))
  })

  it('brings a prompt into view by id, for the composer’s ↑/↓ recall, while mounted', () => {
    const { container, unmount } = render(<AgentView blocks={BLOCKS} currentBlocks={[]} isWorking={false} />)
    const scrollTo = layOut(container, { u1: -900, u2: -300, u3: 500 })

    act(() => useTranscriptFollowStore.getState().showPrompt?.('u1'))
    expect(lastTop(scrollTo)).toBe(landing(-900))

    unmount()
    expect(useTranscriptFollowStore.getState().showPrompt).toBeNull()
  })

  it('steps between prompts without a keyboard, for the mobile chat actions, while mounted', () => {
    const { container, unmount } = render(<AgentView blocks={BLOCKS} currentBlocks={[]} isWorking={false} />)
    const scrollTo = layOut(container, { u1: -900, u2: -300, u3: 500 })

    act(() => useTranscriptFollowStore.getState().jumpToPrompt?.(-1))
    expect(lastTop(scrollTo)).toBe(landing(-300))

    act(() => useTranscriptFollowStore.getState().jumpToPrompt?.(1))
    expect(lastTop(scrollTo)).toBe(landing(500))

    unmount()
    expect(useTranscriptFollowStore.getState().jumpToPrompt).toBeNull()
  })
})

/**
 * Previous past the oldest rendered prompt. Prompts sit at the tops in
 * ``TOPS`` (px below the scroller's top) whenever they are rendered, and any
 * prompt not listed sits far below the view.
 */
describe('AgentView — previous prompt that is not loaded yet', () => {
  let TOPS: Record<string, number> = {}
  const originalRect = HTMLElement.prototype.getBoundingClientRect
  const { loadOlderMessages, loadOlderUntilPrompt } = useAgentStore.getState()

  function rect(top: number, height: number): DOMRect {
    return { top, bottom: top + height, left: 0, right: 800, width: 800, height, x: 0, y: top, toJSON: () => ({}) } as DOMRect
  }

  beforeEach(() => {
    TOPS = {}
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      if (this.classList.contains('oa-chat-scroll')) return rect(0, 600)
      const id = this.dataset.promptId
      if (id === undefined) return rect(0, 0)
      return rect(TOPS[id] ?? 5_000, 40)
    }
  })

  afterEach(() => {
    HTMLElement.prototype.getBoundingClientRect = originalRect
    useAgentStore.setState({ hasMore: false, loadOlderMessages, loadOlderUntilPrompt })
  })

  const turn = (id: string): ContentBlock[] => [
    { id, type: 'user', content: `prompt ${id}` },
    { id: `${id}:a`, type: 'text', content: `answer ${id}` },
  ]

  function scroller(container: HTMLElement) {
    const el = container.querySelector<HTMLElement>('.oa-chat-scroll')!
    const scrollTo = mock((..._args: unknown[]) => {})
    el.scrollTo = scrollTo as unknown as typeof el.scrollTo
    // A transcript taller than its view, so the reader can scroll away from the end.
    Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => 20_000 })
    Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => 600 })
    return { el, scrollTo }
  }

  function pressPrevious() {
    fireEvent.keyDown(document, { key: 'ArrowUp', ctrlKey: true, altKey: true })
  }

  /** A scroll near the top, which on its own reveals or loads earlier turns. */
  function scrollNearTop(el: HTMLElement) {
    el.scrollTop = 100
    act(() => {
      fireEvent.scroll(el)
    })
  }

  it('reveals only the earlier turns down to the nearest prompt, then lands on it', () => {
    // 50 prompts are 100 turn items; the first 80 rendered leave p0–p9 hidden.
    const blocks = Array.from({ length: 50 }, (_, i) => turn(`p${i}`)).flat()
    TOPS = { p9: -300, p10: PROMPT_JUMP_MARGIN }
    const { container } = render(<AgentView blocks={blocks} currentBlocks={[]} isWorking={false} />)
    const { el, scrollTo } = scroller(container)
    expect(container.querySelector('[data-prompt-id="p9"]')).toBeNull()

    pressPrevious()

    expect(container.querySelector('[data-prompt-id="p9"]')).not.toBeNull()
    expect(container.querySelector('[data-prompt-id="p8"]')).toBeNull()
    expect(lastTop(scrollTo)).toBe(el.scrollTop - 300 - PROMPT_JUMP_MARGIN)
  })

  it('reveals a prompt shown by id down to it, then lands on it', () => {
    const blocks = Array.from({ length: 50 }, (_, i) => turn(`p${i}`)).flat()
    TOPS = { p3: -300, p10: PROMPT_JUMP_MARGIN }
    const { container } = render(<AgentView blocks={blocks} currentBlocks={[]} isWorking={false} />)
    const { el, scrollTo } = scroller(container)

    act(() => useTranscriptFollowStore.getState().showPrompt?.('p3'))

    expect(container.querySelector('[data-prompt-id="p3"]')).not.toBeNull()
    expect(container.querySelector('[data-prompt-id="p2"]')).toBeNull()
    expect(lastTop(scrollTo)).toBe(el.scrollTop - 300 - PROMPT_JUMP_MARGIN)
  })

  it('leaves the scroll-top reveal alone while the jump lands', () => {
    const blocks = Array.from({ length: 50 }, (_, i) => turn(`p${i}`)).flat()
    TOPS = { p9: -300, p10: PROMPT_JUMP_MARGIN }
    const { container } = render(<AgentView blocks={blocks} currentBlocks={[]} isWorking={false} />)
    const { el } = scroller(container)

    pressPrevious()
    scrollNearTop(el)

    // Revealing a whole step of turns mid-jump would move the view under it.
    expect(container.querySelector('[data-prompt-id="p8"]')).toBeNull()
  })

  it('loads earlier pages in one call, then lands on the newest prompt among them', async () => {
    TOPS = { u1: PROMPT_JUMP_MARGIN, older: -700 }
    const view = render(<AgentView blocks={BLOCKS} currentBlocks={[]} isWorking={false} />)
    const { el, scrollTo } = scroller(view.container)
    // The store walks pages until one holds a prompt: here a prompt-less page
    // (the rest of a long answer) and then the page with the prompt.
    const older: ContentBlock[] = [...turn('older'), { id: 'older:a2', type: 'text', content: 'the rest of a long answer' }]
    const loadOlderUntilPrompt = mock(async () => {
      view.rerender(<AgentView blocks={[...older, ...BLOCKS]} currentBlocks={[]} isWorking={false} />)
      useAgentStore.setState({ hasMore: false })
      return true
    })
    const loadOlderPage = mock(async () => {})
    useAgentStore.setState({ hasMore: true, loadOlderUntilPrompt, loadOlderMessages: loadOlderPage })

    await act(async () => { pressPrevious() })

    expect(loadOlderUntilPrompt).toHaveBeenCalledTimes(1)
    expect(loadOlderPage).not.toHaveBeenCalled()
    expect(lastTop(scrollTo)).toBe(el.scrollTop - 700 - PROMPT_JUMP_MARGIN)
  })

  it('reveals and lands on a prompt the page put outside the rendered turns', async () => {
    // 40 prompts are 80 turn items, all rendered; the page lands above them, hidden.
    const blocks = Array.from({ length: 40 }, (_, i) => turn(`q${i}`)).flat()
    TOPS = { q0: PROMPT_JUMP_MARGIN, older: -400 }
    const view = render(<AgentView blocks={blocks} currentBlocks={[]} isWorking={false} />)
    const { el, scrollTo } = scroller(view.container)
    const loadOlderUntilPrompt = mock(async () => {
      view.rerender(<AgentView blocks={[...turn('older'), ...blocks]} currentBlocks={[]} isWorking={false} />)
      return true
    })
    useAgentStore.setState({ hasMore: true, loadOlderUntilPrompt })

    await act(async () => { pressPrevious() })

    expect(view.container.querySelector('[data-prompt-id="older"]')).not.toBeNull()
    expect(lastTop(scrollTo)).toBe(el.scrollTop - 400 - PROMPT_JUMP_MARGIN)
  })

  it('gives up when no prompt arrives, rather than retrying', async () => {
    TOPS = { u1: PROMPT_JUMP_MARGIN }
    const { container } = render(<AgentView blocks={BLOCKS} currentBlocks={[]} isWorking={false} />)
    const { scrollTo } = scroller(container)
    const loadOlderUntilPrompt = mock(async () => false)
    useAgentStore.setState({ hasMore: true, loadOlderUntilPrompt })

    await act(async () => { pressPrevious() })
    await act(async () => {})

    expect(loadOlderUntilPrompt).toHaveBeenCalledTimes(1)
    expect(scrollTo).not.toHaveBeenCalled()
  })

  it('holds the view as the page lands, and drops the jump when the reader scrolls by hand', async () => {
    TOPS = { u1: PROMPT_JUMP_MARGIN, older: -400 }
    const view = render(<AgentView blocks={BLOCKS} currentBlocks={[]} isWorking={false} />)
    const { el, scrollTo } = scroller(view.container)
    let finish = () => {}
    const loadOlderUntilPrompt = mock(() => new Promise<boolean>((resolve) => {
      finish = () => {
        // The page pushes the first prompt 900px down.
        TOPS = { ...TOPS, u1: PROMPT_JUMP_MARGIN + 900 }
        view.rerender(<AgentView blocks={[...turn('older'), ...BLOCKS]} currentBlocks={[]} isWorking={false} />)
        resolve(true)
      }
    }))
    useAgentStore.setState({ hasMore: true, loadOlderUntilPrompt })
    el.scrollTop = 2_000

    act(() => pressPrevious())
    fireEvent.wheel(el, { deltaY: -120 })
    await act(async () => { finish() })

    expect(loadOlderUntilPrompt).toHaveBeenCalledTimes(1)
    expect(el.scrollTop).toBe(2_900)
    expect(scrollTo).not.toHaveBeenCalled()
  })

  it('leaves the scroll-top load alone while the page loads', async () => {
    TOPS = { u1: PROMPT_JUMP_MARGIN }
    const { container } = render(<AgentView blocks={BLOCKS} currentBlocks={[]} isWorking={false} />)
    const { el } = scroller(container)
    const loadOlderUntilPrompt = mock(() => new Promise<boolean>(() => {}))
    const loadOlderPage = mock(async () => {})
    useAgentStore.setState({ hasMore: true, loadOlderUntilPrompt, loadOlderMessages: loadOlderPage })

    act(() => pressPrevious())
    scrollNearTop(el)

    expect(loadOlderPage).not.toHaveBeenCalled()
  })
})

/** A reload shows the newest page only; one long run can fill it with no prompt. */
describe('AgentView — a loaded page holding no prompt', () => {
  const { loadOlderUntilPrompt } = useAgentStore.getState()
  const RUN: ContentBlock[] = [
    { id: 'run:t1', type: 'thinking', content: 'thinking' },
    { id: 'run:a1', type: 'text', content: 'still working' },
  ]

  beforeEach(() => {
    useDisplayPrefsStore.setState({ transcriptStyle: 'reader' })
  })

  afterEach(() => {
    useAgentStore.setState({ hasMore: false, loadOlderUntilPrompt })
    useDisplayPrefsStore.setState({ transcriptStyle: 'detailed' })
  })

  it('loads back to the nearest prompt once, without a scroll', async () => {
    const loadOlder = mock(async () => true)
    useAgentStore.setState({ hasMore: true, loadOlderUntilPrompt: loadOlder })

    const view = render(<AgentView blocks={RUN} currentBlocks={[]} isWorking={false} />)
    await act(async () => {})
    view.rerender(<AgentView blocks={[...RUN, { id: 'run:a2', type: 'text', content: 'more' }]} currentBlocks={[]} isWorking={false} />)
    await act(async () => {})

    expect(loadOlder).toHaveBeenCalledTimes(1)
  })

  it('seeks only a few pages, not the manual jump budget', async () => {
    const loadOlder = mock(async (..._args: unknown[]) => true)
    useAgentStore.setState({ hasMore: true, loadOlderUntilPrompt: loadOlder })

    render(<AgentView blocks={RUN} currentBlocks={[]} isWorking={false} />)
    await act(async () => {})

    expect(loadOlder).toHaveBeenCalledTimes(1)
    const pages = loadOlder.mock.calls[0]?.[0] as number | undefined
    expect(pages).toBeDefined()
    expect(pages!).toBeLessThanOrEqual(3)
  })

  it('leaves history alone in the detailed transcript, which scrolls to load', async () => {
    useDisplayPrefsStore.setState({ transcriptStyle: 'detailed' })
    const loadOlder = mock(async () => true)
    useAgentStore.setState({ hasMore: true, loadOlderUntilPrompt: loadOlder })

    render(<AgentView blocks={RUN} currentBlocks={[]} isWorking={false} />)
    await act(async () => {})

    expect(loadOlder).not.toHaveBeenCalled()
  })

  it('leaves history alone when a prompt is already loaded', async () => {
    const loadOlder = mock(async () => true)
    useAgentStore.setState({ hasMore: true, loadOlderUntilPrompt: loadOlder })

    render(<AgentView blocks={BLOCKS} currentBlocks={[]} isWorking={false} />)
    await act(async () => {})

    expect(loadOlder).not.toHaveBeenCalled()
  })

  it('leaves history alone when there is none older', async () => {
    const loadOlder = mock(async () => true)
    useAgentStore.setState({ hasMore: false, loadOlderUntilPrompt: loadOlder })

    render(<AgentView blocks={RUN} currentBlocks={[]} isWorking={false} />)
    await act(async () => {})

    expect(loadOlder).not.toHaveBeenCalled()
  })

  it('leaves history alone when the server pinned the prompt', async () => {
    const loadOlder = mock(async () => true)
    useAgentStore.setState({ hasMore: true, loadOlderUntilPrompt: loadOlder, pinnedPrompt: { id: 'p1', type: 'user', content: 'keep going' } })

    render(<AgentView blocks={RUN} currentBlocks={[]} isWorking={false} />)
    await act(async () => {})

    expect(loadOlder).not.toHaveBeenCalled()
    useAgentStore.setState({ pinnedPrompt: null })
  })
})

/** A run longer than the first page loads its newest rows; its prompt is pinned above them. */
describe('AgentView — a pinned prompt', () => {
  const RUN: ContentBlock[] = [
    { id: 'run:t1', type: 'thinking', content: 'thinking' },
    { id: 'run:a1', type: 'text', content: 'still working' },
  ]
  const startedAt = Date.now() - (2 * 60 + 16) * 60_000
  const PINNED: ContentBlock = { id: 'p1', type: 'user', content: 'keep going', timestamp: new Date(startedAt) }

  beforeEach(() => {
    useAgentStore.setState({ hasMore: true, pinnedPrompt: PINNED })
  })

  afterEach(() => {
    useAgentStore.setState({ hasMore: false, pinnedPrompt: null, _leadRevertTime: null })
    useDisplayPrefsStore.setState({ transcriptStyle: 'detailed' })
  })

  it('shows the prompt above the loaded run, with a plain line and no button', () => {
    const { container } = render(<AgentView blocks={RUN} currentBlocks={[]} isWorking={false} />)

    const pinned = container.querySelector<HTMLElement>('[data-pinned-prompt]')
    expect(pinned?.textContent).toContain('keep going')
    expect(pinned?.dataset.promptId).toBe('p1')
    // Not a loaded row: a view hold must anchor on those.
    expect(pinned?.querySelector('[data-block-id]') ?? pinned?.dataset.blockId).toBeUndefined()
    const gap = container.querySelector('[data-history-gap]')
    expect(gap?.getAttribute('aria-hidden')).toBe('true')
    expect(gap?.compareDocumentPosition(container.querySelector('[data-block-id="run:a1"]')!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    expect(screen.queryAllByRole('button').filter((b) => /earlier/i.test(b.textContent ?? ''))).toEqual([])
  })

  it('times the running turn from it in the reader view', () => {
    useDisplayPrefsStore.setState({ transcriptStyle: 'reader' })
    const { container } = render(<AgentView blocks={RUN} currentBlocks={[]} isWorking={true} />)

    expect(container.querySelector('[data-pinned-prompt]')?.textContent).toContain('keep going')
    expect(screen.getByText(/· 2h 16m/)).toBeTruthy()
  })

  it('is a prompt for ⌥⌘↑', () => {
    const { container } = render(<AgentView blocks={RUN} currentBlocks={[]} isWorking={false} />)
    const scrollTo = layOut(container, { p1: -900 })

    fireEvent.keyDown(document, { key: 'ArrowUp', ctrlKey: true, altKey: true })

    expect(lastTop(scrollTo)).toBe(landing(-900))
  })

  it('goes once an undo takes the prompt back', () => {
    useAgentStore.setState({ _leadRevertTime: startedAt })
    const { container } = render(<AgentView blocks={RUN} currentBlocks={[]} isWorking={false} />)

    expect(container.querySelector('[data-pinned-prompt]')).toBeNull()
    expect(container.querySelector('[data-history-gap]')).toBeNull()
  })
})
