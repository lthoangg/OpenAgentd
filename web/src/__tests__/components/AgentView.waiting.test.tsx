/**
 * Where the "Waiting for N sessions" line sits in a transcript: under the
 * last answer, while its turn runs and after it closes, in a main session
 * only, and as one element throughout.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'

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
  const view = (extra: Partial<React.ComponentProps<typeof AgentView>>) => (
    <QueryClientProvider client={client}>
      <AgentView blocks={BLOCKS} currentBlocks={[]} isWorking={false} {...props} {...extra} />
    </QueryClientProvider>
  )
  const result = render(view({}))
  return { ...result, client, rerenderWith: (extra: Partial<React.ComponentProps<typeof AgentView>>) => result.rerender(view(extra)) }
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

  it('shows it while the turn is still running', () => {
    renderView({ isWorking: true })
    expect(line()?.textContent).toBe('Waiting for 1 session')
    // No footer yet: the turn has not closed.
    expect(document.querySelector('[aria-label="Copy response"]')).toBeNull()
  })

  it('keeps the same line, open, when the turn closes', () => {
    const { rerenderWith } = renderView({ isWorking: true })
    const before = line()
    fireEvent.click(before!.querySelector('button')!)
    rerenderWith({ isWorking: false })
    expect(document.querySelectorAll('[data-waiting-for]').length).toBe(1)
    expect(line()).toBe(before)
    expect(line()?.querySelector('button')?.getAttribute('aria-expanded')).toBe('true')
    // The footer arrived above it.
    const copy = document.querySelector('[aria-label="Copy response"]')
    expect(copy && copy.compareDocumentPosition(line()!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('updates the count mid-run as subagents start and finish', async () => {
    const { client } = renderView({ isWorking: true })
    act(() => client.setQueryData(queryKeys.session.waiting('s1'), {
      items: [
        { kind: 'subagent', session_id: 'c1', title: 'Port the tests', label: 'worker#1', workspace: '', state: 'idle' },
        { kind: 'subagent', session_id: 'c2', title: 'Map the code', label: 'explorer#1', workspace: '', state: 'working' },
        { kind: 'subagent', session_id: 'c3', title: 'Check the docs', label: 'explorer#2', workspace: '', state: 'working' },
      ],
    }))
    await waitFor(() => expect(line()?.textContent).toBe('Waiting for 2 sessions'))
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
