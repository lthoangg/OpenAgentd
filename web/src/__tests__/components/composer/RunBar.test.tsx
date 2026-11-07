/**
 * The phone's run bar above the composer: what step the agent is on and for
 * how long (mockup J4 4.1). Only while the lead agent is working.
 */
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, render, screen } from '@testing-library/react'

mock.module('@/hooks/use-is-phone', () => ({ useIsPhone: () => true }))

import { RunBar, runBarLabel } from '@/components/composer/RunBar'
import { useAgentStore } from '@/stores/useAgentStore'

afterEach(() => {
  cleanup()
  useAgentStore.setState({ leadName: null, agentStreams: {}, isAgentWorking: false })
})

describe('runBarLabel', () => {
  it('counts the steps and the time as m:ss', () => {
    expect(runBarLabel(0, 4_000)).toBe('Running · 0:04')
    expect(runBarLabel(7, 192_000)).toBe('Running · step 7 · 3:12')
  })
})

describe('RunBar', () => {
  const stream = (status: string, tools: number) => ({
    blocks: [],
    currentBlocks: Array.from({ length: tools }, (_, i) => ({ id: `t${i}`, type: 'tool', content: '' })),
    currentText: '',
    currentThinking: '',
    status,
    usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0 },
    _turnStartedAt: Date.now() - 65_000,
  })

  it('shows the step and elapsed time while working', () => {
    useAgentStore.setState({ leadName: 'lead', isAgentWorking: true, agentStreams: { lead: stream('working', 3) as never } })
    render(<RunBar />)
    expect(screen.getByText(/^Running · step 3 · 1:0\d$/)).toBeTruthy()
  })

  it('is gone when the agent is not working', () => {
    useAgentStore.setState({ leadName: 'lead', isAgentWorking: true, agentStreams: { lead: stream('working', 1) as never } })
    const { container } = render(<RunBar />)
    act(() => { useAgentStore.setState({ isAgentWorking: false, agentStreams: { lead: stream('idle', 1) as never } }) })
    expect(container.textContent).toBe('')
  })
})
