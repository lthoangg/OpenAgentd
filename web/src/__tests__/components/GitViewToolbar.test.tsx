import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { GitViewToolbar, type GitViewToolbarProps } from '@/components/WorkspacePanel/GitViewToolbar'

afterEach(cleanup)

function renderToolbar(overrides: Partial<GitViewToolbarProps> = {}) {
  const props: GitViewToolbarProps = {
    idBase: 'git',
    subTab: 'tree',
    onSubTabChange: () => {},
    changedCount: 3,
    commitsAhead: 2,
    commitsBehind: null,
    upstream: 'origin/main',
    mobile: true,
    allExpanded: null,
    onToggleExpandAll: () => {},
    allBranches: false,
    onAllBranchesChange: () => {},
    ...overrides,
  }
  return render(<GitViewToolbar {...props} />)
}

describe('GitViewToolbar View menu', () => {
  it('holds Graph view and All branches as checkable items, leaving the tabs the width', () => {
    const onSubTabChange = mock(() => {})
    const onAllBranchesChange = mock(() => {})
    renderToolbar({ onSubTabChange, onAllBranchesChange })

    expect(screen.queryByRole('checkbox')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'View' }))
    expect(screen.getByRole('menuitemcheckbox', { name: 'Graph view' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('menuitemcheckbox', { name: 'All branches' }).getAttribute('aria-checked')).toBe('false')
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'All branches' }))
    expect(onAllBranchesChange).toHaveBeenCalledWith(true)
    expect(screen.queryByRole('menu')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'View' }))
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Graph view' }))
    expect(onSubTabChange).toHaveBeenCalledWith('commits')
  })

  it('offers All branches only with the graph on, and Graph view back from the list', () => {
    const onSubTabChange = mock(() => {})
    renderToolbar({ subTab: 'commits', onSubTabChange })

    fireEvent.click(screen.getByRole('button', { name: 'View' }))
    expect(screen.getByRole('menuitemcheckbox', { name: 'Graph view' }).getAttribute('aria-checked')).toBe('false')
    expect(screen.queryByRole('menuitemcheckbox', { name: 'All branches' })).toBeNull()
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Graph view' }))
    expect(onSubTabChange).toHaveBeenCalledWith('tree')
  })

  it('is the same one button on desktop and phone, with no checkboxes', () => {
    for (const mobile of [true, false]) {
      renderToolbar({ mobile })
      expect(screen.getByRole('button', { name: 'View' }).getAttribute('aria-haspopup')).toBe('menu')
      expect(screen.queryByRole('checkbox')).toBeNull()
      cleanup()
    }
  })

  it('is not on the Changes view, which has nothing to set but expand-all', () => {
    renderToolbar({ subTab: 'changes', allExpanded: false })
    expect(screen.queryByRole('button', { name: 'View' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Expand all diffs' })).toBeTruthy()
  })

  it('keeps the Changes / History tabs short enough for the 32px toolbar on touch', () => {
    renderToolbar()
    const tablist = screen.getByRole('tablist', { name: 'Git view' })
    expect(tablist.className).toContain('pointer-coarse:data-[orientation=horizontal]:h-7')
    expect(tablist.className).not.toContain('h-10.5')
  })

  it('keeps the View button inside the 32px toolbar on touch, with a 36px hit area', () => {
    renderToolbar()
    const view = screen.getByRole('button', { name: 'View' })
    expect(view.className).toContain('h-7')
    expect(view.className).toContain('touch-hit')
    expect(view.className).not.toMatch(/pointer-coarse:(min-)?h-9/)
  })
})
