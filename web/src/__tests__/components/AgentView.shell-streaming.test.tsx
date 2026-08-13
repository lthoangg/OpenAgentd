import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, render } from '@testing-library/react'
import type { ContentBlock } from '@/api/types'
import { AgentView } from '@/components/AgentView'

let userBubbleRenderCount = 0

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))
mock.module('@/components/AgentView/UserBubble', () => ({
  UserBubble: () => {
    userBubbleRenderCount += 1
    return <div data-testid="user-bubble" />
  },
}))

function shellBlock(output: string): ContentBlock {
  return {
    id: 'shell-1',
    type: 'tool',
    content: '',
    toolName: 'shell',
    toolArgs: '{"command":"bun test"}',
    toolCallId: 'call-1',
    toolDone: false,
    toolOutput: output,
  }
}

describe('AgentView shell streaming', () => {
  beforeEach(() => {
    userBubbleRenderCount = 0
  })

  afterEach(cleanup)

  it('does not rerender historical user blocks for live shell output updates', () => {
    const history: ContentBlock[] = [
      { id: 'user-1', type: 'user', content: 'Run the tests' },
    ]
    const view = render(
      <AgentView blocks={history} currentBlocks={[shellBlock('first\n')]} isWorking />,
    )

    expect(userBubbleRenderCount).toBe(1)

    view.rerender(
      <AgentView blocks={history} currentBlocks={[shellBlock('first\nsecond\n')]} isWorking />,
    )

    expect(userBubbleRenderCount).toBe(1)
  })

  /**
   * Counterpart to the guard below: gating `isStreaming` on `isLast` must not
   * switch the typewriter off for the block that is genuinely receiving text.
   * `isLast` is derived from `totalBlocks`, which is `mergeBlocks(...).length`
   * — if that ever disagreed with the turn's own indices, nothing would
   * animate at all and the regression would be invisible to the unit tests.
   */
  it('still animates the block that is currently receiving text', () => {
    const pending: FrameRequestCallback[] = []
    const realRaf = globalThis.requestAnimationFrame
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      pending.push(cb)
      return pending.length
    }) as typeof requestAnimationFrame

    const runFrames = (n: number) => {
      for (let i = 0; i < n; i++) {
        const batch = pending.splice(0, pending.length)
        act(() => { for (const cb of batch) cb(performance.now()) })
      }
    }

    try {
      const history: ContentBlock[] = [{ id: 'user-1', type: 'user', content: 'Explain' }]
      const text = (content: string): ContentBlock => ({ id: 'text-1', type: 'text', content })

      const view = render(
        <AgentView blocks={history} currentBlocks={[text('Hello')]} isWorking />,
      )
      runFrames(5)

      const long = 'Hello, and here is a considerably longer assistant answer.'
      act(() => {
        view.rerender(<AgentView blocks={history} currentBlocks={[text(long)]} isWorking />)
      })

      // A loop must be armed for the live block…
      expect(pending.length).toBeGreaterThan(0)

      // …and one frame must reveal only part of the new text.
      runFrames(1)
      const partial = view.container.textContent ?? ''
      expect(partial).toContain('Hello')
      expect(partial).not.toContain('considerably longer assistant answer')

      // …converging on the full text.
      runFrames(60)
      expect(view.container.textContent).toContain('considerably longer assistant answer')
    } finally {
      globalThis.requestAnimationFrame = realRaf
    }
  })

  /**
   * End-to-end guard for the two halves of the fix: a live turn used to flag
   * every one of its blocks as streaming, and `useSmoothStream` re-armed its
   * rAF loop forever while that flag was set. A `pytest` / `bun test` call
   * kept those loops running for the entire command — minutes of animation
   * frames over a transcript that had stopped changing, which held WebKit's
   * rendering pipeline awake the whole time.
   */
  it('leaves no animation-frame loop running while a shell tool streams', () => {
    const pending: FrameRequestCallback[] = []
    const realRaf = globalThis.requestAnimationFrame
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      pending.push(cb)
      return pending.length
    }) as typeof requestAnimationFrame

    try {
      const history: ContentBlock[] = [{ id: 'user-1', type: 'user', content: 'Run the tests' }]
      const thinking: ContentBlock = { id: 'think-1', type: 'thinking', content: 'Plan: run the suite.' }
      const text: ContentBlock = { id: 'text-1', type: 'text', content: 'Running the test suite now.' }

      render(
        <AgentView
          blocks={history}
          currentBlocks={[thinking, text, shellBlock('PASS a.test.ts\n')]}
          isWorking
        />,
      )

      // Drain whatever mount scheduled; a settled transcript must then be
      // asking for no further frames.
      for (let i = 0; i < 5; i++) {
        const batch = pending.splice(0, pending.length)
        for (const cb of batch) cb(performance.now())
      }

      expect(pending.length).toBe(0)
    } finally {
      globalThis.requestAnimationFrame = realRaf
    }
  })
})
