import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { act, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanupSidebarHarness, fx, renderSidebarWithProps, resetSidebarHarness } from './harness'

describe('Sidebar workspace trust flow', () => {
  beforeEach(resetSidebarHarness)
  afterEach(cleanupSidebarHarness)

  it('slides shut on desktop: a short width tween, its rows held at their width and riding the edge', async () => {
    const { Sidebar } = await import('@/components/Sidebar')
    const queryClient = new QueryClient()
    const tree = (collapsed: boolean) => (
      <QueryClientProvider client={queryClient}>
        <Sidebar desktopCollapsed={collapsed} />
      </QueryClientProvider>
    )
    let view: ReturnType<typeof render> | undefined
    await act(async () => { view = render(tree(false)) })
    const sidebar = view!.container.querySelector('aside') as HTMLElement
    const region = sidebar.querySelector('[data-focus-region="sidebar"]') as HTMLElement
    // At rest nothing tweens, so a window resize moves the edge at once.
    expect(sidebar.style.transition).toBe('')
    expect(region.style.width).toBe('')
    const open = sidebar.style.width

    await act(async () => { view!.rerender(tree(true)) })
    expect(sidebar.style.width).toBe('0px')
    expect(sidebar.style.transition).toContain('width')
    // The rows keep the open width and sit at the moving edge, so they
    // slide out with it instead of rewrapping every frame.
    expect(region.style.width).toBe(open)
    expect(region.className).toContain('self-end')
    // The hairline and the drawer stay until the slide is over.
    expect(sidebar.className.split(' ')).not.toContain('border-r-0')
  })

  it('re-clamps the resize bounds when the window shrinks, not only on the next unrelated render', async () => {
    const originalWidth = window.innerWidth
    try {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1600 })
      await renderSidebarWithProps({ desktopCollapsed: false, dockOpen: true })
      const separator = screen.getByRole('separator', { name: 'Resize sidebar' })
      expect(separator.getAttribute('aria-valuemax')).toBe('440')

      // 1100 - 400 (chat) - 340 (open Review panel) leaves 360px for the sidebar.
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1100 })
      act(() => {
        window.dispatchEvent(new Event('resize'))
      })
      expect(separator.getAttribute('aria-valuemax')).toBe('360')
      expect(separator.getAttribute('aria-valuenow')).toBe('264')

      // 960 leaves the minimum for the chat and the panel: 220px.
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: 960 })
      act(() => {
        window.dispatchEvent(new Event('resize'))
      })
      expect(separator.getAttribute('aria-valuemax')).toBe('220')
      expect(separator.getAttribute('aria-valuenow')).toBe('220')
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalWidth })
    }
  })

  it('keeps the mobile drawer visible after a desktop-collapsed coding sidebar crosses the breakpoint', async () => {
    fx.isMobile = true

    const view = await renderSidebarWithProps({
      desktopCollapsed: true,
      mobileOpen: true,
      workspace: '/repo/project',
    })
    const drawer = view.container.querySelector('aside')

    expect(drawer).toBeTruthy()
    expect(JSON.parse(drawer?.getAttribute('data-animate') ?? '{}')).toEqual({
      width: 'min(272px, calc(100vw - 2rem))',
    })
    // Open: the drawer sits at its place (no translate), the scrim fully shown.
    expect(drawer?.getAttribute('data-edge-drawer')).toBe('sidebar')
    expect(drawer?.style.translate).toBe('')
    expect(view.container.querySelector<HTMLElement>('[data-edge-drawer-scrim="sidebar"]')?.style.opacity).toBe('1')
  })
})
