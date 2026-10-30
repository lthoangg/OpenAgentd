import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SidebarSectionHeader } from '@/components/Sidebar/SidebarSectionHeader'
import { SIDEBAR_VIEW_DEFAULTS, useSidebarViewStore, type SidebarGroupBy } from '@/stores/useSidebarViewStore'

afterEach(cleanup)

beforeEach(() => {
  localStorage.clear()
  useSidebarViewStore.setState({ ...SIDEBAR_VIEW_DEFAULTS })
})

function renderHeader(groupBy: SidebarGroupBy = 'project', workspaceGroups: Array<{ id: string; name: string; brief: string | null }> = []) {
  const onNewSession = mock(() => {})
  render(
    <SidebarSectionHeader
      groupBy={groupBy}
      workspaceGroups={workspaceGroups}
      newSessionShortcut="⌘N"
      searchOpen={false}
      onNewSession={onNewSession}
      onToggleSearch={() => {}}
      onCollapseAll={() => {}}
      onOpenFolder={() => {}}
    />,
  )
  return { onNewSession }
}

describe('SidebarSectionHeader', () => {
  it('names the tree Workspaces and keeps Collapse all to it, in View options', async () => {
    const user = userEvent.setup()
    renderHeader('project')
    expect(screen.getByText('Workspaces')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'View options' }))
    const menu = screen.getByRole('menu', { name: 'View options' })
    expect(within(menu).getByRole('menuitem', { name: 'Collapse all workspaces' })).toBeTruthy()
    expect(within(menu).getByRole('menuitem', { name: 'Open folder…' })).toBeTruthy()
  })

  it('always offers New session with its shortcut, in every view', async () => {
    const user = userEvent.setup()
    const { onNewSession } = renderHeader('project')
    const button = screen.getByRole('button', { name: 'New session' })
    expect(button.textContent).toContain('⌘N')
    await user.click(button)
    expect(onNewSession).toHaveBeenCalledTimes(1)
  })

  it('names a flat view Sessions, with no Collapse all', async () => {
    const user = userEvent.setup()
    renderHeader('date')
    expect(screen.getByText('Sessions')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'New session' })).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'View options' }))
    expect(screen.queryByRole('menuitem', { name: 'Collapse all workspaces' })).toBeNull()
  })
})

describe('SidebarViewMenu', () => {
  it('narrows the Project view to one workspace group', async () => {
    const user = userEvent.setup()
    renderHeader('project', [{ id: 'g-acme', name: 'acme', brief: null }])
    await user.click(screen.getByRole('button', { name: 'View options' }))
    const filter = within(screen.getByRole('menu', { name: 'View options' })).getByRole('group', { name: 'Workspace group' })
    expect(within(filter).getAllByRole('menuitemradio').map((item) => item.textContent)).toEqual(['All workspaces', 'acme'])
    await user.click(within(filter).getByRole('menuitemradio', { name: 'acme' }))
    expect(useSidebarViewStore.getState().groupFilter).toBe('g-acme')
    expect(within(filter).getByRole('menuitemradio', { name: 'acme' }).getAttribute('aria-checked')).toBe('true')
  })

  it('offers no group filter without groups or outside Project view', async () => {
    const user = userEvent.setup()
    useSidebarViewStore.setState({ groupBy: 'date' })
    renderHeader('date', [{ id: 'g-acme', name: 'acme', brief: null }])
    await user.click(screen.getByRole('button', { name: 'View options' }))
    expect(within(screen.getByRole('menu', { name: 'View options' })).queryByRole('group', { name: 'Workspace group' })).toBeNull()
  })

  it('shows the current view as checked radio and checkbox items', async () => {
    const user = userEvent.setup()
    renderHeader()
    const trigger = screen.getByRole('button', { name: 'View options' })
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu')
    await user.click(trigger)

    const menu = screen.getByRole('menu', { name: 'View options' })
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    const groupBy = within(menu).getByRole('group', { name: 'Group by' })
    expect(within(groupBy).getAllByRole('menuitemradio').map((item) => item.textContent)).toEqual(['Workspace', 'Status', 'Date', 'None'])
    expect(within(groupBy).getByRole('menuitemradio', { name: 'Workspace' }).getAttribute('aria-checked')).toBe('true')
    // Sessions are always in activity order: there is nothing to sort by.
    expect(within(menu).queryByRole('group', { name: 'Sort by' })).toBeNull()
    expect(within(menu).getByRole('menuitemcheckbox', { name: 'Show details' }).getAttribute('aria-checked')).toBe('true')
  })

  it('applies each choice at once and keeps the menu open', async () => {
    const user = userEvent.setup()
    renderHeader()
    await user.click(screen.getByRole('button', { name: 'View options' }))

    await user.click(screen.getByRole('menuitemradio', { name: 'Status' }))
    await user.click(screen.getByRole('menuitemcheckbox', { name: 'Show details' }))

    expect(useSidebarViewStore.getState()).toMatchObject({ groupBy: 'status', showDetails: false })
    expect(screen.getByRole('menuitemradio', { name: 'Status' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('menuitemcheckbox', { name: 'Show details' }).getAttribute('aria-checked')).toBe('false')
    // The choice persists per device.
    expect(JSON.parse(localStorage.getItem('oa.sidebarView.v1') ?? '{}').state).toMatchObject({ groupBy: 'status' })
  })

  it('resets to the defaults and closes', async () => {
    const user = userEvent.setup()
    useSidebarViewStore.setState({ groupBy: 'none', showDetails: false })
    renderHeader('none')
    await user.click(screen.getByRole('button', { name: 'View options' }))
    await user.click(screen.getByRole('menuitem', { name: 'Reset to defaults' }))

    expect(useSidebarViewStore.getState()).toMatchObject(SIDEBAR_VIEW_DEFAULTS)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('moves with the arrow keys and returns focus to the trigger on Escape', async () => {
    const user = userEvent.setup()
    renderHeader()
    const trigger = screen.getByRole('button', { name: 'View options' })
    await user.click(trigger)

    expect(document.activeElement).toBe(screen.getByRole('menuitemradio', { name: 'Workspace' }))
    await user.keyboard('{ArrowDown}')
    expect(document.activeElement).toBe(screen.getByRole('menuitemradio', { name: 'Status' }))
    await user.keyboard('{ArrowUp}{ArrowUp}')
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Reset to defaults' }))

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })
})
