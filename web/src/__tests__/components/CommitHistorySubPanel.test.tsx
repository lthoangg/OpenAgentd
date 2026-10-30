import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'

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

function renderPanel() {
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
})
