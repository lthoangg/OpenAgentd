import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, render, waitFor } from '@testing-library/react'

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))

import { AgentView } from '@/components/AgentView'
import { useAgentStore } from '@/stores/useAgentStore'
import type { ContentBlock } from '@/api/types'

// happy-dom has no layout; give the transcript scroller more content than view.
const original = {
  scrollHeight: Object.getOwnPropertyDescriptor(Element.prototype, 'scrollHeight'),
  clientHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight'),
}

beforeEach(() => {
  useAgentStore.setState({ sessionId: 'session-1' })
  Object.defineProperty(Element.prototype, 'scrollHeight', {
    configurable: true,
    get(this: Element) { return this.classList.contains('oa-chat-scroll') ? 2000 : 0 },
  })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get(this: HTMLElement) { return this.classList.contains('oa-chat-scroll') ? 500 : 0 },
  })
})

afterEach(() => {
  cleanup()
  useAgentStore.setState({ sessionId: null, _pendingMessages: [] })
  if (original.scrollHeight) Object.defineProperty(Element.prototype, 'scrollHeight', original.scrollHeight)
  if (original.clientHeight) Object.defineProperty(HTMLElement.prototype, 'clientHeight', original.clientHeight)
})

const BLOCKS: ContentBlock[] = [
  { id: 'u1', type: 'user', content: 'first prompt' },
  { id: 'a1', type: 'text', content: 'first answer' },
  { id: 'r1', type: 'user', content: 'a report', extra: { from_agent: 'explorer' } },
  { id: 'u2', type: 'user', content: 'second prompt' },
  { id: 'a2', type: 'text', content: 'second answer' },
]

function markKinds(container: HTMLElement): string[] {
  return [...container.querySelectorAll<HTMLElement>('[data-scrubber-mark]')].map((el) => el.dataset.scrubberMark!)
}

describe('AgentView — timeline scrubber', () => {
  it('marks each prompt the user wrote', async () => {
    const { container } = render(<AgentView blocks={BLOCKS} currentBlocks={[]} isWorking={false} />)

    // The rail is its own chunk, so it arrives just after the transcript.
    await waitFor(() => expect(markKinds(container)).toEqual(['prompt', 'prompt']))
  })
})
