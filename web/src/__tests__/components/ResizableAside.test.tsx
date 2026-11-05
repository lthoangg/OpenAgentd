import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { useRef } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

import {
  PANEL_SLIDE_MS,
  PanelResizeHandle,
  ResizableAside,
  usePanelWidthSink,
  onPanelSlideBeside,
  settledWidthBesidePanels,
  usePanelSlideBeside,
} from '@/components/ResizableAside'
import { useElementWidth } from '@/hooks/use-element-width'
import { useFakeTimers } from '../fake-timers'
import * as realHaptics from '@/lib/haptics'

const alignmentTick = mock(() => {})
// Keep every other export real: the module registry is shared across test files.
mock.module('@/lib/haptics', () => ({ ...realHaptics, alignmentHapticFeedback: alignmentTick }))

// rAF is async in browsers: queue frames and flush them explicitly.
const frames: FrameRequestCallback[] = []
const realRaf = globalThis.requestAnimationFrame

beforeEach(() => {
  alignmentTick.mockClear()
  frames.length = 0
  globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => frames.push(callback)) as typeof requestAnimationFrame
})

afterEach(() => {
  cleanup()
  globalThis.requestAnimationFrame = realRaf
})

function moveTo(clientX: number) {
  act(() => {
    window.dispatchEvent(new MouseEvent('pointermove', { clientX }))
    while (frames.length > 0) frames.shift()?.(0)
  })
}

describe('ResizableAside', () => {
  it('drags without re-rendering the panel content, then commits once', () => {
    let contentRenders = 0
    function Content() {
      contentRenders += 1
      return <p>content</p>
    }
    const onCommit = mock(() => {})
    const motionCalls: Array<{ width: number; isResizing: boolean }> = []
    const getMotion = (live: { width: number; isResizing: boolean }) => {
      motionCalls.push(live)
      return { animate: { width: live.width }, transition: { duration: 0 } }
    }

    render(
      <ResizableAside
        aria-label="Panel"
        resize={{ width: 300, min: 200, max: 500, edge: 'right', onCommit, label: 'Resize panel' }}
        getMotion={getMotion}
      >
        <PanelResizeHandle edge="right" />
        <Content />
      </ResizableAside>,
    )
    const separator = screen.getByRole('separator', { name: 'Resize panel' })
    expect(separator.getAttribute('aria-valuenow')).toBe('300')
    const settled = contentRenders

    fireEvent.pointerDown(separator, { button: 0, clientX: 100, pointerType: 'mouse' })
    moveTo(150)
    moveTo(180)

    expect(separator.getAttribute('aria-valuenow')).toBe('380')
    expect(motionCalls.at(-1)).toEqual({ width: 380, isResizing: true })
    expect(contentRenders).toBe(settled)
    expect(onCommit).not.toHaveBeenCalled()

    act(() => { window.dispatchEvent(new MouseEvent('pointerup')) })
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onCommit).toHaveBeenCalledWith(380)
    expect(contentRenders).toBe(settled)
  })

  it('renders no handle outside a ResizableAside', () => {
    render(<PanelResizeHandle edge="left" />)
    expect(screen.queryByRole('separator')).toBeNull()
  })

  describe('detent', () => {
    const snapping = (onCommit: () => void = () => {}) => (
      <ResizableAside
        aria-label="Panel"
        resize={{ width: 300, min: 200, max: 600, edge: 'right', detent: 264, onCommit, label: 'Resize panel' }}
        getMotion={(live) => ({ animate: { width: live.width }, transition: { duration: 0 } })}
      >
        <PanelResizeHandle edge="right" />
      </ResizableAside>
    )

    it('lands exactly on the default within 8px, and ticks once as it snaps in', () => {
      const onCommit = mock(() => {})
      render(snapping(onCommit))
      const separator = screen.getByRole('separator', { name: 'Resize panel' })
      fireEvent.pointerDown(separator, { button: 0, clientX: 500, pointerType: 'mouse' })

      moveTo(470) // 270: within 8px of 264
      expect(separator.getAttribute('aria-valuenow')).toBe('264')
      expect(alignmentTick).toHaveBeenCalledTimes(1)

      moveTo(468) // 268: still held, no second tick
      expect(separator.getAttribute('aria-valuenow')).toBe('264')
      expect(alignmentTick).toHaveBeenCalledTimes(1)

      moveTo(450) // 250: out of range, follows the pointer
      expect(separator.getAttribute('aria-valuenow')).toBe('250')
      moveTo(466) // 266: snaps in again
      expect(separator.getAttribute('aria-valuenow')).toBe('264')
      expect(alignmentTick).toHaveBeenCalledTimes(2)

      act(() => { window.dispatchEvent(new MouseEvent('pointerup')) })
      expect(onCommit).toHaveBeenCalledWith(264)
    })

    it('does not snap, or tick, far from the default', () => {
      render(snapping())
      const separator = screen.getByRole('separator', { name: 'Resize panel' })
      fireEvent.pointerDown(separator, { button: 0, clientX: 500, pointerType: 'mouse' })

      moveTo(480) // 280
      expect(separator.getAttribute('aria-valuenow')).toBe('280')
      moveTo(440) // 240
      expect(separator.getAttribute('aria-valuenow')).toBe('240')
      expect(alignmentTick).not.toHaveBeenCalled()
    })

    it('does not tick for a drag that starts on the default', () => {
      render(
        <ResizableAside
          aria-label="Panel"
          resize={{ width: 264, min: 200, max: 600, edge: 'right', detent: 264, onCommit: () => {}, label: 'Resize panel' }}
          getMotion={(live) => ({ animate: { width: live.width }, transition: { duration: 0 } })}
        >
          <PanelResizeHandle edge="right" />
        </ResizableAside>,
      )
      const separator = screen.getByRole('separator', { name: 'Resize panel' })
      fireEvent.pointerDown(separator, { button: 0, clientX: 500, pointerType: 'mouse' })
      moveTo(503)
      expect(separator.getAttribute('aria-valuenow')).toBe('264')
      expect(alignmentTick).not.toHaveBeenCalled()
    })
  })

  // Desktop panels show and hide as a straight cut. Through an animation the
  // width waited for a frame, and a throttled frame loop (a hidden window)
  // left the panel at 0 px; as a style it is there on the first paint.
  it('sets the width as a plain style with instantWidth, without waiting for a frame', () => {
    const { rerender } = render(
      <ResizableAside
        aria-label="Panel"
        resize={{ width: 300, min: 200, max: 500, edge: 'right', onCommit: () => {}, label: 'Resize panel' }}
        getMotion={(live) => ({ animate: { width: live.width }, transition: { duration: 0.01 }, instantWidth: true })}
      >
        <p>content</p>
      </ResizableAside>,
    )
    const aside = screen.getByRole('complementary', { name: 'Panel' })
    expect(aside.style.width).toBe('300px')
    expect(aside.getAttribute('data-panel-target-width')).toBe('300')
    expect(frames).toHaveLength(0)

    rerender(
      <ResizableAside
        aria-label="Panel"
        resize={{ width: 300, min: 200, max: 500, edge: 'right', onCommit: () => {}, label: 'Resize panel' }}
        getMotion={() => ({ animate: { width: 0 }, transition: { duration: 0.01 }, instantWidth: true })}
      >
        <p>content</p>
      </ResizableAside>,
    )
    expect(aside.style.width).toBe('0px')
  })

  // Opening and closing slide: a CSS width transition, set only for the
  // toggle, so a window resize or a drag still moves the edge at once. CSS,
  // not a frame loop, so a hidden window still ends at the right width.
  it('tweens the width with a CSS transition only while tweenWidth is set', () => {
    const panel = (tweenWidth: boolean, width: number) => (
      <ResizableAside
        aria-label="Panel"
        resize={{ width: 300, min: 200, max: 500, edge: 'right', onCommit: () => {}, label: 'Resize panel' }}
        getMotion={() => ({ animate: { width }, transition: { duration: 0.01 }, instantWidth: true, tweenWidth })}
      >
        <p>content</p>
      </ResizableAside>
    )
    const { rerender } = render(panel(false, 300))
    const aside = screen.getByRole('complementary', { name: 'Panel' })
    expect(aside.style.transition).toBe('')

    rerender(panel(true, 0))
    expect(aside.style.width).toBe('0px')
    expect(aside.style.transition).toBe('width var(--motion-base) var(--ease-sheet)')

    rerender(panel(false, 0))
    expect(aside.style.transition).toBe('')
    expect(frames).toHaveLength(0)
  })

  // Closing tweens the aside's width to 0. Content that tracked that width
  // reflowed every frame (a long plan: ~10 ms a frame); pinned to the target
  // width it is only clipped by the shrinking aside.
  it('pins the content to the width the motion asks for so open and close tweens only clip it', () => {
    render(
      <ResizableAside
        aria-label="Panel"
        pinContentWidth
        resize={{ width: 300, min: 200, max: 500, edge: 'right', onCommit: () => {}, label: 'Resize panel' }}
        getMotion={(live) => ({ animate: { width: 0 }, transition: { duration: 0 }, pinWidth: live.width })}
      >
        <p>content</p>
      </ResizableAside>,
    )
    expect((screen.getByText('content').parentElement as HTMLElement).style.width).toBe('300px')
  })

  // A resize tween with the content pinned at the target clipped its far
  // side (growing) or left a blank strip there (shrinking) until it ended.
  it('lets the content fill the aside through any other width change', () => {
    render(
      <ResizableAside
        aria-label="Panel"
        pinContentWidth
        resize={{ width: 300, min: 200, max: 500, edge: 'right', onCommit: () => {}, label: 'Resize panel' }}
        getMotion={(live) => ({ animate: { width: live.width }, transition: { duration: 0 } })}
      >
        <PanelResizeHandle edge="right" />
        <p>content</p>
      </ResizableAside>,
    )
    const content = screen.getByText('content').parentElement as HTMLElement
    expect(content.style.width).toBe('100%')
    fireEvent.pointerDown(screen.getByRole('separator'), { button: 0, clientX: 100, pointerType: 'mouse' })
    moveTo(150)
    expect(content.style.width).toBe('100%')
  })

  // The header's caps line up with the sidebar and the Review panel by
  // reading their widths from CSS properties, so they follow a drag and a
  // show/hide slide frame by frame.
  describe('publishWidthAs', () => {
    const realObserver = globalThis.ResizeObserver
    const observers: Array<{ callback: ResizeObserverCallback; options?: ResizeObserverOptions; disconnected: boolean }> = []
    beforeEach(() => {
      observers.length = 0
      globalThis.ResizeObserver = class {
        private entry: { callback: ResizeObserverCallback; options?: ResizeObserverOptions; disconnected: boolean }
        constructor(callback: ResizeObserverCallback) {
          this.entry = { callback, disconnected: false }
          observers.push(this.entry)
        }
        observe(_target: Element, options?: ResizeObserverOptions) { this.entry.options = options }
        unobserve() {}
        disconnect() { this.entry.disconnected = true }
      } as unknown as typeof ResizeObserver
    })
    afterEach(() => {
      globalThis.ResizeObserver = realObserver
    })

    /** A header cap: carries the property, as AgentChatHeader's caps do. */
    function Sink() {
      return <div data-testid="sink" ref={usePanelWidthSink('--oa-test-w')} />
    }
    const panel = (publish: boolean, sink = true) => (
      <>
        {sink && <Sink />}
        <ResizableAside
          aria-label="Panel"
          publishWidthAs={publish ? '--oa-test-w' : undefined}
          resize={{ width: 300, min: 200, max: 500, edge: 'right', onCommit: () => {}, label: 'Resize panel' }}
          getMotion={(live) => ({ animate: { width: live.width }, transition: { duration: 0 }, instantWidth: true })}
        >
          <p>content</p>
        </ResizableAside>
      </>
    )
    const published = () => screen.getByTestId('sink').style.getPropertyValue('--oa-test-w')

    it('writes its border-box width to its sinks as it changes, never to the root', () => {
      render(panel(true))
      const aside = screen.getByRole('complementary', { name: 'Panel' })
      aside.getBoundingClientRect = () => ({ width: 264.5 }) as DOMRect
      act(() => observers[0]?.callback([], {} as ResizeObserver))

      expect(published()).toBe('264.5px')
      // On <html> every element would inherit it and restyle on each frame of a slide.
      expect(document.documentElement.style.getPropertyValue('--oa-test-w')).toBe('')
      // The border box: a panel closed to 0 still draws its 1px edge until
      // the edge is dropped, and that change must be seen too.
      expect(observers[0]?.options).toEqual({ box: 'border-box' })
    })

    it('gives a sink that mounts later the current width', () => {
      const { rerender } = render(panel(true, false))
      const aside = screen.getByRole('complementary', { name: 'Panel' })
      aside.getBoundingClientRect = () => ({ width: 120 }) as DOMRect
      act(() => observers[0]?.callback([], {} as ResizeObserver))

      rerender(panel(true, true))
      expect(published()).toBe('120px')
    })

    it('clears the property when it stops publishing or unmounts', () => {
      const { rerender } = render(panel(true))
      expect(published()).toBe('0px')
      rerender(panel(false))
      expect(published()).toBe('')
      expect(observers[0]?.disconnected).toBe(true)

      rerender(panel(true))
      expect(published()).toBe('0px')
      const sink = screen.getByTestId('sink')
      rerender(<Sink />)
      expect(sink.style.getPropertyValue('--oa-test-w')).toBe('')
    })
  })
})

describe('settledWidthBesidePanels', () => {
  // The sidebar mid-tween: rendered at ``rendered`` px on its way to ``target``.
  function row(rendered: number, target: number) {
    render(
      <div>
        <ResizableAside
          aria-label="Sidebar"
          style={{ borderRight: '1px solid' }}
          resize={{ width: 264, min: 200, max: 500, edge: 'right', onCommit: () => {}, label: 'Resize sidebar' }}
          getMotion={() => ({ animate: { width: target }, transition: { duration: 0 } })}
        >
          <p>sidebar</p>
        </ResizableAside>
        <div data-testid="center" />
      </div>,
    )
    const sidebar = screen.getByRole('complementary', { name: 'Sidebar' })
    sidebar.getBoundingClientRect = () => ({ width: rendered }) as DOMRect
    const center = screen.getByTestId('center')
    center.getBoundingClientRect = () => ({ width: 1000 - rendered }) as DOMRect
    return center
  }

  it('measures the center for where a closing sidebar ends, down to its border', () => {
    expect(settledWidthBesidePanels(row(120, 0))).toBe(999)
  })

  it('measures the center for where an opening sidebar ends', () => {
    expect(settledWidthBesidePanels(row(40, 264))).toBe(736)
  })

  it('is the rendered width once the sidebar has settled', () => {
    expect(settledWidthBesidePanels(row(264, 264))).toBe(736)
    cleanup()
    expect(settledWidthBesidePanels(row(1, 0))).toBe(999)
  })

  // A drawer floats over the row: opening it (40 on its way to 264) or
  // closing it leaves the center the room it has. Counted, it shrank the
  // center by its width on open, so the Review panel covered the chat, and
  // grew it on close, leaving the chat under its minimum.
  it('does not count a drawer that floats over the row', () => {
    render(
      <div>
        <ResizableAside
          aria-label="Drawer"
          inFlow={false}
          resize={{ width: 264, min: 200, max: 500, edge: 'right', onCommit: () => {}, label: 'Resize sidebar' }}
          getMotion={() => ({ animate: { width: 264 }, transition: { duration: 0 }, instantWidth: true })}
        >
          <p>drawer</p>
        </ResizableAside>
        <div data-testid="center" />
      </div>,
    )
    const drawer = screen.getByRole('complementary', { name: 'Drawer' })
    drawer.getBoundingClientRect = () => ({ width: 40 }) as DOMRect
    expect(drawer.hasAttribute('data-panel-target-width')).toBe(false)
    const center = screen.getByTestId('center')
    center.getBoundingClientRect = () => ({ width: 900 }) as DOMRect
    expect(settledWidthBesidePanels(center)).toBe(900)
  })
})

describe('a panel beside a sliding one', () => {
  let timers: ReturnType<typeof useFakeTimers> | null = null
  afterEach(() => {
    timers?.restore()
    timers = null
  })

  // The Review panel beside the center: its width is a ratio of the center.
  function Center() {
    const ref = useRef<HTMLDivElement | null>(null)
    const width = useElementWidth(ref, settledWidthBesidePanels, onPanelSlideBeside)
    const sliding = usePanelSlideBeside(ref)
    const attach = (node: HTMLDivElement | null) => {
      if (node) node.getBoundingClientRect = () => ({ width: 736 }) as DOMRect
      ref.current = node
    }
    return <div ref={attach}>{`${width} ${sliding ? 'sliding' : 'still'}`}</div>
  }
  // The sidebar is 264px on screen; ``target`` is where its width is headed.
  const row = (target: number, tweenWidth: boolean, inFlow = true) => (
    <div ref={(node) => {
      const sidebar = node?.querySelector('aside')
      if (sidebar) sidebar.getBoundingClientRect = () => ({ width: 264 }) as DOMRect
    }}>
      <ResizableAside
        aria-label="Sidebar"
        inFlow={inFlow}
        resize={{ width: 264, min: 200, max: 500, edge: 'right', onCommit: () => {}, label: 'Resize sidebar' }}
        getMotion={() => ({ animate: { width: target }, transition: { duration: 0.01 }, instantWidth: true, tweenWidth })}
      >
        <p>sidebar</p>
      </ResizableAside>
      <Center />
    </div>
  )

  // Measured a ResizeObserver callback and a frame later, the Review panel
  // jumped to its new width a few frames into the sidebar's slide: the chat
  // between them overshot, then snapped back.
  it('re-measures in the commit the panel beside it starts sliding, and slides along until it ends', () => {
    const view = render(row(264, false))
    expect(screen.getByText('736 still')).toBeTruthy()
    timers = useFakeTimers()

    view.rerender(row(0, true))

    // No frame was run: the width is there for the slide's first paint.
    expect(frames).toHaveLength(0)
    expect(screen.getByText('1000 sliding')).toBeTruthy()
    act(() => timers!.tick(PANEL_SLIDE_MS - 1))
    expect(screen.getByText('1000 sliding')).toBeTruthy()
    act(() => timers!.tick(1))
    expect(screen.getByText('1000 still')).toBeTruthy()
  })

  it('does not slide along with a width change that is not a show or hide', () => {
    const view = render(row(264, false))

    view.rerender(row(300, false))

    expect(screen.getByText('736 still')).toBeTruthy()
  })

  it('neither re-measures nor slides along when a drawer over the row slides', () => {
    const view = render(row(264, false, false))
    expect(screen.getByText('736 still')).toBeTruthy()

    view.rerender(row(0, true, false))

    expect(screen.getByText('736 still')).toBeTruthy()
  })
})
