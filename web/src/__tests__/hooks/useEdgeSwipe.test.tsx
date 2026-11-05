import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, createEvent, fireEvent, render } from '@testing-library/react'
import { useEdgeSwipe, type DrawerId } from '@/hooks/use-edge-swipe'
import { _resetDrawerMotionsForTests, getDrawerMotion } from '@/lib/drawer-motion'

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

/** A touch event stamped ``t`` ms, so velocity is deterministic. */
function fireTouchAt(type: 'touchStart' | 'touchMove' | 'touchEnd', el: Element, x: number, y: number, t: number) {
  const event = createEvent[type](el, type === 'touchEnd' ? { touches: [] } : touchEvt(x, y))
  Object.defineProperty(event, 'timeStamp', { value: t })
  fireEvent(el, event)
}

describe('useEdgeSwipe', () => {
  beforeEach(() => {
    platform = { isTauri: true, os: 'ios', isMacOverlay: false }
    mobile = true
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 400 })
  })
  afterEach(() => {
    cleanup()
    _resetDrawerMotionsForTests()
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

  describe('edge zone', () => {
    it('starts an open gesture within 20px of the edge', () => {
      const onLeft = mock(() => undefined)
      const onRight = mock(() => undefined)
      const { getByTestId } = render(
        <Harness activeDrawer={null} onLeft={onLeft} onRight={onRight} onClose={() => undefined} />,
      )
      const el = getByTestId('surface')
      fireEvent.touchStart(el, touchEvt(20, 200))
      fireEvent.touchMove(el, touchEvt(140, 203))
      fireEvent.touchEnd(el)
      expect(onLeft).toHaveBeenCalledTimes(1)

      fireEvent.touchStart(el, touchEvt(380, 200)) // 20px from the right edge of 400
      fireEvent.touchMove(el, touchEvt(260, 203))
      fireEvent.touchEnd(el)
      expect(onRight).toHaveBeenCalledTimes(1)
    })

    it('ignores a start 21px or more from the edge', () => {
      const onLeft = mock(() => undefined)
      const onRight = mock(() => undefined)
      const { getByTestId } = render(
        <Harness activeDrawer={null} onLeft={onLeft} onRight={onRight} onClose={() => undefined} />,
      )
      const el = getByTestId('surface')
      fireEvent.touchStart(el, touchEvt(21, 200))
      fireEvent.touchMove(el, touchEvt(160, 203))
      fireEvent.touchEnd(el)
      fireEvent.touchStart(el, touchEvt(379, 200))
      fireEvent.touchMove(el, touchEvt(240, 203))
      fireEvent.touchEnd(el)
      expect(onLeft).not.toHaveBeenCalled()
      expect(onRight).not.toHaveBeenCalled()
    })
  })

  describe('drag-follow', () => {
    function DragHarness({ onRender }: { onRender: () => void }) {
      const { handlers } = useEdgeSwipe({
        activeDrawer: null,
        left: { id: 'sidebar', open: () => undefined },
        close: () => undefined,
      })
      onRender()
      return (
        <div data-testid="surface" {...handlers}>
          <aside data-edge-drawer="sidebar" />
          <div data-edge-drawer-scrim="sidebar" />
        </div>
      )
    }

    it('moves the drawer and scrim on touchmove without re-rendering', () => {
      const onRender = mock(() => undefined)
      const { getByTestId, container } = render(<DragHarness onRender={onRender} />)
      const motion = getDrawerMotion('sidebar')
      motion.configure({ hidden: -280, reduced: false })
      const el = getByTestId('surface')
      const drawer = container.querySelector<HTMLElement>('[data-edge-drawer]')!
      const scrim = container.querySelector<HTMLElement>('[data-edge-drawer-scrim]')!
      const rendersBefore = onRender.mock.calls.length

      fireEvent.touchStart(el, touchEvt(8, 200))
      // A short move (under commit distance) tracks the finger but does not open.
      fireEvent.touchMove(el, touchEvt(40, 202))
      expect(motion.progress).toBeGreaterThan(0)
      expect(motion.progress).toBeLessThan(1)
      const first = drawer.style.translate
      expect(first).toMatch(/^-\d+(\.\d+)?px 0$/)
      expect(Number(scrim.style.opacity)).toBeCloseTo(motion.progress, 6)

      for (let x = 50; x <= 120; x += 10) fireEvent.touchMove(el, touchEvt(x, 203))
      expect(drawer.style.translate).not.toBe(first)
      // The gesture wrote the DOM per frame; React rendered nothing.
      expect(onRender.mock.calls.length).toBe(rendersBefore)
    })

    it('stops at fully open however far the finger goes (hard edge)', () => {
      const { getByTestId } = render(<DragHarness onRender={() => undefined} />)
      const motion = getDrawerMotion('sidebar')
      const el = getByTestId('surface')
      fireEvent.touchStart(el, touchEvt(8, 200))
      fireEvent.touchMove(el, touchEvt(390, 203))
      expect(motion.progress).toBe(1)
    })

    it('stops at fully shut when a close drag runs past the closed position', () => {
      function CloseHarness() {
        const { handlers } = useEdgeSwipe({
          activeDrawer: 'sidebar',
          left: { id: 'sidebar', open: () => undefined },
          close: () => undefined,
        })
        return <div data-testid="surface" {...handlers}>surface</div>
      }
      const { getByTestId } = render(<CloseHarness />)
      const motion = getDrawerMotion('sidebar')
      const el = getByTestId('surface')
      fireEvent.touchStart(el, touchEvt(300, 200))
      fireEvent.touchMove(el, touchEvt(5, 203))
      expect(motion.progress).toBe(0)
    })
  })

  describe('release', () => {
    function spySettle() {
      const motion = getDrawerMotion('sidebar')
      const settle = mock(() => undefined)
      motion.settle = settle as unknown as typeof motion.settle
      return settle
    }

    it('springs to open carrying the finger velocity (progress/s)', () => {
      const settle = spySettle()
      const onLeft = mock(() => undefined)
      const { getByTestId } = render(
        <Harness activeDrawer={null} onLeft={onLeft} onRight={() => undefined} onClose={() => undefined} />,
      )
      const el = getByTestId('surface')
      fireTouchAt('touchStart', el, 8, 200, 1000)
      fireTouchAt('touchMove', el, 50, 201, 1020)
      fireTouchAt('touchMove', el, 100, 202, 1040)
      fireTouchAt('touchEnd', el, 0, 0, 1045)

      expect(onLeft).toHaveBeenCalledTimes(1)
      expect(settle).toHaveBeenCalledTimes(1)
      const [goal, velocity] = settle.mock.calls[0] as unknown as [number, number]
      expect(goal).toBe(1)
      // ~1.2 px/ms of a 272px drawer is a few progress/s, toward open.
      expect(velocity).toBeGreaterThan(3)
      expect(velocity).toBeLessThan(8)
    })

    it('carries no velocity when the finger rested before lifting', () => {
      const settle = spySettle()
      const { getByTestId } = render(
        <Harness activeDrawer={null} onLeft={() => undefined} onRight={() => undefined} onClose={() => undefined} />,
      )
      const el = getByTestId('surface')
      fireTouchAt('touchStart', el, 8, 200, 1000)
      fireTouchAt('touchMove', el, 50, 201, 1020)
      fireTouchAt('touchMove', el, 130, 202, 1040)
      fireTouchAt('touchEnd', el, 0, 0, 1400)
      expect(settle).toHaveBeenCalledWith(1, 0)
    })

    it('a close fling springs shut with a falling progress', () => {
      const settle = spySettle()
      const onClose = mock(() => undefined)
      const { getByTestId } = render(
        <Harness activeDrawer="sidebar" onLeft={() => undefined} onRight={() => undefined} onClose={onClose} />,
      )
      const el = getByTestId('surface')
      fireTouchAt('touchStart', el, 250, 200, 1000)
      fireTouchAt('touchMove', el, 200, 201, 1020)
      fireTouchAt('touchMove', el, 150, 202, 1040)
      fireTouchAt('touchEnd', el, 0, 0, 1045)
      expect(onClose).toHaveBeenCalledTimes(1)
      const [goal, velocity] = settle.mock.calls[0] as unknown as [number, number]
      expect(goal).toBe(0)
      expect(velocity).toBeLessThan(-3)
    })

    it('an uncommitted drag springs back to where it began', () => {
      const settle = spySettle()
      const onLeft = mock(() => undefined)
      const { getByTestId } = render(
        <Harness activeDrawer={null} onLeft={onLeft} onRight={() => undefined} onClose={() => undefined} />,
      )
      const el = getByTestId('surface')
      fireTouchAt('touchStart', el, 8, 200, 1000)
      fireTouchAt('touchMove', el, 30, 201, 1100)
      fireTouchAt('touchMove', el, 38, 202, 1200)
      fireTouchAt('touchEnd', el, 0, 0, 1210)
      expect(onLeft).not.toHaveBeenCalled()
      expect(settle).toHaveBeenCalledTimes(1)
      expect((settle.mock.calls[0] as unknown as number[])[0]).toBe(0)
    })

    it('a cancelled gesture springs back instead of freezing mid-drag', () => {
      const settle = spySettle()
      const { getByTestId } = render(
        <Harness activeDrawer="sidebar" onLeft={() => undefined} onRight={() => undefined} onClose={() => undefined} />,
      )
      const el = getByTestId('surface')
      fireEvent.touchStart(el, touchEvt(250, 200))
      fireEvent.touchMove(el, touchEvt(230, 201))
      fireEvent.touchCancel(el)
      expect(settle).toHaveBeenCalledTimes(1)
      expect((settle.mock.calls[0] as unknown as number[])[0]).toBe(1)
    })

    it('never settles a gesture that did not lock to horizontal', () => {
      const settle = spySettle()
      const { getByTestId } = render(
        <Harness activeDrawer={null} onLeft={() => undefined} onRight={() => undefined} onClose={() => undefined} />,
      )
      const el = getByTestId('surface')
      fireEvent.touchStart(el, touchEvt(10, 100))
      fireEvent.touchMove(el, touchEvt(30, 260))
      fireEvent.touchEnd(el)
      expect(settle).not.toHaveBeenCalled()
    })
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

  describe('horizontal scrollers inside a drawer', () => {
    // Regression: a wide markdown table in the Plan panel (right drawer)
    // scrolled horizontally *and* dragged the panel closed at once.
    function ScrollerHarness({ onClose, scrollLeft }: { onClose: () => void; scrollLeft: number }) {
      const { handlers } = useEdgeSwipe({
        activeDrawer: 'actions',
        right: { id: 'actions', open: () => undefined },
        close: onClose,
      })
      return (
        <div {...handlers}>
          <div
            data-testid="scroller"
            style={{ overflowX: 'auto' }}
            ref={(el) => {
              if (!el) return
              Object.defineProperty(el, 'scrollWidth', { configurable: true, value: 800 })
              Object.defineProperty(el, 'clientWidth', { configurable: true, value: 300 })
              el.scrollLeft = scrollLeft
            }}
          >
            <span data-testid="cell">cell</span>
          </div>
        </div>
      )
    }

    it('yields to a scroller that can still scroll in the drag direction', () => {
      const onClose = mock(() => undefined)
      const { getByTestId } = render(<ScrollerHarness onClose={onClose} scrollLeft={200} />)
      const cell = getByTestId('cell')
      // Swipe right (the right drawer's close direction) — the table can
      // still scroll back toward its start, so the table owns the gesture.
      fireEvent.touchStart(cell, touchEvt(100, 200))
      fireEvent.touchMove(cell, touchEvt(250, 205))
      fireEvent.touchEnd(cell)

      expect(onClose).not.toHaveBeenCalled()
    })

    it('still closes once the scroller is already at its edge in the drag direction', () => {
      const onClose = mock(() => undefined)
      const { getByTestId } = render(<ScrollerHarness onClose={onClose} scrollLeft={0} />)
      const cell = getByTestId('cell')
      fireEvent.touchStart(cell, touchEvt(100, 200))
      fireEvent.touchMove(cell, touchEvt(250, 205))
      fireEvent.touchEnd(cell)

      expect(onClose).toHaveBeenCalledTimes(1)
    })

    it('yields to a single-line text input whose text overflows', () => {
      // <input> scrolls its text natively without overflow-x: auto (e.g.
      // a long URL in the Preview tab's address bar).
      const onClose = mock(() => undefined)
      function InputHarness() {
        const { handlers } = useEdgeSwipe({
          activeDrawer: 'actions',
          right: { id: 'actions', open: () => undefined },
          close: onClose,
        })
        return (
          <div {...handlers}>
            <input
              data-testid="url"
              ref={(el) => {
                if (!el) return
                Object.defineProperty(el, 'scrollWidth', { configurable: true, value: 800 })
                Object.defineProperty(el, 'clientWidth', { configurable: true, value: 300 })
                el.scrollLeft = 200
              }}
            />
          </div>
        )
      }
      const { getByTestId } = render(<InputHarness />)
      const input = getByTestId('url')
      fireEvent.touchStart(input, touchEvt(100, 200))
      fireEvent.touchMove(input, touchEvt(250, 205))
      fireEvent.touchEnd(input)

      expect(onClose).not.toHaveBeenCalled()
    })
  })

  it('does not lock horizontal on a mostly-vertical scroll with sideways drift', () => {
    // Regression: dx=10/dy=14 (~55° off horizontal) used to lock as a
    // horizontal drawer drag, so a thumb arcing while scrolling the Plan
    // panel dragged — and could fling — the drawer closed.
    const onClose = mock(() => undefined)
    const { getByTestId } = render(
      <Harness activeDrawer="actions" onLeft={() => undefined} onRight={() => undefined} onClose={onClose} />,
    )
    const el = getByTestId('surface')
    fireEvent.touchStart(el, touchEvt(200, 400))
    fireEvent.touchMove(el, touchEvt(210, 386))
    // The rest of the arc drifts far enough right to commit if locked.
    fireEvent.touchMove(el, touchEvt(320, 200))
    fireEvent.touchEnd(el)

    expect(onClose).not.toHaveBeenCalled()
  })

  it('ignores multi-touch gestures (pinch / two-finger pan)', () => {
    const onClose = mock(() => undefined)
    const { getByTestId } = render(
      <Harness activeDrawer="actions" onLeft={() => undefined} onRight={() => undefined} onClose={onClose} />,
    )
    const el = getByTestId('surface')
    fireEvent.touchStart(el, { touches: [{ clientX: 100, clientY: 200 }, { clientX: 200, clientY: 200 }] })
    fireEvent.touchMove(el, { touches: [{ clientX: 250, clientY: 200 }, { clientX: 350, clientY: 200 }] })
    fireEvent.touchEnd(el)

    expect(onClose).not.toHaveBeenCalled()
  })

  it('abandons the gesture when a second finger lands mid-swipe', () => {
    const onClose = mock(() => undefined)
    const { getByTestId } = render(
      <Harness activeDrawer="actions" onLeft={() => undefined} onRight={() => undefined} onClose={onClose} />,
    )
    const el = getByTestId('surface')
    fireEvent.touchStart(el, touchEvt(100, 200))
    fireEvent.touchMove(el, touchEvt(130, 200))
    fireEvent.touchMove(el, { touches: [{ clientX: 250, clientY: 200 }, { clientX: 300, clientY: 220 }] })
    fireEvent.touchEnd(el)

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
