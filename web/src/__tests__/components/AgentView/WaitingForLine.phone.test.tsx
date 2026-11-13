/**
 * On a phone the list of sessions a finished answer waits for is a sheet.
 */
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

mock.module('@/hooks/use-is-phone', () => ({ useIsPhone: () => true }))

const { WaitingForLine } = await import('@/components/AgentView/WaitingForLine')
const { queryKeys } = await import('@/queries')

afterEach(cleanup)

describe('WaitingForLine on a phone', () => {
  it('opens the list in a sheet', () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
    client.setQueryData(queryKeys.session.waiting('lead-1'), {
      items: [{ kind: 'subagent', session_id: 'sub-1', title: 'Port the settings tests', label: 'worker#1', workspace: '', state: 'working' }],
    })
    render(<QueryClientProvider client={client}><WaitingForLine sessionId="lead-1" /></QueryClientProvider>)
    expect(document.querySelector('[data-waiting-sheet]')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /^Waiting for 1 session/ }))
    const sheet = document.querySelector('[data-waiting-sheet]')
    expect(sheet?.textContent).toContain('Port the settings tests')
  })
})
