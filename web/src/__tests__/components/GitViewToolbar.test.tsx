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

describe('GitViewToolbar on a phone', () => {
  it('moves Graph view and All branches into a History options menu, leaving the tabs the width', () => {
    const onSubTabChange = mock(() => {})
    const onAllBranchesChange = mock(() => {})
    renderToolbar({ onSubTabChange, onAllBranchesChange })

    expect(screen.queryByRole('checkbox', { name: 'Graph view' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'History options' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'All branches' }))
    expect(onAllBranchesChange).toHaveBeenCalledWith(true)

    fireEvent.click(screen.getByRole('button', { name: 'History options' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Graph view' }))
    expect(onSubTabChange).toHaveBeenCalledWith('commits')
  })

  it('keeps the checkboxes on desktop', () => {
    renderToolbar({ mobile: false })
    expect(screen.getByRole('checkbox', { name: 'Graph view' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'History options' })).toBeNull()
  })
})
