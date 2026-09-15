/**
 * Chat workspaces in CodingWorkspacePanel.
 *
 * The chat root is the user's home directory and usually not a git repo, so
 * the dock must not present a Git review tab (or spend git probes on it) while
 * keeping file tabs and terminals available.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import type React from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const WORKSPACE = '/home/user'
const filesResponse = { workspace: WORKSPACE, truncated: true, files: [] }

const Icon = () => null
mock.module('lucide-react', () => ({
  Check: Icon, CheckSquare: Icon, ChevronDown: Icon, ChevronLeft: Icon, ChevronRight: Icon,
  ClipboardPaste: Icon, Copy: Icon, Download: Icon, ExternalLink: Icon, File: Icon, FileText: Icon,
  Folder: Icon, FolderOpen: Icon, GitCompare: Icon, Loader2: Icon, Plus: Icon,
  Pencil: Icon, RefreshCw: Icon, RotateCcw: Icon, Search: Icon, TerminalSquare: Icon, Undo2: Icon, X: Icon,
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

let requestedUrls: string[] = []

beforeEach(() => {
  requestedUrls = []
  globalThis.fetch = mock(async (input: unknown) => {
    const url = String(input)
    requestedUrls.push(url)
    if (url.includes('/workspace/files/list')) return new Response(JSON.stringify(filesResponse))
    return new Response(null, { status: 404 })
  }) as typeof fetch
})

afterEach(cleanup)

async function renderPanel(chatWorkspace: boolean) {
  const { CodingWorkspacePanel } = await import('@/components/CodingWorkspacePanel')
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => {
    render(
      <QueryClientProvider client={queryClient}>
        <CodingWorkspacePanel
          workspace={WORKSPACE}
          open
          chatWorkspace={chatWorkspace}
          onClose={() => {}}
        />
      </QueryClientProvider>,
    )
  })
}

describe('CodingWorkspacePanel chat workspace', () => {
  it('drops the Git tab and never probes git for a chat root', async () => {
    await renderPanel(true)

    expect(screen.queryByRole('button', { name: 'Git' })).toBeNull()
    expect(screen.getByText(/start a terminal/i)).toBeTruthy()
    expect(
      requestedUrls.filter(
        (url) =>
          url.includes('git-diff') ||
          url.includes('/workspace/status') ||
          url.includes('git/history'),
      ),
    ).toEqual([])
  })

  it('keeps the Git tab for coding workspaces', async () => {
    await renderPanel(false)

    expect(screen.getByRole('button', { name: 'Git' })).toBeTruthy()
    expect(screen.queryByText(/start a terminal/i)).toBeNull()
  })
})
