/**
 * Scroll memory per session.
 *
 * Leaving a session scrolled up and coming back restores where you were;
 * a session left at the bottom keeps following.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { act, cleanup, render } from '@testing-library/react'
import { AgentView } from '@/components/AgentView'
import { useAgentStore } from '@/stores/useAgentStore'
import { _resetScrollMemoryForTests } from '@/hooks/useAutoFollowScroll'
import type { ContentBlock } from '@/api/types'

beforeEach(() => {
  _resetScrollMemoryForTests()
})
afterEach(() => {
  cleanup()
  act(() => {
    useAgentStore.setState({ sessionId: null })
  })
})

function text(id: string, content = 'Hello'): ContentBlock {
  return { id, type: 'text', content }
}

const frame = () => act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(null))) })

const scroller = (container: HTMLElement) => container.querySelector('.oa-chat-scroll') as HTMLDivElement

describe('scroll memory', () => {
  const blocksFor = (prefix: string) => Array.from({ length: 10 }, (_, i) => text(`${prefix}${i}`, `${prefix} block ${i}`))
  let restoreRect: (() => void) | null = null

  /** Blocks are 100 px tall, stacked; the scroller's viewport starts at 0. */
  function layOut(root: HTMLDivElement) {
    Object.defineProperty(root, 'scrollHeight', { value: 1000, configurable: true, writable: true })
    Object.defineProperty(root, 'clientHeight', { value: 500, configurable: true, writable: true })
    Object.defineProperty(root, 'scrollTop', { value: 500, configurable: true, writable: true })
    const original = HTMLElement.prototype.getBoundingClientRect
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      const id = this.dataset.blockId
      if (id) {
        const top = Number(id.slice(1)) * 100 - root.scrollTop
        return { top, bottom: top + 100, left: 0, right: 800, width: 800, height: 100, x: 0, y: top, toJSON: () => ({}) }
      }
      if (this === root) return { top: 0, bottom: 500, left: 0, right: 800, width: 800, height: 500, x: 0, y: 0, toJSON: () => ({}) }
      return original.call(this)
    }
    restoreRect = () => { HTMLElement.prototype.getBoundingClientRect = original }
  }
  afterEach(() => {
    restoreRect?.()
    restoreRect = null
  })

  async function scrollTo(root: HTMLDivElement, top: number) {
    root.scrollTop = top
    await act(async () => { root.dispatchEvent(new Event('scroll')) })
    await frame()
  }

  async function show(rerender: (ui: React.ReactElement) => void, session: string, prefix: string) {
    await act(async () => {
      useAgentStore.setState({ sessionId: session })
      rerender(<AgentView blocks={blocksFor(prefix)} currentBlocks={[]} isWorking={false} />)
    })
    await frame()
  }

  it('puts a session left scrolled up back where it was', async () => {
    act(() => useAgentStore.setState({ sessionId: 'a' }))
    const { container, rerender } = render(<AgentView blocks={blocksFor('a')} currentBlocks={[]} isWorking={false} />)
    const root = scroller(container)
    layOut(root)
    await scrollTo(root, 500)
    // Up to 250: block a2 is the first in view, 50 px above the top.
    await scrollTo(root, 250)
    expect(container.querySelector('button[aria-label^="Jump to latest"]')).toBeTruthy()

    await show(rerender, 'b', 'b')
    expect(root.scrollTop).toBe(500)

    await show(rerender, 'a', 'a')
    expect(root.scrollTop).toBe(250)
    expect(container.querySelector('button[aria-label^="Jump to latest"]')).toBeTruthy()
  })

  it('keeps following a session left at the bottom', async () => {
    act(() => useAgentStore.setState({ sessionId: 'a' }))
    const { container, rerender } = render(<AgentView blocks={blocksFor('a')} currentBlocks={[]} isWorking={false} />)
    const root = scroller(container)
    layOut(root)
    await scrollTo(root, 500)
    await scrollTo(root, 250)
    // Back down to the end before leaving.
    await scrollTo(root, 500)

    await show(rerender, 'b', 'b')
    root.scrollTop = 0
    await show(rerender, 'a', 'a')
    expect(root.scrollTop).toBe(500)
    expect(container.querySelector('button[aria-label^="Jump to latest"]')).toBeNull()
  })
})
