import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import type React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

let isMobile = false
let platformOs: string | null = null
const closePanel = mock(() => {})

mock.module('@/hooks/use-mobile', () => ({
  useIsMobile: () => isMobile,
}))

mock.module('@/hooks/use-platform', () => ({
  usePlatform: () => ({ isTauri: Boolean(platformOs), os: platformOs, isMacOverlay: platformOs === 'macos' }),
  getPlatform: () => ({ isTauri: Boolean(platformOs), os: platformOs, isMacOverlay: platformOs === 'macos' }),
}))

mock.module('@/hooks/useModalFocus', () => ({
  useModalFocus: () => undefined,
}))

mock.module('@/hooks/useReducedMotion', () => ({
  useReducedMotion: () => true,
}))

mock.module('framer-motion', () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  motion: {
    div: ({ children, initial, animate, exit, transition, ...props }: React.ComponentProps<'div'> & { initial?: unknown; animate?: unknown; exit?: unknown; transition?: unknown }) => {
      void initial
      void animate
      void exit
      void transition
      return <div {...props}>{children}</div>
    },
  },
}))

const Icon = () => null
mock.module('lucide-react', () => ({
  ArrowLeft: Icon,
  ChevronDown: Icon,
  ChevronRight: Icon,
  FileText: Icon,
  Folder: Icon,
  Loader2: Icon,
  Save: Icon,
  Trash2: Icon,
  X: Icon,
}))

const tree = {
  system: [{ path: 'INDEX.md', description: 'Index', updated: null, tags: [] }],
  wiki: [{ path: 'wiki/user.md', description: 'User memory', updated: null, tags: [] }],
  imports: [{ path: 'imports/article.md', description: 'Article', updated: null, tags: [] }],
  notes: [],
  topics: [],
  entities: [],
  sources: [],
  comparisons: [],
}

mock.module('@/queries', () => ({
  useWikiTreeQuery: () => ({ data: tree, isLoading: false, isError: false }),
  useWikiFileQuery: (path: string | null) => ({
    data: path ? { path, content: `# ${path}`, description: '', updated: null, tags: [] } : null,
    isLoading: false,
    isError: false,
  }),
  useWriteWikiFileMutation: () => ({ mutate: mock(() => {}), isPending: false, isError: false }),
  useDeleteWikiFileMutation: () => ({ mutate: mock(() => {}), isPending: false }),
}))

describe('WikiPanel', () => {
  afterEach(() => {
    cleanup()
    closePanel.mockClear()
    isMobile = false
    platformOs = null
  })

  async function renderWikiPanel() {
    const { WikiPanel } = await import('@/components/WikiPanel')
    const queryClient = new QueryClient()
    return render(
      <QueryClientProvider client={queryClient}>
        <WikiPanel open onClose={closePanel} />
      </QueryClientProvider>,
    )
  }

  it('renders memory files as a collapsible code-editor style tree', async () => {
    await renderWikiPanel()

    expect(screen.getByRole('button', { name: 'wiki 1' })).toBeTruthy()
    const importsButton = screen.getByRole('button', { name: /imports/i })
    expect(importsButton).toBeTruthy()
    expect(importsButton.getAttribute('aria-expanded')).toBe('false')
    expect(screen.getByRole('button', { name: 'INDEX.md' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'user.md' })).toBeTruthy()

    fireEvent.click(importsButton)
    expect(importsButton.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('button', { name: 'article.md' })).toBeTruthy()
  })

  it('cancels mobile wiki long-press actions when the row unmounts', async () => {
    isMobile = true
    platformOs = 'ios'
    const view = await renderWikiPanel()

    const fileButton = screen.getByRole('button', { name: 'user.md' })
    fireEvent.pointerDown(fileButton, {
      pointerType: 'touch',
      clientX: 40,
      clientY: 40,
    })
    view.unmount()

    await new Promise((resolve) => window.setTimeout(resolve, 650))
    expect(screen.queryByLabelText('Actions for user.md')).not.toBeTruthy()
  })

  it('replaces stale mobile wiki long-press timers', async () => {
    isMobile = true
    platformOs = 'ios'
    const originalClearTimeout = window.clearTimeout
    const clearTimeout = spyOn(window, 'clearTimeout').mockImplementation((...args: unknown[]) => originalClearTimeout(args[0] as number | undefined))

    await renderWikiPanel()
    const fileButton = screen.getByRole('button', { name: 'user.md' })
    fireEvent.pointerDown(fileButton, {
      pointerType: 'touch',
      clientX: 40,
      clientY: 40,
    })
    fireEvent.pointerDown(fileButton, {
      pointerType: 'touch',
      clientX: 42,
      clientY: 42,
    })

    expect(clearTimeout).toHaveBeenCalled()
    clearTimeout.mockRestore()
  })

  it('does not throw when copying a wiki path is denied', async () => {
    const originalClipboard = navigator.clipboard
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: mock(async () => { throw new Error('denied') }) },
    })

    await renderWikiPanel()
    fireEvent.contextMenu(screen.getByRole('button', { name: 'user.md' }), {
      clientX: 20,
      clientY: 20,
    })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy path' }))

    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: originalClipboard,
    })
  })
})
