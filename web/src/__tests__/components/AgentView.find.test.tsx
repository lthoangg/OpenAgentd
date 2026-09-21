import { describe, it, expect, afterEach, mock } from 'bun:test'
import { render, cleanup } from '@testing-library/react'
import '@testing-library/jest-dom'

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))

import { AgentView } from '@/components/AgentView'
import { useAgentStore } from '@/stores/useAgentStore'
import type { ContentBlock } from '@/api/types'

afterEach(() => {
  cleanup()
  useAgentStore.setState({ sessionId: null, _pendingMessages: [] })
})

const BLOCKS: ContentBlock[] = [
  { id: 'u1', type: 'user', content: 'Hello world' },
  { id: 'th1', type: 'thinking', content: 'Consider the world model' },
  { id: 'tool1', type: 'tool', content: '', toolName: 'read', toolArgs: 'world.txt', toolResult: 'world.bin' },
  { id: 'a1', type: 'text', content: 'A smaller world' },
]

describe('AgentView — transcript find', () => {
  it('highlights exact matches in user, thinking, and assistant text without a block ring', () => {
    const { container } = render(
      <AgentView
        blocks={BLOCKS}
        currentBlocks={[]}
        isWorking={false}
        findOpen
        findQuery="world"
        findActiveIndex={0}
      />,
    )

    const marks = [...container.querySelectorAll('mark[data-transcript-find]')]
    expect(marks.map((mark) => mark.textContent)).toEqual(['world', 'world', 'world'])
    expect(container.querySelector('[class*="ring-1"]')).toBeNull()
    expect(marks.some((mark) => mark.closest('[data-find-block="tool1"]'))).toBe(false)
  })
})
