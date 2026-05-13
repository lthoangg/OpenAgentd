import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import type React from 'react'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { findCodingWorkspaceId, loadLastCodingWorkspace } from '@/utils/workspace'
import { useTeamStore } from '@/stores/useTeamStore'

const navigate = mock(() => {})
const originalFetch = globalThis.fetch
const browseResponse = {
  path: '/repo/project',
  parent: '/repo',
  directories: [],
}
let validateError: Error | null = null
let sessionsData: Array<{
  id: string
  title: string | null
  agent_name: string | null
  created_at: string | null
  updated_at: string | null
  mode?: string
  workspace?: string | null
}> = []

mock.module('@tanstack/react-router', () => ({
  useNavigate: () => navigate,
}))

const Icon = () => null
mock.module('lucide-react', () => ({
  FolderCode: Icon,
  Home: Icon,
  Loader2: Icon,
  PanelLeftClose: Icon,
  Plus: Icon,
  RefreshCw: Icon,
}))

mock.module('@/components/ui/button', () => ({
  Button: ({ children, variant, ...props }: React.ComponentProps<'button'> & { variant?: string }) => {
    void variant
    return <button {...props}>{children}</button>
  },
}))

mock.module('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) => (open ? <div>{children}</div> : null),
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}))

mock.module('@/queries/useSessionsQuery', () => ({
  useTeamSessionsQuery: () => ({
    data: { pages: [{ data: sessionsData }] },
    isFetching: false,
    refetch: mock(() => {}),
  }),
  useDeleteTeamSessionMutation: () => ({ mutate: mock(() => {}) }),
}))

describe('CodingSidebar workspace trust flow', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionsData = []
    useTeamStore.setState({ isTeamWorking: false, sessionId: null })
    navigate.mockClear()
    validateError = null
    globalThis.fetch = mock(async (input: unknown) => {
      const url = String(input)
      if (url.startsWith('/api/team/workspace/browse')) {
        return new Response(JSON.stringify(browseResponse))
      }
      if (url.startsWith('/api/team/workspace/validate')) {
        if (validateError) {
          return new Response(JSON.stringify({ detail: validateError.message }), { status: 422 })
        }
        return new Response(JSON.stringify({ workspace: '/repo/project' }))
      }
      return new Response(null, { status: 404 })
    }) as typeof fetch
  })

  afterEach(() => {
    cleanup()
    globalThis.fetch = originalFetch
  })

  async function renderCodingSidebar() {
    const { CodingSidebar } = await import('@/components/CodingSidebar')
    let view: ReturnType<typeof render> | undefined
    await act(async () => {
      view = render(<CodingSidebar openWorkspaceDialogKey={1} />)
      await Promise.resolve()
    })
    return view
  }

  async function renderCodingSidebarForSessions(currentSessionId?: string) {
    const { CodingSidebar } = await import('@/components/CodingSidebar')
    let view: ReturnType<typeof render> | undefined
    await act(async () => {
      view = render(<CodingSidebar currentSessionId={currentSessionId} workspace="/repo/project" />)
      await Promise.resolve()
    })
    return view
  }

  it('does not navigate or save the last workspace until the user trusts the validated directory', async () => {
    const user = userEvent.setup()
    await renderCodingSidebar()

    const openButton = await screen.findByRole('button', { name: /open this folder/i })
    await user.click(openButton)

    expect(screen.getByText('Trust this workspace?')).toBeTruthy()
    expect(screen.getByText('/repo/project')).toBeTruthy()
    expect(navigate).not.toHaveBeenCalled()
    expect(loadLastCodingWorkspace()).toBeNull()

    await user.click(screen.getByRole('button', { name: /trust and open/i }))

    await waitFor(() => {
      expect(navigate).toHaveBeenCalledWith({
        to: '/coding',
        search: { w: findCodingWorkspaceId('/repo/project') },
      })
    })
    expect(loadLastCodingWorkspace()?.path).toBe('/repo/project')
  })

  it('lets the user go back from the trust warning without opening the workspace', async () => {
    const user = userEvent.setup()
    await renderCodingSidebar()

    await user.click(await screen.findByRole('button', { name: /open this folder/i }))
    await user.click(screen.getByRole('button', { name: /back/i }))

    expect(screen.getByText('Open workspace')).toBeTruthy()
    expect(navigate).not.toHaveBeenCalled()
    expect(loadLastCodingWorkspace()).toBeNull()
  })

  it('shows validation errors without showing the trust confirmation', async () => {
    const user = userEvent.setup()
    validateError = new Error('Workspace does not exist')

    await renderCodingSidebar()

    await user.click(await screen.findByRole('button', { name: /open this folder/i }))

    expect(await screen.findByText('Workspace does not exist')).toBeTruthy()
    expect(screen.queryByText('Trust this workspace?')).toBeNull()
    expect(navigate).not.toHaveBeenCalled()
    expect(loadLastCodingWorkspace()).toBeNull()
  })

  it('shows a running indicator on the active coding session while the team is working', async () => {
    sessionsData = [
      {
        id: 'session-1',
        title: 'Active session',
        agent_name: 'lead',
        created_at: '2026-05-13T00:00:00Z',
        updated_at: '2026-05-13T00:00:00Z',
        mode: 'coding',
        workspace: '/repo/project',
      },
      {
        id: 'session-2',
        title: 'Idle session',
        agent_name: 'lead',
        created_at: '2026-05-12T00:00:00Z',
        updated_at: '2026-05-12T00:00:00Z',
        mode: 'coding',
        workspace: '/repo/project',
      },
    ]
    useTeamStore.setState({ isTeamWorking: true, sessionId: 'session-1' })

    await renderCodingSidebarForSessions('session-1')

    expect(screen.getByLabelText('Session running')).toBeTruthy()
    expect(screen.getByText('Active session')).toBeTruthy()
    expect(screen.getByText('Idle session')).toBeTruthy()
  })

  it('does not show a running indicator for idle coding sessions', async () => {
    sessionsData = [
      {
        id: 'session-1',
        title: 'Idle session',
        agent_name: 'lead',
        created_at: '2026-05-13T00:00:00Z',
        updated_at: '2026-05-13T00:00:00Z',
        mode: 'coding',
        workspace: '/repo/project',
      },
    ]

    await renderCodingSidebarForSessions('session-1')

    expect(screen.queryByLabelText('Session running')).toBeNull()
  })
})
