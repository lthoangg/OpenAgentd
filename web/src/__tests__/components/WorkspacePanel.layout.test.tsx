/**
 * Review dock geometry — side vs overlay mode, maximize/restore, keyboard
 * resizing into the layout store, and hide.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import type React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useGitPanelStore } from '@/stores/useGitPanelStore'
import { useLayoutStore } from '@/stores/useLayoutStore'
import { DOCK_DEFAULT_RATIO } from '@/lib/workbench-layout'

const WORKSPACE = '/repo/project'

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
// The mocked aside does not animate: tests finish its tween by hand.
let finishTween: (() => void) | undefined
mock.module('framer-motion', () => ({
  motion: {
    aside: ({ children, className, 'aria-label': ariaLabel, onAnimationComplete }: {
      children: React.ReactNode
      className?: string
      'aria-label'?: string
      onAnimationComplete?: () => void
    }) => {
      finishTween = onAnimationComplete
      return <aside className={className} aria-label={ariaLabel}>{children}</aside>
    },
  },
}))

beforeEach(() => {
  useGitPanelStore.setState({ workspaces: {} })
  useLayoutStore.setState({ dockRatio: DOCK_DEFAULT_RATIO, dockMaximized: false })
  globalThis.fetch = mock(async (input: unknown) => {
    const url = String(input)
    if (url.includes('/workspace/files/list')) return new Response(JSON.stringify({ workspace: WORKSPACE, truncated: false, files: [] }))
    if (url.includes('/workspace/git-diff')) return new Response(JSON.stringify({ workspace: WORKSPACE, is_git_repo: false, diff: '' }))
    if (url.includes('/workspace/status')) return new Response(JSON.stringify({ workspace: WORKSPACE }))
    return new Response(null, { status: 404 })
  }) as typeof fetch
})
afterEach(cleanup)

async function renderPanel({ centerWidth = 1000, mobile = false, git = false } = {}) {
  const { WorkspacePanel } = await import('@/components/WorkspacePanel')
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => {
    render(
      <QueryClientProvider client={queryClient}>
        <WorkspacePanel workspace={WORKSPACE} open centerWidth={centerWidth} mobile={mobile} viewRequest={git ? { view: 'review', key: 1 } : null} />
      </QueryClientProvider>,
    )
  })
  return { dock: screen.getByRole('complementary', { name: 'Review dock' }) }
}

describe('Review dock layout', () => {
  it('sits beside the chat with a keyboard-resizable separator by default', async () => {
    const { dock } = await renderPanel({ centerWidth: 1000 })

    expect(dock.className).toContain('md:relative')
    const separator = screen.getByRole('separator', { name: 'Resize review dock' })
    // 45% of a 1000px center, capped so the chat keeps 400px.
    expect(separator.getAttribute('aria-valuenow')).toBe('450')
    expect(separator.getAttribute('aria-valuemax')).toBe('600')
    // The body keeps that width while the aside tweens open...
    const body = dock.querySelector<HTMLElement>('[data-review-dock]')!
    expect(body.parentElement!.style.width).toBe('450px')
    // ...then fills it, so a later resize moves it with the edge instead of
    // clipping its far side or leaving it blank until the tween ends.
    act(() => finishTween?.())
    expect(body.parentElement!.style.width).toBe('100%')

    fireEvent.keyDown(separator, { key: 'ArrowLeft' })
    expect(useLayoutStore.getState().dockRatio).toBeCloseTo(0.466, 3)

    fireEvent.keyDown(separator, { key: 'Enter' })
    expect(useLayoutStore.getState().dockRatio).toBe(DOCK_DEFAULT_RATIO)
  })

  it('maximizes into an overlay over the chat and restores', async () => {
    const user = userEvent.setup()
    const { dock } = await renderPanel({ centerWidth: 1000 })

    await user.click(screen.getByRole('button', { name: /^Maximize review dock/ }))

    expect(useLayoutStore.getState().dockMaximized).toBe(true)
    expect(dock.className).toContain('md:absolute')
    expect(screen.queryByRole('separator', { name: 'Resize review dock' })).toBeNull()

    await user.click(screen.getByRole('button', { name: /^Restore review dock/ }))
    expect(useLayoutStore.getState().dockMaximized).toBe(false)
    expect(dock.className).toContain('md:relative')
  })

  it('falls back to an overlay without a maximize toggle when the center is too narrow', async () => {
    const { dock } = await renderPanel({ centerWidth: 600 })

    expect(dock.className).toContain('md:absolute')
    expect(screen.queryByRole('button', { name: /^(Maximize|Restore) review dock/ })).toBeNull()
  })

  it('measures the center element it is given so the shell need not re-render on resize', async () => {
    const { WorkspacePanel } = await import('@/components/WorkspacePanel')
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const centerRef: { current: HTMLDivElement | null } = { current: null }
    const attach = (node: HTMLDivElement | null) => {
      if (node) node.getBoundingClientRect = () => ({ width: 600 }) as DOMRect
      centerRef.current = node
    }
    await act(async () => {
      render(
        <QueryClientProvider client={queryClient}>
          <div ref={attach}>
            <WorkspacePanel workspace={WORKSPACE} open centerRef={centerRef} />
          </div>
        </QueryClientProvider>,
      )
    })

    expect(screen.getByRole('complementary', { name: 'Review dock' }).className).toContain('md:absolute')
  })

  // Sized from the mid-tween center, the dock chased the sidebar a frame
  // behind and the chat between them overshot, then snapped back.
  it('sizes for where a tweening sidebar beside the center ends', async () => {
    const { WorkspacePanel } = await import('@/components/WorkspacePanel')
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const centerRef: { current: HTMLDivElement | null } = { current: null }
    // Collapsing: the sidebar is still 100px wide on its way to 0.
    const sidebar = (node: HTMLDivElement | null) => {
      if (node) node.getBoundingClientRect = () => ({ width: 100 }) as DOMRect
    }
    const attach = (node: HTMLDivElement | null) => {
      if (node) node.getBoundingClientRect = () => ({ width: 1000 }) as DOMRect
      centerRef.current = node
    }
    await act(async () => {
      render(
        <QueryClientProvider client={queryClient}>
          <div>
            <div ref={sidebar} data-panel-target-width={0} />
            <div ref={attach}>
              <WorkspacePanel workspace={WORKSPACE} open centerRef={centerRef} />
            </div>
          </div>
        </QueryClientProvider>,
      )
    })

    // 45% of the 1100px center the sidebar leaves, not of the 1000px now.
    expect(screen.getByRole('separator', { name: 'Resize review dock' }).getAttribute('aria-valuenow')).toBe('495')
  })

  it('takes focus stranded in the covered chat so keyboard users land on the active tab', async () => {
    const chat = document.createElement('main')
    chat.setAttribute('inert', '')
    const composer = document.createElement('textarea')
    chat.appendChild(composer)
    document.body.appendChild(chat)
    composer.focus()

    await renderPanel({ centerWidth: 600, git: true })

    const activeTab = document.querySelector('[data-review-dock] [aria-current="true"]')
    expect(activeTab).not.toBeNull()
    expect(document.activeElement).toBe(activeTab)
    chat.remove()
  })

  it('lands stranded focus on the launcher when the covering dock is empty', async () => {
    const chat = document.createElement('main')
    chat.setAttribute('inert', '')
    const composer = document.createElement('textarea')
    chat.appendChild(composer)
    document.body.appendChild(chat)
    composer.focus()

    await renderPanel({ centerWidth: 600 })

    expect(document.activeElement).toBe(screen.getByRole('button', { name: /^Git \(/ }))
    chat.remove()
  })

  it('does not take focus from the chat when it sits beside it', async () => {
    const composer = document.createElement('textarea')
    document.body.appendChild(composer)
    composer.focus()

    await renderPanel({ centerWidth: 1000 })

    expect(document.activeElement).toBe(composer)
    composer.remove()
  })

  it('leaves hiding to the header toggle: the tab bar has no hide button', async () => {
    await renderPanel()

    expect(screen.queryByRole('button', { name: /^(Hide|Close) review dock/ })).toBeNull()
  })

  it('keeps mobile on the full-screen sheet without desktop window controls', async () => {
    const { dock } = await renderPanel({ mobile: true })

    expect(dock.className).toContain('mobile-safe-top')
    expect(screen.queryByRole('separator', { name: 'Resize review dock' })).toBeNull()
    expect(screen.queryByRole('button', { name: /review dock/ })).toBeNull()
  })
})
