/**
 * The Review panel on a phone: a page pushed over the chat, not a drawer under
 * the header. It covers the whole screen with its own navigation bar (‹ Chat,
 * "Review", the "+" that opens a view or tool), slides in over its full width,
 * and follows the finger when it is dragged closed.
 *
 * A phone is touch and narrow (``useIsPhone``). A narrow mouse window and a
 * tablet keep the drawer under the header they had before.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import type React from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useGitPanelStore } from '@/stores/useGitPanelStore'
import { _resetTerminalStoreForTests } from '@/stores/useTerminalStore'
import { useEdgeSwipe } from '@/hooks/use-edge-swipe'
import { _resetDrawerMotionsForTests, getDrawerMotion } from '@/lib/drawer-motion'
import { gitDiffResponse } from '../git-diff-mock'

const WORKSPACE = '/repo/project'
const WIDTH = 390

let phone = true
mock.module('@/hooks/use-is-phone', () => ({ useIsPhone: () => phone }))
// The edge swipe (in the harness below) acts on a mobile shell on iOS or Android.
mock.module('@/hooks/use-mobile', () => ({ useIsMobile: () => true, MOBILE_QUERY: '(max-width: 767px)' }))
mock.module('@/hooks/useReducedMotion', () => ({ useReducedMotion: () => false }))
mock.module('@/hooks/use-platform', () => ({
  usePlatform: () => ({ isTauri: false, os: 'ios', isMacOverlay: false, isFullscreen: false }),
  getPlatform: () => ({ isTauri: false, os: 'ios', isMacOverlay: false, isFullscreen: false }),
}))
// The mocked aside does not animate; it keeps every attribute and style the
// panel sets, so the drawer driver can find and move it.
mock.module('framer-motion', () => ({
  motion: {
    aside: ({ children, initial: _initial, animate: _animate, exit: _exit, transition: _transition, ...props }: Record<string, unknown> & { children: React.ReactNode }) => (
      <aside {...props}>{children}</aside>
    ),
  },
  AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
}))

let frames: Array<(now: number) => void> = []
const realRaf = globalThis.requestAnimationFrame
const realCancel = globalThis.cancelAnimationFrame
const realInnerWidth = Object.getOwnPropertyDescriptor(window, 'innerWidth')

/** Run the spring's frames until it comes to rest. */
function settle() {
  act(() => {
    let at = 0
    while (frames.length && at < 5000) {
      const queued = frames
      frames = []
      at += 16
      for (const callback of queued) callback(at)
    }
  })
}

beforeEach(() => {
  phone = true
  frames = []
  // A terminal one test opens would come back as a tab in the next.
  _resetTerminalStoreForTests()
  globalThis.requestAnimationFrame = ((callback: (now: number) => void) => frames.push(callback)) as typeof requestAnimationFrame
  globalThis.cancelAnimationFrame = (() => { frames = [] }) as typeof cancelAnimationFrame
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: WIDTH })
  useGitPanelStore.setState({ workspaces: {} })
  globalThis.fetch = mock(async (input: unknown) => {
    const url = String(input)
    if (url.includes('/workspace/files/list')) return new Response(JSON.stringify({ workspace: WORKSPACE, truncated: false, files: [] }))
    if (url.includes('/workspace/git-diff')) return gitDiffResponse(url, { workspace: WORKSPACE, is_git_repo: false, diff: '' })
    if (url.includes('/workspace/status')) return new Response(JSON.stringify({ workspace: WORKSPACE }))
    return new Response(null, { status: 404 })
  }) as typeof fetch
})
afterEach(() => {
  cleanup()
  _resetDrawerMotionsForTests()
  globalThis.requestAnimationFrame = realRaf
  globalThis.cancelAnimationFrame = realCancel
  if (realInnerWidth) Object.defineProperty(window, 'innerWidth', realInnerWidth)
})

interface PanelOptions {
  open?: boolean
  slideIn?: boolean
  onRequestClose?: () => void
  /** Opens the Git tab, so the page has a tab (and a tab strip). */
  git?: boolean
}

const queryClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } })

/** The dock inside a query client; imported late so the mocks above are in place. */
async function dock(client: QueryClient, { open = true, slideIn = false, onRequestClose, git = false }: PanelOptions = {}) {
  const { WorkspacePanel } = await import('@/components/WorkspacePanel')
  return (
    <QueryClientProvider client={client}>
      <WorkspacePanel workspace={WORKSPACE} open={open} slideIn={slideIn} mobile onRequestClose={onRequestClose} viewRequest={git ? { view: 'review', key: 1 } : null} />
    </QueryClientProvider>
  )
}

async function renderPanel(options: PanelOptions = {}) {
  const tree = await dock(queryClient(), options)
  await act(async () => { render(tree) })
  return screen.getByRole('complementary', { name: 'Review panel' })
}

describe('Review panel on a phone — a page over the chat', () => {
  it('covers the whole screen, top edge included, under its own navigation bar', async () => {
    const panel = await renderPanel()

    // The drawer sat under the app header (`mobile-safe-top`); a page starts at the top.
    expect(panel.className).not.toContain('mobile-safe-top')
    expect(panel.className.split(' ')).toEqual(expect.arrayContaining(['fixed', 'top-0', 'bottom-0', 'right-0', 'w-full', 'pl-safe', 'pr-safe']))
    const bar = panel.querySelector<HTMLElement>('[data-phone-nav-bar]')
    expect(bar).not.toBeNull()
    expect(within(bar!).getByRole('heading', { name: 'Workspace' })).toBeTruthy()
  })

  it('goes back to the chat from ‹ Chat, and has no × of its own', async () => {
    const onRequestClose = mock(() => {})
    const panel = await renderPanel({ onRequestClose })
    const bar = panel.querySelector<HTMLElement>('[data-phone-nav-bar]')!

    const back = within(bar).getByRole('button', { name: 'Back to Chat' })
    expect(back.textContent).toBe('')
    await userEvent.setup().click(back)
    expect(onRequestClose).toHaveBeenCalledTimes(1)

    // One way out: no Close control anywhere in the bar or the strip.
    expect(within(panel).queryByRole('button', { name: /^Close/ })).toBeNull()
  })

  it('has no ‹ without somewhere to go back to', async () => {
    const panel = await renderPanel()
    expect(within(panel).queryByRole('button', { name: /^Back to/ })).toBeNull()
  })

  it('puts "+" in the bar, where an iOS bar keeps its action, and leaves the strip to the tabs', async () => {
    const panel = await renderPanel({ onRequestClose: () => {}, git: true })
    const bar = panel.querySelector<HTMLElement>('[data-phone-nav-bar]')!
    const strip = panel.querySelector<HTMLElement>('[data-dock-strip]')!

    expect(within(strip).getByRole('button', { name: 'Git' })).toBeTruthy()
    const plus = within(bar).getByRole('button', { name: 'Open in Review panel' })
    expect(plus.textContent).toBe('')
    expect(within(strip).queryByRole('button', { name: 'Open in Review panel' })).toBeNull()

    const user = userEvent.setup()
    await user.click(plus)
    const menu = screen.getByRole('menu', { name: 'Open in Review panel' })
    const rows = within(menu).getAllByRole('menuitem').map((item) => item.getAttribute('aria-label'))
    // The open Git tab is checked in the list, as in the strip's menu.
    expect(rows).toEqual(expect.arrayContaining(['Git (open)', 'Terminal', 'Find file…']))
    // Tasks and side questions open above the chat on a phone, not in the dock.
    expect(rows).not.toContain('Tasks')
    expect(rows).not.toContain('Side questions')

    await user.click(within(menu).getByRole('menuitem', { name: 'Terminal' }))
    expect(screen.queryByRole('menu')).toBeNull()
    expect(screen.getByRole('button', { name: /^Close Terminal 1/ })).toBeTruthy()
  })

  it('has no tab strip while it has no tabs: the launcher starts under the bar, which draws the hairline', async () => {
    const empty = await renderPanel({ onRequestClose: () => {} })
    expect(empty.querySelector('[data-dock-strip]')).toBeNull()
    // An iOS grouped list: Changes (Git) among the views, Files among the tools.
    const views = within(empty).getByRole('group', { name: 'Views' })
    expect(within(views).getByRole('button', { name: /Changes/ }).className).toContain('min-h-11')
    expect(within(within(empty).getByRole('group', { name: 'Tools' })).getByRole('button', { name: /Files/ })).toBeTruthy()
    expect(empty.querySelector('[data-phone-nav-bar]')!.className).not.toContain('border-transparent')
    cleanup()

    const open = await renderPanel({ onRequestClose: () => {}, git: true })
    expect(open.querySelector('[data-dock-strip]')).not.toBeNull()
    // The strip draws the one hairline under the bar.
    expect(open.querySelector('[data-phone-nav-bar]')!.className).toContain('border-transparent!')
  })

  it('keeps the drawer under the header on a narrow mouse window, as it was', async () => {
    phone = false
    const panel = await renderPanel({ onRequestClose: () => {} })

    expect(panel.className).toContain('mobile-safe-top')
    expect(panel.querySelector('[data-phone-nav-bar]')).toBeNull()
    expect(within(panel).queryByRole('button', { name: /^Back to/ })).toBeNull()
    // "+" stays in the tab strip.
    const strip = panel.querySelector<HTMLElement>('[data-dock-strip]')!
    expect(within(strip).getByRole('button', { name: 'Open in Review panel' })).toBeTruthy()
  })
})

describe('Review panel on a phone — motion', () => {
  const drawer = () => document.querySelector<HTMLElement>('[data-edge-drawer="workspace-panel"]')!

  it('slides in from the right over its full width, not 272px, and slides back out', async () => {
    const client = queryClient()
    let view!: ReturnType<typeof render>
    await act(async () => { view = render(await dock(client, { open: true, slideIn: true })) })

    // Mounted by the toggle: it starts a whole screen to the right and springs home.
    expect(drawer().style.translate).toBe(`${WIDTH}px 0`)
    expect(getDrawerMotion('workspace-panel').hidden).toBe(WIDTH)
    settle()
    expect(drawer().style.translate).toBe('')

    const closed = await dock(client, { open: false, slideIn: true })
    await act(async () => { view.rerender(closed) })
    settle()
    expect(drawer().style.translate).toBe(`${WIDTH}px 0`)
  })

  it('is a plain slide: the page never fades', async () => {
    await renderPanel({ slideIn: true })
    settle()
    // An opaque page moving over the chat; no opacity written alongside the translate.
    expect(drawer().style.opacity).toBe('')
  })

  it('sizes its shut position to the screen it is on, wherever it is turned', async () => {
    await renderPanel({ slideIn: true })
    settle()
    await act(async () => {
      Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 844 })
      window.dispatchEvent(new Event('resize'))
    })
    expect(getDrawerMotion('workspace-panel').hidden).toBe(844)
  })

  it('keeps a panel that was open from the start in place, as a restored one is', async () => {
    await renderPanel({ slideIn: false })
    expect(drawer().style.translate).toBe('')
    expect(frames).toHaveLength(0)
  })

  it('keeps the 272px drawer travel on a narrow mouse window', async () => {
    phone = false
    await renderPanel({ slideIn: true })
    expect(getDrawerMotion('workspace-panel').hidden).toBe(272)
  })
})

describe('Review panel on a phone — dragged closed by the edge swipe', () => {
  /**
   * The shell's edge swipe, as ``useOverlayState`` wires it for a phone: the
   * Review panel is the open drawer, and its travel is the screen's width.
   */
  async function renderWithEdgeSwipe(onClose: () => void) {
    const tree = await dock(queryClient(), { onRequestClose: onClose })
    function Shell() {
      const { handlers } = useEdgeSwipe({
        activeDrawer: 'workspace-panel',
        right: { id: 'workspace-panel', open: () => {} },
        close: onClose,
        drawerWidth: window.innerWidth,
      })
      return <div data-testid="shell" {...handlers}>{tree}</div>
    }
    await act(async () => { render(<Shell />) })
    return document.querySelector<HTMLElement>('[data-phone-nav-bar]')!
  }

  const finger = (x: number, y = 300) => ({ touches: [{ clientX: x, clientY: y }] })
  const drawer = () => document.querySelector<HTMLElement>('[data-edge-drawer="workspace-panel"]')!
  const travelled = () => parseFloat(drawer().style.translate)

  it('follows a rightward drag from its left edge, one for one', async () => {
    const bar = await renderWithEdgeSwipe(() => {})

    fireEvent.touchStart(bar, finger(4))
    fireEvent.touchMove(bar, finger(104, 304))
    expect(travelled()).toBeCloseTo(100, 3)
    fireEvent.touchMove(bar, finger(204, 306))
    expect(travelled()).toBeCloseTo(200, 3)
  })

  it('closes when released past the commit distance, and goes on off the screen', async () => {
    const onClose = mock(() => {})
    const bar = await renderWithEdgeSwipe(onClose)

    fireEvent.touchStart(bar, finger(4))
    fireEvent.touchMove(bar, finger(204, 306))
    fireEvent.touchEnd(bar)

    expect(onClose).toHaveBeenCalledTimes(1)
    settle()
    expect(drawer().style.translate).toBe(`${WIDTH}px 0`)
  })

  it('springs back when released short of it', async () => {
    const onClose = mock(() => {})
    const bar = await renderWithEdgeSwipe(onClose)

    fireEvent.touchStart(bar, finger(4))
    fireEvent.touchMove(bar, finger(54, 304))
    fireEvent.touchEnd(bar)

    expect(onClose).not.toHaveBeenCalled()
    settle()
    expect(drawer().style.translate).toBe('')
  })
})
