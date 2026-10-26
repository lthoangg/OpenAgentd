import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))
mock.module('@/queries', () => ({
  useAgentFileQuery: () => ({ data: undefined, isLoading: false, isError: true, error: new Error('agent not found'), refetch: () => {} }),
  useUpdateAgentMutation: () => ({ mutateAsync: async () => ({}), isPending: false }),
  useDeleteAgentMutation: () => ({ mutateAsync: async () => {}, isPending: false }),
}))

import { AgentEditorPage } from '@/components/settings/pages/settings.agents.$name'

afterEach(cleanup)

describe('AgentEditorPage — load failure', () => {
  it('shows the error message without the "Error:" type prefix', () => {
    render(<AgentEditorPage name="reviewer" onBack={() => {}} />)

    expect(screen.getByText('Failed to load: agent not found')).toBeTruthy()
    expect(screen.queryByText(/Error: agent not found/)).toBeNull()
  })
})
