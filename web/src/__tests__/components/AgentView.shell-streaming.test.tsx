import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, render } from '@testing-library/react'
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
})
