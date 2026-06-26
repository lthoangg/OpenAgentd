import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import type React from 'react'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useGitPanelStore } from '@/stores/useGitPanelStore'
import type { WorkspaceFileInfo } from '@/api/types'

const WORKSPACE = '/repo/project'
const readme: WorkspaceFileInfo = { path: 'README.md', name: 'README.md', size: 24, mtime: 1, mime: 'text/markdown' }
const image: WorkspaceFileInfo = { path: 'assets/logo.png', name: 'logo.png', size: 100, mtime: 1, mime: 'image/png' }
const binary: WorkspaceFileInfo = { path: 'dist/app.bin', name: 'app.bin', size: 1024 * 1024, mtime: 1, mime: 'application/octet-stream' }
const envExample: WorkspaceFileInfo = { path: '.env.example', name: '.env.example', size: 32, mtime: 1, mime: 'application/octet-stream' }
const filesResponse = { workspace: WORKSPACE, truncated: false, files: [readme, image, binary, envExample] }
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
  GitCompare: Icon,
  Loader2: Icon,
  Plus: Icon,
  RefreshCw: Icon,
  Search: Icon,
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

async function renderWorkspacePanel(onFileSelect = mock(() => {}), selectedFilePath: string | null = null, mobile = false) {
  const { CodingWorkspacePanel } = await import('@/components/CodingWorkspacePanel')
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  let renderResult: ReturnType<typeof render> | null = null
  await act(async () => {
    renderResult = render(
      <QueryClientProvider client={queryClient}>
        <CodingWorkspacePanel workspace={WORKSPACE} open initialTab="files" selectedFilePath={selectedFilePath} onFileSelect={onFileSelect} onClose={() => {}} mobile={mobile} />
      </QueryClientProvider>,
    )
  })
  return { CodingWorkspacePanel, queryClient, renderResult: renderResult! }
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
    await renderWorkspacePanel(onFileSelect, 'README.md')

    await waitFor(() => expect(onFileSelect).toHaveBeenCalledWith(readme))
    await waitFor(() => expect(screen.getAllByTitle('README.md').length).toBeGreaterThanOrEqual(1))
    await waitFor(() => expect(screen.getByText('const')).toBeTruthy())
  })

  it('reopens the selected file tab when the open key changes', async () => {
    const onFileSelect = mock(() => {})
    const { CodingWorkspacePanel, queryClient, renderResult } = await renderWorkspacePanel(onFileSelect, 'README.md')

    await waitFor(() => expect(onFileSelect).toHaveBeenCalledWith(readme))
    await userEvent.setup().click(screen.getByRole('button', { name: /git/i }))
    expect(screen.getByText('Not a git repository')).toBeTruthy()

    renderResult.rerender(
      <QueryClientProvider client={queryClient}>
        <CodingWorkspacePanel workspace={WORKSPACE} open selectedFilePath="README.md" selectedFileOpenKey={1} onFileSelect={onFileSelect} onClose={() => {}} />
      </QueryClientProvider>,
    )

    await waitFor(() => expect(screen.getByText('const')).toBeTruthy())
  })

  it('opens file tabs from the plus file search', async () => {
    const user = userEvent.setup()
    const onFileSelect = mock(() => {})
    await renderWorkspacePanel(onFileSelect)

    await user.click(screen.getByRole('button', { name: /open file search/i }))
    await waitFor(() => expect(screen.getByRole('textbox', { name: /search workspace files/i })).toBeTruthy())
    await user.type(screen.getByRole('textbox', { name: /search workspace files/i }), 'readme')
    await user.click(screen.getByTitle('README.md'))

    expect(onFileSelect).toHaveBeenCalledWith(readme)
    expect(screen.getByRole('button', { name: /git/i })).toBeTruthy()
    expect(screen.getByText('const')).toBeTruthy()
  })

  it('opens the first matching file with Enter from file search', async () => {
    const user = userEvent.setup()
    const onFileSelect = mock(() => {})
    await renderWorkspacePanel(onFileSelect)

    await user.click(screen.getByRole('button', { name: /open file search/i }))
    await user.type(screen.getByRole('textbox', { name: /search workspace files/i }), 'readme{Enter}')

    expect(onFileSelect).toHaveBeenCalledWith(readme)
    await waitFor(() => expect(screen.getAllByTitle('README.md').length).toBeGreaterThanOrEqual(1))
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
    const firstLine = screen.getByText('const').closest('div')
    expect(firstLine?.className).toContain('whitespace-pre-wrap')
    expect(firstLine?.className).toContain('break-words')
  })

  it('renders images inline in the separate file viewer panel', async () => {
    await renderViewer(image)
    const img = screen.getByRole('img', { name: 'logo.png' }) as HTMLImageElement
    expect(img.src).toContain('workspace/files/read')
    expect(img.src).toContain('logo.png')
  })

  it('shows binary fallback links in the separate file viewer panel', async () => {
    await renderViewer(binary)
    expect(screen.getByText('No inline preview for this file type')).toBeTruthy()
    expect(screen.getByRole('link', { name: /open in new tab/i })).toBeTruthy()
    expect(screen.getAllByRole('button', { name: /download/i }).length).toBeGreaterThanOrEqual(1)
  })

  it('previews small unknown non-media files as text', async () => {
    await renderViewer(envExample)

    await waitFor(() => expect(screen.getByText('OPENAGENTD_PORT')).toBeTruthy())
    expect(screen.queryByText('No inline preview for this file type')).toBeNull()
  })

  it('hides the workspace tab scrollbar while keeping horizontal overflow scrollable', async () => {
    await renderWorkspacePanel()

    const tabRow = screen.getByRole('button', { name: /git/i }).parentElement
    expect(tabRow?.className).toContain('overflow-x-auto')
    expect(tabRow?.className).toContain('scrollbar-none')
  })

  it('copy button fetches text content and writes it to the clipboard', async () => {
    const user = userEvent.setup()
    const writeText = mock(async () => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })

    await renderViewer(readme)
    await user.click(screen.getByRole('button', { name: /copy file contents/i }))

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('const value = 1\n// comment\nreturn value'))
  })

  it('positions the mobile workspace panel below the app header instead of covering desktop window controls', async () => {
    await renderWorkspacePanel(mock(() => {}), null, true)

    const panel = screen.getByRole('complementary')
    expect(panel.className).toContain('mobile-safe-top')
    expect(panel.className).toContain('fixed')
    expect(panel.className).toContain('md:relative')
  })

  it('keeps mobile file search inside the workspace panel viewport', async () => {
    const user = userEvent.setup()
    await renderWorkspacePanel(mock(() => {}), null, true)

    await user.click(screen.getByRole('button', { name: /open file search/i }))

    const overlay = screen.getByRole('dialog', { name: /search workspace files/i }).parentElement
    expect(overlay?.className).toContain('absolute')
    expect(overlay?.className).toContain('inset-0')
    expect(overlay?.className).not.toContain('fixed')
  })

  it('keeps desktop file search anchored to the full viewport', async () => {
    const user = userEvent.setup()
    await renderWorkspacePanel(mock(() => {}), null, false)

    await user.click(screen.getByRole('button', { name: /open file search/i }))

    const overlay = screen.getByRole('dialog', { name: /search workspace files/i }).parentElement
    expect(overlay?.className).toContain('fixed')
    expect(overlay?.className).toContain('inset-0')
    expect(overlay?.className).not.toContain('absolute')
  })

  it('does not extend the desktop workspace panel into the macOS overlay header', async () => {
    isMacOverlay = true
    await renderWorkspacePanel(mock(() => {}), null, false)

    const panel = screen.getByRole('complementary')
    expect(panel.className).toContain('h-full')
    expect(panel.className).not.toContain('-mt-10')
    expect(panel.className).not.toContain('h-[calc(100%+2.5rem)]')
  })

  it('keeps the desktop workspace panel inside the app shell under non-macOS headers', async () => {
    await renderWorkspacePanel(mock(() => {}), null, false)

    const panel = screen.getByRole('complementary')
    expect(panel.className).toContain('h-full')
    expect(panel.className).not.toContain('-mt-10')
    expect(panel.className).not.toContain('h-[calc(100%+2.5rem)]')
  })

  it('positions the mobile file viewer below the app header and keeps the preview full-width', async () => {
    await renderViewer(readme, mock(() => {}), true)

    const viewer = screen.getByLabelText('File viewer')
    expect(viewer.className).toContain('mobile-safe-top')
    expect(viewer.className).toContain('w-full')
    expect(viewer.className).toContain('md:relative')
  })

  it('does not reserve mobile header safe-area space for the desktop file viewer', async () => {
    await renderViewer(readme, mock(() => {}), false)

    const viewer = screen.getByLabelText('File viewer')
    expect(viewer.className).not.toContain('mobile-safe-top')
    expect(viewer.className).toContain('md:relative')
  })

  it('lets users select preview lines and add a line comment reference', async () => {
    const user = userEvent.setup()
    const onAddComment = mock(() => {})
    await renderViewer(readme, onAddComment)
    await waitFor(() => expect(screen.getByText('const')).toBeTruthy())

    await user.click(screen.getByRole('button', { name: /select line 1/i }))
    await user.click(screen.getByRole('button', { name: /add comment for line 1/i }))

    expect(onAddComment).toHaveBeenCalledWith('README.md', 1, 1)
  })
})
