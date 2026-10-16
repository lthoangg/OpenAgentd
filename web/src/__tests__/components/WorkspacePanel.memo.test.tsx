/**
 * The dock re-renders whenever its measured center width changes (window or
 * sidebar resize). The Git list views are memoized with stable props so those
 * re-renders do not re-run every changed-file row.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import type React from 'react'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useGitPanelStore } from '@/stores/useGitPanelStore'

const WORKSPACE = '/repo/project'
const DIFF = [
  'diff --git a/src/app.ts b/src/app.ts',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -1 +1 @@',
  '-const before = 2',
  '+const after = 3',
].join('\n')

let iconRenders = 0
mock.module('@/components/FileTypeIcon', () => ({
  FileTypeIcon: () => {
    iconRenders += 1
    return null
  },
}))
const Icon = () => null
mock.module('lucide-react', () => ({
  Globe: Icon, ArrowRight: Icon, MousePointerClick: Icon, RotateCw: Icon, Smartphone: Icon, SquareTerminal: Icon, Send: Icon, Bot: Icon,
  CalendarClock: Icon, ListTodo: Icon, Unlink: Icon, MessageSquarePlus: Icon, FileVideo: Icon, ImageOff: Icon,
  AlertCircle: Icon, ArrowLeft: Icon, CalendarIcon: Icon, Circle: Icon, Clock: Icon, Minus: Icon,
  Pause: Icon, Play: Icon, Terminal: Icon, Trash2: Icon, Zap: Icon,
  ChevronDownIcon: Icon, ChevronLeftIcon: Icon, ChevronRightIcon: Icon,
  Check: Icon, ChevronDown: Icon, ChevronLeft: Icon, ChevronRight: Icon,
  ChevronsDownUp: Icon, ChevronsUpDown: Icon,
  Copy: Icon, Download: Icon, ExternalLink: Icon, File: Icon, FileDiff: Icon, FileHeadphone: Icon, FileText: Icon,
  Folder: Icon, FolderOpen: Icon, GitCommitHorizontal: Icon, GitCompare: Icon, Loader2: Icon,
  Maximize2: Icon, Minimize2: Icon, Plus: Icon,
  Pencil: Icon, RefreshCw: Icon, RotateCcw: Icon, Search: Icon, TerminalSquare: Icon, Eraser: Icon, Undo2: Icon, X: Icon,
}))
mock.module('@/hooks/useReducedMotion', () => ({ useReducedMotion: () => false }))
mock.module('@/hooks/use-platform', () => ({
  usePlatform: () => ({ isTauri: false, os: 'linux', isMacOverlay: false }),
  getPlatform: () => ({ isTauri: false, os: 'linux', isMacOverlay: false }),
}))
mock.module('framer-motion', () => ({
  motion: {
    aside: ({ children, className, 'aria-label': ariaLabel }: { children: React.ReactNode; className?: string; 'aria-label'?: string }) => (
      <aside className={className} aria-label={ariaLabel}>{children}</aside>
    ),
  },
}))

beforeEach(() => {
  iconRenders = 0
  useGitPanelStore.setState({ workspaces: {} })
  globalThis.fetch = mock(async (input: unknown) => {
    const url = String(input)
    if (url.includes('/workspace/files/list')) return new Response(JSON.stringify({ workspace: WORKSPACE, truncated: false, files: [] }))
    if (url.includes('/workspace/git-diff')) return new Response(JSON.stringify({ workspace: WORKSPACE, is_git_repo: true, diff: DIFF, untracked: [] }))
    if (url.includes('/workspace/status')) return new Response(JSON.stringify({ workspace: WORKSPACE, name: 'project', is_git_repo: true }))
    return new Response(null, { status: 404 })
  }) as typeof fetch
})
afterEach(cleanup)

describe('Review dock list memoization', () => {
  it('does not re-render changed-file rows when only the dock width changes', async () => {
    const { WorkspacePanel } = await import('@/components/WorkspacePanel')
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const panel = (centerWidth: number) => (
      <QueryClientProvider client={queryClient}>
        <WorkspacePanel workspace={WORKSPACE} open centerWidth={centerWidth} viewRequest={{ view: 'review', key: 1 }} />
      </QueryClientProvider>
    )
    let rerender: (ui: React.ReactElement) => void = () => {}
    await act(async () => {
      rerender = render(panel(1000)).rerender
    })
    await waitFor(() => expect(screen.getByRole('button', { name: /diff for src\/app\.ts/ })).toBeTruthy())
    const settled = iconRenders
    expect(settled).toBeGreaterThan(0)

    await act(async () => { rerender(panel(1100)) })
    await act(async () => { rerender(panel(1200)) })

    expect(iconRenders).toBe(settled)
  })
})
