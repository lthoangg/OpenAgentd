/**
 * Terminal tabs in CodingWorkspacePanel — multi-instance + persistence.
 *
 * Sessions live in useTerminalStore (module-level), so tabs must:
 *  - open a numbered session per "New terminal" action,
 *  - focus the existing terminal on terminalOpenKey bumps (VS Code style),
 *  - close the *session* when the tab is closed,
 *  - be re-adopted from the store when the panel remounts (panel close /
 *    reopen must not kill or forget running terminals).
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import type React from 'react'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useGitPanelStore } from '@/stores/useGitPanelStore'
import { useTerminalStore, _resetTerminalStoreForTests } from '@/stores/useTerminalStore'

const WORKSPACE = '/repo/project'
const filesResponse = { workspace: WORKSPACE, truncated: false, files: [] }
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
mock.module('framer-motion', () => ({
  motion: {
    aside: ({ children, className, 'aria-label': ariaLabel }: { children: React.ReactNode; className?: string; 'aria-label'?: string }) => (
      <aside className={className} aria-label={ariaLabel}>{children}</aside>
    ),
  },
}))
// Keep sessions in 'connecting' (never resolves) — these tests only assert
// tab bookkeeping, not the transport.
mock.module('@/api/terminal', () => ({
  connectTerminal: mock(() => new Promise(() => {})),
}))

beforeEach(() => {
  _resetTerminalStoreForTests()
  useGitPanelStore.setState({ workspaces: {} })
  globalThis.fetch = mock(async (input: unknown) => {
    const url = String(input)
    if (url.includes('/workspace/files/list')) return new Response(JSON.stringify(filesResponse))
    if (url.includes('/workspace/git-diff')) return new Response(JSON.stringify(diffResponse))
    if (url.includes('/workspace/status')) return new Response(JSON.stringify({ workspace: WORKSPACE }))
    return new Response(null, { status: 404 })
  }) as typeof fetch
})
afterEach(cleanup)

async function renderPanel(terminalOpenKey = 0) {
  const { CodingWorkspacePanel } = await import('@/components/CodingWorkspacePanel')
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  let result: ReturnType<typeof render>
  await act(async () => {
    result = render(
      <QueryClientProvider client={queryClient}>
        <CodingWorkspacePanel workspace={WORKSPACE} open terminalOpenKey={terminalOpenKey} onClose={() => {}} />
      </QueryClientProvider>,
    )
  })
  return result!
}

describe('CodingWorkspacePanel terminal tabs', () => {
  it('terminalOpenKey bump opens a store-backed session and tab', async () => {
    await renderPanel(1)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Close Terminal 1' })).toBeTruthy())
    const termBtn = screen.getByRole('button', { name: 'Terminal 1' })
    const termTabContainer = termBtn.closest('div')
    expect(termTabContainer?.className).toContain('border-(--color-border-strong)')
    expect(useTerminalStore.getState().sessionsForContext(WORKSPACE)).toHaveLength(1)
  })

  it('"New terminal" button opens additional numbered sessions', async () => {
    await renderPanel(1)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Close Terminal 1' })).toBeTruthy())

    await act(async () => {
      screen.getByRole('button', { name: 'New terminal' }).click()
    })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Close Terminal 2' })).toBeTruthy())
    expect(useTerminalStore.getState().sessionsForContext(WORKSPACE)).toHaveLength(2)
  })

  it('closing a terminal tab closes its session', async () => {
    await renderPanel(1)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Close Terminal 1' })).toBeTruthy())

    await act(async () => {
      screen.getByRole('button', { name: 'Close Terminal 1' }).click()
    })
    expect(screen.queryByRole('button', { name: 'Close Terminal 1' })).toBeNull()
    expect(useTerminalStore.getState().sessionsForContext(WORKSPACE)).toHaveLength(0)
  })

  it('remount re-adopts live sessions from the store as tabs', async () => {
    // Session opened before the panel mounts (e.g. panel was closed and
    // reopened) — the tab must reappear and the session must survive.
    useTerminalStore.getState().open({ workspace: WORKSPACE }, WORKSPACE)
    const view = await renderPanel(0)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Close Terminal 1' })).toBeTruthy())

    view.unmount()
    expect(useTerminalStore.getState().sessionsForContext(WORKSPACE)).toHaveLength(1)

    await renderPanel(0)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Close Terminal 1' })).toBeTruthy())
  })

  it('closing a terminal tab and reopening panel keeps terminal closed', async () => {
    const handledRef = { current: 0 }
    const { CodingWorkspacePanel } = await import('@/components/CodingWorkspacePanel')
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

    // Open terminal via terminalOpenKey bump = 1
    let view: ReturnType<typeof render>
    await act(async () => {
      view = render(
        <QueryClientProvider client={queryClient}>
          <CodingWorkspacePanel
            workspace={WORKSPACE}
            open
            terminalOpenKey={1}
            handledTerminalOpenKeyRef={handledRef}
            onClose={() => {}}
          />
        </QueryClientProvider>,
      )
    })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Close Terminal 1' })).toBeTruthy())

    // Close the terminal tab
    await act(async () => {
      screen.getByRole('button', { name: 'Close Terminal 1' }).click()
    })
    expect(screen.queryByRole('button', { name: 'Close Terminal 1' })).toBeNull()
    expect(useTerminalStore.getState().sessionsForContext(WORKSPACE)).toHaveLength(0)

    // Close panel (unmount)
    view!.unmount()

    // Reopen panel (terminalOpenKey remains 1 in parent state)
    await act(async () => {
      render(
        <QueryClientProvider client={queryClient}>
          <CodingWorkspacePanel
            workspace={WORKSPACE}
            open
            terminalOpenKey={1}
            handledTerminalOpenKeyRef={handledRef}
            onClose={() => {}}
          />
        </QueryClientProvider>,
      )
    })

    // Terminal tab should NOT reopen
    expect(screen.queryByRole('button', { name: /Close Terminal/ })).toBeNull()
    expect(useTerminalStore.getState().sessionsForContext(WORKSPACE)).toHaveLength(0)
  })

  it('sessions from other contexts are not adopted', async () => {
    useTerminalStore.getState().open({ sessionId: 'sid-1' }, 'session:sid-1')
    await renderPanel(0)
    expect(screen.queryByRole('button', { name: /Close Terminal/ })).toBeNull()
  })
})
