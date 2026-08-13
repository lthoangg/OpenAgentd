/**
 * Cmd+W / Ctrl+W closes the active file tab instead of propagating
 * to the desktop (where it would close the app window).
 *
 * Platform note: the test environment resolves to os='unknown', which
 * takes the non-macOS branch in isPrimaryShortcut — so the primary
 * modifier here is Ctrl (same as Windows/Linux). macOS behaviour is
 * the same pattern, just metaKey instead of ctrlKey.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import type React from 'react'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useGitPanelStore } from '@/stores/useGitPanelStore'
import type { WorkspaceFileInfo } from '@/api/types'

const WORKSPACE = '/repo/project'
const readme: WorkspaceFileInfo = { path: 'main.ts', name: 'main.ts', size: 24, mtime: 1, mime: 'text/plain' }
const filesResponse = { workspace: WORKSPACE, truncated: false, files: [readme] }
const diffResponse = { workspace: WORKSPACE, is_git_repo: false, diff: '', untracked: [] as string[] }

const Icon = () => null
mock.module('lucide-react', () => ({
  Check: Icon, ChevronDown: Icon, ChevronLeft: Icon, ChevronRight: Icon,
  Copy: Icon, Download: Icon, ExternalLink: Icon, File: Icon, FileText: Icon,
  Folder: Icon, FolderOpen: Icon, GitCompare: Icon, Loader2: Icon, Plus: Icon,
  Pencil: Icon, RefreshCw: Icon, RotateCcw: Icon, Search: Icon, TerminalSquare: Icon, Undo2: Icon, X: Icon,
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

function buildKeyEvent(key: string, opts: { ctrlKey?: boolean; metaKey?: boolean } = {}): KeyboardEvent {
  return new KeyboardEvent('keydown', {
    key,
    ctrlKey: opts.ctrlKey ?? false,
    metaKey: opts.metaKey ?? false,
    shiftKey: false,
    bubbles: true,
    cancelable: true,
  })
}

async function renderWithOpenFileTab() {
  const { CodingWorkspacePanel } = await import('@/components/CodingWorkspacePanel')
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => {
    render(
      <QueryClientProvider client={queryClient}>
        <CodingWorkspacePanel
          workspace={WORKSPACE}
          open
          selectedFilePath={readme.path}
          selectedFileOpenKey={1}
          onFileSelect={() => {}}
          onClose={() => {}}
        />
      </QueryClientProvider>,
    )
  })
  // Wait for the file tab to open (file name appears as a tab button)
  await waitFor(() =>
    expect(screen.getByRole('button', { name: `Close ${readme.name}` })).toBeTruthy()
  )
}

describe('CodingWorkspacePanel Cmd+W / Ctrl+W closes the active file tab', () => {
  it('calls onFileSelect(null) on Ctrl+W so the parent clears its file state (prevents re-open bug)', async () => {
    // Regression: Cmd+W only cleared local tab state but never notified the
    // parent. When the panel was closed then reopened the parent still held
    // codingFileViewer, so the tab was immediately re-opened on mount.
    const { CodingWorkspacePanel } = await import('@/components/CodingWorkspacePanel')
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const onFileSelect = mock(() => {})
    await act(async () => {
      render(
        <QueryClientProvider client={queryClient}>
          <CodingWorkspacePanel
            workspace={WORKSPACE}
            open
            selectedFilePath={readme.path}
            selectedFileOpenKey={1}
            onFileSelect={onFileSelect}
            onClose={() => {}}
          />
        </QueryClientProvider>,
      )
    })
    await waitFor(() =>
      expect(screen.getByRole('button', { name: `Close ${readme.name}` })).toBeTruthy()
    )
    // onFileSelect(file) was called when the tab was opened — reset the mock
    onFileSelect.mockClear()

    await act(async () => { document.dispatchEvent(buildKeyEvent('w', { ctrlKey: true })) })

    // Must notify parent with null so it can clear codingFileViewer
    expect(onFileSelect).toHaveBeenCalledTimes(1)
    expect(onFileSelect).toHaveBeenCalledWith(null)
  })

  it('closes the active file tab on Ctrl+W (non-macOS primary shortcut)', async () => {
    await renderWithOpenFileTab()

    // File tab is open — close button exists
    expect(screen.getByRole('button', { name: `Close ${readme.name}` })).toBeTruthy()

    const event = buildKeyEvent('w', { ctrlKey: true })
    await act(async () => { document.dispatchEvent(event) })

    // Tab should be closed — close button gone, back to Git tab
    expect(screen.queryByRole('button', { name: `Close ${readme.name}` })).toBeNull()
    // The event must be consumed so the browser/desktop doesn't also act on it
    expect(event.defaultPrevented).toBe(true)
  })

  it('does NOT close the tab on plain W (no modifier)', async () => {
    await renderWithOpenFileTab()

    await act(async () => {
      document.dispatchEvent(buildKeyEvent('w'))
    })

    // Tab still open
    expect(screen.getByRole('button', { name: `Close ${readme.name}` })).toBeTruthy()
  })

  it('does nothing when the Git review tab is active (no file tab to close)', async () => {
    // Render without a pre-opened file tab — the Git tab is active
    const { CodingWorkspacePanel } = await import('@/components/CodingWorkspacePanel')
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    await act(async () => {
      render(
        <QueryClientProvider client={queryClient}>
          <CodingWorkspacePanel
            workspace={WORKSPACE}
            open
            onClose={() => {}}
          />
        </QueryClientProvider>,
      )
    })

    // No file tab close button present
    expect(screen.queryByRole('button', { name: /^Close / })).toBeNull()

    const event = buildKeyEvent('w', { ctrlKey: true })
    await act(async () => { document.dispatchEvent(event) })

    // Still no close button — nothing exploded
    expect(screen.queryByRole('button', { name: /^Close / })).toBeNull()
    // Event NOT consumed — the review tab can't be closed, so don't intercept
    expect(event.defaultPrevented).toBe(false)
  })
})
