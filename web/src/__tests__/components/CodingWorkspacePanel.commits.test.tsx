import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import type React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useGitPanelStore } from '@/stores/useGitPanelStore'

const WORKSPACE = '/repo/project'

const Icon = () => null
mock.module('lucide-react', () => ({
  Check: Icon, ChevronDown: Icon, ChevronLeft: Icon, ChevronRight: Icon,
  Copy: Icon, Download: Icon, ExternalLink: Icon,
  File: Icon, FileText: Icon, FileType: Icon,
  Folder: Icon, FolderOpen: Icon,
  GitBranch: Icon, GitCompare: Icon,
  Loader2: Icon, Pencil: Icon, Plus: Icon, RefreshCw: Icon, RotateCcw: Icon,
  TerminalSquare: Icon, Undo2: Icon, X: Icon,
}))
mock.module('@/hooks/useReducedMotion', () => ({ useReducedMotion: () => false }))
mock.module('@/hooks/use-platform', () => ({
  usePlatform: () => ({ isTauri: false, os: 'linux', isMacOverlay: false }),
  getPlatform: () => ({ isTauri: false, os: 'linux', isMacOverlay: false }),
}))
mock.module('framer-motion', () => ({
  motion: {
    aside: ({ children, className }: { children: React.ReactNode; className?: string }) => (
      <aside className={className}>{children}</aside>
    ),
  },
}))

const commitNoBody = {
  sha: 'aaaaaaaabbbbbbbbcccccccc',
  short_sha: 'aaaaaaa',
  author_name: 'Alice',
  author_email: 'alice@example.com',
  timestamp: 1700000000,
  subject: 'feat: add login page',
  body: null,
  refs: null,
}

const commitWithBody = {
  sha: 'ddddddddeeeeeeeeffffffff',
  short_sha: 'ddddddd',
  author_name: 'Bob',
  author_email: 'bob@example.com',
  timestamp: 1700001000,
  subject: 'fix: handle null session',
  body: 'Without this guard the session lookup throws when the\nstore is empty on first load.\n\nCloses #42',
  refs: null,
}

const historyResponse = {
  workspace: WORKSPACE,
  is_git_repo: true,
  commits: [commitWithBody, commitNoBody],
  next_cursor: null,
  graph: '',
}

const emptyDiff = { workspace: WORKSPACE, is_git_repo: true, diff: '', untracked: [] }

beforeEach(() => {
  useGitPanelStore.setState({ workspaces: {} })

  globalThis.fetch = mock(async (input: unknown) => {
    const url = String(input)
    if (url.includes('/workspace/git/history')) return new Response(JSON.stringify(historyResponse))
    if (url.includes('/workspace/git-diff')) return new Response(JSON.stringify(emptyDiff))
    if (url.includes('/workspace/files/list')) return new Response(JSON.stringify({ workspace: WORKSPACE, truncated: false, files: [] }))
    if (url.includes('/workspace/git/commit-diff')) return new Response(JSON.stringify({ sha: commitWithBody.sha, diff: '' }))
    return new Response(null, { status: 404 })
  }) as typeof fetch
})

afterEach(cleanup)

async function renderCommitsTab(mobile = false) {
  const { CodingWorkspacePanel } = await import('@/components/CodingWorkspacePanel')
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  // Pre-set store to commits sub-tab so the history query fires immediately.
  useGitPanelStore.getState().setSubTab(WORKSPACE, 'commits')

  await act(async () => {
    render(
      <QueryClientProvider client={queryClient}>
        <CodingWorkspacePanel
          workspace={WORKSPACE}
          open
          onClose={() => {}}
          onOpenPalette={() => {}}
          mobile={mobile}
        />
      </QueryClientProvider>,
    )
  })

  return { queryClient }
}

describe('CodingWorkspacePanel – commit body expand/collapse', () => {
  it('renders commit subjects without showing the body by default', async () => {
    await renderCommitsTab()

    await waitFor(() => expect(screen.getByText('fix: handle null session')).toBeTruthy())

    // Body text must NOT be visible before expanding
    expect(screen.queryByText(/Without this guard/)).toBeNull()
  })

  it('does not render body for commits that have none', async () => {
    await renderCommitsTab()

    await waitFor(() => expect(screen.getByText('feat: add login page')).toBeTruthy())

    // Click the subject-only commit card to expand it
    const user = userEvent.setup()
    await user.click(screen.getByText('feat: add login page'))

    // Still no body paragraph (the commit has body: null)
    expect(screen.queryByText(/Without this guard/)).toBeNull()
  })

  it('shows the body when the commit card is expanded', async () => {
    const user = userEvent.setup()
    await renderCommitsTab()

    await waitFor(() => expect(screen.getByText('fix: handle null session')).toBeTruthy())

    // Body is hidden before expanding
    expect(screen.queryByText(/Without this guard/)).toBeNull()

    await user.click(screen.getByText('fix: handle null session'))

    await waitFor(() =>
      expect(screen.getByText((content) => content.includes('Without this guard'))).toBeTruthy()
    )
  })

  it('hides the body again when the expanded card is collapsed', async () => {
    const user = userEvent.setup()
    await renderCommitsTab()

    await waitFor(() => expect(screen.getByText('fix: handle null session')).toBeTruthy())

    // Expand
    await user.click(screen.getByText('fix: handle null session'))
    await waitFor(() =>
      expect(screen.getByText((content) => content.includes('Without this guard'))).toBeTruthy()
    )

    // Collapse (click the same card again)
    // getAllByText — the first click opened the subject's Tooltip, which
    // portals a second element with the same text into document.body.
    await user.click(screen.getAllByText('fix: handle null session')[0])
    await waitFor(() => expect(screen.queryByText(/Without this guard/)).toBeNull())
  })

  it('collapses the previously-open card when a different one is expanded', async () => {
    const user = userEvent.setup()
    await renderCommitsTab()

    await waitFor(() => {
      expect(screen.getByText('fix: handle null session')).toBeTruthy()
      expect(screen.getByText('feat: add login page')).toBeTruthy()
    })

    // Expand the commit with a body
    await user.click(screen.getByText('fix: handle null session'))
    await waitFor(() =>
      expect(screen.getByText((content) => content.includes('Without this guard'))).toBeTruthy()
    )

    // Now expand the subject-only commit — the body commit should collapse
    await user.click(screen.getByText('feat: add login page'))
    await waitFor(() => expect(screen.queryByText(/Without this guard/)).toBeNull())
  })

  it('renders URL-encoded commit subjects decoded in the list', async () => {
    // Regression: subjects arriving as percent-encoded strings (e.g. from
    // git log --format=%s piped through URL encoding) must not display raw
    // percent sequences to the user.
    const encodedHistory = {
      ...historyResponse,
      commits: [{
        ...commitNoBody,
        subject: 'feat:%20add%20login%20page',
      }],
    }
    globalThis.fetch = mock(async (input: unknown) => {
      const url = String(input)
      if (url.includes('/workspace/git/history')) return new Response(JSON.stringify(encodedHistory))
      if (url.includes('/workspace/git-diff')) return new Response(JSON.stringify(emptyDiff))
      if (url.includes('/workspace/files/list')) return new Response(JSON.stringify({ workspace: WORKSPACE, truncated: false, files: [] }))
      return new Response(null, { status: 404 })
    }) as typeof fetch

    await renderCommitsTab()

    // Raw percent-encoding must never appear
    await waitFor(() => expect(screen.queryByText(/feat:%20/)).toBeNull())
    // Decoded subject must be shown instead
    expect(screen.getByText('feat: add login page')).toBeTruthy()
  })

  it('handles invalid percent-encoded commit subjects gracefully without throwing URI error', async () => {
    const invalidEncodedHistory = {
      ...historyResponse,
      commits: [{
        ...commitNoBody,
        subject: 'feat: 100% test coverage',
      }],
    }
    globalThis.fetch = mock(async (input: unknown) => {
      const url = String(input)
      if (url.includes('/workspace/git/history')) return new Response(JSON.stringify(invalidEncodedHistory))
      if (url.includes('/workspace/git-diff')) return new Response(JSON.stringify(emptyDiff))
      if (url.includes('/workspace/files/list')) return new Response(JSON.stringify({ workspace: WORKSPACE, truncated: false, files: [] }))
      return new Response(null, { status: 404 })
    }) as typeof fetch

    await renderCommitsTab()

    // It should render the raw subject gracefully instead of throwing a URIError and crashing
    await waitFor(() => expect(screen.getByText('feat: 100% test coverage')).toBeTruthy())
  })

  it('preserves multi-line body whitespace via whitespace-pre-wrap', async () => {
    const user = userEvent.setup()
    await renderCommitsTab()

    await waitFor(() => expect(screen.getByText('fix: handle null session')).toBeTruthy())
    await user.click(screen.getByText('fix: handle null session'))

    await waitFor(() => {
      const bodyEl = screen.getByText((content) => content.includes('Without this guard'))
      expect(bodyEl.className).toContain('whitespace-pre-wrap')
    })
  })
})

describe('CodingWorkspacePanel – commit actions (undo/revert)', () => {
  it('opens commit actions context menu on right click on desktop, showing undo and revert buttons', async () => {
    await renderCommitsTab(false)

    await waitFor(() => expect(screen.getByText('fix: handle null session')).toBeTruthy())

    // Right-click the latest commit button
    const commitButton = screen.getByText('fix: handle null session').closest('button')!
    fireEvent.contextMenu(commitButton)

    // Verify context menu is open and shows "Undo commit" and "Revert commit"
    await waitFor(() => {
      expect(screen.getByText('Undo commit')).toBeTruthy()
      expect(screen.getByText('Revert commit')).toBeTruthy()
    })
  })

  it('opens commit actions dialog on long press on mobile, showing undo and revert buttons', async () => {
    await renderCommitsTab(true)

    await waitFor(() => expect(screen.getByText('fix: handle null session')).toBeTruthy())

    const commitButton = screen.getByText('fix: handle null session').closest('button')!

    // Simulate touch pointer events for long press
    fireEvent.pointerDown(commitButton, { pointerType: 'touch', clientX: 10, clientY: 10 })
    const origSetTimeout = globalThis.setTimeout
    try {
      let callback: (() => void) | null = null
      globalThis.setTimeout = ((cb: () => void) => {
        callback = cb
        return 1 as unknown as ReturnType<typeof setTimeout>
      }) as unknown as typeof setTimeout
      fireEvent.pointerDown(commitButton, { pointerType: 'touch', clientX: 10, clientY: 10 })
      if (callback) act(() => { (callback as () => void)() })
    } finally {
      globalThis.setTimeout = origSetTimeout
    }

    // Verify dialog is open and shows "Undo commit" and "Revert commit"
    await waitFor(() => {
      expect(screen.getByText('Undo commit')).toBeTruthy()
      expect(screen.getByText('Revert commit')).toBeTruthy()
    })
  })

  it('triggers undo last commit when Undo commit is clicked', async () => {
    const user = userEvent.setup()
    const undoMock = mock(() => Promise.resolve(new Response(JSON.stringify({ workspace: WORKSPACE, success: true }))))

    const originalFetch = globalThis.fetch
    globalThis.fetch = mock(async (input: unknown, init?: unknown) => {
      const url = String(input)
      if (url.includes('/workspace/git/undo')) {
        return undoMock()
      }
      return originalFetch(input as RequestInfo | URL, init as RequestInit)
    }) as typeof fetch

    await renderCommitsTab(false)

    await waitFor(() => expect(screen.getByText('fix: handle null session')).toBeTruthy())

    const commitButton = screen.getByText('fix: handle null session').closest('button')!
    fireEvent.contextMenu(commitButton)

    await waitFor(() => expect(screen.getByText('Undo commit')).toBeTruthy())
    await user.click(screen.getByText('Undo commit'))

    await waitFor(() => {
      expect(undoMock).toHaveBeenCalled()
    })
  })

  it('triggers revert commit when Revert commit is clicked', async () => {
    const user = userEvent.setup()
    const revertMock = mock(() => Promise.resolve(new Response(JSON.stringify({ workspace: WORKSPACE, sha: commitWithBody.sha, success: true }))))

    const originalFetch = globalThis.fetch
    globalThis.fetch = mock(async (input: unknown, init?: unknown) => {
      const url = String(input)
      if (url.includes('/workspace/git/revert')) {
        return revertMock()
      }
      return originalFetch(input as RequestInfo | URL, init as RequestInit)
    }) as typeof fetch

    await renderCommitsTab(false)

    await waitFor(() => expect(screen.getByText('fix: handle null session')).toBeTruthy())

    const commitButton = screen.getByText('fix: handle null session').closest('button')!
    fireEvent.contextMenu(commitButton)

    await waitFor(() => expect(screen.getByText('Revert commit')).toBeTruthy())
    await user.click(screen.getByText('Revert commit'))

    await waitFor(() => {
      expect(revertMock).toHaveBeenCalled()
    })
  })
})

// ── commits_ahead badge ───────────────────────────────────────────────────────

const statusWithDivergence = (ahead: number | null, behind: number | null) => ({
  workspace: WORKSPACE,
  name: 'project',
  is_git_repo: true,
  branch: 'main',
  commits_ahead: ahead,
  commits_behind: behind,
})

function makeFetch(ahead: number | null, behind: number | null = null) {
  return mock(async (input: unknown) => {
    const url = String(input)
    if (url.includes('/workspace/git/history')) return new Response(JSON.stringify(historyResponse))
    if (url.includes('/workspace/git-diff'))    return new Response(JSON.stringify(emptyDiff))
    if (url.includes('/workspace/files/list'))  return new Response(JSON.stringify({ workspace: WORKSPACE, truncated: false, files: [] }))
    if (url.includes('/workspace/git/commit-diff')) return new Response(JSON.stringify({ sha: commitWithBody.sha, diff: '' }))
    if (url.includes('/workspace/status'))      return new Response(JSON.stringify(statusWithDivergence(ahead, behind)))
    return new Response(null, { status: 404 })
  }) as typeof fetch
}

async function renderWithCommitsSubtab(ahead: number | null, behind: number | null = null) {
  globalThis.fetch = makeFetch(ahead, behind)
  const { CodingWorkspacePanel } = await import('@/components/CodingWorkspacePanel')
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  // Start on commits subtab so the trigger label shows the badge
  useGitPanelStore.getState().setSubTab(WORKSPACE, 'commits')

  await act(async () => {
    render(
      <QueryClientProvider client={queryClient}>
        <CodingWorkspacePanel
          workspace={WORKSPACE}
          open
          onClose={() => {}}
          onOpenPalette={() => {}}
          mobile={false}
        />
      </QueryClientProvider>,
    )
  })

  return { queryClient }
}


describe('CodingWorkspacePanel – commits_ahead badge', () => {
  beforeEach(() => {
    useGitPanelStore.setState({ workspaces: {} })
  })

  it('shows the badge in the dropdown trigger when commits subtab is active', async () => {
    await renderWithCommitsSubtab(3)

    await waitFor(() => {
      expect(screen.getByText('3↑')).toBeTruthy()
    })
  })

  it('hides the badge when commits_ahead is 0', async () => {
    await renderWithCommitsSubtab(0)

    // Give queries time to settle then assert no badge present
    await waitFor(() => expect(screen.getByText('Commits')).toBeTruthy())
    expect(screen.queryByText(/↑$/)).toBeNull()
  })

  it('hides the badge when commits_ahead is null (no upstream configured)', async () => {
    await renderWithCommitsSubtab(null)

    await waitFor(() => expect(screen.getByText('Commits')).toBeTruthy())
    expect(screen.queryByText(/↑$/)).toBeNull()
  })

  it('badge is sourced from /workspace/status — visible without the history query firing', async () => {
    // Core regression: badge data comes from /workspace/status (always-enabled),
    // not /workspace/git/history (only fetched on commits/tree subtab).
    // Even on the changes subtab the status query fires, so the data is ready
    // the moment the user switches to commits. We verify by staying on changes
    // and confirming history was never called, then switch to commits and check.
    const user = userEvent.setup()
    globalThis.fetch = makeFetch(2)
    const { CodingWorkspacePanel } = await import('@/components/CodingWorkspacePanel')
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

    useGitPanelStore.getState().setSubTab(WORKSPACE, 'changes')

    await act(async () => {
      render(
        <QueryClientProvider client={queryClient}>
          <CodingWorkspacePanel
            workspace={WORKSPACE}
            open
            onClose={() => {}}
            onOpenPalette={() => {}}
            mobile={false}
          />
        </QueryClientProvider>,
      )
    })

    // Wait for status query to settle (diff confirms render is stable)
    await waitFor(() => expect(screen.getByText('Changes (0)')).toBeTruthy())

    // History endpoint must NOT have been called yet (still on changes subtab)
    const callsBefore = (globalThis.fetch as ReturnType<typeof mock>).mock.calls
    const historyCalledBefore = callsBefore.some((args) => String(args[0]).includes('/workspace/git/history'))
    expect(historyCalledBefore).toBe(false)

    // Open the dropdown and switch to commits
    await user.click(screen.getByRole('button', { name: /changes/i }))
    await waitFor(() => expect(screen.getByText('Commits')).toBeTruthy())
    await user.click(screen.getByText('Commits'))

    // Badge should appear in the trigger immediately
    await waitFor(() => {
      expect(screen.getByText('2↑')).toBeTruthy()
    })
  })

  it('badge title uses singular "commit" for count of 1', async () => {
    await renderWithCommitsSubtab(1)

    const badge = await screen.findByText('1↑')
    await userEvent.hover(badge)
    expect((await screen.findByRole('tooltip')).textContent).toBe('1 local commit ahead of origin')
  })

  it('badge title uses plural "commits" for count > 1', async () => {
    await renderWithCommitsSubtab(5)

    const badge = await screen.findByText('5↑')
    await userEvent.hover(badge)
    expect((await screen.findByRole('tooltip')).textContent).toBe('5 local commits ahead of origin')
  })

  it('shows both ahead and behind badges when the branch diverged from origin', async () => {
    await renderWithCommitsSubtab(3, 2)

    await waitFor(() => {
      expect(screen.getByText('3↑')).toBeTruthy()
      expect(screen.getByText('2↓')).toBeTruthy()
    })
  })

  it('uses origin in the behind badge title', async () => {
    await renderWithCommitsSubtab(0, 1)

    const badge = await screen.findByText('1↓')
    await userEvent.hover(badge)
    expect((await screen.findByRole('tooltip')).textContent).toBe('1 commit behind origin')
  })
})
