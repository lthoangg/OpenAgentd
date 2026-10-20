import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import '@testing-library/jest-dom'
import type { SessionResponse } from '@/api/types'
import { queryKeys } from '@/queries/keys'

const navigate = mock((..._args: unknown[]) => {})
mock.module('@tanstack/react-router', () => ({ useNavigate: () => navigate }))

import { WorkspaceInfoCard } from '@/components/WorkspaceInfoCard'

const WORKSPACE = '/work/project'
let requested: string[] = []
const realFetch = globalThis.fetch

function session(id: string, title: string | null, updated: string, extra: Partial<SessionResponse> = {}): SessionResponse {
  return { id, title, agent_name: 'lead', created_at: updated, updated_at: updated, workspace: WORKSPACE, ...extra }
}

function renderCard(sessions: SessionResponse[] | null, props: { chatWorkspace?: boolean; currentSessionId?: string; workspace?: string } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  const workspace = props.workspace ?? WORKSPACE
  if (sessions) {
    client.setQueryData(queryKeys.session.sessions.workspace(workspace, 'activity'), {
      pages: [{ data: sessions, next_cursor: null, has_more: false }],
      pageParams: [null],
    })
  }
  return render(
    <QueryClientProvider client={client}>
      <WorkspaceInfoCard workspace={workspace} chatWorkspace={props.chatWorkspace} currentSessionId={props.currentSessionId} />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  requested = []
  globalThis.fetch = mock(async (input: unknown) => {
    requested.push(String(input))
    return new Promise<Response>(() => {})
  }) as unknown as typeof fetch
})

afterEach(() => {
  cleanup()
  navigate.mockClear()
  globalThis.fetch = realFetch
})

describe('WorkspaceInfoCard', () => {
  it("lists the workspace's recent sessions by last activity and opens one", async () => {
    const user = userEvent.setup()
    renderCard([
      session('old', 'Fix login bug', '2026-01-01T10:00:00Z'),
      session('current', null, '2026-01-03T10:00:00Z'),
      session('new', 'Ship updater', '2026-01-02T10:00:00Z', { running: true }),
      session('child', 'Explore tests', '2026-01-02T12:00:00Z', { parent_session_id: 'new' }),
    ], { currentSessionId: 'current' })

    const recent = screen.getByRole('region', { name: 'Recent sessions' })
    const rows = Array.from(recent.querySelectorAll('li')).map((row) => row.textContent ?? '')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toContain('Ship updater')
    expect(rows[1]).toContain('Fix login bug')

    await user.click(screen.getByRole('button', { name: /Fix login bug/ }))
    expect(navigate.mock.calls).toEqual([[{ to: '/$sessionId', params: { sessionId: 'old' } }]])
  })

  it('shows the workspace without the old git status block', () => {
    renderCard([])

    expect(screen.getByRole('heading', { name: 'project' })).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Recent sessions' })).toBeNull()
    expect(requested.some((url) => url.includes('/workspace/status'))).toBe(false)
  })

  it('renders a chat empty state without sessions, git status or the home path', () => {
    renderCard(null, { chatWorkspace: true, workspace: '/Users/someone' })

    expect(screen.getByRole('heading', { name: 'Chat' })).toBeInTheDocument()
    expect(screen.getByText(/runs here, in your home directory/i)).toBeInTheDocument()
    expect(screen.queryByText('/Users/someone')).toBeNull()
    expect(requested).toEqual([])
  })
})
