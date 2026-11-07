/**
 * On desktop the run's status sits in the run deck beside Stop (desktop
 * mockup 5.1): the step, the time, and the Esc that stops it. It takes the
 * deck's empty middle, so the composer never moves for it.
 */
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, render, screen } from '@testing-library/react'

let isPhone = false
mock.module('@/hooks/use-is-phone', () => ({ useIsPhone: () => isPhone }))

import { DeckRunStatus, RunBar } from '@/components/composer/RunBar'
import { useAgentStore } from '@/stores/useAgentStore'

afterEach(() => {
  cleanup()
  isPhone = false
  useAgentStore.setState({ leadName: null, agentStreams: {}, isAgentWorking: false })
})

const stream = (status: string, tools: number) => ({
  blocks: [],
  currentBlocks: Array.from({ length: tools }, (_, i) => ({ id: `t${i}`, type: 'tool', content: '' })),
  currentText: '',
  currentThinking: '',
  status,
  usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0 },
  _turnStartedAt: Date.now() - 125_000,
})

describe('DeckRunStatus', () => {
  it('shows the step, the time and the Esc that stops it while working', () => {
    useAgentStore.setState({ leadName: 'lead', isAgentWorking: true, agentStreams: { lead: stream('working', 7) as never } })
    render(<DeckRunStatus />)
    expect(screen.getByText(/^Running · step 7 · 2:0\d$/)).toBeTruthy()
    expect(screen.getByText('Esc')).toBeTruthy()
  })

  it('is gone once the agent stops working', () => {
    useAgentStore.setState({ leadName: 'lead', isAgentWorking: true, agentStreams: { lead: stream('working', 1) as never } })
    const { container } = render(<DeckRunStatus />)
    act(() => { useAgentStore.setState({ isAgentWorking: false, agentStreams: { lead: stream('idle', 1) as never } }) })
    expect(container.textContent).toBe('')
  })

  it('leaves a phone to its status line', () => {
    isPhone = true
    useAgentStore.setState({ leadName: 'lead', isAgentWorking: true, agentStreams: { lead: stream('working', 1) as never } })
    const { container } = render(<DeckRunStatus />)
    expect(container.textContent).toBe('')
  })

  it('keeps the phone status line off desktop', () => {
    useAgentStore.setState({ leadName: 'lead', isAgentWorking: true, agentStreams: { lead: stream('working', 1) as never } })
    const { container } = render(<RunBar />)
    expect(container.textContent).toBe('')
  })
})
