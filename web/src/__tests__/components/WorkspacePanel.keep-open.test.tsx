/**
 * A closed review dock stays mounted (the shell keeps it after its first
 * open): its tabs and the last active tab survive the close, it parks
 * hidden and inert once the close tween is done, and its keys are off.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import type React from 'react'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useGitPanelStore } from '@/stores/useGitPanelStore'
import type { WorkspaceFileInfo } from '@/api/types'

const WORKSPACE = '/repo/project'
const readme: WorkspaceFileInfo = { path: 'main.ts', name: 'main.ts', size: 24, mtime: 1, mime: 'text/plain' }
const other: WorkspaceFileInfo = { path: 'other.ts', name: 'other.ts', size: 12, mtime: 1, mime: 'text/plain' }
const filesResponse = { workspace: WORKSPACE, truncated: false, files: [readme, other] }
const diffResponse = { workspace: WORKSPACE, is_git_repo: false, diff: '', untracked: [] as string[] }

const Icon = () => null
mock.module('lucide-react', () => ({
  AlertTriangle: Icon, CheckCircle2: Icon, Info: Icon,
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
  Pencil: Icon, RefreshCw: Icon, RotateCcw: Icon, Search: Icon, TerminalSquare: Icon, Eraser: Icon, Undo2: Icon, X: Icon,
}))
mock.module('@/hooks/useReducedMotion', () => ({ useReducedMotion: () => false }))
mock.module('@/hooks/use-platform', () => ({
  usePlatform: () => ({ isTauri: false, os: 'linux', isMacOverlay: false }),
  getPlatform: () => ({ isTauri: false, os: 'linux', isMacOverlay: false }),
}))
mock.module('@/lib/pdfjs-loader', () => ({
  loadPdfjs: async () => ({
    getDocument: () => ({
      promise: Promise.resolve({
        numPages: 1,
        getPage: async () => ({
          getViewport: ({ scale }: { scale: number }) => ({ width: 100 * scale, height: 140 * scale }),
          render: () => ({ promise: Promise.resolve(), cancel: () => {} }),
        }),
      }),
    }),
  }),
}))
mock.module('framer-motion', () => ({
  motion: {
    aside: ({ children, className, 'aria-label': ariaLabel }: { children: React.ReactNode; className?: string; 'aria-label'?: string }) => (
      <aside className={className} aria-label={ariaLabel}>{children}</aside>
    ),
  },
}))

beforeEach(() => {
  useGitPanelStore.setState({ workspaces: {} })
  globalThis.fetch = mock(async (input: unknown) => {
    const url = String(input)
    if (url.includes('/workspace/files/list')) return new Response(JSON.stringify(filesResponse))
    if (url.includes('/workspace/files/read')) return new Response('const x = 1')
    if (url.includes('/workspace/git-diff')) return new Response(JSON.stringify(diffResponse))
    if (url.includes('/workspace/status')) return new Response(JSON.stringify({ workspace: WORKSPACE }))
    return new Response(null, { status: 404 })
  }) as typeof fetch
})
afterEach(cleanup)

function panel(queryClient: QueryClient, open: boolean, onFileSelect = () => {}) {
  return (
    <QueryClientProvider client={queryClient}>
      <WorkspacePanelRef.current
        workspace={WORKSPACE}
        open={open}
        selectedFilePath={readme.path}
        selectedFileOpenKey={1}
        onFileSelect={onFileSelect}
      />
    </QueryClientProvider>
  )
}

const WorkspacePanelRef: { current: typeof import('@/components/WorkspacePanel').WorkspacePanel } = { current: (() => null) as never }

const dock = () => document.querySelector('[data-review-dock]') as HTMLElement
const fileTab = () => screen.getByRole('button', { name: readme.name, hidden: true })

describe('closed review dock', () => {
  it('keeps its tabs and last active tab, parks inert, and ignores Ctrl+W until reopened', async () => {
    WorkspacePanelRef.current = (await import('@/components/WorkspacePanel')).WorkspacePanel
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    let rerender: (ui: React.ReactElement) => void = () => {}
    await act(async () => {
      rerender = render(panel(queryClient, true)).rerender
    })
    await waitFor(() => expect(fileTab().getAttribute('aria-current')).toBe('true'))

    await act(async () => { rerender(panel(queryClient, false)) })
    // Still mounted; not inert until the close tween is done.
    expect(fileTab()).toBeTruthy()
    expect(dock().hasAttribute('inert')).toBe(false)
    await waitFor(() => expect(dock().hasAttribute('inert')).toBe(true))
    expect(dock().closest('aside')?.className).toContain('invisible')

    // Ctrl+W must not close a tab in a dock the user cannot see.
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', ctrlKey: true, bubbles: true, cancelable: true })) })
    expect(fileTab()).toBeTruthy()

    await act(async () => { rerender(panel(queryClient, true)) })
    expect(dock().hasAttribute('inert')).toBe(false)
    expect(dock().closest('aside')?.className).not.toContain('invisible')
    // The file tab is still the active one: reopening does not fall back to Git.
    expect(fileTab().getAttribute('aria-current')).toBe('true')
  })
})
