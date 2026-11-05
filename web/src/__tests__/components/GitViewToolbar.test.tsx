import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { GitViewToolbar, type GitViewToolbarProps } from '@/components/WorkspacePanel/GitViewToolbar'

afterEach(cleanup)

function renderToolbar(overrides: Partial<GitViewToolbarProps> = {}) {
  const props: GitViewToolbarProps = {
    idBase: 'git',
    subTab: 'commits',
    onSubTabChange: () => {},
    changedCount: 3,
    commitsAhead: 2,
    commitsBehind: null,
    upstream: 'origin/main',
    mobile: true,
    allExpanded: null,
    onToggleExpandAll: () => {},
    ...overrides,
  }
  return render(<GitViewToolbar {...props} />)
}

describe('GitViewToolbar', () => {
  it('has no View menu, graph or All branches on History, on desktop or phone', () => {
    for (const mobile of [true, false]) {
      renderToolbar({ mobile })
      expect(screen.queryByRole('button', { name: 'View' })).toBeNull()
      expect(screen.queryByRole('menuitemcheckbox')).toBeNull()
      expect(screen.queryByText(/Graph view|All branches/)).toBeNull()
      cleanup()
    }
  })

  it('opens History as the commit list', () => {
    const onSubTabChange = mock(() => {})
    renderToolbar({ subTab: 'changes', onSubTabChange })

    fireEvent.click(screen.getByRole('tab', { name: /^History/ }))

    expect(onSubTabChange).toHaveBeenCalledWith('commits')
  })

  it('keeps expand-all on the Changes view', () => {
    renderToolbar({ subTab: 'changes', allExpanded: false })
    expect(screen.getByRole('button', { name: 'Expand all diffs' })).toBeTruthy()
  })

  it('ends with Refresh, the tab\'s own button (it left the tab strip), on either view', () => {
    const onRefresh = mock(() => {})
    for (const subTab of ['changes', 'commits'] as const) {
      renderToolbar({ subTab, allExpanded: false, onRefresh })
      const names = screen.getAllByRole('button').map((button) => button.getAttribute('aria-label'))
      expect(names.at(-1)).toBe('Refresh Git status')
      cleanup()
    }
    renderToolbar({ onRefresh })
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Git status' }))
    expect(onRefresh).toHaveBeenCalledTimes(1)
  })

  it('shows no Refresh when the caller gives none', () => {
    renderToolbar()
    expect(screen.queryByRole('button', { name: /^Refresh/ })).toBeNull()
  })

  it('keeps the Changes / History tabs short enough for the 32px toolbar on touch', () => {
    renderToolbar()
    const tablist = screen.getByRole('tablist', { name: 'Git view' })
    expect(tablist.className).toContain('pointer-coarse:data-[orientation=horizontal]:h-7')
    expect(tablist.className).not.toContain('h-10.5')
  })
})
