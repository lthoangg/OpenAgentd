/**
 * Review dock geometry — side vs overlay mode, maximize/restore, keyboard
 * resizing into the layout store, and hide.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { gitDiffResponse } from '../git-diff-mock'
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
  MoreHorizontal: Icon, SlidersHorizontal: Icon, AlertTriangle: Icon, CheckCircle2: Icon, Info: Icon,
  Globe: Icon, ArrowRight: Icon, MousePointerClick: Icon, RotateCw: Icon, Smartphone: Icon, SquareTerminal: Icon, Send: Icon, Bot: Icon,
  CalendarClock: Icon, ListTodo: Icon, MessageCircleQuestion: Icon, Target: Icon, CircleCheck: Icon, Square: Icon, Unlink: Icon, MessageSquarePlus: Icon, FileVideo: Icon, ImageOff: Icon,
  AlertCircle: Icon, ArrowLeft: Icon, CalendarIcon: Icon, Circle: Icon, Clock: Icon, Minus: Icon,
  Pause: Icon, Play: Icon, Terminal: Icon, Trash2: Icon, Zap: Icon,
  ChevronDownIcon: Icon, ChevronLeftIcon: Icon, ChevronRightIcon: Icon,
  Check: Icon, ChevronDown: Icon, ChevronLeft: Icon, ChevronRight: Icon,
  ChevronsDownUp: Icon, ChevronsUpDown: Icon,
  Copy: Icon, Download: Icon, ExternalLink: Icon, File: Icon, FileDiff: Icon, FileHeadphone: Icon, FileText: Icon,
  Folder: Icon, FolderOpen: Icon, GitCommitHorizontal: Icon, GitCompare: Icon, Loader2: Icon,
  Maximize2: Icon, Columns2: Icon, Rows2: Icon, Minimize2: Icon, Plus: Icon,
  Pencil: Icon, RefreshCw: Icon, RotateCcw: Icon, Search: Icon, TerminalSquare: Icon, Eraser: Icon, Undo2: Icon, X: Icon,
}))
mock.module('@/hooks/useReducedMotion', () => ({ useReducedMotion: () => false }))
mock.module('@/hooks/use-platform', () => ({
  usePlatform: () => ({ isTauri: false, os: 'linux', isMacOverlay: false }),
  getPlatform: () => ({ isTauri: false, os: 'linux', isMacOverlay: false }),
}))
// The mocked aside does not animate; it keeps the inline style the panel
// sets (desktop widths are a straight cut, not a tween), its ref and the
// width target a neighbour sizes itself by.
mock.module('framer-motion', () => ({
  motion: {
    aside: ({ children, className, 'aria-label': ariaLabel, style, ref, 'data-panel-target-width': target }: {
      children: React.ReactNode
      className?: string
      'aria-label'?: string
      style?: React.CSSProperties
      ref?: React.Ref<HTMLElement>
      'data-panel-target-width'?: number
    }) => <aside ref={ref} className={className} aria-label={ariaLabel} style={style} data-panel-target-width={target}>{children}</aside>,
  },
}))

beforeEach(() => {
  useGitPanelStore.setState({ workspaces: {} })
  useLayoutStore.setState({ dockRatio: DOCK_DEFAULT_RATIO, dockMaximized: false })
  globalThis.fetch = mock(async (input: unknown) => {
    const url = String(input)
    if (url.includes('/workspace/files/list')) return new Response(JSON.stringify({ workspace: WORKSPACE, truncated: false, files: [] }))
    if (url.includes('/workspace/git-diff')) return gitDiffResponse(url, { workspace: WORKSPACE, is_git_repo: false, diff: '' })
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
  return { dock: screen.getByRole('complementary', { name: 'Review panel' }) }
}

describe('Review dock layout', () => {
  it('sits beside the chat with a keyboard-resizable separator by default', async () => {
    const { dock } = await renderPanel({ centerWidth: 1000 })

    expect(dock.className).toContain('md:relative')
    const separator = screen.getByRole('separator', { name: 'Resize Review panel' })
    // 45% of a 1000px center, capped so the chat keeps 400px.
    expect(separator.getAttribute('aria-valuenow')).toBe('450')
    expect(separator.getAttribute('aria-valuemax')).toBe('600')
    // Showing it is a straight cut, not a tween: the aside takes its width
    // as a style at once (no animation frame needed), and the body fills it,
    // so a later resize moves it with the edge.
    expect(dock.style.width).toBe('450px')
    const body = dock.querySelector<HTMLElement>('[data-review-dock]')!
    expect(body.parentElement!.style.width).toBe('100%')

    fireEvent.keyDown(separator, { key: 'ArrowLeft' })
    expect(useLayoutStore.getState().dockRatio).toBeCloseTo(0.466, 3)

    fireEvent.keyDown(separator, { key: 'Enter' })
    expect(useLayoutStore.getState().dockRatio).toBe(DOCK_DEFAULT_RATIO)
  })

  it('maximizes into an overlay over the chat and restores', async () => {
    const user = userEvent.setup()
    const { dock } = await renderPanel({ centerWidth: 1000 })

    await user.click(screen.getByRole('button', { name: /^Maximize Review panel/ }))

    expect(useLayoutStore.getState().dockMaximized).toBe(true)
    expect(dock.className).toContain('md:absolute')
    expect(screen.queryByRole('separator', { name: 'Resize Review panel' })).toBeNull()
    // Reading-column tabs widen off this marker.
    expect(dock.querySelector('[data-review-dock]')!.hasAttribute('data-dock-maximized')).toBe(true)

    await user.click(screen.getByRole('button', { name: /^Restore Review panel/ }))
    expect(useLayoutStore.getState().dockMaximized).toBe(false)
    expect(dock.className).toContain('md:relative')
    expect(dock.querySelector('[data-review-dock]')!.hasAttribute('data-dock-maximized')).toBe(false)
  })

  it('slides in the first time it opens too (mounted by the toggle), from 0 to its width', async () => {
    const { WorkspacePanel } = await import('@/components/WorkspacePanel')
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    await act(async () => {
      render(
        <QueryClientProvider client={queryClient}>
          <WorkspacePanel workspace={WORKSPACE} open slideIn centerWidth={1000} />
        </QueryClientProvider>,
      )
    })
    const dock = screen.getByRole('complementary', { name: 'Review panel' })
    expect(dock.style.width).toBe('450px')
    expect(dock.style.transition).toContain('width')
  })

  it('slides shut on desktop: the width tweens for the toggle only, the body held at its open width', async () => {
    const { WorkspacePanel } = await import('@/components/WorkspacePanel')
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const panel = (open: boolean) => (
      <QueryClientProvider client={queryClient}>
        <WorkspacePanel workspace={WORKSPACE} open={open} centerWidth={1000} />
      </QueryClientProvider>
    )
    let view: ReturnType<typeof render> | undefined
    await act(async () => { view = render(panel(true)) })
    const dock = screen.getByRole('complementary', { name: 'Review panel' })
    expect(dock.style.transition).toBe('')

    await act(async () => { view!.rerender(panel(false)) })

    expect(dock.style.width).toBe('0px')
    expect(dock.style.transition).toContain('width')
    // Clipped, not reflowed: the body rides the moving edge at 450px.
    expect(dock.querySelector<HTMLElement>('[data-review-dock]')!.parentElement!.style.width).toBe('450px')
  })

  // Closing frees room the sidebar takes at once (its clamp leaves an open
  // dock 340px), so a 740px center can drop to 736 mid-slide. Switching to
  // the overlay then pulled the dock out of the row: the chat snapped to
  // full width and the dock slid over it.
  it('closes beside the chat when closing drops the center under the side-by-side minimum', async () => {
    const { WorkspacePanel } = await import('@/components/WorkspacePanel')
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const panel = (open: boolean, centerWidth: number) => (
      <QueryClientProvider client={queryClient}>
        <WorkspacePanel workspace={WORKSPACE} open={open} centerWidth={centerWidth} />
      </QueryClientProvider>
    )
    let view: ReturnType<typeof render> | undefined
    await act(async () => { view = render(panel(true, 740)) })
    const dock = screen.getByRole('complementary', { name: 'Review panel' })
    expect(dock.className).toContain('md:relative')

    await act(async () => { view!.rerender(panel(false, 736)) })

    expect(dock.className).toContain('md:relative')
    expect(dock.style.width).toBe('0px')
    expect(dock.style.transition).toContain('width')
    expect(dock.querySelector<HTMLElement>('[data-review-dock]')!.parentElement!.style.width).toBe('340px')

    // Opened again at that width, it covers the chat as before.
    await act(async () => { view!.rerender(panel(true, 736)) })
    expect(dock.className).toContain('md:absolute')
  })

  it('falls back to an overlay without a maximize toggle when the center is too narrow', async () => {
    const { dock } = await renderPanel({ centerWidth: 600 })

    expect(dock.className).toContain('md:absolute')
    expect(screen.queryByRole('button', { name: /^(Maximize|Restore) Review panel/ })).toBeNull()
    expect(dock.querySelector('[data-review-dock]')!.hasAttribute('data-dock-maximized')).toBe(false)
  })

  // A desktop window keeps the chat beside the panel down to 740px of center;
  // a touch tablet covers the transcript below 860px (layout.html, 820px).
  it('sits beside the chat in an 856px desktop window but covers it on an 820px touch tablet', async () => {
    const realMatchMedia = window.matchMedia
    try {
      const { dock } = await renderPanel({ centerWidth: 856 })
      expect(dock.className).toContain('md:relative')
      cleanup()

      window.matchMedia = ((query: string) => ({
        matches: query === '(pointer: coarse)',
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      })) as unknown as typeof window.matchMedia
      const tablet = await renderPanel({ centerWidth: 820 })
      expect(tablet.dock.className).toContain('md:absolute')
    } finally {
      window.matchMedia = realMatchMedia
    }
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

    expect(screen.getByRole('complementary', { name: 'Review panel' }).className).toContain('md:absolute')
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
    expect(screen.getByRole('separator', { name: 'Resize Review panel' }).getAttribute('aria-valuenow')).toBe('495')
  })

  // Re-sized only once the center had grown (a ResizeObserver callback and
  // a frame later), the panel jumped a few frames into the sidebar's slide,
  // and the chat between them overshot, then snapped back.
  it('slides with a sidebar showing or hiding beside the center, from the same commit', async () => {
    const { WorkspacePanel } = await import('@/components/WorkspacePanel')
    const { ResizableAside } = await import('@/components/ResizableAside')
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const centerRef: { current: HTMLDivElement | null } = { current: null }
    const attach = (node: HTMLDivElement | null) => {
      if (node) node.getBoundingClientRect = () => ({ width: 1000 }) as DOMRect
      centerRef.current = node
    }
    // The sidebar is 100px on screen; ``target`` is where its width is headed.
    const row = (target: number, tweenWidth: boolean) => (
      <QueryClientProvider client={queryClient}>
        <div ref={(node) => {
          const sidebar = node?.querySelector<HTMLElement>('aside[aria-label="Sidebar"]')
          if (sidebar) sidebar.getBoundingClientRect = () => ({ width: 100 }) as DOMRect
        }}>
          <ResizableAside
            aria-label="Sidebar"
            resize={{ width: 100, min: 0, max: 500, edge: 'right', onCommit: () => {}, label: 'Resize sidebar' }}
            getMotion={() => ({ animate: { width: target }, transition: { duration: 0.01 }, instantWidth: true, tweenWidth })}
          >
            <p>sidebar</p>
          </ResizableAside>
          <div ref={attach}>
            <WorkspacePanel workspace={WORKSPACE} open centerRef={centerRef} />
          </div>
        </div>
      </QueryClientProvider>
    )
    let view: ReturnType<typeof render> | undefined
    await act(async () => { view = render(row(100, false)) })
    const dock = screen.getByRole('complementary', { name: 'Review panel' })
    expect(dock.style.width).toBe('450px')
    expect(dock.style.transition).toBe('')

    act(() => view!.rerender(row(0, true)))

    // 45% of the 1100px center the sidebar leaves, on the sidebar's curve.
    expect(dock.style.width).toBe('495px')
    expect(dock.style.transition).toContain('width')
    // The body fills the panel, so it moves with the edge rather than clipping.
    expect(dock.querySelector<HTMLElement>('[data-review-dock]')!.parentElement!.style.width).toBe('100%')
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

    expect(screen.queryByRole('button', { name: /^(Hide|Close) Review panel/ })).toBeNull()
  })

  it('keeps mobile on the full-screen sheet without desktop window controls', async () => {
    useLayoutStore.setState({ dockMaximized: true })
    const { dock } = await renderPanel({ mobile: true })

    expect(dock.className).toContain('mobile-safe-top')
    expect(screen.queryByRole('separator', { name: 'Resize Review panel' })).toBeNull()
    // No window controls; the "Open…" button is the one control that stays
    expect(screen.queryByRole('button', { name: /^(Maximize|Restore|Hide|Close) Review panel/ })).toBeNull()
    expect(screen.getByRole('button', { name: 'Open in Review panel' })).toBeTruthy()
    expect(dock.querySelector('[data-review-dock]')!.hasAttribute('data-dock-maximized')).toBe(false)
  })

  it('keeps the mobile sheet fixed and full width on a landscape phone wider than md', async () => {
    const { dock } = await renderPanel({ mobile: true })
    const classes = dock.className.split(' ')

    // No desktop `md:` layout leaks in when the phone is wider than md.
    expect(classes.filter((c) => c.startsWith('md:'))).toEqual([])
    expect(classes).toEqual(expect.arrayContaining(['fixed', 'w-full', 'pl-safe', 'pr-safe']))
  })
})
