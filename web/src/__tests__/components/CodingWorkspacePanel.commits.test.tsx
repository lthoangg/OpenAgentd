import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import type React from 'react'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useGitPanelStore } from '@/stores/useGitPanelStore'

const WORKSPACE = '/repo/project'

const Icon = () => null
mock.module('lucide-react', () => ({
  Check: Icon,
  ChevronDown: Icon,
  ChevronRight: Icon,
  Copy: Icon,
  Download: Icon,
  ExternalLink: Icon,
  FileText: Icon,
  Folder: Icon,
  GitBranch: Icon,
  GitCompare: Icon,
  Loader2: Icon,
  Plus: Icon,
  RefreshCw: Icon,
  Search: Icon,
  X: Icon,
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

async function renderCommitsTab() {
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
    await user.click(screen.getByText('fix: handle null session'))
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
