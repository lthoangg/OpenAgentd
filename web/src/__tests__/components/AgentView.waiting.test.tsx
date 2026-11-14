/**
 * Where the "Waiting for N sessions" line sits in a transcript: under the
 * last answer once its turn has closed, in a main session only.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render } from '@testing-library/react'

import type { ContentBlock } from '@/api/types'
import { AgentView } from '@/components/AgentView'
import { queryKeys } from '@/queries'
import { useAgentStore } from '@/stores/useAgentStore'

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))

const BLOCKS: ContentBlock[] = [
  { id: 'u1', type: 'user', content: 'Split the work.' },
  { id: 'a1', type: 'text', content: 'I started two subagents.' },
]

function renderView(props: Partial<React.ComponentProps<typeof AgentView>> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.session.waiting('s1'), {
    items: [{ kind: 'subagent', session_id: 'c1', title: 'Port the tests', label: 'worker#1', workspace: '', state: 'working' }],
  })
  return render(
    <QueryClientProvider client={client}>
      <AgentView blocks={BLOCKS} currentBlocks={[]} isWorking={false} {...props} />
    </QueryClientProvider>,
  )
}

const line = () => document.querySelector('[data-waiting-for]')

beforeEach(() => {
  useAgentStore.setState({ sessionId: 's1', parentSessionId: null, isLoadingHistory: false })
})

afterEach(cleanup)

describe('AgentView: what a finished answer waits for', () => {
  it('shows the line under the last answer once its turn has closed', () => {
    renderView()
    expect(line()?.textContent).toBe('Waiting for 1 session')
    // After the footer's own row, inside the same turn.
    const copy = document.querySelector('[aria-label="Copy response"]')
    expect(copy && line() && copy.compareDocumentPosition(line()!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('hides it while the turn is still open', () => {
    renderView({ isWorking: true })
    expect(line()).toBeNull()
  })

  it("leaves it out of a subagent's own session", () => {
    useAgentStore.setState({ parentSessionId: 'lead-1' })
    renderView()
    expect(line()).toBeNull()
  })

  it('keeps it when the transcript ends on a report instead of an answer', () => {
    const report: ContentBlock = { id: 'u2', type: 'user', content: 'Build finished.', extra: { from_agent: 'worker#1' } }
    renderView({ blocks: [...BLOCKS, report] })
    expect(line()?.textContent).toBe('Waiting for 1 session')
  })
})
