import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { loadLastWorkspace } from '@/utils/workspace'
import { useToastStore } from '@/stores/useToastStore'
import {
  cleanupSidebarHarness,
  deleteSessionMutate,
  fx,
  invokeMock,
  navigate,
  renderSidebarForSessions,
  resetSidebarHarness,
  updateSessionTitleMutate,
} from './harness'

describe('Sidebar workspace trust flow', () => {
  beforeEach(resetSidebarHarness)
  afterEach(cleanupSidebarHarness)

  it('opens a coding session in a new desktop window on macOS Command+click', async () => {
    fx.sessionsData = [
      {
        id: 'session-1',
        title: 'Selected session',
        agent_name: 'lead',
        created_at: '2026-05-13T00:00:00Z',
        updated_at: '2026-05-13T00:00:00Z',
        mode: 'coding',
        workspace: '/repo/project',
      },
    ]
    fx.workspaceSessionsData = fx.sessionsData

    await renderSidebarForSessions()

    fireEvent.mouseDown(screen.getByRole('button', { name: 'Selected session' }), { button: 0, metaKey: true })

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('app_new_window', {
        initialPath: '/session-1',
        initial_path: '/session-1',
      })
    })
    expect(navigate).not.toHaveBeenCalled()
  })

  it('renames a session in place from its row', async () => {
    const user = userEvent.setup()
    fx.sessionsData = [
      {
        id: 'session-1',
        title: 'Old title',
        agent_name: 'lead',
        created_at: '2026-05-13T00:00:00Z',
        updated_at: '2026-05-13T00:00:00Z',
        mode: 'coding',
        workspace: '/repo/project',
      },
    ]
    fx.workspaceSessionsData = fx.sessionsData

    await renderSidebarForSessions('session-1')
    await user.click(screen.getByLabelText('More actions for Old title'))
    await user.click(screen.getByRole('menuitem', { name: 'Rename' }))
    const input = screen.getByLabelText('Session title')
    await user.clear(input)
    await user.type(input, 'New title{Enter}')

    expect(updateSessionTitleMutate).toHaveBeenCalledWith(
      { id: 'session-1', title: 'New title' },
      expect.objectContaining({ onError: expect.any(Function) }),
    )
    expect(screen.queryByLabelText('Session title')).toBeNull()
    expect(screen.queryByText('Edit session title')).toBeNull()
  })

  it('trims title edits before submitting', async () => {
    const user = userEvent.setup()
    fx.sessionsData = [
      {
        id: 'session-1',
        title: 'Old title',
        agent_name: 'lead',
        created_at: '2026-05-13T00:00:00Z',
        updated_at: '2026-05-13T00:00:00Z',
        mode: 'coding',
        workspace: '/repo/project',
      },
    ]
    fx.workspaceSessionsData = fx.sessionsData

    await renderSidebarForSessions('session-1')
    await user.dblClick(screen.getByText('Old title'))
    const input = screen.getByLabelText('Session title')
    await user.clear(input)
    await user.type(input, '  New title  {Enter}')

    expect(updateSessionTitleMutate).toHaveBeenCalledWith(
      { id: 'session-1', title: 'New title' },
      expect.anything(),
    )
  })

  it('does not submit empty or cancelled title edits', async () => {
    const user = userEvent.setup()
    fx.sessionsData = [
      {
        id: 'session-1',
        title: 'Old title',
        agent_name: 'lead',
        created_at: '2026-05-13T00:00:00Z',
        updated_at: '2026-05-13T00:00:00Z',
        mode: 'coding',
        workspace: '/repo/project',
      },
    ]
    fx.workspaceSessionsData = fx.sessionsData

    await renderSidebarForSessions('session-1')
    await user.click(screen.getByLabelText('More actions for Old title'))
    await user.click(screen.getByRole('menuitem', { name: 'Rename' }))
    await user.clear(screen.getByLabelText('Session title'))
    await user.type(screen.getByLabelText('Session title'), '   {Enter}')
    expect(screen.queryByLabelText('Session title')).toBeNull()

    await user.click(screen.getByLabelText('More actions for Old title'))
    await user.click(screen.getByRole('menuitem', { name: 'Rename' }))
    await user.type(screen.getByLabelText('Session title'), 'Other{Escape}')

    expect(screen.queryByLabelText('Session title')).toBeNull()
    expect(screen.getByText('Old title')).toBeTruthy()
    expect(updateSessionTitleMutate).not.toHaveBeenCalled()
  })

  it('selects another coding session after deleting the current one', async () => {
    const user = userEvent.setup()
    fx.sessionsData = [
      {
        id: 'session-1',
        title: 'Delete me',
        agent_name: 'lead',
        created_at: '2026-05-13T00:00:00Z',
        updated_at: '2026-05-13T00:00:00Z',
        mode: 'coding',
        workspace: '/repo/project',
      },
      {
        id: 'session-2',
        title: 'Keep me',
        agent_name: 'lead',
        created_at: '2026-05-12T00:00:00Z',
        updated_at: '2026-05-12T00:00:00Z',
        mode: 'coding',
        workspace: '/repo/project',
      },
    ]
    fx.workspaceSessionsData = fx.sessionsData

    await renderSidebarForSessions('session-1')
    await user.click(screen.getByLabelText('More actions for Delete me'))
    await user.click(screen.getByRole('menuitem', { name: 'Delete session' }))

    expect(deleteSessionMutate).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'session-1', holdMs: 10000 }),
      expect.objectContaining({ onError: expect.any(Function) }),
    )
    expect(navigate).toHaveBeenCalledWith({
      to: '/$sessionId',
      params: { sessionId: 'session-2' },
      replace: true,
    })
    expect(loadLastWorkspace()?.path).toBe('/repo/project')
  })

  it('offers Undo after a delete, which cancels it and reopens the session', async () => {
    const user = userEvent.setup()
    fx.sessionsData = [
      { id: 'session-1', title: 'Delete me', agent_name: 'lead', created_at: '2026-05-13T00:00:00Z', updated_at: '2026-05-13T00:00:00Z', mode: 'coding', workspace: '/repo/project' },
    ]
    fx.workspaceSessionsData = fx.sessionsData
    useToastStore.setState({ toasts: [] })

    await renderSidebarForSessions('session-1')
    await user.click(screen.getByLabelText('More actions for Delete me'))
    await user.click(screen.getByRole('menuitem', { name: 'Delete session' }))

    const toast = useToastStore.getState().toasts.find((t) => t.title === 'Session deleted')
    expect(toast?.action?.label).toBe('Undo')
    const [target] = deleteSessionMutate.mock.calls.at(-1) as unknown as [{ undo: AbortSignal }]
    expect(target.undo.aborted).toBe(false)

    navigate.mockClear()
    toast?.action?.onAction()
    expect(target.undo.aborted).toBe(true)
    expect(navigate).toHaveBeenCalledWith({ to: '/$sessionId', params: { sessionId: 'session-1' }, replace: true })
  })

  it('deletes an idle session at once: no dialog, a toast with Undo that stays ten seconds', async () => {
    const user = userEvent.setup()
    fx.sessionsData = [
      { id: 'session-1', title: 'Delete me', agent_name: 'lead', created_at: '2026-05-13T00:00:00Z', updated_at: '2026-05-13T00:00:00Z', mode: 'coding', workspace: '/repo/project' },
    ]
    fx.workspaceSessionsData = fx.sessionsData
    useToastStore.setState({ toasts: [] })

    await renderSidebarForSessions('session-1')
    await user.click(screen.getByLabelText('More actions for Delete me'))
    await user.click(screen.getByRole('menuitem', { name: 'Delete session' }))

    expect(screen.queryByText('Delete this session?')).toBeNull()
    expect(deleteSessionMutate).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'session-1', holdMs: 10000 }),
      expect.objectContaining({ onError: expect.any(Function) }),
    )
    const toast = useToastStore.getState().toasts.find((t) => t.title === 'Session deleted')
    expect(toast?.description).toBe('Delete me')
    expect(toast?.durationMs).toBe(10000)
    expect(navigate).toHaveBeenCalledWith({ to: '/', replace: true })
  })

  it('asks before deleting a session whose agent is still working, since Undo does not restart it', async () => {
    const user = userEvent.setup()
    fx.sessionsData = [
      { id: 'session-1', title: 'Delete me', agent_name: 'lead', created_at: '2026-05-13T00:00:00Z', updated_at: '2026-05-13T00:00:00Z', mode: 'coding', workspace: '/repo/project', running: true },
    ]
    fx.workspaceSessionsData = fx.sessionsData

    await renderSidebarForSessions('session-1')
    await user.click(screen.getByLabelText('More actions for Delete me'))
    await user.click(screen.getByRole('menuitem', { name: 'Delete session…' }))

    expect(deleteSessionMutate).not.toHaveBeenCalled()
    expect(screen.getByText('Delete this session?')).toBeTruthy()
    expect(screen.getByText(/is still working\. Deleting stops it/)).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'Delete session' }))

    expect(deleteSessionMutate).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'session-1', holdMs: 10000 }),
      expect.objectContaining({ onError: expect.any(Function) }),
    )
  })
})
