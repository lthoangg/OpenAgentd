import { afterEach, describe, expect, it, mock } from 'bun:test'
import type React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

let isMobile = false
const closePanel = mock(() => {})

mock.module('@/hooks/use-mobile', () => ({
  useIsMobile: () => isMobile,
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
})
