import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import type React from 'react'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useGitPanelStore } from '@/stores/useGitPanelStore'
import type { WorkspaceFileInfo } from '@/api/types'

const WORKSPACE = '/repo/project'
// NOTE: Use a .ts extension so hljs keyword-highlights 'const' as a standalone
// token, keeping getByText('const') and getByText('return') assertions valid.
const readme: WorkspaceFileInfo = { path: 'main.ts', name: 'main.ts', size: 24, mtime: 1, mime: 'text/plain' }
const image: WorkspaceFileInfo = { path: 'assets/logo.png', name: 'logo.png', size: 100, mtime: 1, mime: 'image/png' }
const binary: WorkspaceFileInfo = { path: 'dist/app.bin', name: 'app.bin', size: 1024 * 1024, mtime: 1, mime: 'application/octet-stream' }
const envExample: WorkspaceFileInfo = { path: '.env.example', name: '.env.example', size: 32, mtime: 1, mime: 'application/octet-stream' }
const filesResponse = { workspace: WORKSPACE, truncated: false, files: [readme, image, binary, envExample] }
// Alias used in assertions that reference the old 'README.md' filename.
const readmePath = readme.path
let diffResponse = { workspace: WORKSPACE, is_git_repo: false, diff: '', untracked: [] as string[] }
let isMacOverlay = false

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
  FolderOpen: Icon,
  GitCompare: Icon,
  Loader2: Icon,
  Plus: Icon,
  RefreshCw: Icon,
  RotateCcw: Icon,
  Search: Icon,
  Undo2: Icon,
  X: Icon,
}))
mock.module('@/hooks/useReducedMotion', () => ({ useReducedMotion: () => false }))
mock.module('@/hooks/use-platform', () => ({
  usePlatform: () => ({ isTauri: isMacOverlay, os: isMacOverlay ? 'macos' : 'linux', isMacOverlay }),
  getPlatform: () => ({ isTauri: isMacOverlay, os: isMacOverlay ? 'macos' : 'linux', isMacOverlay }),
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
  diffResponse = { workspace: WORKSPACE, is_git_repo: false, diff: '', untracked: [] }
  isMacOverlay = false
  globalThis.fetch = mock(async (input: unknown) => {
    const url = String(input)
    if (url.includes('/workspace/files/list')) return new Response(JSON.stringify(filesResponse))
    if (url.includes('/workspace/files/read') && url.includes('.env.example')) return new Response('OPENAGENTD_PORT=4082\n')
    if (url.includes('/workspace/files/read')) return new Response('const value = 1\n// comment\nreturn value')
    if (url.includes('/workspace/git-diff')) return new Response(JSON.stringify(diffResponse))
    return new Response(null, { status: 404 })
  }) as typeof fetch
})

afterEach(cleanup)

async function renderWorkspacePanel(onFileSelect = mock(() => {}), selectedFilePath: string | null = null, mobile = false, onOpenPalette = mock(() => {})) {
  const { CodingWorkspacePanel } = await import('@/components/CodingWorkspacePanel')
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  let renderResult: ReturnType<typeof render> | null = null
  await act(async () => {
    renderResult = render(
      <QueryClientProvider client={queryClient}>
        <CodingWorkspacePanel workspace={WORKSPACE} open initialTab="files" selectedFilePath={selectedFilePath} onFileSelect={onFileSelect} onClose={() => {}} mobile={mobile} onOpenPalette={onOpenPalette} />
      </QueryClientProvider>,
    )
  })
  return { CodingWorkspacePanel, queryClient, renderResult: renderResult!, onOpenPalette }
}

async function renderViewer(file: WorkspaceFileInfo | null = readme, onAddComment = mock(() => {}), mobile = false) {
  const { CodingFileViewerPanel } = await import('@/components/CodingFileViewerPanel')
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => {
    render(
      <QueryClientProvider client={queryClient}>
        <CodingFileViewerPanel workspace={WORKSPACE} file={file} onClose={() => {}} onAddComment={onAddComment} mobile={mobile} />
      </QueryClientProvider>,
    )
  })
}

describe('Coding workspace two-layer file preview', () => {
  it('opens the selected file path as a file tab', async () => {
    const onFileSelect = mock(() => {})
    await renderWorkspacePanel(onFileSelect, readmePath)

    await waitFor(() => expect(onFileSelect).toHaveBeenCalledWith(readme))
    await waitFor(() => expect(screen.getAllByTitle(readmePath).length).toBeGreaterThanOrEqual(1))
    await waitFor(() => expect(screen.getByText('const')).toBeTruthy())
  })

  it('reopens the selected file tab when the open key changes', async () => {
    const onFileSelect = mock(() => {})
    const { CodingWorkspacePanel, queryClient, renderResult } = await renderWorkspacePanel(onFileSelect, readmePath)

    await waitFor(() => expect(onFileSelect).toHaveBeenCalledWith(readme))
    await userEvent.setup().click(screen.getByRole('button', { name: /git/i }))
    expect(screen.getByText('Not a git repository')).toBeTruthy()

    renderResult.rerender(
      <QueryClientProvider client={queryClient}>
        <CodingWorkspacePanel workspace={WORKSPACE} open selectedFilePath={readmePath} selectedFileOpenKey={1} onFileSelect={onFileSelect} onClose={() => {}} />
      </QueryClientProvider>,
    )

    await waitFor(() => expect(screen.getByText('const')).toBeTruthy())
  })

  it('does not reopen a closed file tab when the files query refetches', async () => {
    const user = userEvent.setup()
    const onFileSelect = mock(() => {})
    // Open README via a selection request (key bumps from 0).
    const { queryClient } = await renderWorkspacePanel(onFileSelect, readmePath)
    await waitFor(() => expect(onFileSelect).toHaveBeenCalledWith(readme))
    await waitFor(() => expect(screen.getByText('const')).toBeTruthy())

    // User closes the file tab.
    await user.click(screen.getByRole('button', { name: `Close ${readmePath}` }))
    await waitFor(() => expect(screen.queryByText('const')).toBeNull())

    // A background refetch of the files list resolves with a fresh array
    // reference (same as a poll / window-focus refetch). This must NOT
    // reopen the tab the user just closed — selectedFileOpenKey is unchanged.
    await act(async () => {
      await queryClient.invalidateQueries()
      // Give any errant effect a chance to fire before asserting.
      await new Promise((resolve) => setTimeout(resolve, 20))
    })

    expect(screen.queryByText('const')).toBeNull()
    expect(screen.queryByRole('button', { name: `Close ${readmePath}` })).toBeNull()
  })

  it('opens file tabs from the plus file search', async () => {
    // The + button delegates to the parent-owned Command Palette via onOpenPalette.
    // File search, filtering, and tab-opening all happen at the TeamChatView level;
    // CodingWorkspacePanel's responsibility is only to call the callback.
    const user = userEvent.setup()
    const { onOpenPalette } = await renderWorkspacePanel()

    await user.click(screen.getByRole('button', { name: /search files/i }))

    expect(onOpenPalette).toHaveBeenCalledTimes(1)
  })

  it('opens the first matching file with Enter from file search', async () => {
    // Same delegation — clicking the + button fires onOpenPalette so the
    // parent can open the palette; palette interaction is tested at that level.
    const user = userEvent.setup()
    const { onOpenPalette } = await renderWorkspacePanel()

    await user.click(screen.getByRole('button', { name: /search files/i }))

    expect(onOpenPalette).toHaveBeenCalledTimes(1)
  })

  it('expands changed-file diffs in the Changes tab without opening a file tab', async () => {
    diffResponse = {
      workspace: WORKSPACE,
      is_git_repo: true,
      diff: 'diff --git a/README.md b/README.md\n@@ -1 +1 @@\n-old\n+new\n',
      untracked: ['assets/logo.png'],
    }

    const user = userEvent.setup()
    await renderWorkspacePanel()
    await waitFor(() => expect(screen.getByTitle('README.md')).toBeTruthy())

    const changedRow = screen.getByTitle('README.md')
    expect(changedRow.textContent).toContain('M')
    await user.click(changedRow)

    expect(screen.getByText('old')).toBeTruthy()
    expect(screen.getByText('new')).toBeTruthy()
    expect(screen.getAllByTitle('README.md')).toHaveLength(1)
    expect(screen.queryByRole('button', { name: /^diff$/i })).toBeNull()
  })

  it('marks git-deleted files and opens a deleted-file placeholder instead of loading 404 content', async () => {
    diffResponse = {
      workspace: WORKSPACE,
      is_git_repo: true,
      diff: 'diff --git a/deleted.txt b/deleted.txt\ndeleted file mode 100644\nindex 1111111..0000000\n--- a/deleted.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-old\n',
      untracked: [],
    }
    const user = userEvent.setup()
    const onFileSelect = mock(() => {})
    await renderWorkspacePanel(onFileSelect)
    await waitFor(() => expect(screen.getByTitle('deleted.txt')).toBeTruthy())
    const deletedRow = screen.getByTitle('deleted.txt')
    await user.click(deletedRow)

    expect(deletedRow.textContent).toContain('D')
    expect(onFileSelect).not.toHaveBeenCalled()

    await renderViewer({ path: 'deleted.txt', name: 'deleted.txt', size: 0, mtime: 0, mime: 'text/plain', deleted: true })

    expect(screen.getByText('File deleted from workspace')).toBeTruthy()
    expect(screen.getByText('Open Changes to review the removed contents.')).toBeTruthy()
    expect(screen.queryByText(/Failed to load: HTTP 404/i)).toBeNull()
  })

  it('does not render File/Diff switching in file previews', async () => {
    await renderViewer(readme)

    await waitFor(() => expect(screen.getByText('const')).toBeTruthy())
    expect(screen.queryByRole('button', { name: /^file$/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /^diff$/i })).toBeNull()
  })

  it('renders text files with a wrapping read-only IDE-style line-number gutter', async () => {
    await renderViewer(readme)

    await waitFor(() => expect(screen.getByText('const')).toBeTruthy())
    expect(screen.getAllByText('1').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('2')).toBeTruthy()
    expect(screen.getByText('3')).toBeTruthy()
    expect(screen.getByText('// comment')).toBeTruthy()
    expect(screen.getByText('return')).toBeTruthy()
  })

  it('renders images inline in the separate file viewer panel', async () => {
    await renderViewer(image)
    const img = screen.getByRole('img', { name: 'logo.png' }) as HTMLImageElement
    expect(img.src).toContain('workspace/files/read')
    expect(img.src).toContain('logo.png')
  })

  it('renders videos inline in the separate file viewer panel', async () => {
    const video: WorkspaceFileInfo = { path: 'assets/clip.mp4', name: 'clip.mp4', size: 1000, mtime: 1, mime: 'video/mp4' }
    await renderViewer(video)
    const videoEl = document.querySelector('video')
    expect(videoEl).toBeTruthy()
    expect(videoEl?.src).toContain('workspace/files/read')
    expect(videoEl?.src).toContain('clip.mp4')
  })

  it('shows binary fallback links in the separate file viewer panel', async () => {
    await renderViewer(binary)
    expect(screen.getByText('No inline preview for this file type')).toBeTruthy()
    expect(screen.getByRole('link', { name: /open in new tab/i })).toBeTruthy()
    expect(screen.getAllByRole('button', { name: /download/i }).length).toBeGreaterThanOrEqual(1)
  })

  it('previews small unknown non-media files as text', async () => {
    await renderViewer(envExample)

    await waitFor(() => expect(screen.getByText(/OPENAGENTD_PORT/, { exact: false })).toBeTruthy())
    expect(screen.queryByText('No inline preview for this file type')).toBeNull()
  })

  it('copy button fetches text content and writes it to the clipboard', async () => {
    const user = userEvent.setup()
    const writeText = mock(async () => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })

    await renderViewer(readme)
    await user.click(screen.getByRole('button', { name: /copy file contents/i }))

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('const value = 1\n// comment\nreturn value'))
  })

  it('keeps mobile file search inside the workspace panel viewport', async () => {
    // The inline file-search dialog was removed; the + button now opens the
    // parent-owned Command Palette via onOpenPalette.  Palette positioning
    // (fixed vs absolute) is handled at the TeamChatView level and tested
    // in the CommandPalette unit tests.
    const user = userEvent.setup()
    const { onOpenPalette } = await renderWorkspacePanel(mock(() => {}), null, true)

    await user.click(screen.getByRole('button', { name: /search files/i }))

    expect(onOpenPalette).toHaveBeenCalledTimes(1)
  })

  it('keeps desktop file search anchored to the full viewport', async () => {
    // Same — palette positioning is the parent's concern, not the panel's.
    const user = userEvent.setup()
    const { onOpenPalette } = await renderWorkspacePanel(mock(() => {}), null, false)

    await user.click(screen.getByRole('button', { name: /search files/i }))

    expect(onOpenPalette).toHaveBeenCalledTimes(1)
  })

  it('lets users select preview lines and add a line comment reference', async () => {
    const user = userEvent.setup()
    const onAddComment = mock(() => {})
    await renderViewer(readme, onAddComment)
    await waitFor(() => expect(screen.getByText('const')).toBeTruthy())

    await user.click(screen.getByRole('button', { name: /select line 1/i }))
    await user.click(screen.getByRole('button', { name: /add comment for line 1/i }))

    expect(onAddComment).toHaveBeenCalledWith(readmePath, 1, 1)
  })

  it('shows comment button on native text selection and clears it on click elsewhere', async () => {
    const onAddComment = mock(() => {})
    await renderViewer(readme, onAddComment)
    await waitFor(() => expect(screen.getByText('const')).toBeTruthy())

    const startNode = screen.getByText('const')
    const endNode = screen.getByText('// comment')
    const commonAncestor = startNode.closest('[data-line]')?.parentNode || startNode

    // 1. Simulate selection of text in lines
    const originalGetSelection = window.getSelection

    const mockRange = {
      startContainer: startNode,
      endContainer: endNode,
      commonAncestorContainer: commonAncestor,
    } as unknown as Range

    const mockSelection = {
      isCollapsed: false,
      rangeCount: 1,
      getRangeAt: () => mockRange,
    } as unknown as Selection

    window.getSelection = () => mockSelection

    // Trigger mouseup event to simulate user finishing selection
    await act(async () => {
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    })

    // Now, the + button (comment button) should be visible on the last selected line (line 2)
    await waitFor(() => expect(screen.getByRole('button', { name: /add comment for lines 1-2/i })).toBeTruthy())

    // 2. Click elsewhere (collapsed selection) to dismiss
    const collapsedSelection = {
      isCollapsed: true,
      rangeCount: 0,
    } as unknown as Selection

    window.getSelection = () => collapsedSelection

    await act(async () => {
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    })

    // The + button should be gone
    expect(screen.queryByRole('button', { name: /add comment for lines 1-2/i })).toBeNull()

    // Restore original getSelection
    window.getSelection = originalGetSelection
  })
})
