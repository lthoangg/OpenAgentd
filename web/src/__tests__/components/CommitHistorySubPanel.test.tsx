import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import type { GitCommit } from '@/api/types'
import { CommitHistorySubPanel, type CommitHistorySubPanelProps } from '@/components/WorkspacePanel/CommitHistorySubPanel'
import { formatCommitTime } from '@/components/WorkspacePanel/diff-helpers'

afterEach(cleanup)

const commit: GitCommit = {
  sha: 'f18f596f6aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  short_sha: 'f18f596f6',
  author_name: 'Hoang Le',
  author_email: 'h@example.com',
  timestamp: 1_800_000_000,
  subject: 'Merge pull request #483',
  refs: 'tag: v3.36.0, origin/main, origin/HEAD',
}

function renderPanel(overrides: Partial<CommitHistorySubPanelProps> = {}) {
  const noop = () => {}
  const props: CommitHistorySubPanelProps = {
    workspace: 'ws',
    subTab: 'commits',
    gitHistory: { isLoading: false, isError: false, isFetchingNextPage: false, hasNextPage: false, fetchNextPage: async () => {} },
    commits: [commit],
    expandedCommitSha: null,
    setExpandedCommitSha: noop,
    expandedCommitFiles: new Set(),
    setExpandedCommitFiles: noop,
    commitDiff: { isLoading: false, isError: false },
    commitChangedFiles: [],
    commitDiffSections: new Map(),
    parsedGraphLines: [],
    commitsScrollRef: { current: null },
    pendingScrollShaRef: { current: null },
    setSubTab: noop,
    openCommitTab: noop,
    mobile: true,
    setMobileCommitActions: noop,
    setDesktopCommitActions: noop,
    setMobileFileActions: noop,
    setDesktopFileActions: noop,
    ...overrides,
  }
  return render(<CommitHistorySubPanel {...props} />)
}

describe('CommitHistorySubPanel commit row', () => {
  it('lets ref labels shrink so the date stays fully visible', () => {
    renderPanel()
    for (const ref of ['tag: v3.36.0', 'origin/main', 'origin/HEAD']) {
      const chip = screen.getByText(ref)
      expect(chip.className).not.toContain('shrink-0')
      expect(chip.className).toContain('min-w-0')
      expect(chip.className).toContain('truncate')
    }
    const time = screen.getByText(formatCommitTime(commit.timestamp))
    expect(time.className).toContain('shrink-0')
  })

  it('draws ref labels as soft fills, with no border', () => {
    renderPanel()
    expect(screen.getByText('origin/main').className).not.toMatch(/(^|\s)border(-\w+)?(\s|$)/)
  })
})

describe('CommitHistorySubPanel tree rows', () => {
  const lines = [
    { key: '1', raw: '* f18f596 (HEAD -> main, origin/main) Merge', graphPart: '* ', sha: 'f18f596', decorations: 'HEAD -> main, origin/main', message: 'Merge' },
    { key: '2', raw: '* a1b2c3d Fix', graphPart: '* ', sha: 'a1b2c3d', message: 'Fix' },
  ]

  it('are list-row tall (28px, 36px on touch through the token), not 20px', () => {
    renderPanel({ subTab: 'tree', parsedGraphLines: lines })
    const row = screen.getByRole('button', { name: 'f18f596' }).closest('[class*="spacing-list-row"]')
    expect(row?.className).toContain('h-(--spacing-list-row)')
    expect(row?.className).not.toMatch(/(^|\s)h-5(\s|$)/)
  })

  it('have an sha button with a 36px touch hit area and no border, and borderless ref chips', () => {
    renderPanel({ subTab: 'tree', parsedGraphLines: lines })
    const sha = screen.getByRole('button', { name: 'f18f596' })
    expect(sha.className).toContain('touch-hit')
    expect(sha.className).not.toMatch(/(^|\s)border(-\w+)?(\s|$)/)
    expect(screen.getByText('HEAD -> main').className).not.toMatch(/(^|\s)border(-\w+)?(\s|$)/)
  })
})

describe('CommitHistorySubPanel load errors', () => {
  for (const subTab of ['commits', 'tree'] as const) {
    it(`shows the ${subTab} failure with Retry, and Retry reloads`, () => {
      const refetch = mock(async () => {})
      renderPanel({
        subTab,
        commits: [],
        gitHistory: { isLoading: false, isError: true, isFetchingNextPage: false, hasNextPage: false, fetchNextPage: async () => {}, refetch },
      })

      expect(screen.getByRole('alert').textContent).toMatch(/^Failed to load/)
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
      expect(refetch).toHaveBeenCalledTimes(1)
    })
  }

  it('disables Retry while it runs', () => {
    renderPanel({
      commits: [],
      gitHistory: { isLoading: false, isError: true, isFetching: true, isFetchingNextPage: false, hasNextPage: false, fetchNextPage: async () => {}, refetch: async () => {} },
    })
    expect((screen.getByRole('button', { name: 'Retry' }) as HTMLButtonElement).disabled).toBe(true)
  })
})
