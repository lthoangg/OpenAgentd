/**
 * AgentView — publishing the follow state for the composer's jump chip.
 *
 * With a floating composer the jump-to-latest control rides on the composer,
 * so the transcript reports whether it has left the live end, and how many
 * blocks arrived since, instead of drawing its own button.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, render } from '@testing-library/react'

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))

import { AgentView } from '@/components/AgentView'
import { useAgentStore } from '@/stores/useAgentStore'
import { useDisplayPrefsStore } from '@/stores/useDisplayPrefsStore'
import { useTranscriptFollowStore } from '@/stores/useTranscriptFollowStore'
import type { ContentBlock } from '@/api/types'

const text = (id: string, content = id): ContentBlock => ({ id, type: 'text', content })
const prompt = (id: string): ContentBlock => ({ id, type: 'user', content: id })

beforeEach(() => useTranscriptFollowStore.setState({ unseen: null, jumpToLatest: null }))
afterEach(() => {
  cleanup()
  act(() => useAgentStore.setState({ sessionId: null }))
  act(() => useDisplayPrefsStore.setState({ transcriptStyle: 'detailed' }))
})

async function waitFrame() {
  await act(async () => {
    await new Promise((r) => requestAnimationFrame(() => r(undefined)))
  })
}

/** Scroll ``distFromBottom`` px above the end, starting from the bottom. */
async function scrollUp(el: HTMLDivElement, distFromBottom: number) {
  Object.defineProperty(el, 'scrollHeight', { value: 1000, configurable: true, writable: true })
  Object.defineProperty(el, 'clientHeight', { value: 500, configurable: true, writable: true })
  Object.defineProperty(el, 'scrollTop', { value: 500, configurable: true, writable: true })
  await act(async () => { el.dispatchEvent(new Event('scroll', { bubbles: true })) })
  await waitFrame()
  Object.defineProperty(el, 'scrollTop', { value: 500 - distFromBottom, configurable: true, writable: true })
  await act(async () => { el.dispatchEvent(new Event('scroll', { bubbles: true })) })
  await waitFrame()
}

function renderView(blocks: ContentBlock[], currentBlocks: ContentBlock[] = []) {
  const view = render(<AgentView blocks={blocks} currentBlocks={currentBlocks} isWorking jumpToLatestInComposer />)
  const scroller = view.container.querySelector('.oa-chat-scroll') as HTMLDivElement
  return {
    ...view,
    scroller,
    update: (nextBlocks: ContentBlock[], nextCurrent: ContentBlock[] = []) =>
      view.rerender(<AgentView blocks={nextBlocks} currentBlocks={nextCurrent} isWorking jumpToLatestInComposer />),
  }
}

describe('AgentView — jump chip in the composer', () => {
  it('draws no button of its own and reports following while at the end', () => {
    const { container } = renderView([prompt('p'), text('a')])

    expect(container.querySelector('button[aria-label^="Jump to latest"]')).toBeNull()
    expect(useTranscriptFollowStore.getState().unseen).toBeNull()
    expect(useTranscriptFollowStore.getState().jumpToLatest).not.toBeNull()
  })

  it('counts the blocks that arrive after the reader scrolls away', async () => {
    const { scroller, update, container } = renderView([prompt('p'), text('a')])
    await scrollUp(scroller, 200)
    expect(useTranscriptFollowStore.getState().unseen).toBe(0)

    update([prompt('p'), text('a')], [text('b'), text('c')])
    expect(useTranscriptFollowStore.getState().unseen).toBe(2)
    expect(container.querySelector('button[aria-label^="Jump to latest"]')).toBeNull()
  })

  it('does not count earlier messages loaded above', async () => {
    const { scroller, update } = renderView([prompt('p'), text('a')])
    await scrollUp(scroller, 200)

    update([prompt('old'), text('older'), prompt('p'), text('a')])
    expect(useTranscriptFollowStore.getState().unseen).toBe(0)
  })

  it('does not count blocks in reader mode, only offers the bare jump', async () => {
    act(() => useDisplayPrefsStore.setState({ transcriptStyle: 'reader' }))
    const { scroller, update } = renderView([prompt('p'), text('a')])
    await scrollUp(scroller, 200)
    expect(useTranscriptFollowStore.getState().unseen).toBe(0)

    update([prompt('p'), text('a')], [text('b'), text('c')])
    expect(useTranscriptFollowStore.getState().unseen).toBe(0)
  })

  it('labels the inline chip plain "Jump to latest" in reader mode', async () => {
    act(() => useDisplayPrefsStore.setState({ transcriptStyle: 'reader' }))
    const view = render(<AgentView blocks={[prompt('p'), text('a')]} currentBlocks={[]} isWorking />)
    await scrollUp(view.container.querySelector('.oa-chat-scroll') as HTMLDivElement, 200)
    view.rerender(<AgentView blocks={[prompt('p'), text('a')]} currentBlocks={[text('b'), text('c')]} isWorking />)

    const chip = view.container.querySelector('button[aria-label^="Jump to latest"]') as HTMLButtonElement
    expect(chip.getAttribute('aria-label')).toBe('Jump to latest')
  })

  it('counts afresh when switching from reader back to detailed while scrolled away', async () => {
    act(() => useDisplayPrefsStore.setState({ transcriptStyle: 'reader' }))
    const { scroller, update } = renderView([prompt('p'), text('a')])
    await scrollUp(scroller, 200)
    update([prompt('p'), text('a')], [text('b'), text('c')])

    await act(async () => { useDisplayPrefsStore.setState({ transcriptStyle: 'detailed' }) })
    expect(useTranscriptFollowStore.getState().unseen).toBe(0)
    update([prompt('p'), text('a')], [text('b'), text('c'), text('d')])
    expect(useTranscriptFollowStore.getState().unseen).toBe(1)
  })

  it('jumps back to the end and follows again', async () => {
    const { scroller } = renderView([prompt('p'), text('a')])
    await scrollUp(scroller, 200)

    await act(async () => { useTranscriptFollowStore.getState().jumpToLatest?.() })
    expect(useTranscriptFollowStore.getState().unseen).toBeNull()
  })

  it('withdraws its handler when it unmounts', () => {
    const { unmount } = renderView([text('a')])
    unmount()
    expect(useTranscriptFollowStore.getState().jumpToLatest).toBeNull()
  })
})
