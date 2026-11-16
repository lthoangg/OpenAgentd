/**
 * useOverlayState — the phone's edge swipes.
 *
 * The right edge used to open the "More actions" sheet when there was no
 * workspace. That sheet is gone: the right edge opens the Review panel, which
 * holds terminal, find file and scheduled tasks, and does nothing without a
 * workspace. The left edge still opens the sidebar.
 */
import { afterEach, describe, expect, it, mock } from 'bun:test'
import type React from 'react'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

mock.module('@/hooks/use-platform', () => ({
  usePlatform: () => ({ isTauri: true, os: 'ios', isMacOverlay: false }),
  getPlatform: () => ({ isTauri: true, os: 'ios', isMacOverlay: false }),
  backgroundSuspendsSockets: () => true,
}))
mock.module('@/hooks/use-mobile', () => ({ useIsMobile: () => true }))
mock.module('@/lib/haptics', () => ({ haptic: () => undefined, softHapticFeedback: () => undefined, mediumHapticFeedback: () => undefined }))

import { useOverlayState } from '@/components/AgentChatView/useOverlayState'

let renders = 0

function Harness({ workspace }: { workspace: string | null }) {
  const overlay = useOverlayState({
    isMobile: true,
    workspace,
    toggleScheduler: () => {},
    toggleRunPicker: () => {},
    togglePalette: () => {},
    toggleQuickOpen: () => {},
  })
  renders += 1
  return (
    <div
      data-testid="surface"
      data-review={overlay.workspacePanel ?? ''}
      data-sidebar={String(overlay.mobileSidebarOpen)}
      {...overlay.edgeSwipeHandlers}
    />
  )
}

function renderSurface(workspace: string | null) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 400 })
  const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
  return render(<Harness workspace={workspace} />, { wrapper }).getByTestId('surface')
}

function swipe(el: HTMLElement, fromX: number, toX: number) {
  fireEvent.touchStart(el, { touches: [{ clientX: fromX, clientY: 200 }] })
  fireEvent.touchMove(el, { touches: [{ clientX: toX, clientY: 205 }] })
  fireEvent.touchEnd(el)
}

afterEach(cleanup)

describe('useOverlayState edge swipes on a phone', () => {
  // The state lives at the chat's root: a render per touchmove re-rendered the
  // whole chat per frame. The drawers follow the finger through the DOM now.
  it('does not re-render the chat view while a drawer follows the finger', () => {
    const surface = renderSurface('/repo/project')
    fireEvent.touchStart(surface, { touches: [{ clientX: 10, clientY: 200 }] })
    fireEvent.touchMove(surface, { touches: [{ clientX: 40, clientY: 203 }] })
    const before = renders
    for (let x = 50; x <= 180; x += 10) fireEvent.touchMove(surface, { touches: [{ clientX: x, clientY: 205 }] })
    expect(renders).toBe(before)
    // Only the release commits state.
    fireEvent.touchEnd(surface)
    expect(surface.dataset.sidebar).toBe('true')
  })

  it('opens the Review panel from the right edge with a workspace', () => {
    const surface = renderSurface('/repo/project')
    swipe(surface, 392, 280)
    expect(surface.dataset.review).toBe('changed')
    expect(surface.dataset.sidebar).toBe('false')
  })

  it('does nothing from the right edge without a workspace: there is no More sheet', () => {
    const surface = renderSurface(null)
    swipe(surface, 392, 280)
    expect(surface.dataset.review).toBe('')
    expect(surface.dataset.sidebar).toBe('false')
  })

  it('still opens the sidebar from the left edge', () => {
    const surface = renderSurface(null)
    swipe(surface, 10, 130)
    expect(surface.dataset.sidebar).toBe('true')
  })
})
