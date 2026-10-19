/**
 * Changes tab — per-file addition/deletion counters.
 *
 * Companion to DiffPreview.test.tsx: `collectChangedFiles` used the same
 * flawed `---`/`+++` prefix checks, so removed/added lines whose content
 * starts with `--`/`++` (YAML frontmatter, `counter--;`) were missing from
 * the +N/-N badges shown next to each changed file.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import type React from 'react'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useGitPanelStore } from '@/stores/useGitPanelStore'
import { _resetTerminalStoreForTests } from '@/stores/useTerminalStore'

const WORKSPACE = '/repo/project'
// Old file: ---, title: hello, ---, body, counter--;  → 4 deletions
// New file: title: hello, body2, counter++;           → 2 additions
const DIFF = [
  'diff --git a/doc.md b/doc.md',
  'index 26807bb..ad621fb 100644',
  '--- a/doc.md',
  '+++ b/doc.md',
  '@@ -1,5 +1,3 @@',
  '----',
  ' title: hello',
  '----',
  '-body',
  '-counter--;',
  '+body2',
  '+counter++;',
].join('\n')

const filesResponse = { workspace: WORKSPACE, truncated: false, files: [] }
const diffResponse = { workspace: WORKSPACE, is_git_repo: true, diff: DIFF, untracked: [] as string[] }

const Icon = () => null
mock.module('lucide-react', () => ({
  Globe: Icon, ArrowRight: Icon, MousePointerClick: Icon, RotateCw: Icon, Smartphone: Icon, SquareTerminal: Icon, Send: Icon, Bot: Icon,
  CalendarClock: Icon, ListTodo: Icon, MessageCircleQuestion: Icon, Square: Icon, Unlink: Icon, MessageSquarePlus: Icon, FileVideo: Icon, ImageOff: Icon,
  AlertCircle: Icon, ArrowLeft: Icon, CalendarIcon: Icon, Circle: Icon, Clock: Icon, Minus: Icon,
  Pause: Icon, Play: Icon, Terminal: Icon, Trash2: Icon, Zap: Icon,
  ChevronDownIcon: Icon, ChevronLeftIcon: Icon, ChevronRightIcon: Icon,
  Check: Icon, ChevronDown: Icon, ChevronLeft: Icon, ChevronRight: Icon,
  ChevronsDownUp: Icon, ChevronsUpDown: Icon,
  Copy: Icon, Download: Icon, ExternalLink: Icon, File: Icon, FileDiff: Icon, FileHeadphone: Icon, FileText: Icon,
  Folder: Icon, FolderOpen: Icon, GitCommitHorizontal: Icon, GitCompare: Icon, Loader2: Icon,
  Maximize2: Icon, Minimize2: Icon, Plus: Icon,
  Pencil: Icon, RefreshCw: Icon, RotateCcw: Icon, Search: Icon,
  TerminalSquare: Icon, Eraser: Icon, Undo2: Icon, X: Icon,
}))
mock.module('@/hooks/useReducedMotion', () => ({ useReducedMotion: () => false }))
mock.module('framer-motion', () => ({
  motion: {
    aside: ({ children, className }: { children: React.ReactNode; className?: string }) => (
      <aside className={className}>{children}</aside>
    ),
  },
}))
mock.module('@/api/terminal', () => ({ connectTerminal: mock(() => new Promise(() => {})) }))

beforeEach(() => {
  _resetTerminalStoreForTests()
  useGitPanelStore.setState({ workspaces: {} })
  globalThis.fetch = mock(async (input: unknown) => {
    const url = String(input)
    if (url.includes('/workspace/files/list')) return new Response(JSON.stringify(filesResponse))
    if (url.includes('/workspace/git-diff')) return new Response(JSON.stringify(diffResponse))
    if (url.includes('/workspace/status')) return new Response(JSON.stringify({ workspace: WORKSPACE }))
    if (url.includes('/workspace/git/history')) return new Response(JSON.stringify({ workspace: WORKSPACE, is_git_repo: true, commits: [], graph: '', next_cursor: null }))
    return new Response(null, { status: 404 })
  }) as typeof fetch
})
afterEach(cleanup)

describe('Changes tab counters', () => {
  it('counts removed/added lines whose content starts with -- or ++', async () => {
    const { WorkspacePanel } = await import('@/components/WorkspacePanel')
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    await act(async () => {
      render(
        <QueryClientProvider client={queryClient}>
          <WorkspacePanel workspace={WORKSPACE} open viewRequest={{ view: 'review', key: 1 }} />
        </QueryClientProvider>,
      )
    })
    const row = await waitFor(() => {
      const button = screen.getByRole('button', { name: /diff for doc\.md/ })
      expect(button).toBeTruthy()
      return button
    })
    expect(row.textContent).toContain('+2')
    expect(row.textContent).toContain('-4')
  })
})
