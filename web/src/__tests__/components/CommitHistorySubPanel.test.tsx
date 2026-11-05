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
    gitHistory: { isLoading: false, isError: false, isFetchingNextPage: false, hasNextPage: false, fetchNextPage: async () => {} },
    commits: [commit],
    expandedCommitSha: null,
    setExpandedCommitSha: noop,
    expandedCommitFiles: new Set(),
    setExpandedCommitFiles: noop,
    commitDiff: { isLoading: false, isError: false },
    commitChangedFiles: [],
    commitDiffSections: new Map(),
    commitsScrollRef: { current: null },
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

describe('CommitHistorySubPanel load errors', () => {
  it('shows the failure with Retry, and Retry reloads', () => {
    const refetch = mock(async () => {})
    renderPanel({
      commits: [],
      gitHistory: { isLoading: false, isError: true, isFetchingNextPage: false, hasNextPage: false, fetchNextPage: async () => {}, refetch },
    })

    expect(screen.getByRole('alert').textContent).toBe("Couldn't load commit history.")
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(refetch).toHaveBeenCalledTimes(1)
  })

  it('disables Retry while it runs', () => {
    renderPanel({
      commits: [],
      gitHistory: { isLoading: false, isError: true, isFetching: true, isFetchingNextPage: false, hasNextPage: false, fetchNextPage: async () => {}, refetch: async () => {} },
    })
    expect((screen.getByRole('button', { name: 'Retry' }) as HTMLButtonElement).disabled).toBe(true)
  })
})
