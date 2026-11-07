/**
 * The Undo notice above the composer names the files the undos changed back
 * on desktop. The phone's notice keeps its caption alone (its layout is not
 * part of this change).
 */
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'

let mobile = false
mock.module('@/hooks/use-mobile', () => ({ useIsMobile: () => mobile }))
mock.module('@/queries/useAgentsQuery', () => ({
  useAgentsQuery: () => ({ data: { agents: [] }, refetch: async () => {} }),
}))
mock.module('@/queries/useMcpQuery', () => ({
  useMcpServersQuery: () => ({ data: { servers: [] }, isLoading: false, isError: false, refetch: async () => {} }),
  useUpdateMcpServerMutation: () => ({ mutate: () => {}, isPending: false }),
  useConnectMcpOAuthMutation: () => ({ mutate: () => {}, isPending: false }),
}))

const { Composer } = await import('@/components/composer/Composer')

afterEach(() => {
  cleanup()
  mobile = false
})

function wrap(node: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } })
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>)
}

describe('the Undo notice above the composer', () => {
  it('lists the files the undo changed back on desktop', () => {
    wrap(<Composer onSubmit={() => {}} revertedCount={1} revertedFiles={['src/app.ts']} onRedo={() => {}} />)

    expect(screen.getByText(/^Undid the last message and its changes to 1 file\./)).toBeTruthy()
    expect(screen.getByRole('list', { name: 'Files Undo changed back' })).toBeTruthy()
  })

  it('keeps the phone notice to its caption', () => {
    mobile = true
    wrap(<Composer onSubmit={() => {}} revertedCount={1} revertedFiles={['src/app.ts']} onRedo={() => {}} />)

    expect(screen.getByText('Undid the last message. Redo brings it back; sending a new message discards it.')).toBeTruthy()
    expect(screen.queryByRole('list', { name: 'Files Undo changed back' })).toBeNull()
  })
})
