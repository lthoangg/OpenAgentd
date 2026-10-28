import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { gitDiffResponse } from '../git-diff-mock'
import type React from 'react'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useGitPanelStore } from '@/stores/useGitPanelStore'
import { useFileRevealStore } from '@/stores/useFileRevealStore'
import { useToastStore } from '@/stores/useToastStore'
import type { WorkspaceFileInfo } from '@/api/types'

const WORKSPACE = '/repo/project'
// NOTE: Use a .ts extension so the highlighter tokenises 'const' as a standalone
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
  AlertTriangle: Icon, CheckCircle2: Icon, Info: Icon,
  Globe: Icon, ArrowRight: Icon, MousePointerClick: Icon, RotateCw: Icon, Smartphone: Icon, SquareTerminal: Icon, Send: Icon, Bot: Icon,
  CalendarClock: Icon, ListTodo: Icon, MessageCircleQuestion: Icon, Target: Icon, CircleCheck: Icon, Square: Icon, Unlink: Icon, MessageSquarePlus: Icon, FileVideo: Icon, ImageOff: Icon,
  AlertCircle: Icon, ArrowLeft: Icon, CalendarIcon: Icon, Circle: Icon, Clock: Icon, Minus: Icon,
  Pause: Icon, Play: Icon, Terminal: Icon, Trash2: Icon, Zap: Icon,
  ChevronDownIcon: Icon, ChevronLeftIcon: Icon, ChevronRightIcon: Icon,
  Check: Icon,
  ChevronDown: Icon,
  ChevronLeft: Icon,
  ChevronRight: Icon,
  ChevronsDownUp: Icon,
  ChevronsUpDown: Icon,
  Copy: Icon,
  Download: Icon,
  ExternalLink: Icon,
  File: Icon,
  FileDiff: Icon,
  FileHeadphone: Icon,
  FileText: Icon,
  Folder: Icon,
  FolderOpen: Icon,
  GitCommitHorizontal: Icon,
  GitCompare: Icon,
  Loader2: Icon,
  Maximize2: Icon,
  Minimize2: Icon,
  Plus: Icon,
  RefreshCw: Icon,
  RotateCcw: Icon,
  Search: Icon,
  Pencil: Icon, TerminalSquare: Icon, Eraser: Icon, Undo2: Icon,
  X: Icon,
}))
mock.module('@/hooks/useReducedMotion', () => ({ useReducedMotion: () => false }))
mock.module('@/hooks/use-platform', () => ({
  usePlatform: () => ({ isTauri: isMacOverlay, os: isMacOverlay ? 'macos' : 'linux', isMacOverlay }),
  getPlatform: () => ({ isTauri: isMacOverlay, os: isMacOverlay ? 'macos' : 'linux', isMacOverlay }),
}))
// PdfThumbnail renders via pdf.js — stub the shared loader so PDF preview
// tests don't need real PDF bytes/worker.
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
  diffResponse = { workspace: WORKSPACE, is_git_repo: false, diff: '', untracked: [] }
  isMacOverlay = false
  globalThis.fetch = mock(async (input: unknown) => {
    const url = String(input)
    if (url.includes('/workspace/files/list')) return new Response(JSON.stringify(filesResponse))
    if (url.includes('/workspace/files/read') && url.includes('.env.example')) return new Response('OPENAGENTD_PORT=4082\n')
    if (url.includes('/workspace/files/read')) return new Response('const value = 1\n// comment\nreturn value')
    if (url.includes('/workspace/git-diff')) return gitDiffResponse(url, diffResponse)
    return new Response(null, { status: 404 })
  }) as typeof fetch
})

afterEach(cleanup)

async function renderWorkspacePanel(onFileSelect = mock(() => {}), selectedFilePath: string | null = null, mobile = false) {
  const { WorkspacePanel } = await import('@/components/WorkspacePanel')
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  let renderResult: ReturnType<typeof render> | null = null
  await act(async () => {
    renderResult = render(
      <QueryClientProvider client={queryClient}>
        <WorkspacePanel workspace={WORKSPACE} open selectedFilePath={selectedFilePath} onFileSelect={onFileSelect} mobile={mobile} viewRequest={{ view: 'review', key: 1 }} />
      </QueryClientProvider>,
    )
  })
  return { WorkspacePanel, queryClient, renderResult: renderResult! }
}

/** Render a dock file tab (toolbar + preview) on its own. */
async function renderViewer(file: WorkspaceFileInfo = readme, onAddComment = mock(() => {})) {
  const { FilePreviewSubPanel } = await import('@/components/WorkspacePanel/FilePreviewSubPanel')
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => {
    render(
      <QueryClientProvider client={queryClient}>
        <FilePreviewSubPanel workspace={WORKSPACE} file={file} onAddComment={onAddComment} />
      </QueryClientProvider>,
    )
  })
}

describe('Coding workspace two-layer file preview', () => {
  it('opens the selected file path as a file tab', async () => {
    const onFileSelect = mock(() => {})
    await renderWorkspacePanel(onFileSelect, readmePath)

    await waitFor(() => expect(onFileSelect).toHaveBeenCalledWith(readme))
    await waitFor(() => expect(screen.getAllByText(readmePath).length).toBeGreaterThanOrEqual(1))
    await waitFor(() => expect(screen.getByText('const')).toBeTruthy())
  })

  it('reopens the selected file tab when the open key changes', async () => {
    const onFileSelect = mock(() => {})
    const { WorkspacePanel, queryClient, renderResult } = await renderWorkspacePanel(onFileSelect, readmePath)

    await waitFor(() => expect(onFileSelect).toHaveBeenCalledWith(readme))
    await userEvent.setup().click(screen.getByRole('button', { name: 'Git' }))
    expect(screen.getByText('Not a git repository')).toBeTruthy()

    renderResult.rerender(
      <QueryClientProvider client={queryClient}>
        <WorkspacePanel workspace={WORKSPACE} open selectedFilePath={readmePath} selectedFileOpenKey={1} onFileSelect={onFileSelect} viewRequest={{ view: 'review', key: 1 }} />
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

  it('keeps an open file tab in sync with the listing and the working diff', async () => {
    let listing: WorkspaceFileInfo[] = [readme, image]
    let diff = { workspace: WORKSPACE, is_git_repo: true, diff: '', untracked: [] as string[] }
    globalThis.fetch = mock(async (input: unknown) => {
      const url = String(input)
      if (url.includes('/workspace/files/list')) return new Response(JSON.stringify({ workspace: WORKSPACE, truncated: false, files: listing }))
      if (url.includes('/workspace/files/read')) return new Response('const value = 1')
      if (url.includes('/workspace/git-diff')) return gitDiffResponse(url, diff)
      return new Response(null, { status: 404 })
    }) as typeof fetch
    const { queryClient } = await renderWorkspacePanel(mock(() => {}), readmePath)
    await waitFor(() => expect(screen.getByText('24 B')).toBeTruthy())

    // The agent rewrites the file: the tab shows the new size, not the one it opened with.
    listing = [{ ...readme, size: 2048 }, image]
    await act(async () => {
      await queryClient.invalidateQueries()
    })
    await waitFor(() => expect(screen.getByText('2 KB')).toBeTruthy())

    // Then deletes it: nothing left to download.
    listing = [image]
    diff = {
      ...diff,
      diff: 'diff --git a/main.ts b/main.ts\ndeleted file mode 100644\nindex 1111111..0000000\n--- a/main.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-const value = 1\n',
    }
    await act(async () => {
      await queryClient.invalidateQueries()
    })
    await waitFor(() => {
      const download = screen.getByRole('button', { name: 'File deleted from workspace' }) as HTMLButtonElement
      expect(download.disabled).toBe(true)
    })
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
    await waitFor(() => expect(screen.getByRole('button', { name: /diff for README.md/i })).toBeTruthy())

    const changedRow = screen.getByRole('button', { name: /diff for README.md/i })
    expect(changedRow.textContent).toContain('M')
    await user.click(changedRow)

    expect(screen.getByText('old')).toBeTruthy()
    expect(screen.getByText('new')).toBeTruthy()
    expect(screen.getAllByRole('button', { name: /diff for README.md/i })).toHaveLength(1)
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
    await waitFor(() => expect(screen.getByRole('button', { name: /diff for deleted.txt/i })).toBeTruthy())
    const deletedRow = screen.getByRole('button', { name: /diff for deleted.txt/i })
    await user.click(deletedRow)

    expect(deletedRow.textContent).toContain('D')
    expect(onFileSelect).not.toHaveBeenCalled()

    await renderViewer({ path: 'deleted.txt', name: 'deleted.txt', size: 0, mtime: 0, mime: 'text/plain', deleted: true })

    expect(screen.getByText('File deleted from workspace')).toBeTruthy()
    expect(screen.getByText('Open Changes to review the removed contents.')).toBeTruthy()
    expect(screen.queryByText(/Failed to load: HTTP 404/i)).toBeNull()
    // A deleted file has nothing to download or copy.
    expect((screen.getByRole('button', { name: 'File deleted from workspace' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.queryByRole('button', { name: /copy file contents/i })).toBeNull()
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

  it('escapes highlighted file preview HTML from file contents', async () => {
    globalThis.fetch = mock(async (input: unknown) => {
      const url = String(input)
      if (url.includes('/workspace/files/read')) {
        return new Response('const payload = `<script>window.__pwned = true</script>`\n<img src=x onerror="window.__pwned = true">')
      }
      if (url.includes('/workspace/files/list')) return new Response(JSON.stringify(filesResponse))
      if (url.includes('/workspace/git-diff')) return gitDiffResponse(url, diffResponse)
      return new Response(null, { status: 404 })
    }) as typeof fetch

    await renderViewer(readme)

    await waitFor(() => expect(document.body.textContent).toContain('<script>window.__pwned = true</script>'))
    expect(document.querySelector('script')).toBeNull()
    expect(document.querySelector('img[src="x"]')).toBeNull()
    expect((window as Window & { __pwned?: boolean }).__pwned).toBeUndefined()
    expect(document.body.textContent).toContain('<img src=x onerror="window.__pwned = true">')
  })

  it('renders images inline in the file tab', async () => {
    await renderViewer(image)
    const img = screen.getByRole('img', { name: 'logo.png' }) as HTMLImageElement
    expect(img.src).toContain('workspace/files/read')
    expect(img.src).toContain('logo.png')
    // Binary contents are never offered as clipboard text.
    expect(screen.queryByRole('button', { name: /copy file contents/i })).toBeNull()
  })

  it('opens image previews in a lightbox from the file tab', async () => {
    const user = userEvent.setup()
    await renderViewer(image)

    await user.click(screen.getByRole('button', { name: 'Open logo.png preview in lightbox' }))

    expect(document.body.querySelector("[role='dialog']")).toBeTruthy()
    expect(screen.getByLabelText('Close lightbox')).toBeTruthy()
  })

  it('renders videos inline in the file tab', async () => {
    const video: WorkspaceFileInfo = { path: 'assets/clip.mp4', name: 'clip.mp4', size: 1000, mtime: 1, mime: 'video/mp4' }
    await renderViewer(video)
    const videoEl = document.querySelector('video')
    expect(videoEl).toBeTruthy()
    expect(videoEl?.src).toContain('workspace/files/read')
    expect(videoEl?.src).toContain('clip.mp4')
  })

  it('previews a .ts source as text even when the MIME says video/mp2t', async () => {
    // Regression test: stdlib MIME tables map `.ts` to `video/mp2t` (MPEG
    // transport stream), which used to route TypeScript files into the
    // <video> branch of kindOf().
    const tsFile: WorkspaceFileInfo = { path: 'src/main.ts', name: 'main.ts', size: 24, mtime: 1, mime: 'video/mp2t' }
    await renderViewer(tsFile)

    expect(document.querySelector('video')).toBeNull()
    await waitFor(() => expect(screen.getByText('const')).toBeTruthy())
  })

  it('highlights an .astro component as markup', async () => {
    // No stdlib MIME knows `.astro`; it must still preview as highlighted text.
    globalThis.fetch = mock(async () => new Response('<section class="hero">hi</section>\n')) as typeof fetch
    const astro: WorkspaceFileInfo = { path: 'src/pages/index.astro', name: 'index.astro', size: 36, mtime: 1, mime: 'application/octet-stream' }
    await renderViewer(astro)

    // Opening and closing tags each become their own token.
    await waitFor(() => expect(screen.getAllByText('section', { selector: 'span' })).toHaveLength(2))
  })

  it('plays videos inline without opening a lightbox', async () => {
    const user = userEvent.setup()
    const video: WorkspaceFileInfo = { path: 'assets/clip.mp4', name: 'clip.mp4', size: 1000, mtime: 1, mime: 'video/mp4' }
    await renderViewer(video)

    const videoEl = document.querySelector('video')
    expect(videoEl?.controls).toBe(true)
    expect(screen.queryByRole('button', { name: 'Open clip.mp4 preview in lightbox' })).toBeNull()

    await user.click(videoEl!)

    expect(document.body.querySelector("[role='dialog']")).toBeNull()
  })

  it('plays audio files inline in the file tab', async () => {
    const audio: WorkspaceFileInfo = { path: 'assets/voice.mp3', name: 'voice.mp3', size: 4096, mtime: 1, mime: 'audio/mpeg' }
    await renderViewer(audio)
    const audioEl = document.querySelector('audio')
    expect(audioEl).toBeTruthy()
    expect(audioEl?.controls).toBe(true)
    expect(audioEl?.src).toContain('workspace/files/read')
    expect(audioEl?.src).toContain('voice.mp3')
    expect(screen.getByText('voice.mp3')).toBeTruthy()
    expect(screen.queryByText('No inline preview for this file type')).toBeNull()
    expect(screen.queryByRole('button', { name: /copy file contents/i })).toBeNull()
  })

  it('shows the deleted notice instead of a player for a deleted audio file', async () => {
    await renderViewer({ path: 'old.wav', name: 'old.wav', size: 0, mtime: 0, mime: 'audio/x-wav', deleted: true })
    expect(document.querySelector('audio')).toBeNull()
    expect(screen.getByText('File deleted from workspace')).toBeTruthy()
  })

  it('previews a small PDF via pdf.js instead of raw binary text', async () => {
    // Regression test: PDFs under MAX_TEXT_PREVIEW_BYTES used to fall through
    // kindOf()'s generic "small file -> text" branch and render their raw
    // bytes via TextPreview, showing garbled binary instead of a PDF preview.
    // The preview renders page 1 client-side via pdf.js (canvas) rather than
    // a native <embed> — that has no PDF plugin to delegate to on iOS/Android
    // and is blank on desktop unless the framed resource opts into
    // frame-ancestors 'self', so canvas rendering is what actually works
    // uniformly across platforms.
    const user = userEvent.setup()
    const pdf: WorkspaceFileInfo = { path: 'docs/report.pdf', name: 'report.pdf', size: 2048, mtime: 1, mime: 'application/pdf' }
    await renderViewer(pdf)

    expect(document.querySelector('embed[type="application/pdf"]')).toBeNull()
    await waitFor(() => expect(document.querySelector('canvas')).toBeTruthy())
    expect(screen.queryByText('No inline preview for this file type')).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Open report.pdf preview in lightbox' }))
    expect(document.body.querySelector("[role='dialog']")).toBeTruthy()
  })

  it('shows binary fallback links in the file tab', async () => {
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

describe('Markdown file preview', () => {
  const markdown: WorkspaceFileInfo = { path: 'docs/README.md', name: 'README.md', size: 120, mtime: 1, mime: 'text/markdown' }
  const MARKDOWN_SOURCE = '# Project title\n\nSome **bold** text.\n\n![shot](img/a.png)\n'
  let reads = 0

  beforeEach(() => {
    reads = 0
    useFileRevealStore.setState({ request: null })
    globalThis.fetch = mock(async (input: unknown) => {
      const url = String(input)
      if (url.includes('/workspace/files/read')) {
        reads += 1
        return new Response(MARKDOWN_SOURCE)
      }
      return new Response(null, { status: 404 })
    }) as typeof fetch
  })

  it('opens a markdown file rendered, without the line gutter', async () => {
    await renderViewer(markdown)

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Project title' })).toBeTruthy())
    expect(screen.queryByRole('button', { name: /select line 1/i })).toBeNull()
    const view = screen.getByRole('radiogroup', { name: 'Markdown view' })
    expect(view).toBeTruthy()
    expect(screen.getByRole('radio', { name: 'Rendered' }).getAttribute('aria-checked')).toBe('true')
  })

  it('switches between rendered and source without reloading the file', async () => {
    const user = userEvent.setup()
    await renderViewer(markdown)
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Project title' })).toBeTruthy())

    await user.click(screen.getByRole('radio', { name: 'Source' }))
    await waitFor(() => expect(screen.getByRole('button', { name: /select line 1/i })).toBeTruthy())
    expect(screen.queryByRole('heading', { name: 'Project title' })).toBeNull()

    await user.click(screen.getByRole('radio', { name: 'Rendered' }))
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Project title' })).toBeTruthy())
    expect(reads).toBe(1)
  })

  it('resolves relative images against the markdown file folder', async () => {
    await renderViewer(markdown)

    const img = await waitFor(() => screen.getByRole('img', { name: 'shot' }) as HTMLImageElement)
    expect(img.src).toContain('workspace/files/read')
    expect(decodeURIComponent(img.src)).toContain('path=docs/img/a.png')
  })

  it('switches to source and selects the line when a reference reveals it', async () => {
    await renderViewer(markdown)
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Project title' })).toBeTruthy())

    await act(async () => {
      useFileRevealStore.getState().reveal(markdown.path, 3)
    })

    await waitFor(() => expect(screen.getByRole('radio', { name: 'Source' }).getAttribute('aria-checked')).toBe('true'))
    await waitFor(() => expect(document.querySelector('[data-line="3"]')?.className).toContain('bg-(--bg-key)'))
  })

  it('does not run raw HTML from a markdown file', async () => {
    globalThis.fetch = mock(async () => new Response('# Hi\n\n<script>window.__mdPwned = true</script>\n\n<img src=x onerror="window.__mdPwned = true">\n')) as typeof fetch
    await renderViewer(markdown)

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Hi' })).toBeTruthy())
    expect(document.querySelector('script')).toBeNull()
    expect(document.querySelector('img[onerror]')).toBeNull()
    expect((window as Window & { __mdPwned?: boolean }).__mdPwned).toBeUndefined()
  })

  it('hides front matter in the rendered view, with no code block or stray heading', async () => {
    globalThis.fetch = mock(async () => new Response('---\nname: demo\n---\n# Body\n')) as typeof fetch
    await renderViewer(markdown)

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Body' })).toBeTruthy())
    expect(screen.queryByRole('heading', { name: 'name: demo' })).toBeNull()
    expect(document.body.textContent).not.toContain('name: demo')
    expect(document.querySelector('pre')).toBeNull()
  })

  it('offers no markdown view switch for other text files', async () => {
    await renderViewer(readme)

    await waitFor(() => expect(screen.getByRole('button', { name: /select line 1/i })).toBeTruthy())
    expect(screen.queryByRole('radiogroup', { name: 'Markdown view' })).toBeNull()
  })
})

describe('Links in a rendered markdown file', () => {
  const markdown: WorkspaceFileInfo = { path: 'docs/README.md', name: 'README.md', size: 200, mtime: 1, mime: 'text/markdown' }
  const LISTED = new Set(['docs/README.md', 'docs/guide.md', 'docs/demo.html', 'setup.md', 'src/app.ts'])
  const SOURCE = [
    'See [the guide](guide.md), [setup](../setup.md#L12), `src/app.ts:42`,',
    '[the demo](demo.html), [gone](missing.md), [outside](../../outside.md)',
    'and [the site](https://x.dev).',
    '',
  ].join('\n')

  beforeEach(() => {
    useFileRevealStore.setState({ request: null })
    useToastStore.setState({ toasts: [] })
    globalThis.fetch = mock(async (input: unknown) => {
      if (String(input).includes('/workspace/files/read')) return new Response(SOURCE)
      return new Response(null, { status: 404 })
    }) as typeof fetch
  })

  async function renderLinked() {
    const onOpenFile = mock(() => {})
    const onOpenPreview = mock(() => {})
    const { FilePreviewSubPanel } = await import('@/components/WorkspacePanel/FilePreviewSubPanel')
    await act(async () => {
      render(
        <FilePreviewSubPanel
          workspace={WORKSPACE}
          file={markdown}
          onOpenFile={onOpenFile}
          onOpenPreview={onOpenPreview}
          isListed={(path) => LISTED.has(path)}
        />,
      )
    })
    await waitFor(() => expect(screen.getByRole('link', { name: 'the guide' })).toBeTruthy())
    return { onOpenFile, onOpenPreview, user: userEvent.setup() }
  }

  it("opens a relative link from the file's folder in a file tab", async () => {
    const { onOpenFile, user } = await renderLinked()

    await user.click(screen.getByRole('link', { name: 'the guide' }))

    expect(onOpenFile).toHaveBeenCalledWith('docs/guide.md')
  })

  it('opens a line link at that line', async () => {
    const { onOpenFile, user } = await renderLinked()

    await user.click(screen.getByRole('link', { name: 'setup' }))

    expect(onOpenFile).toHaveBeenCalledWith('setup.md')
    expect(useFileRevealStore.getState().request).toMatchObject({ path: 'setup.md', line: 12 })
  })

  it('opens a file-named code span from the workspace root', async () => {
    const { onOpenFile, user } = await renderLinked()

    await user.click(screen.getByRole('button', { name: 'src/app.ts:42' }))

    expect(onOpenFile).toHaveBeenCalledWith('src/app.ts')
    expect(useFileRevealStore.getState().request).toMatchObject({ path: 'src/app.ts', line: 42 })
  })

  it('opens an HTML link in Preview', async () => {
    const { onOpenFile, onOpenPreview, user } = await renderLinked()

    await user.click(screen.getByRole('link', { name: 'the demo' }))

    expect(onOpenPreview).toHaveBeenCalledWith('docs/demo.html')
    expect(onOpenFile).not.toHaveBeenCalled()
  })

  it('says so when the linked file is missing', async () => {
    const { onOpenFile, user } = await renderLinked()

    await user.click(screen.getByRole('link', { name: 'gone' }))

    expect(onOpenFile).not.toHaveBeenCalled()
    expect(useToastStore.getState().toasts.map((toast) => toast.title)).toEqual(['File not found'])
  })

  it('leaves links outside the workspace and web links as plain links', async () => {
    await renderLinked()

    expect(screen.getByRole('link', { name: 'outside' }).getAttribute('target')).toBe('_blank')
    expect(screen.getByRole('link', { name: 'the site' }).getAttribute('target')).toBe('_blank')
  })
})
