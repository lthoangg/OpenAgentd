/**
 * A suspended agent must not look finished.
 *
 * ``waiting_input`` is neither working nor idle. Falling through to the idle
 * branch would paint the same dot as a completed turn, telling the user nothing
 * is expected of them while the agent sits stopped on a question.
 */
import { describe, it, expect, afterEach, mock } from 'bun:test'
import '@testing-library/jest-dom'
import { render, screen, cleanup } from '@testing-library/react'

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))

import { AgentPane } from '@/components/AgentPane'
import type { AgentStream } from '@/stores/useAgentStore'

afterEach(cleanup)

function makeStream(overrides: Partial<AgentStream> = {}): AgentStream {
  return {
    blocks: [],
    currentBlocks: [],
    currentText: '',
    currentThinking: '',
    status: 'idle',
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0 },
    model: null,
    lastError: null,
    ...overrides,
  }
}

describe('AgentPane — waiting on the user', () => {
  it('labels the status dot as waiting for input', () => {
    render(<AgentPane name="openagentd" stream={makeStream({ status: 'waiting_input' })} isLead />)

    expect(screen.getByLabelText(/waiting for your input/i)).toBeInTheDocument()
  })

  it('does not reuse the idle dot for a suspended agent', () => {
    const { container: waiting } = render(
      <AgentPane name="openagentd" stream={makeStream({ status: 'waiting_input' })} isLead />,
    )
    const waitingDot = waiting.querySelector('[aria-label]')?.className ?? ''
    cleanup()

    const { container: idle } = render(
      <AgentPane name="openagentd" stream={makeStream({ status: 'idle' })} isLead />,
    )
    const idleDot = idle.querySelector('[aria-label]')?.className ?? ''

    expect(waitingDot).not.toBe(idleDot)
  })
})
