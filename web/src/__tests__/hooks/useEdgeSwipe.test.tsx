import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { useEdgeSwipe, type DrawerId } from '@/hooks/use-edge-swipe'

let platform = { isTauri: true, os: 'ios', isMacOverlay: false }
let mobile = true

mock.module('@/hooks/use-platform', () => ({
  usePlatform: () => platform,
  getPlatform: () => platform,
}))
mock.module('@/hooks/use-mobile', () => ({
  useIsMobile: () => mobile,
}))
mock.module('@/lib/haptics', () => ({
  haptic: () => undefined,
  softHapticFeedback: () => undefined,
  mediumHapticFeedback: () => undefined,
}))

interface HarnessProps {
  activeDrawer: DrawerId
  onLeft: () => void
  onRight: () => void
  onClose: () => void
}

function Harness({ activeDrawer, onLeft, onRight, onClose }: HarnessProps) {
  const { handlers } = useEdgeSwipe({
    activeDrawer,
    left: { id: 'sidebar', open: onLeft },
    right: { id: 'actions', open: onRight },
    close: onClose,
  })
  return <div data-testid="surface" {...handlers}>surface</div>
}

function touchEvt(x: number, y: number) {
  return { touches: [{ clientX: x, clientY: y }] }
}

describe('useEdgeSwipe', () => {
  beforeEach(() => {
    platform = { isTauri: true, os: 'ios', isMacOverlay: false }
    mobile = true
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 400 })
  })
  afterEach(() => {
    cleanup()
  })

  it('opens the left drawer on an inward swipe from the left edge', () => {
    const onLeft = mock(() => undefined)
    const onRight = mock(() => undefined)
    const onClose = mock(() => undefined)
    const { getByTestId } = render(
      <Harness activeDrawer={null} onLeft={onLeft} onRight={onRight} onClose={onClose} />,
    )
    const el = getByTestId('surface')
    fireEvent.touchStart(el, touchEvt(10, 200))
    fireEvent.touchMove(el, touchEvt(120, 205))
    fireEvent.touchEnd(el)

    expect(onLeft).toHaveBeenCalledTimes(1)
    expect(onRight).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('waits for release before committing a full left-edge swipe', () => {
    const onLeft = mock(() => undefined)
    const { getByTestId } = render(
      <Harness activeDrawer={null} onLeft={onLeft} onRight={() => undefined} onClose={() => undefined} />,
    )
    const el = getByTestId('surface')
    fireEvent.touchStart(el, touchEvt(8, 200))
    fireEvent.touchMove(el, touchEvt(200, 205))

    // Keep tracking the finger across the drawer's entire travel instead
    // of snapping open as soon as the commit distance is crossed.
    expect(onLeft).not.toHaveBeenCalled()

    fireEvent.touchEnd(el)
    expect(onLeft).toHaveBeenCalledTimes(1)
  })

  it('opens the right drawer on an inward swipe from the right edge', () => {
    const onLeft = mock(() => undefined)
    const onRight = mock(() => undefined)
    const onClose = mock(() => undefined)
    const { getByTestId } = render(
      <Harness activeDrawer={null} onLeft={onLeft} onRight={onRight} onClose={onClose} />,
    )
    const el = getByTestId('surface')
    fireEvent.touchStart(el, touchEvt(392, 200))
    fireEvent.touchMove(el, touchEvt(280, 205))
    fireEvent.touchEnd(el)

    expect(onRight).toHaveBeenCalledTimes(1)
    expect(onLeft).not.toHaveBeenCalled()
  })

  it('does NOT open the right drawer while the left drawer is open (mutual exclusion)', () => {
    const onLeft = mock(() => undefined)
    const onRight = mock(() => undefined)
    const onClose = mock(() => undefined)
    const { getByTestId } = render(
      <Harness activeDrawer="sidebar" onLeft={onLeft} onRight={onRight} onClose={onClose} />,
    )
    const el = getByTestId('surface')
    // Try a right-edge inward open while the sidebar is open.
    fireEvent.touchStart(el, touchEvt(392, 200))
    fireEvent.touchMove(el, touchEvt(300, 205))

    expect(onRight).not.toHaveBeenCalled()
    expect(onLeft).not.toHaveBeenCalled()
  })

  it('closes the open left drawer when swiped back toward its edge', () => {
    const onLeft = mock(() => undefined)
    const onRight = mock(() => undefined)
    const onClose = mock(() => undefined)
    const { getByTestId } = render(
      <Harness activeDrawer="sidebar" onLeft={onLeft} onRight={onRight} onClose={onClose} />,
    )
    const el = getByTestId('surface')
    // Swipe leftward (back toward the left edge) to dismiss.
    fireEvent.touchStart(el, touchEvt(200, 200))
    fireEvent.touchMove(el, touchEvt(80, 205))
    fireEvent.touchEnd(el)

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onLeft).not.toHaveBeenCalled()
    expect(onRight).not.toHaveBeenCalled()
  })

  it('ignores dominantly-vertical gestures (lets the list scroll)', () => {
    const onLeft = mock(() => undefined)
    const onClose = mock(() => undefined)
    const { getByTestId } = render(
      <Harness activeDrawer={null} onLeft={onLeft} onRight={() => undefined} onClose={onClose} />,
    )
    const el = getByTestId('surface')
    fireEvent.touchStart(el, touchEvt(10, 100))
    fireEvent.touchMove(el, touchEvt(30, 260))

    expect(onLeft).not.toHaveBeenCalled()
  })

  it('reports a live drag offset while the finger moves', () => {
    const offsets: number[] = []
    function DragHarness() {
      const { handlers, drag } = useEdgeSwipe({
        activeDrawer: null,
        left: { id: 'sidebar', open: () => undefined },
        close: () => undefined,
      })
      if (drag?.drawerId === 'sidebar') offsets.push(drag.offset)
      return <div data-testid="surface" {...handlers}>surface</div>
    }
    const { getByTestId } = render(<DragHarness />)
    const el = getByTestId('surface')
    fireEvent.touchStart(el, touchEvt(8, 200))
    // A short move (under commit distance) should not open but should drag.
    fireEvent.touchMove(el, touchEvt(40, 202))
    expect(offsets.length).toBeGreaterThan(0)
    const last = offsets[offsets.length - 1]
    expect(last).toBeLessThan(0)
    expect(last).toBeGreaterThan(-272)
  })

  it('ignores gestures that start on a data-swipe-ignore element', () => {
    const onLeft = mock(() => undefined)
    function ExcludeHarness() {
      const { handlers } = useEdgeSwipe({
        activeDrawer: null,
        left: { id: 'sidebar', open: onLeft },
        close: () => undefined,
      })
      return (
        <div {...handlers}>
          <div data-testid="toast" data-swipe-ignore>toast</div>
        </div>
      )
    }
    const { getByTestId } = render(<ExcludeHarness />)
    const toast = getByTestId('toast')
    fireEvent.touchStart(toast, touchEvt(8, 200))
    fireEvent.touchMove(toast, touchEvt(90, 205))
    expect(onLeft).not.toHaveBeenCalled()
  })

  it('ignores a close-gesture that starts on a data-swipe-ignore overlay stacked on the open drawer', () => {
    // Regression: a confirmation dialog/action-sheet (e.g. "Delete session")
    // rendered on top of an already-open drawer must not let a drag on it
    // be read as a swipe-to-close for the drawer underneath.
    const onClose = mock(() => undefined)
    function OverlayHarness() {
      const { handlers } = useEdgeSwipe({
        activeDrawer: 'sidebar',
        left: { id: 'sidebar', open: () => undefined },
        close: onClose,
      })
      return (
        <div {...handlers}>
          <div data-testid="dialog" data-swipe-ignore>dialog</div>
        </div>
      )
    }
    const { getByTestId } = render(<OverlayHarness />)
    const dialog = getByTestId('dialog')
    // Drag from the middle of the dialog toward the left edge — this is
    // exactly the "close" gesture shape, just starting on excluded content.
    fireEvent.touchStart(dialog, touchEvt(200, 200))
    fireEvent.touchMove(dialog, touchEvt(80, 205))

    expect(onClose).not.toHaveBeenCalled()
  })

  it('does nothing on non-mobile shells', () => {
    mobile = false
    const onLeft = mock(() => undefined)
    const { getByTestId } = render(
      <Harness activeDrawer={null} onLeft={onLeft} onRight={() => undefined} onClose={() => undefined} />,
    )
    const el = getByTestId('surface')
    fireEvent.touchStart(el, touchEvt(10, 200))
    fireEvent.touchMove(el, touchEvt(90, 205))

    expect(onLeft).not.toHaveBeenCalled()
  })
})
