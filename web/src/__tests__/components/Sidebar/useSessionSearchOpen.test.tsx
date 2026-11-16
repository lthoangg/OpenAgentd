import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  cleanupSidebarHarness,
  fx,
  navigate,
  renderSidebarForSessions,
  renderSidebarWithProps,
  resetSidebarHarness,
} from './harness'

describe('Sidebar workspace trust flow', () => {
  beforeEach(resetSidebarHarness)
  afterEach(cleanupSidebarHarness)

  it('searches session titles across workspaces in place of the tree', async () => {
    const user = userEvent.setup()
    fx.sessionsData = [
      {
        id: 'session-1',
        title: 'Current session',
        agent_name: 'lead',
        created_at: '2026-05-13T00:00:00Z',
        updated_at: '2026-05-13T00:00:00Z',
        mode: 'coding',
        workspace: '/repo/project',
      },
    ]
    fx.workspaceSessionsData = fx.sessionsData
    fx.searchResultsData = [
      {
        id: 'm1',
        title: 'Migration plan',
        agent_name: 'lead',
        created_at: '2026-01-02T00:00:00Z',
        updated_at: '2026-01-02T00:00:00Z',
        workspace: '/repo/other',
      },
      // An older server ignores ``q`` and sends a normal page.
      {
        id: 'x',
        title: 'Unrelated',
        agent_name: 'lead',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        workspace: '/repo/project',
      },
    ]

    await renderSidebarForSessions('session-1')
    await user.click(screen.getByRole('button', { name: 'Search sessions' }))
    const input = await screen.findByRole('searchbox', { name: 'Search sessions' })
    await waitFor(() => expect(document.activeElement).toBe(input))
    await user.type(input, 'MIGR')

    const results = await screen.findByRole('region', { name: 'Search results' })
    await waitFor(() => expect(results.textContent).toContain('Migration plan'))
    expect(results.textContent).toContain('other')
    expect(results.textContent).not.toContain('Unrelated')
    expect(fx.searchQueries).toContain('MIGR')
    expect(screen.queryByLabelText('Collapse workspace project')).toBeNull()

    await user.click(screen.getByRole('button', { name: /Migration plan/ }))
    expect(navigate).toHaveBeenCalledWith({ to: '/$sessionId', params: { sessionId: 'm1' } })
    expect(screen.queryByRole('searchbox')).toBeNull()
    expect(screen.getByLabelText('Collapse workspace project')).toBeTruthy()
  })

  it('opens session search from its button and gives focus back on Escape', async () => {
    const user = userEvent.setup()
    await renderSidebarForSessions(undefined)

    await user.click(screen.getByRole('button', { name: 'Search sessions' }))
    const input = await screen.findByRole('searchbox', { name: 'Search sessions' })
    await waitFor(() => expect(document.activeElement).toBe(input))

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('searchbox')).toBeNull()
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Search sessions' })))
  })

  it('opens session search, focused, when the app asks for it (⌘⇧F)', async () => {
    await renderSidebarWithProps({ workspace: '/repo/project', searchSessionsKey: 1 })

    const input = await screen.findByRole('searchbox', { name: 'Search sessions' })
    await waitFor(() => expect(document.activeElement).toBe(input))
  })
})
