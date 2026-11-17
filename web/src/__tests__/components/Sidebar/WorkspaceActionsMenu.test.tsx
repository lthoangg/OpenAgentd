import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { queryKeys } from '@/queries'
import { loadLastWorkspace, loadWorkspaceEntries, saveLastWorkspace } from '@/utils/workspace'
import { useAgentStore } from '@/stores/useAgentStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useToastStore } from '@/stores/useToastStore'
import {
  WORKTREE_CHIP,
  cleanupSidebarHarness,
  fx,
  navigate,
  renderSidebar,
  renderSidebarForSessions,
  renderSidebarWithProps,
  resetSidebarHarness,
  type TestSession,
} from './harness'
import { runOf } from '@/stores/useAgentStore/run-state'

describe('Sidebar workspace trust flow', () => {
  beforeEach(resetSidebarHarness)
  afterEach(cleanupSidebarHarness)

  it('hides a main repository from the sidebar without deleting it', async () => {
    const user = userEvent.setup()
    fx.sessionsData = [
      {
        id: 'session-1',
        title: 'Main session',
        agent_name: 'lead',
        created_at: '2026-05-13T00:00:00Z',
        updated_at: '2026-05-13T00:00:00Z',
        mode: 'coding',
        workspace: '/repo/project',
      },
    ]
    fx.workspaceSessionsData = fx.sessionsData
    localStorage.setItem('oa-coding-workspaces', JSON.stringify([{ id: 'main', path: '/repo/project', createdAt: '2026-05-01T00:00:00Z' }]))

    await renderSidebarForSessions('session-1')

    expect(screen.getByLabelText('Collapse workspace project')).toBeTruthy()
    await user.click(screen.getByLabelText('Actions for project'))
    expect(screen.getByRole('menu', { name: 'Actions for project' })).toBeTruthy()
    await user.click(screen.getByRole('menuitem', { name: 'Hide from sidebar' }))
    expect(screen.queryByText('Hide this workspace from the sidebar?')).toBeNull()

    expect(screen.queryByLabelText('Collapse workspace project')).toBeNull()
    expect(globalThis.fetch).toHaveBeenCalledWith('/api/agent/workspace/visibility', expect.objectContaining({
      method: 'PATCH',
      body: JSON.stringify({ workspace: '/repo/project', hidden: true }),
    }))
    expect(globalThis.fetch).not.toHaveBeenCalledWith('/api/agent/workspace/worktrees', expect.objectContaining({ method: 'DELETE' }))
    expect(navigate).toHaveBeenCalledWith({ to: '/', replace: true })
  })

  it('says a workspace was hidden and how to bring it back, with Undo that shows it again', async () => {
    const user = userEvent.setup()
    fx.sessionsData = [
      { id: 'session-1', title: 'Main session', agent_name: 'lead', created_at: '2026-05-13T00:00:00Z', updated_at: '2026-05-13T00:00:00Z', mode: 'coding', workspace: '/repo/project' },
    ]
    fx.workspaceSessionsData = fx.sessionsData
    useToastStore.setState({ toasts: [] })

    await renderSidebarForSessions('session-1')
    await user.click(screen.getByLabelText('Actions for project'))
    await user.click(screen.getByRole('menuitem', { name: 'Hide from sidebar' }))

    const toast = useToastStore.getState().toasts.find((t) => t.title === 'Hid project from the sidebar')
    expect(toast?.description).toBe('Its sessions are kept. Open workspace… brings it back.')
    expect(toast?.action?.label).toBe('Undo')

    act(() => toast?.action?.onAction())
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledWith('/api/agent/workspace/visibility', expect.objectContaining({
      method: 'PATCH',
      body: JSON.stringify({ workspace: '/repo/project', hidden: false }),
    })))
  })

  describe('Remove from sidebar', () => {
    const session = (id: string, workspace: string): TestSession => ({
      id,
      title: `Session in ${workspace}`,
      agent_name: 'lead',
      created_at: '2026-05-13T00:00:00Z',
      updated_at: '2026-05-13T00:00:00Z',
      mode: 'coding',
      workspace,
    })

    async function removeFromSidebar(name: string) {
      const user = userEvent.setup()
      await user.click(screen.getByLabelText(`Actions for ${name}`))
      await user.click(screen.getByRole('menuitem', { name: 'Hide from sidebar' }))
    }

    it('drops the repository row once the backend has hidden it', async () => {
      fx.sessionsData = [session('session-1', '/repo/project'), session('session-2', '/repo/other')]
      fx.workspaceSessionsData = fx.sessionsData
      // The tree was fetched moments ago, so a cached copy is still fresh.
      await renderSidebarWithProps({ currentSessionId: 'session-2', workspace: '/repo/other' })
      await waitFor(() => expect(screen.getByLabelText('Actions for project')).toBeTruthy())

      await removeFromSidebar('project')

      await waitFor(() => expect(screen.queryByLabelText('Actions for project')).toBeNull())
      expect(fx.hiddenWorkspacePaths.has('/repo/project')).toBe(true)
      expect(screen.getByLabelText('Actions for other')).toBeTruthy()
    })

    it('forgets the removed workspace before leaving it, so the empty route cannot reopen it', async () => {
      fx.sessionsData = [session('session-1', '/repo/project')]
      fx.workspaceSessionsData = fx.sessionsData
      saveLastWorkspace('/repo/project')
      // The empty route restores the last workspace the moment it renders.
      let lastWorkspaceAtNavigation: string | null | undefined
      navigate.mockImplementation(() => { lastWorkspaceAtNavigation = loadLastWorkspace()?.path ?? null })

      await renderSidebarForSessions('session-1')
      await removeFromSidebar('project')

      expect(navigate).toHaveBeenCalledWith({ to: '/', replace: true })
      expect(lastWorkspaceAtNavigation).toBeNull()
      expect(loadWorkspaceEntries().map((entry) => entry.path)).not.toContain('/repo/project')
      await waitFor(() => expect(screen.queryByLabelText('Actions for project')).toBeNull())
    })

    it('hides the repository worktrees too, which would otherwise keep it listed', async () => {
      fx.sessionsData = [session('session-1', '/repo/project'), session('session-2', '/repo/other')]
      fx.workspaceSessionsData = fx.sessionsData
      fx.worktreesByRepo = { '/repo/project': [{ path: '/data/worktrees/project/task-a', name: 'task-a', managed: true }] }
      await renderSidebarWithProps({ currentSessionId: 'session-2', workspace: '/repo/other' })
      await waitFor(() => expect(screen.getByLabelText('Actions for project')).toBeTruthy())

      await removeFromSidebar('project')

      await waitFor(() => expect(screen.queryByLabelText('Actions for project')).toBeNull())
      expect(screen.queryByRole('button', WORKTREE_CHIP)).toBeNull()
      expect([...fx.hiddenWorkspacePaths].sort()).toEqual(['/data/worktrees/project/task-a', '/repo/project'])
    })

    it('lists a hidden workspace again once reopening it has un-hidden it', async () => {
      const user = userEvent.setup()
      fx.sessionsData = [session('session-1', '/repo/project')]
      fx.workspaceSessionsData = fx.sessionsData
      fx.hiddenWorkspacePaths = new Set(['/repo/project'])

      await renderSidebar()
      expect(screen.queryByLabelText('Actions for project')).toBeNull()
      await user.click(screen.getByRole('button', { name: 'Allow and open' }))

      // Opening a folder the sidebar does not list un-hides it first.
      await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: '/', search: { workspace: '/repo/project' }, replace: false }))
      await waitFor(() => expect(screen.getByLabelText('Actions for project')).toBeTruthy())
    })

    it('follows workspace-tree refreshes made outside the sidebar', async () => {
      fx.sessionsData = [session('session-1', '/repo/project')]
      fx.workspaceSessionsData = fx.sessionsData
      fx.hiddenWorkspacePaths = new Set(['/repo/project'])
      const { Sidebar } = await import('@/components/Sidebar')
      const queryClient = new QueryClient()
      await act(async () => {
        render(
          <QueryClientProvider client={queryClient}>
            <Sidebar />
          </QueryClientProvider>,
        )
        await Promise.resolve()
      })
      await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledWith('/api/agent/workspace/tree'))
      expect(screen.queryByLabelText('Actions for project')).toBeNull()

      // The command palette's workspace switch refreshes the shared query.
      fx.hiddenWorkspacePaths.delete('/repo/project')
      await act(async () => {
        await queryClient.invalidateQueries({ queryKey: queryKeys.coding.tree() })
      })

      await waitFor(() => expect(screen.getByLabelText('Actions for project')).toBeTruthy())
    })
  })

  it('opens a draft from the workspace menu without creating a session', async () => {
    const user = userEvent.setup()
    fx.sessionsData = [
      {
        id: 'session-1',
        title: null,
        agent_name: 'lead',
        created_at: '2026-05-13T00:00:00Z',
        updated_at: '2026-05-13T00:00:00Z',
        mode: 'coding',
        workspace: '/repo/project',
      },
    ]
    fx.workspaceSessionsData = fx.sessionsData
    useAgentStore.setState({
      sessionId: 'session-1',
      sessionRun: runOf(false),
      agentNames: ['lead'],
      agentStreams: {
        lead: {
          blocks: [],
          currentBlocks: [],
          currentText: '',
          currentThinking: '',
          status: 'idle',
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0 },
                model: null,
          lastError: null,
        },
      },
    })
    const fetchSpy = globalThis.fetch as unknown as ReturnType<typeof mock>

    await renderSidebarForSessions('session-1')
    await user.click(screen.getByLabelText('Actions for project'))
    await user.click(screen.getByRole('menuitem', { name: /new session/i }))

    expect(fetchSpy).not.toHaveBeenCalledWith('/api/agent/sessions/resolve', expect.anything())
    expect(navigate).toHaveBeenCalledWith({ to: '/', search: { workspace: '/repo/project' }, replace: false })
    expect(useAgentStore.getState().sessionId).toBeNull()
  })

  it('copies the folder path from the workspace actions menu', async () => {
    const user = userEvent.setup()
    const writeText = mock(async () => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })

    fx.sessionsData = [
      {
        id: 'session-1',
        title: 'Feature session',
        agent_name: 'lead',
        created_at: '2026-05-13T00:00:00Z',
        updated_at: '2026-05-13T00:00:00Z',
        mode: 'coding',
        workspace: '/repo/project',
      },
    ]
    fx.workspaceSessionsData = fx.sessionsData

    await renderSidebarForSessions('session-1')

    await user.click(screen.getByLabelText('Actions for project'))
    const copyOption = screen.getByRole('menuitem', { name: /^copy path$/i })
    expect(copyOption).toBeTruthy()

    await user.click(copyOption)
    expect(writeText).toHaveBeenCalledWith('/repo/project')
  })

  it('toggles a repository\'s groups from its actions menu and links to group settings', async () => {
    const user = userEvent.setup()
    fx.sessionsData = [
      { id: 'session-1', title: 'Feature', agent_name: 'lead', created_at: '2026-05-13T00:00:00Z', updated_at: '2026-05-13T00:00:00Z', mode: 'coding', workspace: '/repo/project' },
    ]
    fx.workspaceSessionsData = fx.sessionsData
    fx.workspaceGroupsData = [
      { id: 'g-acme', name: 'acme', brief: null },
      { id: 'g-shared', name: 'shared', brief: null },
    ]
    fx.groupIdsByRepo = { '/repo/project': ['g-acme'] }
    const realOpenSettings = useSettingsStore.getState().openSettings
    const openSettings = mock(() => {})
    useSettingsStore.setState({ openSettings })

    await renderSidebarForSessions('session-1')

    await user.click(screen.getByLabelText('Actions for project'))
    const toggle = (name: string) => screen.getByRole('menuitemcheckbox', { name })
    expect(toggle('acme').getAttribute('aria-checked')).toBe('true')
    expect(toggle('shared').getAttribute('aria-checked')).toBe('false')

    // A toggle saves at once and keeps the menu open for the next one.
    await user.click(toggle('shared'))
    await waitFor(() => expect(fx.setGroupsRequests).toEqual([{ workspace: '/repo/project', group_ids: ['g-acme', 'g-shared'] }]))
    await waitFor(() => expect(toggle('shared').getAttribute('aria-checked')).toBe('true'))
    await user.click(toggle('acme'))
    await waitFor(() => expect(fx.setGroupsRequests.at(-1)).toEqual({ workspace: '/repo/project', group_ids: ['g-shared'] }))

    await user.click(screen.getByRole('menuitem', { name: 'Manage groups…' }))
    expect(openSettings).toHaveBeenCalledWith('workspaces')
    expect(screen.queryByRole('menu')).toBeNull()
    useSettingsStore.setState({ openSettings: realOpenSettings })
  })

  it('offers a new chat session from the long-press action list on touch', async () => {
    // On a touch build the inline "+" is hidden, so the pinned Chat row is the
    // only affordance left — long-pressing it has to surface "New session"
    // rather than bailing out the way repository-only actions do.
    fx.isMobile = true
    fx.platformOs = 'ios'
    fx.chatWorkspaceEntry = { path: '/home/user', name: 'Chat' }
    fx.sessionsData = [
      {
        id: 'chat-1',
        title: 'Trip planning',
        agent_name: 'code',
        created_at: '2026-09-15T00:00:00Z',
        updated_at: '2026-09-15T00:00:00Z',
        workspace: '/home/user',
      },
    ]
    fx.workspaceSessionsData = fx.sessionsData

    await renderSidebarWithProps({
      currentSessionId: 'chat-1',
      workspace: '/home/user',
      mobileOpen: true,
    })

    const chatRow = screen.getByRole('button', { name: 'Open workspace Chat' })
    fireEvent.pointerDown(chatRow, { pointerType: 'touch', clientX: 20, clientY: 20 })

    const newSession = await waitFor(
      () => {
        // Not the sidebar's own New session row: the one in the action sheet.
        const inSheet = screen.getAllByRole('button', { name: 'New session' }).find((el) => !el.hasAttribute('data-sidebar-new-session'))
        if (!inSheet) throw new Error('no action sheet yet')
        return inSheet
      },
      { timeout: 1500 },
    )

    // Repository-shaped actions stay off the chat root.
    expect(screen.queryByRole('button', { name: /^copy path$/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /create worktree/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /hide from sidebar/i })).toBeNull()
    // The phone's long-press menu is a bottom sheet.
    expect(newSession.closest('[data-bottom-sheet]')).not.toBeNull()

    fireEvent.click(newSession)

    // A session is on screen, so the Chat draft opens; nothing is created.
    expect(navigate).toHaveBeenCalledWith({
      to: '/',
      search: { workspace: '/home/user' },
      replace: false,
    })
  })
})
