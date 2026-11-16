import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { cleanupSidebarHarness, fx, navigate, renderSidebarForSessions, resetSidebarHarness } from './harness'

describe('Sidebar workspace trust flow', () => {
  beforeEach(resetSidebarHarness)
  afterEach(cleanupSidebarHarness)

  it('lists sessions that need you from every workspace above the workspaces', async () => {
    const user = userEvent.setup()
    fx.activeSessionsData = [
      {
        id: 'ask-1',
        title: 'Pick a migration plan',
        agent_name: 'lead',
        created_at: '2026-05-13T00:00:00Z',
        updated_at: '2026-05-13T00:00:00Z',
        workspace: '/repo/project',
        running: true,
        needs_input: true,
      },
      {
        id: 'ask-2',
        title: 'Confirm the release notes',
        agent_name: 'lead',
        created_at: '2026-05-12T00:00:00Z',
        updated_at: '2026-05-12T00:00:00Z',
        workspace: '/repo/other',
        running: true,
        needs_input: true,
      },
      // An older server ignores ``active`` and sends a normal page.
      {
        id: 'busy',
        title: 'Still working',
        agent_name: 'lead',
        created_at: '2026-05-11T00:00:00Z',
        updated_at: '2026-05-11T00:00:00Z',
        workspace: '/repo/project',
        running: true,
      },
    ]

    await renderSidebarForSessions(undefined)

    const section = screen.getByRole('region', { name: 'Needs you' })
    expect(section.textContent).toContain('Pick a migration plan')
    expect(section.textContent).toContain('Confirm the release notes')
    expect(section.textContent).toContain('other')
    expect(section.textContent).not.toContain('Still working')

    await user.click(screen.getByRole('button', { name: /Confirm the release notes/ }))
    expect(navigate).toHaveBeenCalledWith({ to: '/$sessionId', params: { sessionId: 'ask-2' } })
  })

  it('hides the Needs you section when nothing is waiting', async () => {
    await renderSidebarForSessions(undefined)

    expect(screen.queryByRole('region', { name: 'Needs you' })).toBeNull()
  })
})
